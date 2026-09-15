import type { Citation, Note, WorkspaceData } from "./types";
import type { KnowledgeNoteSnapshot } from "./knowledge-update-types";
import type { OrganizationJob, OrganizationRequest } from "./organization-types";
import type {
  ConceptRelation,
  RelationDraft,
  RelationInput,
  RelationProposal,
  RelationType,
} from "./concept-relation-types";
import {
  conceptRelationSchema,
  relationDraftSchema,
  relationInputSchema,
  relationProposalSchema,
} from "./concept-relation-schema";
import {
  knowledgeNoteKey,
  knowledgeUpdateTargetReason,
  snapshotKnowledgeNote,
} from "./knowledge-update";
import { knowledgeNoteSnapshotSchema } from "./knowledge-update-schema";
import { organizationReviewReason } from "./organization";
import { resolveCitation } from "./retrieval";
import { MAX_WORKSPACE_BYTES } from "./supabase/validation";

export const relationLabels: Record<RelationType, string> = {
  synonym: "同义词候选",
  related: "相关概念",
  prerequisite: "前置知识",
  conflict: "冲突观点",
};
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const citationKey = (c: Citation) =>
  JSON.stringify([c.sourceId, c.versionId, c.chunkId, c.title, c.quote, c.page ?? null, c.section]);
const citationsOf = (draft: RelationDraft) => [...draft.fromCitations, ...draft.toCitations];
function scopeExists(data: WorkspaceData, spaceId: string) {
  return (
    spaceId === "inbox" || data.spaces.some((space) => space.id === spaceId && !space.archived)
  );
}
function currentCitation(data: WorkspaceData, citation: Citation, spaceId: string) {
  const found = resolveCitation(data, citation);
  return (
    !!found &&
    (spaceId === "inbox"
      ? found.source.spaceIds.length === 0
      : found.source.spaceIds.includes(spaceId)) &&
    !!normalize(citation.quote) &&
    normalize(found.source.text).includes(normalize(citation.quote)) &&
    found.chunk.page === citation.page &&
    found.chunk.section === citation.section
  );
}
function currentPair(data: WorkspaceData, fromId: string, toId: string): [Note, Note] {
  if (fromId === toId) throw new Error("请选择两个不同的知识页。");
  const from = data.notes.find(
    (note) => note.id === fromId && note.kind === "knowledge" && !note.deletedAt,
  );
  const to = data.notes.find(
    (note) => note.id === toId && note.kind === "knowledge" && !note.deletedAt,
  );
  if (!from || !to) throw new Error("关系涉及的知识页已不可用。");
  if (from.spaceId !== to.spaceId || !scopeExists(data, from.spaceId))
    throw new Error("关系需要两个属于同一可用知识库的知识页。");
  return [from, to];
}

/** Both user-owned pages and all inherited evidence must be allowed before model transmission. */
export function relationTargetsReason(data: WorkspaceData, request: OrganizationRequest): string {
  if (request.kind !== "relations") return "";
  if (
    !request.targetNote ||
    !request.compareNote ||
    request.targetNote.id === request.compareNote.id
  )
    return "请选定两个不同知识页再生成关系建议。";
  for (const targetNote of [request.targetNote, request.compareNote]) {
    const reason = knowledgeUpdateTargetReason(data, {
      ...request,
      kind: "update",
      targetNote,
      compareNote: undefined,
    });
    if (reason) return reason;
  }
  const bases = [request.targetNote, request.compareNote].map((basis) =>
    snapshotKnowledgeNote(data.notes.find((note) => note.id === basis.id)!),
  );
  if (new TextEncoder().encode(JSON.stringify(bases)).byteLength > 120 * 1024)
    return "两个知识页的正文和引用快照合计超过 120 KiB，请缩短或拆分页面后再生成关系建议。";
  return "";
}

export function validateRelationProposals(
  target: KnowledgeNoteSnapshot,
  compare: KnowledgeNoteSnapshot,
  proposals: RelationProposal[],
): boolean {
  if (
    !knowledgeNoteSnapshotSchema.safeParse(target).success ||
    !knowledgeNoteSnapshotSchema.safeParse(compare).success ||
    target.id === compare.id ||
    target.spaceId !== compare.spaceId ||
    proposals.length > 4
  )
    return false;
  return (
    new Set(proposals.map((p) => p.id)).size === proposals.length &&
    new Set(proposals.map((p) => p.type)).size === proposals.length &&
    proposals.every((p) => relationProposalSchema.safeParse(p).success)
  );
}

