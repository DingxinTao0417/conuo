import { describe, expect, it } from "vitest";
import { prepareWorkspaceExport, workspaceExportFingerprint } from "./export-scope";
import { createDemoWorkspace } from "./seed";
import { snapshotKnowledgeNote } from "./knowledge-update";
import { workspaceSchema } from "./supabase/validation";
import {
  createRecoverableSourceAnnotationDraft,
  recoverableSourceAnnotationDraftId,
  resolveRecoverableSourceAnnotationDraft,
} from "./recoverable-drafts";
import { createImportJob } from "./import-queue";
import type { Citation, Note, Source, WorkspaceData } from "./types";

const at = "2026-09-15T00:00:00.000Z";

function fixture() {
  const data = createDemoWorkspace();
  data.spaces = [
    { id: "selected", name: "目标学习", goal: "", color: "blue", archived: true, createdAt: at },
    {
      id: "other",
      name: "UNRELATED_LIBRARY_SECRET",
      goal: "private",
      color: "red",
      archived: false,
      createdAt: at,
    },
  ];
  function source(id: string, spaceIds: string[]): Source {
    return {
      ...data.sources[0],
      id,
      versionId: `${id}-v2`,
      title: id,
      spaceIds,
      text: `${id} CURRENT_BODY`,
      chunks: [
        {
          id: `${id}-c2`,
          sourceId: id,
          versionId: `${id}-v2`,
          text: `${id} CURRENT_BODY`,
          section: "正文",
          order: 0,
        },
      ],
      coverage: undefined,
      blobKey: undefined,
      storagePath: undefined,
      originalMissing: undefined,
      versions: [
        {
          versionId: `${id}-v1`,
          title: `${id} old`,
          filename: "old.md",
          kind: "markdown",
          mime: "text/markdown",
          size: 10,
          hash: "old-hash",
          status: "ready",
          text: `${id} HISTORICAL_BODY`,
          chunks: [
            {
              id: `${id}-c1`,
              sourceId: id,
              versionId: `${id}-v1`,
              text: `${id} HISTORICAL_BODY`,
              section: "旧正文",
              order: 0,
            },
          ],
          createdAt: at,
          archivedAt: at,
        },
      ],
    };
  }
  data.sources = [
    source("member", ["selected", "other"]),
    source("external", ["other"]),
    source("scope", ["other"]),
    source("job", ["other"]),
    source("relation", ["other"]),
    source("UNRELATED_SOURCE_SECRET", ["other"]),
  ];
  data.sources[0].deletedAt = at;
  const cite = (id: string, old = false): Citation => {
    const version = old
      ? data.sources.find((item) => item.id === id)!.versions![0]
      : data.sources.find((item) => item.id === id)!;
    return {
      sourceId: id,
      versionId: version.versionId,
      chunkId: version.chunks[0].id,
      title: id,
      quote: version.chunks[0].text,
      section: "正文",
    };
  };
  const note = (id: string, spaceId: string, content: string): Note => ({
    id,
    spaceId,
    title: id,
    content,
    kind: "knowledge",
    status: "accepted",
    citations: [],
    versions: [],
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  });
  data.notes = [
    note("selected-note", "selected", "SELECTED_BODY"),
    note("private-note", "other", "UNRELATED_CURRENT_NOTE_SECRET"),
  ];
  data.notes[0].deletedAt = at;
  data.notes[0].versions = [
    {
      id: "note-history",
      title: "旧笔记",
      content: "SELECTED_NOTE_HISTORY",
      citations: [cite("external", true)],
      manualExcerptRefs: [
        {
          sourceId: "scope",
          versionId: "scope-v1",
          chunkId: "scope-c1",
          selectionFingerprint: "1111111111111111",
        },
      ],
      spaceId: "other",
      savedAt: at,
    },
  ];
  data.conversations = [
    {
      id: "selected-conversation",
      spaceId: "selected",
      title: "我的问题",
      scope: "sources",
      sourceIds: ["scope"],
      resolved: false,
      updatedAt: at,
      messages: [
        {
          id: "answer",
          role: "assistant",
          content: "SELECTED_ANSWER",
          createdAt: at,
          citations: [],
          noteEvidence: [
            {
              noteId: "private-note",
              spaceId: "other",
              sourceId: "external",
              sourceVersionId: "external-v1",
              revision: 0,
              updatedAt: at,
              blockId: "private-block",
              title: "历史摘录",
              quote: "EMBEDDED_PERSONAL_EVIDENCE",
            },
          ],
          attempt: {
            id: "attempt",
            questionMessageId: "question",
            status: "completed",
            scopeSnapshot: {
              scope: "sources",
              spaceId: "selected",
              sourceIds: ["scope"],
              sourceVersions: [{ sourceId: "scope", versionId: "scope-v1" }],
            },
          },
        },
      ],
    },
    {
      id: "private-conversation",
      spaceId: "other",
      title: "UNRELATED_CONVERSATION_SECRET",
      scope: "space",
      sourceIds: [],
      resolved: true,
      messages: [],
      updatedAt: at,
    },
  ];
  const frozen = snapshotKnowledgeNote(data.notes[0]);
  const foreign = {
    ...snapshotKnowledgeNote(data.notes[1]),
    spaceId: "selected",
    content: "EMBEDDED_RELATION_HISTORY",
    citations: [cite("relation", true)],
  };
  data.conceptRelations = [
    {
      id: "relationship",
      spaceId: "selected",
      from: frozen,
      to: foreign,
      type: "related",
      fromClaim: "本页",
      toClaim: "另一页",
      fromCondition: "",
      toCondition: "",
      explanation: "已保存关系",
      fromCitations: [],
      toCitations: [cite("relation", true)],
      origin: "manual",
      revision: 0,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    },
  ];
  data.organizationJobs = [
    {
      id: "selected-job",
      request: {
        requestId: "selected-job",
        kind: "source",
        trigger: "manual",
        spaceId: "selected",
        sourceIds: ["job"],
        sourceVersions: [{ sourceId: "job", versionId: "job-v1" }],
      },
      status: "ready",
      createdAt: at,
      updatedAt: at,
      result: {
        kind: "source",
        mode: "model",
        coverage: "有限范围",
        summary: { title: "总结", content: "SELECTED_JOB_RESULT", citations: [cite("job", true)] },
        tags: [],
        topics: [],
      },
    },
  ];
  data.annotations = [
    {
      id: "member-annotation",
      sourceId: "member",
      versionId: "member-v1",
      quote: "member HISTORICAL_BODY",
      note: "成员批注",
      createdAt: at,
    },
    {
      id: "foreign-annotation",
      sourceId: "external",
      versionId: "external-v1",
      quote: "external HISTORICAL_BODY",
      note: "外部资料批注",
      createdAt: at,
    },
  ];
  data.conversations[0].messages.unshift({
    id: "question",
    role: "user",
    content: "原问题",
    citations: [],
    createdAt: at,
  });
  return { data, cite };
}

