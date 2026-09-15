import { describe, expect, it } from "vitest";
import type { Citation, Source, SourceVersion } from "@/lib/types";
import { citationProblem, quoteOffsets } from "./reader-utils";

const source: Source = {
  id: "source-a",
  versionId: "version-1",
  title: "学习资料",
  filename: "学习资料.txt",
  kind: "text",
  mime: "text/plain",
  size: 100,
  hash: "content-hash",
  spaceIds: ["space-a"],
  tags: [],
  status: "ready",
  text: "梯度下降通过迭代更新参数。 学习率决定每次更新的步长。",
  chunks: [
    {
      id: "chunk-1",
      sourceId: "source-a",
      versionId: "version-1",
      text: "梯度下降通过迭代更新参数。",
      section: "引言",
      order: 0,
    },
  ],
  createdAt: "2026-09-12T00:00:00Z",
  updatedAt: "2026-09-12T00:00:00Z",
  deletedAt: null,
  aiAllowed: true,
  starred: false,
};
const citation: Citation = {
  sourceId: "source-a",
  versionId: "version-1",
  chunkId: "chunk-1",
  title: "学习资料",
  quote: "梯度下降通过迭代更新参数。",
  section: "引言",
};

describe("immutable citation opening", () => {
  it("opens a citation only against its accessible exact source version", () => {
    expect(citationProblem(citation, [source])).toBeNull();
    expect(citationProblem(citation, [])).toContain("不可访问");
    expect(citationProblem(citation, [{ ...source, deletedAt: "2026-09-13T00:00:00Z" }])).toContain(
      "已删除",
    );
    expect(citationProblem(citation, [{ ...source, versionId: "version-2" }])).toContain("旧版本");
  });
  it("does not silently rebind missing chunks or fabricated quotations", () => {
    expect(citationProblem({ ...citation, chunkId: "gone" }, [source])).toContain("片段当前不可用");
    expect(citationProblem({ ...citation, quote: "资料里不存在的结论。" }, [source])).toContain(
      "未在保存的这个版本",
    );
    expect(
      citationProblem(citation, [
        { ...source, chunks: [{ ...source.chunks[0], sourceId: "another-source" }] },
      ]),
    ).toContain("片段当前不可用");
  });
  it("opens the retained exact version while enforcing the current source's availability", () => {
    const version: SourceVersion = { ...source, archivedAt: "2026-09-13T00:00:00Z" };
    const refreshed: Source = {
      ...source,
      versionId: "version-2",
      text: "新版已经修改了这个结论。",
      chunks: [],
      versions: [version],
    };
    expect(citationProblem(citation, [refreshed])).toBeNull();
    expect(citationProblem(citation, [{ ...refreshed, aiAllowed: false }])).toBeNull();
    expect(
      citationProblem(citation, [{ ...refreshed, deletedAt: "2026-09-14T00:00:00Z" }]),
    ).toContain("已删除");
    expect(citationProblem({ ...citation, versionId: "never-retained" }, [refreshed])).toContain(
      "未保留",
    );
    expect(
      citationProblem(citation, [
        {
          ...refreshed,
          versions: [{ ...version, chunks: [{ ...source.chunks[0], sourceId: "another-source" }] }],
        },
      ]),
    ).toContain("片段当前不可用");
  });
  it("allows an exact original selection spanning adjacent parsing chunks", () => {
    expect(citationProblem({ ...citation, quote: source.text }, [source])).toBeNull();
  });
});

describe("PDF text quote offsets", () => {
  it("maps layout whitespace to original offsets without altering punctuation", () => {
    const text = "前言\n\n学习 率\n决定步长。\n后文";
    const range = quoteOffsets(text, "学习率决定步长。");
    expect(range && text.slice(...range)).toBe("学习 率\n决定步长。");
    expect(quoteOffsets(text, "学习率决定步长！")).toBeNull();
  });
  it("matches Latin PDF line layout and Unicode without fabricating absent matches", () => {
    const text = "😀 A learning\nrate controls updates.";
    const range = quoteOffsets(text, "😀 A learning rate");
    expect(range && text.slice(...range)).toBe("😀 A learning\nrate");
    expect(quoteOffsets(text, "   ")).toBeNull();
    expect(quoteOffsets(text, "learning loss")).toBeNull();
  });
});
