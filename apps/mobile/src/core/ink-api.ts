import { z } from "zod";
import { createApi, type ClientError } from "./api.ts";

const revisionId = z.string().uuid();
const coordinateSpace = z.object({ version: z.literal(1), space: z.literal("pdf-crop-box") }).strict();

export const inkManifestSchema = z
  .object({
    inkDocumentId: revisionId.nullable(),
    sourceId: z.string(),
    versionId: z.string(),
    pageCount: z.number().int().nonnegative(),
    pages: z.array(
      z
        .object({
          pageIndex: z.number().int().nonnegative(),
          headRevisionId: revisionId.nullable(),
          headGeneration: z.number().int().nonnegative(),
          previewDownloadUrl: z.string().url().optional(),
          coordinateSpace: coordinateSpace.optional(),
          pencilKitContentVersion: z.number().int().positive().optional(),
          updatedAt: z.string(),
          deleted: z.boolean(),
        })
        .strict(),
    ),
    updatedAt: z.string().optional(),
  })
  .strict();

export const inkReservationSchema = z
  .object({
    status: z.enum(["reserved", "uploaded", "committed"]),
    intentId: revisionId,
    revisionId,
    drawingStoragePath: z.string().min(1).max(512),
    previewStoragePath: z.string().min(1).max(512),
    reservationToken: revisionId,
    baseRevisionId: revisionId.nullable(),
    pageIndex: z.number().int().nonnegative(),
  })
  .strict();

export const inkCommitSchema = z
  .object({
    status: z.literal("committed"),
    revisionId,
    pageIndex: z.number().int().nonnegative(),
    headGeneration: z.number().int().nonnegative().optional(),
  })
  .strict();

export type InkSnapshotInput = {
  operationId: string;
  pageIndex: number;
  baseRevisionId: string | null;
  localGeneration: number;
  drawing: { sha256: string; bytes: number };
  preview: { sha256: string; bytes: number; mimeType: "image/png" };
  coordinateSpace: { version: 1; space: "pdf-crop-box" };
  pencilKitContentVersion: number;
};

export type InkApi = ReturnType<typeof createApi>;

export function parseInkManifest(value: unknown) {
  const parsed = inkManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error("云端笔迹清单格式不兼容，请更新客户端。");
  return parsed.data;
}

export function parseInkReservation(value: unknown) {
  const parsed = inkReservationSchema.safeParse(value);
  if (!parsed.success) throw new Error("云端笔迹预留响应无效，笔迹仍保留在本机。");
  return parsed.data;
}

export function parseInkCommit(value: unknown) {
  const parsed = inkCommitSchema.safeParse(value);
  if (!parsed.success) throw new Error("云端笔迹提交响应无效，笔迹仍保留在本机。");
  return parsed.data;
}

export function inkErrorMessage(error: unknown) {
  const cause = error as ClientError | null;
  if (cause?.code === "INK_PAGE_CONFLICT") return "这页在其他设备上有新笔迹，当前笔迹仍保留在本机。";
  if (cause?.code === "UNAUTHENTICATED" || cause?.code === "SESSION_CHANGED")
    return "登录已失效，当前笔迹仍保留在本机。";
  return "笔迹尚未同步到云端，当前笔迹仍保留在本机。";
}

/**
 * Page-level upload identity. Generation changes when the client starts a new
 * CAS attempt (new content or retry after rejection) so stale intents cannot
 * block a later upload of the same bytes.
 */
export function buildInkOperationId(
  pageIndex: number,
  drawingSha256: string,
  generation: number,
) {
  return `p${Math.max(0, pageIndex)}g${Math.max(1, generation)}-${drawingSha256}`.slice(0, 100);
}

/** Serializes ink commits for one page so concurrent snapshots cannot self-conflict. */
export function createInkSyncQueue() {
  const tails = new Map<number, Promise<void>>();
  return function enqueue(pageIndex: number, task: () => Promise<void>) {
    const previous = tails.get(pageIndex) ?? Promise.resolve();
    const next = previous.then(task, task);
    tails.set(
      pageIndex,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };
}
