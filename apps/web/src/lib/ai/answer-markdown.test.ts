import { describe, expect, it } from "vitest";
import { escapePlainAnswerText, sanitizeAnswerMarkdown } from "./answer-markdown";

describe("answer Markdown sanitizer", () => {
  it("preserves the supported Markdown subset", () => {
    const answer = sanitizeAnswerMarkdown(
      "**重点**、*说明*、`x > 0`。\n\n- 一\n- 二\n\n```ts\nconst x = 1;\n```\n\n| 条件 | 结论 |\n| --- | --- |\n| x | y |",
    );
    expect(answer).toContain("**重点**");
    expect(answer).toContain("*说明*");
    expect(answer).toContain("`x > 0`");
    expect(answer).toContain("- 一");
    expect(answer).toContain("```ts");
    expect(answer).toContain("| 条件 | 结论 |");
  });

  it("rewrites inline math into display math delimiters", () => {
    const answer = sanitizeAnswerMarkdown("设 $x^2$ 为平方");
    expect(answer).toContain("$$x^2$$");
    expect(answer).not.toMatch(/(?<!\$)\$(?!\$)/u);
  });

  it("keeps code delimiters and bracket indexes literal", () => {
    const answer = sanitizeAnswerMarkdown("代码 `$HOME` 与 `a[1]` 保持不变");
    expect(answer).toContain("`$HOME`");
    expect(answer).toContain("`a[1]`");
    expect(sanitizeAnswerMarkdown("正文数组 a[1]")).toContain("a［1］");
  });

  it.each([
    "# 标题",
    "[外链](https://example.invalid)",
    "![图片](https://example.invalid/image)",
    "<script>alert(1)</script>",
    "> 引用块",
  ])("falls back to escaped plain text for forbidden syntax: %s", (value) => {
    const answer = sanitizeAnswerMarkdown(value);
    expect(answer).toBe(escapePlainAnswerText(value));
  });

  it("falls back when a server citation marker is present", () => {
    expect(sanitizeAnswerMarkdown("已有 [[conuo-citation:1]]")).toBe(
      escapePlainAnswerText("已有 [[conuo-citation:1]]"),
    );
  });
});
