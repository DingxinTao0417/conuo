import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import type { Root, RootContent } from "hast";
import { unified } from "unified";
import { markdownToEditorHtml } from "./markdown";
import { reviseNote } from "./note-versions";
import { resolveCitation } from "./retrieval";
import { MAX_WORKSPACE_BYTES } from "./supabase/validation";
import type { AnswerResult, Citation, WorkspaceData } from "./types";

const MAX_KNOWLEDGE_PAGE_CONTENT = 200_000;
const MAX_KNOWLEDGE_PAGE_CITATIONS = 1_000;
const answerHtmlParser = unified().use(rehypeParse, { fragment: true });
const answerHtmlStringifier = unified().use(rehypeStringify);

export interface AppendAnswerToKnowledgePageInput {
  noteId: string;
  spaceId: string;
  content: string;
  citations: readonly Citation[];
  mode: AnswerResult["mode"];
}

const citationKey = (citation: Citation) =>
  JSON.stringify([
    citation.sourceId,
    citation.versionId,
    citation.chunkId,
    citation.title,
    citation.quote,
    citation.page ?? null,
    citation.section,
  ]);

function sourceBelongsToSpace(sourceSpaceIds: readonly string[], spaceId: string): boolean {
  return spaceId === "inbox" ? sourceSpaceIds.length === 0 : sourceSpaceIds.includes(spaceId);
}

function rewriteCitationMarkers(nodes: readonly RootContent[], numbers: readonly number[]): void {
  for (const node of nodes) {
    if (node.type === "text") {
      node.value = node.value.replace(/\[(\d+)\]/g, (marker, rawIndex: string) => {
        const index = Number(rawIndex) - 1;
        return Number.isSafeInteger(index) && index >= 0 && index < numbers.length
          ? `[${numbers[index]}]`
          : marker;
      });
      continue;
    }
    if (node.type !== "element" || ["a", "code", "pre"].includes(node.tagName)) continue;
    rewriteCitationMarkers(node.children, numbers);
  }
}

/**
 * Renumber answer-local [1] markers after its evidence joins an existing page.
 * Text in links and code remains literal, matching the reader's citation-marker rules.
 */
export function renumberAnswerCitationMarkers(html: string, numbers: readonly number[]): string {
  const tree = answerHtmlParser.parse(html) as Root;
  rewriteCitationMarkers(tree.children, numbers);
  return String(answerHtmlStringifier.stringify(tree));
}

function pageAppendHtml(
  answer: Pick<AppendAnswerToKnowledgePageInput, "content" | "mode">,
  citationNumbers: readonly number[],
): string {
  const answerHtml = markdownToEditorHtml(answer.content.trim());
  if (!answerHtml.trim()) throw new Error("这条回答没有可保存的正文。");
  const content = renumberAnswerCitationMarkers(answerHtml, citationNumbers);
  const origin =
    answer.mode === "model"
      ? "由 Conuo AI 基于下方原文依据生成，保存后请核对。"
      : "由 Conuo 从原文检索整理，保存后请核对。";
  return [
    "<hr>",
    "<h2>资料问答</h2>",
    `<p><em>${origin}</em></p>`,
    content,
    `<p><em>本段原文依据：${citationNumbers.map((number) => `[${number}]`).join(" ")}</em></p>`,
  ].join("");
}

/**
 * Append a completed, source-grounded answer to an existing page without
 * overwriting its human-authored content. This is deliberately a domain
 * operation so UI events, local storage, and future Supabase writes share the
 * same source/version and history guarantees.
 */
export function appendAnswerToKnowledgePage(
  data: WorkspaceData,
  input: AppendAnswerToKnowledgePageInput,
): WorkspaceData {
  const note = data.notes.find((item) => item.id === input.noteId && !item.deletedAt);
  if (!note || note.kind !== "knowledge") throw new Error("这份知识页已不可用，请重新选择。");
  if (note.spaceId !== input.spaceId)
    throw new Error("只能保存到当前知识库中的知识页，请重新选择。");
  if (
    input.spaceId !== "inbox" &&
    !data.spaces.some((space) => space.id === input.spaceId && !space.archived)
  )
    throw new Error("当前知识库已不可用，请重新选择。");
  if (!input.content.trim()) throw new Error("这条回答没有可保存的正文。");
  if (!input.citations.length) throw new Error("回答缺少可核对的原文依据，暂不能保存到知识页。");
  if (input.mode !== "model" && input.mode !== "extractive")
    throw new Error("回答类型无效，暂不能保存到知识页。");

  const citations = note.citations.map((citation) => ({ ...citation }));
  const indexes = new Map(citations.map((citation, index) => [citationKey(citation), index]));
  const answerCitationNumbers: number[] = [];
  for (const citation of input.citations) {
    const resolved = resolveCitation(data, citation);
    if (!resolved || !sourceBelongsToSpace(resolved.source.spaceIds, input.spaceId))
      throw new Error("回答的原文依据已变化或不在当前知识库中，请重新提问后再保存。");
    const key = citationKey(citation);
    let index = indexes.get(key);
    if (index === undefined) {
      index = citations.length;
      citations.push({ ...citation });
      indexes.set(key, index);
    }
    answerCitationNumbers.push(index + 1);
  }
  if (citations.length > MAX_KNOWLEDGE_PAGE_CITATIONS)
    throw new Error("知识页引用数量已达上限，请拆分页面后再保存。");

  const appended = pageAppendHtml(input, answerCitationNumbers);
  const content = `${note.content}${note.content ? "\n" : ""}${appended}`;
  if (content.length > MAX_KNOWLEDGE_PAGE_CONTENT)
    throw new Error("知识页内容已达上限，请拆分页面后再保存。");

  // An appended answer changes the review unit. Preserve the old page in its
  // history and require a fresh review before it can be used as accepted knowledge.
  const revised = reviseNote(
    note,
    {
      content,
      citations,
      status: "draft",
      aiGenerated: note.aiGenerated || input.mode === "model",
    },
    "always",
  );
  const next = {
    ...data,
    notes: data.notes.map((item) => (item.id === note.id ? revised : item)),
  };
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_WORKSPACE_BYTES)
    throw new Error("保存后工作区会超过容量上限，请先导出并整理内容；本次未修改正文。");
  return next;
}
