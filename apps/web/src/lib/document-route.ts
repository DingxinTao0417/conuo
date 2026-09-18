export interface SourceRoute {
  sourceId: string;
  versionId?: string;
}

export interface NoteRoute {
  noteId: string;
  panel?: "relations" | "update" | "ask";
}

/** The identity contract used by persisted sources, versions, and notes. */
const documentIdPattern = /^[a-zA-Z0-9_-]{1,100}$/;

function decodeDocumentId(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  try {
    const id = decodeURIComponent(segment);
    return documentIdPattern.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function routePath(hash: string): string[] | undefined {
  if (typeof hash !== "string" || !hash.startsWith("#")) return undefined;
  const [path] = hash.slice(1).split("?");
  return path!.split("/");
}

/** A malformed historical URL must never fall through to the current version. */
export function parseSourceRoute(hash: string): SourceRoute | undefined {
  const path = routePath(hash);
  if (!path || path[0] !== "source" || (path.length !== 2 && path.length !== 4)) return undefined;
  const sourceId = decodeDocumentId(path[1]);
  if (!sourceId) return undefined;
  if (path.length === 2) return { sourceId };
  if (path[2] !== "version") return undefined;
  const versionId = decodeDocumentId(path[3]);
  return versionId ? { sourceId, versionId } : undefined;
}

/** Matches the supported note panels without guessing a view from extra segments. */
export function parseNoteRoute(hash: string): NoteRoute | undefined {
  const path = routePath(hash);
  if (!path || path[0] !== "note" || (path.length !== 2 && path.length !== 3)) return undefined;
  const noteId = decodeDocumentId(path[1]);
  if (!noteId) return undefined;
  if (path.length === 2) return { noteId };
  const panel = path[2];
  return panel === "relations" || panel === "update" || panel === "ask"
    ? { noteId, panel }
    : undefined;
}
