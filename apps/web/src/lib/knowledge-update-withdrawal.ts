import { unified } from "unified";
import rehypeParse from "rehype-parse";
import type { RootContent } from "hast";
import { knowledgeBlocks, validateKnowledgeChanges } from "./knowledge-update";
import {
  knowledgeNoteSnapshotSchema,
  knowledgeUpdateWithdrawalReceiptSchema,
} from "./knowledge-update-schema";
import { MAX_WORKSPACE_BYTES } from "./supabase/validation";
import { noteVersion, reviseNote } from "./note-versions";
import type { Citation, Note, WorkspaceData } from "./types";
import type { OrganizationJob } from "./organization-types";

export interface KnowledgeUpdateWithdrawalSelection {
  changeId: string;
  action: "restore" | "keep";
  candidateId?: string;
  /** Plain text for an explicitly selected local manual merge; never executable HTML. */
  text?: string;
}

export interface KnowledgeUpdateWithdrawalCandidate {
  id: string;
  start: number;
  end: number;
  currentHtml: string;
  currentText: string;
  restoreHtml: string;
  canRestore: boolean;
  reason?: string;
  edits: { start: number; end: number; beforeHtml: string; afterHtml: string }[];
}

export interface KnowledgeUpdateWithdrawalChange {
  id: string;
  kind: "safe" | "conflict";
  beforeHtml: string;
  appliedHtml: string;
  currentHtml: string;
  candidates: KnowledgeUpdateWithdrawalCandidate[];
  reason?: string;
}

export interface KnowledgeUpdateWithdrawalPlan {
  jobId: string;
  noteId: string;
  fingerprint: string;
  changes: KnowledgeUpdateWithdrawalChange[];
  safeCount: number;
  conflictCount: number;
  reason?: string;
}

export interface PreparedKnowledgeUpdateWithdrawal {
  readonly jobId: string;
  readonly noteId: string;
  readonly fingerprint: string;
  /** Ephemeral full canonical comparison. Do not persist or export this prepared object. */
  readonly canonicalBaseKey: string;
  readonly selections: readonly KnowledgeUpdateWithdrawalSelection[];
}

