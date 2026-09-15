import { describe, expect, it } from "vitest";
import {
  discardRecoverableDraft,
  restoreSourceAndResolveDrafts,
  restoreSourceFromRecoverableDraft,
  saveRecoverableDraftAsNote,
} from "./recoverable-draft-actions";
import { createRecoverableSourceAnnotationDraft } from "./recoverable-drafts";
import { workspaceSchema } from "./supabase/validation";
import type { Annotation, Source, WorkspaceData } from "./types";

const deletedAt = "2026-09-14T08:00:00.000Z";
const restoredAt = "2026-09-14T09:00:00.000Z";

function fixture(): WorkspaceData {
  const source: Source = {
    id: "source-a",
    versionId: "version-a",
    title: "安全 <script> & 学习",
    filename: "source.txt",
    kind: "text",
    mime: "text/plain",
    size: 12,
    hash: "a".repeat(64),
    spaceIds: ["space-a"],
    tags: [],
    status: "ready",
    text: "一段原文",
    chunks: [
      {
        id: "chunk-a",
        sourceId: "source-a",
        versionId: "version-a",
        text: "一段原文",
        section: "正文",
        order: 0,
      },
    ],
    createdAt: "2026-09-14T06:00:00.000Z",
    updatedAt: deletedAt,
    deletedAt,
    aiAllowed: false,
    starred: false,
  };
  const annotation: Annotation = {
    id: "annotation-a",
    sourceId: source.id,
    versionId: source.versionId,
    quote: "一段 <原文>",
    note: "我的 **离线** 想法\n第二行",
    page: 2,
    createdAt: "2026-09-14T07:00:00.000Z",
  };
  const draft = createRecoverableSourceAnnotationDraft(source, deletedAt, annotation);
  return {
    schemaVersion: 1,
    spaces: [
      {
        id: "space-a",
        name: "学习空间",
        goal: "",
        color: "#6758d8",
        archived: false,
        createdAt: "2026-09-14T05:00:00.000Z",
      },
    ],
    sources: [source],
    notes: [],
    annotations: [annotation],
    recoverableDrafts: [draft],
    conversations: [],
    aiEnabled: false,
  };
}

