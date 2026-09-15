import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { createAnnotation } from "./annotations";
import { readWorkspaceBackup } from "./backup-archive";
import { prepareBackupRestore } from "./backup-restore";
import { buildWorkspaceArchiveResult } from "./export";
import { chunkText } from "./import";
import { createRecoverableSourceAnnotationDraft } from "./recoverable-drafts";
import { restoreSourceFromRecoverableDraft } from "./recoverable-draft-actions";
import { resolveSavedCitation } from "./retrieval";
import { createEmptyWorkspace } from "./seed";
import { getSourceVersion } from "./source-versions";
import { workspaceSchema } from "./supabase/validation";
import type { Source, SourceVersion, WorkspaceData } from "./types";

describe("selected knowledge-base ZIP through strict portable backup restoration", () => {
  it("keeps referenced histories, original bytes, anchored recovery drafts and citations without unrelated bodies", async () => {
    const at = "2026-09-15T00:00:00.000Z";
    const originals = new Map<string, Blob>();
    const key = (sourceId: string, versionId: string) => JSON.stringify([sourceId, versionId]);
    const historySentence = "😀 学习 **梯度下降**。";
    function version(id: string, versionId: string, text: string): SourceVersion {
      originals.set(key(id, versionId), new Blob([text], { type: "text/markdown" }));
      return {
        versionId,
        title: id,
        filename: `${id}-${versionId}.md`,
        kind: "markdown",
        mime: "text/markdown",
        size: new TextEncoder().encode(text).length,
        hash: createHash("sha256").update(text).digest("hex"),
        status: "ready",
        text,
        chunks: chunkText(text, id, versionId),
        blobKey: `original:${id}:${versionId}`,
        createdAt: at,
        archivedAt: at,
      };
    }
    function source(id: string, spaceId: string, text: string, history?: string): Source {
      const current = version(id, `${id}-current`, text);
      const result: Source = {
        ...current,
        id,
        spaceIds: [spaceId],
        tags: [],
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        aiAllowed: false,
        starred: false,
        ...(history ? { versions: [version(id, `${id}-history`, history)] } : {}),
      };
      Reflect.deleteProperty(result, "archivedAt");
      return result;
    }
    const selected = source(
      "selected",
      "selected-space",
      "SELECTED_CURRENT_BODY",
      "SELECTED_HISTORY_BODY",
    );
    const external = source(
      "external",
      "other-space",
      "EXTERNAL_CURRENT_BODY",
      `# 原文位置\n\n${historySentence}\n\n${historySentence}`,
    );
    const unrelated = source("unrelated", "other-space", "UNRELATED_SOURCE_PRIVATE_BODY");
    const oldExternal = getSourceVersion(external, "external-history")!;
    const start = oldExternal.text.lastIndexOf(historySentence);
    const annotation = createAnnotation(
      {
        id: "external-position",
        sourceId: external.id,
        versionId: oldExternal.versionId,
        quote: historySentence,
        textAnchor: { start, end: start + historySentence.length },
        note: "EXTERNAL_ANNOTATION_CONTEXT",
        createdAt: at,
      },
      oldExternal,
    );
    external.deletedAt = at;
    const recoverable = createRecoverableSourceAnnotationDraft(external, at, annotation);
    const citation = {
      sourceId: external.id,
      versionId: oldExternal.versionId,
      chunkId: oldExternal.chunks.at(-1)!.id,
      title: external.title,
      quote: oldExternal.chunks.at(-1)!.text,
      section: "原文位置",
    };
    const fixture: WorkspaceData = {
      ...createEmptyWorkspace(),
      spaces: [
        {
          id: "selected-space",
          name: "所选知识库",
          goal: "",
          color: "blue",
          archived: true,
          createdAt: at,
        },
        {
          id: "other-space",
          name: "UNRELATED_LIBRARY_PRIVATE_METADATA",
          goal: "",
          color: "red",
          archived: false,
          createdAt: at,
        },
      ],
      sources: [selected, external, unrelated],
      notes: [
        {
          id: "selected-note",
          spaceId: "selected-space",
          title: "知识页",
          content: "<p>SELECTED_KNOWLEDGE_BODY</p>",
          kind: "knowledge",
          status: "accepted",
          citations: [citation],
          versions: [],
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
        },
        {
          id: "other-note",
          spaceId: "other-space",
          title: "其他库笔记",
          content: "<p>UNRELATED_NOTE_PRIVATE_BODY</p>",
          kind: "note",
          status: "accepted",
          citations: [],
          versions: [],
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
        },
      ],
      annotations: [annotation],
      recoverableDrafts: [recoverable],
      conversations: [
        {
          id: "selected-conversation",
          spaceId: "selected-space",
          title: "所选问题",
          scope: "sources",
          sourceIds: [external.id],
          messages: [
            {
              id: "selected-answer",
              role: "assistant",
              content: "SELECTED_ANSWER_BODY",
              citations: [citation],
              createdAt: at,
            },
          ],
          resolved: true,
          updatedAt: at,
        },
        {
          id: "other-conversation",
          spaceId: "other-space",
          title: "UNRELATED_CONVERSATION_PRIVATE_BODY",
          scope: "space",
          sourceIds: [unrelated.id],
          messages: [],
          resolved: true,
          updatedAt: at,
        },
      ],
    };
    const data = workspaceSchema.parse(fixture);
    const before = structuredClone(data);
    const resolveBlob = vi.fn(async (item: Source) => originals.get(key(item.id, item.versionId)));
    const options = { scope: { kind: "space", spaceId: "selected-space" } as const, resolveBlob };
    const archive = await buildWorkspaceArchiveResult(data, options);
    expect(archive.issues).toEqual([]);
    const zip = await JSZip.loadAsync(archive.bytes);
    const bodies = (
      await Promise.all(
        Object.values(zip.files)
          .filter((file) => !file.dir)
          .map((file) => file.async("string")),
      )
    ).join("\n");
    for (const marker of [
      "UNRELATED_SOURCE_PRIVATE_BODY",
      "UNRELATED_NOTE_PRIVATE_BODY",
      "UNRELATED_CONVERSATION_PRIVATE_BODY",
      "UNRELATED_LIBRARY_PRIVATE_METADATA",
    ])
      expect(bodies).not.toContain(marker);
    for (const marker of [
      "SELECTED_CURRENT_BODY",
      "SELECTED_HISTORY_BODY",
      "EXTERNAL_CURRENT_BODY",
      historySentence,
      "EXTERNAL_ANNOTATION_CONTEXT",
    ])
      expect(bodies).toContain(marker);
    expect(resolveBlob.mock.calls.map(([item]) => key(item.id, item.versionId))).toEqual([
      key("selected", "selected-current"),
      key("selected", "selected-history"),
      key("external", "external-current"),
      key("external", "external-history"),
    ]);
    const backup = await readWorkspaceBackup(
      new Blob([new Uint8Array(archive.bytes)], { type: "application/zip" }),
    );
    expect(backup.data.spaces.map((space) => space.id)).toEqual(["selected-space"]);
    expect(backup.data.sources.map((item) => item.id)).toEqual(["selected", "external"]);
    expect(backup.data.sources[1]!.spaceIds).toEqual([]);
    expect(backup.originals).toHaveLength(4);
    expect(backup.missingOriginals).toEqual([]);
    expect(backup.data.annotations).toEqual([annotation]);
    expect(backup.data.recoverableDrafts).toEqual([recoverable]);
    const plan = prepareBackupRestore(backup);
    expect(workspaceSchema.parse(plan.data)).toEqual(plan.data);
    expect(plan.data.spaces[0]!.id).not.toBe("selected-space");
    expect(plan.data.sources[0]!.spaceIds).toEqual([plan.data.spaces[0]!.id]);
    expect(plan.data.sources[1]!.spaceIds).toEqual([]);
    expect(plan.blobs).toHaveLength(4);
    const restoredAnnotation = plan.data.annotations[0]!;
    const restoredExternal = plan.data.sources.find(
      (item) => item.id === restoredAnnotation.sourceId,
    )!;
    const restoredVersion = getSourceVersion(restoredExternal, restoredAnnotation.versionId)!;
    expect(restoredExternal.id).not.toBe(external.id);
    expect(restoredAnnotation.versionId).not.toBe(oldExternal.versionId);
    expect(restoredAnnotation.textAnchor).toEqual(annotation.textAnchor);
    expect(
      restoredVersion.text.slice(
        restoredAnnotation.textAnchor!.start,
        restoredAnnotation.textAnchor!.end,
      ),
    ).toBe(historySentence);
    expect(restoredVersion.text.lastIndexOf(historySentence)).toBe(
      restoredAnnotation.textAnchor!.start,
    );
    expect(plan.data.recoverableDrafts![0]).toMatchObject({
      sourceId: restoredExternal.id,
      sourceVersionId: restoredVersion.versionId,
      annotationId: restoredAnnotation.id,
      textAnchor: annotation.textAnchor,
    });
    const restoredCitation = plan.data.notes[0]!.citations[0]!;
    expect(resolveSavedCitation(plan.data, restoredCitation)).toBeNull();
    const recovered = restoreSourceFromRecoverableDraft(
      plan.data,
      plan.data.recoverableDrafts![0]!.id,
      at,
    );
    expect(workspaceSchema.parse(recovered)).toEqual(recovered);
    expect(resolveSavedCitation(recovered, restoredCitation)?.chunk.id).toBe(
      restoredVersion.chunks.at(-1)!.id,
    );
    expect(restoredCitation.quote).toBe(citation.quote);
    expect(restoredCitation.versionId).toBe(restoredVersion.versionId);
    expect(plan.data.conversations[0]!.messages[0]!.citations[0]).toEqual(restoredCitation);
    expect(data).toEqual(before);
  });
});
