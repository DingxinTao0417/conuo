import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceArchive, buildWorkspaceArchiveResult, exportWorkspace } from "./export";
import { readWorkspaceBackup } from "./backup-archive";
import { createDemoWorkspace } from "./seed";
import { posix } from "node:path";
import type { AnswerNoteEvidence, Citation, Note, Source, SourceVersion } from "./types";
import type { ConceptRelation, RelationType } from "./concept-relation-types";
import { snapshotKnowledgeNote } from "./knowledge-update";
import { prepareWorkspaceExport } from "./export-scope";
import { prepareBackupRestore, mergeBackupRestore } from "./backup-restore";
import { createImportJob } from "./import-queue";
import {
  createRecoverableSourceAnnotationDraft,
  recoverableSourceAnnotationDraftId,
  resolveRecoverableSourceAnnotationDraft,
} from "./recoverable-drafts";

const mocks = vi.hoisted(() => ({ getBlob: vi.fn() }));
vi.mock("./local-store", () => ({ getBlob: mocks.getBlob, putBlob: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBlob.mockReset();
});

describe("designated-space portable archive and account fences", () => {
  const at = "2026-09-15T00:00:00.000Z";
  beforeEach(() => {
    mocks.getBlob.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function scopedFixture() {
    const data = createDemoWorkspace();
    data.spaces = [
      {
        id: "selected",
        name: "学习/目标",
        goal: "",
        color: "blue",
        archived: false,
        createdAt: at,
      },
      {
        id: "outside",
        name: "OUTSIDE_LIBRARY_SECRET",
        goal: "",
        color: "red",
        archived: false,
        createdAt: at,
      },
    ];
    function source(id: string, spaceIds: string[]): Source {
      const text = `${id} CURRENT_RAW`;
      const oldText = id === "member" ? "😀目标\n目标" : `${id} OLD_RAW`;
      return {
        ...data.sources[0],
        id,
        versionId: `${id}-v2`,
        title: id,
        filename: `${id}.md`,
        text,
        spaceIds,
        chunks: [
          { id: `${id}-c2`, sourceId: id, versionId: `${id}-v2`, text, section: "正文", order: 0 },
        ],
        coverage: undefined,
        blobKey: `${id}-key`,
        versions: [
          {
            versionId: `${id}-v1`,
            title: `${id} old`,
            filename: `${id}-old.md`,
            kind: "markdown",
            mime: "text/markdown",
            size: 20,
            hash: "old-hash",
            status: "ready",
            text: oldText,
            chunks: [
              {
                id: `${id}-c1`,
                sourceId: id,
                versionId: `${id}-v1`,
                text: oldText,
                section: "旧正文",
                order: 0,
              },
            ],
            createdAt: at,
            archivedAt: at,
            ...(id === "external" ? { originalMissing: true } : { blobKey: `${id}-old-key` }),
          },
        ],
      };
    }
    data.sources = [
      source("member", ["selected", "outside"]),
      source("external", ["outside"]),
      source("OUTSIDE_SOURCE_SECRET", ["outside"]),
    ];
    data.sources[0].deletedAt = at;
    function citation(item: Source, old = false): Citation {
      const version = old ? item.versions![0] : item;
      return {
        sourceId: item.id,
        versionId: version.versionId,
        chunkId: version.chunks[0].id,
        title: item.title,
        quote: version.chunks[0].text,
        section: "正文",
      };
    }
    function note(id: string, spaceId: string, content: string): Note {
      return {
        id,
        spaceId,
        title: id,
        content,
        kind: "knowledge",
        citations: [],
        status: "accepted",
        versions: [],
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      };
    }
    data.notes = [
      note("selected-note", "selected", "SELECTED_NOTE_RAW"),
      note("outside-note", "outside", "OUTSIDE_NOTE_CURRENT_SECRET"),
    ];
    data.notes[0].citations = [citation(data.sources[1], true)];
    data.notes[0].versions = [
      {
        id: "selected-note-history",
        title: "旧笔记",
        content: "SELECTED_NOTE_HISTORY_RAW",
        citations: [citation(data.sources[0], true)],
        spaceId: "outside",
        savedAt: at,
      },
    ];
    data.notes[1].versions = [
      {
        id: "outside-history",
        title: "旧私人笔记",
        content: "OUTSIDE_NOTE_HISTORY_SECRET",
        savedAt: at,
      },
    ];
    data.annotations = [
      {
        id: "positioned",
        sourceId: "member",
        versionId: "member-v1",
        quote: "目标",
        textAnchor: { start: 5, end: 7 },
        note: "SELECTED_RECOVERY_USER_TEXT",
        createdAt: at,
      },
    ];
    data.recoverableDrafts = [
      createRecoverableSourceAnnotationDraft(data.sources[0], at, data.annotations[0]),
    ];
    data.resolvedRecoverableDrafts = [
      resolveRecoverableSourceAnnotationDraft(
        {
          id: recoverableSourceAnnotationDraftId("handled", at),
          sourceId: "member",
          annotationId: "handled",
          sourceDeletedAt: at,
        },
        "remove",
      ),
    ];
    data.importJobs = [
      createImportJob({
        sourceId: "member",
        versionId: "member-v2",
        filename: "member.md",
        spaceId: "outside",
        at,
      }),
      createImportJob({
        sourceId: "OUTSIDE_SOURCE_SECRET",
        versionId: "OUTSIDE_SOURCE_SECRET-v2",
        filename: "outside.md",
        spaceId: "outside",
        at,
      }),
    ];
    data.conversations = [
      {
        id: "selected-conversation",
        spaceId: "selected",
        title: "我的对话",
        scope: "document",
        sourceId: "member",
        sourceIds: ["member"],
        resolved: false,
        updatedAt: at,
        messages: [
          { id: "question", role: "user", content: "原问题", citations: [], createdAt: at },
          {
            id: "answer",
            role: "assistant",
            content: "SELECTED_ANSWER",
            citations: [citation(data.sources[1], true)],
            noteEvidence: [
              {
                noteId: "outside-note",
                spaceId: "selected",
                sourceId: "external",
                sourceVersionId: "external-v1",
                revision: 0,
                updatedAt: at,
                blockId: "old-personal-block",
                title: "回答当时的笔记",
                quote: "EMBEDDED_PERSONAL_HISTORY",
              },
            ],
            createdAt: at,
            attempt: {
              id: "answer-attempt",
              questionMessageId: "question",
              status: "completed",
              scopeSnapshot: {
                scope: "document",
                sourceId: "member",
                sourceIds: ["member"],
                sourceVersions: [{ sourceId: "member", versionId: "member-v2" }],
                spaceId: "selected",
              },
            },
          },
        ],
      },
      {
        id: "outside-conversation",
        spaceId: "outside",
        title: "OUTSIDE_CONVERSATION_SECRET",
        scope: "space",
        sourceIds: [],
        messages: [],
        resolved: false,
        updatedAt: at,
      },
    ];
    const from = snapshotKnowledgeNote(data.notes[0]);
    const to = {
      ...snapshotKnowledgeNote(data.notes[1]),
      spaceId: "selected",
      content: "EMBEDDED_KNOWLEDGE_HISTORY",
      citations: [citation(data.sources[1], true)],
    };
    data.conceptRelations = [
      {
        id: "selected-relation",
        spaceId: "selected",
        type: "related",
        from,
        to,
        fromClaim: "我的观点",
        toClaim: "另一页观点",
        fromCondition: "",
        toCondition: "",
        explanation: "已保存关系",
        fromCitations: from.citations,
        toCitations: to.citations,
        origin: "manual",
        revision: 0,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      },
      {
        id: "outside-relation",
        spaceId: "outside",
        type: "related",
        from: { ...from, spaceId: "outside", content: "OUTSIDE_RELATION_SECRET", citations: [] },
        to: { ...to, spaceId: "outside", citations: [] },
        fromClaim: "其他库",
        toClaim: "其他观点",
        fromCondition: "",
        toCondition: "",
        explanation: "其他库记录",
        fromCitations: [],
        toCitations: [],
        origin: "manual",
        revision: 0,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      },
    ];
    const request = {
      requestId: "selected-job",
      kind: "source" as const,
      trigger: "manual" as const,
      spaceId: "selected",
      sourceIds: ["external"],
      sourceVersions: [{ sourceId: "external", versionId: "external-v1" }],
    };
    data.organizationJobs = [
      {
        id: "selected-job",
        request,
        status: "ready",
        createdAt: at,
        updatedAt: at,
        result: {
          kind: "source",
          mode: "model",
          summary: {
            title: "结果",
            content: "SELECTED_JOB_RESULT",
            citations: [citation(data.sources[1], true)],
          },
          tags: [],
          topics: [],
          coverage: "有限范围",
        },
      },
      {
        id: "outside-job",
        request: { ...request, requestId: "outside-job", spaceId: "outside" },
        status: "ready",
        createdAt: at,
        updatedAt: at,
        result: {
          kind: "source",
          mode: "model",
          summary: { title: "私人总结", content: "OUTSIDE_JOB_SECRET", citations: [] },
          tags: [],
          topics: [],
          coverage: "其他范围",
        },
      },
    ];
    return data;
  }

  it("exports exact scoped objects, mappings and progress, then restores anchors and frozen evidence without outside current bodies", async () => {
    const data = scopedFixture();
    const memberOriginal = new Blob(["member original exact"]);
    const memberOldOriginal = new Blob(["member historical original exact"]);
    data.sources[0].size = memberOriginal.size;
    data.sources[0].versions![0].size = memberOldOriginal.size;
    const before = structuredClone(data);
    mocks.getBlob.mockImplementation(async (key: string) =>
      key === "member-key"
        ? memberOriginal
        : key === "member-old-key"
          ? memberOldOriginal
          : undefined,
    );
    const resolveBlob = vi.fn(async (source: Source) => {
      const local = source.blobKey ? await mocks.getBlob(source.blobKey) : undefined;
      if (local) return local;
      throw new Error("mock cloud original failed");
    });
    const progress = vi.fn();
    const result = await buildWorkspaceArchiveResult(data, {
      scope: { kind: "space", spaceId: "selected" },
      resolveBlob,
      onProgress: progress,
    });
    const zip = await JSZip.loadAsync(result.bytes);
    const allContents = (
      await Promise.all(
        Object.values(zip.files)
          .filter((file) => !file.dir)
          .map((file) => file.async("string")),
      )
    ).join("\n");
    for (const marker of [
      "OUTSIDE_LIBRARY_SECRET",
      "OUTSIDE_SOURCE_SECRET",
      "OUTSIDE_NOTE_CURRENT_SECRET",
      "OUTSIDE_NOTE_HISTORY_SECRET",
      "OUTSIDE_CONVERSATION_SECRET",
      "OUTSIDE_JOB_SECRET",
      "OUTSIDE_RELATION_SECRET",
    ])
      expect(allContents).not.toContain(marker);
    expect(allContents).toContain("EMBEDDED_PERSONAL_HISTORY");
    expect(allContents).toContain("EMBEDDED_KNOWLEDGE_HISTORY");
    const manifest = JSON.parse(await zip.file("export-scope.json")!.async("string"));
    expect(manifest).toEqual(
      JSON.parse(
        JSON.stringify(
          prepareWorkspaceExport(before, { kind: "space", spaceId: "selected" }).manifest,
        ),
      ),
    );
    expect(manifest.counts).toMatchObject({
      spaces: 1,
      sources: 2,
      sourceVersions: 4,
      notes: 1,
      conversations: 1,
      annotations: 1,
      importJobs: 1,
      organizationJobs: 1,
      conceptRelations: 1,
      recoverableDrafts: 1,
    });
    const mappings = JSON.parse(await zip.file("source-mapping.json")!.async("string"));
    expect(mappings).toHaveLength(2);
    expect(mappings.map((item: { versions: unknown[] }) => item.versions.length)).toEqual([1, 1]);
    expect(await zip.file(mappings[0].original)!.async("uint8array")).toEqual(
      new Uint8Array(await memberOriginal.arrayBuffer()),
    );
    expect(await zip.file(mappings[0].versions[0].original)!.async("uint8array")).toEqual(
      new Uint8Array(await memberOldOriginal.arrayBuffer()),
    );
    expect(mappings[1].original).toBeNull();
    expect(mappings[1].versions[0].original).toBeNull();
    expect(result.issues).toEqual([
      expect.objectContaining({
        sourceId: "external",
        versionId: "external-v2",
        code: "original-read-failed",
      }),
      expect.objectContaining({
        sourceId: "external",
        versionId: "external-v1",
        code: "original-missing",
      }),
    ]);
    expect(mocks.getBlob.mock.calls.map(([key]) => key)).toEqual([
      "member-key",
      "member-old-key",
      "external-key",
    ]);
    expect(
      progress.mock.calls
        .map(([event]) => event)
        .filter((event) => event.phase === "originals" && event.status !== "reading"),
    ).toEqual([
      expect.objectContaining({ completed: 1, total: 4, status: "included" }),
      expect.objectContaining({ completed: 2, total: 4, status: "included" }),
      expect.objectContaining({ completed: 3, total: 4, status: "failed" }),
      expect.objectContaining({ completed: 4, total: 4, status: "missing" }),
    ]);
    expect(
      JSON.parse(await zip.file("relation-mapping.json")!.async("string"))[0].to,
    ).toMatchObject({ availability: "missing", currentMetadata: null });
    expect(await zip.file("README.txt")!.async("string")).toContain("指定学习空间");
    const backup = await readWorkspaceBackup(
      new Blob([new Uint8Array(result.bytes)], { type: "application/zip" }),
    );
    const plan = prepareBackupRestore(backup);
    const restored = mergeBackupRestore(
      {
        schemaVersion: 1,
        spaces: [],
        sources: [],
        notes: [],
        conversations: [],
        annotations: [],
        aiEnabled: true,
      },
      plan,
    );
    expect(restored.sources.map((item) => item.spaceIds.length)).toEqual([1, 0]);
    expect(restored.importJobs![0].spaceId).toBe("");
    expect(restored.annotations[0]).toMatchObject({
      quote: "目标",
      textAnchor: { start: 5, end: 7 },
      note: "SELECTED_RECOVERY_USER_TEXT",
    });
    expect(restored.recoverableDrafts![0].textAnchor).toEqual(restored.annotations[0].textAnchor);
    expect(restored.sources[0].versions![0].text).toBe("😀目标\n目标");
    expect(restored.conceptRelations![0].to.content).toBe("EMBEDDED_KNOWLEDGE_HISTORY");
    expect(JSON.stringify(restored)).not.toContain("OUTSIDE_NOTE_CURRENT_SECRET");
    expect(data).toEqual(before);
  });

  it.each([
    "local-success",
    "local-failure",
    "blob-failure",
    "resolver-success",
    "resolver-failure",
  ])(
    "aborts all archive work when the account fence fails after %s, without converting it to an original issue",
    async (phase) => {
      const data = createDemoWorkspace();
      data.sources = [data.sources[0]];
      data.sources[0].blobKey = "guard-key";
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const pending = new Promise<void>((resolve) => {
        started = resolve;
      });
      const original = new Blob(["guarded bytes"]);
      const resolveBlob = vi.fn(async () => {
        started();
        await blocked;
        if (phase === "resolver-failure") throw new Error("provider failed");
        return original;
      });
      if (phase.startsWith("resolver")) mocks.getBlob.mockResolvedValue(undefined);
      else if (phase === "blob-failure") {
        vi.spyOn(original, "arrayBuffer").mockImplementation(async () => {
          started();
          await blocked;
          throw new Error("blob read failed");
        });
        mocks.getBlob.mockResolvedValue(original);
      } else
        mocks.getBlob.mockImplementation(async () => {
          started();
          await blocked;
          if (phase === "local-failure") throw new Error("disk failed");
          return original;
        });
      const changed = new Error("contextChanged");
      let allowed = true;
      let thrown = false;
      const assertCanContinue = () => {
        if (!allowed && !thrown) {
          thrown = true;
          throw changed;
        }
      };
      const progress = vi.fn();
      const generation = vi.spyOn(JSZip.prototype, "generateAsync");
      const build = buildWorkspaceArchiveResult(data, {
        resolveBlob,
        onProgress: progress,
        assertCanContinue,
      });
      const outcome = build.then(
        () => "unexpected completed archive",
        (cause: unknown) => cause,
      );
      await pending;
      allowed = false;
      release();
      expect(await outcome).toBe(changed);
      expect(generation).not.toHaveBeenCalled();
      expect(
        progress.mock.calls.some(
          ([event]) => event.phase === "originals" && ["missing", "failed"].includes(event.status),
        ),
      ).toBe(false);
    },
  );

  it("checks a pure-text export before work and after actual ZIP generation settles", async () => {
    const data = createDemoWorkspace();
    const changed = new Error("contextChanged");
    const nativeGenerate = JSZip.prototype.generateAsync;
    const generation = vi.spyOn(JSZip.prototype, "generateAsync");
    await expect(
      buildWorkspaceArchiveResult(data, {
        assertCanContinue: () => {
          throw changed;
        },
      }),
    ).rejects.toBe(changed);
    expect(generation).not.toHaveBeenCalled();
    let allowed = true;
    generation.mockRestore();
    const spy = vi.spyOn(JSZip.prototype, "generateAsync").mockImplementation(async function (
      this: JSZip,
      options,
    ) {
      const result = await nativeGenerate.call(this, options);
      allowed = false;
      return result;
    });
    await expect(
      buildWorkspaceArchiveResult(data, {
        assertCanContinue: () => {
          if (!allowed) throw changed;
        },
      }),
    ).rejects.toBe(changed);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fences the final browser click and revokes a staged URL instead of downloading after context drift", async () => {
    const data = createDemoWorkspace();
    const changed = new Error("contextChanged");
    let allowed = true;
    const link = { href: "", download: "", remove: vi.fn(), click: vi.fn() };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => link),
      body: {
        appendChild: vi.fn(() => {
          allowed = false;
        }),
      },
    });
    vi.stubGlobal("window", { setTimeout: vi.fn() });
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:staged-export");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await expect(
      exportWorkspace(data, undefined, {
        assertCanContinue: () => {
          if (!allowed) throw changed;
        },
      }),
    ).rejects.toBe(changed);
    expect(create).toHaveBeenCalledTimes(1);
    expect(link.click).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:staged-export");
    expect(link.remove).toHaveBeenCalled();
  });
});

