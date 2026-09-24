// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfCaptureResult } from "./pdf-capture";
import type { VisionStudyResult } from "@/lib/vision-region-contract";

const mock = vi.hoisted(() => ({
  availability: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@/lib/vision-region-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vision-region-client")>()),
  getVisionRegionAvailability: mock.availability,
  requestVisionRegionStudy: mock.request,
}));

import RegionStudyPanel from "./region-study-panel";

const capture: PdfCaptureResult = {
  identity: { sourceId: "source-one", versionId: "version-one", page: 7 },
  region: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
  pixelRegion: { x: 20, y: 40, width: 640, height: 480 },
  blob: new Blob(["region"], { type: "image/jpeg" }),
  mimeType: "image/jpeg",
  width: 640,
  height: 480,
  bytes: 6,
};

const quizResult: VisionStudyResult = {
  mode: "vision",
  task: "quiz",
  provenance: {
    sourceId: "source-one",
    versionId: "version-one",
    page: 7,
    region: capture.region,
  },
  questions: [{ question: "图中极限是多少？", answer: "1", explanation: "使用等价无穷小。" }],
};

describe("RegionStudyPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  let onRecapture: ReturnType<typeof vi.fn<() => void>>;
  let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "request-one") });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:region-preview"),
      revokeObjectURL: vi.fn(),
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    mock.availability.mockReset();
    mock.request.mockReset();
    fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    mock.availability.mockResolvedValue({ available: true, message: "多模态模型已就绪。" });
    onClose = vi.fn<() => void>();
    onRecapture = vi.fn<() => void>();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => {
      root.render(
        createElement(RegionStudyPanel, {
          capture,
          sourceTitle: "高等数学",
          spaceId: "space-one",
          expectedUserId: "account-one",
          onClose,
          onRecapture,
        }),
      );
    });
    await act(async () => undefined);
  }

  function button(text: string) {
    const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes(text),
    );
    expect(result, text).toBeTruthy();
    return result!;
  }

  async function click(target: HTMLButtonElement) {
    await act(async () => target.click());
  }

  function enterTextarea(value: string) {
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("checks readiness without uploading the preview and sends only after an explicit action", async () => {
    const result: VisionStudyResult = {
      mode: "vision",
      task: "explain",
      provenance: {
        sourceId: "source-one",
        versionId: "version-one",
        page: 7,
        region: capture.region,
      },
      visibleText: "lim x → 0",
      content: "这是一个关于极限的推导。",
    };
    mock.request.mockResolvedValue(result);
    await render();

    expect(mock.availability).toHaveBeenCalledWith("account-one", expect.any(AbortSignal));
    expect(mock.request).not.toHaveBeenCalled();
    expect(host.textContent).toContain("点击发送后只临时上传当前截图");
    expect(host.textContent).toContain("高等数学 · 第 7 页 · 640 × 480px");

    await click(button("开始解读"));

    expect(mock.request).toHaveBeenCalledWith(
      expect.objectContaining({ capture, task: "explain", requestId: "request-one" }),
      "account-one",
      expect.any(AbortSignal),
    );
    expect(host.textContent).toContain("这是一个关于极限的推导。");
    expect(host.textContent).toContain("模型看到的区域文字（可选转写）");
    expect(host.textContent).toContain("lim x → 0");
    expect(host.textContent).toContain("请结合原图核对");
  });

  it("does not render the iPad-only grade_work result in the Web panel", async () => {
    mock.request.mockResolvedValue({
      mode: "vision",
      task: "grade_work",
      provenance: {
        sourceId: "source-one",
        versionId: "version-one",
        page: 7,
        region: capture.region,
      },
      problem: "解方程 2x + 1 = 5。",
      steps: [{ index: 1, transcription: "2x + 1 = 5", verdict: "ok", comment: "抄写正确。" }],
      firstErrorStep: null,
      overall: "correct",
      hint: "继续检查下一步。",
    } satisfies VisionStudyResult);
    await render();
    await click(button("开始解读"));

    expect(host.querySelector(".region-study-result")).toBeNull();
    expect(host.textContent).toContain("手写批改仅支持 iPad 区域学习");
  });

  it("keeps links, images and HTML inactive while rendering Markdown", async () => {
    const content =
      "请核对 ![remote](https://tracker.invalid/pixel) [外部链接](https://tracker.invalid) <script>alert(1)</script>";
    mock.request.mockResolvedValue({
      mode: "vision",
      task: "explain",
      provenance: {
        sourceId: "source-one",
        versionId: "version-one",
        page: 7,
        region: capture.region,
      },
      content,
    } satisfies VisionStudyResult);
    await render();

    await click(button("开始解读"));

    const result = host.querySelector(".region-study-result")!;
    expect(result.textContent).toContain("请核对");
    expect(result.textContent).toContain("外部链接");
    expect(result.querySelector("a")).toBeNull();
    expect(result.querySelector("img")).toBeNull();
    expect(result.querySelector("script")).toBeNull();
  });

  it("renders structured explanations with separate sections and copies the complete Markdown", async () => {
    const summary = "理解**导数与切线**的关系。";
    const sections = [
      {
        kind: "observation" as const,
        title: "图中内容",
        content: "- 曲线 $y = x^2$\n- 切点 P(2, 4)",
      },
      {
        kind: "reasoning" as const,
        title: "求出切线",
        content: "1. 求导得到 $f'(2)=4$。\n2. 代入点斜式。\n\n$$\ny = 4x - 4\n$$",
      },
      {
        kind: "takeaway" as const,
        title: "记住这两点",
        content: "**斜率与纵坐标含义不同。**\n\n先化简，再取极限。",
      },
    ];
    const content =
      summary +
      "\n\n## 图中内容\n\n- 曲线 $y = x^2$\n- 切点 P(2, 4)\n\n## 求出切线\n\n1. 求导得到 $f'(2)=4$。\n2. 代入点斜式。\n\n$$\ny = 4x - 4\n$$\n\n## 记住这两点\n\n**斜率与纵坐标含义不同。**\n\n先化简，再取极限。";
    mock.request.mockResolvedValue({
      mode: "vision",
      task: "explain",
      provenance: {
        sourceId: "source-one",
        versionId: "version-one",
        page: 7,
        region: capture.region,
      },
      summary,
      sections,
      content,
    } satisfies VisionStudyResult);
    await render();
    await click(button("开始解读"));

    expect(host.querySelectorAll(".region-study-section")).toHaveLength(3);
    expect(
      [...host.querySelectorAll(".region-study-explanation h4")].map((item) => item.textContent),
    ).toEqual(["内容概览", "图中内容", "求出切线", "记住这两点"]);
    expect(host.querySelectorAll(".region-study-section-observation ul > li")).toHaveLength(2);
    expect(host.querySelectorAll(".region-study-section-reasoning ol > li")).toHaveLength(2);
    expect(host.querySelectorAll(".region-study-section-reasoning .katex-display")).toHaveLength(1);
    expect(host.querySelector(".region-study-summary strong")?.textContent).toBe("导数与切线");
    expect(host.querySelector(".region-study-section-takeaway strong")?.textContent).toBe(
      "斜率与纵坐标含义不同。",
    );
    await click(button("复制"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(content);
  });

  it("renders legacy explanation content without fabricating structured sections", async () => {
    mock.request.mockResolvedValue({
      mode: "vision",
      task: "explain",
      provenance: {
        sourceId: "source-one",
        versionId: "version-one",
        page: 7,
        region: capture.region,
      },
      content: "历史解读。\n\n1. 观察图形。\n2. 核对数值。",
    } satisfies VisionStudyResult);
    await render();
    await click(button("开始解读"));
    expect(host.querySelector(".region-study-explanation")).toBeNull();
    expect(host.querySelectorAll(".region-study-markdown ol > li")).toHaveLength(2);
    expect(host.textContent).toContain("历史解读。");
  });

  it("renders exercise formulas while keeping the answer hidden until requested", async () => {
    mock.request.mockResolvedValue({
      mode: "vision",
      task: "quiz",
      provenance: {
        sourceId: "source-one",
        versionId: "version-one",
        page: 7,
        region: capture.region,
      },
      questions: [{ question: "求 $f'(2)$。", answer: "$4$", explanation: "由 $f'(x)=2x$ 得到。" }],
    } satisfies VisionStudyResult);
    await render();
    await click(button("出题"));
    await click(host.querySelector<HTMLButtonElement>(".region-study-run")!);
    expect(host.querySelectorAll(".region-study-quiz .katex")).toHaveLength(1);
    expect(host.querySelector(".region-study-quiz-answer")).toBeNull();
    await click(button("查看答案"));
    expect(host.querySelectorAll(".region-study-quiz .katex")).toHaveLength(3);
    await click(button("收起答案"));
    expect(host.querySelectorAll(".region-study-quiz .katex")).toHaveLength(1);
  });

  it("requires a learner question before sending the selected image", async () => {
    mock.request.mockResolvedValue({
      mode: "vision",
      task: "ask",
      provenance: {
        sourceId: "source-one",
        versionId: "version-one",
        page: 7,
        region: capture.region,
      },
      content: "因为分母同时乘了同一个非零量。",
    } satisfies VisionStudyResult);
    await render();
    await click(button("提问"));
    expect(button("发送问题").disabled).toBe(true);

    await act(async () => enterTextarea("为什么这里可以约分？"));
    expect(button("发送问题").disabled).toBe(false);
    await click(button("发送问题"));

    expect(mock.request).toHaveBeenCalledWith(
      expect.objectContaining({ task: "ask", question: "为什么这里可以约分？" }),
      "account-one",
      expect.any(AbortSignal),
    );
    expect(host.textContent).toContain("因为分母同时乘了同一个非零量。");
  });

  it("reveals generated exercise answers on demand", async () => {
    mock.request.mockResolvedValue({
      mode: "vision",
      task: "quiz",
      provenance: {
        sourceId: "source-one",
        versionId: "version-one",
        page: 7,
        region: capture.region,
      },
      questions: [{ question: "图中极限是多少？", answer: "1", explanation: "使用等价无穷小。" }],
    } satisfies VisionStudyResult);
    await render();
    await click(button("出题"));
    await click(host.querySelector<HTMLButtonElement>(".region-study-run")!);

    expect(host.textContent).toContain("图中极限是多少？");
    expect(host.textContent).not.toContain("使用等价无穷小。");
    await click(button("查看答案"));
    expect(host.textContent).toContain("答案：1");
    expect(host.textContent).toContain("解析：使用等价无穷小。");
  });

  it("passes same-region history on a follow-up question", async () => {
    mock.request
      .mockResolvedValueOnce({
        mode: "vision",
        task: "ask",
        provenance: {
          sourceId: "source-one",
          versionId: "version-one",
          page: 7,
          region: capture.region,
        },
        content: "第一次回答。",
      } satisfies VisionStudyResult)
      .mockResolvedValueOnce({
        mode: "vision",
        task: "ask",
        provenance: {
          sourceId: "source-one",
          versionId: "version-one",
          page: 7,
          region: capture.region,
        },
        content: "第二次回答。",
      } satisfies VisionStudyResult);
    await render();
    await click(button("提问"));
    await act(async () => enterTextarea("第一问"));
    await click(button("发送问题"));
    await act(async () => enterTextarea("第二问"));
    await click(button("发送问题"));
    expect(mock.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ history: [{ question: "第一问", answer: "第一次回答。" }] }),
      "account-one",
      expect.any(AbortSignal),
    );
  });

  it("saves a selected visual exercise into learning with region provenance", async () => {
    mock.request.mockResolvedValue(quizResult);
    await render();
    await click(button("出题"));
    await click(host.querySelector<HTMLButtonElement>(".region-study-run")!);
    await click(button("加入复习"));
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/learning/items",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      spaceId: "space-one",
      kind: "short",
      prompt: "图中极限是多少？",
      answer: { text: "1" },
      explanation: "使用等价无穷小。",
      citations: [],
      origin: "region",
      originRef: {
        sourceId: "source-one",
        versionId: "version-one",
        page: 7,
        rect: capture.region,
      },
    });
  });

  it("does not offer image submission when the vision service is unavailable", async () => {
    mock.availability.mockResolvedValue({
      available: false,
      message: "尚未启用多模态模型。",
    });
    await render();

    expect(button("开始解读").disabled).toBe(true);
    expect(host.textContent).toContain("尚未启用多模态模型。");
    expect(mock.request).not.toHaveBeenCalled();
  });

  it("revokes the local preview and can return to region selection", async () => {
    await render();
    await click(button("重新框选"));
    expect(onRecapture).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:region-preview");
    root = createRoot(host);
  });
});
