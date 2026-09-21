import { z } from "zod";
import type { Source, Workspace } from "./contracts.ts";

export const MAX_WEB_TEXT = 120_000;
const MAX_WORKSPACE_BYTES = 3 * 1024 * 1024;
const timestampSchema = z.string().datetime({ offset: true });
const identitySchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

/** URL syntax is checked here; only the server grants permission to fetch a public page. */
export function normalizeImportUrl(value: string): string {
  const input = value.trim();
  if (!input || input.length > 8192 || /[\u0000-\u0020\u007f]/.test(input))
    throw new Error("请输入有效的网页地址，地址中不能包含空格或控制字符。");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("请输入完整的 http 或 https 网页地址。");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("请使用不含账号或密码的 http 或 https 网页地址。");
  return url.href;
}

const webUrlSchema = z
  .string()
  .max(8192)
  .refine((value) => {
    try {
      return normalizeImportUrl(value) === value;
    } catch {
      return false;
    }
  });

/** Matches the existing Web endpoint, including its link-only fallback. */
export const webPreviewSchema = z
  .object({
    originalUrl: webUrlSchema,
    finalUrl: webUrlSchema,
    capturedAt: timestampSchema,
    title: z.string().trim().min(1).max(512),
    text: z.string().max(MAX_WEB_TEXT),
    excerpt: z.string().max(500),
    byline: z.string().max(512).optional(),
    siteName: z.string().max(512).optional(),
    warnings: z.array(z.string().max(1000)).max(20),
    kind: z.enum(["article", "link-only"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.kind === "article" && !value.text.trim()) ||
      (value.kind === "link-only" && value.text !== "")
    )
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "正文与提取状态不一致。",
      });
  });
export type WebPreview = z.infer<typeof webPreviewSchema>;

function comparableUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(normalizeImportUrl(value));
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function duplicateWebSource(
  workspace: Workspace,
  url: string,
  preview?: WebPreview,
) {
  const candidates = new Set(
    [comparableUrl(url), comparableUrl(preview?.finalUrl)].filter(Boolean),
  );
  return workspace.sources.find((source) => {
    if (source.kind !== "web" || source.deletedAt) return false;
    const metadata = source.webSnapshot as
      { originalUrl?: unknown; finalUrl?: unknown } | undefined;
    return [source.url, metadata?.originalUrl, metadata?.finalUrl].some(
      (value) => candidates.has(comparableUrl(value)),
    );
  });
}

