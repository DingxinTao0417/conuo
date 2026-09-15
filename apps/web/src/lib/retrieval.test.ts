import { describe, expect, it } from "vitest";
import { createDemoWorkspace, createEmptyWorkspace } from "./seed";
import { answerNoteMarker, extractiveCitationMarker } from "./citation-markers";
import { createCrossLibraryAnswerRequest } from "./cross-library-ask";
import {
  answerScopeAvailability,
  isSourceAnswerEligible,
  resolveAnswerNoteEvidence,
  retrieveEvidence,
  resolveCitation,
  selectedDocumentNoteEvidence,
  selectedDocumentNotes,
} from "./retrieval";
import type { AnswerRequest, Note, WorkspaceData } from "./types";

type AnswerRequestWithUserContext = AnswerRequest & { userContext?: string[] };

function request(
  data: WorkspaceData,
  patch: Partial<AnswerRequestWithUserContext> = {},
): AnswerRequestWithUserContext {
  return {
    question: "怎样判断学习率过高",
    scope: "space",
    sourceIds: [],
    spaceId: data.spaces[0].id,
    ...patch,
  };
}

function documentNote(data: WorkspaceData, patch: Partial<Note> = {}): Note {
  const source = data.sources[0];
  const chunk = source.chunks.find((item) => item.text.includes("学习率太小")) ?? source.chunks[0];
  const now = "2026-09-13T00:00:00.000Z";
  return {
    id: "note-current",
    spaceId: data.spaces[0].id,
    title: "我的学习率复盘",
    content: "<p>我的理解：学习率太大时，训练损失可能振荡，需要先把步长调小再观察。</p>",
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
    contentRevision: 2,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...patch,
  };
}