type Edit = { start: number; end: number; text: string };
type Token = { value: string; start: number; end: number };
type AppliedEdit = Edit & { id: string; aStart: number; aEnd: number; before: string };
type Context = {
  job: OrganizationJob;
  note: Note;
  edits: AppliedEdit[];
  citations: Citation[];
  canonical: string;
};
const parser = unified().use(rehypeParse, { fragment: true });
const preparedObjects = new WeakSet<PreparedKnowledgeUpdateWithdrawal>();
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const MANUAL_REASON =
  "无法唯一核对原文位置或结构；请选择一个当前局部位置并手工合并，或保留当前内容。";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function plainHtml(text: string, numbers: number[] = []): string {
  const parts = text
    .trim()
    .split(/\n\s*\n/)
    .map((part) => escapeHtml(part).replace(/\r?\n/g, "<br>"));
  if (numbers.length) parts[parts.length - 1] += ` ${numbers.map((n) => `[${n}]`).join(" ")}`;
  return parts.map((part) => `<p>${part}</p>`).join("");
}
function citationKey(c: Citation): string {
  return JSON.stringify([
    c.sourceId,
    c.versionId,
    c.chunkId,
    c.title,
    c.quote,
    c.page ?? null,
    c.section,
  ]);
}
/** A citation number in an attribute is not a visible citation marker. Keep raw markup intact. */
function remapBeforeReferences(html: string, old: Citation[], current: Citation[]): string {
  const edits: Edit[] = [];
  function visit(node: RootContent) {
    if (node.type === "element") {
      if (!["script", "style", "iframe", "object"].includes(node.tagName))
        node.children.forEach(visit);
    } else if (node.type === "text") {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start === undefined || end === undefined) throw new Error(MANUAL_REASON);
      const raw = html.slice(start, end);
      const mapped = raw.replace(/\[(\d+)\]/g, (marker, digits: string) => {
        const original = old[Number(digits) - 1];
        if (!original) return marker;
        const index = current.findIndex((c) => citationKey(c) === citationKey(original));
        if (index < 0) throw new Error("历史引用编号无法保持，请先核对引用后重试。");
        return `[${index + 1}]`;
      });
      if (mapped !== raw) edits.push({ start, end, text: mapped });
    }
  }
  parser.parse(html).children.forEach(visit);
  return applyEdits(html, edits);
}
function context(data: WorkspaceData, jobId: string): Context {
  const job = data.organizationJobs?.find((item) => item.id === jobId);
  if (
    !job ||
    !["ready", "dismissed"].includes(job.status) ||
    job.result?.kind !== "update" ||
    job.request.kind !== "update"
  )
    throw new Error("这次已应用的更新已不可用。");
  const review = job.updateReview;
  const update = job.result;
  if (review?.withdrawal) throw new Error("这次更新已撤回并封存，不能再次操作。");
  if (!review?.applied.length) throw new Error("这次更新尚未应用任何建议。");
  const before = knowledgeNoteSnapshotSchema.parse(job.result.target);
  const applied = knowledgeNoteSnapshotSchema.parse(review.note);
  const lock = job.request.targetNote;
  if (
    !lock ||
    before.id !== lock.id ||
    before.revision !== lock.revision ||
    before.updatedAt !== lock.updatedAt ||
    before.spaceId !== job.request.spaceId ||
    applied.id !== before.id ||
    applied.spaceId !== before.spaceId ||
    applied.revision <= before.revision
  )
    throw new Error("更新的原始版本身份不一致，请重新核对。");
  if (!validateKnowledgeChanges(before, job.result.changes))
    throw new Error("更新建议与原始版本不一致。");
  const ids = [...review.applied.map((item) => item.changeId), ...review.ignored];
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !update.changes.some((change) => change.id === id))
  )
    throw new Error("更新审核身份不一致。");
  const note = data.notes.find((item) => item.id === before.id);
  if (
    !note ||
    note.kind !== "knowledge" ||
    note.deletedAt ||
    (note.contentRevision ?? 0) < applied.revision
  )
    throw new Error("当前目标知识页已不可用。");
  if (note.spaceId !== "inbox" && !data.spaces.some((space) => space.id === note.spaceId))
    throw new Error("当前知识库已不可用。");
  const citations = note.citations.map((c) => ({ ...c }));
  for (const c of before.citations)
    if (!citations.some((item) => citationKey(item) === citationKey(c))) citations.push({ ...c });
  const blocks = knowledgeBlocks(before.content);
  const edits: AppliedEdit[] = [];
  for (const accepted of review.applied) {
    if (typeof accepted.text !== "string" || accepted.text.length > 6000)
      throw new Error("已应用改写内容超出容量。");
    const change = job.result.changes.find((item) => item.id === accepted.changeId)!;
    const block = blocks.find((item) => item.id === change.blockId);
    if (change.type !== "insert_after" && !block) throw new Error("更新原始位置已不可用。");
    if (
      (change.type === "remove" && accepted.text !== "") ||
      (change.type !== "remove" && !accepted.text.trim())
    )
      throw new Error("已应用改写内容不一致。");
    const numbers = change.citations.map((c) => {
      const index = applied.citations.findIndex((item) => citationKey(item) === citationKey(c));
      if (index < 0) throw new Error("已应用引用身份不一致。");
      return index + 1;
    });
    edits.push({
      id: change.id,
      start: change.type === "insert_after" ? (block?.end ?? 0) : block!.start,
      end: change.type === "insert_after" ? (block?.end ?? 0) : block!.end,
      text: change.type === "remove" ? "" : plainHtml(accepted.text, numbers),
      before:
        change.type === "insert_after"
          ? ""
          : remapBeforeReferences(block!.html, before.citations, citations),
      aStart: 0,
      aEnd: 0,
    });
  }
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  let content = "",
    cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) throw new Error("已应用更新位置发生重叠。");
    content += before.content.slice(cursor, edit.start);
    edit.aStart = content.length;
    content += edit.text;
    edit.aEnd = content.length;
    cursor = edit.end;
  }
  content += before.content.slice(cursor);
  if (content !== applied.content)
    throw new Error("已应用历史快照与原始建议不一致，不能自动撤回。");
  return {
    job,
    note,
    edits,
    citations,
    canonical: JSON.stringify({
      version: 1,
      note,
      job,
      currentSpace: data.spaces.find((space) => space.id === note.spaceId),
      originalSpace: data.spaces.find((space) => space.id === job.request.spaceId) ?? null,
    }),
  };
}

