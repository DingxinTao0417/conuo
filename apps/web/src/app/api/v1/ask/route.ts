import { createHash } from "node:crypto";
import { z } from "zod";
import {
  formatNoteEvidenceExtracts,
  resolveAnswerNoteEvidence,
  retrieveEvidence,
  resolveCitation,
  selectedDocumentNoteEvidence,
  selectedSources,
} from "@/lib/retrieval";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import {
  answerRequestSchema,
  answerResultSchema,
  workspaceSchema,
} from "@/lib/supabase/validation";
import {
  callModel,
  callModelStream,
  type ModelObserver,
  type ModelProfileName,
} from "@/lib/ai/model";
import { selectAnswerProfile, selectFastProfile } from "@/lib/ai/model-routing";
import { findUnsupportedParagraphs, VERIFY_CONTRACT_VERSION } from "@/lib/ai/answer-verification";
import { priorAnswerContext } from "@/lib/ai/answer-memory";
import {
  type AnswerFormat,
  GROUNDING_CONTRACT_VERSION,
  buildFullDocumentGrounding,
  buildGrounding,
  buildSummaryGrounding,
  groundingMessages,
  parseGeneratedAnswer,
  renderGeneratedAnswer,
} from "@/lib/ai/grounding";
import { aiFeatureEnabled } from "@/lib/ai/features";
import { createGroundingPreview } from "@/lib/ai/grounding-stream";
import { createRequestStore, reserveRequest, finishRequest } from "@/lib/ai/requests";
import { questionContextKey } from "@/lib/question-context";
import { answerRetrievalQuery, normalizeUserQuestionContext } from "@/lib/answer-context";
import { extractiveCitationMarker } from "@/lib/citation-markers";
import { sourceCoverageNotices } from "@/lib/source-coverage";
import {
  isCrossLibraryAnswerRequest,
  validateCrossLibraryAnswerRequest,
} from "@/lib/cross-library-ask";
import type { AnswerRequest, AnswerResult, WorkspaceData } from "@/lib/types";
import {
  fuseCandidates,
  indexedCitations,
  indexedSourceCandidates,
  noteSearchCandidates,
} from "@/lib/server-search";
import { readEmbeddingConfig } from "@/lib/ai/embeddings";
import {
  REWRITE_CONTRACT_VERSION,
  documentLanguage,
  needsRewrite,
  rewriteQuery,
} from "@/lib/ai/query-rewrite";
import { readRerankConfig, rerank } from "@/lib/ai/rerank";
import { createTraceRecorder } from "@/lib/ai/traces";
import { classifyQuestionIntent } from "@/lib/ai/question-intent";
import {
  answerStreamResponse,
  ANSWER_STREAM_LIMITS,
  type AnswerStreamSink,
} from "@/lib/ai/answer-response-stream";
import type { OutlineItem } from "@/lib/source-outline";
import { SUMMARY_CONTRACT_VERSION } from "@/lib/ai/source-summary";
import { appendGlossaryAliases, glossaryTermSchema } from "@/lib/ai/glossary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** Bounds even unresolved auth/database reads; losing promises cannot advance the request. */
function preflightGuard(request: Request, deadlineAt: number) {
  const controller = new AbortController();
  let reject!: (error: unknown) => void;
  const stopped = new Promise<never>((_resolve, no) => {
    reject = no;
  });
  // An abort may arrive between awaited stages, before the next race is attached.
  void stopped.catch(() => undefined);
  const stop = (error: unknown) => {
    if (controller.signal.aborted) return;
    reject(error);
    controller.abort(error);
    if (request.body && !request.body.locked)
      void request.body.cancel(error).catch(() => undefined);
  };
  const abort = () => stop(new ApiError(499, "REQUEST_CANCELLED", "回答已停止，问题已保留。"));
  const timer = setTimeout(
    () => stop(new ApiError(504, "ANSWER_STREAM_TIMEOUT", "回答耗时过长，已停止本次生成。")),
    Math.max(0, deadlineAt - Date.now()),
  );
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  return {
    signal: controller.signal,
    async wait<T>(work: () => Promise<T>): Promise<T> {
      if (controller.signal.aborted) throw controller.signal.reason;
      return Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw controller.signal.reason;
          return work();
        }),
        stopped,
      ]);
    },
    dispose(error?: unknown) {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      if (error !== undefined) stop(error);
    },
  };
}

function cancellableJsonRequest(request: Request, signal: AbortSignal): Request {
  if (!request.body) return request;
  // Abort the pipe, including its upstream reader, without changing the shared JSON validator.
  const init: RequestInit & { duplex: "half" } = {
    method: request.method,
    headers: request.headers,
    signal,
    duplex: "half",
    body: request.body.pipeThrough(new TransformStream(), { signal }),
  };
  return new Request(request.url, init);
}

