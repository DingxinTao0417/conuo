import { describe, expect, it } from "vitest";
import { chunkText } from "./import";
import { knowledgeBlocks } from "./knowledge-update";
import { reviseNote } from "./note-versions";
import { createEmptyWorkspace } from "./seed";
import {
  materializeSearchCandidates,
  SearchBoundaryError,
  searchItemEligible,
  searchTokens,
  searchWorkspace,
  validateSearchRequest,
} from "./search";
import { searchRequestSchema } from "./search-types";
import type { SearchCandidate, SearchHit, SearchRequest } from "./search-types";
import type { Citation, Note, Source, SourceVersion } from "./types";

const created = "2026-09-10T00:00:00.000Z";
const updated = "2026-09-12T12:00:00.000Z";
const all: SearchRequest = { query: "", scope: { kind: "all" } };
function source(id: string, text: string, spaceIds = ["alpha"]): Source {
  const versionId = `${id}-current`;
  return {
    id,
    versionId,
    title: id,
    filename: `${id}.txt`,
    kind: "text",
    mime: "text/plain",
    size: text.length,
    hash: "a".repeat(64),
    spaceIds,
    tags: [],
    status: "ready",
    text,
    chunks: chunkText(text, id, versionId),
    createdAt: created,
    updatedAt: updated,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
  };
}
function note(id: string, content: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    spaceId: "alpha",
    title: id,
    content,
    kind: "note",
    status: "accepted",
    citations: [],
    versions: [],
    contentRevision: 2,
    createdAt: created,
    updatedAt: updated,
    deletedAt: null,
    ...overrides,
  };
}
function citation(item: Source): Citation {
  const chunk = item.chunks[0];
  return {
    sourceId: item.id,
    versionId: item.versionId,
    chunkId: chunk.id,
    quote: chunk.text,
    title: item.title,
    section: chunk.section,
    ...(chunk.page ? { page: chunk.page } : {}),
  };
}
function fixture() {
  const data = createEmptyWorkspace();
  data.spaces = ["alpha", "beta"].map((id) => ({
    id,
    name: id,
    goal: "",
    color: "#7865cf",
    archived: false,
    createdAt: created,
  }));
  const first = source(
    "first",
    "学习率决定参数更新步长。\n\n熵用于描述不确定性。 C++ 与 C# 是不同名称。",
  );
  first.title = "优化方法";
  first.tags = ["机器学习", "优化", "AI"];
  const other = source("other", "另一个知识库的独立说明。", ["beta"]);
  const inbox = source("unassigned", "收件箱的未归类原文。", []);
  const personal = note("personal", "<h2>我的理解</h2><p>我认为学习率需要结合误差曲线调整。</p>");
  const knowledge = note("knowledge", "<p>AI 接受知识页的总结仍须核对。</p>", {
    kind: "knowledge",
    aiGenerated: true,
    citations: [citation(first)],
  });
  const draft = note("draft", "<p>草稿不能参与默认搜索。</p>", {
    kind: "knowledge",
    status: "draft",
    aiGenerated: true,
  });
  data.sources = [first, other, inbox];
  data.notes = [personal, knowledge, draft];
  return { data, first, other, inbox, personal, knowledge, draft };
}
function candidate(hit: SearchHit): SearchCandidate {
  const shared = { kind: hit.kind, objectId: hit.objectId, blockId: hit.blockId, score: hit.score };
  return hit.kind === "source"
    ? { ...shared, kind: "source", versionId: hit.versionId }
    : { ...shared, kind: hit.kind, revision: hit.revision, updatedAt: hit.updatedAt };
}
function archived(item: Source): SourceVersion {
  return {
    versionId: `${item.id}-old`,
    title: "原文旧版",
    filename: "old.pdf",
    kind: "pdf",
    mime: "application/pdf",
    size: 8,
    hash: "b".repeat(64),
    status: "ready",
    text: "旧版仅保留的旧词。",
    chunks: [
      {
        id: "old-chunk",
        sourceId: item.id,
        versionId: `${item.id}-old`,
        text: "旧版仅保留的旧词。",
        section: "第 4 页",
        page: 4,
        order: 0,
      },
    ],
    pageCount: 4,
    parsedPages: 4,
    createdAt: created,
    archivedAt: updated,
  };
}

