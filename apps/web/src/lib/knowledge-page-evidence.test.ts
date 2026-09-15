import { describe, expect, it } from "vitest";
import { createDemoWorkspace } from "./seed";
import {
  createKnowledgePageEvidenceAnswerRequest,
  resolveKnowledgePageOriginalEvidence,
} from "./knowledge-page-evidence";
import type { Citation, Note, Source, WorkspaceData } from "./types";

function citation(source: Source): Citation {
  const chunk = source.chunks[0]!;
  return {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    page: chunk.page,
    section: chunk.section,
  };
}

function acceptedKnowledgePage(
  data: WorkspaceData,
  citations: Citation[] = [citation(data.sources[0]!)],
): Note {
  const now = "2026-09-13T12:00:00.000Z";
  return {
    id: "knowledge-page",
    spaceId: data.spaces[0]!.id,
    title: "已接受的知识页",
    content: "<p>这段知识页正文绝不能进入问答请求。</p>",
    kind: "knowledge",
    aiGenerated: true,
    status: "accepted",
    citations,
    versions: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

describe("knowledge-page original evidence", () => {
  it("deduplicates current, same-space original sources and never puts the page body in a request", () => {
    const data = createDemoWorkspace();
    const source = data.sources[0]!;
    const note = acceptedKnowledgePage(data, [citation(source), citation(source)]);

    const evidence = resolveKnowledgePageOriginalEvidence(data, note);
    expect(evidence).toMatchObject({
      ok: true,
      sourceIds: [source.id],
      sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
    });

    const request = createKnowledgePageEvidenceAnswerRequest(data, note, {
      question: "学习率为什么会振荡？",
      requestId: "knowledge-question",
    });
    expect(request).toEqual({
      requestId: "knowledge-question",
      question: "学习率为什么会振荡？",
      scope: "sources",
      sourceIds: [source.id],
      sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
      spaceId: note.spaceId,
    });
    expect(JSON.stringify(request)).not.toContain("知识页正文");
  });

  it("excludes a cited source that has left the knowledge page's space", () => {
    const data = createDemoWorkspace();
    const source = data.sources[0]!;
    const note = acceptedKnowledgePage(data);
    source.spaceIds = ["other-space"];

    expect(resolveKnowledgePageOriginalEvidence(data, note)).toMatchObject({
      ok: false,
      reason: "no-current-original-sources",
    });
  });

  it("excludes a cited source that was deleted", () => {
    const data = createDemoWorkspace();
    const note = acceptedKnowledgePage(data);
    data.sources[0]!.deletedAt = "2026-09-13T12:00:00.000Z";

    expect(resolveKnowledgePageOriginalEvidence(data, note)).toMatchObject({
      ok: false,
      reason: "no-current-original-sources",
    });
  });

  it("excludes a citation to a historical source version", () => {
    const data = createDemoWorkspace();
    const source = data.sources[0]!;
    const note = acceptedKnowledgePage(data, [{ ...citation(source), versionId: "old-version" }]);

    expect(resolveKnowledgePageOriginalEvidence(data, note)).toMatchObject({
      ok: false,
      reason: "no-current-original-sources",
    });
  });

  it("excludes a source whose AI permission was revoked", () => {
    const data = createDemoWorkspace();
    const note = acceptedKnowledgePage(data);
    data.sources[0]!.aiAllowed = false;

    expect(resolveKnowledgePageOriginalEvidence(data, note)).toMatchObject({
      ok: false,
      reason: "no-current-original-sources",
    });
  });

  it("returns an explained unavailable result for a page without citations", () => {
    const data = createDemoWorkspace();
    const note = acceptedKnowledgePage(data, []);

    const evidence = resolveKnowledgePageOriginalEvidence(data, note);
    expect(evidence).toMatchObject({
      ok: false,
      reason: "no-current-original-sources",
    });
    if (!evidence.ok) expect(evidence.message).toContain("没有可用于问答的原始资料");
  });
});