function assertScope(workspace: WorkspaceData, question: AnswerRequest) {
  if (isCrossLibraryAnswerRequest(question)) {
    const checked = validateCrossLibraryAnswerRequest(workspace, question);
    if (checked.ok) return;
    const status =
      checked.error.code === "CROSS_LIBRARY_AI_DISABLED"
        ? 403
        : checked.error.code === "CROSS_LIBRARY_SOURCE_NOT_READY" ||
            checked.error.code === "CROSS_LIBRARY_VERSION_CHANGED"
          ? 409
          : 404;
    const code =
      checked.error.code === "CROSS_LIBRARY_AI_DISABLED"
        ? "SOURCE_AI_DISABLED"
        : checked.error.code === "CROSS_LIBRARY_SOURCE_NOT_READY"
          ? "SOURCE_NOT_READY"
          : checked.error.code === "CROSS_LIBRARY_VERSION_CHANGED"
            ? "SOURCE_VERSION_CHANGED"
            : "INVALID_SCOPE";
    throw new ApiError(status, code, checked.error.message);
  }
  const isInbox = question.spaceId === "inbox";
  if (
    !isInbox &&
    !workspace.spaces.some((space) => space.id === question.spaceId && !space.archived)
  )
    throw new ApiError(404, "INVALID_SCOPE", "所选学习空间不可用。");
  const candidates = [question.sourceId, ...question.sourceIds].filter((id): id is string =>
    Boolean(id),
  );
  if (
    candidates.some(
      (id) =>
        !workspace.sources.some(
          (source) =>
            source.id === id &&
            !source.deletedAt &&
            (isInbox ? source.spaceIds.length === 0 : source.spaceIds.includes(question.spaceId)),
        ),
    )
  )
    throw new ApiError(404, "INVALID_SCOPE", "部分所选资料不在当前可用范围内。");
  if (question.sourceVersions) {
    const fixedSources = question.sourceVersions.map((reference) =>
      workspace.sources.find((source) => source.id === reference.sourceId),
    );
    if (
      fixedSources.some(
        (source, index) => source?.versionId !== question.sourceVersions![index]!.versionId,
      )
    )
      throw new ApiError(
        409,
        "SOURCE_VERSION_CHANGED",
        "固定资料版本已改变，请重新确认资料后再提问。",
      );
    if (fixedSources.some((source) => !source?.aiAllowed))
      throw new ApiError(403, "SOURCE_AI_DISABLED", "部分固定资料不允许用于 AI，请重新确认范围。");
    if (
      fixedSources.some(
        (source) =>
          !source ||
          !["ready", "partial"].includes(source.status) ||
          !source.text.trim() ||
          !source.chunks.length ||
          source.chunks.some(
            (chunk) =>
              chunk.sourceId !== source.id ||
              chunk.versionId !== source.versionId ||
              !chunk.text.trim() ||
              !source.text.includes(chunk.text),
          ),
      )
    )
      throw new ApiError(
        409,
        "SOURCE_NOT_READY",
        "部分固定资料尚无可用正文，请完成解析后重新确认。",
      );
  }
  if (
    question.scope === "document-notes" &&
    (!question.sourceId || question.sourceIds.length || question.selection !== undefined)
  )
    throw new ApiError(
      400,
      "INVALID_SCOPE",
      "“此资料 + 我的笔记”只能针对当前一份资料，不能附带其他资料或选段。",
    );
}

/** Configuration state only, never a claim that the provider has been tested. */
export async function GET(request: Request) {
  try {
    await requireUser(request);
    if (!selectAnswerProfile("standard"))
      return json({ mode: "extractive", message: "尚未配置生成模型，当前使用原文检索。" });
    const store = createRequestStore();
    const { error } = await store.from("ai_requests").select("request_id").limit(0);
    if (error)
      throw new ApiError(
        503,
        "MODEL_LEDGER_UNAVAILABLE",
        "模型请求记录服务尚未就绪，请完成数据库配置。",
      );
    return json({
      mode: "model",
      message: "已配置生成模型；回答仅使用所选资料，调用结果以实际请求为准。",
    });
  } catch (error) {
    return failure(error);
  }
}

function hasFixedMultiSourceRange(question: AnswerRequest) {
  return question.scope === "sources" || isCrossLibraryAnswerRequest(question);
}

const outlineItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    level: z.number().int().min(1).max(6),
    page: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();
const outlineRowSchema = z
  .object({
    sourceId: z.string(),
    versionId: z.string(),
    method: z.enum(["pdf-outline", "heading-heuristic", "docx-headings", "markdown-headings"]),
    items: z.array(outlineItemSchema).max(1_000),
    updatedAt: z.string(),
  })
  .strict();
const summaryRowSchema = z
  .object({
    level: z.enum(["section", "document"]),
    sectionIndex: z.number().int().min(0).max(1000),
    title: z.string().min(1).max(200),
    pageStart: z.number().int().positive().nullable().optional(),
    pageEnd: z.number().int().positive().nullable().optional(),
    chunkIds: z.array(z.string()).min(1).max(400),
    summary: z
      .object({
        paragraphs: z
          .array(z.object({ text: z.string(), chunkIds: z.array(z.string()).min(1).max(6) }))
          .max(8),
      })
      .passthrough(),
    modelName: z.string().nullable().optional(),
    createdAt: z.string().optional(),
  })
  .strict();

