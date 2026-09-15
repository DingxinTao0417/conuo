import { unified } from "unified";
import rehypeParse from "rehype-parse";
import type { RootContent } from "hast";
import { resolveCitation } from "./retrieval";
import { organizationReviewReason } from "./organization";
import { knowledgeChangeSchema, knowledgeNoteSnapshotSchema } from "./knowledge-update-schema";
import { MAX_WORKSPACE_BYTES } from "./supabase/validation";
import { reviseNote } from "./note-versions";
import type {
  KnowledgeBlock,
  KnowledgeChange,
  KnowledgeNoteSnapshot,
} from "./knowledge-update-types";
import type { OrganizationJob, OrganizationRequest } from "./organization-types";
import type { Citation, Note, WorkspaceData } from "./types";

const parser = unified().use(rehypeParse, { fragment: true });
const normalized = (text: string) => text.replace(/\s+/g, " ").trim();
function textOf(node: RootContent): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return "";
  if (["script", "style", "iframe", "object"].includes(node.tagName)) return "";
  if (node.tagName === "br") return "\n";
  return node.children
    .map(textOf)
    .join(["ul", "ol", "table", "tbody", "tr"].includes(node.tagName) ? "\n" : "");
}

/** Top-level paragraphs/headings/lists/tables are stable atomic review blocks. */
export function knowledgeBlocks(content: string): KnowledgeBlock[] {
  const tree = parser.parse(content);
  const blocks: KnowledgeBlock[] = [];
  let lastEnd = 0;
  for (const node of tree.children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "comment" || (node.type === "text" && !node.value.trim())) continue;
    if (
      start === undefined ||
      end === undefined ||
      start < lastEnd ||
      end <= start ||
      end > content.length
    )
      throw new Error("知识页结构无法安全定位，请先在编辑器中保存后重试。");
    blocks.push({
      id: `b${blocks.length + 1}`,
      start,
      end,
      html: content.slice(start, end),
      text: textOf(node),
    });
    lastEnd = end;
  }
  return blocks;
}

export function snapshotKnowledgeNote(note: Note): KnowledgeNoteSnapshot {
  return {
    id: note.id,
    spaceId: note.spaceId,
    title: note.title,
    content: note.content,
    citations: note.citations.map((citation) => ({ ...citation })),
    status: note.status,
    aiGenerated: note.aiGenerated ?? false,
    revision: note.contentRevision ?? 0,
    updatedAt: note.updatedAt,
  };
}

export function knowledgeNoteKey(value: Note | KnowledgeNoteSnapshot): string {
  const note = "revision" in value ? value : snapshotKnowledgeNote(value);
  return JSON.stringify({
    id: note.id,
    spaceId: note.spaceId,
    title: note.title,
    content: note.content,
    citations: note.citations.map((c) => [
      c.sourceId,
      c.versionId,
      c.chunkId,
      c.title,
      c.quote,
      c.page ?? null,
      c.section,
    ]),
    status: note.status,
    aiGenerated: note.aiGenerated,
    revision: note.revision,
    updatedAt: note.updatedAt,
  });
}

function citationAvailable(data: WorkspaceData, citation: Citation): boolean {
  const found = resolveCitation(data, citation);
  return (
    !!found &&
    !!normalized(citation.quote) &&
    normalized(found.source.text).includes(normalized(citation.quote)) &&
    found.chunk.page === citation.page &&
    found.chunk.section === citation.section
  );
}

/** Generation rules, including inherited source AI permissions of the target page. */
export function knowledgeUpdateTargetReason(
  data: WorkspaceData,
  request: OrganizationRequest,
): string {
  if (request.kind !== "update") return "";
  const basis = request.targetNote;
  const note = data.notes.find((item) => item.id === basis?.id);
  if (!basis || !note || note.deletedAt || note.kind !== "knowledge") return "目标知识页已不可用。";
  if (note.spaceId !== request.spaceId) return "目标知识页已不在所选知识库，请重新选择。";
  if ((note.contentRevision ?? 0) !== basis.revision || note.updatedAt !== basis.updatedAt)
    return "知识页已被修改，请基于当前版本重新生成更新建议。";
  if (note.citations.some((citation) => !citationAvailable(data, citation)))
    return "目标知识页有失效的原文依据，请先核对并修正引用，再生成更新建议。";
  if (
    note.citations.some(
      (citation) => !data.sources.find((source) => source.id === citation.sourceId)?.aiAllowed,
    )
  )
    return "目标知识页引用了不允许 AI 使用的资料，本次不会把它发送给模型。";
  if (note.citations.some((citation) => !request.sourceIds.includes(citation.sourceId)))
    return "请同时选中目标知识页已有依据的资料，避免丢失原有上下文。";
  try {
    const blocks = knowledgeBlocks(note.content);
    if (
      note.content.length > 60_000 ||
      blocks.length > 100 ||
      blocks.reduce((n, b) => n + b.text.length, 0) > 20_000
    )
      return "这份知识页超出单次更新容量（100 个结构块、2 万字正文或 6 万字符 HTML），请拆分页面后再生成。";
  } catch (error) {
    return error instanceof Error ? error.message : "知识页结构无法安全定位。";
  }
  return "";
}

