import { describe, expect, it } from "vitest";
import {
  ComparisonAnswerRequestError,
  comparisonAnswerRequestReason,
  createComparisonAnswerRequest,
  validateComparisonAnswerRequest,
  type ComparisonAnswerRequestReason,
  type ComparisonAnswerScope,
} from "./comparison-answer";
import type { Chunk, Source, Space } from "./types";

const now = "2026-09-13T12:00:00.000Z";

function chunk(sourceId: string, versionId: string, text: string): Chunk {
  return {
    id: `${sourceId}-${versionId}-chunk`,
    sourceId,
    versionId,
    text,
    section: "正文",
    order: 0,
  };
}

function source(id: string, patch: Partial<Source> = {}): Source {
  const versionId = patch.versionId ?? `${id}-v1`;
  const text = patch.text ?? `${id} parsed text`;
  return {
    id,
    versionId,
    title: `${id} title`,
    filename: `${id}.txt`,
    kind: "text",
    mime: "text/plain",
    size: text.length,
    hash: `${id}-hash`,
    spaceIds: ["space-a"],
    tags: [],
    status: "ready",
    text,
    chunks: [chunk(id, versionId, text)],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    ...patch,
  };
}

function scope(patch: Partial<ComparisonAnswerScope> = {}): ComparisonAnswerScope {
  const space: Space = {
    id: "space-a",
    name: "学习资料",
    goal: "",
    color: "#123456",
    archived: false,
    createdAt: now,
  };
  return {
    space,
    left: { source: source("left"), isCurrentVersion: true },
    right: { source: source("right"), isCurrentVersion: true },
    ...patch,
  };
}

function request(patch: Record<string, unknown> = {}) {
  const current = scope();
  return {
    requestId: "comparison-attempt-1",
    question: "两份资料的结论有什么不同？",
    scope: "sources",
    sourceIds: [current.left.source.id, current.right.source.id],
    sourceVersions: [
      { sourceId: current.left.source.id, versionId: current.left.source.versionId },
      { sourceId: current.right.source.id, versionId: current.right.source.versionId },
    ],
    comparison: {
      leftSourceId: current.left.source.id,
      leftVersionId: current.left.source.versionId,
      rightSourceId: current.right.source.id,
      rightVersionId: current.right.source.versionId,
    },
    spaceId: current.space.id,
    ...patch,
  };
}

function expectReason(
  current: ComparisonAnswerScope,
  candidate: unknown,
  reason: ComparisonAnswerRequestReason,
) {
  expect(comparisonAnswerRequestReason(current, candidate)).toBe(reason);
  expect(() => validateComparisonAnswerRequest(current, candidate)).toThrow(
    ComparisonAnswerRequestError,
  );
  try {
    validateComparisonAnswerRequest(current, candidate);
  } catch (error) {
    expect(error).toMatchObject({ reason });
  }
}

