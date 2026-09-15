import { describe, expect, it } from "vitest";
import { makeWebSource } from "./import";
import { makeCapturedWebSource } from "./web-import";
import { createEmptyWorkspace } from "./seed";
import {
  MAX_SOURCE_VERSIONS,
  getSourceVersion,
  refreshWebSource,
  restoreArchivedSourceVersion,
} from "./source-versions";
import { resolveCitation, resolveSavedCitation, retrieveEvidence } from "./retrieval";
import { buildGrounding } from "./ai/grounding";
import { questionContextKey } from "./question-context";
import { organizationUnavailableReason } from "./organization";
import { MAX_WORKSPACE_BYTES, workspaceSchema } from "./supabase/validation";
import type { AnswerRequest, Citation, Source, SourceVersion, WorkspaceData } from "./types";

const url = "https://article.example/learning#chapter";
const textOne =
  "# 学习方法\n\namberarchive identifies the original explanation, with its original conditions.";
const textTwo =
  "# 学习方法\n\nbluecurrent identifies a revised explanation, with a newly recorded example.";
const textThree =
  "# 学习方法\n\ngreencurrent identifies the latest explanation and the latest applicable conditions.";

function capture(text: string, number = 1, scope: "article" | "selection" | "link" = "article") {
  return makeCapturedWebSource({
    preview: {
      originalUrl: url,
      finalUrl: `https://article.example/captured-${number}`,
      title: `网站标题 ${number}`,
      text,
      excerpt: "测试摘要",
      capturedAt: `2026-09-12T12:0${number}:00.000Z`,
      warnings: [`第 ${number} 次提取的覆盖说明。`],
      byline: `作者 ${number}`,
      siteName: `站点 ${number}`,
      kind: "article",
    },
    spaceId: "",
    scope,
    aiAllowed: true,
    ...(scope === "selection" ? { text: text.split("\n\n").at(-1) } : {}),
  });
}
function fixture() {
  const data = createEmptyWorkspace();
  const source = capture(textOne);
  data.sources.push(source);
  return { data, source };
}
function citation(source: Source): Citation {
  const chunk = source.chunks.find((item) => !item.text.startsWith("#"))!;
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
function question(source: Source, value = "greencurrent"): AnswerRequest {
  return {
    question: value,
    scope: "document",
    sourceId: source.id,
    sourceIds: [],
    spaceId: "inbox",
  };
}
function replaced() {
  const { data, source } = fixture();
  const next = refreshWebSource(data, source.id, source.versionId, capture(textTwo, 2));
  return { data, source, next, current: next.sources[0] };
}
function expectAtomicFailure(
  data: WorkspaceData,
  source: Source,
  candidate: Source,
  reason?: RegExp,
) {
  const before = structuredClone(data);
  const inputBefore = structuredClone(candidate);
  if (reason)
    expect(() => refreshWebSource(data, source.id, source.versionId, candidate)).toThrow(reason);
  else expect(() => refreshWebSource(data, source.id, source.versionId, candidate)).toThrow();
  expect(data).toEqual(before);
  expect(candidate).toEqual(inputBefore);
}

describe("WEB-04 retained web versions", () => {
  it("AT-06 keeps the source identity and all old bodies/citations across v1 → v2 → v3", () => {
    const { data, source } = fixture();
    const oldCitation = citation(source);
    data.notes.push({
      id: "saved-note",
      spaceId: "inbox",
      title: "旧解释",
      content: oldCitation.quote,
      kind: "knowledge",
      status: "accepted",
      citations: [oldCitation],
      versions: [],
      createdAt: source.createdAt,
      updatedAt: source.createdAt,
      deletedAt: null,
    });
    data.annotations.push({
      id: "saved-annotation",
      sourceId: source.id,
      versionId: source.versionId,
      quote: oldCitation.quote,
      note: "先前的笔记",
      createdAt: source.createdAt,
    });
    data.conversations.push({
      id: "saved-chat",
      sourceId: source.id,
      sourceIds: [source.id],
      spaceId: "inbox",
      title: "旧问答",
      scope: "document",
      resolved: false,
      updatedAt: source.createdAt,
      messages: [
        {
          id: "saved-answer",
          role: "assistant",
          content: "先前回答",
          citations: [oldCitation],
          createdAt: source.createdAt,
        },
      ],
    });
    const before = structuredClone(data);
    const candidateTwo = capture(textTwo, 2);
    const second = refreshWebSource(data, source.id, source.versionId, candidateTwo);
    const v2Citation = citation(second.sources[0]);
    const third = refreshWebSource(
      second,
      source.id,
      second.sources[0].versionId,
      capture(textThree, 3),
    );
    const current = third.sources[0];
    expect(third.sources).toHaveLength(1);
    expect(current.id).toBe(source.id);
    expect(current.versionId).not.toBe(source.versionId);
    expect(current.versionId).not.toBe(candidateTwo.versionId);
    expect(current.text).toBe(textThree);
    expect(current.versions?.map((version) => version.text)).toEqual([textTwo, textOne]);
    expect(getSourceVersion(current, source.versionId)?.text).toBe(textOne);
    expect(getSourceVersion(current, candidateTwo.versionId)?.text).toBe(textTwo);
    expect(resolveSavedCitation(third, oldCitation)?.chunk.text).toBe(oldCitation.quote);
    expect(resolveSavedCitation(third, v2Citation)?.chunk.text).toBe(v2Citation.quote);
    expect(third.notes).toEqual(before.notes);
    expect(third.conversations).toEqual(before.conversations);
    expect(third.annotations).toEqual(before.annotations);
    expect(data).toEqual(before);
    expect(second.sources[0].text).toBe(textTwo);
    expect(workspaceSchema.safeParse(third).success).toBe(true);
  });

  it("keeps only the current version in new retrieval and model grounding", () => {
    const { source, next, current } = replaced();
    expect(resolveCitation(next, citation(source))).toBeNull();
    expect(resolveSavedCitation(next, citation(source))).not.toBeNull();
    expect(retrieveEvidence(next, question(current, "amberarchive")).citations).toEqual([]);
    const answer = retrieveEvidence(next, question(current, "bluecurrent"));
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations.every((item) => item.versionId === current.versionId)).toBe(true);
    const grounding = buildGrounding(next, question(current, "总结这份资料"));
    expect(grounding.evidence.length).toBeGreaterThan(0);
    expect(grounding.evidence.every((item) => item.versionId === current.versionId)).toBe(true);
    expect(JSON.stringify(grounding.evidence)).not.toContain("amberarchive");
  });

  it("invalidates old generation requests while historical-only changes stay outside new context keys", () => {
    const { data, source, next, current } = replaced();
    const request = question(current, "bluecurrent");
    expect(questionContextKey(data, request)).not.toBe(questionContextKey(next, request));
    const changedHistory = structuredClone(next);
    changedHistory.sources[0].versions![0].text = "archival note changed";
    expect(questionContextKey(changedHistory, request)).toBe(questionContextKey(next, request));
    expect(
      organizationUnavailableReason(next, {
        requestId: "old-analysis",
        kind: "source",
        trigger: "manual",
        spaceId: "inbox",
        sourceIds: [source.id],
        sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
      }),
    ).toMatch(/版本/);
  });

  it("never aliases archived content or candidate arrays to mutable caller input", () => {
    const { data, source } = fixture();
    const candidate = capture(textTwo, 2);
    const next = refreshWebSource(data, source.id, source.versionId, candidate);
    const archived = structuredClone(next.sources[0].versions![0]);
    source.chunks[1].text = "mutated old input";
    source.webSnapshot!.warnings.push("mutated old warning");
    candidate.chunks[1].text = "mutated new input";
    candidate.webSnapshot!.warnings.push("mutated new warning");
    expect(next.sources[0].versions![0]).toEqual(archived);
    expect(next.sources[0].chunks[1].text).not.toContain("mutated");
    expect(next.sources[0].webSnapshot!.warnings).not.toContain("mutated new warning");
  });

  it("preserves human title, tags, permissions, favorite and all current library memberships", () => {
    const { data, source } = fixture();
    data.spaces.push({ ...data.spaces[0], id: "second-library", name: "另一个库" });
    Object.assign(source, {
      title: "我的标题",
      filename: "我的文件名.txt",
      tags: ["手动标签"],
      tagsLocked: true,
      tagsRevision: 7,
      aiAllowed: false,
      starred: true,
      spaceIds: data.spaces.map((space) => space.id),
      readOffset: 900,
      readPage: 4,
      lastReadAt: "2026-09-12T10:00:00.000Z",
      readingPositionAlternatives: [
        {
          origin: "remote",
          readPage: 2,
          readOffset: 450,
          lastReadAt: "2026-09-11T10:00:00.000Z",
        },
      ],
    });
    const candidate = capture(textTwo, 2);
    Object.assign(candidate, {
      title: "网站改名",
      tags: ["不应覆盖"],
      aiAllowed: true,
      starred: false,
      spaceIds: [],
    });
    const current = refreshWebSource(data, source.id, source.versionId, candidate).sources[0];
    for (const key of [
      "id",
      "title",
      "filename",
      "tags",
      "tagsLocked",
      "tagsRevision",
      "aiAllowed",
      "starred",
      "spaceIds",
      "createdAt",
    ] as const)
      expect(current[key]).toEqual(source[key]);
    expect(current.readOffset).toBe(0);
    expect(current.readPage).toBeUndefined();
    expect(current.lastReadAt).toBeUndefined();
    expect(current.readingPositionAlternatives).toBeUndefined();
    expect(
      current.chunks.every(
        (chunk) => chunk.sourceId === source.id && chunk.versionId === candidate.versionId,
      ),
    ).toBe(true);
    expect(getSourceVersion(current, source.versionId)).toMatchObject({
      aiAllowed: false,
      starred: true,
      tags: source.tags,
      spaceIds: source.spaceIds,
    });
  });

  it("clears optional content fields on replacement but retains them in their own old version", () => {
    const { data, source } = fixture();
    Object.assign(source, {
      error: "旧提取提示",
      blobKey: "old-original",
      storagePath: "owner/old-original",
      pageCount: 3,
      parsedPages: 2,
    });
    const current = refreshWebSource(data, source.id, source.versionId, capture(textTwo, 2))
      .sources[0];
    for (const key of ["error", "blobKey", "storagePath", "pageCount", "parsedPages"] as const)
      expect(current[key]).toBeUndefined();
    expect(getSourceVersion(current, source.versionId)).toMatchObject({
      error: "旧提取提示",
      blobKey: "old-original",
      storagePath: "owner/old-original",
      pageCount: 3,
      parsedPages: 2,
    });
  });

  it("does not fill missing historical metadata, errors, blobs or reading position from the live version", () => {
    const { data, source } = fixture();
    delete source.webSnapshot;
    source.readOffset = 111;
    const candidate = capture(textTwo, 2);
    Object.assign(candidate, {
      error: "新提示",
      blobKey: "new-original",
      storagePath: "owner/new-original",
      pageCount: 7,
      parsedPages: 6,
    });
    const current = refreshWebSource(data, source.id, source.versionId, candidate).sources[0];
    current.readOffset = 999;
    current.readPage = 6;
    current.readingPositionAlternatives = [
      {
        origin: "local",
        readPage: 5,
        readOffset: 888,
        lastReadAt: "2026-09-12T14:00:00.000Z",
      },
    ];
    const historic = getSourceVersion(current, source.versionId)!;
    expect(historic.text).toBe(textOne);
    expect(historic.versionCreatedAt).toBe(source.createdAt);
    expect(historic.readOffset).toBe(0);
    for (const key of [
      "readPage",
      "webSnapshot",
      "error",
      "blobKey",
      "storagePath",
      "pageCount",
      "parsedPages",
      "readingPositionAlternatives",
    ] as const)
      expect(historic[key]).toBeUndefined();
  });

  it("keeps history flat through multiple replacements", () => {
    const { source, next, current } = replaced();
    const third = refreshWebSource(next, source.id, current.versionId, capture(textThree, 3));
    for (const version of third.sources[0].versions!) {
      expect(version).not.toHaveProperty("versions");
      expect(version).not.toHaveProperty("readOffset");
      expect(version).not.toHaveProperty("spaceIds");
      expect(version).not.toHaveProperty("aiAllowed");
    }
  });

  it("retains selection, link-only and manually pasted captures with truthful scope", () => {
    const { data, source } = fixture();
    const second = refreshWebSource(
      data,
      source.id,
      source.versionId,
      capture(textTwo, 2, "selection"),
    );
    expect(second.sources[0]).toMatchObject({
      status: "ready",
      coverage: { captureScope: "selection", parseState: "complete" },
      webSnapshot: { method: "server", scope: "selection" },
    });
    expect(second.sources[0].text).toBe(textTwo.split("\n\n")[1]);
    const third = refreshWebSource(
      second,
      source.id,
      second.sources[0].versionId,
      capture(textThree, 3, "link"),
    );
    expect(third.sources[0]).toMatchObject({
      status: "link-only",
      text: "",
      chunks: [],
      webSnapshot: { scope: "link" },
    });
    expect(retrieveEvidence(third, question(source, "bluecurrent")).citations).toEqual([]);
    const pasted = makeWebSource({
      url,
      title: "手动标题",
      text: "用户手动粘贴的新说明。",
      spaceId: "",
    });
    const fourth = refreshWebSource(third, source.id, third.sources[0].versionId, pasted);
    expect(fourth.sources[0]).toMatchObject({
      status: "ready",
      text: pasted.text,
      webSnapshot: { method: "manual", scope: "pasted", finalUrl: url },
    });
    expect(fourth.sources[0].versions?.map((version) => version.webSnapshot?.scope)).toEqual([
      "link",
      "selection",
      "article",
    ]);
    expect(getSourceVersion(fourth.sources[0], second.sources[0].versionId)?.coverage).toEqual({
      captureScope: "selection",
      parseState: "complete",
    });
    expect(getSourceVersion(fourth.sources[0], third.sources[0].versionId)).toMatchObject({
      text: "",
      chunks: [],
      status: "link-only",
    });
  });

  it("restores old text only as a newly captured version without rewinding identity or citations", () => {
    const { source, next, current } = replaced();
    const restoreCandidate = makeWebSource({
      url,
      title: "恢复内容",
      text: source.text,
      spaceId: "",
    });
    const restored = refreshWebSource(next, source.id, current.versionId, restoreCandidate)
      .sources[0];
    expect(restored.id).toBe(source.id);
    expect(restored.versionId).toBe(restoreCandidate.versionId);
    expect(restored.versionId).not.toBe(source.versionId);
    expect(restored.text).toBe(textOne);
    expect(restored.webSnapshot?.method).toBe("manual");
    expect(restored.versions?.map((version) => version.versionId)).toEqual([
      current.versionId,
      source.versionId,
    ]);
    expect(getSourceVersion(restored, source.versionId)?.chunks).toEqual(source.chunks);
    expect(restored.chunks.map((chunk) => chunk.id)).not.toEqual(
      source.chunks.map((chunk) => chunk.id),
    );
  });
});