/** HTML tags, comments, entities, and Unicode scalars are atomic. No diff may split them. */
function tokens(html: string, limit = 24_000): Token[] {
  const result: Token[] = [];
  for (let i = 0; i < html.length;) {
    const start = i;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end < 0) throw new Error(MANUAL_REASON);
      i = end + 3;
    } else if (html[i] === "<") {
      let quote = "";
      i++;
      for (; i < html.length; i++) {
        const ch = html[i];
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") {
          i++;
          break;
        }
      }
      if (html[i - 1] !== ">") throw new Error(MANUAL_REASON);
    } else if (
      html[i] === "&" &&
      /^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(html.slice(i, i + 40))
    ) {
      i += /^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.exec(html.slice(i, i + 40))![0].length;
    } else i += (html.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    result.push({ value: html.slice(start, i), start, end: i });
    if (result.length > limit) throw new Error(MANUAL_REASON);
  }
  return result;
}
function validStructure(html: string): boolean {
  try {
    const stack: string[] = [],
      voids = new Set([
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
      ]);
    for (const token of tokens(html, 250_000)) {
      if (!token.value.startsWith("<") || token.value.startsWith("<!--")) continue;
      const match = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i.exec(token.value);
      if (!match) return false;
      const tag = match[2].toLowerCase();
      if (["script", "style", "iframe", "object"].includes(tag)) return false;
      if (match[1]) {
        if (stack.pop() !== tag) return false;
      } else if (!voids.has(tag) && !/\/\s*>$/.test(token.value)) stack.push(tag);
    }
    if (stack.length) return false;
    knowledgeBlocks(html);
    return true;
  } catch {
    return false;
  }
}
function applyEdits(html: string, edits: Edit[]): string {
  let cursor = 0,
    output = "";
  for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (edit.start < cursor || edit.start < 0 || edit.end < edit.start || edit.end > html.length)
      throw new Error("局部选择发生重叠，请将重叠部分合并为一个手工修改，其他项选择保留。");
    output += html.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return output + html.slice(cursor);
}

