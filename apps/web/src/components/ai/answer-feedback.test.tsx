// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/types";

const mock = vi.hoisted(() => ({ submit: vi.fn(), withdraw: vi.fn() }));
vi.mock("@/lib/cloud", () => ({
  submitAnswerFeedback: mock.submit,
  withdrawAnswerFeedback: mock.withdraw,
}));

import AnswerFeedback from "./answer-feedback";

const message: Message = {
  id: "message-a",
  role: "assistant",
  content: "回答内容",
  citations: [],
  createdAt: "2026-09-23T00:00:00.000Z",
  attempt: {
    id: "request-a",
    questionMessageId: "question-a",
    scopeSnapshot: { scope: "document", spaceId: "space-a", sourceIds: [], sourceVersions: [] },
    status: "completed",
  },
};

describe("AnswerFeedback", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubEnv("NEXT_PUBLIC_CONUO_FEATURE_ANSWER_FEEDBACK", "on");
    mock.submit.mockReset().mockResolvedValue({ requestId: "request-a" });
    mock.withdraw.mockReset().mockResolvedValue({ requestId: "request-a" });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllEnvs();
  });

  async function render(value = message) {
    await act(async () =>
      root.render(
        createElement(AnswerFeedback, {
          message: value,
          expectedUserId: "owner-a",
          question: "问题",
        }),
      ),
    );
  }

  it("hides feedback for incomplete answers", async () => {
    await render({ ...message, attempt: { ...message.attempt!, status: "failed" } });
    expect(host.textContent).toBe("");
  });

  it("expands a down rating, submits selected reasons, and can withdraw it", async () => {
    await render();
    expect(host.querySelector('[aria-label="这条回答有帮助"]')).not.toBeNull();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="这条回答没帮助"]')!.click(),
    );
    expect(host.textContent).toContain("引用不支持");
    await act(async () => host.querySelector<HTMLLabelElement>("label")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>("button[type=submit]")!.click());
    expect(mock.submit).toHaveBeenCalledWith(
      expect.objectContaining({ rating: "down", reasons: ["wrong_citation"] }),
      "owner-a",
    );
    expect(mock.submit.mock.calls[0]?.[0]).not.toHaveProperty("question");
    expect(mock.submit.mock.calls[0]?.[0]).not.toHaveProperty("answer");
    expect(host.textContent).toContain("已收到反馈");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(mock.withdraw).toHaveBeenCalledWith("request-a", "owner-a");
  });
});