describe("evidence retrieval", () => {
  it("uses one readiness rule for blocked and mixed answer scopes", () => {
    const data = createDemoWorkspace();
    const ready = data.sources[0];
    const partial = { ...ready, id: "partial-source", status: "partial" as const };
    const parsing = { ...ready, id: "parsing-source", status: "parsing" as const };
    const saved = { ...ready, id: "saved-source", status: "saved" as const };
    const blocked = { ...ready, id: "blocked-source", aiAllowed: false };
    const failed = { ...ready, id: "failed-source", status: "failed" as const };
    const linkOnly = { ...ready, id: "link-source", status: "link-only" as const };
    const deleted = { ...ready, id: "deleted-source", deletedAt: ready.createdAt };

    expect(isSourceAnswerEligible(ready)).toBe(true);
    expect(isSourceAnswerEligible(partial)).toBe(true);
    expect(isSourceAnswerEligible(saved)).toBe(false);
    expect(isSourceAnswerEligible(parsing)).toBe(false);
    expect(isSourceAnswerEligible(failed)).toBe(false);
    expect(isSourceAnswerEligible(linkOnly)).toBe(false);
    expect(isSourceAnswerEligible(deleted)).toBe(false);
    expect(answerScopeAvailability([parsing])).toMatchObject({
      eligibleCount: 0,
      excludedCount: 1,
      blockedMessage: expect.stringContaining("正在解析"),
    });
    expect(answerScopeAvailability([blocked]).blockedMessage).toContain("允许用于 AI");
    expect(answerScopeAvailability([failed]).blockedMessage).toContain("没有可用于问答的正文");
    expect(answerScopeAvailability([]).blockedMessage).toContain("当前范围没有资料");
    expect(answerScopeAvailability([ready, parsing])).toEqual({
      eligibleCount: 1,
      excludedCount: 1,
    });
  });

  it("new workspaces contain no injected demo evidence", () => {
    const data = createEmptyWorkspace();
    expect(data.sources).toEqual([]);
    expect(data.notes).toEqual([]);
    expect(data.conversations).toEqual([]);
  });

  it("returns actual quotes with resolvable versioned citations and an honest mode", () => {
    const data = createDemoWorkspace();
    const result = retrieveEvidence(data, request(data));
    expect(result.mode).toBe("extractive");
    expect(result.content).toContain("未调用生成式 AI");
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations.some((citation) => citation.quote.includes("十分之一"))).toBe(true);
    expect(result.citations.every((citation) => resolveCitation(data, citation))).toBe(true);
  });

  it("uses controlled markers so source Markdown and footnotes stay within the extractive quote", () => {
    const data = createDemoWorkspace();
    data.sources[0].title = "学习资料 *草稿* [v2]";
    data.sources[0].text += "\n原文脚注 [1]。";
    data.sources[0].chunks.forEach((chunk) => {
      chunk.text += " 原文脚注 [1]。";
    });
    const result = retrieveEvidence(
      data,
      request(data, {
        question: "怎样判断学习率过高",
        scope: "document",
        sourceId: data.sources[0].id,
      }),
    );
    expect(result.mode).toBe("extractive");
    expect(result.content).toContain(`**${extractiveCitationMarker(0)}**`);
    expect(result.content).not.toContain(`**[1] ${data.sources[0].title}`);
    expect(result.content).toContain("[1]");
  });

  it("returns body evidence for the demo learning-rate question without changing existing chunk IDs", () => {
    const data = createDemoWorkspace();
    const before = structuredClone(data.sources[0].chunks);
    const result = retrieveEvidence(
      data,
      request(data, {
        question: "学习率过高会怎样？",
        scope: "document",
        sourceId: data.sources[0].id,
      }),
    );
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations.every((citation) => !/^#{1,6}\s+[^\n]+$/.test(citation.quote))).toBe(
      true,
    );
    expect(result.citations.some((citation) => citation.quote.includes("振荡"))).toBe(true);
    expect(result.citations.some((citation) => citation.quote.includes("十分之一"))).toBe(true);
    expect(data.sources[0].chunks).toEqual(before);
    expect(result.citations.every((citation) => resolveCitation(data, citation))).toBe(true);
  });

  it("does not reach other documents or spaces through a narrowed scope", () => {
    const data = createDemoWorkspace();
    const only = data.sources[1];
    const narrowed = retrieveEvidence(
      data,
      request(data, { scope: "document", sourceId: only.id }),
    );
    expect(narrowed.citations.every((citation) => citation.sourceId === only.id)).toBe(true);
    data.sources[0].spaceIds = ["some-other-space"];
    const crossSpace = retrieveEvidence(
      data,
      request(data, { scope: "sources", sourceIds: [data.sources[0].id] }),
    );
    expect(crossSpace.citations).toEqual([]);
  });

  it("honors explicit selected-source sets and never treats an empty set as all sources", () => {
    const data = createDemoWorkspace();
    expect(
      retrieveEvidence(data, request(data, { scope: "sources", sourceIds: [] })).citations,
    ).toEqual([]);
    const result = retrieveEvidence(
      data,
      request(data, { scope: "sources", sourceIds: [data.sources[0].id] }),
    );
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations.every((citation) => citation.sourceId === data.sources[0].id)).toBe(
      true,
    );
  });

  it("keeps ordinary selected-source retrieval in the current space", () => {
    const data = createDemoWorkspace();
    const first = data.sources[0]!;
    const second = data.sources[1]!;
    const otherSpace = { ...data.spaces[0]!, id: "ordinary-other-space", name: "其他空间" };
    data.spaces.push(otherSpace);
    second.spaceIds = [otherSpace.id];

    const result = retrieveEvidence(
      data,
      request(data, {
        scope: "sources",
        sourceIds: [first.id, second.id],
      }),
    );
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations.every((citation) => citation.sourceId === first.id)).toBe(true);
  });

  it("uses only the explicit cross-library source set and refuses a changed member as a whole", () => {
    const data = createDemoWorkspace();
    const firstSpace = data.spaces[0]!;
    const secondSpace = { ...firstSpace, id: "cross-retrieval-space-b", name: "跨库第二空间" };
    data.spaces.push(secondSpace);
    const [first, second] = data.sources;
    second!.spaceIds = [secondSpace.id];
    const outside = structuredClone(first!);
    outside.id = "outside-cross-library-range";
    outside.versionId = "outside-cross-library-version";
    outside.text = "学习率过高的外部资料不应进入跨库检索。";
    outside.chunks = [
      {
        ...outside.chunks[0]!,
        id: "outside-cross-library-chunk",
        sourceId: outside.id,
        versionId: outside.versionId,
        text: outside.text,
      },
    ];
    data.sources.push(outside);
    const cross = createCrossLibraryAnswerRequest(data, {
      question: "学习率过高会怎样？",
      sourceIds: [first!.id, second!.id],
    });

    const result = retrieveEvidence(data, cross);
    expect(result.citations.length).toBeGreaterThan(0);
    expect(
      result.citations.every((citation) => [first!.id, second!.id].includes(citation.sourceId)),
    ).toBe(true);

    second!.aiAllowed = false;
    const blocked = retrieveEvidence(data, cross);
    expect(blocked.citations).toEqual([]);
    expect(blocked.content).toContain("禁止 AI 使用");
  });

  it("allows reading and selection questions for unassigned inbox documents", () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    source.spaceIds = [];
    for (const scope of ["document", "selection"] as const) {
      const result = retrieveEvidence(
        data,
        request(data, {
          spaceId: "inbox",
          scope,
          sourceId: source.id,
          selection: scope === "selection" ? "学习率太大" : undefined,
        }),
      );
      expect(result.citations.length).toBeGreaterThan(0);
      expect(result.citations.every((citation) => citation.sourceId === source.id)).toBe(true);
    }
  });

  it("does not use inbox to bypass another space or a source's permission", () => {
    const data = createDemoWorkspace();
    const inboxSource = data.sources[0];
    const assignedSource = data.sources[1];
    inboxSource.spaceIds = [];
    for (const scope of ["document", "sources"] as const) {
      const result = retrieveEvidence(
        data,
        request(data, {
          spaceId: "inbox",
          scope,
          sourceId: assignedSource.id,
          sourceIds: [assignedSource.id],
        }),
      );
      expect(result.citations).toEqual([]);
    }
    const inbox = retrieveEvidence(data, request(data, { spaceId: "inbox" }));
    expect(inbox.citations.length).toBeGreaterThan(0);
    expect(inbox.citations.every((citation) => citation.sourceId === inboxSource.id)).toBe(true);
    inboxSource.aiAllowed = false;
    expect(retrieveEvidence(data, request(data, { spaceId: "inbox" })).citations).toEqual([]);
    inboxSource.aiAllowed = true;
    inboxSource.deletedAt = new Date().toISOString();
    expect(retrieveEvidence(data, request(data, { spaceId: "inbox" })).citations).toEqual([]);
  });

  it("rejects unknown and archived spaces without treating them as inbox", () => {
    const data = createDemoWorkspace();
    data.sources[0].spaceIds = [];
    const unknown = retrieveEvidence(data, request(data, { spaceId: "not-a-real-space" }));
    expect(unknown.citations).toEqual([]);
    expect(unknown.content).toContain("学习空间不可用");
    data.spaces[0].archived = true;
    const archived = retrieveEvidence(data, request(data));
    expect(archived.citations).toEqual([]);
    expect(archived.content).toContain("学习空间不可用");
  });

  it("revoked, deleted and globally disabled evidence never enters new answers", () => {
    const data = createDemoWorkspace();
    data.sources[0].aiAllowed = false;
    data.sources[1].deletedAt = new Date().toISOString();
    expect(retrieveEvidence(data, request(data)).citations).toEqual([]);
    data.sources[0].aiAllowed = true;
    data.aiEnabled = false;
    const result = retrieveEvidence(data, request(data));
    expect(result.citations).toEqual([]);
    expect(result.content).toContain("已关闭");
  });

  it("rejects stale/forged chunks and refuses to rebind an old citation", () => {
    const data = createDemoWorkspace();
    const citation = retrieveEvidence(
      data,
      request(data, { scope: "document", sourceId: data.sources[0].id }),
    ).citations[0];
    expect(citation).toBeTruthy();
    data.sources[0].versionId = "replacement-version";
    const result = retrieveEvidence(
      data,
      request(data, { scope: "document", sourceId: data.sources[0].id }),
    );
    expect(result.citations).toEqual([]);
    expect(resolveCitation(data, citation)).toBeNull();
  });

  it("rejects a fabricated selection instead of widening scope", () => {
    const data = createDemoWorkspace();
    const result = retrieveEvidence(
      data,
      request(data, {
        scope: "selection",
        sourceId: data.sources[0].id,
        selection: "原文中不存在的秘密内容",
      }),
    );
    expect(result.citations).toEqual([]);
    expect(result.content).toContain("不属于当前资料版本");
    const valid = retrieveEvidence(
      data,
      request(data, { scope: "selection", sourceId: data.sources[0].id, selection: "学习率太大" }),
    );
    expect(valid.citations.length).toBeGreaterThan(0);
    expect(valid.citations.every((citation) => citation.sourceId === data.sources[0].id)).toBe(
      true,
    );
  });

  it("distinguishes no match from incomplete text coverage", () => {
    const data = createDemoWorkspace();
    const absent = retrieveEvidence(data, request(data, { question: "量子纠缠的实验条件" }));
    expect(absent.citations).toEqual([]);
    expect(absent.content).toContain("没有找到");
    data.sources[0].status = "partial";
    const partial = retrieveEvidence(data, request(data, { question: "量子纠缠的实验条件" }));
    expect(partial.content).toContain("部分原文件内容未能解析");
    data.sources.forEach((source) => {
      source.status = "failed";
    });
    const unparsed = retrieveEvidence(data, request(data));
    expect(unparsed.citations).toEqual([]);
    expect(unparsed.content).toContain("尚未提取");
  });

  it("uses prior user questions to retrieve evidence for an otherwise ambiguous follow-up", () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    source.text = "orionanchor requires explicit calibration before deployment.";
    source.chunks = [{ ...source.chunks[0], text: source.text }];
    const followUp = request(data, { question: "请继续说明。" });

    expect(retrieveEvidence(data, followUp).citations).toEqual([]);

    const result = retrieveEvidence(data, {
      ...followUp,
      userContext: ["orionanchor 的约束条件是什么？"],
    });
    expect(result.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: source.id, quote: source.text }),
      ]),
    );
  });

  it("never retrieves unaccepted knowledge drafts", () => {
    const data = createEmptyWorkspace();
    data.notes.push({
      id: "draft",
      spaceId: data.spaces[0].id,
      title: "秘密配方",
      content: "秘密配方是水",
      kind: "knowledge",
      status: "draft",
      citations: [],
      versions: [],
      createdAt: "",
      updatedAt: "",
      deletedAt: null,
    });
    const result = retrieveEvidence(data, request(data, { question: "秘密配方" }));
    expect(result.citations).toEqual([]);
    expect(result.content).not.toContain("秘密配方是水");
  });

  it("includes only exact, current human notes already associated with the requested document", () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    const eligible = documentNote(data);
    const other = data.sources[1];
    const otherChunk = other.chunks[0];
    const crossDocument = documentNote(data, {
      id: "cross-document",
      citations: [
        {
          sourceId: other.id,
          versionId: other.versionId,
          chunkId: otherChunk.id,
          title: other.title,
          quote: otherChunk.text,
          section: otherChunk.section,
          page: otherChunk.page,
        },
      ],
    });
    const stale = documentNote(data, {
      id: "stale",
      citations: [{ ...eligible.citations[0], versionId: "old-version" }],
    });
    data.notes = [
      eligible,
      documentNote(data, { id: "draft", status: "draft" }),
      documentNote(data, { id: "generated", aiGenerated: true }),
      documentNote(data, { id: "unmarked-origin", aiGenerated: undefined }),
      documentNote(data, { id: "knowledge", kind: "knowledge" }),
      documentNote(data, { id: "deleted", deletedAt: "2026-09-13T00:00:00.000Z" }),
      documentNote(data, { id: "other-space", spaceId: "another-space" }),
      documentNote(data, { id: "unlinked", citations: [] }),
      crossDocument,
      stale,
    ];
    const scoped = request(data, {
      question: "学习率振荡怎么判断",
      scope: "document-notes",
      sourceId: source.id,
    });
    expect(selectedDocumentNotes(data, scoped).map((note) => note.id)).toEqual([eligible.id]);
    const evidence = selectedDocumentNoteEvidence(data, scoped);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      noteId: eligible.id,
      spaceId: data.spaces[0].id,
      sourceId: source.id,
      sourceVersionId: source.versionId,
      revision: 2,
      title: eligible.title,
    });
    expect(resolveAnswerNoteEvidence(data, evidence[0])?.note).toBe(eligible);

    source.versionId = "replacement-version";
    expect(resolveAnswerNoteEvidence(data, evidence[0])).toBeNull();
    source.versionId = evidence[0].sourceVersionId;

    eligible.spaceId = "another-space";
    expect(resolveAnswerNoteEvidence(data, evidence[0])).toBeNull();
    eligible.spaceId = evidence[0].spaceId;

    source.aiAllowed = false;
    expect(selectedDocumentNoteEvidence(data, scoped)).toEqual([]);
  });

  it("returns separate, controlled personal-note evidence for the document-notes scope", () => {
    const data = createDemoWorkspace();
    data.notes = [documentNote(data)];
    const result = retrieveEvidence(
      data,
      request(data, {
        question: "学习率振荡怎么判断",
        scope: "document-notes",
        sourceId: data.sources[0].id,
      }),
    );
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.noteEvidence).toHaveLength(1);
    expect(result.content).toContain(`**${answerNoteMarker(0)}**`);
    expect(result.content).toContain("不是原始资料");
  });
});
