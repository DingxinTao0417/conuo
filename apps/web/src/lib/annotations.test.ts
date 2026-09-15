import { describe, expect, it } from "vitest";
import { createAnnotation, removeAnnotation, updateAnnotation } from "./annotations";
import type { Source } from "./types";

type AnnotationInput = Parameters<typeof createAnnotation>[0];

const source: Source = {
  id: "source-a",
  versionId: "version-a",
  title: "学习资料",
  filename: "learning.txt",
  kind: "text",
  mime: "text/plain",
  size: 20,
  hash: "a".repeat(64),
  spaceIds: ["space-a"],
  tags: [],
  status: "ready",
  text: "前言\n学习 率\n决定每次更新的步长。\n结尾",
  chunks: [],
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
  deletedAt: null,
  aiAllowed: true,
  starred: false,
  pageCount: 2,
};

function input(overrides: Partial<AnnotationInput> = {}): AnnotationInput {
  return {
    id: "annotation-a",
    sourceId: source.id,
    versionId: source.versionId,
    quote: "学习率\n决定每次更新的步长。",
    note: "第一次理解",
    page: 1,
    createdAt: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("version-bound annotation lifecycle", () => {
  it("accepts whole non-BMP characters but rejects either half of a surrogate pair", () => {
    const target = { ...source, text: "前😀后" };
    expect(
      createAnnotation(
        { ...input({ quote: "😀", page: undefined }), textAnchor: { start: 1, end: 3 } },
        target,
      ).textAnchor,
    ).toEqual({ start: 1, end: 3 });
    for (const textAnchor of [
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]) {
      const quote = target.text.slice(textAnchor.start, textAnchor.end);
      expect(() =>
        createAnnotation({ ...input({ quote, page: undefined }), textAnchor }, target),
      ).toThrow("原文位置");
    }
  });

  it("keeps an exact UTF16 anchor to the second occurrence through note edits", () => {
    const text = "😀 目标\n目标";
    const target = { ...source, text };
    const anchored = {
      ...input({ quote: "目标", page: undefined }),
      textAnchor: { start: text.lastIndexOf("目标"), end: text.length },
    };
    const saved = createAnnotation(anchored, target);
    expect(saved).toMatchObject({ quote: "目标", textAnchor: anchored.textAnchor });
    expect(updateAnnotation(saved, "第二处的理解", target)).toEqual({
      ...saved,
      note: "第二处的理解",
    });
  });

  it("preserves anchored whitespace and CRLF byte-for-byte instead of normalizing quote", () => {
    const text = "前\n 学习率\r\n 后";
    const quote = " 学习率\r\n ";
    const anchored = {
      ...input({ quote }),
      textAnchor: { start: text.indexOf(quote), end: text.indexOf(quote) + quote.length },
    };
    expect(createAnnotation(anchored, { ...source, text })).toMatchObject({
      quote,
      textAnchor: anchored.textAnchor,
    });
  });

  it.each([
    { start: -1, end: 2 },
    { start: 0.5, end: 2 },
    { start: 2, end: 2 },
    { start: 0, end: 99 },
    { start: 0, end: 2 },
  ])("rejects forged ranges even when the same quote exists elsewhere: %j", (textAnchor) => {
    const anchored = { ...input({ quote: "目标" }), textAnchor };
    expect(() => createAnnotation(anchored, { ...source, text: "前言目标" })).toThrow("原文位置");
  });

  it("rejects anchor drift for edits and removes only the reviewed anchored identity", () => {
    const text = "目标\n目标";
    const target = { ...source, text };
    const saved = createAnnotation(
      { ...input({ quote: "目标" }), textAnchor: { start: 3, end: 5 } },
      target,
    );
    const moved = { ...saved, textAnchor: { start: 0, end: 2 } };
    expect(() => removeAnnotation([saved], moved, target)).toThrow("已变化");
    expect(() =>
      updateAnnotation(saved, "不可错误套用", { ...target, text: "目标\n变化" }),
    ).toThrow("原文位置");
    expect(removeAnnotation([saved], saved, target)).toEqual([]);
  });

  it("creates a bounded annotation after checking its exact source version", () => {
    const annotation = createAnnotation(input(), source);
    expect(annotation).toEqual({
      ...input(),
      quote: "学习率\n决定每次更新的步长。",
    });
  });

  it("does not accept a different source/version, a missing selection, or an invalid page", () => {
    expect(() => createAnnotation(input({ sourceId: "source-b" }), source)).toThrow(
      "不属于当前资料版本",
    );
    expect(() => createAnnotation(input({ versionId: "version-b" }), source)).toThrow(
      "不属于当前资料版本",
    );
    expect(() => createAnnotation(input({ quote: "不存在的选段" }), source)).toThrow(
      "不属于当前资料版本",
    );
    expect(() => createAnnotation(input({ page: 3 }), source)).toThrow("页码无效");
    expect(() => createAnnotation(input({ quote: "   " }), source)).toThrow("请先选择");
  });

  it("edits only the note and leaves source/version/quote identity unchanged", () => {
    const saved = createAnnotation(input(), source);
    const updated = updateAnnotation(saved, "补充：需要看推导。", source);
    expect(updated).toEqual({ ...saved, note: "补充：需要看推导。" });
    expect(saved.note).toBe("第一次理解");
  });

  it("removes only the exact current annotation and fails closed after deletion or identity drift", () => {
    const saved = createAnnotation(input(), source);
    const other = createAnnotation(
      input({ id: "annotation-b", quote: "前言", page: undefined }),
      source,
    );
    expect(removeAnnotation([saved, other], saved, source)).toEqual([other]);
    expect(() => removeAnnotation([saved], { ...saved, quote: "前言" }, source)).toThrow("已变化");
    expect(() =>
      removeAnnotation([saved], saved, { ...source, deletedAt: "2026-09-13T00:00:00.000Z" }),
    ).toThrow("已删除");
  });
});
