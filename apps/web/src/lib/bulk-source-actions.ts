import type { WorkspaceData } from "./types";
import { addSourcesToLearningSpaces } from "./source-space-association";
import { recycleSourcesWithResult } from "./space-lifecycle";
import { MAX_WORKSPACE_BYTES } from "./supabase/validation";

export type BulkSourceActionRequest =
  | { kind: "associate"; sourceIds: readonly string[]; spaceIds: readonly string[] }
  | { kind: "recycle"; sourceIds: readonly string[]; spaceIds?: never };
export interface BulkSourceActionItem {
  sourceId: string;
  versionId: string | null;
  title: string;
  status: "accepted" | "noop" | "failed";
  reason: string;
  addedSpaceIds: string[];
  at?: string;
}
export interface BulkSourceActionResult {
  kind: "associate" | "recycle";
  request: BulkSourceActionRequest;
  at: string;
  selectedCount: number;
  items: BulkSourceActionItem[];
  acceptedSourceIds: string[];
  noopSourceIds: string[];
  failedSourceIds: string[];
  addedSourceIds: string[];
  addedAssociations: number;
  recycledSourceIds: string[];
}
export interface BulkSourceActionApplication {
  data: WorkspaceData;
  result: BulkSourceActionResult;
}
type Binding = { versionId: string; deletedAt: string | null; spaceIds: string[] };
type Receipt = { confirmed: boolean; bindings: Map<string, Binding> };
const receipts = new WeakMap<BulkSourceActionResult, Receipt>();
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
function ids(values: readonly string[], max: number, label: string): string[] {
  if (!Array.isArray(values) || !values.length) throw new Error(`请至少选择一个${label}。`);
  if (values.length > max) throw new Error(`每次最多选择 ${max} 个${label}，请分批处理。`);
  if (values.some((value) => typeof value !== "string" || !ID.test(value)))
    throw new Error(`所选${label}身份不合规，请重新选择。`);
  return [...new Set(values)];
}
function normalize(request: BulkSourceActionRequest): BulkSourceActionRequest {
  if (
    !request ||
    typeof request !== "object" ||
    !["associate", "recycle"].includes(request.kind) ||
    Object.keys(request).some((key) => !["kind", "sourceIds", "spaceIds"].includes(key))
  )
    throw new Error("批量操作请求身份不合规。");
  const sourceIds = ids(request.sourceIds, 5000, "资料");
  if (request.kind === "associate")
    return { kind: "associate", sourceIds, spaceIds: ids(request.spaceIds, 500, "学习空间") };
  if (Object.hasOwn(request, "spaceIds")) throw new Error("移入回收站不能同时指定学习空间。");
  return { kind: "recycle", sourceIds };
}
function time(value?: string): string {
  if (value === undefined) return new Date().toISOString();
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("批量操作时间不合规。");
  return new Date(value).toISOString();
}
function spaces(data: WorkspaceData, request: BulkSourceActionRequest) {
  if (request.kind !== "associate") return;
  const active = new Set(data.spaces.filter((space) => !space.archived).map((space) => space.id));
  if (request.spaceIds.some((id) => !active.has(id)))
    throw new Error("所选学习空间已不存在或已归档，请重新选择。");
}
function capacity(data: WorkspaceData) {
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_WORKSPACE_BYTES)
    throw new Error("批量操作超过工作区容量，本次整批未提交；请先导出并清理后重试。");
}
function recorded(
  data: WorkspaceData,
  request: BulkSourceActionRequest,
  at: string,
  items: BulkSourceActionItem[],
  bindings?: Map<string, Binding>,
): BulkSourceActionResult {
  const actualBindings = bindings ?? new Map<string, Binding>(),
    byId = new Map(data.sources.map((source) => [source.id, source]));
  for (const item of items) {
    if (!actualBindings.has(item.sourceId) && item.status !== "failed") {
      const source = byId.get(item.sourceId)!;
      actualBindings.set(item.sourceId, {
        versionId: source.versionId,
        deletedAt: source.deletedAt,
        spaceIds: request.kind === "associate" ? [...request.spaceIds] : [],
      });
    }
    Object.freeze(item.addedSpaceIds);
    Object.freeze(item);
  }
  Object.freeze(request.sourceIds);
  if (request.kind === "associate") Object.freeze(request.spaceIds);
  Object.freeze(request);
  const acceptedSourceIds = items
      .filter((item) => item.status === "accepted")
      .map((item) => item.sourceId),
    noopSourceIds = items.filter((item) => item.status === "noop").map((item) => item.sourceId),
    failedSourceIds = items.filter((item) => item.status === "failed").map((item) => item.sourceId);
  const result: BulkSourceActionResult = {
    kind: request.kind,
    request,
    at,
    selectedCount: request.sourceIds.length,
    items,
    acceptedSourceIds,
    noopSourceIds,
    failedSourceIds,
    addedSourceIds: request.kind === "associate" ? [...acceptedSourceIds] : [],
    addedAssociations: items.reduce((count, item) => count + item.addedSpaceIds.length, 0),
    recycledSourceIds: request.kind === "recycle" ? [...acceptedSourceIds] : [],
  };
  for (const value of [
    items,
    acceptedSourceIds,
    noopSourceIds,
    failedSourceIds,
    result.addedSourceIds,
    result.recycledSourceIds,
  ])
    Object.freeze(value);
  Object.freeze(result);
  receipts.set(result, { confirmed: false, bindings: actualBindings });
  return result;
}
function protectedSources(data: WorkspaceData): Set<string> {
  const byId = new Map(data.sources.map((source) => [source.id, source])),
    protectedIds = new Set(
      data.sources.filter((source) => source.status === "parsing").map((source) => source.id),
    );
  for (const job of data.importJobs ?? [])
    if (
      (job.status === "queued" || job.status === "running") &&
      job.originalSaved &&
      job.stage === "parsing" &&
      byId.get(job.sourceId)?.versionId === job.versionId
    )
      protectedIds.add(job.sourceId);
  return protectedIds;
}
function receipt(result: BulkSourceActionResult): Receipt {
  const value = receipts.get(result);
  if (!value) throw new Error("批量操作结果身份已失效，请重新选择；不能使用复制或伪造结果。");
  return value;
}
function postconditions(data: WorkspaceData, result: BulkSourceActionResult, record: Receipt) {
  spaces(data, result.request);
  const byId = new Map(data.sources.map((source) => [source.id, source]));
  for (const [sourceId, expected] of record.bindings) {
    const current = byId.get(sourceId);
    if (
      !current ||
      current.versionId !== expected.versionId ||
      current.deletedAt !== expected.deletedAt ||
      expected.spaceIds.some((id) => !current.spaceIds.includes(id))
    )
      throw new Error(
        "已处理资料的版本、空间关联或回收状态已变化，请重新打开操作；本次不会覆盖这些变化。",
      );
  }
  capacity(data);
}
export function applyBulkSourceAction(
  data: WorkspaceData,
  request: BulkSourceActionRequest,
  at?: string,
): BulkSourceActionApplication {
  const normalized = normalize(request),
    now = time(at);
  spaces(data, normalized);
  const byId = new Map(data.sources.map((source) => [source.id, source])),
    busy = protectedSources(data),
    eligible: string[] = [],
    items: BulkSourceActionItem[] = [];
  for (const sourceId of normalized.sourceIds) {
    const source = byId.get(sourceId),
      base = {
        sourceId,
        versionId: source?.versionId ?? null,
        title: source?.title || `资料 ${sourceId}`,
        addedSpaceIds: [] as string[],
      };
    if (!source) {
      items.push({ ...base, status: "failed", reason: "资料已不可用，请恢复或重新选择。" });
      continue;
    }
    if (source.deletedAt) {
      items.push({
        ...base,
        status: normalized.kind === "recycle" ? "noop" : "failed",
        reason:
          normalized.kind === "recycle"
            ? "已在回收站，无需重复移入。"
            : "已在回收站，未改变关联；恢复后可重试。",
      });
      continue;
    }
    if (busy.has(sourceId)) {
      items.push({
        ...base,
        status: "failed",
        reason: "当前版本正在解析或等待解析，请先取消或等待完成后重试。",
      });
      continue;
    }
    if (normalized.kind === "associate") {
      const addedSpaceIds = normalized.spaceIds.filter((id) => !source.spaceIds.includes(id));
      if (new Set([...source.spaceIds, ...addedSpaceIds]).size > 500) {
        items.push({
          ...base,
          status: "failed",
          reason: "每份资料最多关联 500 个学习空间，请先整理已有关联。",
        });
        continue;
      }
      if (!addedSpaceIds.length) {
        items.push({ ...base, status: "noop", reason: "已关联到所选学习空间，无需修改。" });
        continue;
      }
      eligible.push(sourceId);
      items.push({
        ...base,
        addedSpaceIds,
        status: "accepted",
        reason: "已新增学习空间关联。",
        at: now,
      });
    } else {
      eligible.push(sourceId);
      items.push({ ...base, status: "accepted", reason: "已移入回收站，可恢复。", at: now });
    }
  }
  const next = !eligible.length
    ? data
    : normalized.kind === "associate"
      ? addSourcesToLearningSpaces(data, eligible, normalized.spaceIds, now).data
      : recycleSourcesWithResult(data, eligible, now).data;
  capacity(next);
  return { data: next, result: recorded(next, normalized, now, items) };
}
/** After real local acknowledgement, pass the latest guarded workspace; this verifies postconditions, not IO or ownership. */
export function confirmBulkSourceAction(
  data: WorkspaceData,
  result: BulkSourceActionResult,
): BulkSourceActionResult {
  const value = receipt(result);
  postconditions(data, result, value);
  value.confirmed = true;
  return result;
}
/** Save current unrelated edits too, without repeating any association/delete or losing its first accepted identities. */
export function snapshotRetryBulkSourceAction(
  data: WorkspaceData,
  result: BulkSourceActionResult,
): BulkSourceActionApplication {
  const value = receipt(result);
  if (value.confirmed) throw new Error("本次结果已确认保存，请只重试失败资料。");
  postconditions(data, result, value);
  return { data: { ...data }, result };
}
export function retryBulkSourceAction(
  data: WorkspaceData,
  result: BulkSourceActionResult,
  at?: string,
): BulkSourceActionApplication {
  const value = receipt(result);
  if (!value.confirmed) throw new Error("请先确认本次本机快照保存，再重试失败资料。");
  postconditions(data, result, value);
  if (!result.failedSourceIds.length) return { data, result };
  const request: BulkSourceActionRequest =
    result.kind === "associate"
      ? {
          kind: "associate",
          sourceIds: result.failedSourceIds,
          spaceIds: (result.request as Extract<BulkSourceActionRequest, { kind: "associate" }>)
            .spaceIds,
        }
      : { kind: "recycle", sourceIds: result.failedSourceIds };
  const next = applyBulkSourceAction(data, request, at),
    replaced = new Map(next.result.items.map((item) => [item.sourceId, item])),
    bindings = new Map(value.bindings);
  for (const [id, binding] of receipt(next.result).bindings) bindings.set(id, binding);
  const original: BulkSourceActionRequest =
    result.request.kind === "associate"
      ? {
          kind: "associate",
          sourceIds: [...result.request.sourceIds],
          spaceIds: [...result.request.spaceIds],
        }
      : { kind: "recycle", sourceIds: [...result.request.sourceIds] };
  return {
    data: next.data,
    result: recorded(
      next.data,
      original,
      next.result.at,
      result.items.map((item) => replaced.get(item.sourceId) ?? item),
      bindings,
    ),
  };
}
