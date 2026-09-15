import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGrounding } from "./ai/grounding";
import { buildWorkspaceArchive } from "./export";
import { importFile, makeWebSource, prepareFile } from "./import";
import { questionContextKey } from "./question-context";
import { resolveCitation, resolveSavedCitation, retrieveEvidence } from "./retrieval";
import { createEmptyWorkspace } from "./seed";
import { getSourceVersion, MAX_SOURCE_VERSIONS, replaceFileSource } from "./source-versions";
import { MAX_WORKSPACE_BYTES, workspaceSchema } from "./supabase/validation";
import type { AnswerRequest, Citation, Source, SourceVersion, WorkspaceData } from "./types";

const mocks = vi.hoisted(() => ({
  originals: new Map<string, Blob>(),
  putBlob: vi.fn(),
  getBlob: vi.fn(),
  pages: [] as (string | Error)[],
  destroy: vi.fn(),
}));
vi.mock("./local-store", () => ({ putBlob: mocks.putBlob, getBlob: mocks.getBlob }));
vi.mock("mammoth", async (importOriginal) => {
  const mammoth = await importOriginal<typeof import("mammoth")>();
  return {
    ...mammoth,
    // Vitest loads the Node entry, whose byte input is Buffer; the app's browser entry uses ArrayBuffer.
    extractRawText: ({ arrayBuffer }: { arrayBuffer: ArrayBuffer }) =>
      mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) }),
    convertToHtml: (
      { arrayBuffer }: { arrayBuffer: ArrayBuffer },
      options?: Parameters<typeof mammoth.convertToHtml>[1],
    ) => mammoth.convertToHtml({ buffer: Buffer.from(arrayBuffer) }, options),
  };
});
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: mocks.pages.length,
      getPage: async (number: number) => {
        const value = mocks.pages[number - 1];
        if (value instanceof Error) throw value;
        return {
          getTextContent: async () => ({ items: [{ str: value, hasEOL: true }] }),
          cleanup: vi.fn(),
        };
      },
    }),
    destroy: mocks.destroy,
  }),
}));

const firstText = "amberarchive records an original calibration of ten degrees.";
const secondText = "bluecurrent records an updated calibration of twenty degrees.";
const thirdText = "greencurrent records a final calibration of thirty degrees.";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.originals.clear();
  mocks.pages = [];
  mocks.putBlob.mockImplementation(async (key: string, blob: Blob) => {
    mocks.originals.set(key, blob);
  });
  mocks.getBlob.mockImplementation(async (key: string) => mocks.originals.get(key));
});

async function prepared(text = secondText, filename = "revision.txt") {
  const file = new File([text], filename);
  return { file, candidate: await prepareFile(file, "") };
}

async function fixture(text = firstText, filename = "original.txt") {
  const data = createEmptyWorkspace();
  const file = new File([text], filename);
  const source = await importFile(file, data.spaces[0].id, true);
  data.sources.push(source);
  return { data, source, file };
}

async function replaced() {
  const initial = await fixture();
  const { candidate, file } = await prepared();
  const next = replaceFileSource(
    initial.data,
    initial.source.id,
    initial.source.versionId,
    candidate,
  );
  return { ...initial, next, current: next.sources[0], candidate, nextFile: file };
}

function cite(source: Source, index = 0): Citation {
  const chunk = source.chunks[index];
  return {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    section: chunk.section,
    ...(chunk.page ? { page: chunk.page } : {}),
  };
}

function question(source: Source, text: string): AnswerRequest {
  return {
    question: text,
    scope: "document",
    sourceId: source.id,
    sourceIds: [],
    spaceId: source.spaceIds[0] ?? "inbox",
  };
}