describe("SRC-01 explicit ordinary search boundary", () => {
  it("provides a validated metadata filter for database preselection without widening empty sets", () => {
    const { data, first } = fixture();
    first.aiAllowed = false;
    const request = validateSearchRequest(data, {
      query: "  学习率  ",
      scope: { kind: "space", spaceId: "alpha" },
      filters: { types: ["text"], tags: ["优化"], created: { from: created } },
    });
    expect(request.query).toBe("学习率");
    expect(
      data.sources.filter((item) => searchItemEligible(item, request)).map((item) => item.id),
    ).toEqual([first.id]);
    expect(
      data.sources.filter((item) =>
        searchItemEligible(item, { ...request, filters: { tags: ["不存在"] } }),
      ),
    ).toEqual([]);
  });

  it("keeps ordinary source/note/knowledge search available with both AI switches off", () => {
    const { data } = fixture();
    const before = searchWorkspace(data, all).hits.map((hit) => hit.objectId);
    data.aiEnabled = false;
    data.sources.forEach((item) => {
      item.aiAllowed = false;
    });
    expect(searchWorkspace(data, all).hits.map((hit) => hit.objectId)).toEqual(before);
    expect(new Set(searchWorkspace(data, all).hits.map((hit) => hit.kind))).toEqual(
      new Set(["source", "note", "knowledge"]),
    );
  });

  it("isolates space, inbox and explicitly selected all-library scopes", () => {
    const { data } = fixture();
    data.notes.push(note("inbox-note", "<p>未归类笔记</p>", { spaceId: "inbox" }));
    const alpha = searchWorkspace(data, { ...all, scope: { kind: "space", spaceId: "alpha" } });
    expect(new Set(alpha.hits.map((hit) => hit.objectId))).toEqual(
      new Set(["first", "personal", "knowledge"]),
    );
    const inbox = searchWorkspace(data, { ...all, scope: { kind: "inbox" } });
    expect(new Set(inbox.hits.map((hit) => hit.objectId))).toEqual(
      new Set(["unassigned", "inbox-note"]),
    );
    expect(searchWorkspace(data, all).total).toBe(6);
    expect(searchRequestSchema.safeParse({ query: "" }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ query: "", scope: "all" }).success).toBe(false);
  });

  it.each(["missing", "archived"])(
    "never turns an unavailable %s space into all-library search",
    (kind) => {
      const { data } = fixture();
      if (kind === "archived") data.spaces[0].archived = true;
      expect(() =>
        searchWorkspace(data, {
          ...all,
          scope: { kind: "space", spaceId: kind === "missing" ? "missing" : "alpha" },
        }),
      ).toThrow(SearchBoundaryError);
    },
  );

  it("excludes deleted objects and drafts by default while allowing explicit management of drafts", () => {
    const { data, first, personal } = fixture();
    first.deletedAt = updated;
    personal.deletedAt = updated;
    const current = searchWorkspace(data, all);
    for (const id of ["first", "personal", "draft"])
      expect(current.hits.some((hit) => hit.objectId === id)).toBe(false);
    expect(current.hits.every((hit) => !hit.draft)).toBe(true);
    const draft = searchWorkspace(data, { ...all, includeDrafts: true }).hits.find(
      (hit) => hit.objectId === "draft",
    )!;
    expect(draft).toMatchObject({
      kind: "knowledge",
      draft: true,
      provenance: { origin: "ai", label: "AI 草稿" },
    });
    expect(draft.warnings.join(" ")).toContain("不作为未来 AI");
    expect(current.hits.find((hit) => hit.objectId === "knowledge")).toBeTruthy();
  });

  it("returns title, tag and parsed-body hits with one best block per object", () => {
    const { data, first } = fixture();
    for (const query of ["优化方法", "机器学习", "参数更新"]) {
      const result = searchWorkspace(data, { ...all, query, filters: { types: ["text"] } });
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]).toMatchObject({
        kind: "source",
        objectId: first.id,
        versionId: first.versionId,
        sourceKind: "text",
        locator: { kind: "chunk" },
      });
    }
    expect(searchWorkspace(data, { ...all, query: "不确定性" }).hits[0].blockId).toBe(
      first.chunks[1].id,
    );
  });

  it("supports mixed Chinese/English tokens, single Han characters and programming-language names", () => {
    expect(searchTokens("熵 C++ C# ＡＩ 学习率")).toEqual([
      "熵",
      "c++",
      "c#",
      "ai",
      "学习",
      "习率",
    ]);
    const { data } = fixture();
    for (const query of ["熵", "C++", "c#", "ＡＩ"])
      expect(
        searchWorkspace(data, { ...all, query }).hits.some((hit) => hit.objectId === "first"),
      ).toBe(true);
    expect(searchWorkspace(data, { ...all, query: "zzzz no-matching-concept" }).hits).toEqual([]);
  });

  it("combines explicit type and all-tag filters; notes do not inherit source tags", () => {
    const { data } = fixture();
    expect(
      searchWorkspace(data, {
        ...all,
        filters: { types: ["text"], tags: ["机器学习", "ai"] },
      }).hits.map((hit) => hit.objectId),
    ).toEqual(["first"]);
    expect(
      searchWorkspace(data, { ...all, filters: { tags: ["机器学习", "不存在"] } }).hits,
    ).toEqual([]);
    expect(
      searchWorkspace(data, { ...all, filters: { types: ["note", "knowledge"] } })
        .hits.map((hit) => hit.kind)
        .sort(),
    ).toEqual(["knowledge", "note"]);
  });

  it("applies ISO time filters with inclusive lower and exclusive upper bounds", () => {
    const { data } = fixture();
    const filters = {
      created: { from: created, to: "2026-09-11T00:00:00.000Z" },
      updated: { from: updated, to: "2026-09-13T00:00:00.000Z" },
    };
    expect(searchWorkspace(data, { ...all, filters }).total).toBe(5);
    expect(searchWorkspace(data, { ...all, filters: { created: { to: created } } }).hits).toEqual(
      [],
    );
    expect(
      searchWorkspace(data, { ...all, filters: { updated: { from: "2026-09-12T13:00:00.000Z" } } })
        .hits,
    ).toEqual([]);
    expect(
      searchRequestSchema.safeParse({
        ...all,
        filters: { created: { from: updated, to: created } },
      }).success,
    ).toBe(false);
    expect(
      searchRequestSchema.safeParse({ ...all, filters: { created: { from: "yesterday" } } })
        .success,
    ).toBe(false);
  });

  it("keeps title-only failed/link records navigable without inventing a body chunk", () => {
    const { data, first } = fixture();
    first.title = "扫描件元数据";
    first.status = "failed";
    first.text = "";
    first.chunks = [];
    const hit = searchWorkspace(data, { ...all, query: "扫描件" }).hits[0];
    expect(hit).toMatchObject({
      objectId: first.id,
      blockId: null,
      snippet: "",
      locator: { kind: "metadata" },
    });
    expect(hit.warnings.join(" ")).toContain("未提取到可检索文字");
    expect(hit).not.toHaveProperty("quote");
    expect(hit).not.toHaveProperty("chunkId");
  });

  it("does not search history or forged/outdated source chunks", () => {
    const { data, first } = fixture();
    first.versions = [archived(first)];
    expect(searchWorkspace(data, { ...all, query: "旧版仅保留" }).hits).toEqual([]);
    first.chunks[0].text = "forged-body-term";
    expect(searchWorkspace(data, { ...all, query: "forged-body-term" }).hits).toEqual([]);
    first.chunks[1].versionId = "old-version";
    expect(searchWorkspace(data, { ...all, query: "不确定性" }).hits).toEqual([]);
  });

  it("provides bounded plain snippets near a match without rewriting stored text or offsets", () => {
    const { data, personal } = fixture();
    personal.content = `<p>${"背景😀 ".repeat(100)} needleword ${"末尾内容 ".repeat(100)}</p>`;
    const before = structuredClone(data);
    const hit = searchWorkspace(data, { ...all, query: "needleword" }).hits[0];
    expect(Array.from(hit.snippet).length).toBeLessThanOrEqual(260);
    expect(hit.snippet).toContain("needleword");
    expect(hit.snippet).not.toContain("<p>");
    expect(hit.locator).toEqual({ kind: "note-block", start: 0, end: personal.content.length });
    expect(data).toEqual(before);
  });

  it("paginates object hits deterministically and reports a known local total", () => {
    const { data } = fixture();
    const first = searchWorkspace(data, { ...all, limit: 2 });
    expect(first.hits).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.hasMore).toBe(true);
    expect(searchWorkspace(data, { ...all, limit: 2 })).toEqual(first);
    expect(searchWorkspace(data, { ...all, limit: 100 }).hasMore).toBe(false);
  });
});