type Hunk = { ls: number; le: number; rs: number; re: number };
/** Bounded LCS on only the differing middle; opposite directions expose repeat ambiguity. */
function diff(left: string, right: string, backwards = false): Edit[] {
  let l = tokens(left),
    r = tokens(right);
  if (backwards) {
    l = [...l].reverse();
    r = [...r].reverse();
  }
  let prefix = 0,
    suffix = 0;
  while (prefix < l.length && prefix < r.length && l[prefix].value === r[prefix].value) prefix++;
  while (
    suffix < l.length - prefix &&
    suffix < r.length - prefix &&
    l[l.length - 1 - suffix].value === r[r.length - 1 - suffix].value
  )
    suffix++;
  const n = l.length - prefix - suffix,
    m = r.length - prefix - suffix;
  if ((n + 1) * (m + 1) > 2_000_000) throw new Error(MANUAL_REASON);
  const matrix = new Uint16Array((n + 1) * (m + 1));
  const width = m + 1;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      matrix[i * width + j] =
        l[prefix + i].value === r[prefix + j].value
          ? matrix[(i + 1) * width + j + 1] + 1
          : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  const hunks: Hunk[] = [];
  let i = 0,
    j = 0,
    hunk: Hunk | null = null;
  function close() {
    if (hunk) {
      hunks.push(hunk);
      hunk = null;
    }
  }
  while (i < n || j < m) {
    if (i < n && j < m && l[prefix + i].value === r[prefix + j].value) {
      close();
      i++;
      j++;
    } else {
      hunk ??= { ls: prefix + i, le: prefix + i, rs: prefix + j, re: prefix + j };
      if (i < n && (j === m || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) i++;
      else j++;
      hunk.le = prefix + i;
      hunk.re = prefix + j;
    }
  }
  close();
  const originalL = backwards ? [...l].reverse() : l,
    originalR = backwards ? [...r].reverse() : r;
  function offset(array: Token[], index: number, length: number) {
    return array[index]?.start ?? length;
  }
  return hunks
    .map((h) => {
      const ls = backwards ? l.length - h.le : h.ls,
        le = backwards ? l.length - h.ls : h.le;
      const rs = backwards ? r.length - h.re : h.rs,
        re = backwards ? r.length - h.rs : h.re;
      return {
        start: offset(originalL, ls, left.length),
        end: offset(originalL, le, left.length),
        text: right.slice(offset(originalR, rs, right.length), offset(originalR, re, right.length)),
      };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
}
function overlaps(a: Edit, b: Edit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}
function merge(
  before: string,
  applied: string,
  current: string,
): { html: string; conflict: boolean; canRestore: boolean; reason?: string } {
  try {
    const inverse = diff(applied, before),
      user = diff(applied, current);
    const conflict = user.some((edit) => inverse.some((ai) => overlaps(ai, edit)));
    const broadOverlap = user.some((edit) =>
      inverse.some(
        (ai) =>
          overlaps(ai, edit) &&
          ((ai.start === ai.end && edit.start !== edit.end) ||
            (edit.text && edit.start !== edit.end && (edit.start < ai.start || edit.end > ai.end))),
      ),
    );
    if (broadOverlap)
      return { html: before, conflict: true, canRestore: false, reason: MANUAL_REASON };
    const safe = user.filter(
      (edit) =>
        !inverse.some(
          (ai) => overlaps(ai, edit) && !(ai.start === ai.end && edit.start === edit.end),
        ),
    );
    const html = applyEdits(applied, [...safe, ...inverse]);
    const alternativeInverse = diff(applied, before, true),
      alternativeUser = diff(applied, current, true);
    const alternative = applyEdits(applied, [
      ...alternativeUser.filter(
        (edit) =>
          !alternativeInverse.some(
            (ai) => overlaps(ai, edit) && !(ai.start === ai.end && edit.start === edit.end),
          ),
      ),
      ...alternativeInverse,
    ]);
    if (html !== alternative || !validStructure(html))
      return { html: before, conflict: true, canRestore: false, reason: MANUAL_REASON };
    return { html, conflict, canRestore: true };
  } catch {
    return { html: before, conflict: true, canRestore: false, reason: MANUAL_REASON };
  }
}
function occurrences(content: string, html: string): number[] {
  if (!html) return [];
  const found: number[] = [];
  let from = 0;
  while (from <= content.length - html.length && found.length <= 24) {
    const at = content.indexOf(html, from);
    if (at < 0) break;
    found.push(at);
    from = at + Math.max(1, html.length);
  }
  return found;
}
function candidate(
  id: string,
  start: number,
  end: number,
  current: string,
  restore: string,
  canRestore = true,
  reason?: string,
): KnowledgeUpdateWithdrawalCandidate {
  let edits: KnowledgeUpdateWithdrawalCandidate["edits"];
  try {
    edits = diff(current, restore).map((edit) => ({
      start: start + edit.start,
      end: start + edit.end,
      beforeHtml: current.slice(edit.start, edit.end),
      afterHtml: edit.text,
    }));
  } catch {
    edits = [{ start, end, beforeHtml: current, afterHtml: restore }];
  }
  let currentText = "";
  try {
    currentText = knowledgeBlocks(current)
      .map((block) => block.text)
      .join("\n\n");
  } catch {
    currentText = current;
  }
  return {
    id,
    start,
    end,
    currentHtml: current,
    currentText,
    restoreHtml: restore,
    canRestore,
    reason,
    edits,
  };
}
function changes(ctx: Context): KnowledgeUpdateWithdrawalChange[] {
  const applied = ctx.job.updateReview!.note.content,
    current = ctx.note.content;
  const blocks = knowledgeBlocks(applied);
  let currentBlocks: ReturnType<typeof knowledgeBlocks>;
  try {
    currentBlocks = knowledgeBlocks(current);
  } catch {
    currentBlocks = [];
  }
  return ctx.edits.map((edit) => {
    const base = { id: edit.id, beforeHtml: edit.before, appliedHtml: edit.text };
    const disappeared =
      !!edit.text &&
      ctx.note.versions.some(
        (version) =>
          (version.contentRevision ?? -1) > ctx.job.updateReview!.note.revision &&
          !version.content.includes(edit.text),
      );
    if (applied === current && !disappeared)
      return {
        ...base,
        kind: "safe" as const,
        currentHtml: edit.text,
        candidates: [
          candidate(`${edit.id}-position-1`, edit.aStart, edit.aEnd, edit.text, edit.before),
        ],
      };
    const exact = occurrences(current, edit.text).filter(
      (at) =>
        currentBlocks.some((block) => block.start === at) &&
        currentBlocks.some((block) => block.end === at + edit.text.length),
    );
    // Unchanged, unique neighboring blocks are positional anchors, not the old bN ordinal.
    let leftA = 0,
      leftC = 0,
      rightA = applied.length,
      rightC = current.length;
    let leftAnchored = false,
      rightAnchored = false;
    for (const block of [...blocks].reverse())
      if (block.end <= edit.aStart) {
        const hits = occurrences(current, block.html);
        if (
          hits.length === 1 &&
          currentBlocks.some(
            (item) => item.start === hits[0] && item.end === hits[0] + block.html.length,
          )
        ) {
          leftA = block.end;
          leftC = hits[0] + block.html.length;
          leftAnchored = true;
          break;
        }
      }
    for (const block of blocks)
      if (block.start >= edit.aEnd) {
        const hits = occurrences(current, block.html);
        if (
          hits.length === 1 &&
          currentBlocks.some(
            (item) => item.start === hits[0] && item.end === hits[0] + block.html.length,
          )
        ) {
          rightA = block.start;
          rightC = hits[0];
          rightAnchored = true;
          break;
        }
      }
    if (exact.length && exact.length <= 24) {
      const at = exact[0],
        checkLeft = leftAnchored || !blocks.some((block) => block.end <= edit.aStart),
        checkRight = rightAnchored || !blocks.some((block) => block.start >= edit.aEnd),
        safe =
          exact.length === 1 &&
          occurrences(applied, edit.text).length === 1 &&
          leftC <= rightC &&
          at >= leftC &&
          at + edit.text.length <= rightC &&
          !disappeared &&
          (checkLeft || checkRight) &&
          (!checkLeft || current.slice(leftC, at) === applied.slice(leftA, edit.aStart)) &&
          (!checkRight ||
            current.slice(at + edit.text.length, rightC) === applied.slice(edit.aEnd, rightA));
      return {
        ...base,
        kind: safe ? ("safe" as const) : ("conflict" as const),
        currentHtml: edit.text,
        candidates: exact.map((position, i) =>
          candidate(
            `${edit.id}-position-${i + 1}`,
            position,
            position + edit.text.length,
            edit.text,
            edit.before,
          ),
        ),
        ...(!safe
          ? {
              reason:
                "内容相同不能证明仍是此次更新的原位置；请明确选择当前撤回位置，或保留该内容。",
            }
          : {}),
      };
    }
    const aPart = applied.slice(leftA, rightA),
      cPart = current.slice(leftC, rightC);
    if (
      leftC <= rightC &&
      edit.aStart >= leftA &&
      edit.aEnd <= rightA &&
      aPart.length <= 24_000 &&
      cPart.length <= 24_000
    ) {
      const bPart =
        aPart.slice(0, edit.aStart - leftA) + edit.before + aPart.slice(edit.aEnd - leftA);
      const merged = merge(bPart, aPart, cPart);
      // A range with multiple current blocks is safe only when the three-way map agrees in both directions.
      const row = {
        ...base,
        kind: merged.conflict ? ("conflict" as const) : ("safe" as const),
        currentHtml: cPart,
        candidates: [
          candidate(
            `${edit.id}-position-1`,
            leftC,
            rightC,
            cPart,
            merged.html,
            merged.canRestore,
            merged.reason,
          ),
        ],
        reason:
          merged.reason ??
          (merged.conflict ? "这次更新与后续编辑重叠，请选择恢复、保留或局部合并。" : undefined),
      };
      if (
        merged.canRestore ||
        currentBlocks.filter((block) => block.start >= leftC && block.end <= rightC).length <= 1
      )
        return row;
    }
    // Unprovable/reordered/large layouts still have a local manual completion path; never default to replacing the whole page.
    const local = currentBlocks.filter(
      (block) => block.start >= Math.min(leftC, rightC) && block.end <= Math.max(leftC, rightC),
    );
    const available = local.length ? local : currentBlocks;
    const reason =
      available.length > 24
        ? `${MANUAL_REASON} 本次仅列出前 24 个当前结构块，其余位置请返回知识页手工编辑后重新预览。`
        : MANUAL_REASON;
    const options = available
      .slice(0, 24)
      .map((block, i) =>
        candidate(
          `${edit.id}-position-${i + 1}`,
          block.start,
          block.end,
          block.html,
          edit.before,
          false,
          reason,
        ),
      );
    if (!options.length)
      options.push(candidate(`${edit.id}-position-1`, 0, 0, "", edit.before, false, MANUAL_REASON));
    return {
      ...base,
      kind: "conflict" as const,
      currentHtml: options.map((option) => option.currentHtml).join("\n"),
      candidates: options,
      reason,
    };
  });
}
async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => freeze(item));
    Object.freeze(value);
  }
  return value;
}