describe("comparison answer request boundary", () => {
  it("creates the canonical two-source request and keeps the caller-owned attempt ID", () => {
    const current = scope();

    const result = createComparisonAnswerRequest({
      ...current,
      question: "  两份资料的结论有什么不同？  ",
      requestId: "comparison-attempt-1",
    });

    expect(result).toEqual({
      requestId: "comparison-attempt-1",
      question: "两份资料的结论有什么不同？",
      scope: "sources",
      sourceIds: ["left", "right"],
      sourceVersions: [
        { sourceId: "left", versionId: "left-v1" },
        { sourceId: "right", versionId: "right-v1" },
      ],
      comparison: {
        leftSourceId: "left",
        leftVersionId: "left-v1",
        rightSourceId: "right",
        rightVersionId: "right-v1",
      },
      spaceId: "space-a",
    });
    expect(createComparisonAnswerRequest({ ...current, question: "原文差异" })).not.toHaveProperty(
      "requestId",
    );
  });

  it("accepts only the two unique source IDs in either order", () => {
    const current = scope();
    const reversed = request({ sourceIds: ["right", "left"] });

    expect(validateComparisonAnswerRequest(current, reversed)).toMatchObject({
      scope: "sources",
      sourceIds: ["right", "left"],
    });
    expectReason(
      current,
      request({
        sourceIds: ["left"],
        sourceVersions: [{ sourceId: "left", versionId: "left-v1" }],
        comparison: undefined,
      }),
      "source-ids-mismatch",
    );
    expectReason(
      current,
      request({
        sourceIds: ["left", "right", "other"],
        sourceVersions: [
          { sourceId: "left", versionId: "left-v1" },
          { sourceId: "right", versionId: "right-v1" },
          { sourceId: "other", versionId: "other-v1" },
        ],
        comparison: undefined,
      }),
      "source-ids-mismatch",
    );
    expectReason(
      current,
      request({
        sourceIds: ["left", "other"],
        sourceVersions: [
          { sourceId: "left", versionId: "left-v1" },
          { sourceId: "other", versionId: "other-v1" },
        ],
        comparison: undefined,
      }),
      "source-ids-mismatch",
    );
    expectReason(
      current,
      request({ sourceIds: ["left", "left"], comparison: undefined }),
      "invalid-request",
    );
  });

  it("requires an exact current-version identity for both fixed sources", () => {
    const current = scope();

    expectReason(
      current,
      request({ sourceVersions: undefined, comparison: undefined }),
      "source-versions-mismatch",
    );
    expectReason(
      current,
      request({
        sourceVersions: [
          { sourceId: "left", versionId: "stale-version" },
          { sourceId: "right", versionId: "right-v1" },
        ],
        comparison: undefined,
      }),
      "source-versions-mismatch",
    );
    expectReason(
      current,
      request({
        sourceVersions: [
          { sourceId: "left", versionId: "left-v1" },
          { sourceId: "left", versionId: "left-v1" },
        ],
        comparison: undefined,
      }),
      "invalid-request",
    );
  });

  it("requires a server-visible identity for this exact comparison pair", () => {
    const current = scope();

    expectReason(current, request({ comparison: undefined }), "comparison-mismatch");
    expectReason(
      current,
      request({
        comparison: {
          leftSourceId: "right",
          leftVersionId: "right-v1",
          rightSourceId: "left",
          rightVersionId: "left-v1",
        },
      }),
      "comparison-mismatch",
    );
  });

  it("rejects a tampered scope, source ID, selection, or notes", () => {
    const current = scope();

    expectReason(
      current,
      request({ scope: "document-notes", sourceVersions: undefined, comparison: undefined }),
      "scope-not-sources",
    );
    expectReason(
      current,
      request({ sourceId: "left", comparison: undefined }),
      "source-id-not-allowed",
    );
    expectReason(
      current,
      request({ selection: "一段原文", comparison: undefined }),
      "selection-not-allowed",
    );
    expectReason(current, request({ notes: ["note-1"] }), "notes-not-allowed");
  });

  it("keeps unknown or absent scopes invalid instead of treating them as another scope", () => {
    const current = scope();

    expectReason(current, request({ scope: "unknown" }), "invalid-request");
    expectReason(current, request({ scope: undefined }), "invalid-request");
  });

  it("rejects a request for another space or an archived comparison space", () => {
    const current = scope();

    expectReason(current, request({ spaceId: "space-b" }), "space-mismatch");
    expectReason(
      scope({ space: { ...current.space, archived: true } }),
      request(),
      "space-archived",
    );
  });

  it("never sends historical versions or sources that revoked AI access", () => {
    const current = scope();

    expectReason(
      scope({ left: { source: current.left.source, isCurrentVersion: false } }),
      request(),
      "historical-version",
    );
    expectReason(
      scope({
        right: { source: { ...current.right.source, aiAllowed: false }, isCurrentVersion: true },
      }),
      request(),
      "source-ai-disabled",
    );
  });

  it("requires current parsed source text in the comparison space", () => {
    const current = scope();

    expectReason(
      scope({ left: { source: { ...current.left.source, spaceIds: [] }, isCurrentVersion: true } }),
      request(),
      "source-not-in-space",
    );
    expectReason(
      scope({
        right: { source: { ...current.right.source, status: "parsing" }, isCurrentVersion: true },
      }),
      request(),
      "source-not-ready",
    );
  });

  it("rejects empty questions and malformed request identities", () => {
    const current = scope();

    expectReason(current, request({ question: "  " }), "empty-question");
    expectReason(current, request({ requestId: "contains spaces" }), "invalid-request");
  });
});