/** Hermes does not need a TextEncoder polyfill just to size a JSON snapshot. */
function utf8Bytes(value: string) {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function webChunks(
  text: string,
  sourceId: string,
  versionId: string,
): Source["chunks"] {
  const chunks: Source["chunks"] = [];
  let section = "正文";
  for (const block of text.split(/\n\s*\n/).filter(Boolean)) {
    const heading = block.match(/^#{1,6}\s+([^\n]+)/);
    if (heading) section = heading[1].trim().slice(0, 512);
    let remaining = block.trim();
    while (remaining) {
      let end = Math.min(1200, remaining.length);
      if (remaining.length > 1200) {
        const boundaries = [
          ...remaining.slice(900, 1200).matchAll(/[。！？.!?;；\n]\s*/g),
        ];
        const last = boundaries.at(-1);
        if (last) end = 900 + last.index! + last[0].length;
        // Keep a surrogate pair together at a hard cut.
        if (
          /[\uD800-\uDBFF]/.test(remaining[end - 1]) &&
          /[\uDC00-\uDFFF]/.test(remaining[end])
        )
          end--;
      }
      const content = remaining.slice(0, end).trim();
      if (content)
        chunks.push({
          id: `${versionId}_chunk_${chunks.length}`,
          sourceId,
          versionId,
          text: content,
          section,
          order: chunks.length,
        });
      remaining = remaining.slice(end).trimStart();
    }
  }
  return chunks;
}

export type WebImportInput = {
  id: string;
  versionId: string;
  url: string;
  title?: string;
  spaceId?: string;
  now: string;
  preview?: WebPreview;
  mode?: "article" | "link";
  aiAllowed?: boolean;
  allowDuplicate?: boolean;
};

/** The caller retains these IDs across an uncertain save and checks the cloud before retrying. */
export function createWebSource(
  workspace: Workspace,
  input: WebImportInput,
): Workspace {
  if (
    !identitySchema.safeParse(input.id).success ||
    !identitySchema.safeParse(input.versionId).success ||
    !timestampSchema.safeParse(input.now).success
  )
    throw new Error("资料身份或保存时间无效，请重新打开收集页面。");
  if (
    workspace.sources.some(
      (source) =>
        source.id === input.id ||
        source.versionId === input.versionId ||
        (Array.isArray(source.versions) &&
          source.versions.some(
            (version) =>
              version &&
              typeof version === "object" &&
              "versionId" in version &&
              version.versionId === input.versionId,
          )),
    )
  )
    throw new Error("这份资料已经保存，请重新载入资料库核对。");
  const url = normalizeImportUrl(input.url);
  const preview = input.preview
    ? webPreviewSchema.parse(input.preview)
    : undefined;
  if (preview && preview.originalUrl !== url)
    throw new Error("预览来源与当前网址不一致，请重新提取。");
  const mode = input.mode ?? (preview?.kind === "article" ? "article" : "link");
  if (mode === "article" && preview?.kind !== "article")
    throw new Error("没有提取到正文，可仅保存链接。");
  if (mode === "article" && input.aiAllowed === true && !workspace.aiEnabled)
    throw new Error("请先开启工作区 AI，再授权这份正文。");
  if (
    input.spaceId &&
    input.spaceId !== "inbox" &&
    !workspace.spaces.some(
      (space) => space.id === input.spaceId && !space.archived,
    )
  )
    throw new Error("目标知识库已不可用，请重新选择保存位置。");
  if (!input.allowDuplicate && duplicateWebSource(workspace, url, preview))
    throw new Error("资料库已收藏这个网页，可打开已有资料，或确认另存一份。");
  if (workspace.sources.length >= 5000)
    throw new Error("资料数量已达当前上限，请先整理资料库。");
  const title = input.title?.trim() || preview?.title || new URL(url).hostname;
  if (title.length > 512) throw new Error("网页标题请控制在 512 个字符以内。");
  const text =
    mode === "article"
      ? preview!.text
          .replace(/\r\n?/g, "\n")
          .replace(/\u0000/g, "")
          .trim()
      : "";
  if (mode === "article" && !text)
    throw new Error("没有可保存的正文，可仅保存链接。");
  const chunks = webChunks(text, input.id, input.versionId);
  if (chunks.length > 20_000) throw new Error("正文段落过多，请改为收藏链接。");
  const source: Source = {
    id: input.id,
    versionId: input.versionId,
    title,
    filename: `${title.slice(0, 508)}.txt`,
    kind: "web",
    mime: "text/plain",
    size: utf8Bytes(text),
    hash: "",
    url,
    spaceIds: input.spaceId && input.spaceId !== "inbox" ? [input.spaceId] : [],
    tags: [],
    status: mode === "article" ? "ready" : "link-only",
    coverage:
      mode === "article"
        ? { captureScope: "full", parseState: "complete" }
        : { captureScope: "link", parseState: "not-requested" },
    text,
    chunks,
    aiAllowed:
      mode === "article" && workspace.aiEnabled && input.aiAllowed === true,
    starred: false,
    createdAt: input.now,
    updatedAt: input.now,
    deletedAt: null,
    webSnapshot: {
      originalUrl: url,
      finalUrl: preview?.finalUrl ?? url,
      capturedAt: preview?.capturedAt ?? input.now,
      method: preview ? "server" : "manual",
      scope: mode === "article" ? "article" : "link",
      warnings: [...(preview?.warnings ?? [])],
      ...(preview?.byline ? { byline: preview.byline } : {}),
      ...(preview?.siteName ? { siteName: preview.siteName } : {}),
    },
  };
  const next = { ...workspace, sources: [source, ...workspace.sources] };
  if (utf8Bytes(JSON.stringify(next)) > MAX_WORKSPACE_BYTES)
    throw new Error("工作区超过当前 3 MiB 快照容量，请先整理资料后重试。");
  return next;
}
