import { markdownToEditorHtml } from "./markdown";
import { knowledgeAcceptanceReason, organizationReviewReason } from "./organization";
import type { OrganizationJob } from "./organization-types";
import type { Note, WorkspaceData } from "./types";
import { reviseNote } from "./note-versions";

function jobForReview(data: WorkspaceData, jobId: string): OrganizationJob {
  const job = data.organizationJobs?.find((item) => item.id === jobId);
  if (!job) throw new Error("整理记录已不可用。");
  const reason = organizationReviewReason(data, job);
  if (reason) throw new Error(reason);
  return job;
}

function withJob(data: WorkspaceData, job: OrganizationJob): WorkspaceData {
  return {
    ...data,
    organizationJobs: data.organizationJobs?.map((item) => (item.id === job.id ? job : item)),
  };
}

/** All tag writers advance the revision, including manual delete-and-readd cycles. */
function nextTagRevision(revision = 0): number {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER - 1)
    throw new Error("标签版本无效，请导出副本后重新载入工作区。");
  return revision + 1;
}

export function setSourceTags(
  data: WorkspaceData,
  sourceId: string,
  labels: string[],
): WorkspaceData {
  const source = data.sources.find((item) => item.id === sourceId && !item.deletedAt);
  if (!source) throw new Error("这份资料已不可用，标签未修改。");
  const tags = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  if (tags.length > 100 || tags.some((label) => label.length > 100))
    throw new Error("每份资料最多 100 个标签，每个标签最多 100 字符。");
  if (JSON.stringify(tags) === JSON.stringify(source.tags)) return data;
  const tagsRevision = nextTagRevision(source.tagsRevision);
  return {
    ...data,
    sources: data.sources.map((item) =>
      item.id === sourceId
        ? { ...item, tags, tagsRevision, updatedAt: new Date().toISOString() }
        : item,
    ),
  };
}

export function acceptKnowledgePage(data: WorkspaceData, noteId: string): WorkspaceData {
  const note = data.notes.find(
    (item) => item.id === noteId && !item.deletedAt && item.kind === "knowledge",
  );
  if (!note) throw new Error("这份知识页已不可用。");
  const reason = knowledgeAcceptanceReason(data, note);
  if (reason) throw new Error(reason);
  return {
    ...data,
    notes: data.notes.map((item) =>
      item.id === noteId ? reviseNote(item, { status: "accepted" }, "always") : item,
    ),
  };
}

export function applyOrganizationTags(
  data: WorkspaceData,
  jobId: string,
  labels: string[],
): WorkspaceData {
  const job = jobForReview(data, jobId);
  if (job.result?.kind !== "source") throw new Error("这项建议没有可应用的资料标签。");
  if (job.appliedTags) throw new Error("标签已经应用；如需调整，请先撤回本次应用。");
  const source = data.sources.find((item) => item.id === job.request.sourceIds[0])!;
  if (source.tagsLocked) throw new Error("标签已固定，AI 建议不能改动。可在资料详情中解除固定。");
  const allowed = new Set(job.result.tags.map((tag) => tag.label));
  const selected = [...new Set(labels)];
  if (!selected.length || selected.some((label) => !allowed.has(label)))
    throw new Error("请勾选本次建议中的标签。");
  const added = selected.filter((label) => !source.tags.includes(label));
  const after = [...source.tags, ...added];
  if (after.length > 100) throw new Error("单份资料最多保留 100 个标签，请先整理现有标签。");
  const now = new Date().toISOString();
  const tagsRevision = nextTagRevision(source.tagsRevision);
  return withJob(
    {
      ...data,
      sources: data.sources.map((item) =>
        item.id === source.id ? { ...item, tags: after, tagsRevision, updatedAt: now } : item,
      ),
    },
    {
      ...job,
      appliedTags: { added, before: [...source.tags], after: [...after], revision: tagsRevision },
      updatedAt: now,
    },
  );
}

export function undoOrganizationTags(data: WorkspaceData, jobId: string): WorkspaceData {
  const job = jobForReview(data, jobId);
  const source = data.sources.find((item) => item.id === job.request.sourceIds[0])!;
  if (!job.appliedTags) throw new Error("这项建议尚未应用标签。");
  if (source.tagsLocked) throw new Error("标签已固定，无法自动撤回。请在资料详情中调整。");
  // Any subsequent manual change wins. Never reconstruct tags from an old snapshot.
  if (
    job.appliedTags.revision === undefined ||
    (source.tagsRevision ?? 0) !== job.appliedTags.revision ||
    JSON.stringify(source.tags) !== JSON.stringify(job.appliedTags.after)
  )
    throw new Error("标签在应用后已被修改，请在资料详情中手动调整；本次未覆盖你的编辑。");
  const now = new Date().toISOString();
  const tagsRevision = nextTagRevision(source.tagsRevision);
  const nextJob = { ...job, updatedAt: now };
  delete nextJob.appliedTags;
  return withJob(
    {
      ...data,
      sources: data.sources.map((item) =>
        item.id === source.id
          ? { ...item, tags: [...job.appliedTags!.before], tagsRevision, updatedAt: now }
          : item,
      ),
    },
    nextJob,
  );
}

export function saveOrganizationPage(
  data: WorkspaceData,
  jobId: string,
  index: number,
  status: "draft" | "accepted",
  noteId: string,
): WorkspaceData {
  const job = jobForReview(data, jobId);
  if (job.result?.kind !== "knowledge" || !Number.isInteger(index) || !job.result.pages[index])
    throw new Error("这份主题草稿已不可用。");
  if (job.savedPages?.some((page) => page.index === index))
    throw new Error("该主题已保存，请打开已保存的知识页。");
  if (job.ignoredPages?.includes(index)) throw new Error("该主题已忽略，请重新生成需要的建议。");
  if (data.notes.some((note) => note.id === noteId)) throw new Error("知识页标识重复，请重试。");
  const page = job.result.pages[index];
  const now = new Date().toISOString();
  const note: Note = {
    id: noteId,
    spaceId: job.request.spaceId,
    title: page.title,
    content: markdownToEditorHtml(`${page.content}\n\n> ${job.result.coverage}`),
    kind: "knowledge",
    aiGenerated: true,
    status,
    citations: page.citations.map((citation) => ({ ...citation })),
    versions: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  return withJob(
    { ...data, notes: [note, ...data.notes] },
    {
      ...job,
      savedPages: [...(job.savedPages ?? []), { index, noteId }],
      updatedAt: now,
    },
  );
}

export function ignoreOrganizationPage(
  data: WorkspaceData,
  jobId: string,
  index: number,
): WorkspaceData {
  const job = jobForReview(data, jobId);
  if (job.result?.kind !== "knowledge" || !Number.isInteger(index) || !job.result.pages[index])
    throw new Error("这份主题草稿已不可用。");
  if (job.savedPages?.some((page) => page.index === index))
    throw new Error("该主题已另行保存，请在知识页中管理。");
  return withJob(data, {
    ...job,
    ignoredPages: [...new Set([...(job.ignoredPages ?? []), index])],
    updatedAt: new Date().toISOString(),
  });
}

export function dismissOrganizationJob(data: WorkspaceData, jobId: string): WorkspaceData {
  const job = data.organizationJobs?.find((item) => item.id === jobId);
  if (!job) throw new Error("整理记录已不可用。");
  if (job.status === "queued" || job.status === "running")
    throw new Error("请先停止正在执行的任务。");
  return withJob(data, { ...job, status: "dismissed", updatedAt: new Date().toISOString() });
}
