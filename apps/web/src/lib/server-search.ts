import "server-only";
import { z } from "zod";
import { ApiError } from "./supabase/api";
import type { createClient } from "./supabase/server";
import type { Citation, WorkspaceData, AnswerRequest } from "./types";
import type { SearchCandidate, SearchRequest } from "./search-types";
import { materializeSearchCandidates, searchItemEligible, searchWorkspace } from "./search";
import { isHeadingOnly, selectedSources } from "./retrieval";
import { readEmbeddingConfig, embedQuery, reserveEmbeddingUsage } from "./ai/embeddings";

type Client = Awaited<ReturnType<typeof createClient>>;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const rowsSchema = z
  .array(
    z.object({
      source_id: id,
      version_id: id,
      chunk_id: id.nullable(),
      score: z.coerce.number().finite(),
      workspace_revision: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
  )
  .max(100);
export type SearchMode = "keyword" | "semantic";

export async function indexedSourceCandidates(
  client: Client,
  data: WorkspaceData,
  revision: number,
  request: SearchRequest,
  forAI = false,
  options?: {
    mode: SearchMode;
    ownerId: string;
    signal?: AbortSignal;
    assertCurrent: () => Promise<void>;
    /** Answers alone may verify unchanged evidence in a newer authoritative snapshot. */
    validateSnapshotRevision?: (observedRevision: number) => Promise<boolean>;
  },
): Promise<SearchCandidate[]> {
  // All metadata filters run BEFORE the database candidate limit, never only after ANN top-K.
  materializeSearchCandidates(data, request, []);
  if (options?.mode === "semantic") {
    if (request.scope.kind === "all")
      throw new ApiError(
        400,
        "SEMANTIC_SCOPE_REQUIRED",
        "请先选择一个知识库或收件箱，再进行语义搜索。",
      );
    if (!data.aiEnabled || !data.semanticSearch)
      throw new ApiError(403, "SEMANTIC_DISABLED", "请先在设置中开启语义索引与搜索。");
  }
  const ids = data.sources
    .filter(
      (source) =>
        searchItemEligible(source, request) &&
        (!forAI ||
          (data.aiEnabled && source.aiAllowed && ["ready", "partial"].includes(source.status))),
    )
    .map((source) => source.id);
  if (!ids.length) return [];
  const args = {
    p_space_id:
      request.scope.kind === "space"
        ? request.scope.spaceId
        : request.scope.kind === "inbox"
          ? "inbox"
          : "*",
    p_source_ids: ids,
    p_limit: 100,
  };
  const lexical = await client.rpc("search_source_chunks", {
    ...args,
    p_query: request.query,
    p_for_ai: forAI,
  });
  if (lexical.error)
    throw new ApiError(
      503,
      "SEARCH_INDEX_UNAVAILABLE",
      "资料搜索索引尚未就绪，请完成数据库迁移后重试。",
    );
  const parse = async (value: unknown) => {
    const parsed = rowsSchema.safeParse(value);
    if (!parsed.success) throw new ApiError(503, "INVALID_SEARCH_INDEX", "资料搜索结果格式异常。");
    const revisions = new Set(parsed.data.map((row) => row.workspace_revision));
    const observedRevision = parsed.data[0]?.workspace_revision;
    if (
      revisions.size > 1 ||
      (observedRevision !== undefined &&
        (observedRevision < revision ||
          (observedRevision !== revision &&
            (!forAI ||
              !options?.validateSnapshotRevision ||
              (await options.validateSnapshotRevision(observedRevision)) !== true))))
    )
      throw new ApiError(409, "SEARCH_CONTEXT_CHANGED", "资料已改变，请重新搜索。");
    if (
      observedRevision !== undefined &&
      observedRevision > revision &&
      parsed.data.some((row) => {
        const source = data.sources.find((item) => item.id === row.source_id);
        return (
          !source ||
          !ids.includes(source.id) ||
          source.versionId !== row.version_id ||
          (row.chunk_id !== null &&
            !source.chunks.some(
              (chunk) =>
                chunk.id === row.chunk_id &&
                chunk.sourceId === source.id &&
                chunk.versionId === source.versionId,
            ))
        );
      })
    )
      throw new ApiError(409, "SEARCH_CONTEXT_CHANGED", "资料已改变，请重新搜索。");
    return parsed.data.map((row): SearchCandidate => ({
      kind: "source",
      objectId: row.source_id,
      versionId: row.version_id,
      blockId: row.chunk_id,
      score: Math.max(0, row.score),
    }));
  };
  const keyword = await parse(lexical.data);
  if (options?.mode !== "semantic") return keyword;
  if (request.scope.kind === "all")
    throw new ApiError(
      400,
      "SEMANTIC_SCOPE_REQUIRED",
      "请先选择一个知识库或收件箱，再进行语义搜索。",
    );
  if (!data.aiEnabled || !data.semanticSearch)
    throw new ApiError(403, "SEMANTIC_DISABLED", "请先在设置中开启语义索引与搜索。");
  const config = readEmbeddingConfig();
  if (!config)
    throw new ApiError(
      503,
      "EMBEDDING_NOT_CONFIGURED",
      "语义检索模型尚未配置，普通关键词搜索仍可使用。",
    );
  // This preflight checks published availability without disclosing the query to a provider.
  const status = await client.rpc("embedding_job_status", { p_source_ids: ids });
  if (status.error) throw new ApiError(503, "INDEXING_UNAVAILABLE", "无法读取语义索引状态。");
  const jobs = status.data?.jobs;
  const statuses = z
    .array(
      z.object({
        state: z.string(),
        sourceId: id,
        versionId: id,
        profileFingerprint: z.string().nullable(),
      }),
    )
    .safeParse(jobs);
  if (!statuses.success)
    throw new ApiError(503, "INVALID_INDEXING_STATUS", "语义索引状态格式异常。");
  const currentJobs = statuses.data.filter(
    (job) =>
      job.state === "succeeded" &&
      ids.includes(job.sourceId) &&
      data.sources.some(
        (source) => source.id === job.sourceId && source.versionId === job.versionId,
      ),
  );
  if (currentJobs.some((job) => job.profileFingerprint !== config.fingerprint))
    throw new ApiError(409, "EMBEDDING_PROFILE_CHANGED", "语义模型已改变，需要重建匹配的索引。");
  if (!currentJobs.length)
    throw new ApiError(
      409,
      "SEMANTIC_NOT_READY",
      "当前范围的语义索引尚未完成，请先使用关键词搜索。",
    );
  await reserveEmbeddingUsage(options.ownerId, [...request.query].length);
  await options.assertCurrent();
  const vector = await embedQuery(config, request.query, options.signal);
  await options.assertCurrent();
  const semantic = await client.rpc("semantic_source_chunks", {
    ...args,
    p_query_embedding: vector,
    p_profile_fingerprint: config.fingerprint,
  });
  if (semantic.error)
    throw new ApiError(
      503,
      "SEMANTIC_INDEX_UNAVAILABLE",
      "语义索引与模型配置不一致或暂不可用，请检查索引状态。",
    );
  const semanticRows = await parse(semantic.data);
  // Reciprocal rank fusion avoids treating unrelated lexical/cosine scores as comparable.
  const merged = new Map<string, SearchCandidate>();
  for (const list of [keyword, semanticRows])
    list.forEach((candidate, index) => {
      const key = JSON.stringify([candidate.objectId, candidate.blockId]);
      const score = (merged.get(key)?.score || 0) + 1 / (60 + index + 1);
      merged.set(key, { ...candidate, score });
    });
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

export function noteSearchCandidates(
  data: WorkspaceData,
  request: SearchRequest,
): SearchCandidate[] {
  const result = searchWorkspace({ ...data, sources: [] }, { ...request, limit: 100 });
  return result.hits.map((hit) => {
    if (hit.kind === "source") throw new Error("Unexpected source in note search");
    return {
      kind: hit.kind,
      objectId: hit.objectId,
      revision: hit.revision,
      updatedAt: hit.updatedAt,
      blockId: hit.blockId,
      score: hit.score,
    };
  });
}

export function indexedCitations(
  data: WorkspaceData,
  request: AnswerRequest,
  candidates: SearchCandidate[],
): Citation[] {
  const allowed = selectedSources(data, request);
  const found: Citation[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind !== "source" || !candidate.blockId) continue;
    const source = allowed.find(
      (s) => s.id === candidate.objectId && s.versionId === candidate.versionId,
    );
    const chunk = source?.chunks.find(
      (c) =>
        c.id === candidate.blockId && c.sourceId === source.id && c.versionId === source.versionId,
    );
    if (!source || !chunk || isHeadingOnly(source, chunk) || !source.text.includes(chunk.text))
      continue;
    const key = `${source.id}:${chunk.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: chunk.id,
      title: source.title,
      quote: chunk.text,
      section: chunk.section,
      page: chunk.page,
    });
  }
  return found;
}