describe("archived source version restoration", () => {
  it("promotes the selected body and archives the previous current version without changing live metadata", () => {
    const { source, next, current } = replaced();
    Object.assign(current, {
      title: "我维护的资料名称",
      tags: ["人工标签"],
      tagsLocked: true,
      tagsRevision: 5,
      aiAllowed: false,
      starred: true,
      spaceIds: ["inbox"],
      readPage: 3,
      readOffset: 420,
      lastReadAt: "2026-09-13T10:00:00.000Z",
      readingPositionAlternatives: [
        {
          origin: "local",
          readPage: 8,
          readOffset: 1200,
          lastReadAt: "2026-09-12T18:00:00.000Z",
        },
      ],
    });
    const before = structuredClone(next);
    const restoredData = restoreArchivedSourceVersion(
      next,
      current.id,
      current.versionId,
      source.versionId,
    );
    const restored = restoredData.sources[0];

    expect(restored).toMatchObject({
      id: current.id,
      versionId: source.versionId,
      versionCreatedAt: current.versions![0].createdAt,
      text: textOne,
      title: "我维护的资料名称",
      tags: ["人工标签"],
      tagsLocked: true,
      tagsRevision: 5,
      aiAllowed: false,
      starred: true,
      spaceIds: ["inbox"],
      readOffset: 0,
    });
    expect(restored.readPage).toBeUndefined();
    expect(restored.lastReadAt).toBeUndefined();
    expect(restored.readingPositionAlternatives).toBeUndefined();
    expect(restored.versions?.map((version) => version.versionId)).toEqual([current.versionId]);
    expect(getSourceVersion(restored, current.versionId)).toMatchObject({ text: textTwo });
    expect(restored.versions![0].archivedAt).toEqual(expect.any(String));
    expect(restored.chunks.every((chunk) => chunk.versionId === source.versionId)).toBe(true);
    expect(next).toEqual(before);
    expect(workspaceSchema.safeParse(restoredData).success).toBe(true);
  });

  it("makes only the restored body eligible for new retrieval while both saved citation identities remain exact", () => {
    const { source, next, current } = replaced();
    const firstCitation = citation(source);
    const secondCitation = citation(current);
    const restoredData = restoreArchivedSourceVersion(
      next,
      current.id,
      current.versionId,
      source.versionId,
    );
    const restored = restoredData.sources[0];

    expect(retrieveEvidence(restoredData, question(restored, "amberarchive")).citations).toEqual([
      expect.objectContaining({ versionId: source.versionId }),
    ]);
    expect(retrieveEvidence(restoredData, question(restored, "bluecurrent")).citations).toEqual([]);
    expect(resolveSavedCitation(restoredData, firstCitation)?.chunk.text).toBe(firstCitation.quote);
    expect(resolveSavedCitation(restoredData, secondCitation)?.chunk.text).toBe(
      secondCitation.quote,
    );
  });

  it("can restore the just-archived version again without growing or duplicating history", () => {
    const { source, next, current } = replaced();
    const firstRestore = restoreArchivedSourceVersion(
      next,
      current.id,
      current.versionId,
      source.versionId,
    );
    const restored = firstRestore.sources[0];
    const secondRestore = restoreArchivedSourceVersion(
      firstRestore,
      restored.id,
      restored.versionId,
      current.versionId,
    );

    expect(secondRestore.sources[0].versionId).toBe(current.versionId);
    expect(secondRestore.sources[0].versions?.map((version) => version.versionId)).toEqual([
      source.versionId,
    ]);
    expect(new Set([secondRestore.sources[0].versionId, source.versionId]).size).toBe(2);
  });

  it.each([
    "stale-current",
    "missing-history",
    "deleted",
    "active-import",
    "processing-current",
    "processing-target",
  ])("rejects %s restoration without mutating the workspace", (kind) => {
    const { source, next, current } = replaced();
    if (kind === "deleted") current.deletedAt = "2026-09-13T12:00:00.000Z";
    if (kind === "processing-current") current.status = "parsing";
    if (kind === "processing-target") current.versions![0].status = "saved";
    if (kind === "active-import")
      next.importJobs = [
        {
          id: "active-import",
          sourceId: current.id,
          versionId: current.versionId,
          filename: current.filename,
          spaceId: "",
          status: "running",
          stage: "parsing",
          originalSaved: true,
          attempt: 1,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
        },
      ];
    const before = structuredClone(next);
    expect(() =>
      restoreArchivedSourceVersion(
        next,
        current.id,
        kind === "stale-current" ? "stale-version" : current.versionId,
        kind === "missing-history" ? "missing-version" : source.versionId,
      ),
    ).toThrow();
    expect(next).toEqual(before);
  });
});

