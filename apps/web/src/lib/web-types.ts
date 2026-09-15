import { z } from "zod";

export const MAX_WEB_TEXT = 120_000;

/** URL validation here never grants permission for a server network request. */
export function normalizeWebUrl(value: string): string {
  const input = value.trim();
  if (!input || input.length > 8192 || /[\u0000-\u0020\u007f]/.test(input))
    throw new Error("请输入有效的网页地址，地址中不能包含空格或控制字符。");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("请输入完整的 http 或 https 网页地址。");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("请使用不含账号或密码的 http 或 https 网页地址。");
  return url.href;
}

const webUrlSchema = z
  .string()
  .max(8192)
  .refine((value) => {
    try {
      return normalizeWebUrl(value) === value;
    } catch {
      return false;
    }
  }, "网页地址无效");

export const webPreviewSchema = z
  .object({
    originalUrl: webUrlSchema,
    finalUrl: webUrlSchema,
    capturedAt: z.string().datetime({ offset: true }),
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
      context.addIssue({ code: "custom", path: ["text"], message: "正文与提取状态不一致" });
  });
export type WebPreview = z.infer<typeof webPreviewSchema>;

export const webSnapshotSchema = z
  .object({
    originalUrl: webUrlSchema,
    finalUrl: webUrlSchema,
    capturedAt: z.string().datetime({ offset: true }),
    method: z.enum(["server", "manual"]),
    scope: z.enum(["article", "selection", "pasted", "link"]),
    byline: z.string().max(512).optional(),
    siteName: z.string().max(512).optional(),
    warnings: z.array(z.string().max(1000)).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.method === "manual" && !["pasted", "link"].includes(value.scope)) ||
      (value.method === "server" && value.scope === "pasted")
    )
      context.addIssue({ code: "custom", path: ["scope"], message: "保存方式与采集范围不一致" });
  });
export type WebSnapshot = z.infer<typeof webSnapshotSchema>;
