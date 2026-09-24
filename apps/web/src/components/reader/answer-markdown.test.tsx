// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnswerMarkdown } from "./answer-markdown";

describe("AnswerMarkdown", () => {
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

  async function render(content: string) {
    await act(async () =>
      root.render(
        createElement(AnswerMarkdown, {
          content,
          citations: [
            {
              sourceId: "source-1",
              versionId: "version-1",
              chunkId: "chunk-1",
              title: "资料一",
              quote: "原文",
              section: "第一节",
            },
          ],
          noteEvidence: [],
          mode: "model",
          messageId: "message-1",
          expandedCitationIndex: null,
          expandedNoteEvidenceIndex: null,
          citationIssues: [null],
          noteEvidenceIssues: [],
          onCitationToggle: vi.fn(),
          onNoteEvidenceToggle: vi.fn(),
        }),
      ),
    );
  }

  it("renders formulas and keeps tables in the answer container", async () => {
    await render("设 $$x^2$$。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(host.querySelectorAll(".katex")).toHaveLength(1);
    expect(host.querySelector("table")).toBeTruthy();
  });

  it("does not render legacy single dollar prices as formulas", async () => {
    await render("价格是 $5 和 $10");
    expect(host.querySelector(".katex")).toBeNull();
    expect(host.textContent).toContain("价格是 $5 和 $10");
  });

  it("does not turn bracket indexes inside formulas into citation buttons", async () => {
    await render("$$a[1]$$\n\n[1]");
    expect(host.querySelector(".katex")).toBeTruthy();
    expect(host.querySelectorAll(".reader-inline-citation")).toHaveLength(1);
  });
});
