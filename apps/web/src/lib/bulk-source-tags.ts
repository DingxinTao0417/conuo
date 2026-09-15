import type { WorkspaceData } from "./types";
import { setSourceTags } from "./organization-review";
import { MAX_WORKSPACE_BYTES } from "./supabase/validation";

export interface BulkSourceTagsItem {
  sourceId: string;
  title: string;
  status: "accepted" | "noop" | "failed";
  beforeTags?: string[];
  afterTags?: string[];
  reason: string;
}
export interface BulkSourceTagsResult {
  sourceIds: string[];
  tags: string[];
  selectedCount: number;
  items: BulkSourceTagsItem[];
  acceptedSourceIds: string[];
  noopSourceIds: string[];
  failedSourceIds: string[];
}
export interface BulkSourceTagsApplication {
  data: WorkspaceData;
  result: BulkSourceTagsResult;
}
export function normalizeBulkSourceTags(input: string | readonly string[]): string[] {
  if ((typeof input !== "string" && !Array.isArray(input)) || input.length > 20_000)
    throw new Error("标签输入不合规或过长。");
  const values = typeof input === "string" ? input.split(/[,，]/u) : input;
  if (values.some((value) => typeof value !== "string")) throw new Error("标签必须是文字。");
  // Match the manual setter. Case/NFKC normalization would rename independently chosen labels.
  const tags = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (!tags.length) throw new Error("请输入至少一个标签。");
  if (tags.length > 100 || tags.some((tag) => tag.length > 100))
    throw new Error("每份资料最多 100 个标签，每个标签最多 100 字符。");
  return tags;
}
function selection(sourceIds: readonly string[]): string[] {
  if (!Array.isArray(sourceIds) || !sourceIds.length) throw new Error("请先选择资料。");
  if (sourceIds.length > 5000) throw new Error("每次最多选择 5000 份资料，请分批处理。");
  if (sourceIds.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)))
    throw new Error("所选资料身份不合规，请重新选择。");
  return [...new Set(sourceIds)];
}
function freezeResult(value: BulkSourceTagsResult): BulkSourceTagsResult {
  for (const item of value.items) {
    if (item.beforeTags) Object.freeze(item.beforeTags);
    if (item.afterTags) Object.freeze(item.afterTags);
    Object.freeze(item);
  }
  Object.freeze(value.items);
  Object.freeze(value.tags);
  Object.freeze(value.sourceIds);
  Object.freeze(value.acceptedSourceIds);
  Object.freeze(value.noopSourceIds);
  Object.freeze(value.failedSourceIds);
  return Object.freeze(value);
}
function summarized(
  sourceIds: string[],
  tags: string[],
  items: BulkSourceTagsItem[],
): BulkSourceTagsResult {
  return freezeResult({
    sourceIds: [...sourceIds],
    tags: [...tags],
    selectedCount: sourceIds.length,
    items,
    acceptedSourceIds: items
      .filter((item) => item.status === "accepted")
      .map((item) => item.sourceId),
    noopSourceIds: items.filter((item) => item.status === "noop").map((item) => item.sourceId),
    failedSourceIds: items.filter((item) => item.status === "failed").map((item) => item.sourceId),
  });
}
function apply(
  data: WorkspaceData,
  sourceIds: string[],
  tags: string[],
): BulkSourceTagsApplication {
  const sources = new Map(data.sources.map((source) => [source.id, source])),
    changed = new Map<string, WorkspaceData["sources"][number]>();
  const items: BulkSourceTagsItem[] = sourceIds.map((sourceId) => {
    const source = sources.get(sourceId),
      title = source?.title || `资料 ${sourceId}`;
    if (!source)
      return {
        sourceId,
        title,
        status: "failed",
        reason: "这份资料已不可用，请恢复或重新选择后重试。",
      };
    if (source.deletedAt)
      return {
        sourceId,
        title,
        status: "failed",
        reason: "已在回收站，标签未修改；恢复后可重试。",
      };
    try {
      // The single-source view reuses the real manual writer without repeatedly traversing the whole batch.
      const updated = setSourceTags({ ...data, sources: [source] }, sourceId, [
        ...source.tags,
        ...tags,
      ]).sources[0];
      const same = updated === source;
      if (!same) changed.set(sourceId, updated);
      return {
        sourceId,
        title,
        status: same ? "noop" : "accepted",
        beforeTags: [...source.tags],
        afterTags: [...updated.tags],
        reason: same ? "已包含所填标签，无需修改。" : "标签已修改。",
      };
    } catch (cause) {
      return {
        sourceId,
        title,
        status: "failed",
        reason: cause instanceof Error ? cause.message : "这份资料的标签未修改，请检查后重试。",
      };
    }
  });
  const next = changed.size
    ? { ...data, sources: data.sources.map((source) => changed.get(source.id) ?? source) }
    : data;
  // All accepted changes form one atomic workspace write. Capacity failure rejects the entire batch.
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_WORKSPACE_BYTES)
    throw new Error("批量标签超过工作区容量，本次整批未提交；请先导出并清理后重试。");
  return { data: next, result: summarized(sourceIds, tags, items) };
}
export function applyBulkSourceTags(
  data: WorkspaceData,
  sourceIds: readonly string[],
  tags: string | readonly string[],
): BulkSourceTagsApplication {
  const ids = selection(sourceIds),
    labels = normalizeBulkSourceTags(tags);
  return apply(data, ids, labels);
}
export function retryBulkSourceTags(
  data: WorkspaceData,
  previous: BulkSourceTagsResult,
): BulkSourceTagsApplication {
  if (!previous || typeof previous !== "object")
    throw new Error("上次批量标签结果已不可用，请重新选择。");
  const ids = selection(previous.sourceIds),
    tags = normalizeBulkSourceTags(previous.tags);
  if (
    ids.length !== previous.selectedCount ||
    ids.length !== previous.sourceIds.length ||
    !Array.isArray(previous.items) ||
    previous.items.length !== ids.length ||
    previous.items.some(
      (item, i) =>
        !item ||
        item.sourceId !== ids[i] ||
        !["accepted", "noop", "failed"].includes(item.status) ||
        typeof item.title !== "string" ||
        typeof item.reason !== "string",
    )
  )
    throw new Error("上次批量标签结果身份不一致，请重新选择。");
  for (const [status, key] of [
    ["accepted", "acceptedSourceIds"],
    ["noop", "noopSourceIds"],
    ["failed", "failedSourceIds"],
  ] as const)
    if (
      JSON.stringify(previous[key]) !==
      JSON.stringify(
        previous.items.filter((item) => item.status === status).map((item) => item.sourceId),
      )
    )
      throw new Error("上次批量标签失败列表不一致，请重新选择。");
  if (!previous.failedSourceIds.length) return { data, result: previous };
  const retried = apply(data, [...previous.failedSourceIds], tags),
    replacement = new Map(retried.result.items.map((item) => [item.sourceId, item]));
  const items = previous.items.map(
    (item) =>
      replacement.get(item.sourceId) ?? {
        ...item,
        beforeTags: item.beforeTags ? [...item.beforeTags] : undefined,
        afterTags: item.afterTags ? [...item.afterTags] : undefined,
      },
  );
  return { data: retried.data, result: summarized(ids, tags, items) };
}
