import { File, Paths } from "expo-file-system";
import type { Source } from "./contracts.ts";
import { getAuthClient } from "../session";

function cacheName(source: Source) {
  return `conuo-${source.id}-${source.versionId}.pdf`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const candidate = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof candidate.arrayBuffer === "function") return candidate.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("原件字节读取结果无效。"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("原件字节读取失败。"));
    reader.readAsArrayBuffer(blob);
  });
}

/** Download one immutable private PDF version to a local file URI for PDFKit. */
export async function downloadPdfOriginal(source: Source): Promise<string> {
  if (source.kind !== "pdf" || !source.storagePath)
    throw new Error("这份资料没有可用的 PDF 原件，请重新上传或在网页版打开。");
  const client = getAuthClient();
  if (!client) throw new Error("当前构建尚未配置云端连接，请重新启动客户端。");
  let stage = "下载原件";
  try {
    // Paths.cache already exists on iOS. Keeping the file directly there avoids
    // relying on Directory.create in older Expo FileSystem native runtimes.
    const file = new File(Paths.cache, cacheName(source));
    const { data, error } = await client.storage.from("originals").download(source.storagePath);
    if (error || !data) throw new Error("原件下载失败，请检查网络后重试。");
    stage = "读取原件字节";
    const bytes = new Uint8Array(await blobToArrayBuffer(data));
    const expectedSize = source.size ?? 0;
    if (expectedSize > 0 && bytes.byteLength !== expectedSize)
      throw new Error("原件大小校验失败，未打开这份 PDF。");
    stage = "写入本机缓存";
    if (file.exists) file.delete();
    file.write(bytes);
    return file.uri;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "未知错误";
    throw new Error(`原件${stage}失败：${message}`);
  }
}
