// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrimaryLearningContinuation } from "@/lib/learning-continue";
import { createDemoWorkspace } from "@/lib/seed";
import LearningContinuationCard from "./learning-continuation-card";

describe("LearningContinuationCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("shows source, library, reading position and the exact unresolved question together", async () => {
    const data = createDemoWorkspace();
    const source = { ...data.sources[0]!, readPage: 8, pageCount: 24 };
    const conversation = {
      ...data.conversations[0]!,
      id: "pending-thread",
      sourceId: source.id,
      sourceIds: [source.id],
      title: "为什么学习率太大会震荡？",
      resolved: false,
    };
    const continuation: PrimaryLearningContinuation = {
      source,
      spaceId: data.spaces[0]!.id,
      spaceName: "机器学习基础",
      conversation,
    };
    const onContinue = vi.fn();
    await act(async () => {
      root.render(
        createElement(LearningContinuationCard, {
          continuation,
          icon: createElement("span", null, "PDF"),
          onContinue,
        }),
      );
    });

    expect(host.textContent).toContain(source.title);
    expect(host.textContent).toContain("机器学习基础");
    expect(host.textContent).toContain("第 8 / 24 页");
    expect(host.textContent).toContain("最近留下的问题");
    expect(host.textContent).toContain("为什么学习率太大会震荡？");
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.replace(/\s+/gu, "").trim() === "继续讨论",
    )!;
    await act(async () => button.click());
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("falls back to reading from the saved text position when no question is resumable", async () => {
    const data = createDemoWorkspace();
    const continuation: PrimaryLearningContinuation = {
      source: { ...data.sources[0]!, pageCount: undefined, readPage: undefined, readOffset: 720 },
      spaceId: "inbox",
      spaceName: "收件箱",
    };
    await act(async () => {
      root.render(
        createElement(LearningContinuationCard, {
          continuation,
          icon: null,
          onContinue: vi.fn(),
        }),
      );
    });

    expect(host.textContent).toContain("收件箱");
    expect(host.textContent).toContain("上次读到正文");
    expect(host.textContent).toContain("继续阅读");
    expect(host.textContent).not.toContain("最近留下的问题");
  });
});
