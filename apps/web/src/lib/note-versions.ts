import type { Note, NoteVersion } from "./types";

export function noteVersion(note: Note): NoteVersion {
  return {
    id: crypto.randomUUID(),
    title: note.title,
    content: note.content,
    savedAt: note.updatedAt,
    citations: note.citations.map((citation) => ({ ...citation })),
    status: note.status,
    aiGenerated: note.aiGenerated ?? false,
    spaceId: note.spaceId,
    contentRevision: note.contentRevision ?? 0,
    ...(note.manualExcerptRefs !== undefined
      ? { manualExcerptRefs: note.manualExcerptRefs.map((reference) => ({ ...reference })) }
      : {}),
  };
}

/** All current note writers advance a monotonic revision, including restore/ABA edits. */
export function reviseNote(
  note: Note,
  patch: Partial<
    Pick<
      Note,
      | "title"
      | "content"
      | "citations"
      | "status"
      | "spaceId"
      | "aiGenerated"
      | "deletedAt"
      | "manualExcerptRefs"
    >
  >,
  history: "always" | "debounced" | "none" = "debounced",
): Note {
  const fields = Object.keys(patch) as (keyof typeof patch)[];
  if (fields.every((key) => JSON.stringify(note[key]) === JSON.stringify(patch[key]))) return note;
  const revision = note.contentRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER - 1)
    throw new Error("知识页版本已无法继续递增，请先导出副本。");
  const record =
    history === "always" ||
    (history === "debounced" &&
      !!note.content &&
      (!note.versions.length ||
        Date.now() - new Date(note.versions.at(-1)!.savedAt).getTime() > 60000));
  const refs = Object.hasOwn(patch, "manualExcerptRefs")
    ? patch.manualExcerptRefs
    : note.manualExcerptRefs;
  return {
    ...note,
    ...patch,
    citations: patch.citations
      ? patch.citations.map((citation) => ({ ...citation }))
      : note.citations,
    ...(refs !== undefined
      ? { manualExcerptRefs: refs.map((reference) => ({ ...reference })) }
      : {}),
    contentRevision: revision + 1,
    updatedAt: new Date().toISOString(),
    versions: record ? [...note.versions, noteVersion(note)].slice(-30) : note.versions,
  };
}

export function restoreNoteVersion(note: Note, versionId: string): Note {
  const version = note.versions.find((item) => item.id === versionId);
  if (!version) throw new Error("这个历史版本已不可用。");
  // Older snapshots had no source/status metadata: never relabel current citations as historical.
  return reviseNote(
    note,
    {
      title: version.title,
      content: version.content,
      citations: version.citations ?? [],
      status: version.status ?? (note.kind === "knowledge" ? "draft" : note.status),
      aiGenerated: version.aiGenerated ?? note.aiGenerated,
      manualExcerptRefs: version.manualExcerptRefs?.map((reference) => ({ ...reference })) ?? [],
    },
    "always",
  );
}
