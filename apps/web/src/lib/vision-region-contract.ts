import { z } from "zod";

export const VISION_REGION_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const VISION_REGION_MAX_BODY_BYTES = 3 * 1024 * 1024;
export const VISION_REGION_MAX_DIMENSION = 4096;
export const VISION_REGION_MAX_PIXELS = 8_000_000;
export const VISION_REGION_MAX_DATA_URL_CHARS =
  Math.ceil((VISION_REGION_MAX_IMAGE_BYTES * 4) / 3) + 64;

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const coordinate = z.number().finite().min(0).max(1);
const extent = z.number().finite().positive().max(1);

export const visionRegionSchema = z
  .object({
    x: coordinate,
    y: coordinate,
    width: extent,
    height: extent,
  })
  .strict()
  .superRefine((region, context) => {
    if (region.x + region.width > 1 + Number.EPSILON)
      context.addIssue({ code: "custom", path: ["width"], message: "区域超出页面右边界。" });
    if (region.y + region.height > 1 + Number.EPSILON)
      context.addIssue({ code: "custom", path: ["height"], message: "区域超出页面下边界。" });
  });

export const visionProvenanceSchema = z
  .object({
    sourceId: id,
    versionId: id,
    page: z.number().int().min(1).max(100_000),
    region: visionRegionSchema,
  })
  .strict();

export const visionImageInputSchema = z
  .object({
    dataUrl: z.string().min(1).max(VISION_REGION_MAX_DATA_URL_CHARS),
    width: z.number().int().min(1).max(VISION_REGION_MAX_DIMENSION),
    height: z.number().int().min(1).max(VISION_REGION_MAX_DIMENSION),
  })
  .strict();

const visionHistoryItemSchema = z
  .object({
    question: z.string().trim().min(1).max(2_000),
    answer: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const visionStudyRequestSchema = z
  .object({
    requestId: id,
    task: z.enum(["explain", "ask", "quiz"]),
    provenance: visionProvenanceSchema,
    image: visionImageInputSchema,
    question: z.string().trim().min(1).max(2_000).optional(),
    history: z.array(visionHistoryItemSchema).max(3).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.task === "ask" && !request.question)
      context.addIssue({
        code: "custom",
        path: ["question"],
        message: "区域问答需要问题。",
      });
    if (request.task !== "ask" && request.question !== undefined)
      context.addIssue({
        code: "custom",
        path: ["question"],
        message: "只有区域问答可以携带问题。",
      });
  });

const visibleTextSchema = z.string().trim().max(16_000);
const answerText = z.string().trim().min(1).max(16_000);
export const visionExplanationSummarySchema = z.string().trim().min(1).max(1_200);
export const visionExplanationSectionSchema = z
  .object({
    kind: z.enum(["observation", "reasoning", "takeaway"]),
    title: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\r\n\u2028\u2029]+$/, "解读小节标题必须为单行文本。"),
    content: z.string().trim().min(1).max(4_000),
  })
  .strict();
export const visionExplanationSectionsSchema = z
  .array(visionExplanationSectionSchema)
  .min(2)
  .max(8)
  .superRefine((sections, context) => {
    for (const kind of ["observation", "takeaway"] as const) {
      if (!sections.some((section) => section.kind === kind))
        context.addIssue({
          code: "custom",
          message: `解读需要 ${kind} 小节。`,
        });
    }
  });

export type VisionExplanationSection = z.infer<typeof visionExplanationSectionSchema>;

/** Keep the public copy text identical to the structured explanation shown in the UI. */
export function visionExplanationMarkdown(
  summary: string,
  sections: readonly VisionExplanationSection[],
): string {
  return [
    summary,
    ...sections.map(
      (section) => `## ${section.title.replace(/[\\`*_[\]<>]/g, "\\$&")}\n\n${section.content}`,
    ),
  ].join("\n\n");
}

const quizQuestion = z
  .object({
    question: z.string().trim().min(1).max(2_000),
    answer: z.string().trim().min(1).max(4_000),
    explanation: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const visionStudyResultSchema = z.discriminatedUnion("task", [
  z
    .object({
      mode: z.literal("vision"),
      task: z.literal("explain"),
      provenance: visionProvenanceSchema,
      visibleText: visibleTextSchema.optional(),
      content: answerText,
      summary: visionExplanationSummarySchema.optional(),
      sections: visionExplanationSectionsSchema.optional(),
    })
    .strict()
    .superRefine((result, context) => {
      if ((result.summary === undefined) !== (result.sections === undefined))
        context.addIssue({
          code: "custom",
          path: result.summary === undefined ? ["summary"] : ["sections"],
          message: "解读摘要与小节需要一起提供。",
        });
      if (
        result.summary !== undefined &&
        result.sections !== undefined &&
        result.content !== visionExplanationMarkdown(result.summary, result.sections)
      )
        context.addIssue({
          code: "custom",
          path: ["content"],
          message: "解读复制内容与摘要及小节不一致。",
        });
    }),
  z
    .object({
      mode: z.literal("vision"),
      task: z.literal("ask"),
      provenance: visionProvenanceSchema,
      visibleText: visibleTextSchema.optional(),
      content: answerText,
    })
    .strict(),
  z
    .object({
      mode: z.literal("vision"),
      task: z.literal("quiz"),
      provenance: visionProvenanceSchema,
      visibleText: visibleTextSchema.optional(),
      questions: z.array(quizQuestion).min(1).max(8),
    })
    .strict(),
]);

export type VisionRegion = z.infer<typeof visionRegionSchema>;
export type VisionProvenance = z.infer<typeof visionProvenanceSchema>;
export type VisionStudyRequest = z.infer<typeof visionStudyRequestSchema>;
export type VisionStudyResult = z.infer<typeof visionStudyResultSchema>;

export function sameVisionProvenance(left: VisionProvenance, right: VisionProvenance): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.versionId === right.versionId &&
    left.page === right.page &&
    left.region.x === right.region.x &&
    left.region.y === right.region.y &&
    left.region.width === right.region.width &&
    left.region.height === right.region.height
  );
}