function addSavedEvidence(data: WorkspaceData, source: Source) {
  const citation = cite(source);
  data.annotations = [...data.annotations];
  data.notes = [...data.notes];
  data.conversations = [...data.conversations];
  data.annotations.push({
    id: `annotation-${source.versionId}`,
    sourceId: source.id,
    versionId: source.versionId,
    quote: citation.quote,
    note: "当时记录",
    ...(citation.page ? { page: citation.page } : {}),
    createdAt: source.createdAt,
  });
  data.notes.push({
    id: `note-${source.versionId}`,
    spaceId: data.spaces[0].id,
    title: "原话摘录",
    content: `<p>${citation.quote}</p>`,
    kind: "note",
    status: "accepted",
    citations: [citation],
    versions: [],
    createdAt: source.createdAt,
    updatedAt: source.createdAt,
    deletedAt: null,
  });
  data.conversations.push({
    id: `chat-${source.versionId}`,
    sourceId: source.id,
    sourceIds: [source.id],
    spaceId: data.spaces[0].id,
    title: "当时问答",
    scope: "document",
    resolved: false,
    updatedAt: source.createdAt,
    messages: [
      {
        id: `answer-${source.versionId}`,
        role: "assistant",
        content: citation.quote,
        citations: [citation],
        createdAt: source.createdAt,
      },
    ],
  });
  return citation;
}

function expectAtomicFailure(data: WorkspaceData, candidate: Source, pattern?: RegExp) {
  const before = structuredClone(data);
  const candidateBefore = structuredClone(candidate);
  const source = data.sources[0];
  const writesBefore = mocks.putBlob.mock.calls.length;
  const action = () => replaceFileSource(data, source.id, source.versionId, candidate);
  if (pattern) expect(action).toThrow(pattern);
  else expect(action).toThrow();
  expect(data).toEqual(before);
  expect(candidate).toEqual(candidateBefore);
  expect(mocks.putBlob).toHaveBeenCalledTimes(writesBefore);
}

