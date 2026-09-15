import { describe, expect, it } from "vitest";
import {
  isParserCoverageIncomplete,
  sourceCaptureScopeNotice,
  sourceCoverageLabel,
  sourceCoverageNotices,
  sourceCoverageOf,
  sourcePresentationStatus,
  sourceParserCoverageNotice,
} from "./source-coverage";
import type { Source } from "./types";

type CoverageInput = Pick<
  Source,
  "kind" | "status" | "coverage" | "webSnapshot" | "pageCount" | "parsedPages"
>;

function webSnapshot(scope: NonNullable<Source["webSnapshot"]>["scope"]): Source["webSnapshot"] {
  return {
    originalUrl: "https://example.test/article",
    finalUrl: "https://example.test/article",
    capturedAt: "2026-09-13T12:00:00.000Z",
    method: scope === "pasted" || scope === "link" ? "manual" : "server",
    scope,
    warnings: [],
  };
}

describe("source coverage semantics", () => {
  it("treats a legacy selected web excerpt as complete retained text, not a parser gap", () => {
    const legacySelection: CoverageInput = {
      kind: "web",
      status: "partial",
      webSnapshot: webSnapshot("selection"),
    };

    expect(sourceCoverageOf(legacySelection)).toEqual({
      captureScope: "selection",
      parseState: "complete",
    });
    expect(isParserCoverageIncomplete(legacySelection)).toBe(false);
    expect(sourceParserCoverageNotice(legacySelection)).toBe("");
    expect(sourceCaptureScopeNotice(legacySelection)).toContain("不代表整篇网页");
    expect(sourceCoverageLabel(legacySelection)).toBe("仅保存选段");
    expect(sourcePresentationStatus(legacySelection)).toBe("ready");
    expect(sourceCoverageNotices([legacySelection])).toEqual([
      "范围说明：其中的网页仅保存了用户选取的片段；回答只依据已保存片段，不代表整篇网页。",
    ]);
  });

  it("reports real partial parsing separately and preserves unavailable page ranges", () => {
    const partialPdf: CoverageInput = {
      kind: "pdf",
      status: "partial",
      pageCount: 9,
      parsedPages: 6,
      coverage: {
        captureScope: "full",
        parseState: "partial",
        unavailablePageRanges: [
          { start: 2, end: 3 },
          { start: 8, end: 8 },
        ],
      },
    };

    expect(isParserCoverageIncomplete(partialPdf)).toBe(true);
    expect(sourceCaptureScopeNotice(partialPdf)).toBe("");
    expect(sourceParserCoverageNotice(partialPdf)).toContain("第 2–3、8 页未能解析");
    expect(sourceCoverageLabel(partialPdf)).toBe("部分内容已解析");
    expect(sourceCoverageNotices([partialPdf])).toContain(
      "部分原文件内容未能解析；回答只依据已提取文字。",
    );
  });

  it("labels manual text, link-only records, and pending parsing with their own notices", () => {
    const manual: CoverageInput = {
      kind: "web",
      status: "ready",
      coverage: { captureScope: "manual", parseState: "complete" },
      webSnapshot: webSnapshot("pasted"),
    };
    const link: CoverageInput = {
      kind: "web",
      status: "link-only",
      coverage: { captureScope: "link", parseState: "not-requested" },
      webSnapshot: webSnapshot("link"),
    };
    const pending: CoverageInput = {
      kind: "pdf",
      status: "parsing",
      coverage: { captureScope: "full", parseState: "pending" },
    };

    expect(sourceCoverageLabel(manual)).toBe("手动保存内容");
    expect(sourceCaptureScopeNotice(manual)).toContain("手动粘贴");
    expect(sourceCoverageLabel(link)).toBe("仅保存链接");
    expect(sourceCaptureScopeNotice(link)).toContain("未保存可检索正文");
    expect(sourceCoverageLabel(pending)).toBe("等待解析");
    expect(sourceParserCoverageNotice(pending)).toContain("仍在解析");
    expect(isParserCoverageIncomplete(pending)).toBe(false);
    expect(sourceCoverageNotices([manual, link, pending])).toEqual([
      "范围说明：其中的网页由手动粘贴内容建立；回答只依据已保存文字。",
      "其中有仅保存链接的资料，未作为正文证据使用。",
      "有资料仍在解析，未作为正文证据使用。",
    ]);
  });
});
