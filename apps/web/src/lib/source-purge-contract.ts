import { z } from "zod";
import type { PermanentSourceDeletionSelection } from "./permanent-deletion";

export const SOURCE_PURGE_SELECTION_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const sourcePurgeIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const count = z.number().int().nonnegative().safe();

export const sourcePurgeSelectionSchema = z
  .object({
    noteIds: z.array(sourcePurgeIdSchema).max(10_000),
    conversationIds: z.array(sourcePurgeIdSchema).max(5_000),
  })
  .strict()
  .superRefine((selection, context) => {
    for (const key of ["noteIds", "conversationIds"] as const)
      if (new Set(selection[key]).size !== selection[key].length)
        context.addIssue({ code: "custom", path: [key], message: "删除选择不能包含重复记录。" });
  });

export function sameSourcePurgeSelection(
  left: PermanentSourceDeletionSelection,
  right: PermanentSourceDeletionSelection,
): boolean {
  return (["noteIds", "conversationIds"] as const).every(
    (key) => [...left[key]].sort().join("|") === [...right[key]].sort().join("|"),
  );
}

export const sourcePurgeContentSchema = z
  .object({
    version: z.literal(1),
    notes: z
      .array(
        z
          .object({
            id: sourcePurgeIdSchema,
            title: z.string(),
            kind: z.enum(["note", "knowledge"]),
            versions: count.min(1),
          })
          .strict(),
      )
      .max(10_000),
    conversations: z
      .array(z.object({ id: sourcePurgeIdSchema, title: z.string(), messages: count }).strict())
      .max(5_000),
    selection: sourcePurgeSelectionSchema,
  })
  .strict()
  .superRefine((content, context) => {
    for (const [collection, selection] of [
      ["notes", "noteIds"],
      ["conversations", "conversationIds"],
    ] as const) {
      const ids = new Set(content[collection].map((item) => item.id));
      if (ids.size !== content[collection].length)
        context.addIssue({ code: "custom", path: [collection], message: "删除候选记录重复。" });
      if (content.selection[selection].some((id) => !ids.has(id)))
        context.addIssue({
          code: "custom",
          path: ["selection", selection],
          message: "删除选择不属于当前关联范围。",
        });
    }
  });

export const sourcePurgePreviewSchema = z
  .object({
    revision: count.min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    impact: z.object({
      source: z.object({
        id: sourcePurgeIdSchema,
        title: z.string(),
        deletedAt: z.string().nullable(),
      }),
      versions: count.min(1),
      annotations: count,
      blockingAnnotations: count,
      retainedNotes: count,
      retainedNoteCitations: count,
      retainedConversations: count,
      retainedConversationCitations: count,
      organizationJobs: count,
      pendingOrganizationJobs: count,
      conceptRelations: count,
      blockingConceptRelations: count,
      importJobs: count,
      localOriginals: count,
      cloudOriginals: count,
      removedNotes: count.optional(),
      removedNoteVersions: count.optional(),
      removedConversations: count.optional(),
      removedMessages: count.optional(),
    }),
    blockers: z.object({
      annotations: z.array(sourcePurgeIdSchema),
      conceptRelations: z.array(sourcePurgeIdSchema),
    }),
    contentSelection: sourcePurgeContentSchema.optional(),
  })
  .superRefine((preview, context) => {
    const content = preview.contentSelection;
    if (!content) return;
    const selectedNotes = new Set(content.selection.noteIds);
    const selectedConversations = new Set(content.selection.conversationIds);
    const expected = {
      retainedNotes: content.notes.length - selectedNotes.size,
      retainedConversations: content.conversations.length - selectedConversations.size,
      removedNotes: selectedNotes.size,
      removedNoteVersions: content.notes.reduce(
        (total, note) => total + (selectedNotes.has(note.id) ? note.versions : 0),
        0,
      ),
      removedConversations: selectedConversations.size,
      removedMessages: content.conversations.reduce(
        (total, conversation) =>
          total + (selectedConversations.has(conversation.id) ? conversation.messages : 0),
        0,
      ),
    };
    for (const key of Object.keys(expected) as Array<keyof typeof expected>)
      if (preview.impact[key] !== expected[key])
        context.addIssue({
          code: "custom",
          path: ["impact", key],
          message: "删除计数与所选关联范围不一致。",
        });
    if (
      preview.impact.blockingAnnotations !== preview.blockers.annotations.length ||
      preview.impact.blockingConceptRelations !== preview.blockers.conceptRelations.length
    )
      context.addIssue({ code: "custom", path: ["blockers"], message: "删除阻塞范围不一致。" });
  });
