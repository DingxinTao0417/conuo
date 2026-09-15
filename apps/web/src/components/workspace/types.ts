import type { useWorkspace } from "@/lib/use-workspace";
import type { WorkspaceSearchAskDraft } from "../workspace-search";

/** Everything `useWorkspace()` returns; sections receive it whole or pick fields off it. */
export type WorkspaceStore = ReturnType<typeof useWorkspace>;
export type WorkspaceUser = WorkspaceStore["user"];
export type WorkspaceStorageMode = "hybrid" | "cloud";

/** A question hand-off from workspace search into the cross-library ask panel. */
export type CrossLibrarySearchDraft = WorkspaceSearchAskDraft & { id: string };
