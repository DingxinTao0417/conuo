import { describe, expect, it } from "vitest";
import { visionStudyResultSchema, type VisionStudyRequest } from "@/lib/vision-region-contract";
import {
  VISION_STUDY_SEMANTICS_VERSION,
  bindVisionStudyResult,
  visionStudyMessages,
} from "@/lib/ai/vision-region";

const request: VisionStudyRequest = {
  requestId: "structured-region-1",
  task: "explain",
  provenance: {
    sourceId: "source-pdf",
    versionId: "version-pdf-1",
    page: 1,
    region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
  },
  image: { dataUrl: "data:image/png;base64,", width: 640, height: 480 },
};

function explanation() {
  return {
    task: "explain",
    summary: "图中箭头表示两个可见节点之间的方向。",
    sections: [
      { kind: "observation", title: "观察", content: "- 左侧节点有一条指向右侧的箭头。" },
      { kind: "takeaway", title: "要点", content: "方向来自可见图示，节点的其他关系并未展示。" },
    ],
  };
}

function publicExplanation() {
  return {
    mode: "vision",
    provenance: request.provenance,
    ...explanation(),
    content:
      "图中箭头表示两个可见节点之间的方向。\n\n## 观察\n\n- 左侧节点有一条指向右侧的箭头。\n\n## 要点\n\n方向来自可见图示，节点的其他关系并未展示。",
  };
}

function invalid(value: unknown) {
  expect(() => bindVisionStudyResult(JSON.stringify(value), request)).toThrowError(
    expect.objectContaining({ code: "INVALID_VISION_RESULT", status: 502 }),
  );
}

