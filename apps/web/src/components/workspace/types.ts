import type { useWorkspace } from "@/lib/use-workspace";
import type { WorkspaceSearchAskDraft } from "../workspace-search";

/** Everything `useWorkspace()` returns; sections receive it whole or pick fields off it. */
export type WorkspaceStore = ReturnType<typeof useWorkspace>;
export type WorkspaceUser = WorkspaceStore["user"];
export type WorkspaceStorageMode = "hybrid" | "cloud";

/** Every dialog the workspace shell can show; `null` means none is open. */
export type WorkspaceModal =
  | "import"
  | "space"
  | "account"
  | "details"
  | "recognized-content"
  | "history"
  | "compare-source"
  | "bulk-tags"
  | "bulk-spaces"
  | "bulk-recycle"
  | "export"
  | "export-result"
  | "restore"
  | "legacy-recovery"
  | "delete-space"
  | "purge-source"
  | "conversation-history"
  | "sync-conflict"
  | null;

/** A question hand-off from workspace search into the cross-library ask panel. */
export type CrossLibrarySearchDraft = WorkspaceSearchAskDraft & { id: string };

/** A search hit to highlight inside the note editor once the matching revision is open. */
export type NoteSearchTarget = {
  noteId: string;
  revision: number;
  updatedAt: string;
  text: string;
};