describe("exact historical reading and invalid refreshes", () => {
  it("never substitutes the live version when a requested version is missing or ambiguous", () => {
    const { source, current } = replaced();
    expect(getSourceVersion(current, current.versionId)).toBe(current);
    expect(getSourceVersion(current, "missing-version")).toBeNull();
    const ambiguous = structuredClone(current);
    ambiguous.versions!.push(structuredClone(ambiguous.versions![0]));
    expect(getSourceVersion(ambiguous, source.versionId)).toBeNull();
  });

  it.each(["source", "version", "chunk", "quote"])(
    "does not resolve a forged historical citation %s",
    (field) => {
      const { source, next, current } = replaced();
      const forged = citation(source);
      if (field === "source") forged.sourceId = "missing-source";
      if (field === "version") forged.versionId = current.versionId;
      if (field === "chunk") forged.chunkId = current.chunks[1].id;
      if (field === "quote") forged.quote += " invented claim";
      expect(resolveSavedCitation(next, forged)).toBeNull();
    },
  );

  it("blocks historical citation reading for a deleted parent source", () => {
    const { source, next, current } = replaced();
    current.deletedAt = "2026-09-13T12:00:00.000Z";
    expect(resolveSavedCitation(next, citation(source))).toBeNull();
    expect(getSourceVersion(current, source.versionId)?.deletedAt).toBe(current.deletedAt);
  });

  it("rejects a stale preview after another refresh has already won", () => {
    const { source, next } = replaced();
    const before = structuredClone(next);
    expect(() =>
      refreshWebSource(next, source.id, source.versionId, capture(textThree, 3)),
    ).toThrow(/新版本|旧预览/);
    expect(next).toEqual(before);
  });

  it.each(["current", "historical"])("rejects a duplicate %s version ID", (kind) => {
    const { source, next, current } = replaced();
    const candidate = capture(textThree, 3);
    candidate.versionId = kind === "current" ? current.versionId : source.versionId;
    candidate.chunks = candidate.chunks.map((chunk) => ({
      ...chunk,
      versionId: candidate.versionId,
    }));
    expectAtomicFailure(next, current, candidate, /版本已保存/);
  });

  it.each(["different-origin", "different-path"])("rejects a changed original URL: %s", (kind) => {
    const { data, source } = fixture();
    const candidate = makeWebSource({
      url:
        kind === "different-origin"
          ? "https://other.example/learning#chapter"
          : "https://article.example/elsewhere",
      title: "其他网页",
      text: textTwo,
      spaceId: "",
    });
    expectAtomicFailure(data, source, candidate, /原始网址/);
  });

  it.each(["deleted", "archived", "missing-space", "not-web"])(
    "rejects an unavailable refresh target: %s",
    (kind) => {
      const { data, source } = fixture();
      if (kind === "deleted") source.deletedAt = source.createdAt;
      if (kind === "not-web") source.kind = "text";
      if (kind === "archived") {
        source.spaceIds = [data.spaces[0].id];
        data.spaces[0].archived = true;
      }
      if (kind === "missing-space") source.spaceIds = ["nonexistent-library"];
      expectAtomicFailure(data, source, capture(textTwo, 2), /不可用/);
    },
  );

  it.each(["wrong-source", "wrong-version", "nested-history", "deleted-candidate"])(
    "rejects malformed candidate %s without changing old data",
    (kind) => {
      const { data, source, current } = replaced();
      const candidate = capture(textTwo, 2);
      if (kind === "wrong-source") candidate.chunks[1].sourceId = "someone-elses-source";
      if (kind === "wrong-version") candidate.chunks[1].versionId = "someone-elses-version";
      if (kind === "nested-history") candidate.versions = structuredClone(current.versions);
      if (kind === "deleted-candidate") candidate.deletedAt = candidate.createdAt;
      expectAtomicFailure(data, source, candidate);
    },
  );
});