describe("notes retain their own provenance and exact revision locations", () => {
  it("distinguishes user notes, user knowledge and accepted AI content without SourceCitation coercion", () => {
    const { data, personal, knowledge } = fixture();
    data.notes.push(note("user-knowledge", "<p>独立思考</p>", { kind: "knowledge" }));
    const hits = searchWorkspace(data, all).hits;
    expect(hits.find((hit) => hit.objectId === personal.id)).toMatchObject({
      kind: "note",
      revision: 2,
      updatedAt: updated,
      provenance: { origin: "user", label: "用户笔记" },
    });
    expect(hits.find((hit) => hit.objectId === knowledge.id)).toMatchObject({
      kind: "knowledge",
      provenance: { origin: "ai", label: "AI 整理 · 已接受知识页", referenceState: "current" },
    });
    expect(hits.find((hit) => hit.objectId === "user-knowledge")?.provenance.label).toBe(
      "用户知识页",
    );
    for (const hit of hits.filter((value) => value.kind !== "source")) {
      expect(hit).not.toHaveProperty("sourceKind");
      expect(hit).not.toHaveProperty("sourceId");
      expect(hit).not.toHaveProperty("versionId");
    }
  });

  it("indexes visible note blocks and never extracts script/style payloads as note text", () => {
    const { data, personal } = fixture();
    personal.content =
      "<h2>标题</h2><script>secret-script-token</script><style>secret-style-token</style><p>正文 needleword &amp; 学习</p>";
    expect(searchWorkspace(data, { ...all, query: "secret-script-token" }).hits).toEqual([]);
    expect(searchWorkspace(data, { ...all, query: "secret-style-token" }).hits).toEqual([]);
    const hit = searchWorkspace(data, { ...all, query: "needleword" }).hits[0];
    const block = knowledgeBlocks(personal.content).find((item) => item.id === hit.blockId)!;
    expect(hit.snippet).toBe("正文 needleword & 学习");
    expect(personal.content.slice(block.start, block.end)).toBe(
      "<p>正文 needleword &amp; 学习</p>",
    );
  });

  it.each([
    "deleted",
    "missing",
    "missing-version",
    "wrong-chunk",
    "wrong-quote",
    "wrong-page",
    "forged-chunk",
  ])("keeps saved notes readable but flags %s source evidence", (kind) => {
    const { data, first, knowledge } = fixture();
    if (kind === "deleted") first.deletedAt = updated;
    if (kind === "missing") data.sources = data.sources.filter((item) => item.id !== first.id);
    if (kind === "missing-version") knowledge.citations[0].versionId = "gone";
    if (kind === "wrong-chunk") knowledge.citations[0].chunkId = "gone";
    if (kind === "wrong-quote") knowledge.citations[0].quote = "a made-up claim";
    if (kind === "wrong-page") knowledge.citations[0].page = 10;
    if (kind === "forged-chunk") {
      first.chunks[0].text = "invented";
      knowledge.citations[0].quote = "invented";
    }
    const hit = searchWorkspace(data, { ...all, filters: { types: ["knowledge"] } }).hits[0];
    expect(hit.objectId).toBe(knowledge.id);
    expect(hit.provenance).toMatchObject({
      origin: "ai",
      referenceState: "unavailable",
      unavailableCount: 1,
    });
    expect(hit.warnings.join(" ")).toContain("仍保留你已保存的笔记文字");
  });

  it("labels exact retained historical citations separately from current evidence and AI restrictions", () => {
    const { data, first, knowledge } = fixture();
    const version = archived(first);
    first.versions = [version];
    first.aiAllowed = false;
    const chunk = version.chunks[0];
    knowledge.citations = [
      {
        sourceId: first.id,
        versionId: version.versionId,
        chunkId: chunk.id,
        title: first.title,
        quote: chunk.text,
        page: chunk.page,
        section: chunk.section,
      },
    ];
    const hit = searchWorkspace(data, { ...all, filters: { types: ["knowledge"] } }).hits[0];
    expect(hit.provenance).toMatchObject({
      referenceState: "historical",
      historicalCount: 1,
      unavailableCount: 0,
      aiRestrictedCount: 1,
    });
    expect(hit.warnings.join(" ")).toContain("历史版本");
    expect(hit.warnings.join(" ")).toContain("禁用 AI");
  });

  it("accepts real manually saved substrings and whitespace differences for ordinary provenance", () => {
    const { data, knowledge } = fixture();
    knowledge.citations[0].quote = "参数 更新 步长";
    const hit = searchWorkspace(data, { ...all, filters: { types: ["knowledge"] } }).hits[0];
    expect(hit.provenance.referenceState).toBe("current");
  });
});