export function validateKnowledgeChanges(
  target: KnowledgeNoteSnapshot,
  changes: KnowledgeChange[],
): boolean {
  try {
    const blocks = knowledgeBlocks(target.content);
    const ids = new Set<string>();
    const anchors = new Set<string>();
    if (changes.length > 12) return false;
    for (const change of changes) {
      if (
        !knowledgeChangeSchema.safeParse(change).success ||
        ids.has(change.id) ||
        anchors.has(change.blockId)
      )
        return false;
      ids.add(change.id);
      anchors.add(change.blockId);
      const block = blocks.find((item) => item.id === change.blockId);
      if (change.blockId === "start") {
        if (change.type !== "insert_after" || change.before !== "") return false;
      } else if (!block || block.html !== change.before) return false;
      if (change.type === "remove" ? change.after !== "" : !change.after.trim()) return false;
      if (change.type === "replace" && normalized(change.after) === normalized(block!.text))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function knowledgeUpdateReviewReason(data: WorkspaceData, job: OrganizationJob): string {
  if (job.result?.kind !== "update" || job.request.kind !== "update")
    return "这项任务不是知识页更新建议。";
  if (job.updateReview?.withdrawal)
    return "这次知识更新已撤回并封存。历史仍可查看；请基于当前页面重新生成更新建议。";
  const reason = organizationReviewReason(data, job);
  if (reason) return reason;
  const target = job.result.target;
  const note = data.notes.find(
    (item) => item.id === target.id && !item.deletedAt && item.kind === "knowledge",
  );
  const expected = job.updateReview?.note ?? target;
  if (
    !note ||
    note.spaceId !== job.request.spaceId ||
    knowledgeNoteKey(note) !== knowledgeNoteKey(expected)
  )
    return "知识页在生成或上次接受后已被修改。为保护你的编辑，请基于当前页面重新生成。";
  if (
    target.id !== job.request.targetNote?.id ||
    target.revision !== job.request.targetNote.revision ||
    target.updatedAt !== job.request.targetNote.updatedAt ||
    !validateKnowledgeChanges(target, job.result.changes)
  )
    return "更新建议的基础版本或段落定位无效，请重新生成。";
  if (target.citations.some((citation) => !citationAvailable(data, citation)))
    return "知识页原有依据已变化，请先核对后再更新。";
  const reviewed = [
    ...(job.updateReview?.applied.map((item) => item.changeId) ?? []),
    ...(job.updateReview?.ignored ?? []),
  ];
  if (
    new Set(reviewed).size !== reviewed.length ||
    reviewed.some(
      (id) =>
        !job.result ||
        job.result.kind !== "update" ||
        !job.result.changes.some((change) => change.id === id),
    )
  )
    return "更新建议的审核记录不一致，请重新生成。";
  return "";
}

const citationKey = (c: Citation) =>
  JSON.stringify([c.sourceId, c.versionId, c.chunkId, c.title, c.quote, c.page ?? null, c.section]);
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
function replacementHtml(text: string, numbers: number[]): string {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((part) => escapeHtml(part).replace(/\r?\n/g, "<br>"));
  paragraphs[paragraphs.length - 1] += ` ${numbers.map((number) => `[${number}]`).join(" ")}`;
  return paragraphs.map((part) => `<p>${part}</p>`).join("");
}

/** Apply a chosen subset atomically; untouched HTML slices remain byte-for-byte intact. */
export function applyKnowledgeUpdate(
  data: WorkspaceData,
  jobId: string,
  selected: { changeId: string; text: string }[],
): WorkspaceData {
  const job = data.organizationJobs?.find((item) => item.id === jobId);
  if (!job) throw new Error("更新建议已不可用。");
  const reason = knowledgeUpdateReviewReason(data, job);
  if (reason) throw new Error(reason);
  if (job.result?.kind !== "update") throw new Error("更新建议类型无效。");
  if (!selected.length || new Set(selected.map((item) => item.changeId)).size !== selected.length)
    throw new Error("请勾选要接受的修改，不能重复选择。");
  const prior = job.updateReview?.applied ?? [];
  const ignored = job.updateReview?.ignored ?? [];
  for (const item of selected) {
    const change = job.result.changes.find((change) => change.id === item.changeId);
    if (
      !change ||
      prior.some((previous) => previous.changeId === item.changeId) ||
      ignored.includes(item.changeId)
    )
      throw new Error("部分修改已经处理或不存在，请重新选择。");
    if (
      item.text.length > 6000 ||
      (change.type === "remove" ? item.text !== "" : !item.text.trim())
    )
      throw new Error("修改内容不能为空或超过 6000 字符；删除建议不接受替换内容。");
  }
  const applied = [...prior, ...selected.map((item) => ({ ...item }))];
  const base = job.result.target;
  const blocks = knowledgeBlocks(base.content);
  // Previously accepted paragraphs keep their reference numbers during later partial accepts.
  const citations = (job.updateReview?.note.citations ?? base.citations).map((citation) => ({
    ...citation,
  }));
  const edits = job.result.changes
    .filter((change) => applied.some((item) => item.changeId === change.id))
    .map((change) => {
      const item = applied.find((item) => item.changeId === change.id)!;
      const numbers = change.citations.map((citation) => {
        let index = citations.findIndex(
          (existing) => citationKey(existing) === citationKey(citation),
        );
        if (index < 0) {
          index = citations.length;
          citations.push({ ...citation });
        }
        return index + 1;
      });
      const block = blocks.find((block) => block.id === change.blockId);
      const start = change.type === "insert_after" ? (block?.end ?? 0) : block!.start;
      const end = change.type === "insert_after" ? start : block!.end;
      return {
        start,
        end,
        content: change.type === "remove" ? "" : replacementHtml(item.text, numbers),
      };
    });
  if (citations.length > 1000) throw new Error("知识页引用数量已达上限，请拆分页面。");
  let content = base.content;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end))
    content = content.slice(0, edit.start) + edit.content + content.slice(edit.end);
  const current = data.notes.find((note) => note.id === base.id)!;
  const note = reviseNote(current, { content, citations, aiGenerated: true }, "always");
  const snapshot = snapshotKnowledgeNote(note);
  if (!knowledgeNoteSnapshotSchema.safeParse(snapshot).success)
    throw new Error("应用后的页面超出更新记录容量，请缩短修改内容或拆分页面；本次未修改正文。");
  const next: WorkspaceData = {
    ...data,
    notes: data.notes.map((item) => (item.id === note.id ? note : item)),
    organizationJobs: data.organizationJobs?.map((item) =>
      item.id === jobId
        ? {
            ...item,
            updatedAt: new Date().toISOString(),
            updateReview: { note: snapshot, applied, ignored: [...ignored] },
          }
        : item,
    ),
  };
  // Include history and review snapshots in the preflight; the database also checks JSONB size.
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_WORKSPACE_BYTES)
    throw new Error("应用后工作区会超过 3 MiB 保存容量，请先导出并处理容量；本次未修改正文。");
  return next;
}

export function ignoreKnowledgeChange(
  data: WorkspaceData,
  jobId: string,
  changeId: string,
): WorkspaceData {
  const job = data.organizationJobs?.find((item) => item.id === jobId);
  if (!job) throw new Error("更新建议已不可用。");
  const reason = knowledgeUpdateReviewReason(data, job);
  if (reason) throw new Error(reason);
  if (job.result?.kind !== "update" || !job.result.changes.some((change) => change.id === changeId))
    throw new Error("这项段落建议不存在。");
  if (job.updateReview?.applied.some((item) => item.changeId === changeId))
    throw new Error("已应用的修改请通过知识页历史版本处理。");
  const review = job.updateReview ?? { note: job.result.target, applied: [], ignored: [] };
  return {
    ...data,
    organizationJobs: data.organizationJobs?.map((item) =>
      item.id === jobId
        ? {
            ...item,
            updatedAt: new Date().toISOString(),
            updateReview: { ...review, ignored: [...new Set([...review.ignored, changeId])] },
          }
        : item,
    ),
  };
}
