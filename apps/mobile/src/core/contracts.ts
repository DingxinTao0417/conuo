import { z } from "zod";

const id = z.string().min(1).max(100);
export const citationSchema = z.object({
  sourceId: id,
  versionId: id,
  chunkId: id,
  title: z.string(),
  quote: z.string(),
  page: z.number().int().positive().optional(),
  section: z.string(),
});
export const sourceSchema = z.looseObject({
  id,
  versionId: id,
  title: z.string(),
  kind: z.enum(["pdf", "docx", "markdown", "text", "web"]),
  filename: z.string(),
  mime: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  hash: z.string().optional(),
  text: z.string(),
  spaceIds: z.array(id),
  tags: z.array(z.string()),
  status: z.string(),
  aiAllowed: z.boolean(),
  starred: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  coverage: z
    .object({
      captureScope: z.enum(["full", "selection", "manual", "link"]),
      parseState: z.enum(["pending", "complete", "partial", "failed", "not-requested"]),
      unavailablePageRanges: z
        .array(
          z.object({
            start: z.number().int().positive(),
            end: z.number().int().positive(),
          }),
        )
        .optional(),
    })
    .optional(),
  pageCount: z.number().int().positive().optional(),
  parsedPages: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  storagePath: z.string().optional(),
  readPage: z.number().optional(),
  lastReadAt: z.string().optional(),
  chunks: z.array(
    z.looseObject({
      id,
      sourceId: id,
      versionId: id,
      text: z.string(),
      section: z.string(),
      page: z.number().optional(),
      order: z.number().int().nonnegative().optional(),
    }),
  ),
});
export const conversationMessageSchema = z.looseObject({
  id,
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  citations: z.array(citationSchema),
  createdAt: z.string(),
  mode: z.enum(["extractive", "model"]).optional(),
  error: z.string().optional(),
  noteEvidence: z.array(z.unknown()).optional(),
  attempt: z.unknown().optional(),
});
export const conversationSchema = z.looseObject({
  id,
  spaceId: id,
  sourceId: id.optional(),
  title: z.string(),
  scope: z.enum([
    "selection",
    "document",
    "document-notes",
    "sources",
    "space",
    "cross-library-sources",
  ]),
  sourceIds: z.array(id),
  messages: z.array(conversationMessageSchema),
  resolved: z.boolean(),
  updatedAt: z.string(),
});
export const noteSchema = z.looseObject({
  id,
  spaceId: id,
  title: z.string(),
  content: z.string(),
  kind: z.enum(["note", "knowledge"]),
  status: z.enum(["draft", "accepted"]),
  aiGenerated: z.boolean().optional(),
  citations: z.array(citationSchema),
  versions: z.array(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export const workspaceSchema = z.looseObject({
  schemaVersion: z.literal(1),
  spaces: z.array(
    z.looseObject({
      id,
      name: z.string(),
      goal: z.string(),
      color: z.string(),
      archived: z.boolean(),
      createdAt: z.string(),
    }),
  ),
  sources: z.array(sourceSchema),
  notes: z.array(noteSchema),
  annotations: z.array(z.unknown()),
  conversations: z.array(conversationSchema),
  aiEnabled: z.boolean(),
});
export const snapshotSchema = z
  .object({
    data: workspaceSchema.nullable(),
    revision: z.number().int().nonnegative().safe(),
  })
  .refine((value) =>
    value.data === null ? value.revision === 0 : value.revision > 0,
  );
export const answerSchema = z.object({
  content: z.string().min(1).max(50_000),
  citations: z.array(citationSchema).max(12),
  mode: z.enum(["model", "extractive"]),
  noteEvidence: z.array(z.unknown()).optional(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Note = z.infer<typeof noteSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type Answer = z.infer<typeof answerSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export function blankWorkspace(): Workspace {
  return {
    schemaVersion: 1,
    spaces: [],
    sources: [],
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: false,
  };
}

export function readingSource(
  workspace: Workspace,
  sourceId: string,
  versionId?: string,
) {
  return workspace.sources.find(
    (source) =>
      source.id === sourceId &&
      !source.deletedAt &&
      (!versionId || source.versionId === versionId),
  );
}

export function adoptSnapshot(
  previous: Snapshot | null,
  incoming: Snapshot,
): Snapshot {
  return previous && incoming.revision < previous.revision
    ? previous
    : incoming;
}

/** Render the retained text once; only unambiguous, non-overlapping excerpts get anchors. */
export function readingBlocks(
  source: Source,
): { text: string; chunkId?: string; section?: string; page?: number }[] {
  const intervals = source.chunks
    .flatMap((chunk) => {
      const start = source.text.indexOf(chunk.text);
      return chunk.text &&
        start >= 0 &&
        start === source.text.lastIndexOf(chunk.text)
        ? [{ start, end: start + chunk.text.length, chunk }]
        : [];
    })
    .sort((a, b) => a.start - b.start);
  const result: {
    text: string;
    chunkId?: string;
    section?: string;
    page?: number;
  }[] = [];
  let cursor = 0;
  for (const { start, end, chunk } of intervals) {
    if (start < cursor) continue;
    if (start > cursor) result.push({ text: source.text.slice(cursor, start) });
    result.push({
      text: chunk.text,
      chunkId: chunk.id,
      section: chunk.section,
      page: chunk.page,
    });
    cursor = end;
  }
  if (cursor < source.text.length)
    result.push({ text: source.text.slice(cursor) });
  return result;
}

export function answerScope(
  workspace: Workspace,
  sourceId: string,
  question: string,
  requestId: string,
) {
  const source = readingSource(workspace, sourceId);
  const spaceId =
    source?.spaceIds.find((space) =>
      workspace.spaces.some((item) => item.id === space && !item.archived),
    ) ?? (source?.spaceIds.length === 0 ? "inbox" : null);
  if (!source || !spaceId)
    throw new Error("这份资料已不可用，请重新载入资料库。");
  if (!workspace.aiEnabled || !source.aiAllowed)
    throw new Error("请先在网页版开启 AI，并授权这份资料用于 AI。");
  if (
    !["ready", "partial"].includes(source.status) ||
    !source.text.trim() ||
    !source.chunks.length
  )
    throw new Error("这份资料还没有可检索的正文，请先在网页版完成解析。");
  if (!question.trim() || question.trim().length > 2000)
    throw new Error("请输入 1–2000 字的问题。");
  return {
    requestId,
    question: question.trim(),
    scope: "document" as const,
    spaceId,
    sourceId: source.id,
    sourceIds: [source.id],
    sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
  };
}

export function createTextNote(
  workspace: Workspace,
  input: {
    id: string;
    spaceId: string;
    title: string;
    text: string;
    now: string;
  },
): Workspace {
  if (
    !workspace.spaces.some(
      (space) => space.id === input.spaceId && !space.archived,
    )
  )
    throw new Error("请选择一个可用的知识库。");
  if (!input.title.trim() || !input.text.trim())
    throw new Error("请填写笔记标题和正文。");
  if (input.title.trim().length > 512 || input.text.length > 50_000)
    throw new Error("笔记内容过长，请分成多篇保存。");
  if (workspace.notes.some((note) => note.id === input.id))
    throw new Error("这份笔记已经存在，请重新载入后查看。");
  const escape = (text: string) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const content = input.text
    .split(/\r?\n/)
    .map((line) => `<p>${escape(line)}</p>`)
    .join("");
  return {
    ...workspace,
    notes: [
      ...workspace.notes,
      {
        id: input.id,
        spaceId: input.spaceId,
        title: input.title.trim(),
        content,
        kind: "note",
        status: "accepted",
        aiGenerated: false,
        contentRevision: 1,
        citations: [],
        versions: [],
        createdAt: input.now,
        updatedAt: input.now,
        deletedAt: null,
      },
    ],
  };
}

export function notePreview(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}