export function relationReviewReason(data: WorkspaceData, job: OrganizationJob): string {
  if (job.request.kind !== "relations" || job.result?.kind !== "relations")
    return "这项任务不是知识关系建议。";
  const reason = organizationReviewReason(data, job);
  if (reason) return reason;
  const { target, compare, relations } = job.result;
  if (!validateRelationProposals(target, compare, relations))
    return "关系建议的类型、依据或页面基线无效，请重新生成。";
  for (const [snapshot, basis] of [
    [target, job.request.targetNote],
    [compare, job.request.compareNote],
  ] as const) {
    if (
      !basis ||
      snapshot.id !== basis.id ||
      snapshot.revision !== basis.revision ||
      snapshot.updatedAt !== basis.updatedAt ||
      snapshot.spaceId !== job.request.spaceId
    )
      return "关系建议与请求的页面版本不一致，请重新生成。";
    const note = data.notes.find(
      (n) => n.id === snapshot.id && n.kind === "knowledge" && !n.deletedAt,
    );
    if (!note || knowledgeNoteKey(note) !== knowledgeNoteKey(snapshot))
      return "关系涉及的知识页已被修改或删除，请基于当前两个页面重新生成。";
    if (snapshot.citations.some((c) => !currentCitation(data, c, snapshot.spaceId)))
      return "知识页原有引用已变化，请核对原文后重新生成关系建议。";
  }
  const reviewed = [
    ...(job.savedRelations?.map((r) => r.proposalId) ?? []),
    ...(job.ignoredRelations ?? []),
  ];
  if (
    new Set(reviewed).size !== reviewed.length ||
    reviewed.some((id) => !relations.some((p) => p.id === id))
  )
    return "关系建议的审核记录不一致，请重新生成。";
  return "";
}

/** Reading an existing relation is allowed with AI disabled; stale evidence stays visibly stale. */
export function relationAvailabilityReason(data: WorkspaceData, relation: ConceptRelation): string {
  if (relation.deletedAt) return "关系已删除，可恢复。";
  try {
    const [from, to] = currentPair(data, relation.from.id, relation.to.id);
    if (
      from.spaceId !== relation.spaceId ||
      knowledgeNoteKey(from) !== knowledgeNoteKey(relation.from) ||
      knowledgeNoteKey(to) !== knowledgeNoteKey(relation.to)
    )
      return "关联页面已变化，请重新核对关系；这里保留的是此前记录。";
    if (
      [...citationsOf(relation), ...relation.from.citations, ...relation.to.citations].some(
        (c) => !currentCitation(data, c, relation.spaceId),
      )
    )
      return "关系的部分原文依据已删除、移库或变更版本，请重新核对。";
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : "关系暂不可用。";
  }
}
function pairKey(relation: Pick<ConceptRelation, "type" | "from" | "to">) {
  const ids = [relation.from.id, relation.to.id];
  if (relation.type !== "prerequisite") ids.sort();
  return JSON.stringify([relation.type, ...ids]);
}
function assertDraft(
  data: WorkspaceData,
  draft: RelationDraft,
  spaceId: string,
  origin: ConceptRelation["origin"],
) {
  const parsed = relationDraftSchema.safeParse(draft);
  if (!parsed.success)
    throw new Error(parsed.error.issues[0]?.message || "请核对关系的观点、条件和原文依据。");
  if (origin === "manual" && !citationsOf(draft).length)
    throw new Error("手动关系至少需要一处原文依据，请先为知识页补充引用。");
  if (citationsOf(draft).some((c) => !currentCitation(data, c, spaceId)))
    throw new Error("关系的原文依据已不可用或不在当前知识库，请重新选择。");
  return parsed.data;
}
function assertCapacity(data: WorkspaceData): WorkspaceData {
  if ((data.conceptRelations?.length ?? 0) > 2000)
    throw new Error("工作区关系记录已达 2000 条上限，请先导出并处理容量。");
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_WORKSPACE_BYTES)
    throw new Error("保存关系会超过工作区 3 MiB 容量，请先导出并处理容量；本次未保存。");
  return data;
}
function putRelation(data: WorkspaceData, relation: ConceptRelation): WorkspaceData {
  const valid = conceptRelationSchema.safeParse(relation);
  if (!valid.success)
    throw new Error(valid.error.issues[0]?.message || "关系超出保存容量或格式无效。");
  if (
    (data.conceptRelations ?? []).some(
      (item) =>
        item.id !== relation.id &&
        !item.deletedAt &&
        !relation.deletedAt &&
        pairKey(item) === pairKey(relation),
    )
  )
    throw new Error("这两个知识页已经有同类型关系，请编辑现有关系。");
  const exists = data.conceptRelations?.some((item) => item.id === relation.id);
  return assertCapacity({
    ...data,
    conceptRelations: exists
      ? data.conceptRelations!.map((item) => (item.id === relation.id ? valid.data : item))
      : [...(data.conceptRelations ?? []), valid.data],
  });
}
function currentRelation(data: WorkspaceData, id: string, revision: number) {
  const relation = data.conceptRelations?.find((r) => r.id === id);
  if (!relation || relation.revision !== revision)
    throw new Error("关系已被其他操作修改，请重新打开后再操作。");
  if (relation.revision >= Number.MAX_SAFE_INTEGER - 1)
    throw new Error("关系版本已达上限，请先导出副本。");
  return relation;
}

