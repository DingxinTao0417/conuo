import { describe, expect, it } from "vitest";
import { createDemoWorkspace } from "./seed";
import {
  sourceAiStatus,
  sourceKindLabel,
  sourceOriginLabel,
  sourceReadingStatus,
  sourceTimestampLabel,
} from "./source-metadata";

describe("source metadata labels", () => {
  it("keeps file origin, reading progress, and AI readiness distinct", () => {
    const source = createDemoWorkspace().sources[0]!;
    source.kind = "pdf";
    source.pageCount = 12;
    source.readPage = 4;
    source.lastReadAt = "2026-09-13T12:00:00.000Z";
    source.aiAllowed = true;
    source.status = "ready";

    expect(sourceKindLabel(source)).toBe("PDF");
    expect(sourceOriginLabel(source)).toBe("本机文件上传");
    expect(sourceReadingStatus(source)).toBe("上次读到第 4 / 12 页");
    expect(sourceAiStatus(source)).toBe("已允许，可用于问答与整理");

    source.aiAllowed = false;
    expect(sourceAiStatus(source)).toBe("未允许 AI 使用");
  });

  it("describes partial, pending, and unavailable AI states without overstating them", () => {
    const source = createDemoWorkspace().sources[0]!;
    source.aiAllowed = true;

    source.status = "partial";
    expect(sourceAiStatus(source)).toBe("已允许，可使用已识别部分");
    source.status = "parsing";
    expect(sourceAiStatus(source)).toBe("已允许，等待正文处理完成");
    source.status = "failed";
    expect(sourceAiStatus(source)).toBe("已允许，但当前没有可用正文");
  });

  it("labels saved web capture scope and malformed timestamps safely", () => {
    const source = createDemoWorkspace().sources[0]!;
    source.kind = "web";
    source.webSnapshot = {
      originalUrl: "https://example.com/article",
      finalUrl: "https://example.com/article",
      capturedAt: "2026-09-13T12:00:00.000Z",
      method: "manual",
      scope: "pasted",
      warnings: [],
    };

    expect(sourceOriginLabel(source)).toBe("手动粘贴的网页正文");
    expect(sourceTimestampLabel("not-a-date")).toBe("时间未知");
    expect(sourceTimestampLabel("2026-09-13T12:00:00.000Z")).toContain("2026");
  });
});