describe("designated-space export snapshot", () => {
  it("does not pull another space's saved relation or task when its current endpoint later moved into the selected space", () => {
    const { data, cite } = fixture();
    const originalRelation = data.conceptRelations![0];
    data.conceptRelations!.push({
      ...structuredClone(originalRelation),
      id: "foreign-record",
      spaceId: "other",
      from: {
        ...originalRelation.from,
        spaceId: "other",
        content: "FOREIGN_RELATION_BODY_SECRET",
        citations: [cite("UNRELATED_SOURCE_SECRET", true)],
      },
      to: { ...originalRelation.to, spaceId: "other" },
      fromCitations: [cite("UNRELATED_SOURCE_SECRET", true)],
      explanation: "FOREIGN_RELATION_EXPLANATION_SECRET",
    });
    data.organizationJobs!.push({
      ...structuredClone(data.organizationJobs![0]),
      id: "foreign-job",
      request: {
        ...data.organizationJobs![0].request,
        requestId: "foreign-job",
        spaceId: "other",
        sourceIds: ["UNRELATED_SOURCE_SECRET"],
        sourceVersions: [
          { sourceId: "UNRELATED_SOURCE_SECRET", versionId: "UNRELATED_SOURCE_SECRET-v1" },
        ],
      },
      result: {
        kind: "source",
        mode: "model",
        summary: {
          title: "其他库结果",
          content: "FOREIGN_JOB_BODY_SECRET",
          citations: [cite("UNRELATED_SOURCE_SECRET", true)],
        },
        tags: [],
        topics: [],
        coverage: "有限范围",
      },
    });
    expect(workspaceSchema.safeParse(data).success).toBe(true);
    const prepared = prepareWorkspaceExport(data, { kind: "space", spaceId: "selected" });
    expect(prepared.data.conceptRelations!.map((value) => value.id)).toEqual(["relationship"]);
    expect(prepared.data.organizationJobs!.map((value) => value.id)).toEqual(["selected-job"]);
    for (const marker of [
      "FOREIGN_RELATION_BODY_SECRET",
      "FOREIGN_RELATION_EXPLANATION_SECRET",
      "FOREIGN_JOB_BODY_SECRET",
      "UNRELATED_SOURCE_SECRET",
    ])
      expect(JSON.stringify(prepared)).not.toContain(marker);
  });

  type AttachReference = (data: WorkspaceData, citation: Citation) => void;
  const paths: [string, AttachReference][] = [
    [
      "current note citation",
      (data, citation) => {
        data.notes[0].citations = [citation];
      },
    ],
    [
      "historical note citation",
      (data, citation) => {
        data.notes[0].versions[0].citations = [citation];
      },
    ],
    [
      "current manual excerpt",
      (data, citation) => {
        data.notes[0].manualExcerptRefs = [
          {
            sourceId: citation.sourceId,
            versionId: citation.versionId,
            chunkId: citation.chunkId,
            selectionFingerprint: "1111111111111111",
          },
        ];
      },
    ],
    [
      "historical manual excerpt",
      (data, citation) => {
        data.notes[0].versions[0].manualExcerptRefs = [
          {
            sourceId: citation.sourceId,
            versionId: citation.versionId,
            chunkId: citation.chunkId,
            selectionFingerprint: "1111111111111111",
          },
        ];
      },
    ],
    [
      "conversation current source",
      (data, citation) => {
        data.conversations[0].sourceId = citation.sourceId;
      },
    ],
    [
      "conversation selected source",
      (data, citation) => {
        data.conversations[0].sourceIds.push(citation.sourceId);
      },
    ],
    [
      "message citation",
      (data, citation) => {
        data.conversations[0].messages[1].citations = [citation];
      },
    ],
    [
      "message frozen personal evidence",
      (data, citation) => {
        data.conversations[0].messages[1].noteEvidence![0].sourceId = citation.sourceId;
        data.conversations[0].messages[1].noteEvidence![0].sourceVersionId = citation.versionId;
      },
    ],
    [
      "attempt single source",
      (data, citation) => {
        data.conversations[0].messages[1].attempt!.scopeSnapshot.sourceId = citation.sourceId;
      },
    ],
    [
      "attempt selected source",
      (data, citation) => {
        data.conversations[0].messages[1].attempt!.scopeSnapshot.sourceIds.push(citation.sourceId);
      },
    ],
    [
      "attempt fixed version",
      (data, citation) => {
        data.conversations[0].messages[1].attempt!.scopeSnapshot.sourceVersions!.push({
          sourceId: citation.sourceId,
          versionId: citation.versionId,
        });
      },
    ],
    [
      "conversation comparison fixed version",
      (data, citation) => {
        data.conversations[0].comparison = {
          leftSourceId: "scope",
          leftVersionId: "scope-v1",
          rightSourceId: citation.sourceId,
          rightVersionId: citation.versionId,
        };
      },
    ],
    [
      "attempt comparison fixed version",
      (data, citation) => {
        data.conversations[0].messages[1].attempt!.scopeSnapshot.comparison = {
          leftSourceId: "scope",
          leftVersionId: "scope-v1",
          rightSourceId: citation.sourceId,
          rightVersionId: citation.versionId,
        };
      },
    ],
    [
      "organization fixed request version",
      (data, citation) => {
        data.organizationJobs![0].request.sourceVersions.push({
          sourceId: citation.sourceId,
          versionId: citation.versionId,
        });
      },
    ],
    [
      "organization summary",
      (data, citation) => {
        data.organizationJobs![0].result = {
          kind: "source",
          mode: "model",
          summary: { title: "总结", content: "正文", citations: [citation] },
          tags: [],
          topics: [],
          coverage: "有限范围",
        };
      },
    ],
    [
      "organization tag",
      (data, citation) => {
        data.organizationJobs![0].result = {
          kind: "source",
          mode: "model",
          summary: { title: "总结", content: "正文", citations: [] },
          tags: [{ label: "标签", citations: [citation] }],
          topics: [],
          coverage: "有限范围",
        };
      },
    ],
    [
      "organization topic",
      (data, citation) => {
        data.organizationJobs![0].result = {
          kind: "source",
          mode: "model",
          summary: { title: "总结", content: "正文", citations: [] },
          tags: [],
          topics: [{ label: "主题", citations: [citation] }],
          coverage: "有限范围",
        };
      },
    ],
    [
      "knowledge result page",
      (data, citation) => {
        data.organizationJobs![0].result = {
          kind: "knowledge",
          mode: "model",
          pages: [{ title: "知识页", content: "正文", citations: [citation] }],
          coverage: "有限范围",
        };
      },
    ],
    [
      "update target",
      (data, citation) => {
        data.organizationJobs![0].result = {
          kind: "update",
          mode: "model",
          target: { ...snapshotKnowledgeNote(data.notes[0]), citations: [citation] },
          changes: [],
          coverage: "有限范围",
        };
      },
    ],
    [
      "update change",
      (data, citation) => {
        data.organizationJobs![0].result = {
          kind: "update",
          mode: "model",
          target: snapshotKnowledgeNote(data.notes[0]),
          changes: [
            {
              id: "change",
              type: "replace",
              blockId: "block",
              before: "之前",
              after: "之后",
              reason: "新增依据",
              citations: [citation],
            },
          ],
          coverage: "有限范围",
        };
      },
    ],
    [
      "update review baseline",
      (data, citation) => {
        data.organizationJobs![0].updateReview = {
          note: { ...snapshotKnowledgeNote(data.notes[0]), citations: [citation] },
          applied: [],
          ignored: [],
        };
      },
    ],
    [
      "relation result target",
      (data, citation) => {
        data.organizationJobs![0].result = {
          kind: "relations",
          mode: "model",
          target: { ...snapshotKnowledgeNote(data.notes[0]), citations: [citation] },
          compare: snapshotKnowledgeNote(data.notes[1]),
          relations: [],
          coverage: "有限范围",
        };
      },
    ],
    [
      "relation result compare",
      (data, citation) => {
        data.organizationJobs![0].result = {
          kind: "relations",
          mode: "model",
          target: snapshotKnowledgeNote(data.notes[0]),
          compare: { ...snapshotKnowledgeNote(data.notes[1]), citations: [citation] },
          relations: [],
          coverage: "有限范围",
        };
      },
    ],
    [
      "relation result from citation",
      (data, citation) => {
        data.organizationJobs![0].result = {
          kind: "relations",
          mode: "model",
          target: snapshotKnowledgeNote(data.notes[0]),
          compare: snapshotKnowledgeNote(data.notes[1]),
          relations: [
            {
              id: "proposal",
              type: "related",
              fromClaim: "起点",
              toClaim: "终点",
              fromCondition: "",
              toCondition: "",
              explanation: "关系",
              fromCitations: [citation],
              toCitations: [],
            },
          ],
          coverage: "有限范围",
        };
      },
    ],
    [
      "relation result to citation",
      (data, citation) => {
        data.organizationJobs![0].result = {
          kind: "relations",
          mode: "model",
          target: snapshotKnowledgeNote(data.notes[0]),
          compare: snapshotKnowledgeNote(data.notes[1]),
          relations: [
            {
              id: "proposal",
              type: "related",
              fromClaim: "起点",
              toClaim: "终点",
              fromCondition: "",
              toCondition: "",
              explanation: "关系",
              fromCitations: [],
              toCitations: [citation],
            },
          ],
          coverage: "有限范围",
        };
      },
    ],
    [
      "saved relation from citation",
      (data, citation) => {
        data.conceptRelations![0].fromCitations = [citation];
      },
    ],
    [
      "saved relation to citation",
      (data, citation) => {
        data.conceptRelations![0].toCitations = [citation];
      },
    ],
    [
      "saved relation frozen from baseline",
      (data, citation) => {
        data.conceptRelations![0].from.citations = [citation];
      },
    ],
    [
      "saved relation frozen to baseline",
      (data, citation) => {
        data.conceptRelations![0].to.citations = [citation];
      },
    ],
  ];
  it.each(paths)(
    "keeps traceable external source history reached by %s without importing its current note",
    (description, attach) => {
      const { data, cite } = fixture();
      const citation = cite("UNRELATED_SOURCE_SECRET", true);
      attach(data, citation);
      const prepared = prepareWorkspaceExport(data, { kind: "space", spaceId: "selected" });
      const additional = prepared.preview.additionalSources.find(
        (value) => value.sourceId === citation.sourceId,
      );
      expect(additional?.versions, description).toEqual([
        { versionId: "UNRELATED_SOURCE_SECRET-v2", state: "current" },
        { versionId: citation.versionId, state: "historical" },
      ]);
      expect(prepared.data.notes.map((value) => value.id)).toEqual(["selected-note"]);
      expect(prepared.data.spaces.map((value) => value.id)).toEqual(["selected"]);
      expect(
        prepared.preview.missingReferences.filter((value) => value.sourceId === citation.sourceId),
      ).toEqual([]);
    },
  );

  it("keeps source-bound recovery and import history while excluding unrelated deletion text", () => {
    const { data } = fixture();
    const other = data.sources.at(-1)!;
    other.deletedAt = at;
    const original = data.annotations[0];
    original.textAnchor = { start: 0, end: original.quote.length };
    const unrelated = {
      id: "unrelated-annotation",
      sourceId: other.id,
      versionId: other.versions![0].versionId,
      quote: other.versions![0].text,
      note: "UNRELATED_RECOVERY_SECRET",
      createdAt: at,
    };
    data.annotations.push(unrelated);
    data.recoverableDrafts = [
      createRecoverableSourceAnnotationDraft(data.sources[0], at, original),
      createRecoverableSourceAnnotationDraft(other, at, unrelated),
    ];
    data.resolvedRecoverableDrafts = [data.sources[0], other].map((source) => {
      const annotationId = `handled-${source.id}`;
      return resolveRecoverableSourceAnnotationDraft(
        {
          id: recoverableSourceAnnotationDraftId(annotationId, at),
          sourceId: source.id,
          annotationId,
          sourceDeletedAt: at,
        },
        "retain",
      );
    });
    data.importJobs = [
      createImportJob({
        sourceId: "member",
        versionId: "member-v2",
        spaceId: "selected",
        filename: "member.md",
        at,
      }),
      createImportJob({
        sourceId: "external",
        versionId: "external-v1",
        spaceId: "other",
        filename: "external.md",
        at,
      }),
      createImportJob({
        sourceId: other.id,
        versionId: other.versionId,
        spaceId: "other",
        filename: "unrelated.md",
        at,
      }),
    ];
    const prepared = prepareWorkspaceExport(data, { kind: "space", spaceId: "selected" });
    expect(prepared.data.importJobs!.map((value) => value.spaceId)).toEqual(["selected", ""]);
    expect(prepared.data.recoverableDrafts).toEqual([data.recoverableDrafts[0]]);
    expect(prepared.data.resolvedRecoverableDrafts).toEqual([data.resolvedRecoverableDrafts[0]]);
    expect(prepared.data.annotations).toEqual(data.annotations.slice(0, 2));
    expect(JSON.stringify(prepared.data)).not.toContain("UNRELATED_RECOVERY_SECRET");
    expect(workspaceSchema.safeParse(prepared.data).success).toBe(true);
  });

  it("keeps exact histories and required source evidence without pulling foreign current notes or libraries", () => {
    const { data } = fixture();
    const before = structuredClone(data);
    const prepared = prepareWorkspaceExport(data, { kind: "space", spaceId: "selected" });
    expect(prepared.data.spaces.map((item) => item.id)).toEqual(["selected"]);
    expect(prepared.data.sources.map((item) => item.id)).toEqual([
      "member",
      "external",
      "scope",
      "job",
      "relation",
    ]);
    expect(prepared.data.sources[0].spaceIds).toEqual(["selected"]);
    expect(prepared.data.sources.slice(1).every((item) => item.spaceIds.length === 0)).toBe(true);
    expect(prepared.data.notes).toEqual([before.notes[0]]);
    expect(prepared.data.conversations).toEqual([before.conversations[0]]);
    expect(prepared.data.conceptRelations).toEqual(before.conceptRelations);
    expect(prepared.preview.additionalSources.map((item) => item.sourceId)).toEqual([
      "external",
      "scope",
      "job",
      "relation",
    ]);
    expect(prepared.preview.additionalSources[0].versions).toEqual([
      { versionId: "external-v2", state: "current" },
      { versionId: "external-v1", state: "historical" },
    ]);
    expect(prepared.preview.counts).toMatchObject({
      spaces: 1,
      sources: 5,
      sourceVersions: 10,
      notes: 1,
      knowledgePages: 1,
      recycledSources: 1,
      recycledNotes: 1,
      conversations: 1,
      annotations: 2,
      organizationJobs: 1,
      conceptRelations: 1,
    });
    expect(prepared.preview.warnings.join(" ")).toMatch(/历史.*快照|快照.*历史/);
    const encoded = JSON.stringify(prepared.data);
    for (const marker of [
      "UNRELATED_LIBRARY_SECRET",
      "UNRELATED_SOURCE_SECRET",
      "UNRELATED_CURRENT_NOTE_SECRET",
      "UNRELATED_CONVERSATION_SECRET",
    ])
      expect(encoded).not.toContain(marker);
    expect(encoded).toContain("EMBEDDED_PERSONAL_EVIDENCE");
    expect(encoded).toContain("EMBEDDED_RELATION_HISTORY");
    expect(data).toEqual(before);
    expect(Object.isFrozen(prepared.data.sources[0].versions![0].chunks[0])).toBe(true);
    expect(workspaceSchema.parse(prepared.data)).toEqual(prepared.data);
  });

  it("reports absent source, retained version, and chunk identities rather than relinking to current content", () => {
    const { data, cite } = fixture();
    data.notes[0].citations = [
      { ...cite("external"), sourceId: "missing-source" },
      { ...cite("external"), versionId: "missing-version" },
      { ...cite("external", true), chunkId: "missing-chunk" },
    ];
    data.sources[1].versions![0].originalMissing = true;
    const prepared = prepareWorkspaceExport(data, { kind: "space", spaceId: "selected" });
    expect(prepared.preview.missingReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "missing-source" }),
        expect.objectContaining({ sourceId: "external", versionId: "missing-version" }),
        expect.objectContaining({
          sourceId: "external",
          versionId: "external-v1",
          chunkId: "missing-chunk",
        }),
      ]),
    );
    expect(prepared.preview.knownMissingOriginals).toEqual([
      expect.objectContaining({
        sourceId: "external",
        versionId: "external-v1",
        state: "historical",
      }),
    ]);
    expect(prepared.data.notes[0].citations).toEqual(data.notes[0].citations);
  });

  it("rejects a missing or ambiguous selected space and leaves full workspace snapshots compatible", () => {
    const { data } = fixture();
    expect(() => prepareWorkspaceExport(data, { kind: "space", spaceId: "missing" })).toThrow(
      /空间/,
    );
    data.spaces.push({ ...data.spaces[0] });
    expect(() => prepareWorkspaceExport(data, { kind: "space", spaceId: "selected" })).toThrow(
      /空间/,
    );
    expect(prepareWorkspaceExport(data, { kind: "workspace" }).data).toEqual(data);
  });

  it("fingerprints only the reviewed scope and its included evidence, including currently unreferenced source history", () => {
    const { data } = fixture();
    const scope = { kind: "space", spaceId: "selected" } as const;
    const fingerprint = workspaceExportFingerprint(data, scope);
    data.notes[1].content = "another unrelated change";
    data.sources.at(-1)!.text = "another unrelated source";
    expect(workspaceExportFingerprint(data, scope)).toBe(fingerprint);
    data.sources[1].text = "changed required external current version";
    expect(workspaceExportFingerprint(data, scope)).not.toBe(fingerprint);
    const current = workspaceExportFingerprint(data, scope);
    data.sources[1].versions![0].text += " changed history";
    expect(workspaceExportFingerprint(data, scope)).not.toBe(current);
    const history = workspaceExportFingerprint(data, scope);
    data.spaces[0].name = "new reviewed name";
    expect(workspaceExportFingerprint(data, scope)).not.toBe(history);
  });
});
