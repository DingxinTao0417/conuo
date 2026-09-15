"use client";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

/**
 * Every lazily loaded workspace panel is declared here, in one module, so the
 * `dynamic()` calls run in a single, stable order during module evaluation.
 *
 * Several workspace tests mock `next/dynamic` and identify a panel by the
 * position of its `dynamic()` call (ConceptRelations = 1, KnowledgeUpdate = 2,
 * Organization = 3, TaskCenter = 4, OrganizationHistoryControl = 5, Reader = 6,
 * ComparisonReader = 7, NoteEditor = 8, Account = 9, BackupRestore = 10,
 * LegacyBrowserRecovery = 11, CrossLibraryAsk = 12, NoteAsk = 13).
 * Do not reorder or split these declarations without updating those tests.
 */
export const ConceptRelationsPanel = dynamic(() => import("../concept-relations-panel"), {
  ssr: false,
});
export const KnowledgeUpdatePanel = dynamic(() => import("../knowledge-update-panel"), {
  ssr: false,
});
export const OrganizationPanel = dynamic(() => import("../organization-panel"), { ssr: false });
export const TaskCenterPanel = dynamic(() => import("../task-center-panel"), { ssr: false });
export const OrganizationHistoryControl = dynamic(() => import("../organization-history-control"), {
  ssr: false,
});
export const Reader = dynamic(() => import("../reader"), {
  ssr: false,
  loading: () => (
    <div className="page-loading">
      <Loader2 className="spin" size={20} />
      正在打开阅读器…
    </div>
  ),
});
export const ComparisonReader = dynamic(() => import("../comparison-reader"), {
  ssr: false,
  loading: () => (
    <div className="page-loading">
      <Loader2 className="spin" size={20} />
      正在打开对照阅读…
    </div>
  ),
});
export const NoteEditor = dynamic(() => import("../note-editor"), { ssr: false });
export const AccountPanel = dynamic(() => import("../account-panel"), { ssr: false });
export const BackupRestorePanel = dynamic(() => import("../backup-restore-panel"), { ssr: false });
export const LegacyBrowserRecoveryPanel = dynamic(
  () => import("../legacy-browser-recovery-panel"),
  { ssr: false },
);
export const CrossLibraryAskPanel = dynamic(() => import("../cross-library-ask-panel"), {
  ssr: false,
});
export const NoteAskPanel = dynamic(() => import("./note-page/note-ask-panel"), {
  ssr: false,
});
