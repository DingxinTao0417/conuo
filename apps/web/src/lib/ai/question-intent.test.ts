import { describe, expect, it } from "vitest";
import { classifyQuestionIntent } from "./question-intent";

describe("question intent classification", () => {
  it.each([
    ["为什么学习率过高会震荡", "targeted"],
    ["请解释其中最重要的概念", "targeted"],
    ["举例说明梯度下降", "targeted"],
    ["为什么学习率比较大时会震荡", "targeted"],
    ["这份资料的核心观点是什么？", "summary"],
    ["总结第三章", "summary"],
    ["Summarize this paper", "summary"],
    ["比较两份资料对学习率的看法", "comparison"],
    ["总结两份资料的异同", "comparison"],
    ["What is the difference between A and B?", "comparison"],
  ] as const)("classifies %s as %s", (question, expected) => {
    expect(classifyQuestionIntent(question)).toBe(expected);
  });
});
