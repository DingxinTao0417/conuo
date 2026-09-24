import { z } from "zod";
import { GROUNDING_CONTRACT_VERSION } from "@/lib/ai/grounding";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const feedbackSchema = z
  .object({
    requestId: id,
    conversationId: id.optional(),
    messageId: id.optional(),
    rating: z.enum(["up", "down"]),
    reasons: z
      .array(
        z.enum([
          "wrong_citation",
          "not_answered",
          "incorrect",
          "incomplete",
          "format",
          "too_long",
          "grading_wrong",
          "other",
        ]),
      )
      .max(8)
      .default([]),
    comment: z.string().trim().max(500).optional(),
    includeContent: z.boolean().default(false),
    question: z.string().max(4000).optional(),
    answer: z.string().max(50_000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.includeContent
        ? Boolean(value.question && value.answer)
        : !value.question && !value.answer,
    { message: "Content inclusion does not match the checkbox" },
  );

const responseSchema = z.object({ requestId: id }).strict();

function feedbackUnavailable(): never {
  throw new ApiError(503, "FEEDBACK_UNAVAILABLE", "反馈暂时无法保存，请稍后重试。");
}

export async function POST(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const parsed = feedbackSchema.safeParse(await readJson(request, 70_000));
    if (!parsed.success) throw new ApiError(400, "INVALID_FEEDBACK", "反馈内容无效。");
    const { data, error } = await supabase.rpc("submit_answer_feedback", {
      p_feedback: { ...parsed.data, contractVersion: GROUNDING_CONTRACT_VERSION },
    });
    if (error) feedbackUnavailable();
    const result = responseSchema.safeParse(data);
    if (!result.success) feedbackUnavailable();
    return json(result.data);
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const requestId = new URL(request.url).searchParams.get("requestId");
    if (!requestId || !id.safeParse(requestId).success)
      throw new ApiError(400, "INVALID_FEEDBACK", "反馈内容无效。");
    const { data, error } = await supabase.rpc("withdraw_answer_feedback", {
      p_request_id: requestId,
    });
    if (error) feedbackUnavailable();
    const result = responseSchema.safeParse(data);
    if (!result.success) feedbackUnavailable();
    return json(result.data);
  } catch (error) {
    return failure(error);
  }
}