describe("portable workspace backup", () => {
  it("keeps restored missing originals visibly incomplete in subsequent backups", async () => {
    const data = createDemoWorkspace();
    data.sources[0].originalMissing = true;
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    const mapping = JSON.parse(await zip.file("source-mapping.json")!.async("string"));
    expect(mapping[0].original).toBeNull();
    expect(mapping[0].originalStatus).toContain("缺少此版本");
    expect(await zip.file("README.txt")!.async("string")).toContain("原文件缺失：1 份");
    expect(await zip.file("README.txt")!.async("string")).toContain("本次导出不完整");
    expect(mocks.getBlob).not.toHaveBeenCalled();
  });
  it("includes exact originals, version mappings, recycle state and note history", async () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    source.blobKey = "original-key";
    source.filename = "../../metadata.json";
    source.deletedAt = "2026-09-12T00:00:00Z";
    const original = new Blob(["original bytes\u0000\u00ff"]);
    mocks.getBlob.mockResolvedValueOnce(original);
    data.notes.push({
      id: "note-a",
      spaceId: data.spaces[0].id,
      title: "我的笔记",
      content: "比较两种学习率。",
      kind: "note",
      status: "accepted",
      citations: [],
      versions: [{ id: "old", title: "旧标题", content: "旧内容", savedAt: "2026-09-11" }],
      createdAt: "",
      updatedAt: "",
      deletedAt: null,
    });
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    const state = JSON.parse(await zip.file("workspace.json")!.async("string"));
    expect(state.sources[0].deletedAt).toBe(source.deletedAt);
    expect(state.notes[0].versions[0].content).toBe("旧内容");
    const mappings = JSON.parse(await zip.file("source-mapping.json")!.async("string"));
    const mapping = mappings[0];
    expect(mapping.versionId).toBe(source.versionId);
    expect(mapping.original).not.toContain("../");
    expect(await zip.file(mapping.original)!.async("uint8array")).toEqual(
      new Uint8Array(await original.arrayBuffer()),
    );
    expect(await zip.file("README.txt")!.async("string")).toContain("原文件缺失：0 份");
    expect(zip.file("conversations.json")).toBeTruthy();
    expect(zip.file("annotations.json")).toBeTruthy();
  });

  it("exports recoverable annotation drafts with exact deleted-source context", async () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    const deletedAt = "2026-09-14T08:00:00.000Z";
    source.deletedAt = deletedAt;
    const annotation = {
      id: "offline-annotation",
      sourceId: source.id,
      versionId: source.versionId,
      quote: source.chunks[0].text,
      note: "我在离线设备补充的人工理解。",
      page: source.chunks[0].page,
      createdAt: "2026-09-14T07:58:00.000Z",
    };
    data.annotations.push(annotation);
    data.recoverableDrafts = [
      createRecoverableSourceAnnotationDraft(source, deletedAt, annotation),
    ];
    data.resolvedRecoverableDrafts = [
      resolveRecoverableSourceAnnotationDraft(
        {
          id: recoverableSourceAnnotationDraftId("handled-offline-annotation", deletedAt),
          sourceId: source.id,
          annotationId: "handled-offline-annotation",
          sourceDeletedAt: deletedAt,
        },
        "remove",
      ),
    ];
    const before = structuredClone(data);

    const archive = await buildWorkspaceArchive(data);
    const zip = await JSZip.loadAsync(archive);
    expect(JSON.parse(await zip.file("recoverable-drafts.json")!.async("string"))).toEqual(
      before.recoverableDrafts,
    );
    expect(JSON.parse(await zip.file("workspace.json")!.async("string")).recoverableDrafts).toEqual(
      before.recoverableDrafts,
    );
    expect(JSON.parse(await zip.file("resolved-recoverable-drafts.json")!.async("string"))).toEqual(
      before.resolvedRecoverableDrafts,
    );
    expect(
      JSON.parse(await zip.file("workspace.json")!.async("string")).resolvedRecoverableDrafts,
    ).toEqual(before.resolvedRecoverableDrafts);
    const readme = `${await zip.file("README.txt")!.async("string")}\n${await zip
      .file("recoverable-drafts/README.txt")!
      .async("string")}`;
    expect(readme).toContain("recoverable-drafts.json");
    expect(readme).toContain("note 是用户新增的批注文字");
    expect(readme).toContain("记录本身不会自动恢复资料");
    expect(readme).toContain("较旧设备重新生成已处理草稿");
    const parsed = await readWorkspaceBackup(
      new Blob([new Uint8Array(archive)], { type: "application/zip" }),
    );
    expect(parsed.data.recoverableDrafts).toEqual(before.recoverableDrafts);
    expect(parsed.data.resolvedRecoverableDrafts).toEqual(before.resolvedRecoverableDrafts);
    expect(data).toEqual(before);
  });

  it("explicitly identifies unavailable cloud originals rather than silently omitting them", async () => {
    const data = createDemoWorkspace();
    data.sources[0].storagePath = "account/source/original.pdf";
    data.sources[0].blobKey = "not-on-this-device";
    mocks.getBlob.mockResolvedValue(undefined);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    expect(await zip.file("README.txt")!.async("string")).toContain("本次导出不完整");
    const mappings = JSON.parse(await zip.file("source-mapping.json")!.async("string"));
    expect(mappings[0].original).toBeNull();
    expect(mappings[0].originalStatus).toContain("缺少");
  });

  it("includes a cloud original through the caller's account-bound resolver", async () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    source.storagePath = "account/source/original.md";
    source.blobKey = "missing-local";
    mocks.getBlob.mockResolvedValue(undefined);
    const original = new Blob(["cloud original bytes"]);
    const resolve = vi.fn(async () => original);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data, resolve));
    const mappings = JSON.parse(await zip.file("source-mapping.json")!.async("string"));
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ id: source.id, versionId: source.versionId }),
    );
    expect(await zip.file(mappings[0].original)!.async("string")).toBe("cloud original bytes");
    expect(await zip.file("README.txt")!.async("string")).toContain("原文件缺失：0 份");
  });

  it("keeps the archive usable and reports one failed original with structured progress", async () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    source.storagePath = "account/source/original.md";
    const resolve = vi.fn(async () => {
      throw new Error("当前账号已改变");
    });
    const progress = vi.fn();
    const result = await buildWorkspaceArchiveResult(data, {
      resolveBlob: resolve,
      onProgress: progress,
    });
    const zip = await JSZip.loadAsync(result.bytes);
    const mapping = JSON.parse(await zip.file("source-mapping.json")!.async("string"));
    expect(mapping[0].original).toBeNull();
    expect(mapping[0].originalStatus).toContain("当前账号已改变");
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "original-read-failed",
        sourceId: source.id,
        versionId: source.versionId,
        versionState: "current",
        message: expect.stringContaining("当前账号已改变"),
      }),
    ]);
    expect(JSON.parse(await zip.file("export-issues.json")!.async("string"))).toEqual(
      result.issues,
    );
    expect(await zip.file("workspace.json")!.async("string")).toContain(source.id);
    expect(progress.mock.calls.map(([item]) => item)).toEqual([
      expect.objectContaining({
        phase: "originals",
        completed: 0,
        total: 1,
        sourceId: source.id,
        versionId: source.versionId,
        status: "reading",
      }),
      expect.objectContaining({
        phase: "originals",
        completed: 1,
        total: 1,
        sourceId: source.id,
        versionId: source.versionId,
        status: "failed",
      }),
      { phase: "archive", completed: 0, total: 1 },
      { phase: "archive", completed: 1, total: 1 },
    ]);
    const compatible = await buildWorkspaceArchive(data, resolve);
    expect(compatible).toBeInstanceOf(Uint8Array);
  });

  it("continues to later originals after one resolver failure", async () => {
    const data = createDemoWorkspace();
    const first = data.sources[0];
    first.blobKey = "first-local";
    first.storagePath = "account/first/original.md";
    const second = structuredClone(first);
    second.id = "second-source";
    second.versionId = "second-version";
    second.blobKey = "second-local";
    second.storagePath = "account/second/original.md";
    second.chunks = second.chunks.map((chunk) => ({
      ...chunk,
      sourceId: second.id,
      versionId: second.versionId,
    }));
    data.sources = [first, second];
    mocks.getBlob.mockResolvedValue(undefined);
    const resolve = vi.fn(async (item: Source) => {
      if (item.id === first.id) throw new Error("网络暂不可用");
      return new Blob(["later original"]);
    });

    const result = await buildWorkspaceArchiveResult(data, { resolveBlob: resolve });
    const zip = await JSZip.loadAsync(result.bytes);
    const mapping = JSON.parse(await zip.file("source-mapping.json")!.async("string"));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      sourceId: first.id,
      versionId: first.versionId,
      code: "original-read-failed",
    });
    expect(mapping[0].original).toBeNull();
    expect(await zip.file(mapping[1].original)!.async("string")).toBe("later original");
    expect(resolve.mock.calls.map(([item]) => item.id)).toEqual([first.id, first.id, second.id]);
  });

  it("uses the cloud-only resolver fallback after IndexedDB throws", async () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    source.blobKey = "failed-local-read";
    source.storagePath = "account/source/original.md";
    const resolve = vi.fn(async (_source: Source, options) => {
      if (!options) throw new Error("IndexedDB transaction closed");
      expect(options).toEqual({ preferCloud: true });
      return new Blob(["cloud fallback original"]);
    });

    const result = await buildWorkspaceArchiveResult(data, { resolveBlob: resolve });
    const zip = await JSZip.loadAsync(result.bytes);
    const mapping = JSON.parse(await zip.file("source-mapping.json")!.async("string"));
    expect(result.issues).toEqual([]);
    expect(await zip.file(mapping[0].original)!.async("string")).toBe("cloud fallback original");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(mocks.getBlob).not.toHaveBeenCalled();
  });

  it("clips oversized original-read errors so the archive remains restorable", async () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    source.blobKey = "broken-local-read";
    mocks.getBlob.mockRejectedValueOnce(new Error("x".repeat(10_000)));

    const result = await buildWorkspaceArchiveResult(data);
    const zip = await JSZip.loadAsync(result.bytes);
    const mapping = JSON.parse(await zip.file("source-mapping.json")!.async("string"));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain("已截断");
    expect(mapping[0].originalStatus.length).toBeLessThanOrEqual(2_000);
    await expect(
      readWorkspaceBackup(new Blob([new Uint8Array(result.bytes)], { type: "application/zip" })),
    ).resolves.toBeDefined();
  });

  it("still rejects structurally invalid retained versions", async () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    const invalid: SourceVersion = {
      versionId: source.versionId,
      title: source.title,
      filename: source.filename,
      kind: source.kind,
      mime: source.mime,
      size: source.size,
      hash: source.hash,
      status: source.status,
      text: source.text,
      chunks: source.chunks,
      createdAt: source.createdAt,
      archivedAt: source.updatedAt,
    };
    source.versions = [invalid];
    await expect(buildWorkspaceArchiveResult(data)).rejects.toThrow("历史版本记录无效");
  });

  it("exports knowledge drafts, all saved versions and exact raw HTML alongside readable Markdown", async () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    const chunk = source.chunks[0];
    const raw =
      "<h2>知识摘要</h2><p><strong>结论</strong>与原文 [1]</p><script>window.bad = true</script>";
    data.notes.push({
      id: "knowledge-1",
      spaceId: data.spaces[0].id,
      title: "知识草稿",
      content: raw,
      kind: "knowledge",
      status: "draft",
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
      versions: [
        {
          id: "v-old",
          title: "历史一",
          content: "<p><em>历史正文</em></p>",
          savedAt: "2026-09-11T00:00:00Z",
        },
        {
          id: "v-old",
          title: "历史二",
          content: "旧的 **Markdown**",
          savedAt: "2026-09-12T00:00:00Z",
        },
      ],
      createdAt: "",
      updatedAt: "",
      deletedAt: "2026-09-12T00:00:00Z",
    });
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    const mapping = JSON.parse(await zip.file("note-mapping.json")!.async("string"))[0];
    expect(mapping).toMatchObject({
      kind: "knowledge",
      status: "draft",
      deletedAt: "2026-09-12T00:00:00Z",
      originalFormat: "html",
    });
    const markdown = await zip.file(mapping.markdown)!.async("string");
    expect(markdown).toContain("## 知识摘要");
    expect(markdown).toContain("**结论**");
    expect(markdown).toContain("## 引用来源");
    expect(markdown).toContain(source.versionId);
    expect(markdown).not.toContain("window.bad");
    expect(await zip.file(mapping.original)!.async("string")).toBe(raw);
    expect(mapping.original).toMatch(/\.html\.txt$/);
    const html = await zip.file(mapping.html)!.async("string");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("<strong>结论</strong>");
    expect(html).not.toContain("<script");
    expect(mapping.versions).toHaveLength(2);
    expect(mapping.versions[0].markdown).not.toBe(mapping.versions[1].markdown);
    expect(await zip.file(mapping.versions[0].markdown)!.async("string")).toContain("*历史正文*");
    expect(await zip.file(mapping.versions[1].markdown)!.async("string")).toContain("**Markdown**");
    expect(
      mapping.versions.every(
        (version: { historicalCitationsAvailable: boolean }) =>
          version.historicalCitationsAvailable === false,
      ),
    ).toBe(true);
    const citations = JSON.parse(await zip.file(mapping.citations)!.async("string"));
    expect(citations[0]).toMatchObject({
      ...JSON.parse(JSON.stringify(data.notes[0].citations[0])),
      number: 1,
      metadataPath: `../../sources/${source.id}/metadata.json`,
    });
    expect(await zip.file("workspace.json")!.async("string")).toContain("window.bad");
  });

  it("does not redirect a citation to the wrong source version", async () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    data.notes.push({
      id: "note-stale",
      spaceId: data.spaces[0].id,
      title: "旧引用",
      content: "<p>引用旧版</p>",
      kind: "note",
      status: "accepted",
      citations: [
        {
          sourceId: source.id,
          versionId: "unavailable-old-version",
          chunkId: "old-chunk",
          title: source.title,
          quote: "旧版原话",
          section: "旧版",
        },
      ],
      versions: [],
      createdAt: "",
      updatedAt: "",
      deletedAt: null,
    });
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    const mapping = JSON.parse(await zip.file("note-mapping.json")!.async("string"))[0];
    const citation = JSON.parse(await zip.file(mapping.citations)!.async("string"))[0];
    expect(citation.versionId).toBe("unavailable-old-version");
    expect(citation.metadataPath).toBeNull();
    expect(await zip.file(mapping.markdown)!.async("string")).toContain("所引用的资料版本未包含");
  });

  it("exports personal-note answer evidence separately from source citations", async () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    const noteEvidence: AnswerNoteEvidence[] = [
      {
        noteId: "note-review",
        spaceId: data.spaces[0].id,
        sourceId: source.id,
        sourceVersionId: source.versionId,
        revision: 3,
        updatedAt: "2026-09-13T00:00:00.000Z",
        blockId: "block-1",
        title: "我的学习率复盘",
        quote: "我记下：损失反复上下波动时，应该先降低学习率。",
      },
    ];
    data.conversations.push({
      id: "conversation-note-evidence",
      spaceId: data.spaces[0].id,
      sourceId: source.id,
      title: "学习率问题",
      scope: "document-notes",
      sourceIds: [source.id],
      resolved: false,
      updatedAt: "2026-09-13T00:00:00.000Z",
      messages: [
        {
          id: "assistant-note-evidence",
          role: "assistant",
          content: "这是当时保存的回答。",
          citations: [],
          noteEvidence,
          mode: "model",
          createdAt: "2026-09-13T00:00:00.000Z",
        },
      ],
    });

    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    const mapping = JSON.parse(await zip.file("conversation-mapping.json")!.async("string"))[0];
    const message = mapping.messages[0];
    expect(message.noteEvidence).toContain("note-evidence.json");
    expect(JSON.parse(await zip.file(message.noteEvidence)!.async("string"))).toEqual(noteEvidence);
    expect(await zip.file(message.markdown)!.async("string")).toContain("## 我的笔记依据");
    expect(await zip.file(message.markdown)!.async("string")).toContain("不是原始资料");
    expect(await zip.file(message.html)!.async("string")).toContain(noteEvidence[0].quote);
    expect(await zip.file(mapping.markdown)!.async("string")).toContain("不是原始资料");
  });
});

