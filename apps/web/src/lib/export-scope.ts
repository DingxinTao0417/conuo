import type { KnowledgeNoteSnapshot } from "./knowledge-update-types";
import type { RelationDraft } from "./concept-relation-types";
import type { OrganizationJob } from "./organization-types";
import type {
  AnswerScopeSnapshot,
  Citation,
  ManualExcerptReference,
  Source,
  WorkspaceData,
} from "./types";

export type WorkspaceExportScope = { kind: "workspace" } | { kind: "space"; spaceId: string };
export interface ExportSourceVersion {
  versionId: string;
  state: "current" | "historical";
}
export interface AdditionalExportSource {
  sourceId: string;
  title: string;
  deletedAt: string | null;
  versions: ExportSourceVersion[];
  reasons: string[];
}
export interface MissingExportReference {
  sourceId: string;
  versionId?: string;
  chunkId?: string;
  from: string;
  reason: "source-missing" | "version-missing" | "chunk-missing" | "quote-invalid";
}
export interface WorkspaceExportPreview {
  scope: WorkspaceExportScope;
  spaceName: string | null;
  counts: {
    spaces: number;
    sources: number;
    sourceVersions: number;
    notes: number;
    knowledgePages: number;
    recycledSources: number;
    recycledNotes: number;
    conversations: number;
    annotations: number;
    importJobs: number;
    organizationJobs: number;
    conceptRelations: number;
    recoverableDrafts: number;
  };
  memberSourceIds: string[];
  additionalSources: AdditionalExportSource[];
  missingReferences: MissingExportReference[];
  knownMissingOriginals: {
    sourceId: string;
    versionId: string;
    title: string;
    state: "current" | "historical";
  }[];
  warnings: string[];
  /** Only embedded foreign personal/knowledge snapshots, for concise UI notices. */
  historicalEvidenceWarnings: string[];
}
export interface WorkspaceExportManifest extends WorkspaceExportPreview {
  schemaVersion: 1;
  allRetainedVersions: true;
}
export interface PreparedWorkspaceExport {
  data: WorkspaceData;
  preview: WorkspaceExportPreview;
  manifest: WorkspaceExportManifest;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const versions = (source: Source): ExportSourceVersion[] => [
  { versionId: source.versionId, state: "current" },
  ...(source.versions ?? []).map((version) => ({
    versionId: version.versionId,
    state: "historical" as const,
  })),
];

/** Build a stable, lossless scope snapshot before any original-byte IO starts. */
export function prepareWorkspaceExport(
  data: WorkspaceData,
  scope: WorkspaceExportScope = { kind: "workspace" },
): PreparedWorkspaceExport {
  if (scope.kind !== "workspace" && scope.kind !== "space")
    throw new Error("导出范围无效，未导出任何内容。");
  const snapshot = structuredClone(data);
  const selected =
    scope.kind === "space" ? snapshot.spaces.filter((space) => space.id === scope.spaceId) : [];
  if (scope.kind === "space" && selected.length !== 1)
    throw new Error("所选学习空间不存在或身份不唯一，请重新选择导出范围。");
  const selectedSpaceId = scope.kind === "space" ? scope.spaceId : null;
  const memberSourceIds = snapshot.sources
    .filter((source) => selectedSpaceId === null || source.spaceIds.includes(selectedSpaceId))
    .map((source) => source.id);
  const included = new Set(memberSourceIds);
  const sourcesById = new Map<string, Source>();
  for (const source of snapshot.sources) {
    if (sourcesById.has(source.id)) throw new Error("资料身份重复，无法确认导出范围。");
    sourcesById.set(source.id, source);
  }
  const sourceReasons = new Map<string, Set<string>>();
  const missingReferences: MissingExportReference[] = [];
  const missingKeys = new Set<string>();
  const warnings = new Set<string>();
  const historicalEvidenceWarnings = new Set<string>();
  function missing(reference: MissingExportReference) {
    const key = JSON.stringify(reference);
    if (!missingKeys.has(key)) {
      missingKeys.add(key);
      missingReferences.push(reference);
    }
  }
  function reference(
    sourceId: string,
    versionId: string | undefined,
    chunkId: string | undefined,
    from: string,
    quote?: string,
  ) {
    const identity = {
      sourceId,
      ...(versionId !== undefined ? { versionId } : {}),
      ...(chunkId !== undefined ? { chunkId } : {}),
      from,
    };
    const source = sourcesById.get(sourceId);
    if (!source) {
      missing({ ...identity, reason: "source-missing" });
      return;
    }
    included.add(sourceId);
    if (!sourceReasons.has(sourceId)) sourceReasons.set(sourceId, new Set());
    sourceReasons.get(sourceId)!.add(from);
    const retained =
      versionId === undefined
        ? source
        : [source, ...(source.versions ?? [])].find((version) => version.versionId === versionId);
    if (!retained) {
      missing({ ...identity, reason: "version-missing" });
      return;
    }
    if (
      chunkId !== undefined &&
      !retained.chunks.some(
        (chunk) =>
          chunk.id === chunkId &&
          chunk.sourceId === sourceId &&
          chunk.versionId === retained.versionId,
      )
    )
      missing({ ...identity, reason: "chunk-missing" });
    else if (
      quote !== undefined &&
      (!quote.replace(/\s/gu, "") ||
        !retained.text.replace(/\s/gu, "").includes(quote.replace(/\s/gu, "")))
    )
      missing({ ...identity, reason: "quote-invalid" });
  }
  function citations(values: readonly Citation[] | undefined, from: string) {
    for (const value of values ?? [])
      reference(value.sourceId, value.versionId, value.chunkId, from, value.quote);
  }
  function manual(values: readonly ManualExcerptReference[] | undefined, from: string) {
    for (const value of values ?? [])
      reference(value.sourceId, value.versionId, value.chunkId, from);
  }
  function basis(value: KnowledgeNoteSnapshot | undefined, from: string) {
    if (!value) return;
    citations(value.citations, from);
    if (
      selectedSpaceId !== null &&
      (value.spaceId !== selectedSpaceId || !selectedNoteIds.has(value.id))
    )
      historicalEvidenceWarnings.add(
        "知识关系或整理记录保留其他页面的历史基线快照，可能含其他学习空间的摘录；不会附带这些页面的当前正文或全部历史。",
      );
  }
  function relation(value: RelationDraft, from: string) {
    citations(value.fromCitations, `${from} 起点依据`);
    citations(value.toCitations, `${from} 终点依据`);
  }
  function answerScope(value: AnswerScopeSnapshot, from: string) {
    const fixed = new Map(
      (value.sourceVersions ?? []).map((item) => [item.sourceId, item.versionId]),
    );
    if (value.sourceId) reference(value.sourceId, fixed.get(value.sourceId), undefined, from);
    for (const id of value.sourceIds) reference(id, fixed.get(id), undefined, from);
    for (const item of value.sourceVersions ?? [])
      reference(item.sourceId, item.versionId, undefined, from);
    if (value.comparison) {
      reference(value.comparison.leftSourceId, value.comparison.leftVersionId, undefined, from);
      reference(value.comparison.rightSourceId, value.comparison.rightVersionId, undefined, from);
    }
  }
  function job(value: OrganizationJob) {
    const from = `整理任务 ${value.id}`;
    const fixed = new Map(
      value.request.sourceVersions.map((item) => [item.sourceId, item.versionId]),
    );
    for (const id of value.request.sourceIds) reference(id, fixed.get(id), undefined, from);
    for (const item of value.request.sourceVersions)
      reference(item.sourceId, item.versionId, undefined, from);
    const result = value.result;
    if (result?.kind === "source") {
      citations(result.summary.citations, from);
      for (const label of [...result.tags, ...result.topics]) citations(label.citations, from);
    } else if (result?.kind === "knowledge") {
      for (const page of result.pages) citations(page.citations, from);
    } else if (result?.kind === "update") {
      basis(result.target, `${from} 目标快照`);
      for (const change of result.changes) citations(change.citations, from);
    } else if (result?.kind === "relations") {
      basis(result.target, `${from} 起点快照`);
      basis(result.compare, `${from} 终点快照`);
      for (const proposal of result.relations) relation(proposal, from);
    }
    basis(value.updateReview?.note, `${from} 审核快照`);
  }
  if (selectedSpaceId !== null) {
    snapshot.spaces = selected;
    snapshot.notes = snapshot.notes.filter((note) => note.spaceId === selectedSpaceId);
    snapshot.conversations = snapshot.conversations.filter(
      (conversation) => conversation.spaceId === selectedSpaceId,
    );
    if (snapshot.organizationJobs !== undefined)
      snapshot.organizationJobs = snapshot.organizationJobs.filter(
        (value) => value.request.spaceId === selectedSpaceId,
      );
  }
  const selectedNoteIds = new Set(snapshot.notes.map((note) => note.id));
  if (selectedSpaceId !== null && snapshot.conceptRelations !== undefined) {
    snapshot.conceptRelations = snapshot.conceptRelations.filter(
      (value) => value.spaceId === selectedSpaceId,
    );
  }
  for (const note of snapshot.notes) {
    citations(note.citations, `笔记 ${note.id}`);
    manual(note.manualExcerptRefs, `笔记 ${note.id} 手工摘录`);
    for (const version of note.versions) {
      citations(version.citations, `笔记 ${note.id} 历史 ${version.id}`);
      manual(version.manualExcerptRefs, `笔记 ${note.id} 历史 ${version.id} 手工摘录`);
    }
  }
  for (const conversation of snapshot.conversations) {
    const from = `对话 ${conversation.id}`;
    if (conversation.sourceId) reference(conversation.sourceId, undefined, undefined, from);
    for (const id of conversation.sourceIds) reference(id, undefined, undefined, from);
    if (conversation.comparison) {
      reference(
        conversation.comparison.leftSourceId,
        conversation.comparison.leftVersionId,
        undefined,
        `${from} 对照范围`,
      );
      reference(
        conversation.comparison.rightSourceId,
        conversation.comparison.rightVersionId,
        undefined,
        `${from} 对照范围`,
      );
    }
    for (const message of conversation.messages) {
      citations(message.citations, `${from} 消息 ${message.id}`);
      for (const evidence of message.noteEvidence ?? []) {
        reference(evidence.sourceId, evidence.sourceVersionId, undefined, `${from} 个人笔记依据`);
        if (selectedSpaceId !== null && !selectedNoteIds.has(evidence.noteId))
          historicalEvidenceWarnings.add(
            "对话保留回答当时的个人笔记历史摘录；不会附带所引笔记的其他当前正文或全部历史。",
          );
      }
      if (message.attempt)
        answerScope(message.attempt.scopeSnapshot, `${from} 回答范围 ${message.attempt.id}`);
    }
  }
  for (const value of snapshot.organizationJobs ?? []) job(value);
  for (const value of snapshot.conceptRelations ?? []) {
    relation(value, `知识关系 ${value.id}`);
    basis(value.from, `知识关系 ${value.id} 起点快照`);
    basis(value.to, `知识关系 ${value.id} 终点快照`);
  }
  if (selectedSpaceId !== null) {
    snapshot.sources = snapshot.sources.filter((source) => included.has(source.id));
    snapshot.sources.forEach((source) => {
      source.spaceIds = memberSourceIds.includes(source.id) ? [selectedSpaceId] : [];
    });
    snapshot.annotations = snapshot.annotations.filter((value) => included.has(value.sourceId));
    if (snapshot.importJobs !== undefined)
      snapshot.importJobs = snapshot.importJobs
        .filter((value) => included.has(value.sourceId))
        .map((value) => ({
          ...value,
          spaceId: value.spaceId === selectedSpaceId ? selectedSpaceId : "",
        }));
    if (snapshot.recoverableDrafts !== undefined)
      snapshot.recoverableDrafts = snapshot.recoverableDrafts.filter((value) =>
        included.has(value.sourceId),
      );
    if (snapshot.resolvedRecoverableDrafts !== undefined)
      snapshot.resolvedRecoverableDrafts = snapshot.resolvedRecoverableDrafts.filter((value) =>
        included.has(value.sourceId),
      );
  }
  const members = new Set(memberSourceIds);
  const additionalSources = snapshot.sources
    .filter((source) => !members.has(source.id))
    .map((source) => ({
      sourceId: source.id,
      title: source.title,
      deletedAt: source.deletedAt,
      versions: versions(source),
      reasons: [...(sourceReasons.get(source.id) ?? [])],
    }));
  if (additionalSources.length)
    warnings.add(
      "为保留可追踪原文依据，将额外包含引用资料的当前完整正文、全部保留历史版本，以及这些资料的全部批注与可恢复草稿；这些资料不会关联到所选学习空间。",
    );
  for (const warning of historicalEvidenceWarnings) warnings.add(warning);
  if (selectedSpaceId !== null)
    warnings.add(
      "所选空间的回收站项目及已选笔记的全部历史正文也会包含；旧版本中的空间身份仅作为历史记录保留。",
    );
  warnings.add(
    "原件是否可取得需在生成 ZIP 时逐版本读取；已知缺失和最终读取问题会分别列出，预览不保证全部原件可用。",
  );
  if (missingReferences.length)
    warnings.add(
      "部分引用的资料、版本或片段缺失或无法核对，原有引用保留，不会以当前版本替代；详见缺失引用清单。",
    );
  const knownMissingOriginals = snapshot.sources.flatMap((source) => [
    ...(source.originalMissing
      ? [
          {
            sourceId: source.id,
            versionId: source.versionId,
            title: source.title,
            state: "current" as const,
          },
        ]
      : []),
    ...(source.versions ?? [])
      .filter((version) => version.originalMissing)
      .map((version) => ({
        sourceId: source.id,
        versionId: version.versionId,
        title: version.title,
        state: "historical" as const,
      })),
  ]);
  const preview: WorkspaceExportPreview = {
    scope: structuredClone(scope),
    spaceName: selected[0]?.name ?? null,
    counts: {
      spaces: snapshot.spaces.length,
      sources: snapshot.sources.length,
      sourceVersions: snapshot.sources.reduce(
        (total, source) => total + 1 + (source.versions?.length ?? 0),
        0,
      ),
      notes: snapshot.notes.length,
      knowledgePages: snapshot.notes.filter((note) => note.kind === "knowledge").length,
      recycledSources: snapshot.sources.filter((source) => source.deletedAt).length,
      recycledNotes: snapshot.notes.filter((note) => note.deletedAt).length,
      conversations: snapshot.conversations.length,
      annotations: snapshot.annotations.length,
      importJobs: snapshot.importJobs?.length ?? 0,
      organizationJobs: snapshot.organizationJobs?.length ?? 0,
      conceptRelations: snapshot.conceptRelations?.length ?? 0,
      recoverableDrafts: snapshot.recoverableDrafts?.length ?? 0,
    },
    memberSourceIds,
    additionalSources,
    missingReferences,
    knownMissingOriginals,
    warnings: [...warnings],
    historicalEvidenceWarnings: [...historicalEvidenceWarnings],
  };
  return freeze({
    data: snapshot,
    preview,
    manifest: { schemaVersion: 1, allRetainedVersions: true, ...preview },
  });
}

/** No timestamps: unrelated workspace edits do not invalidate an explicitly reviewed scope. */
export function workspaceExportFingerprint(
  data: WorkspaceData,
  scope: WorkspaceExportScope,
): string {
  const prepared = prepareWorkspaceExport(data, scope);
  return JSON.stringify({ data: prepared.data, manifest: prepared.manifest });
}