export function saveConceptRelation(
  data: WorkspaceData,
  input: RelationInput,
  existing?: { id: string; revision: number },
): WorkspaceData {
  const parsed = relationInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || "关系内容格式无效。");
  const { fromNoteId, toNoteId, ...fields } = parsed.data;
  const old = existing ? currentRelation(data, existing.id, existing.revision) : undefined;
  if (old?.deletedAt) throw new Error("请先恢复已删除关系，再编辑。");
  const [from, to] = currentPair(data, fromNoteId, toNoteId);
  const origin = old?.origin ?? "manual";
  const draft = assertDraft(data, fields, from.spaceId, origin);
  const now = new Date().toISOString();
  return putRelation(data, {
    ...old,
    ...draft,
    id: old?.id ?? crypto.randomUUID(),
    spaceId: from.spaceId,
    from: snapshotKnowledgeNote(from),
    to: snapshotKnowledgeNote(to),
    origin,
    revision: old ? old.revision + 1 : 0,
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
    deletedAt: null,
  });
}

export function acceptRelationProposal(
  data: WorkspaceData,
  jobId: string,
  proposalId: string,
  patch?: RelationDraft,
): WorkspaceData {
  const job = data.organizationJobs?.find((j) => j.id === jobId);
  if (!job) throw new Error("关系建议已不可用。");
  const reason = relationReviewReason(data, job);
  if (reason) throw new Error(reason);
  if (job.result?.kind !== "relations") throw new Error("关系建议类型无效。");
  if (
    job.savedRelations?.some((r) => r.proposalId === proposalId) ||
    job.ignoredRelations?.includes(proposalId)
  )
    throw new Error("这项关系建议已经处理，请查看已保存关系。");
  const proposal = job.result.relations.find((r) => r.id === proposalId);
  if (!proposal) throw new Error("这项关系建议不存在。");
  const { id: unused, ...original } = proposal;
  void unused;
  const draft = assertDraft(data, patch ?? original, job.request.spaceId, "ai");
  const allowed = new Set(
    [...citationsOf(proposal), ...job.result.target.citations, ...job.result.compare.citations].map(
      citationKey,
    ),
  );
  if (citationsOf(draft).some((c) => !allowed.has(citationKey(c))))
    throw new Error("编辑后的依据不属于本次建议或两个知识页，请重新生成。");
  const now = new Date().toISOString();
  const relation: ConceptRelation = {
    ...draft,
    id: crypto.randomUUID(),
    spaceId: job.request.spaceId,
    from: job.result.target,
    to: job.result.compare,
    origin: "ai",
    revision: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    jobId,
    proposalId,
  };
  const next = putRelation(data, relation);
  return assertCapacity({
    ...next,
    organizationJobs: next.organizationJobs?.map((j) =>
      j.id === job.id
        ? {
            ...j,
            updatedAt: now,
            savedRelations: [...(j.savedRelations ?? []), { proposalId, relationId: relation.id }],
          }
        : j,
    ),
  });
}
export function ignoreRelationProposal(
  data: WorkspaceData,
  jobId: string,
  proposalId: string,
): WorkspaceData {
  const job = data.organizationJobs?.find((j) => j.id === jobId);
  if (!job) throw new Error("关系建议已不可用。");
  const reason = relationReviewReason(data, job);
  if (reason) throw new Error(reason);
  if (job.result?.kind !== "relations" || !job.result.relations.some((r) => r.id === proposalId))
    throw new Error("关系建议不存在。");
  if (job.savedRelations?.some((r) => r.proposalId === proposalId))
    throw new Error("已接受的关系请在关系列表中编辑或删除。");
  return assertCapacity({
    ...data,
    organizationJobs: data.organizationJobs?.map((j) =>
      j.id === job.id
        ? {
            ...j,
            updatedAt: new Date().toISOString(),
            ignoredRelations: [...new Set([...(j.ignoredRelations ?? []), proposalId])],
          }
        : j,
    ),
  });
}
export function deleteConceptRelation(
  data: WorkspaceData,
  id: string,
  revision: number,
): WorkspaceData {
  const relation = currentRelation(data, id, revision);
  if (relation.deletedAt) return data;
  const now = new Date().toISOString();
  return putRelation(data, { ...relation, revision: revision + 1, deletedAt: now, updatedAt: now });
}
export function restoreConceptRelation(
  data: WorkspaceData,
  id: string,
  revision: number,
): WorkspaceData {
  const relation = currentRelation(data, id, revision);
  if (!relation.deletedAt) return data;
  // Restore the old record as-is; the read guard continues to label stale endpoints/evidence.
  return putRelation(data, {
    ...relation,
    revision: revision + 1,
    deletedAt: null,
    updatedAt: new Date().toISOString(),
  });
}