function choose(
  rows: KnowledgeUpdateWithdrawalChange[],
  selections: readonly KnowledgeUpdateWithdrawalSelection[],
): KnowledgeUpdateWithdrawalSelection[] {
  if (!Array.isArray(selections) || selections.length > 12) throw new Error("撤回选择超出容量。");
  const seen = new Set<string>();
  for (const selection of selections) {
    if (
      !selection ||
      typeof selection !== "object" ||
      Object.keys(selection).some(
        (key) => !["changeId", "action", "candidateId", "text"].includes(key),
      ) ||
      !ID.test(selection.changeId) ||
      seen.has(selection.changeId) ||
      !rows.some((row) => row.id === selection.changeId) ||
      !["restore", "keep"].includes(selection.action) ||
      (selection.candidateId !== undefined &&
        (typeof selection.candidateId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,140}$/.test(selection.candidateId))) ||
      (selection.text !== undefined &&
        (typeof selection.text !== "string" || selection.text.length > 6000)) ||
      (selection.action === "keep" &&
        (selection.text !== undefined || selection.candidateId !== undefined))
    )
      throw new Error("撤回选择身份或内容不合规。");
    seen.add(selection.changeId);
  }
  return rows.map((row) => {
    const selection = selections.find((item) => item.changeId === row.id);
    if (!selection && row.kind === "conflict")
      throw new Error("冲突项需要明确选择恢复、保留或手工合并。");
    const value = selection ?? { changeId: row.id, action: "restore" as const };
    if (value.action === "keep") return { ...value };
    const selected = value.candidateId
      ? row.candidates.find((option) => option.id === value.candidateId)
      : row.candidates.length === 1
        ? row.candidates[0]
        : undefined;
    if (!selected) throw new Error("请明确选择要撤回的当前局部位置。");
    if (!selected.canRestore && value.text === undefined)
      throw new Error("这个位置需要手工合并内容后才能确认。");
    return { ...value, candidateId: selected.id };
  });
}
function result(
  data: WorkspaceData,
  ctx: Context,
  rows: KnowledgeUpdateWithdrawalChange[],
  selections: readonly KnowledgeUpdateWithdrawalSelection[],
  fingerprint: string,
): WorkspaceData {
  const values = choose(rows, selections),
    edits: Edit[] = [];
  for (const value of values) {
    if (value.action === "keep") continue;
    const option = rows
      .find((row) => row.id === value.changeId)!
      .candidates.find((item) => item.id === value.candidateId)!;
    if (value.text !== undefined)
      edits.push({ start: option.start, end: option.end, text: plainHtml(value.text) });
    else
      for (const edit of option.edits) {
        if (ctx.note.content.slice(edit.start, edit.end) !== edit.beforeHtml)
          throw new Error("局部原文已变化，请重新预览。");
        edits.push({ start: edit.start, end: edit.end, text: edit.afterHtml });
      }
  }
  const content = applyEdits(ctx.note.content, edits);
  if (edits.length && !validStructure(content))
    throw new Error("合并后的知识页结构无法安全保存，请改用局部手工合并。");
  let note = reviseNote(
    ctx.note,
    { content, citations: edits.length ? ctx.citations : ctx.note.citations },
    "always",
  );
  // An explicitly confirmed all-keep/no-op withdrawal still has a real history version.
  if (note === ctx.note) {
    const revision = note.contentRevision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER - 1)
      throw new Error("知识页版本已无法继续递增，请先导出副本。");
    note = {
      ...note,
      contentRevision: revision + 1,
      updatedAt: new Date().toISOString(),
      versions: [...note.versions, noteVersion(note)].slice(-30),
    };
  }
  if (
    !knowledgeNoteSnapshotSchema.safeParse({
      id: note.id,
      spaceId: note.spaceId,
      title: note.title,
      content: note.content,
      citations: note.citations,
      status: note.status,
      aiGenerated: note.aiGenerated ?? false,
      revision: note.contentRevision ?? 0,
      updatedAt: note.updatedAt,
    }).success
  )
    throw new Error("撤回后的知识页超过单页容量或字段限制，请缩小局部合并内容后重试。");
  const withdrawal = knowledgeUpdateWithdrawalReceiptSchema.parse({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    noteRevision: note.contentRevision,
    fingerprint,
    restoredChangeIds: values
      .filter((value) => value.action === "restore")
      .map((value) => value.changeId),
    keptChangeIds: values.filter((value) => value.action === "keep").map((value) => value.changeId),
  });
  const next = {
    ...data,
    notes: data.notes.map((item) => (item.id === note.id ? note : item)),
    organizationJobs: (data.organizationJobs ?? []).map((job) =>
      job.id === ctx.job.id
        ? { ...job, updateReview: { ...job.updateReview!, withdrawal }, updatedAt: withdrawal.at }
        : job,
    ),
  };
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_WORKSPACE_BYTES)
    throw new Error("撤回后的正文与完整历史超过工作区容量，请先导出并清理后重试。");
  return next;
}

