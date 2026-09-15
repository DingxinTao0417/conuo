import type { SourcePurgePreview } from "../../src/lib/cloud";
import type { PermanentSourceDeletionSelection } from "../../src/lib/permanent-deletion";

export const purgeSourceId = "source-a";
export const purgeFingerprint = "a".repeat(64);
export const purgeTransactionId = "f5d81be7-8cf9-437c-a371-8ea571c006ca";

export function sourcePurgePreviewFixture(
  selection: PermanentSourceDeletionSelection = { noteIds: [], conversationIds: [] },
): SourcePurgePreview {
  const noteSelected = selection.noteIds.includes("note-a");
  const conversationSelected = selection.conversationIds.includes("conversation-a");
  return {
    revision: 7,
    fingerprint: purgeFingerprint,
    impact: {
      source: {
        id: purgeSourceId,
        title: "待删除的学习资料",
        deletedAt: "2026-09-14T00:00:00.000Z",
      },
      versions: 2,
      annotations: 0,
      blockingAnnotations: 0,
      retainedNotes: noteSelected ? 0 : 1,
      retainedNoteCitations: noteSelected ? 0 : 2,
      retainedConversations: conversationSelected ? 0 : 1,
      retainedConversationCitations: conversationSelected ? 0 : 1,
      removedNotes: noteSelected ? 1 : 0,
      removedNoteVersions: noteSelected ? 2 : 0,
      removedConversations: conversationSelected ? 1 : 0,
      removedMessages: conversationSelected ? 2 : 0,
      organizationJobs: 0,
      pendingOrganizationJobs: 0,
      conceptRelations: 0,
      blockingConceptRelations: 0,
      importJobs: 0,
      localOriginals: 1,
      cloudOriginals: 1,
    },
    blockers: { annotations: [], conceptRelations: [] },
    contentSelection: {
      version: 1,
      notes: [{ id: "note-a", title: "另存的解释", kind: "knowledge", versions: 2 }],
      conversations: [{ id: "conversation-a", title: "以前的问答", messages: 2 }],
      selection: structuredClone(selection),
    },
  };
}
