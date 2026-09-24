import { z } from "zod";
import { answerRequestSchema, workspaceSchema } from "@/lib/supabase/validation";
import { ApiError, requireUser } from "@/lib/supabase/api";
import { resolveCitation } from "@/lib/retrieval";
import { citationSchema } from "@/lib/citation-schema";
import type { LearningItem } from "@/lib/learning/types";
import type { WorkspaceData } from "@/lib/types";

export const learningAiRangeSchema = z
  .object({
    scope: z.enum(["selection", "document", "sources"]),
    sourceId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .optional(),
    sourceIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).max(100),
    sourceVersions: z
      .array(z.object({ sourceId: z.string(), versionId: z.string() }).strict())
      .optional(),
    spaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    selection: z.string().max(20_000).optional(),
  })
  .strict();

type UserSupabase = Awaited<ReturnType<typeof requireUser>>["supabase"];

export async function loadLearningWorkspace(
  supabase: UserSupabase,
  ownerId: string,
): Promise<WorkspaceData> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("data")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(404, "NO_WORKSPACE", "请先将资料保存到云端。");
  const parsed = workspaceSchema.safeParse(data.data);
  if (!parsed.success) throw new ApiError(422, "INVALID_CLOUD_DATA", "云端资料格式暂时无法读取。");
  return parsed.data;
}

export function makeAnswerRequest(
  input: z.infer<typeof learningAiRangeSchema>,
  requestId: string,
  question: string,
) {
  const parsed = answerRequestSchema.safeParse({ ...input, requestId, question });
  if (!parsed.success)
    throw new ApiError(400, "INVALID_LEARNING_REQUEST", "练习资料范围格式无效。");
  return parsed.data;
}

export function assertLearningEvidence(data: WorkspaceData, citations: unknown[]) {
  const parsed = z.array(citationSchema).safeParse(citations);
  if (
    !parsed.success ||
    parsed.data.some(
      (citation) =>
        !data.sources.some(
          (source) => source.id === citation.sourceId && source.aiAllowed && !source.deletedAt,
        ) || !resolveCitation(data, citation),
    )
  )
    throw new ApiError(
      409,
      "LEARNING_SOURCE_UNAVAILABLE",
      "题目依据的资料已变化，请对照参考答案自评。",
    );
  return parsed.data;
}

export function learningItemRows(value: unknown): LearningItem[] {
  const row = z
    .object({
      itemId: z.string(),
      spaceId: z.string(),
      kind: z.string(),
      prompt: z.string(),
      choices: z.array(z.string()).nullable().optional(),
      answer: z.record(z.string(), z.unknown()),
      explanation: z.string().nullable().optional(),
      citations: z.array(citationSchema),
      origin: z.string(),
      originRef: z.record(z.string(), z.unknown()).nullable().optional(),
      conceptKey: z.string().nullable().optional(),
      hints: z.array(z.string()).nullable().optional(),
      status: z.string(),
      card: z.record(z.string(), z.unknown()).nullable().optional(),
      dueAt: z.string().nullable().optional(),
      version: z.number().int().optional(),
    })
    .passthrough();
  const parsed = z.array(row).safeParse(value);
  if (!parsed.success)
    throw new ApiError(503, "LEARNING_UNAVAILABLE", "学习题目读取结果无效，请稍后重试。");
  return parsed.data as LearningItem[];
}

export async function readLearningItem(supabase: UserSupabase, itemId: string) {
  const { data, error } = await supabase.rpc("list_learning_items", {
    p_space_id: null,
    p_status: null,
    p_limit: 100,
    p_before: null,
  });
  if (error) throw error;
  const item = learningItemRows(data).find((candidate) => candidate.itemId === itemId);
  if (!item) throw new ApiError(404, "LEARNING_ITEM_NOT_FOUND", "学习题目不存在。");
  return item;
}

export function itemForUpsert(item: LearningItem, hints: string[]) {
  if (!item.card || !item.dueAt)
    throw new ApiError(503, "LEARNING_UNAVAILABLE", "学习题目复习状态缺失。");
  return {
    itemId: item.itemId,
    spaceId: item.spaceId,
    kind: item.kind,
    prompt: item.prompt,
    choices: item.choices ?? null,
    answer: item.answer,
    explanation: item.explanation ?? null,
    citations: item.citations,
    origin: item.origin,
    originRef: item.originRef ?? null,
    conceptKey: item.conceptKey ?? null,
    hints,
    status: item.status,
    card: item.card,
    dueAt: item.dueAt,
  };
}
