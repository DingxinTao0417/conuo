import { makeWebSource } from "./import";
import type { Source, WorkspaceData } from "./types";
import { MAX_WORKSPACE_BYTES, workspaceSchema } from "./supabase/validation";
import { webPreviewSchema, type WebPreview } from "./web-types";
export { webPreviewSchema, type WebPreview } from "./web-types";

export function makeCapturedWebSource({
  preview: input,
  title,
  text,
  scope,
  spaceId,
  aiAllowed = false,
}: {
  preview: WebPreview;
  title?: string;
  text?: string;
  scope: "article" | "selection" | "link";
  spaceId: string;
  aiAllowed?: boolean;
}): Source {
  const preview = webPreviewSchema.parse(input);
  if (scope !== "link" && preview.kind !== "article")
    throw new Error("没有提取到正文，可选择仅保存链接或手动粘贴。");
  let selectedText = scope === "link" ? "" : preview.text;
  if (scope === "selection") {
    selectedText = text?.trim() ?? "";
    if (!selectedText || !preview.text.includes(selectedText))
      throw new Error("请选取预览正文中连续的一段文字；修改的文字可通过手动粘贴保存。");
  } else if (scope === "article" && text !== undefined && text !== preview.text) {
    throw new Error("提取正文已被修改，请重新预览或使用手动粘贴。");
  }
  const source = makeWebSource({
    url: preview.originalUrl,
    title: title ?? preview.title,
    text: selectedText,
    spaceId,
    aiAllowed,
  });
  source.webSnapshot = {
    originalUrl: preview.originalUrl,
    finalUrl: preview.finalUrl,
    capturedAt: preview.capturedAt,
    method: "server",
    scope,
    warnings: [...preview.warnings],
    ...(preview.byline ? { byline: preview.byline } : {}),
    ...(preview.siteName ? { siteName: preview.siteName } : {}),
  };
  source.coverage =
    scope === "selection"
      ? { captureScope: "selection", parseState: "complete" }
      : scope === "link"
        ? { captureScope: "link", parseState: "not-requested" }
        : { captureScope: "full", parseState: "complete" };
  return source;
}

/** A new capture is a separate immutable source until source revision UI exists. */
export function addWebSource(data: WorkspaceData, source: Source): WorkspaceData {
  if (source.kind !== "web" || !source.webSnapshot || source.deletedAt)
    throw new Error("网页资料无效，请重新预览。");
  if (data.sources.some((item) => item.id === source.id))
    throw new Error("这份网页已经保存，请勿重复提交。");
  if (
    source.spaceIds.some((id) => !data.spaces.some((space) => space.id === id && !space.archived))
  )
    throw new Error("目标知识库已不可用，请重新选择保存位置。");
  const next = { ...data, sources: [source, ...data.sources] };
  if (!workspaceSchema.safeParse(next).success)
    throw new Error("网页或工作区超过当前支持范围，请检查标题、正文和资料数量。");
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_WORKSPACE_BYTES)
    throw new Error("工作区超过当前 3 MiB 快照容量，请先导出并整理资料后重试。");
  return next;
}