describe("RPC candidate identity validation and canonical reconstruction", () => {
  it("rebuilds the source title, snippet, location and current AI flag from canonical data", () => {
    const { data, first } = fixture();
    const hit = searchWorkspace(data, { ...all, query: "参数更新" }).hits.find(
      (value) => value.kind === "source",
    )!;
    const row = candidate(hit);
    first.title = "改名后的权威标题";
    first.aiAllowed = false;
    const result = materializeSearchCandidates(data, all, [row]);
    expect(result.hits[0]).toMatchObject({
      title: first.title,
      snippet: first.chunks[0].text,
      provenance: { origin: "original", aiRestrictedCount: 1 },
    });
    expect(result.total).toBeNull();
    expect(result.hasMore).toBe(false);
    expect(materializeSearchCandidates(data, all, []).hits).toEqual([]);
  });

  it("accepts an explicit metadata-only RPC hit without fabricating a chunk", () => {
    const { data, first } = fixture();
    const result = materializeSearchCandidates(data, all, [
      { kind: "source", objectId: first.id, versionId: first.versionId, blockId: null, score: 1 },
    ]);
    expect(result.hits[0]).toMatchObject({ blockId: null, locator: { kind: "metadata" } });
  });

  it.each([
    "out-of-scope",
    "deleted",
    "old-version",
    "wrong-block",
    "wrong-kind",
    "type-filter",
    "tag-filter",
    "time-filter",
  ])("rejects canonical candidates after %s changes", (reason) => {
    const { data, first } = fixture();
    const rows = [
      candidate(
        searchWorkspace(data, { ...all, query: "参数更新" }).hits.find(
          (hit) => hit.kind === "source",
        )!,
      ),
    ];
    let request = all;
    if (reason === "out-of-scope") request = { ...all, scope: { kind: "space", spaceId: "beta" } };
    if (reason === "deleted") first.deletedAt = updated;
    if (reason === "old-version") first.versionId = "next-version";
    if (reason === "wrong-block") first.chunks = [];
    if (reason === "wrong-kind") Object.assign(rows[0], { kind: "note" });
    if (reason === "type-filter") request = { ...all, filters: { types: ["pdf"] } };
    if (reason === "tag-filter") request = { ...all, filters: { tags: ["missing"] } };
    if (reason === "time-filter") request = { ...all, filters: { updated: { to: created } } };
    expect(() => materializeSearchCandidates(data, request, rows)).toThrow(SearchBoundaryError);
  });

  it.each(["revision", "timestamp", "space", "draft", "deleted", "kind", "block"])(
    "rejects a note candidate after its %s changes",
    (reason) => {
      const { data, personal } = fixture();
      const request: SearchRequest = {
        ...all,
        scope: { kind: "space", spaceId: "alpha" },
        query: "误差曲线",
      };
      const rows = [candidate(searchWorkspace(data, request).hits[0])];
      if (reason === "revision") data.notes[0] = reviseNote(personal, { content: "<p>新内容</p>" });
      if (reason === "timestamp") personal.updatedAt = "2026-09-13T12:00:00.000Z";
      if (reason === "space") personal.spaceId = "beta";
      if (reason === "draft") personal.status = "draft";
      if (reason === "deleted") personal.deletedAt = updated;
      if (reason === "kind") personal.kind = "knowledge";
      if (reason === "block") personal.content = "";
      expect(() => materializeSearchCandidates(data, request, rows)).toThrow(SearchBoundaryError);
    },
  );

  it.each(["extra-text", "empty-chunk", "NaN", "infinity", "negative", "nonarray", "too-many"])(
    "rejects invalid RPC payloads: %s",
    (reason) => {
      const { data } = fixture();
      const row = candidate(searchWorkspace(data, all).hits[0]);
      let rows: unknown = [row];
      if (reason === "extra-text") Object.assign(row, { text: "untrusted RPC replacement" });
      if (reason === "empty-chunk") row.blockId = "";
      if (reason === "NaN") row.score = NaN;
      if (reason === "infinity") row.score = Infinity;
      if (reason === "negative") row.score = -1;
      if (reason === "nonarray") rows = row;
      if (reason === "too-many") rows = Array.from({ length: 501 }, () => row);
      expect(() => materializeSearchCandidates(data, all, rows)).toThrow(SearchBoundaryError);
    },
  );

  it("validates candidates outside the visible result limit and never silently drops a stale row", () => {
    const { data } = fixture();
    const rows = searchWorkspace(data, all).hits.map(candidate);
    rows[rows.length - 1].objectId = "missing-object";
    expect(() => materializeSearchCandidates(data, { ...all, limit: 1 }, rows)).toThrow(
      SearchBoundaryError,
    );
  });

  it("deduplicates remote block hits by object, selects the highest rank, and preserves input immutability", () => {
    const { data, first } = fixture();
    const rows: SearchCandidate[] = first.chunks.map((chunk, index) => ({
      kind: "source",
      objectId: first.id,
      versionId: first.versionId,
      blockId: chunk.id,
      score: index + 1,
    }));
    rows.push({ ...rows[0], score: 0 });
    const before = structuredClone({ data, rows });
    const result = materializeSearchCandidates(data, all, rows);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].blockId).toBe(first.chunks[1].id);
    expect(result.hits[0].score).toBe(2);
    expect(result.total).toBeNull();
    expect({ data, rows }).toEqual(before);
  });
});
