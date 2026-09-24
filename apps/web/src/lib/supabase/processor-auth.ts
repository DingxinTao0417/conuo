import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError } from "./api";

export function configuredSecrets(): string[] {
  return [process.env.CONUO_PROCESSOR_SECRET?.trim(), process.env.CRON_SECRET?.trim()].filter(
    (secret): secret is string =>
      !!secret && secret.length >= 32 && secret.length <= 4096 && !/[^\x21-\x7e]/.test(secret),
  );
}

export function requireProcessorIdentity(request: Request): void {
  const secrets = configuredSecrets();
  if (!secrets.length)
    throw new ApiError(503, "PROCESSOR_NOT_CONFIGURED", "后台处理入口尚未配置。");
  const header = request.headers.get("authorization") || "";
  if (header.length > 8192) throw new ApiError(401, "PROCESSOR_UNAUTHORIZED", "后台处理身份无效。");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const actual = digest(header);
  const matched = secrets.some((secret) => timingSafeEqual(actual, digest("Bearer " + secret)));
  if (!matched) throw new ApiError(401, "PROCESSOR_UNAUTHORIZED", "后台处理身份无效。");
}
