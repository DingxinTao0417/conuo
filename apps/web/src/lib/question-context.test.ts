import { describe, expect, it } from "vitest";
import { createCrossLibraryAnswerRequest } from "./cross-library-ask";
import { createDemoWorkspace } from "./seed";
import { questionContextKey } from "./question-context";
import type { AnswerRequest, Note } from "./types";

type AnswerRequestWithUserContext = AnswerRequest & { userContext?: string[] };

function fixture() {
  const data = createDemoWorkspace();
  const request: AnswerRequest = {
    question: "学习率过高会怎样？",
    scope: "document",
    spaceId: data.spaces[0].id,
    sourceId: data.sources[0].id,
    sourceIds: [],
  };
  return { data, request };
}

describe("question evidence fingerprint", () => {
  it("tracks document evidence and permissions, not note edits or reading position", () => {
    const { data, request } = fixture();
    const before = questionContextKey(data, request);
    const same = structuredClone(data);
    same.sources[0].readPage = 9;
    same.sources[0].readOffset = 400;
    same.sources[0].starred = !same.sources[0].starred;
    same.sources[0].tags.push("手动标签");
    same.sources[0].storagePath = "account/version/source.pdf";
    same.sources[0].updatedAt = new Date().toISOString();
    same.spaces[0].name = "重新命名知识库";
    same.sources[1].text = "另一个文档的编辑";
    same.sources[1].aiAllowed = false;
    expect(questionContextKey(same, request)).toBe(before);
    same.sources[0].chunks[0].text = "当前文档的新原文";
    expect(questionContextKey(same, request)).not.toBe(before);
    const coverageChanged = structuredClone(data);
    coverageChanged.sources[0].coverage = { captureScope: "full", parseState: "partial" };
    expect(questionContextKey(coverageChanged, request)).not.toBe(before);
  });

  it("tracks exact selected sets, including empty sets, without falling back to the whole space", () => {
    const { data, request } = fixture();
    request.scope = "sources";
    request.sourceIds = [data.sources[1].id];
    const before = questionContextKey(data, request);
    data.sources[0].text = "尚未选择的资料";
    expect(questionContextKey(data, request)).toBe(before);
    data.sources[1].aiAllowed = false;
    expect(questionContextKey(data, request)).not.toBe(before);
    request.sourceIds = [];
    const empty = questionContextKey(data, request);
    data.sources[1].text = "空选择不使用此资料";
    expect(questionContextKey(data, request)).toBe(empty);
  });

  it("treats inbox as only unassigned sources and notices movement across that boundary", () => {
    const { data, request } = fixture();
    request.spaceId = "inbox";
    request.scope = "space";
    data.sources[0].spaceIds = [];
    const before = questionContextKey(data, request);
    data.sources[1].text = "仍在另一个知识库中的资料";
    expect(questionContextKey(data, request)).toBe(before);
    data.sources[1].spaceIds = [];
    expect(questionContextKey(data, request)).not.toBe(before);
  });

  it("ignores membership changes outside the request space", () => {
    const { data, request } = fixture();
    const otherSpace = { ...data.spaces[0], id: "other-space", name: "另一个知识库" };
    data.spaces.push(otherSpace);
    data.sources[0].spaceIds.push(otherSpace.id);
    const before = questionContextKey(data, request);

    data.sources[0].spaceIds = [request.spaceId];
    expect(questionContextKey(data, request)).toBe(before);
  });

  it("includes question, selection and current space availability", () => {
    const { data, request } = fixture();
    request.scope = "selection";
    request.selection = "学习率太大";
    const before = questionContextKey(data, request);
    expect(questionContextKey(data, { ...request, question: "请给个例子" })).not.toBe(before);
    expect(questionContextKey(data, { ...request, selection: "学习率太小" })).not.toBe(before);
    data.spaces[0].archived = true;
    const archived = questionContextKey(data, request);
    expect(archived).not.toBe(before);
    data.spaces = [];
    expect(questionContextKey(data, request)).not.toBe(archived);
  });

  it("ignores per-attempt IDs and the order of equivalent source selections", () => {
    const { data, request } = fixture();
    request.scope = "sources";
    request.sourceIds = data.sources.map((source) => source.id);
    const first = { ...request, requestId: "first-attempt" };
    const second = {
      ...request,
      sourceIds: [...request.sourceIds].reverse(),
      requestId: "second-attempt",
    };
    expect(questionContextKey(data, first)).toBe(questionContextKey(data, second));
  });

  it("includes canonical exact-version locks for selected source questions", () => {
    const { data, request } = fixture();
    request.scope = "sources";
    request.sourceIds = data.sources.map((source) => source.id);
    request.sourceVersions = data.sources.map((source) => ({
      sourceId: source.id,
      versionId: source.versionId,
    }));
    const first = questionContextKey(data, request);
    const equivalentOrder = questionContextKey(data, {
      ...request,
      sourceVersions: [...request.sourceVersions].reverse(),
    });
    const staleVersion = questionContextKey(data, {
      ...request,
      sourceVersions: request.sourceVersions.map((reference, index) =>
        index === 0 ? { ...reference, versionId: "stale-version" } : reference,
      ),
    });
    const comparison = questionContextKey(data, {
      ...request,
      comparison: {
        leftSourceId: data.sources[0].id,
        leftVersionId: data.sources[0].versionId,
        rightSourceId: data.sources[1].id,
        rightVersionId: data.sources[1].versionId,
      },
    });
    expect(equivalentOrder).toBe(first);
    expect(staleVersion).not.toBe(first);
    expect(comparison).not.toBe(first);
  });

  it("fingerprints the exact cross-library range, version locks, and active-space membership", () => {
    const data = createDemoWorkspace();
    const firstSpace = data.spaces[0]!;
    const secondSpace = { ...firstSpace, id: "cross-context-space-b", name: "第二知识库" };
    data.spaces.push(secondSpace);
    data.sources[1]!.spaceIds = [secondSpace.id];
    const request = createCrossLibraryAnswerRequest(data, {
      question: "两个资料如何说明学习率？",
      sourceIds: data.sources.map((source) => source.id),
    });
    const key = questionContextKey(data, request);

    expect(
      questionContextKey(data, {
        ...request,
        sourceIds: [...request.sourceIds].reverse(),
        sourceVersions: [...request.sourceVersions!].reverse(),
      }),
    ).toBe(key);
    expect(
      questionContextKey(data, {
        ...request,
        sourceVersions: request.sourceVersions!.map((reference, index) =>
          index === 0 ? { ...reference, versionId: "stale-version" } : reference,
        ),
      }),
    ).not.toBe(key);

    secondSpace.archived = true;
    expect(questionContextKey(data, request)).not.toBe(key);
  });

  it("includes actual prior user-question context while treating empty context as absent", () => {
    const { data, request } = fixture();
    const withoutContext = questionContextKey(data, request);
    const emptyContext: AnswerRequestWithUserContext = { ...request, userContext: [] };
    const priorQuestions = ["前一轮提到的 orionanchor 条件是什么？"];
    const withContext: AnswerRequestWithUserContext = {
      ...request,
      userContext: priorQuestions,
    };

    expect(questionContextKey(data, emptyContext)).toBe(withoutContext);
    const contextKey = questionContextKey(data, withContext);
    expect(contextKey).not.toBe(withoutContext);
    expect(JSON.parse(contextKey).userContext).toEqual(priorQuestions);
  });

  it("tracks only the canonical personal-note evidence of a document-notes question", () => {
    const { data, request } = fixture();
    const source = data.sources[0];
    const chunk = source.chunks[0];
    const note: Note = {
      id: "linked-note",
      spaceId: request.spaceId,
      title: "我的复盘",
      content: "<p>我的理解：学习率过大时损失会振荡。</p>",
      kind: "note",
      aiGenerated: false,
      status: "accepted",
      citations: [
        {
          sourceId: source.id,
          versionId: source.versionId,
          chunkId: chunk.id,
          title: source.title,
          quote: chunk.text,
          section: chunk.section,
          page: chunk.page,
        },
      ],
      versions: [],
      contentRevision: 1,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
      deletedAt: null,
    };
    const unrelated: Note = {
      ...structuredClone(note),
      id: "unrelated-note",
      spaceId: "another-space",
      content: "<p>不应出现在这次问答。</p>",
    };
    data.notes = [note, unrelated];
    request.scope = "document-notes";
    const before = questionContextKey(data, request);

    unrelated.content = "<p>编辑其他空间的笔记。</p>";
    expect(questionContextKey(data, request)).toBe(before);

    note.content = "<p>我的理解：学习率过大时损失可能持续振荡。</p>";
    note.contentRevision = 2;
    note.updatedAt = "2026-09-13T00:01:00.000Z";
    expect(questionContextKey(data, request)).not.toBe(before);

    const afterEdit = questionContextKey(data, request);
    note.citations = [{ ...note.citations[0], chunkId: source.chunks[1]?.id ?? chunk.id }];
    expect(questionContextKey(data, request)).not.toBe(afterEdit);
  });
});
