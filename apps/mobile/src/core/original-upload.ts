import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Source } from "./contracts.ts";

const reservationSchema = z
  .object({
    status: z.enum(["reserved", "uploaded", "committed"]),
    intentId: z.string().uuid(),
    storagePath: z.string().min(1).max(512),
    reservationToken: z.string().uuid().nullable(),
    reservationUntil: z.string().min(1).max(80).nullable(),
  })
  .strict();
const completionSchema = z
  .object({
    status: z.enum(["uploaded", "committed"]),
    intentId: z.string().uuid(),
    storagePath: z.string().min(1).max(512),
    reservationUntil: z.string().min(1).max(80).nullable(),
  })
  .strict();

type CloudFailure = {
  code?: string | null;
  status?: number | null;
  statusCode?: string | number | null;
} | null;
type RpcResult = { data: unknown; error: CloudFailure };

export type OriginalUploadPort = {
  currentUserId: () => Promise<string | null>;
  reserve: (input: {
    sourceId: string;
    versionId: string;
    expectedBytes: number;
    expectedSha256: string;
    contentType: string;
  }) => Promise<RpcResult>;
  upload: (
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ) => Promise<{ error: CloudFailure }>;
  download: (path: string) => Promise<{ bytes?: Uint8Array; error: CloudFailure }>;
  complete: (intentId: string, reservationToken: string) => Promise<RpcResult>;
  sha256: (bytes: Uint8Array) => Promise<string>;
};

export function createSupabaseOriginalUploadPort(
  client: SupabaseClient,
  sha256: (bytes: Uint8Array) => Promise<string>,
): OriginalUploadPort {
  // Supabase's rpc method reads the client's internal `rest` field through
  // `this`; extracting it unbound causes "Cannot read property 'rest' of
  // undefined" on Hermes during the first reservation call.
  const rpc = client.rpc.bind(client) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<RpcResult>;
  return {
    currentUserId: async () => {
      const { data, error } = await client.auth.getUser();
      if (error) return null;
      return data.user?.id ?? null;
    },
    reserve: (input) =>
      rpc("reserve_original_upload", {
        p_source_id: input.sourceId,
        p_version_id: input.versionId,
        p_kind: "pdf",
        p_expected_bytes: input.expectedBytes,
        p_expected_sha256: input.expectedSha256,
        p_content_type: input.contentType,
      }),
    upload: async (path, bytes, contentType) => {
      const data =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? (bytes.buffer as ArrayBuffer)
          : (bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer);
      const { error } = await client.storage
        .from("originals")
        .upload(path, data, { contentType, upsert: false });
      return { error: error as CloudFailure };
    },
    download: async (path) => {
      const { data, error } = await client.storage.from("originals").download(path);
      return {
        ...(data ? { bytes: new Uint8Array(await data.arrayBuffer()) } : {}),
        error: error as CloudFailure,
      };
    },
    complete: (intentId, reservationToken) =>
      rpc("complete_original_upload", {
        p_intent_id: intentId,
        p_reservation_token: reservationToken,
      }),
    sha256,
  };
}

function sourcePath(source: Source, owner: string) {
  for (const component of [owner, source.versionId, source.id]) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(component))
      throw new Error("资料标识无效，文件尚未上传。");
  }
  return `${owner}/${source.versionId}/${source.id}.pdf`;
}

function reservationError(error: CloudFailure) {
  const code = error?.code;
  if (code === "42501") return new Error("登录已失效，请重新登录后再上传。");
  if (code === "55P03") return new Error("云端正在处理这份原件，请稍后重试。");
  if (code === "40001" || code === "PT409")
    return new Error("这份原件的云端状态已变化，请稍后重试。");
  if (code === "22023")
    return new Error("文件超过当前账号的云端容量，或不符合上传要求。");
  return new Error("云端原件预留失败，请检查网络后重试。");
}

function completionError(error: CloudFailure) {
  const code = error?.code;
  if (code === "42501") return new Error("登录已失效，请重新登录后再确认上传。");
  if (code === "55P03") return new Error("云端正在处理这份原件，请稍后重试。");
  if (code === "40001" || code === "PT409")
    return new Error("云端尚未确认这份原件，请稍后重试。");
  if (code === "22023") return new Error("云端原件校验未通过，请重新选择文件。");
  return new Error("云端尚未确认这份原件，请稍后重试。");
}

function checkIdentity(source: Source, bytes: Uint8Array) {
  if (
    source.kind !== "pdf" ||
    !source.id ||
    !source.versionId ||
    !source.hash ||
    source.size !== bytes.byteLength ||
    bytes.byteLength > 30 * 1024 * 1024 ||
    source.mime !== "application/pdf"
  )
    throw new Error("文件身份或大小校验失败，尚未开始云端上传。");
}

async function ensureOwner(port: OriginalUploadPort, expectedUserId: string) {
  if ((await port.currentUserId()) !== expectedUserId)
    throw new Error("账号已改变，已停止原件上传。");
}

/** Uploads an immutable PDF using the same reservation and completion contract as Web. */
export async function uploadPdfOriginal(
  source: Source,
  bytes: Uint8Array,
  expectedUserId: string,
  port: OriginalUploadPort,
) {
  checkIdentity(source, bytes);
  if ((await port.sha256(bytes)).toLowerCase() !== source.hash)
    throw new Error("文件内容与待导入资料不一致，请重新选择 PDF。");
  await ensureOwner(port, expectedUserId);
  const path = sourcePath(source, expectedUserId);
  const reservationResult = await port.reserve({
    sourceId: source.id,
    versionId: source.versionId,
    expectedBytes: bytes.byteLength,
    expectedSha256: source.hash,
    contentType: "application/pdf",
  });
  if (reservationResult.error) throw reservationError(reservationResult.error);
  const reservation = reservationSchema.safeParse(reservationResult.data);
  if (!reservation.success || reservation.data.storagePath !== path)
    throw new Error("云端原件预留返回无效，文件尚未上传。");
  if (reservation.data.status === "committed") return path;

  await ensureOwner(port, expectedUserId);
  if (reservation.data.status === "reserved") {
    const uploaded = await port.upload(path, bytes, "application/pdf");
    if (uploaded.error) {
      const status = String(uploaded.error.statusCode ?? uploaded.error.status ?? "");
      if (!["400", "409"].includes(status))
        throw new Error("原件上传失败；资料库尚未确认，请检查网络后重试。");
      const existing = await port.download(path);
      if (
        existing.error ||
        !existing.bytes ||
        existing.bytes.byteLength !== bytes.byteLength ||
        (await port.sha256(existing.bytes)).toLowerCase() !== source.hash
      )
        throw new Error("同一原件路径已有不同内容，未覆盖云端文件。");
    }
  }

  const token = reservation.data.reservationToken;
  if (!token) throw new Error("云端原件预留已失效，请重新上传。");
  await ensureOwner(port, expectedUserId);
  const completed = await port.complete(reservation.data.intentId, token);
  if (completed.error) throw completionError(completed.error);
  const result = completionSchema.safeParse(completed.data);
  if (!result.success || result.data.storagePath !== path)
    throw new Error("云端尚未确认这份原件，资料库不会显示上传成功。");
  return path;
}