async function readSourceOutlines(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  sources: WorkspaceData["sources"],
) {
  const paginated = sources
    .filter((source) => source.chunks.some((chunk) => chunk.page !== undefined))
    .slice(0, 20);
  if (!paginated.length) return { outlines: new Map<string, OutlineItem[]>(), fingerprint: null };
  try {
    const { data, error } = await supabase.rpc("read_source_outlines", {
      p_refs: paginated.map((source) => ({ sourceId: source.id, versionId: source.versionId })),
    });
    if (error || !Array.isArray(data))
      return { outlines: new Map<string, OutlineItem[]>(), fingerprint: null };
    const rows = data.flatMap((value: unknown) => {
      const parsed = outlineRowSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    const outlines = new Map<string, OutlineItem[]>();
    for (const row of rows) outlines.set(`${row.sourceId}:${row.versionId}`, row.items);
    const fingerprint = rows
      .map((row) => [`${row.sourceId}:${row.versionId}`, row.updatedAt])
      .sort(([left], [right]) => left.localeCompare(right));
    return { outlines, fingerprint: fingerprint.length ? JSON.stringify(fingerprint) : null };
  } catch {
    return { outlines: new Map<string, OutlineItem[]>(), fingerprint: null };
  }
}

async function readSourceSummaries(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  source: WorkspaceData["sources"][number],
) {
  try {
    const { data, error } = await supabase.rpc("read_source_summaries", {
      p_source_id: source.id,
      p_version_id: source.versionId,
    });
    if (error || !Array.isArray(data))
      return { rows: [] as import("@/lib/ai/grounding").SummaryRow[], fingerprint: null };
    const rows = data.flatMap((value: unknown) => {
      const parsed = summaryRowSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    const fingerprint = rows
      .map((row) => [row.level, row.sectionIndex, row.createdAt ?? ""])
      .sort((a, b) => a.join("/").localeCompare(b.join("/")));
    return {
      rows: rows as import("@/lib/ai/grounding").SummaryRow[],
      fingerprint: fingerprint.length ? JSON.stringify(fingerprint) : null,
    };
  } catch {
    return { rows: [] as import("@/lib/ai/grounding").SummaryRow[], fingerprint: null };
  }
}

function knowledgeNavigationCitations(data: WorkspaceData, question: AnswerRequest, query: string) {
  if (question.spaceId === "inbox" || !["space", "sources", "document"].includes(question.scope))
    return [];
  const selected = selectedSources(data, question);
  const allowedSources = new Set(selected.map((source) => `${source.id}:${source.versionId}`));
  try {
    const candidates = noteSearchCandidates(data, {
      query,
      scope: { kind: "space", spaceId: question.spaceId },
      filters: { types: ["knowledge"] },
      limit: 20,
    });
    const pages = candidates.filter((candidate) => candidate.kind === "knowledge").slice(0, 3);
    const result = [] as import("@/lib/types").Citation[];
    const seen = new Set<string>();
    for (const candidate of pages) {
      const note = data.notes.find(
        (item) =>
          item.id === candidate.objectId &&
          item.kind === "knowledge" &&
          item.status === "accepted" &&
          !item.deletedAt &&
          item.spaceId === question.spaceId,
      );
      if (!note) continue;
      for (const citation of note.citations) {
        if (result.length >= 6) break;
        if (!allowedSources.has(`${citation.sourceId}:${citation.versionId}`)) continue;
        const resolved = resolveCitation(data, citation);
        if (!resolved) continue;
        const key = `${citation.sourceId}:${citation.versionId}:${citation.chunkId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(citation);
      }
    }
    return result;
  } catch {
    return [];
  }
}

async function readGlossaryTerms(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  spaceId: string,
) {
  if (spaceId === "inbox" || spaceId === "all") return [];
  try {
    const { data, error } = await supabase.rpc("list_glossary_terms", { p_space_id: spaceId });
    if (error || !Array.isArray(data)) return [];
    return data.flatMap((value: unknown) => {
      const parsed = glossaryTermSchema.safeParse(value);
      return parsed.success && parsed.data.status === "accepted" ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const preflightDeadlineAt = startedAt + ANSWER_STREAM_LIMITS.durationMs;
  let deadlineAt = preflightDeadlineAt;
  const streaming = request.headers
    .get("Accept")
    ?.split(",")
    .some((part) => {
      const [mime, ...parameters] = part.trim().toLowerCase().split(";");
      return (
        mime === "text/event-stream" &&
        !parameters.some((item) => /^\s*q=0(?:\.0*)?\s*$/.test(item))
      );
    });
  const checkBudget = () => {
    if (streaming && Date.now() >= deadlineAt)
      throw new ApiError(504, "ANSWER_STREAM_TIMEOUT", "回答耗时过长，已停止本次生成。");
  };
  const preflight = streaming ? preflightGuard(request, preflightDeadlineAt) : undefined;
  const prepare = <T>(work: () => Promise<T>): Promise<T> =>
    preflight ? preflight.wait(work) : work();
  let reservation:
    | { store: ReturnType<typeof createRequestStore>; ownerId: string; requestId: string }
    | undefined;
  let reservationCleanup: Promise<void> | undefined;
  let traceRecorder: ReturnType<typeof createTraceRecorder> | undefined;
  let traceOutcome:
    "completed" | "insufficient" | "failed" | "cancelled" | "cached" | "extractive" = "failed";
  let traceErrorCode: string | undefined;
  let traceModelName: string | undefined;
  let traceModelProfile: ModelProfileName | undefined;
  const finishTrace = () => {
    if (traceRecorder)
      void traceRecorder.finish(traceOutcome, {
        errorCode: traceErrorCode,
        modelProfile: traceModelProfile ?? "default",
        modelName: traceModelName,
      });
  };
  const failReservation = (error: unknown): Promise<void> => {
    if (reservationCleanup) return reservationCleanup;
    const pending = reservation;
    reservation = undefined;
    if (!pending) return Promise.resolve();
    reservationCleanup = (async () => {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const saving = finishRequest(
          pending.store,
          pending.ownerId,
          pending.requestId,
          undefined,
          error instanceof ApiError ? error.code : "MODEL_REQUEST_FAILED",
        );
        await Promise.race([
          saving,
          new Promise<void>((resolve) => {
            cleanupTimer = setTimeout(resolve, ANSWER_STREAM_LIMITS.cleanupMs);
          }),
        ]);
      } catch {
        /* Unresolved reservations stay non-replayable; never silently call the model again. */
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer);
      }
    })();
    return reservationCleanup;
  };
  try {
    const { supabase, user } = await prepare(() => requireUser(request));
    const parsed = answerRequestSchema.safeParse(
      await prepare(() =>
        readJson(preflight ? cancellableJsonRequest(request, preflight.signal) : request, 100_000),
      ),
    );
    if (!parsed.success) throw new ApiError(400, "INVALID_QUESTION", "请检查问题长度与资料范围。");
    const question = parsed.data;
    const tutorModeEnabled = aiFeatureEnabled("TUTOR_MODE");
    const mode = tutorModeEnabled && question.mode === "tutor" ? "tutor" : "answer";
    const depth =
      question.depth === "deep" && aiFeatureEnabled("DEEP_THINKING") ? "deep" : "standard";
    const reservationOptions = {
      route: "ask" as const,
      features: [
        ...(depth === "deep" ? (["deep_thinking"] as const) : []),
        ...(mode === "tutor" ? (["tutor_mode"] as const) : []),
      ],
      ...(depth === "deep" ? { ttlSeconds: 330 } : {}),
    };
    deadlineAt = startedAt + (depth === "deep" ? 280_000 : ANSWER_STREAM_LIMITS.durationMs);
    if (depth === "deep" && !streaming)
      throw new ApiError(
        400,
        "DEEP_REQUIRES_STREAM",
        "深度思考需要使用流式回答，请刷新页面后重试。",
      );
    traceRecorder = createTraceRecorder("ask", user.id, question.requestId);
    traceRecorder.mark("retrievalStart");
    const load = async () => {
      const { data, error } = await supabase
        .from("workspaces")
        .select("data,revision")
        .eq("owner_id", user.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new ApiError(404, "NO_WORKSPACE", "请先将资料保存到云端。");
      const workspace = workspaceSchema.safeParse(data.data);
      if (!workspace.success)
        throw new ApiError(422, "INVALID_CLOUD_DATA", "云端资料格式暂时无法读取。");
      return { workspace: workspace.data, revision: Number(data.revision) };
    };
    const loaded = await prepare(load);
    const initial = loaded.workspace;
    const initialRevision = loaded.revision;
    const memoryEnabled = aiFeatureEnabled("ANSWER_MEMORY");
    const priorMemory = memoryEnabled
      ? priorAnswerContext(initial, question, selectedSources(initial, question))
      : { answers: [], citations: [], key: null };
    const probeRevision = async (): Promise<number> => {
      const { data, error } = await supabase
        .from("workspaces")
        .select("revision")
        .eq("owner_id", user.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new ApiError(404, "NO_WORKSPACE", "请先将资料保存到云端。");
      const revision = Number(data.revision);
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new ApiError(422, "INVALID_CLOUD_DATA", "云端资料格式暂时无法读取。");
      return revision;
    };
    let validated: { workspace: WorkspaceData; revision: number } = loaded;
    /** Full parse only when the authoritative revision moved since the last validated snapshot. */
    const currentWorkspace = async () => {
      const revision = await probeRevision();
      if (revision === validated.revision) return validated;
      validated = await load();
      return validated;
    };
    assertScope(initial, question);
    if (request.signal.aborted)
      throw new ApiError(499, "REQUEST_CANCELLED", "回答已停止，问题已保留。");
    checkBudget();
    preflight?.dispose();
    const contextKey = questionContextKey(initial, question);
    const assertCurrent = async (signal: AbortSignal) => {
      if (signal.aborted) throw new ApiError(499, "REQUEST_CANCELLED", "回答已停止，问题已保留。");
      checkBudget();
      const auth = await requireUser(request);
      if (auth.user.id !== user.id)
        throw new ApiError(409, "SESSION_CHANGED", "当前账号已改变，本次回答未保存。");
      const latest = (await currentWorkspace()).workspace;
      if (signal.aborted) throw new ApiError(499, "REQUEST_CANCELLED", "回答已停止，问题已保留。");
      checkBudget();
      if (question.sourceVersions && hasFixedMultiSourceRange(question))
        assertScope(latest, question);
      if (questionContextKey(latest, question) !== contextKey)
        throw new ApiError(
          409,
          "QUESTION_CONTEXT_CHANGED",
          "资料或 AI 使用权限已改变，本次回答未保存。请基于当前资料重新提问。",
        );
      return latest;
    };
    const assertAnswer = async (answer: AnswerResult, signal: AbortSignal) => {
      const latest = await assertCurrent(signal);
      const allowed = new Set(selectedSources(latest, question).map((source) => source.id));
      const fixedVersions = new Map(
        (question.sourceVersions ?? []).map((reference) => [
          reference.sourceId,
          reference.versionId,
        ]),
      );
      const allowedNoteEvidence = selectedDocumentNoteEvidence(latest, question);
      const noteKey = (item: (typeof allowedNoteEvidence)[number]) =>
        JSON.stringify([
          item.noteId,
          item.spaceId,
          item.sourceId,
          item.sourceVersionId,
          item.revision,
          item.updatedAt,
          item.blockId,
          item.title,
          item.quote,
        ]);
      const allowedNotes = new Set(allowedNoteEvidence.map(noteKey));
      if (
        answer.citations.some(
          (citation) =>
            !allowed.has(citation.sourceId) ||
            !resolveCitation(latest, citation) ||
            (fixedVersions.size > 0 && fixedVersions.get(citation.sourceId) !== citation.versionId),
        ) ||
        (answer.noteEvidence ?? []).some(
          (evidence) =>
            !allowedNotes.has(noteKey(evidence)) ||
            !resolveAnswerNoteEvidence(latest, evidence) ||
            evidence.sourceId !== question.sourceId,
        )
      )
        throw new ApiError(
          409,
          "INVALID_CURRENT_CITATION",
          "回答依据已失效，请基于当前资料和笔记重新提问。",
        );
    };
    const run = async (signal: AbortSignal, send?: AnswerStreamSink): Promise<AnswerResult> => {
      try {
        await send?.({ type: "progress", phase: "retrieving" });
        if (!initial.aiEnabled) {
          traceOutcome = "extractive";
          return retrieveEvidence(initial, question);
        }
        const neighborRadius = aiFeatureEnabled("NEIGHBOR_EXPANSION") ? 1 : 0;
        const currentSearchSnapshot = async () => {
          if (signal.aborted)
            throw new ApiError(499, "REQUEST_CANCELLED", "回答已停止，问题已保留。");
          checkBudget();
          const auth = await requireUser(request);
          const latest = await currentWorkspace();
          if (signal.aborted)
            throw new ApiError(499, "REQUEST_CANCELLED", "回答已停止，问题已保留。");
          checkBudget();
          if (question.sourceVersions && hasFixedMultiSourceRange(question))
            assertScope(latest.workspace, question);
          if (
            auth.user.id !== user.id ||
            !Number.isSafeInteger(latest.revision) ||
            latest.revision < initialRevision ||
            questionContextKey(latest.workspace, question) !== contextKey
          )
            throw new ApiError(
              409,
              "QUESTION_CONTEXT_CHANGED",
              "资料或 AI 使用权限已改变，请重新提问。",
            );
          return latest;
        };
        const assertSearchCurrent = async () => {
          await currentSearchSnapshot();
        };
        const validateSnapshotRevision = async (observedRevision: number) => {
          const latest = await currentSearchSnapshot();
          // A conversation or reading-progress save may advance CAS without changing evidence.
          // Never trust a future RPC revision that an authenticated snapshot has not reached.
          assertScope(latest.workspace, question);
          return Number.isSafeInteger(latest.revision) && latest.revision >= observedRevision;
        };
        if (question.scope === "selection") {
          const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
          if (
            !question.selection?.trim() ||
            !selectedSources(initial, question).some((source) =>
              normalize(source.text).includes(normalize(question.selection!)),
            )
          )
            return retrieveEvidence(initial, question);
        }
        const searchData = { ...initial, sources: selectedSources(initial, question) };
        const glossaryTerms = await readGlossaryTerms(supabase, question.spaceId);
        const glossaryQuery = appendGlossaryAliases(answerRetrievalQuery(question), glossaryTerms);
        const searchRequest = {
          query: glossaryQuery.query,
          scope: isCrossLibraryAnswerRequest(question)
            ? { kind: "all" as const }
            : question.spaceId === "inbox"
              ? { kind: "inbox" as const }
              : { kind: "space" as const, spaceId: question.spaceId },
          limit: 100,
        };
        const glossaryFingerprint = glossaryQuery.fingerprint
          ? "glossary:" + glossaryQuery.fingerprint
          : null;
        const navigationCitations = aiFeatureEnabled("KNOWLEDGE_NAVIGATION")
          ? knowledgeNavigationCitations(initial, question, searchRequest.query)
          : [];
        const navigationFingerprint = navigationCitations.length
          ? JSON.stringify(
              navigationCitations.map((citation) => [
                citation.sourceId,
                citation.versionId,
                citation.chunkId,
              ]),
            )
          : null;
        traceRecorder?.set({ navigationCount: navigationCitations.length });
        const crossLibrary = isCrossLibraryAnswerRequest(question);
        const crossLibrarySemanticEnabled =
          crossLibrary && aiFeatureEnabled("CROSS_LIBRARY_SEMANTIC");
        let searchMode: "keyword" | "semantic" =
          (!crossLibrary || crossLibrarySemanticEnabled) &&
          initial.semanticSearch &&
          readEmbeddingConfig()
            ? "semantic"
            : "keyword";
        const selectedProfile = selectAnswerProfile(depth);
        const config = selectedProfile?.config;
        const format: AnswerFormat = aiFeatureEnabled("RICH_ANSWERS") ? "rich" : "plain";
        const sourceOutlines = config
          ? await readSourceOutlines(supabase, selectedSources(initial, question))
          : { outlines: new Map<string, OutlineItem[]>(), fingerprint: null };
        const outlineFingerprint = sourceOutlines.fingerprint
          ? [`outlines:${sourceOutlines.fingerprint}`]
          : [];
        const summaryRequested =
          Boolean(config) &&
          aiFeatureEnabled("SECTION_SUMMARIES") &&
          selectedSources(initial, question).length === 1 &&
          (classifyQuestionIntent(question.question) === "summary" ||
            /第([一二三四五六七八九十百\d]+)(?:章|节|部分)|chapter\s+(\d+)|section\s+(\d+)/iu.test(
              question.question,
            ));
        const sourceSummary = summaryRequested
          ? await readSourceSummaries(supabase, selectedSources(initial, question)[0]!)
          : { rows: [], fingerprint: null };
        const summaryFingerprint = sourceSummary.fingerprint
          ? [`summaries:${sourceSummary.fingerprint}`]
          : [];
        const summaryAvailable = sourceSummary.rows.some((row) => row.level === "document");
        const verifyEnabled = aiFeatureEnabled("ANSWER_VERIFY");
        const rerankEnabled = aiFeatureEnabled("RERANK");
        let rerankConfig = null;
        if (rerankEnabled) {
          try {
            rerankConfig = readRerankConfig();
          } catch {
            // An incomplete optional reranker configuration keeps the original order.
          }
        }
        const rerankFingerprint = rerankEnabled
          ? JSON.stringify(
              rerankConfig
                ? [
                    rerankConfig.baseUrl,
                    rerankConfig.model,
                    rerankConfig.maxCandidates,
                    rerankConfig.topN,
                  ]
                : null,
            )
          : undefined;
        const rewriteRequested =
          aiFeatureEnabled("QUERY_REWRITE") &&
          needsRewrite(question.question, question.userContext, searchData.sources);
        const fastProfile = rewriteRequested ? selectFastProfile() : null;
        let rewriteReservation:
          { kind: "reserved" } | { kind: "cached"; result: unknown } | undefined;
        const canRewrite = Boolean(config && fastProfile?.config && question.requestId);
        if (canRewrite) {
          const rewriteFingerprint = createHash("sha256")
            .update(
              JSON.stringify([
                GROUNDING_CONTRACT_VERSION,
                REWRITE_CONTRACT_VERSION,
                format,
                config!.baseUrl,
                config!.model,
                config!.jsonMode,
                config!.thinkingMode ?? null,
                selectedProfile!.profile,
                fastProfile!.profile,
                fastProfile!.config.baseUrl,
                fastProfile!.config.model,
                "neighbor:" + neighborRadius,
                contextKey,
                searchMode,
                readEmbeddingConfig()?.fingerprint ?? null,
                ...(rerankFingerprint === undefined ? [] : ["rerank:" + rerankFingerprint]),
                "depth:" + depth,
                ...(tutorModeEnabled ? ["mode:" + mode] : []),
                ...(verifyEnabled ? [VERIFY_CONTRACT_VERSION] : []),
                ...(memoryEnabled ? ["memory:" + priorMemory.key] : []),
                ...outlineFingerprint,
                ...(summaryAvailable ? [SUMMARY_CONTRACT_VERSION, ...summaryFingerprint] : []),
                ...(navigationFingerprint ? ["navigation:" + navigationFingerprint] : []),
                ...(glossaryFingerprint ? [glossaryFingerprint] : []),
              ]),
            )
            .digest("hex");
          const store = createRequestStore();
          rewriteReservation = await reserveRequest(
            store,
            user.id,
            question.requestId!,
            rewriteFingerprint,
            reservationOptions,
          );
          if (rewriteReservation.kind === "reserved")
            reservation = { store, ownerId: user.id, requestId: question.requestId! };
          await assertCurrent(signal);
          if (rewriteReservation.kind === "cached") {
            const cached = answerResultSchema.safeParse(rewriteReservation.result);
            if (!cached.success || cached.data.mode !== "model")
              throw new ApiError(
                503,
                "INVALID_SAVED_ANSWER",
                "已保存回答无法读取，请重新发起问题。",
              );
            await assertAnswer(cached.data, signal);
            traceOutcome = "cached";
            return cached.data;
          }
        }
        let retrievalQueries = [searchRequest.query];
        let rewriteUsed = false;
        if (canRewrite) {
          const rewritten = await rewriteQuery(
            fastProfile!.config,
            {
              question: question.question,
              priorUserQuestions: normalizeUserQuestionContext(question.userContext),
              documentLanguage: documentLanguage(searchData.sources),
            },
            signal,
          );
          if (rewritten) {
            retrievalQueries = [rewritten.query, ...rewritten.alternates]
              .map((query) => query.trim())
              .filter((query, index, all) => query.length > 0 && all.indexOf(query) === index);
            rewriteUsed = true;
          }
        }
        traceRecorder?.set({ rewrite: rewriteUsed });
        const retrieveLists = async (mode: "keyword" | "semantic") => {
          const lists = [];
          for (const query of retrievalQueries) {
            lists.push(
              await indexedSourceCandidates(
                supabase,
                searchData,
                initialRevision,
                { ...searchRequest, query },
                true,
                {
                  mode,
                  ownerId: user.id,
                  signal,
                  assertCurrent: assertSearchCurrent,
                  validateSnapshotRevision,
                },
              ),
            );
          }
          return lists;
        };
        let candidateLists;
        try {
          candidateLists = await retrieveLists(searchMode);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "SEMANTIC_NOT_READY") throw error;
          searchMode = "keyword";
          candidateLists = await retrieveLists("keyword");
        }
        const candidates =
          candidateLists.length === 1 ? candidateLists[0]! : fuseCandidates(candidateLists);
        await assertSearchCurrent();
        traceRecorder?.mark("retrievalEnd");
        let orderedCitations = indexedCitations(initial, question, candidates);
        let rerankUsed = false;
        if (rerankConfig && orderedCitations.length) {
          try {
            const pool = orderedCitations.slice(0, rerankConfig.maxCandidates);
            const indexes = await rerank(
              rerankConfig,
              retrievalQueries[0]!,
              pool.map((citation) => citation.quote.slice(0, 2_000)),
              signal,
            );
            if (
              indexes.some(
                (index, position) =>
                  !Number.isInteger(index) ||
                  index < 0 ||
                  index >= pool.length ||
                  indexes.indexOf(index) !== position,
              )
            )
              throw new Error("INVALID_RERANK_ORDER");
            const ranked = indexes.map((index) => pool[index]!);
            const seen = new Set(indexes);
            orderedCitations = [
              ...ranked,
              ...pool.filter((_citation, index) => !seen.has(index)),
              ...orderedCitations.slice(rerankConfig.maxCandidates),
            ];
            rerankUsed = true;
          } catch (error) {
            if (signal.aborted) throw error;
          }
        }
        traceRecorder?.set({ rerank: rerankUsed });
        let evidenceCharacters = 0;
        const citations = orderedCitations
          .filter((citation) => {
            if (citation.quote.length > 8000 || evidenceCharacters + citation.quote.length > 24000)
              return false;
            evidenceCharacters += citation.quote.length;
            return true;
          })
          .slice(0, 12);
        const coverageNotices = sourceCoverageNotices(searchData.sources);
        const coverage = coverageNotices.length ? `\n\n${coverageNotices.join(" ")}` : "";
        // Cross-language questions can miss the lexical index. Fall back to a
        // bounded document sample so the model (or extractive quotes) still has
        // canonical evidence instead of a permanent empty hit.
        let extractiveCitations = citations;
        if (!extractiveCitations.length) {
          extractiveCitations = buildGrounding(initial, question, undefined, {
            neighborRadius,
            navigationCitations,
          }).evidence.slice(0, 6);
        }
        const noteEvidence = extractiveCitations.length
          ? selectedDocumentNoteEvidence(initial, question)
          : [];
        const retrieved = {
          mode: "extractive" as const,
          citations: extractiveCitations,
          ...(noteEvidence.length ? { noteEvidence } : {}),
          content: extractiveCitations.length
            ? `以下是相关原文摘录，使用${searchMode === "semantic" ? "关键词与语义" : "关键词"}检索，未生成答案。\n\n${extractiveCitations
                .map(
                  (citation, index) =>
                    `**${extractiveCitationMarker(index)}**\n\n${citation.quote
                      .split("\n")
                      .map((line) => `> ${line}`)
                      .join("\n")}`,
                )
                .join("\n\n")}${formatNoteEvidenceExtracts(noteEvidence)}${coverage}`
            : `当前范围未找到可引用的原文证据，请调整关键词或缩小范围。${coverageNotices.length ? ` ${coverageNotices.join(" ")}` : ""}`,
        };
        traceRecorder?.set({
          intent: classifyQuestionIntent(question.question),
          scope: question.scope,
          searchMode,
          sourceCount: selectedSources(initial, question).length,
          candidateCount: candidates.length,
          evidenceCount: extractiveCitations.length,
          evidenceRefs: extractiveCitations.map((citation) => ({
            sourceId: citation.sourceId,
            versionId: citation.versionId,
            chunkId: citation.chunkId,
          })),
        });
        if (!selectedProfile || !config) {
          traceOutcome = "extractive";
          return retrieved;
        }
        traceModelName = config.model;
        traceModelProfile = selectedProfile.profile;
        const fullDocument =
          aiFeatureEnabled("LONG_CONTEXT") && (config.contextChars ?? 0) > 0
            ? buildFullDocumentGrounding(initial, question, config.contextChars!, {
                ...(sourceOutlines.outlines.size ? { outlines: sourceOutlines.outlines } : {}),
              })
            : null;
        const longContext =
          fullDocument &&
          new TextEncoder().encode(JSON.stringify(fullDocument.evidence)).length <=
            (config.maxRequestBytes ?? Number.MAX_SAFE_INTEGER) * 0.8
            ? fullDocument
            : null;
        const grounding =
          (summaryAvailable
            ? buildSummaryGrounding(
                initial,
                question,
                sourceSummary.rows,
                sourceOutlines.outlines.get(
                  `${selectedSources(initial, question)[0]?.id}:${selectedSources(initial, question)[0]?.versionId}`,
                ) ?? null,
              )
            : null) ??
          longContext ??
          buildGrounding(initial, question, retrieved, {
            neighborRadius,
            ...(memoryEnabled ? { priorCitations: priorMemory.citations } : {}),
            ...(navigationCitations.length ? { navigationCitations } : {}),
            ...(sourceOutlines.outlines.size ? { outlines: sourceOutlines.outlines } : {}),
          });
        if (longContext) traceRecorder?.set({ longContext: true });
        if (!grounding.evidence.length) {
          if (reservation)
            await failReservation(new ApiError(422, "MODEL_REQUEST_FAILED", "当前证据不足。"));
          traceOutcome = "insufficient";
          return grounding.fallback;
        }
        if (!question.requestId)
          throw new ApiError(400, "REQUEST_ID_REQUIRED", "请刷新页面后重新发起问题。");
        const store = reservation?.store ?? createRequestStore();
        const saved =
          rewriteReservation ??
          (await reserveRequest(
            store,
            user.id,
            question.requestId,
            createHash("sha256")
              .update(
                JSON.stringify([
                  GROUNDING_CONTRACT_VERSION,
                  format,
                  config.baseUrl,
                  config.model,
                  config.jsonMode,
                  config.thinkingMode ?? null,
                  selectedProfile.profile,
                  grounding.layout,
                  "neighbor:" + neighborRadius,
                  contextKey,
                  searchMode,
                  readEmbeddingConfig()?.fingerprint ?? null,
                  ...(rerankFingerprint === undefined ? [] : ["rerank:" + rerankFingerprint]),
                  "depth:" + depth,
                  ...(tutorModeEnabled ? ["mode:" + mode] : []),
                  ...(verifyEnabled ? [VERIFY_CONTRACT_VERSION] : []),
                  ...(memoryEnabled ? ["memory:" + priorMemory.key] : []),
                  ...outlineFingerprint,
                  ...(summaryAvailable ? [SUMMARY_CONTRACT_VERSION, ...summaryFingerprint] : []),
                  ...(navigationFingerprint ? ["navigation:" + navigationFingerprint] : []),
                  ...(glossaryFingerprint ? [glossaryFingerprint] : []),
                ]),
              )
              .digest("hex"),
            reservationOptions,
          ));
        if (saved.kind === "reserved" && !reservation)
          reservation = { store, ownerId: user.id, requestId: question.requestId };

        // Reservations can wait on another request. Revalidate before disclosure.
        await assertCurrent(signal);
        let answer;
        if (saved.kind === "cached") {
          const cached = answerResultSchema.safeParse(saved.result);
          if (!cached.success || cached.data.mode !== "model")
            throw new ApiError(503, "INVALID_SAVED_ANSWER", "已保存回答无法读取，请重新发起问题。");
          answer = cached.data;
          traceOutcome = "cached";
        } else {
          await send?.({ type: "progress", phase: "generating" });
          // Waiting for a downstream reader must not make the evidence check stale.
          await assertCurrent(signal);
          const preview = send ? createGroundingPreview(grounding, { format }) : undefined;
          const messages = groundingMessages(grounding, question, {
            format,
            mode,
            ...(memoryEnabled ? { priorAnswers: priorMemory.answers } : {}),
          });
          traceRecorder?.mark("modelStart");
          let lastReasoningHeartbeat = 0;
          const modelObserver: ModelObserver = {
            onUsage: (usage) => traceRecorder?.addUsage(usage),
            onFirstDelta: () => traceRecorder?.mark("firstDraft"),
            ...(depth === "deep"
              ? {
                  onReasoningDelta: async () => {
                    const now = Date.now();
                    if (now - lastReasoningHeartbeat < 5_000) return;
                    lastReasoningHeartbeat = now;
                    await send?.({ type: "progress", phase: "reasoning" });
                  },
                }
              : {}),
          };
          const raw = send
            ? await callModelStream(
                config,
                messages,
                signal,
                async (delta) => {
                  const draft = preview!.push(delta);
                  if (draft)
                    await send({ type: "draft", answer: draft }, () => assertAnswer(draft, signal));
                },
                modelObserver,
              )
            : await callModel(config, messages, signal, modelObserver);
          traceRecorder?.mark("modelEnd");
          await send?.({ type: "progress", phase: "validating" });
          const parsedAnswer = parseGeneratedAnswer(raw, grounding);
          let unsupported = new Set<number>();
          if (verifyEnabled && parsedAnswer.status === "answered") {
            traceRecorder?.mark("verifyStart");
            try {
              const fastProfile = selectFastProfile();
              if (fastProfile?.config) {
                unsupported = await findUnsupportedParagraphs(
                  fastProfile.config,
                  parsedAnswer,
                  grounding,
                  AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                  modelObserver,
                );
              } else traceRecorder?.set({ verify: "skipped" });
            } catch (error) {
              if (signal.aborted) throw error;
              traceRecorder?.set({ verify: "skipped" });
            }
            traceRecorder?.mark("verifyEnd");
          }
          answer = renderGeneratedAnswer(parsedAnswer, grounding, { format, unsupported });
          traceOutcome =
            answer.mode === "model" && answer.citations.length === 0 ? "insufficient" : "completed";
        }
        await assertAnswer(answer, signal);
        if (reservation) {
          await finishRequest(store, user.id, question.requestId, answer);
          reservation = undefined;
          // Protect the interval spent saving the result, too.
          await assertCurrent(signal);
        }
        return answer;
      } catch (error) {
        if (error instanceof ApiError) {
          traceErrorCode = error.code;
          if (error.code === "REQUEST_CANCELLED" || error.code === "MODEL_CANCELLED")
            traceOutcome = "cancelled";
        }
        // Start an idempotent terminal write, including when a late reservation
        // resolves after cancellation. The caller publishes the original error
        // without waiting for this bounded best-effort cleanup.
        void failReservation(error);
        throw error;
      }
    };
    checkBudget();
    if (streaming)
      return answerStreamResponse(
        request.signal,
        async (signal, send) => {
          try {
            const answer = await run(signal, send);
            await send({ type: "complete", answer }, () => assertAnswer(answer, signal));
          } finally {
            finishTrace();
          }
        },
        failReservation,
        deadlineAt,
      );
    const answer = await run(request.signal);
    finishTrace();
    return json(answer);
  } catch (error) {
    if (error instanceof ApiError) {
      traceErrorCode = error.code;
      if (error.code === "REQUEST_CANCELLED" || error.code === "MODEL_CANCELLED")
        traceOutcome = "cancelled";
    }
    finishTrace();
    preflight?.dispose(error);
    // A failed reservation stays non-replayable even if the best-effort
    // terminal write outlives this response. Do not let that write mask the
    // original authentication, workspace, model, or cancellation error.
    void failReservation(error);
    return failure(error);
  }
}