describe("historical note evidence in portable exports", () => {
  const citation = (source: Source): Citation => ({
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: source.chunks[0].id,
    title: source.title,
    quote: source.chunks[0].text,
    section: source.chunks[0].section,
    page: source.chunks[0].page,
  });
  function fixture() {
    const data = createDemoWorkspace();
    const note: Note = {
      id: "note-history",
      spaceId: data.spaces[0].id,
      title: "当前知识页",
      content: "<p>当前内容 [1]</p>",
      kind: "knowledge",
      status: "accepted",
      aiGenerated: false,
      contentRevision: 5,
      citations: [citation(data.sources[1])],
      versions: [
        {
          id: "historical-version",
          title: "历史知识页",
          content: "<p>历史内容 [1]</p>",
          savedAt: "2026-09-11T00:00:00Z",
          citations: [citation(data.sources[0])],
          status: "draft",
          aiGenerated: true,
          spaceId: "historical-space",
          contentRevision: 4,
        },
      ],
      createdAt: "2026-09-10T00:00:00Z",
      updatedAt: "2026-09-12T00:00:00Z",
      deletedAt: null,
    };
    data.notes.push(note);
    return { data, note };
  }

  it("exports historical citations separately from current evidence and preserves version metadata", async () => {
    const { data, note } = fixture();
    const original = structuredClone(data);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    const mapping = JSON.parse(await zip.file("note-mapping.json")!.async("string"))[0];
    const historical = mapping.versions[0];
    expect(historical).toMatchObject({
      historicalCitationsAvailable: true,
      status: "draft",
      aiGenerated: true,
      spaceId: "historical-space",
      contentRevision: 4,
    });
    expect(historical.citations).not.toBe(mapping.citations);
    const citations = JSON.parse(await zip.file(historical.citations)!.async("string"));
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      ...JSON.parse(JSON.stringify(note.versions[0].citations![0])),
      number: 1,
      sourceAvailability: "included",
      sourceMetadata: `sources/${data.sources[0].id}/metadata.json`,
      metadataPath: `../../../../sources/${data.sources[0].id}/metadata.json`,
    });
    const linkedPath = posix.normalize(
      posix.join(posix.dirname(historical.markdown), citations[0].metadataPath),
    );
    expect(zip.file(linkedPath)).toBeTruthy();
    const linkedSource = JSON.parse(await zip.file(linkedPath)!.async("string"));
    expect(linkedSource.id).toBe(data.sources[0].id);
    expect(linkedSource.versionId).toBe(note.versions[0].citations![0].versionId);
    for (const path of [historical.markdown, historical.html]) {
      const rendered = await zip.file(path)!.async("string");
      expect(rendered).toContain("引用来源");
      expect(rendered).toContain(data.sources[0].id);
      expect(rendered).toContain(data.sources[0].versionId);
      expect(rendered).not.toContain(data.sources[1].id);
      expect(rendered).not.toContain(data.sources[1].versionId);
    }
    const current = JSON.parse(await zip.file(mapping.citations)!.async("string"));
    expect(current[0].sourceId).toBe(data.sources[1].id);
    const metadata = JSON.parse(await zip.file(historical.metadata)!.async("string"));
    expect(metadata).toEqual(JSON.parse(JSON.stringify(note.versions[0])));
    expect(await zip.file(historical.original)!.async("string")).toBe(note.versions[0].content);
    expect(data).toEqual(original);
  });

  it("distinguishes recorded empty references from missing legacy snapshots", async () => {
    const { data, note } = fixture();
    note.versions[0].citations = [];
    note.versions.push({
      id: "legacy-no-citations",
      title: "旧版没有引用快照",
      content: "<p>旧版没有引用记录。</p>",
      savedAt: "2026-09-10T00:00:00Z",
    });
    const original = structuredClone(data);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    const mapping = JSON.parse(await zip.file("note-mapping.json")!.async("string"))[0];
    const [empty, old] = mapping.versions;
    expect(empty.historicalCitationsAvailable).toBe(true);
    expect(JSON.parse(await zip.file(empty.citations)!.async("string"))).toEqual([]);
    expect(old).toMatchObject({
      historicalCitationsAvailable: false,
      citations: null,
      status: null,
      aiGenerated: null,
      spaceId: null,
      contentRevision: null,
    });
    expect(zip.file(`${posix.dirname(old.metadata)}/citations.json`)).toBeNull();
    for (const version of [empty, old]) {
      for (const path of [version.markdown, version.html]) {
        const rendered = await zip.file(path)!.async("string");
        expect(rendered).not.toContain("引用来源");
        expect(rendered).not.toContain(data.sources[1].id);
      }
    }
    const readme = await zip.file("README.txt")!.async("string");
    expect(readme).toContain("空数组也表示已记录");
    expect(readme).toContain("旧版未记录引用快照时标记 false");
    expect(data).toEqual(original);
  });

  it.each(["source_missing", "version_missing"])(
    "preserves unavailable historical quotations without linking current metadata: %s",
    async (condition) => {
      const { data, note } = fixture();
      const historicalCitation = structuredClone(note.versions[0].citations![0]);
      if (condition === "source_missing") data.sources = data.sources.slice(1);
      else data.sources[0].versionId = "newer-source-version";
      const original = structuredClone(data);
      const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
      const mapping = JSON.parse(await zip.file("note-mapping.json")!.async("string"))[0]
        .versions[0];
      const values = JSON.parse(await zip.file(mapping.citations)!.async("string"));
      expect(mapping.historicalCitationsAvailable).toBe(true);
      expect(values[0]).toMatchObject({
        ...JSON.parse(JSON.stringify(historicalCitation)),
        sourceMetadata: null,
        metadataPath: null,
        sourceAvailability: condition,
      });
      for (const path of [mapping.markdown, mapping.html]) {
        const rendered = await zip.file(path)!.async("string");
        expect(rendered).toContain("所引用的资料版本未包含");
        expect(rendered).toContain(historicalCitation.versionId);
        expect(rendered).not.toContain("newer-source-version");
        expect(rendered).not.toContain(`sources/${historicalCitation.sourceId}/metadata.json`);
      }
      expect(data).toEqual(original);
    },
  );

  it("escapes historical quote text in readable HTML while retaining exact citation data", async () => {
    const { data, note } = fixture();
    const historical = note.versions[0].citations![0];
    historical.title = '<img src="https://remote.invalid/pixel">';
    historical.quote = '<script>alert("quote")</script>\n第二行';
    historical.section = '<a onclick="bad()">章节</a>';
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    const mapping = JSON.parse(await zip.file("note-mapping.json")!.async("string"))[0].versions[0];
    const html = await zip.file(mapping.html)!.async("string");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a onclick");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<br>第二行");
    const citations = JSON.parse(await zip.file(mapping.citations)!.async("string"));
    expect(citations[0].quote).toBe(historical.quote);
  });
});