describe("IMP-03 preparation and stable file identity", () => {
  it("repairs a restored missing original as a new version while preserving the missing history", async () => {
    const { data, source } = await fixture();
    delete source.blobKey;
    source.originalMissing = true;
    const { candidate } = await prepared(firstText, "recovered-original.txt");
    expect(candidate.hash).toBe(source.hash);
    const next = replaceFileSource(data, source.id, source.versionId, candidate);
    expect(next.sources[0].versionId).toBe(candidate.versionId);
    expect(next.sources[0].originalMissing).toBeUndefined();
    expect(getSourceVersion(next.sources[0], source.versionId)?.originalMissing).toBe(true);
    expect(getSourceVersion(next.sources[0], source.versionId)?.blobKey).toBeUndefined();
    expect(workspaceSchema.safeParse(next).success).toBe(true);
  });
  it("prepares real TXT bytes, SHA-256 and chunks without storing an original", async () => {
    const raw = "\uFEFF# 校准记录\r\n\r\n准确保留原件字节。\r\n";
    const { candidate, file } = await prepared(raw, "calibration.txt");
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    expect(candidate.hash).toBe(Buffer.from(digest).toString("hex"));
    expect(candidate.text).toBe("# 校准记录\n\n准确保留原件字节。");
    expect(candidate).toMatchObject({
      filename: "calibration.txt",
      kind: "text",
      status: "ready",
      size: file.size,
    });
    expect(
      candidate.chunks.every(
        (chunk) => chunk.sourceId === candidate.id && chunk.versionId === candidate.versionId,
      ),
    ).toBe(true);
    expect(candidate.blobKey).toBe(`original:${candidate.id}:${candidate.versionId}`);
    expect(mocks.putBlob).not.toHaveBeenCalled();
    expect(mocks.originals.size).toBe(0);
  });

  it("keeps default import durable before parsing while prepare has no storage side effects", async () => {
    mocks.pages = ["first page", new Error("damaged page")];
    mocks.destroy.mockImplementationOnce(() => {
      expect(mocks.putBlob).toHaveBeenCalledOnce();
      expect(mocks.originals.size).toBe(1);
    });
    const file = new File(["%PDF original bytes"], "partial.pdf");
    const imported = await importFile(file, "");
    expect(imported.status).toBe("partial");
    expect(mocks.originals.get(imported.blobKey!)).toBe(file);
    mocks.putBlob.mockClear();
    const candidate = await prepareFile(
      new File(["%PDF replacement bytes"], "replacement.pdf"),
      "",
    );
    expect(candidate.status).toBe("partial");
    expect(mocks.putBlob).not.toHaveBeenCalled();
    expect(mocks.originals.has(candidate.blobKey!)).toBe(false);
  });

  it("previews a candidate without changing the existing workspace or any original", async () => {
    const { data, source } = await fixture();
    const before = structuredClone(data);
    const { candidate } = await prepared();
    expect(data).toEqual(before);
    expect(source.versions).toBeUndefined();
    expect(mocks.originals.has(candidate.blobKey!)).toBe(false);
    expect(mocks.putBlob).toHaveBeenCalledOnce();
  });

  it("keeps three versions and saved evidence exact through TXT → Markdown → TXT", async () => {
    const { data, source } = await fixture();
    const oldCitation = addSavedEvidence(data, source);
    const before = structuredClone(data);
    const second = (await prepared(secondText, "revised.md")).candidate;
    const v2 = replaceFileSource(data, source.id, source.versionId, second);
    const secondCitation = addSavedEvidence(v2, v2.sources[0]);
    const third = (await prepared(thirdText, "final.txt")).candidate;
    const v3 = replaceFileSource(v2, source.id, second.versionId, third);
    const current = v3.sources[0];
    expect(v3.sources).toHaveLength(1);
    expect(current.id).toBe(source.id);
    expect(current.versionId).toBe(third.versionId);
    expect(
      current.versions?.map((version) => [version.versionId, version.kind, version.text]),
    ).toEqual([
      [second.versionId, "markdown", secondText],
      [source.versionId, "text", firstText],
    ]);
    expect(
      current.chunks.every(
        (chunk) => chunk.sourceId === source.id && chunk.versionId === third.versionId,
      ),
    ).toBe(true);
    expect(
      new Set(
        [source, v2.sources[0], current].flatMap((version) =>
          version.chunks.map((chunk) => chunk.id),
        ),
      ).size,
    ).toBe(3);
    expect(resolveSavedCitation(v3, oldCitation)?.chunk.text).toBe(firstText);
    expect(resolveSavedCitation(v3, secondCitation)?.chunk.text).toBe(secondText);
    expect(v3.annotations).toEqual(v2.annotations);
    expect(v3.notes).toEqual(v2.notes);
    expect(v3.conversations).toEqual(v2.conversations);
    expect(data).toEqual(before);
    expect(workspaceSchema.safeParse(JSON.parse(JSON.stringify(v3))).success).toBe(true);
  });

  it("retains human metadata while replacing filename, format and original handle", async () => {
    const { data, source } = await fixture();
    data.spaces.push({ ...data.spaces[0], id: "second-library", name: "共享归属" });
    Object.assign(source, {
      title: "人工命名",
      spaceIds: data.spaces.map((space) => space.id),
      tags: ["手动标签"],
      tagsLocked: true,
      tagsRevision: 7,
      aiAllowed: false,
      starred: true,
      readPage: 4,
      readOffset: 190,
      storagePath: `user/${source.id}/${source.versionId}/original.txt`,
      createdAt: "2026-01-01T00:00:00.000Z",
      versionCreatedAt: "2026-02-01T00:00:00.000Z",
    });
    const { candidate } = await prepared(secondText, "new-name.markdown");
    const current = replaceFileSource(data, source.id, source.versionId, candidate).sources[0];
    expect(current).toMatchObject({
      id: source.id,
      title: source.title,
      createdAt: source.createdAt,
      spaceIds: source.spaceIds,
      tags: source.tags,
      tagsLocked: true,
      tagsRevision: 7,
      aiAllowed: false,
      starred: true,
      filename: candidate.filename,
      kind: "markdown",
      mime: candidate.mime,
      hash: candidate.hash,
      blobKey: candidate.blobKey,
      size: candidate.size,
      versionCreatedAt: candidate.versionCreatedAt ?? candidate.createdAt,
    });
    expect(current.storagePath).toBeUndefined();
    expect(current.readPage).toBeUndefined();
    expect(current.readOffset).toBe(0);
    expect(current.versions![0]).toMatchObject({
      filename: "original.txt",
      title: "人工命名",
      kind: "text",
      blobKey: source.blobKey,
      storagePath: source.storagePath,
      createdAt: source.versionCreatedAt,
    });
    expect(current.versions![0]).not.toHaveProperty("spaceIds");
    expect(current.versions![0]).not.toHaveProperty("aiAllowed");
    expect(current.versions![0]).not.toHaveProperty("versions");
  });

  it("keeps old physical PDF pages and parser warnings when the current file becomes TXT", async () => {
    mocks.pages = ["amberarchive page one", "", "amberarchive page three"];
    const { data, source } = await fixture("%PDF fixture", "old.pdf");
    source.readPage = 3;
    const oldCitation = cite(source, 1);
    const { candidate } = await prepared();
    const next = replaceFileSource(data, source.id, source.versionId, candidate);
    const historical = getSourceVersion(next.sources[0], source.versionId)!;
    expect(historical).toMatchObject({
      kind: "pdf",
      pageCount: 3,
      parsedPages: 2,
      status: "partial",
      error: source.error,
    });
    expect(historical.chunks.map((chunk) => chunk.page)).toEqual([1, 3]);
    expect(resolveSavedCitation(next, oldCitation)?.chunk.page).toBe(3);
    expect(next.sources[0].pageCount).toBeUndefined();
    expect(next.sources[0].parsedPages).toBeUndefined();
    expect(next.sources[0].error).toBeUndefined();
    expect(next.sources[0].chunks.every((chunk) => chunk.page === undefined)).toBe(true);
    expect(historical.readPage).toBeUndefined();
  });

  it("takes new PDF page metadata when replacing a text file", async () => {
    const { data, source } = await fixture();
    mocks.pages = ["revised first page", "revised second page"];
    const { candidate } = await prepared("%PDF revision", "new.pdf");
    const current = replaceFileSource(data, source.id, source.versionId, candidate).sources[0];
    expect(current).toMatchObject({ kind: "pdf", pageCount: 2, parsedPages: 2, status: "ready" });
    expect(current.chunks.map((chunk) => chunk.page)).toEqual([1, 2]);
    const historical = getSourceVersion(current, source.versionId)!;
    expect(historical.kind).toBe("text");
    expect(historical.pageCount).toBeUndefined();
    expect(historical.parsedPages).toBeUndefined();
  });

  it("parses a self-authored DOCX candidate and retains the prior TXT original", async () => {
    const { data, source } = await fixture();
    const document = new JSZip();
    document.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    );
    document.file(
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    document.file(
      "word/_rels/document.xml.rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    );
    document.file(
      "word/styles.xml",
      '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style></w:styles>',
    );
    document.file(
      "word/document.xml",
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>DOCX section</w:t></w:r></w:p><w:p><w:r><w:t>DOCX replacement preserves original evidence.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Speed</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    );
    const file = new File([await document.generateAsync({ type: "arraybuffer" })], "new.docx");
    mocks.putBlob.mockClear();
    const candidate = await prepareFile(file, "");
    expect(candidate).toMatchObject({
      kind: "docx",
      status: "ready",
      text: "DOCX section\n\nDOCX replacement preserves original evidence.\n\nName\n\nValue\n\nSpeed\n\n42",
    });
    expect(candidate.chunks.map((chunk) => [chunk.text, chunk.section])).toEqual([
      ["DOCX section", "DOCX section"],
      ["DOCX replacement preserves original evidence.", "DOCX section"],
      [
        "Name\n\nValue\n\nSpeed\n\n42",
        "DOCX section · 表格 1 · 第 1–2 行 · 2 列；首行各列：1:“Name”；2:“Value”",
      ],
    ]);
    expect(mocks.putBlob).not.toHaveBeenCalled();
    const next = replaceFileSource(data, source.id, source.versionId, candidate);
    const current = next.sources[0];
    expect(current.filename).toBe("new.docx");
    expect(current.mime).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(getSourceVersion(current, source.versionId)?.blobKey).toBe(source.blobKey);
    const tableCitation = cite(current, 2);
    expect(resolveCitation(next, tableCitation)?.chunk).toMatchObject({
      sourceId: source.id,
      versionId: current.versionId,
      text: "Name\n\nValue\n\nSpeed\n\n42",
      section: candidate.chunks[2].section,
    });
  });

  it("clones archived and new content instead of aliasing caller-owned chunk arrays", async () => {
    const { source, current, candidate } = await replaced();
    const old = structuredClone(current.versions![0]);
    source.chunks[0].text = "changed original input";
    candidate.chunks[0].text = "changed prepared input";
    expect(current.versions![0]).toEqual(old);
    expect(current.chunks[0].text).toBe(secondText);
  });
});

describe("current-only generation and explicit new file versions", () => {
  it("never pulls retained old text into new retrieval or model grounding", async () => {
    const { data, source, next, current } = await replaced();
    expect(resolveCitation(next, cite(source))).toBeNull();
    expect(resolveSavedCitation(next, cite(source))).not.toBeNull();
    expect(retrieveEvidence(next, question(current, "amberarchive")).citations).toEqual([]);
    expect(retrieveEvidence(next, question(current, "bluecurrent")).citations).toEqual([
      cite(current),
    ]);
    const grounding = buildGrounding(next, question(current, "总结这份资料"));
    expect(grounding.evidence.length).toBeGreaterThan(0);
    expect(grounding.evidence.every((chunk) => chunk.versionId === current.versionId)).toBe(true);
    expect(JSON.stringify(grounding.evidence)).not.toContain("amberarchive");
    const request = question(current, "bluecurrent");
    expect(questionContextKey(data, request)).not.toBe(questionContextKey(next, request));
    const changedHistory = structuredClone(next);
    changedHistory.sources[0].versions![0].text = "historical-only change";
    expect(questionContextKey(changedHistory, request)).toBe(questionContextKey(next, request));
  });

  it("rejects identical current bytes even with a different filename", async () => {
    const { data } = await fixture();
    const { candidate } = await prepared(firstText, "renamed.md");
    expectAtomicFailure(data, candidate, /相同|重复|一致|变化/);
    expect(data.sources[0].versions).toBeUndefined();
  });

  it("accepts bytes matching a historical file as a newly identified explicit version", async () => {
    const { source, next, current } = await replaced();
    const { candidate } = await prepared(firstText, "restored.txt");
    expect(candidate.hash).toBe(source.hash);
    const restored = replaceFileSource(next, source.id, current.versionId, candidate).sources[0];
    expect(restored.versionId).toBe(candidate.versionId);
    expect(restored.versionId).not.toBe(source.versionId);
    expect(restored.blobKey).not.toBe(source.blobKey);
    expect(restored.chunks[0].id).not.toBe(source.chunks[0].id);
    expect(restored.versions?.map((version) => version.versionId)).toEqual([
      current.versionId,
      source.versionId,
    ]);
    expect(getSourceVersion(restored, source.versionId)?.blobKey).toBe(source.blobKey);
  });

  it.each(["empty-txt", "scanned-pdf"])(
    "retains a confirmed %s as failed without erasing old readable content",
    async (kind) => {
      const { data, source } = await fixture();
      mocks.pages = ["", ""];
      const { candidate } =
        kind === "empty-txt"
          ? await prepared(" \n", "empty.txt")
          : await prepared("%PDF scan", "scan.pdf");
      expect(candidate.status).toBe("failed");
      expect(candidate.error).toContain("尚未保存");
      const next = replaceFileSource(data, source.id, source.versionId, candidate);
      expect(next.sources[0]).toMatchObject({
        status: "failed",
        text: "",
        chunks: [],
        blobKey: candidate.blobKey,
      });
      expect(next.sources[0].error).toContain("已保存");
      expect(candidate.error).toContain("尚未保存");
      expect(getSourceVersion(next.sources[0], source.versionId)?.text).toBe(firstText);
      expect(resolveSavedCitation(next, cite(source))).not.toBeNull();
      expect(retrieveEvidence(next, question(next.sources[0], "amberarchive")).citations).toEqual(
        [],
      );
    },
  );
});

describe("file replacement rejects unsafe or stale candidates atomically", () => {
  it("rejects a prepared version after a concurrent replacement wins", async () => {
    const { source, next } = await replaced();
    const { candidate } = await prepared(thirdText);
    const before = structuredClone(next);
    expect(() => replaceFileSource(next, source.id, source.versionId, candidate)).toThrow(
      /版本|预览/,
    );
    expect(next).toEqual(before);
  });

  it.each(["deleted", "archived-library", "missing-library", "web-target"])(
    "rejects unavailable target: %s",
    async (kind) => {
      const { data, source } = await fixture();
      if (kind === "deleted") source.deletedAt = source.createdAt;
      if (kind === "archived-library") data.spaces[0].archived = true;
      if (kind === "missing-library") source.spaceIds = ["missing-library"];
      if (kind === "web-target")
        data.sources[0] = makeWebSource({
          url: "https://example.com/article",
          title: "网页",
          text: firstText,
          spaceId: "",
        });
      expectAtomicFailure(data, (await prepared()).candidate);
    },
  );

  it.each([
    "web",
    "saved",
    "parsing",
    "link-only",
    "missing-hash",
    "invalid-hash",
    "uppercase-hash",
    "missing-blob",
    "wrong-blob",
    "wrong-mime",
    "empty-filename",
    "oversized",
    "ready-without-chunks",
    "failed-with-chunks",
    "cloud-path",
    "url",
    "web-snapshot",
    "deleted",
    "wrong-chunk-source",
    "wrong-chunk-version",
    "invented-chunk-text",
    "duplicate-chunk",
    "nested-history",
  ])("rejects malformed prepared input: %s", async (kind) => {
    const { data } = await fixture();
    const { candidate } = await prepared();
    if (kind === "web") candidate.kind = "web";
    if (kind === "saved" || kind === "parsing" || kind === "link-only") candidate.status = kind;
    if (kind === "missing-hash") candidate.hash = "";
    if (kind === "invalid-hash") candidate.hash = "g".repeat(64);
    if (kind === "uppercase-hash") candidate.hash = "A".repeat(64);
    if (kind === "missing-blob") delete candidate.blobKey;
    if (kind === "wrong-blob") candidate.blobKey = "original:other-source:other-version";
    if (kind === "wrong-mime") candidate.mime = "application/pdf";
    if (kind === "empty-filename") candidate.filename = " ";
    if (kind === "oversized") candidate.size = 30 * 1024 * 1024 + 1;
    if (kind === "ready-without-chunks") candidate.chunks = [];
    if (kind === "failed-with-chunks") candidate.status = "failed";
    if (kind === "cloud-path") candidate.storagePath = "different-account/private/original.txt";
    if (kind === "url") candidate.url = "https://example.com/article";
    if (kind === "web-snapshot")
      candidate.webSnapshot = makeWebSource({
        url: "https://example.com/article",
        title: "网页",
        text: firstText,
        spaceId: "",
      }).webSnapshot;
    if (kind === "deleted") candidate.deletedAt = candidate.createdAt;
    if (kind === "wrong-chunk-source") candidate.chunks[0].sourceId = "other-source";
    if (kind === "wrong-chunk-version") candidate.chunks[0].versionId = "other-version";
    if (kind === "invented-chunk-text") candidate.chunks[0].text = "not in candidate text";
    if (kind === "duplicate-chunk") candidate.chunks.push({ ...candidate.chunks[0] });
    if (kind === "nested-history") candidate.versions = (await replaced()).current.versions;
    expectAtomicFailure(data, candidate);
  });

  it.each(["current", "historical"])(
    "rejects a repeated %s version identity despite different bytes",
    async (kind) => {
      const { source, next, current } = await replaced();
      const { candidate } = await prepared(thirdText);
      candidate.versionId = kind === "current" ? current.versionId : source.versionId;
      candidate.blobKey = `original:${candidate.id}:${candidate.versionId}`;
      candidate.chunks.forEach((chunk) => {
        chunk.versionId = candidate.versionId;
      });
      expectAtomicFailure(next, candidate);
    },
  );

  it.each(["live-current", "deleted-current", "live-history", "deleted-history"])(
    "does not reuse an original handle belonging to another source: %s",
    async (kind) => {
      const { data } = await fixture();
      const { candidate } = await prepared();
      let owner = structuredClone(candidate);
      if (kind.endsWith("history")) {
        const otherData = createEmptyWorkspace();
        otherData.sources.push(owner);
        owner = replaceFileSource(
          otherData,
          owner.id,
          owner.versionId,
          (await prepared(thirdText)).candidate,
        ).sources[0];
      }
      if (kind.startsWith("deleted")) owner.deletedAt = owner.createdAt;
      data.sources.push(owner);
      expectAtomicFailure(data, candidate, /原件标识已使用/);
    },
  );
});

describe("flat source history, limits and exact original exports", () => {
  it("stores mixed non-web history without copying current identity, permissions or read progress", async () => {
    const { next, current, source } = await replaced();
    const stored = JSON.parse(JSON.stringify(current.versions![0]));
    expect(stored).toMatchObject({
      versionId: source.versionId,
      hash: source.hash,
      blobKey: source.blobKey,
    });
    for (const key of ["id", "spaceIds", "tags", "aiAllowed", "readOffset", "versions"])
      expect(stored).not.toHaveProperty(key);
    expect(stored.createdAt).toBe(source.versionCreatedAt ?? source.createdAt);
    expect(stored.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(workspaceSchema.safeParse(next).success).toBe(true);
    current.aiAllowed = false;
    current.spaceIds = [];
    current.deletedAt = current.createdAt;
    expect(getSourceVersion(current, source.versionId)).toMatchObject({
      aiAllowed: false,
      spaceIds: [],
      deletedAt: current.deletedAt,
      readOffset: 0,
    });
    expect(resolveSavedCitation(next, cite(source))).toBeNull();
  });

  it.each(["web-history", "web-current"])("rejects file/web history mixing: %s", async (kind) => {
    const { next, current } = await replaced();
    if (kind === "web-history") current.versions![0].kind = "web";
    else current.kind = "web";
    expect(workspaceSchema.safeParse(next).success).toBe(false);
  });

  it("keeps the last allowed history record and rejects the next replacement without eviction", async () => {
    const { next, current } = await replaced();
    const template = current.versions![0];
    current.versions = Array.from(
      { length: MAX_SOURCE_VERSIONS - 1 },
      (_, index): SourceVersion => ({
        ...structuredClone(template),
        versionId: `old-${index}`,
        blobKey: `original:${current.id}:old-${index}`,
        chunks: template.chunks.map((chunk, number) => ({
          ...chunk,
          id: `chunk-${index}-${number}`,
          versionId: `old-${index}`,
        })),
      }),
    );
    expect(workspaceSchema.safeParse(next).success).toBe(true);
    const lastCandidate = (await prepared(thirdText)).candidate;
    const last = replaceFileSource(next, current.id, current.versionId, lastCandidate);
    expect(last.sources[0].versions).toHaveLength(MAX_SOURCE_VERSIONS);
    const retained = structuredClone(last.sources[0].versions);
    expectAtomicFailure(last, (await prepared("new fourth revision")).candidate, /上限/);
    expect(last.sources[0].versions).toEqual(retained);
  });

  it("rejects a full valid old/new workspace over 3 MiB without losing old content or originals", async () => {
    const { data, source } = await fixture();
    addSavedEvidence(data, source);
    data.notes[0].content = "";
    const overhead = new TextEncoder().encode(JSON.stringify(data)).byteLength;
    data.notes[0].content = "x".repeat(MAX_WORKSPACE_BYTES - overhead - 3000);
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBe(
      MAX_WORKSPACE_BYTES - 3000,
    );
    expect(workspaceSchema.safeParse(data).success).toBe(true);
    const { candidate } = await prepared("new file sentence. ".repeat(800));
    expectAtomicFailure(data, candidate, /3 MiB/);
    expect(source.versions).toBeUndefined();
    expect(await mocks.originals.get(source.blobKey!)!.text()).toBe(firstText);
    expect(mocks.originals.has(candidate.blobKey!)).toBe(false);
  });

  it("exports every version's exact bytes, format, chunks and old/new citation paths", async () => {
    mocks.pages = ["amberarchive page one", "", "amberarchive page three"];
    const { data, source, file } = await fixture("%PDF self-authored original\u0000", "old.pdf");
    addSavedEvidence(data, source);
    const middle = await prepared(secondText, "middle.md");
    const next = replaceFileSource(data, source.id, source.versionId, middle.candidate);
    const last = await prepared(thirdText, "current.txt");
    const final = replaceFileSource(next, source.id, middle.candidate.versionId, last.candidate);
    addSavedEvidence(final, final.sources[0]);
    // The coordinator stores confirmed uploads; this map substitutes only that durable step.
    mocks.originals.set(middle.candidate.blobKey!, middle.file);
    mocks.originals.set(last.candidate.blobKey!, last.file);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(final), { checkCRC32: true });
    type Mapping = {
      versionId: string;
      original: string;
      metadata: string;
      extractedText: string;
      chunks: string;
      versions: Mapping[];
    };
    const mapping: Mapping = JSON.parse(await zip.file("source-mapping.json")!.async("string"))[0];
    const expected = [
      { source: final.sources[0], file: last.file },
      {
        source: getSourceVersion(final.sources[0], middle.candidate.versionId)!,
        file: middle.file,
      },
      { source, file },
    ];
    for (const [index, entry] of [mapping, ...mapping.versions].entries()) {
      expect(entry.versionId).toBe(expected[index].source.versionId);
      expect(await zip.file(entry.original)!.async("uint8array")).toEqual(
        new Uint8Array(await expected[index].file.arrayBuffer()),
      );
      expect(await zip.file(entry.extractedText)!.async("string")).toBe(
        expected[index].source.text,
      );
      expect(JSON.parse(await zip.file(entry.chunks)!.async("string"))).toEqual(
        expected[index].source.chunks,
      );
      expect(JSON.parse(await zip.file(entry.metadata)!.async("string"))).toMatchObject({
        kind: expected[index].source.kind,
        filename: expected[index].source.filename,
        blobKey: expected[index].source.blobKey,
      });
    }
    expect(new Set([mapping, ...mapping.versions].map((entry) => entry.original)).size).toBe(3);
    expect(mapping.versions).toHaveLength(2); // The middle version has no saved citation.
    const noteMappings: { citations: string }[] = JSON.parse(
      await zip.file("note-mapping.json")!.async("string"),
    );
    const oldCitation = JSON.parse(await zip.file(noteMappings[0].citations)!.async("string"))[0];
    const newCitation = JSON.parse(await zip.file(noteMappings[1].citations)!.async("string"))[0];
    expect(oldCitation).toMatchObject({
      versionId: source.versionId,
      page: 1,
      sourceAvailability: "historical",
      sourceMetadata: mapping.versions[1].metadata,
    });
    expect(newCitation).toMatchObject({
      versionId: last.candidate.versionId,
      sourceAvailability: "included",
      sourceMetadata: mapping.metadata,
    });
    expect(JSON.parse(await zip.file("annotations.json")!.async("string"))).toEqual(
      final.annotations,
    );
    expect(
      workspaceSchema.safeParse(JSON.parse(await zip.file("workspace.json")!.async("string")))
        .success,
    ).toBe(true);
  });

  it("reports a missing historical original without substituting the current file", async () => {
    const { source, next, current, nextFile } = await replaced();
    mocks.originals.delete(source.blobKey!);
    mocks.originals.set(current.blobKey!, nextFile);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(next));
    const mapping = JSON.parse(await zip.file("source-mapping.json")!.async("string"))[0];
    expect(mapping.original).toBeTruthy();
    expect(mapping.versions[0].original).toBeNull();
    expect(mapping.versions[0].originalStatus).toContain("缺少");
    expect(await zip.file(mapping.versions[0].extractedText)!.async("string")).toBe(firstText);
    expect(await zip.file("README.txt")!.async("string")).toContain("原文件缺失：1 份");
  });
});