describe("recoverable draft actions", () => {
  it("rejects matching annotation/draft anchors when their retained raw span was changed", () => {
    const data = fixture();
    data.sources[0].text = "目标\n目标";
    data.sources[0].chunks = [];
    data.annotations[0] = {
      ...data.annotations[0],
      quote: "目标",
      page: undefined,
      textAnchor: { start: 3, end: 5 },
    };
    data.recoverableDrafts = [
      createRecoverableSourceAnnotationDraft(data.sources[0], deletedAt, data.annotations[0]),
    ];
    data.sources[0].text = "目标\n变化";
    const id = data.recoverableDrafts[0].id;
    expect(() => restoreSourceFromRecoverableDraft(data, id, restoredAt)).toThrow("原文位置");
    expect(() =>
      restoreSourceAndResolveDrafts(data, data.sources[0].id, deletedAt, restoredAt),
    ).toThrow("原文位置");
    expect(() => discardRecoverableDraft(data, id)).toThrow("原文位置");
    expect(() => saveRecoverableDraftAsNote(data, id, "saved-note", restoredAt)).toThrow(
      "原文位置",
    );
  });

  it("preserves an anchored second occurrence through source restoration", () => {
    const data = fixture();
    data.sources[0].text = "😀目标\n目标";
    data.sources[0].chunks = [];
    data.annotations[0] = {
      ...data.annotations[0],
      quote: "目标",
      page: undefined,
      textAnchor: { start: 5, end: 7 },
    };
    data.recoverableDrafts = [
      createRecoverableSourceAnnotationDraft(data.sources[0], deletedAt, data.annotations[0]),
    ];
    const next = restoreSourceFromRecoverableDraft(data, data.recoverableDrafts[0].id, restoredAt);
    expect(next.annotations[0]).toMatchObject({ quote: "目标", textAnchor: { start: 5, end: 7 } });
    expect(workspaceSchema.safeParse(next).success).toBe(true);
  });

  it("rejects a recovery action when the matching quote moved to a different anchor", () => {
    const data = fixture();
    data.sources[0].text = "目标\n目标";
    data.sources[0].chunks = [];
    data.annotations[0] = {
      ...data.annotations[0],
      quote: "目标",
      page: undefined,
      textAnchor: { start: 3, end: 5 },
    };
    data.recoverableDrafts = [
      {
        ...createRecoverableSourceAnnotationDraft(data.sources[0], deletedAt, data.annotations[0]),
        textAnchor: { start: 0, end: 2 },
      },
    ];
    const id = data.recoverableDrafts[0].id;
    expect(() => restoreSourceFromRecoverableDraft(data, id, restoredAt)).toThrow("原批注已变化");
    expect(() =>
      restoreSourceAndResolveDrafts(data, data.sources[0].id, deletedAt, restoredAt),
    ).toThrow("原批注已变化");
    expect(() => discardRecoverableDraft(data, id)).toThrow("原批注已变化");
    expect(() => saveRecoverableDraftAsNote(data, id, "saved-note", restoredAt)).toThrow(
      "原批注已变化",
    );
  });

  it("restores the whole source and resolves every marker while preserving annotations", () => {
    const data = fixture();
    const secondAnnotation = { ...data.annotations[0], id: "annotation-b" };
    data.annotations.push(secondAnnotation);
    data.recoverableDrafts!.push(
      createRecoverableSourceAnnotationDraft(data.sources[0], deletedAt, secondAnnotation),
    );

    const next = restoreSourceFromRecoverableDraft(data, data.recoverableDrafts![0].id, restoredAt);

    expect(next.sources[0]).toMatchObject({ deletedAt: null, updatedAt: restoredAt });
    expect(next.annotations).toHaveLength(2);
    expect(next.recoverableDrafts).toEqual([]);
    expect(next.resolvedRecoverableDrafts).toEqual(
      expect.arrayContaining(
        data.recoverableDrafts!.map((draft) => ({
          id: draft.id,
          sourceId: draft.sourceId,
          annotationId: draft.annotationId,
          sourceDeletedAt: draft.sourceDeletedAt,
          annotationDisposition: "retain",
        })),
      ),
    );
    expect(workspaceSchema.safeParse(next).success).toBe(true);
  });

  it("also resolves markers when the ordinary recycle-bin restore button is used", () => {
    const data = fixture();
    const next = restoreSourceAndResolveDrafts(data, "source-a", deletedAt, restoredAt);
    expect(next.sources[0].deletedAt).toBeNull();
    expect(next.recoverableDrafts).toEqual([]);
    expect(next.annotations).toEqual(data.annotations);
  });

  it("saves escaped user text as an accepted note and removes the source-bound annotation", () => {
    const data = fixture();
    const result = saveRecoverableDraftAsNote(
      data,
      data.recoverableDrafts![0].id,
      "note-recovered",
      restoredAt,
    );

    expect(result.data.sources[0].deletedAt).toBe(deletedAt);
    expect(result.data.recoverableDrafts).toEqual([]);
    expect(result.data.annotations).toEqual([]);
    expect(result.data.resolvedRecoverableDrafts).toEqual([
      {
        id: data.recoverableDrafts![0].id,
        sourceId: "source-a",
        annotationId: "annotation-a",
        sourceDeletedAt: deletedAt,
        annotationDisposition: "remove",
      },
    ]);
    expect(result.note).toMatchObject({
      id: "note-recovered",
      spaceId: "space-a",
      kind: "note",
      aiGenerated: false,
      status: "accepted",
      citations: [],
    });
    expect(result.note.content).toContain("我的 **离线** 想法<br>第二行");
    expect(result.note.content).toContain("安全 &lt;script&gt; &amp; 学习");
    expect(result.note.content).not.toContain("<script>");
    expect(workspaceSchema.safeParse(result.data).success).toBe(true);
  });

  it("falls back to the inbox when the source has no active learning space", () => {
    const data = fixture();
    data.spaces[0].archived = true;
    const { note } = saveRecoverableDraftAsNote(
      data,
      data.recoverableDrafts![0].id,
      "note-inbox",
      restoredAt,
    );
    expect(note.spaceId).toBe("inbox");
  });

  it("discards the exact draft and annotation without restoring the source", () => {
    const data = fixture();
    const next = discardRecoverableDraft(data, data.recoverableDrafts![0].id);
    expect(next.sources[0].deletedAt).toBe(deletedAt);
    expect(next.recoverableDrafts).toEqual([]);
    expect(next.annotations).toEqual([]);
    expect(next.resolvedRecoverableDrafts?.map((marker) => marker.id)).toEqual([
      data.recoverableDrafts![0].id,
    ]);
    expect(next.resolvedRecoverableDrafts?.[0].annotationDisposition).toBe("remove");
    expect(workspaceSchema.safeParse(next).success).toBe(true);
  });

  it("rejects an existing marker with the opposite annotation disposition", () => {
    const data = fixture();
    data.resolvedRecoverableDrafts = [
      {
        id: data.recoverableDrafts![0].id,
        sourceId: "source-a",
        annotationId: "annotation-a",
        sourceDeletedAt: deletedAt,
        annotationDisposition: "retain",
      },
    ];

    expect(() => discardRecoverableDraft(data, data.recoverableDrafts![0].id)).toThrow(
      "处理记录已变化",
    );
  });

  it("rejects stale actions before removing or copying newer annotation text", () => {
    const data = fixture();
    data.annotations[0] = { ...data.annotations[0], note: "后来又修改了" };
    expect(() => discardRecoverableDraft(data, data.recoverableDrafts![0].id)).toThrow(
      "原批注已变化",
    );
    expect(() =>
      saveRecoverableDraftAsNote(data, data.recoverableDrafts![0].id, "note-stale", restoredAt),
    ).toThrow("原批注已变化");
  });
});