describe("structured region explanation", () => {
  it("binds the selected provenance and derives copyable Markdown without requiring reasoning or transcription", () => {
    const result = bindVisionStudyResult(JSON.stringify(explanation()), request);
    expect(result).toEqual(publicExplanation());
    expect(visionStudyResultSchema.safeParse(result).success).toBe(true);
    expect(result).not.toHaveProperty("visibleText");
    expect(result).not.toHaveProperty("reasoning");
  });

  it("preserves Markdown and TeX in summary and sections while escaping plain titles", () => {
    const generated = explanation();
    generated.summary = "比较 $h=0.1$ 的割线与切线。";
    generated.sections[0].title = "斜率 [观察]";
    generated.sections[0].content = "**图中给定：** $f(x)=x^2$。";
    generated.sections.splice(1, 0, {
      kind: "reasoning",
      title: "计算",
      content: "$$\n\\frac{f(2+h)-f(2)}{h}=4+h\n$$",
    });
    const result = bindVisionStudyResult(JSON.stringify(generated), request);
    expect(result.task).toBe("explain");
    if (result.task !== "explain") throw new Error("unexpected task");
    expect(result.content).toContain("## 斜率 \\[观察\\]");
    expect(result.content).toContain(generated.sections[1].content);
    expect(result).toMatchObject({ summary: generated.summary, sections: generated.sections });
  });

  it("requires structure from new model output while keeping the public old plain result readable", () => {
    invalid({ task: "explain", content: "旧模型纯文本解释。" });
    expect(
      visionStudyResultSchema.safeParse({
        mode: "vision",
        task: "explain",
        provenance: request.provenance,
        content: "旧已保存解释。",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["model content", { content: "与分节内容不同。" }],
    ["model provenance", { provenance: { ...request.provenance, page: 2 } }],
    ["model mode", { mode: "vision" }],
    ["unknown root key", { confidence: 95 }],
  ])("rejects %s instead of repairing the generated object", (_label, extra) => {
    invalid({ ...explanation(), ...extra });
  });

  it.each([
    [
      "missing observation",
      [
        { kind: "reasoning", title: "分析", content: "解释。" },
        { kind: "takeaway", title: "要点", content: "总结。" },
      ],
    ],
    [
      "missing takeaway",
      [
        { kind: "observation", title: "观察", content: "可见。" },
        { kind: "reasoning", title: "分析", content: "解释。" },
      ],
    ],
    [
      "unknown section kind",
      [
        { kind: "fact", title: "观察", content: "可见。" },
        { kind: "takeaway", title: "要点", content: "总结。" },
      ],
    ],
    ["too few sections", [explanation().sections[0]]],
    ["too many sections", Array.from({ length: 9 }, (_, i) => explanation().sections[i % 2])],
    [
      "multiline title",
      [{ ...explanation().sections[0], title: "观察\n## 伪标题" }, explanation().sections[1]],
    ],
    ["empty title", [{ ...explanation().sections[0], title: " " }, explanation().sections[1]]],
    [
      "long title",
      [{ ...explanation().sections[0], title: "字".repeat(121) }, explanation().sections[1]],
    ],
    ["empty section", [{ ...explanation().sections[0], content: " " }, explanation().sections[1]]],
    [
      "long section",
      [{ ...explanation().sections[0], content: "字".repeat(4001) }, explanation().sections[1]],
    ],
    [
      "unknown section key",
      [{ ...explanation().sections[0], evidenceIds: ["e1"] }, explanation().sections[1]],
    ],
  ])("rejects %s", (_label, sections) => {
    invalid({ ...explanation(), sections });
  });

  it.each(["", " ", "字".repeat(1201)])("bounds a summary independently of sections", (summary) => {
    invalid({ ...explanation(), summary });
  });

  it("bounds total derived Markdown even when each section is individually valid", () => {
    invalid({
      ...explanation(),
      sections: [
        { kind: "observation", title: "观察", content: "字".repeat(4000) },
        { kind: "reasoning", title: "分析一", content: "字".repeat(4000) },
        { kind: "reasoning", title: "分析二", content: "字".repeat(4000) },
        { kind: "takeaway", title: "要点", content: "字".repeat(4000) },
      ],
    });
  });

  it.each(["summary", "sections"] as const)(
    "requires public structured fields to be paired: absent %s",
    (key) => {
      const value: Record<string, unknown> = publicExplanation();
      delete value[key];
      expect(visionStudyResultSchema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects public content that disagrees with the rendered structured fields", () => {
    expect(visionStudyResultSchema.safeParse(publicExplanation()).success).toBe(true);
    expect(
      visionStudyResultSchema.safeParse({ ...publicExplanation(), content: "篡改的复制内容。" })
        .success,
    ).toBe(false);
  });

  it("keeps ask and quiz fields unchanged and preserves their Markdown and TeX strings", () => {
    const content = "**答案：** $x=2$。\n\n$$\\frac{1}{2}$$";
    expect(
      bindVisionStudyResult(JSON.stringify({ task: "ask", content }), {
        ...request,
        task: "ask",
        question: "图里的值是什么？",
      }),
    ).toMatchObject({ task: "ask", content });
    const questions = [{ question: "求 $x$", answer: "$2$", explanation: "**由图示**得 $x=2$。" }];
    expect(
      bindVisionStudyResult(JSON.stringify({ task: "quiz", questions }), {
        ...request,
        task: "quiz",
      }),
    ).toMatchObject({ task: "quiz", questions });
  });

  it("uses a valid concrete structured example and allows optional reasoning without inventing derivations", () => {
    const system = visionStudyMessages(request)[0].content;
    const example = JSON.parse(
      system.match(/Return ONLY valid JSON matching this exact shape: (.+)/)![1],
    );
    expect(() => bindVisionStudyResult(JSON.stringify(example), request)).not.toThrow();
    expect(example).toHaveProperty("summary");
    expect(example).toHaveProperty("sections");
    expect(example).not.toHaveProperty("content");
    expect(system).toContain("reasoning is optional");
    expect(system).toContain("Do not invent a mathematical derivation");
    expect(system).toContain("Markdown");
    expect(system).toContain("TeX");
    expect(system).toContain("visibleText must remain plain text");
    expect(system).toContain("Do not include HTML, links, images");
  });

  it("isolates the structured output contract from old completed ledger semantics", () => {
    expect(VISION_STUDY_SEMANTICS_VERSION).toBe("vision-region-v5");
  });
});