export async function previewKnowledgeUpdateWithdrawal(
  data: WorkspaceData,
  jobId: string,
): Promise<KnowledgeUpdateWithdrawalPlan> {
  const ctx = context(data, jobId),
    rows = changes(ctx);
  return freeze({
    jobId,
    noteId: ctx.note.id,
    fingerprint: await digest(ctx.canonical),
    changes: rows,
    safeCount: rows.filter((row) => row.kind === "safe").length,
    conflictCount: rows.filter((row) => row.kind === "conflict").length,
  });
}

export async function prepareKnowledgeUpdateWithdrawal(
  data: WorkspaceData,
  jobId: string,
  fingerprint: string,
  selections: KnowledgeUpdateWithdrawalSelection[],
): Promise<PreparedKnowledgeUpdateWithdrawal> {
  const ctx = context(data, jobId);
  if (!/^[0-9a-f]{64}$/.test(fingerprint) || (await digest(ctx.canonical)) !== fingerprint)
    throw new Error("知识页或更新任务已变化，请重新预览。");
  const rows = changes(ctx),
    values = choose(rows, selections);
  result(data, ctx, rows, values, fingerprint); // Full history/capacity/structure preflight before the atomic reducer.
  const prepared = freeze({
    jobId,
    noteId: ctx.note.id,
    fingerprint,
    canonicalBaseKey: ctx.canonical,
    selections: values,
  });
  preparedObjects.add(prepared);
  return prepared;
}

export function commitKnowledgeUpdateWithdrawal(
  current: WorkspaceData,
  prepared: PreparedKnowledgeUpdateWithdrawal,
): WorkspaceData {
  if (!preparedObjects.has(prepared)) throw new Error("撤回预览身份无效，请重新预览。");
  const ctx = context(current, prepared.jobId);
  if (ctx.canonical !== prepared.canonicalBaseKey || ctx.note.id !== prepared.noteId)
    throw new Error("知识页或更新任务已变化，请重新预览。");
  return result(current, ctx, changes(ctx), prepared.selections, prepared.fingerprint);
}

export async function withdrawKnowledgeUpdate(
  data: WorkspaceData,
  jobId: string,
  fingerprint: string,
  selections: KnowledgeUpdateWithdrawalSelection[],
): Promise<WorkspaceData> {
  return commitKnowledgeUpdateWithdrawal(
    data,
    await prepareKnowledgeUpdateWithdrawal(data, jobId, fingerprint, selections),
  );
}