describe("portable concept relation records", () => {
  function fixture() {
    const data = createDemoWorkspace();
    const now = "2026-09-12T00:00:00Z";
    const cites = data.sources.map((source): Citation => ({
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: source.chunks[0].id,
      title: source.title,
      quote: source.chunks[0].text,
      section: source.chunks[0].section,
      page: source.chunks[0].page,
    }));
    data.notes = ["from-page", "to-page"].map((id, index): Note => ({
      id,
      title: id,
      content: `<p>记录时的${id}正文</p>`,
      spaceId: data.spaces[0].id,
      kind: "knowledge",
      status: "accepted",
      contentRevision: index + 2,
      citations: [cites[index]],
      versions: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }));
    const relations = (["synonym", "related", "prerequisite", "conflict"] as RelationType[]).map(
      (type, index): ConceptRelation => ({
        id: `relation-${index}`,
        type,
        spaceId: data.spaces[0].id,
        from: snapshotKnowledgeNote(data.notes[0]),
        to: snapshotKnowledgeNote(data.notes[1]),
        fromClaim: "起点记录的观点",
        toClaim: "终点记录的观点",
        fromCondition: "起点适用条件",
        toCondition: "终点适用条件",
        explanation: "用于核对的关系说明",
        fromCitations: [cites[0]],
        toCitations: [cites[1]],
        origin: index % 2 ? "manual" : "ai",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
    );
    data.conceptRelations = relations;
    return { data, relations };
  }
  it("exports all four types, fixed prerequisite direction, provenance, separate evidence and exact endpoint baselines", async () => {
    const { data, relations } = fixture();
    const original = structuredClone(data);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    expect(JSON.parse(await zip.file("relations.json")!.async("string"))).toEqual(
      JSON.parse(JSON.stringify(relations)),
    );
    const mapping = JSON.parse(await zip.file("relation-mapping.json")!.async("string"));
    expect(mapping.map((item: { type: string }) => item.type)).toEqual([
      "synonym",
      "related",
      "prerequisite",
      "conflict",
    ]);
    expect(mapping.map((item: { direction: string }) => item.direction)).toEqual([
      "symmetric",
      "symmetric",
      "from_before_to",
      "symmetric",
    ]);
    expect(mapping.map((item: { origin: string }) => item.origin)).toEqual([
      "ai",
      "manual",
      "ai",
      "manual",
    ]);
    for (const item of mapping) {
      expect(item.availability).toBe("current");
      expect(item.from).toMatchObject({
        noteId: data.notes[0].id,
        revision: 2,
        availability: "current",
        currentMetadata: "notes/from-page/metadata.json",
      });
      expect(item.to).toMatchObject({
        noteId: data.notes[1].id,
        revision: 3,
        availability: "current",
      });
      expect(JSON.parse(await zip.file(item.from.snapshot)!.async("string"))).toEqual(
        JSON.parse(JSON.stringify(relations[0].from)),
      );
      const citations = JSON.parse(await zip.file(item.citations)!.async("string"));
      expect(citations.from[0].sourceId).toBe(data.sources[0].id);
      expect(citations.to[0].sourceId).toBe(data.sources[1].id);
      const reportSource = posix.normalize(
        posix.join(posix.dirname(item.markdown), citations.from[0].metadataPath),
      );
      expect(zip.file(reportSource)).toBeTruthy();
      const endpointCites = JSON.parse(await zip.file(item.from.citations)!.async("string"));
      const endpointSource = posix.normalize(
        posix.join(posix.dirname(item.from.markdown), endpointCites[0].metadataPath),
      );
      expect(endpointSource).toBe(reportSource);
      for (const path of [item.markdown, item.html]) {
        const text = await zip.file(path)!.async("string");
        expect(text).toContain("起点记录的观点");
        expect(text).toContain("终点记录的观点");
        expect(text).toContain("起点适用条件");
        expect(text).toContain("终点适用条件");
        expect(text).toContain(item.origin === "ai" ? "AI 建议" : "手动记录");
        if (item.type === "prerequisite") expect(text).toContain("是终点");
      }
    }
    expect(data).toEqual(original);
  });
  it("keeps deleted relations and old endpoint contents when pages change or disappear", async () => {
    const { data, relations } = fixture();
    relations[0].deletedAt = "2026-09-12T01:00:00Z";
    data.notes[0].content = "<p>NEW_CURRENT_PAGE_ONLY</p>";
    data.notes[0].contentRevision = 20;
    data.notes.pop();
    const original = structuredClone(data);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    const mapping = JSON.parse(await zip.file("relation-mapping.json")!.async("string"));
    expect(mapping[0]).toMatchObject({
      availability: "deleted",
      deletedAt: relations[0].deletedAt,
    });
    expect(mapping[1].availability).toBe("needs_review");
    for (const item of mapping) {
      expect(item.from).toMatchObject({
        availability: "changed",
        revision: 2,
        currentMetadata: null,
      });
      expect(item.to).toMatchObject({
        availability: "missing",
        revision: 3,
        currentMetadata: null,
      });
      expect(await zip.file(item.from.markdown)!.async("string")).toContain(
        "记录时的from-page正文",
      );
      expect(await zip.file(item.from.markdown)!.async("string")).not.toContain(
        "NEW_CURRENT_PAGE_ONLY",
      );
      expect(JSON.parse(await zip.file(item.to.snapshot)!.async("string"))).toEqual(
        JSON.parse(JSON.stringify(relations[0].to)),
      );
    }
    expect(data).toEqual(original);
  });
  it("marks missing and changed source versions without linking current evidence into either side", async () => {
    const { data, relations } = fixture();
    const oldVersion = data.sources[0].versionId;
    data.sources[0].versionId = "NEW_SOURCE_VERSION";
    data.sources.pop();
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    const mapping = JSON.parse(await zip.file("relation-mapping.json")!.async("string"));
    for (const item of mapping) {
      expect(item.availability).toBe("needs_review");
      const cites = JSON.parse(await zip.file(item.citations)!.async("string"));
      expect(cites.from[0]).toMatchObject({
        versionId: oldVersion,
        sourceAvailability: "version_missing",
        sourceMetadata: null,
        metadataPath: null,
      });
      expect(cites.to[0]).toMatchObject({
        sourceId: relations[0].toCitations[0].sourceId,
        sourceAvailability: "source_missing",
        sourceMetadata: null,
        metadataPath: null,
      });
      const html = await zip.file(item.html)!.async("string");
      expect(html).toContain("所引用的资料版本未包含");
      expect(html).toContain(oldVersion);
      expect(html).not.toContain("NEW_SOURCE_VERSION");
    }
  });
  it("renders script-like relation text and quotations inertly while preserving original JSON", async () => {
    const { data, relations } = fixture();
    data.conceptRelations = [relations[0]];
    const relation = relations[0];
    relation.fromClaim = '<script>alert("claim")</script>';
    relation.toCondition = '<img src="https://remote.invalid/pixel">';
    relation.explanation = '<a href="javascript:bad()">关系</a>';
    relation.fromCitations[0] = {
      ...relation.fromCitations[0],
      quote: '<svg onload="bad()">引用原话</svg>',
    };
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data));
    const mapping = JSON.parse(await zip.file("relation-mapping.json")!.async("string"))[0];
    const html = await zip.file(mapping.html)!.async("string");
    for (const tag of ["<script", "<img", "<svg", '<a href="javascript:'])
      expect(html).not.toContain(tag);
    expect(html).toMatch(/(?:&lt;|&#x3c;|&#60;)script/i);
    expect(html).toContain("引用原话");
    const markdown = await zip.file(mapping.markdown)!.async("string");
    expect(markdown).not.toMatch(/(?:^|\n)\s*<script\b/);
    expect(markdown).toContain('alert("claim")');
    expect(JSON.parse(await zip.file(mapping.metadata)!.async("string"))).toEqual(
      JSON.parse(JSON.stringify(relation)),
    );
    expect(JSON.parse(await zip.file("relations.json")!.async("string"))[0].fromClaim).toBe(
      relation.fromClaim,
    );
  });
});