describe("history schema compatibility and capacity", () => {
  it("keeps old workspaces without history or web metadata valid", () => {
    const { data, source } = fixture();
    delete source.webSnapshot;
    expect(source.versions).toBeUndefined();
    expect(workspaceSchema.safeParse(data).success).toBe(true);
    const next = refreshWebSource(data, source.id, source.versionId, capture(textTwo, 2));
    expect(next.sources[0].versions![0].webSnapshot).toBeUndefined();
    expect(next.sources[0].versions![0].createdAt).toBe(source.createdAt);
    expect(workspaceSchema.safeParse(next).success).toBe(true);
  });

  it.each([
    "duplicate-version",
    "current-version",
    "wrong-source",
    "wrong-chunk-version",
    "wrong-chunk-text",
    "nested-history",
    "wrong-kind",
    "extra-source-id",
  ])("rejects tampered retained history: %s", (kind) => {
    const { next, current } = replaced();
    const retained = current.versions![0];
    if (kind === "duplicate-version") current.versions!.push(structuredClone(retained));
    if (kind === "current-version") {
      retained.versionId = current.versionId;
      retained.chunks.forEach((chunk) => {
        chunk.versionId = current.versionId;
      });
    }
    if (kind === "wrong-source") retained.chunks[1].sourceId = "different-source";
    if (kind === "wrong-chunk-version") retained.chunks[1].versionId = "different-version";
    if (kind === "wrong-chunk-text") retained.chunks[1].text = "fabricated old evidence";
    if (kind === "nested-history") Object.assign(retained, { versions: [] });
    if (kind === "wrong-kind") {
      retained.kind = "text";
      delete retained.webSnapshot;
    }
    if (kind === "extra-source-id") Object.assign(retained, { sourceId: "different-source" });
    expect(workspaceSchema.safeParse(next).success).toBe(false);
  });

  it("accepts the last allowed retained version, then refuses to silently evict older history", () => {
    const { next, current } = replaced();
    const template = current.versions![0];
    current.versions = Array.from({ length: MAX_SOURCE_VERSIONS - 1 }, (_, i): SourceVersion => ({
      ...structuredClone(template),
      versionId: `archive-${i}`,
      chunks: template.chunks.map((chunk, n) => ({
        ...chunk,
        id: `old-${i}-${n}`,
        versionId: `archive-${i}`,
      })),
    }));
    expect(workspaceSchema.safeParse(next).success).toBe(true);
    const last = refreshWebSource(next, current.id, current.versionId, capture(textThree, 3));
    expect(last.sources[0].versions).toHaveLength(MAX_SOURCE_VERSIONS);
    expectAtomicFailure(last, last.sources[0], capture(textTwo, 4), /上限/);
    expect(last.sources[0].versions?.at(-1)?.versionId).toBe(`archive-${MAX_SOURCE_VERSIONS - 2}`);
  });

  it("atomically refuses a valid replacement whose complete old/new workspace exceeds 3 MiB", () => {
    const { data, source } = fixture();
    data.notes.push({
      id: "near-capacity-note",
      spaceId: "inbox",
      title: "保留的笔记",
      content: "",
      kind: "note",
      status: "draft",
      citations: [],
      versions: [],
      createdAt: source.createdAt,
      updatedAt: source.createdAt,
      deletedAt: null,
    });
    const baselineBytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
    data.notes[0].content = "x".repeat(MAX_WORKSPACE_BYTES - baselineBytes - 3000);
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBe(
      MAX_WORKSPACE_BYTES - 3000,
    );
    expect(workspaceSchema.safeParse(data).success).toBe(true);
    expectAtomicFailure(data, source, capture("freshword ".repeat(1000), 2), /3 MiB/);
    expect(source.versions).toBeUndefined();
    expect(source.text).toBe(textOne);
  });
});
