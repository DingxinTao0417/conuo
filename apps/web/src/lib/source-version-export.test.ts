import JSZip from "jszip";
import { posix } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceArchive } from "./export";
import { chunkText, makeWebSource } from "./import";
import { snapshotKnowledgeNote } from "./knowledge-update";
import { createEmptyWorkspace } from "./seed";
import type { Citation, Note, SourceVersion } from "./types";

const mocks = vi.hoisted(() => ({ getBlob: vi.fn() }));
vi.mock("./local-store", () => ({ getBlob: mocks.getBlob, putBlob: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

function fixture() {
  const data = createEmptyWorkspace();
  const source = makeWebSource({
    url: "https://example.com/article",
    title: "当前标题",
    text: "CURRENT_ONLY：当前版本的内容。",
    spaceId: data.spaces[0].id,
  });
  source.id = "web-source";
  source.versionId = "v3";
  source.versionCreatedAt = "2026-09-12T03:00:00Z";
  source.webSnapshot!.capturedAt = source.versionCreatedAt;
  source.chunks = chunkText(source.text, source.id, source.versionId);
  const version = (id: string, text: string, at: string): SourceVersion => ({
    versionId: id,
    title: `历史标题 ${id}`,
    filename: `${id}.txt`,
    kind: "web",
    mime: "text/plain",
    size: new TextEncoder().encode(text).byteLength,
    hash: "",
    status: "ready",
    text,
    chunks: chunkText(text, source.id, id),
    url: source.url,
    webSnapshot: { ...source.webSnapshot!, capturedAt: at },
    createdAt: at,
    archivedAt: "2026-09-12T03:00:00Z",
  });
  source.versions = [
    version("v2", "SECOND_ONLY：第二版仍保留完整正文。", "2026-09-12T02:00:00Z"),
    version("v1", "FIRST_ONLY：旧版第一句。\n\n旧版第二句。", "2026-09-12T01:00:00Z"),
  ];
  data.sources = [source];
  const cite = (id: string): Citation => {
    const item =
      id === source.versionId ? source : source.versions!.find((v) => v.versionId === id)!;
    return {
      sourceId: source.id,
      versionId: id,
      chunkId: item.chunks[0].id,
      title: item.title,
      quote: item.chunks[0].text,
      section: item.chunks[0].section,
    };
  };
  const note = (id: string, citations: Citation[]): Note => ({
    id,
    title: id,
    content: "<p>保存的学习内容 [1]</p>",
    citations,
    spaceId: data.spaces[0].id,
    kind: "knowledge",
    status: "accepted",
    versions: [],
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    deletedAt: null,
  });
  return { data, source, cite, note };
}

async function json(zip: JSZip, path: string) {
  return JSON.parse(await zip.file(path)!.async("string"));
}

describe("retained source versions in portable exports", () => {
  it("exports all three exact bodies and snapshots even without citations, with CRC integrity and no mutation", async () => {
    const { data, source } = fixture();
    const original = structuredClone(data);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data), { checkCRC32: true });
    const mapping = (await json(zip, "source-mapping.json"))[0];
    expect(mapping).toMatchObject({
      versionId: "v3",
      versionState: "current",
      metadata: "sources/web-source/metadata.json",
      extractedText: "sources/web-source/extracted.txt",
      createdAt: source.versionCreatedAt,
    });
    expect(mapping.versions.map((v: { versionId: string }) => v.versionId)).toEqual(["v2", "v1"]);
    for (const item of [mapping, ...mapping.versions]) {
      const expected =
        item.versionId === "v3"
          ? source
          : source.versions!.find((v) => v.versionId === item.versionId)!;
      expect(await zip.file(item.extractedText)!.async("string")).toBe(expected.text);
      expect(await json(zip, item.chunks)).toEqual(expected.chunks);
      const metadata = await json(zip, item.metadata);
      expect(metadata).toMatchObject({
        versionId: item.versionId,
        title: expected.title,
        text: expected.text,
      });
      const capture = await json(zip, item.webSnapshot);
      expect(capture).toMatchObject({
        versionId: item.versionId,
        capturedAt: expected.webSnapshot!.capturedAt,
        resources: [],
        extractedText: "extracted.txt",
      });
      expect(item.original).toBeNull();
      expect(await zip.file(item.originalStatusFile)!.async("string")).toContain("未保存原站 HTML");
      if (item.versionId !== "v3") {
        expect(item.metadata).toBe(`sources/web-source/versions/${item.versionId}/source.json`);
        expect(item.versionState).toBe("historical");
        expect(metadata).not.toHaveProperty("versions");
        expect(metadata).not.toHaveProperty("aiAllowed");
        expect(metadata.text).not.toContain("CURRENT_ONLY");
      }
    }
    expect(await json(zip, "workspace.json")).toEqual(JSON.parse(JSON.stringify(original)));
    expect(data).toEqual(original);
  });

  it("links notes, note history, conversations and both relation evidence and baselines to their precise archived version", async () => {
    const { data, source, cite, note } = fixture();
    data.notes = [note("from", [cite("v1")]), note("to", [cite("v3")])];
    data.notes[0].versions = [
      {
        id: "note-v1",
        title: "旧知识页",
        content: "<p>旧知识页</p>",
        citations: [cite("v2")],
        savedAt: source.createdAt,
      },
    ];
    data.conversations = [
      {
        id: "chat",
        title: "历史对话",
        scope: "document",
        sourceIds: [source.id],
        sourceId: source.id,
        spaceId: data.spaces[0].id,
        resolved: false,
        updatedAt: source.updatedAt,
        messages: [
          {
            id: "answer",
            role: "assistant",
            content: "<script>bad()</script>原回答",
            citations: [cite("v2")],
            createdAt: source.createdAt,
          },
        ],
      },
    ];
    data.conceptRelations = [
      {
        id: "relation",
        type: "related",
        spaceId: data.spaces[0].id,
        from: snapshotKnowledgeNote(data.notes[0]),
        to: snapshotKnowledgeNote(data.notes[1]),
        fromClaim: "旧观点",
        toClaim: "新观点",
        fromCondition: "旧条件",
        toCondition: "新条件",
        explanation: "需要复核",
        fromCitations: [cite("v1")],
        toCitations: [cite("v3")],
        origin: "ai",
        revision: 1,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
        deletedAt: null,
      },
    ];
    const original = structuredClone(data);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data), { checkCRC32: true });
    const notes = await json(zip, "note-mapping.json");
    const conversation = (await json(zip, "conversation-mapping.json"))[0];
    const relation = (await json(zip, "relation-mapping.json"))[0];
    for (const [entry, id] of [
      [notes[0], "v1"],
      [notes[0].versions[0], "v2"],
      [conversation.messages[0], "v2"],
      [relation.from, "v1"],
    ] as const) {
      const citation = (await json(zip, entry.citations))[0];
      expect(citation).toMatchObject({
        ...cite(id),
        sourceAvailability: "historical",
        sourceVersionState: "historical",
        sourceMetadata: `sources/web-source/versions/${id}/source.json`,
        extractedText: `sources/web-source/versions/${id}/extracted.txt`,
      });
      for (const [link, path] of [
        [citation.metadataPath, citation.sourceMetadata],
        [citation.textPath, citation.extractedText],
      ]) {
        expect(
          posix.normalize(posix.join(posix.dirname(entry.markdown), decodeURIComponent(link))),
        ).toBe(path);
        expect(zip.file(path)).toBeTruthy();
      }
      for (const path of [entry.markdown, entry.html]) {
        const rendered = await zip.file(path)!.async("string");
        expect(rendered).toContain(`versions/${id}/source.json`);
        expect(rendered).toContain(`versions/${id}/extracted.txt`);
        expect(rendered).toContain("已保留历史版本");
        expect(rendered).not.toContain("CURRENT_ONLY");
        expect(rendered).not.toContain("<script");
      }
    }
    const relationCitations = await json(zip, relation.citations);
    expect(relationCitations.from[0].metadataPath).toBe(
      "../../sources/web-source/versions/v1/source.json",
    );
    expect(relationCitations.to[0]).toMatchObject({
      sourceAvailability: "included",
      sourceVersionState: "current",
      metadataPath: "../../sources/web-source/metadata.json",
    });
    expect(await zip.file(conversation.markdown)!.async("string")).toContain(
      "versions/v2/extracted.txt",
    );
    expect(await json(zip, "conversations.json")).toEqual(
      JSON.parse(JSON.stringify(original.conversations)),
    );
    expect(data).toEqual(original);
  });

  it("keeps deleted backups and manual excerpts while rejecting missing versions, wrong anchors and fabricated quotes", async () => {
    const { data, source, cite, note } = fixture();
    source.deletedAt = "2026-09-12T04:00:00Z";
    const manual = { ...cite("v1"), quote: "旧版第 一句。\n\n旧版第二句。" };
    const entries = [
      cite("v1"),
      manual,
      { ...cite("v1"), versionId: "not-retained" },
      { ...cite("v1"), sourceId: "not-in-backup" },
      { ...cite("v1"), chunkId: "wrong-anchor" },
      { ...cite("v1"), quote: source.text },
      { ...cite("v1"), quote: "<script>invented()</script>" },
    ];
    data.notes = [note("checks", entries)];
    const original = structuredClone(data);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data), { checkCRC32: true });
    const mapping = (await json(zip, "note-mapping.json"))[0];
    const citations = await json(zip, mapping.citations);
    expect(citations.map((c: { sourceAvailability: string }) => c.sourceAvailability)).toEqual([
      "deleted",
      "deleted",
      "version_missing",
      "source_missing",
      "citation_invalid",
      "citation_invalid",
      "citation_invalid",
    ]);
    for (const citation of citations.slice(0, 2)) {
      expect(citation.sourceVersionState).toBe("historical");
      expect(citation.deletedAt).toBe(source.deletedAt);
      expect(citation.sourceMetadata).toBe("sources/web-source/versions/v1/source.json");
    }
    for (const citation of citations.slice(2)) {
      expect(citation.sourceMetadata).toBeNull();
      expect(citation.metadataPath).toBeNull();
      expect(citation.extractedText).toBeNull();
      expect(citation.textPath).toBeNull();
    }
    expect(citations[1].quote).toBe(manual.quote);
    const html = await zip.file(mapping.html)!.async("string");
    expect(html).toContain("资料已删除");
    expect(html).toContain("无法确认原始依据");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(
      await zip.file("sources/web-source/versions/v1/original-status.txt")!.async("string"),
    ).toContain("资料已删除");
    expect(data).toEqual(original);
  });

  it("resolves each version's exact original and reports missing historical bytes without substituting the current original", async () => {
    const { data, source } = fixture();
    for (const item of [source, ...source.versions!]) {
      item.kind = "markdown";
      item.filename = "source.json";
      item.blobKey = `${item.versionId}-local`;
      item.storagePath = `account/${item.versionId}/original.md`;
      delete item.webSnapshot;
    }
    const resolve = vi.fn(async (item) =>
      item.versionId === "v1" ? undefined : new Blob([`${item.versionId} bytes\u0000\u00ff`]),
    );
    const original = structuredClone(data);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data, resolve), {
      checkCRC32: true,
    });
    const mapping = (await json(zip, "source-mapping.json"))[0];
    expect(resolve.mock.calls.map(([item]) => [item.versionId, item.storagePath])).toEqual([
      ["v3", "account/v3/original.md"],
      ["v2", "account/v2/original.md"],
      ["v1", "account/v1/original.md"],
      ["v1", "account/v1/original.md"],
    ]);
    for (const item of [mapping, mapping.versions[0]]) {
      expect(item.original).toMatch(/original-source\.json$/);
      expect(await zip.file(item.original)!.async("string")).toBe(
        `${item.versionId} bytes\u0000\u00ff`,
      );
      expect((await json(zip, item.metadata)).versionId).toBe(item.versionId);
    }
    expect(mapping.versions[1].original).toBeNull();
    expect(mapping.versions[1].originalStatus).toContain("缺少");
    expect(await zip.file(mapping.versions[1].originalStatusFile)!.async("string")).toContain(
      "缺少",
    );
    expect(await zip.file("README.txt")!.async("string")).toContain(
      "原文件缺失：1 份（含历史版本）",
    );
    expect(data).toEqual(original);
  });

  it("does not trust cross-source chunk identities or choose one of duplicate version snapshots", async () => {
    const { data, source, cite, note } = fixture();
    const citation = cite("v1");
    source.versions![1].chunks[0].sourceId = "another-source";
    data.notes = [note("wrong-identity", [citation])];
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data), { checkCRC32: true });
    const mapping = (await json(zip, "note-mapping.json"))[0];
    expect((await json(zip, mapping.citations))[0]).toMatchObject({
      sourceAvailability: "citation_invalid",
      metadataPath: null,
      textPath: null,
    });
    source.versions!.push(structuredClone(source.versions![1]));
    await expect(buildWorkspaceArchive(data)).rejects.toThrow("历史版本记录无效");
  });
});
