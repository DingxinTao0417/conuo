import { z } from "zod";
import {
  answerScope,
  blankWorkspace,
  snapshotSchema,
  type Note,
  type Snapshot,
  type Source,
} from "./contracts.ts";

const id = z.string().min(1).max(100);
const time = z.string().datetime({ offset: true });
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.object({ id, now: time });
const noteReceiptSchema = z.object({
  kind: z.literal("note"),
  id,
  fingerprint,
});
const webReceiptSchema = z.object({
  kind: z.literal("web"),
  id,
  versionId: id,
  fingerprint,
});
const noteInputSchema = z
  .object({
    title: z.string().max(512),
    text: z.string().max(50_000),
    spaceId: z.string().max(100),
    identity: identity.optional(),
    pending: noteReceiptSchema.optional(),
  })
  .refine((value) => !value.pending || value.pending.id === value.identity?.id);
const webInputSchema = z
  .object({
    url: z.string().max(8192),
    title: z.string().max(512),
    titleEditedByUser: z.boolean(),
    spaceId: z.string().max(100),
    identity: identity.extend({ versionId: id }).optional(),
    pending: webReceiptSchema.optional(),
    previousPending: z.array(webReceiptSchema).max(10).optional(),
  })
  .refine(
    (value) =>
      (!value.previousPending ||
        value.previousPending.every(
          (receipt) => receipt.id === value.identity?.id,
        )) &&
      (!value.pending ||
        (value.pending.id === value.identity?.id &&
          value.pending.versionId === value.identity.versionId)),
  );
const questionInputSchema = z.object({
  sourceId: id,
  versionId: id,
  question: z.string().max(2000),
  questionDirty: z.boolean(),
  kind: z.enum(["unsent", "unanswered"]).optional(),
});
const patchSchema = z.object({
  note: noteInputSchema.nullable().optional(),
  web: webInputSchema.nullable().optional(),
  questions: z.array(questionInputSchema).max(5000).optional(),
});

export type DraftScope = { owner: string; generation: number };
export type NoteReceipt = z.infer<typeof noteReceiptSchema>;
export type WebReceipt = z.infer<typeof webReceiptSchema>;
export type NoteDraftInput = z.infer<typeof noteInputSchema>;
export type WebDraftInput = z.infer<typeof webInputSchema>;
export type QuestionDraftInput = z.infer<typeof questionInputSchema>;
/** Omitted fields are unchanged; null/[] explicitly discard that input. */
export type DraftPatch = z.infer<typeof patchSchema>;
export type DraftClearReason =
  "user" | "discard" | "account-blocked" | "account-changed";
export type AuthInterruption =
  "reauthentication" | "account-blocked" | "account-changed";
export function authInterruptionReason(
  error: unknown,
): AuthInterruption | null {
  const cause = error as { status?: number; code?: string } | null;
  if (cause?.status === 423 || cause?.code === "ACCOUNT_DELETION_PENDING")
    return "account-blocked";
  if (cause?.code === "SESSION_CHANGED") return "account-changed";
  return cause?.status === 401 ? "reauthentication" : null;
}
export type Sha256 = (value: string) => Promise<string>;
export type PendingState = "matched" | "missing" | "changed" | "deleted";
export type QuestionContext =
  "ready" | "version-changed" | "source-unavailable" | "ai-unavailable";

type Inputs = {
  note: NoteDraftInput | null;
  web: WebDraftInput | null;
  questions: QuestionDraftInput[];
};
export type RestoredDrafts = {
  note:
    | (NoteDraftInput & {
        targetAvailable: boolean;
        pendingState?: PendingState;
      })
    | null;
  web:
    | (WebDraftInput & {
        targetAvailable: boolean;
        pendingState?: PendingState;
        /** Previous preview and consent are never retained, even after a matched save. */
        requiresPreview: true;
        aiAllowed: false;
      })
    | null;
  questions: (QuestionDraftInput & { context: QuestionContext })[];
};
export type RecoveryResult =
  | {
      status: "restored";
      scope: DraftScope;
      revision: number;
      drafts: RestoredDrafts;
    }
  | { status: "empty" }
  | {
      status: "locked";
      reason:
        | "confirmation-required"
        | "busy"
        | "stale"
        | "fence"
        | "identity"
        | "account-changed"
        | "account-blocked"
        | "temporary"
        | "invalid-snapshot";
    };

/** Inject Expo Crypto on native; no original payload is returned or retained. */
export async function noteSaveReceipt(
  note: Note,
  sha256: Sha256,
): Promise<NoteReceipt> {
  const value = JSON.stringify([
    "conuo-note-v1",
    note.id,
    note.spaceId,
    note.title,
    note.content,
    note.kind,
    note.status,
    note.aiGenerated === true,
  ]);
  return noteReceiptSchema.parse({
    kind: "note",
    id: note.id,
    fingerprint: await sha256(value),
  });
}

/** Version, content, attribution and consent all participate in the receipt. */
export async function webSaveReceipt(
  source: Source,
  sha256: Sha256,
): Promise<WebReceipt> {
  if (source.kind !== "web") throw new Error("网页保存收据需要网页资料。");
  const value = JSON.stringify([
    "conuo-web-v1",
    source.id,
    source.versionId,
    source.title,
    source.text,
    source.url,
    [...source.spaceIds].sort(),
    source.status,
    source.aiAllowed,
  ]);
  return webReceiptSchema.parse({
    kind: "web",
    id: source.id,
    versionId: source.versionId,
    fingerprint: await sha256(value),
  });
}

const emptyInputs = (): Inputs => ({ note: null, web: null, questions: [] });
const sameScope = (left: DraftScope | null, right: DraftScope) =>
  left?.owner === right.owner && left.generation === right.generation;
const cloneInputs = (value: Inputs): Inputs => ({
  note: value.note ? noteInputSchema.parse(value.note) : null,
  web: value.web ? webInputSchema.parse(value.web) : null,
  questions: value.questions.map((item) => questionInputSchema.parse(item)),
});
const hasInputs = (value: Inputs) =>
  !!(value.note || value.web || value.questions.length);

/**
 * A process-memory-only vault for user-entered, new inputs. There is deliberately
 * no reader, serializer, storage adapter, saved-document cache or write API.
 * Call capture only with user input; never project server objects into text fields.
 * The App must clear synchronously on explicit logout/423/account change, before
 * SDK events, and recheck the returned scope before installing restored UI state.
 */
export function createDraftRecoveryStore() {
  let active: DraftScope | null = null;
  let latestGeneration = -1;
  let invalidatedGeneration = -1;
  let live = emptyInputs();
  let sealed: { owner: string; inputs: Inputs } | null = null;
  let epoch = 0;
  let restoring: AbortController | null = null;

  function cancelRestore() {
    epoch++;
    restoring?.abort();
    restoring = null;
  }

  function clear(_reason: DraftClearReason) {
    cancelRestore();
    invalidatedGeneration = latestGeneration;
    active = null;
    live = emptyInputs();
    sealed = null;
  }

  return {
    /** Bind only an already verified App session; this alone never unlocks drafts. */
    activate(scope: DraftScope): boolean {
      if (
        !id.safeParse(scope.owner).success ||
        !Number.isSafeInteger(scope.generation) ||
        scope.generation < 0 ||
        scope.generation < latestGeneration ||
        scope.generation <= invalidatedGeneration
      )
        return false;
      if (sameScope(active, scope)) return true;
      if (scope.generation === latestGeneration) return false;
      cancelRestore();
      if (
        (active && active.owner !== scope.owner) ||
        (sealed && sealed.owner !== scope.owner)
      ) {
        live = emptyInputs();
        sealed = null;
      }
      active = { ...scope };
      latestGeneration = scope.generation;
      return true;
    },

    /** Capture synchronously on user edits and before beginning a possibly unknown save. */
    capture(scope: DraftScope, patch: DraftPatch): boolean {
      if (!sameScope(active, scope) || sealed) return false;
      const parsed = patchSchema.safeParse(patch);
      if (!parsed.success) return false;
      const next = parsed.data;
      if (next.note !== undefined) {
        const note = next.note;
        live.note =
          note && (note.title.trim() || note.text.trim() || note.pending)
            ? note
            : null;
      }
      if (next.web !== undefined) {
        const web = next.web;
        if (web && !web.titleEditedByUser) web.title = "";
        live.web =
          web && (web.url.trim() || web.title.trim() || web.pending)
            ? web
            : null;
      }
      if (next.questions !== undefined) {
        // Last draft for a source wins; sent questions and answers are never retained.
        const unique = new Map<string, QuestionDraftInput>();
        for (const item of next.questions) {
          if (item.questionDirty && item.question.trim())
            unique.set(item.sourceId, item);
          else unique.delete(item.sourceId);
        }
        live.questions = [...unique.values()];
      }
      return true;
    },

    /** An unexplained 401/SIGNED_OUT may seal, but cannot itself authorize restoration. */
    suspend(scope: DraftScope): boolean {
      if (!sameScope(active, scope)) return false;
      cancelRestore();
      if (!sealed && hasInputs(live))
        sealed = { owner: scope.owner, inputs: cloneInputs(live) };
      live = emptyInputs();
      active = null;
      invalidatedGeneration = latestGeneration;
      return !!sealed;
    },

    clear,
    cancelRestore,
    /** An online-verified different owner invalidates old input even if login later fails. */
    clearIfDifferentOwner(owner: string) {
      if (!id.safeParse(owner).success) return false;
      const previous = sealed?.owner ?? active?.owner;
      if (!previous || previous === owner) return false;
      clear("account-changed");
      return true;
    },
    /** Explicitly discard the prompt while keeping the verified session usable. */
    discardSealed(scope: DraftScope) {
      if (!sameScope(active, scope)) return false;
      cancelRestore();
      sealed = null;
      live = emptyInputs();
      return true;
    },
    /** Only expose whether a prompt is useful; never expose a draft before the gates. */
    hasSealedDrafts: () => sealed !== null,

    async restoreExplicit(options: {
      scope: DraftScope;
      confirmed: boolean;
      /** Must compare the current App identity AND generation, not a captured value. */
      isCurrent: () => boolean;
      isFenceBlocked: () => Promise<boolean>;
      /** Must perform online Auth getUser; cached getSession is not an implementation. */
      verifyUser: (signal: AbortSignal) => Promise<string | null>;
      /** The existing identity-checked API GET, including the account business gate. */
      loadWorkspace: (owner: string, signal: AbortSignal) => Promise<Snapshot>;
      sha256: Sha256;
    }): Promise<RecoveryResult> {
      if (!sealed) return { status: "empty" };
      if (!options.confirmed)
        return { status: "locked", reason: "confirmation-required" };
      if (restoring) return { status: "locked", reason: "busy" };
      const scope = { ...options.scope };
      if (!sameScope(active, scope) || !options.isCurrent())
        return { status: "locked", reason: "stale" };
      if (sealed.owner !== scope.owner) {
        clear("account-changed");
        return { status: "locked", reason: "account-changed" };
      }
      const controller = new AbortController();
      restoring = controller;
      const startedEpoch = epoch;
      const current = () =>
        !controller.signal.aborted &&
        epoch === startedEpoch &&
        sameScope(active, scope) &&
        options.isCurrent();
      const stale = () => ({ status: "locked", reason: "stale" }) as const;
      const checkFence = async () => {
        const blocked = await options.isFenceBlocked();
        if (!current()) return stale();
        return blocked
          ? ({ status: "locked", reason: "fence" } as const)
          : null;
      };
      try {
        let denied = await checkFence();
        if (denied) return denied;
        const verifiedOwner = await options.verifyUser(controller.signal);
        if (!current()) return stale();
        if (!verifiedOwner) return { status: "locked", reason: "identity" };
        if (verifiedOwner !== scope.owner) {
          clear("account-changed");
          return { status: "locked", reason: "account-changed" };
        }
        denied = await checkFence();
        if (denied) return denied;
        const response = await options.loadWorkspace(
          scope.owner,
          controller.signal,
        );
        if (!current()) return stale();
        const parsed = snapshotSchema.safeParse(response);
        if (!parsed.success)
          return { status: "locked", reason: "invalid-snapshot" };
        denied = await checkFence();
        if (denied) return denied;
        const workspace = parsed.data.data ?? blankWorkspace();
        const inputs = cloneInputs(sealed!.inputs);
        const available = (spaceId: string) =>
          workspace.spaces.some(
            (space) => space.id === spaceId && !space.archived,
          );
        let notePending: PendingState | undefined;
        if (inputs.note?.pending) {
          const receipt = inputs.note.pending;
          const found = workspace.notes.find((note) => note.id === receipt.id);
          notePending = !found
            ? "missing"
            : found.deletedAt
              ? "deleted"
              : (await noteSaveReceipt(found, options.sha256)).fingerprint ===
                  receipt.fingerprint
                ? "matched"
                : "changed";
          if (!current()) return stale();
        }
        let webPending: PendingState | undefined;
        if (inputs.web?.pending) {
          const receipt = inputs.web.pending;
          const found = workspace.sources.find(
            (source) => source.id === receipt.id,
          );
          const receipts = [receipt, ...(inputs.web.previousPending ?? [])];
          if (!found) webPending = "missing";
          else if (found.deletedAt) webPending = "deleted";
          else if (found.kind !== "web") webPending = "changed";
          else {
            const actual = await webSaveReceipt(found, options.sha256);
            webPending = receipts.some(
              (item) =>
                item.versionId === actual.versionId &&
                item.fingerprint === actual.fingerprint,
            )
              ? "matched"
              : "changed";
          }
          if (!current()) return stale();
        }
        const drafts: RestoredDrafts = {
          note: inputs.note
            ? {
                ...inputs.note,
                targetAvailable: available(inputs.note.spaceId),
                pendingState: notePending,
              }
            : null,
          web: inputs.web
            ? {
                ...inputs.web,
                targetAvailable:
                  !inputs.web.spaceId ||
                  inputs.web.spaceId === "inbox" ||
                  available(inputs.web.spaceId),
                pendingState: webPending,
                requiresPreview: true,
                aiAllowed: false,
              }
            : null,
          questions: inputs.questions.map((question) => {
            const source = workspace.sources.find(
              (item) => item.id === question.sourceId && !item.deletedAt,
            );
            let context: QuestionContext = "source-unavailable";
            if (
              source &&
              (!source.spaceIds.length || source.spaceIds.some(available))
            ) {
              if (source.versionId !== question.versionId)
                context = "version-changed";
              else {
                try {
                  answerScope(
                    workspace,
                    source.id,
                    question.question,
                    "draft-recovery",
                  );
                  context = "ready";
                } catch {
                  context = "ai-unavailable";
                }
              }
            }
            return { ...question, context };
          }),
        };
        // A logout/fence change during hashing must win, just as one during GET does.
        denied = await checkFence();
        if (denied) return denied;
        sealed = null;
        live = cloneInputs(inputs);
        return {
          status: "restored",
          scope,
          revision: parsed.data.revision,
          drafts,
        };
      } catch (error) {
        if (!current()) return stale();
        const failure = error as { status?: number; code?: string } | null;
        if (
          failure?.status === 423 ||
          failure?.code === "ACCOUNT_DELETION_PENDING"
        ) {
          clear("account-blocked");
          return { status: "locked", reason: "account-blocked" };
        }
        if (failure?.code === "SESSION_CHANGED") {
          clear("account-changed");
          return { status: "locked", reason: "account-changed" };
        }
        return {
          status: "locked",
          reason: failure?.status === 401 ? "identity" : "temporary",
        };
      } finally {
        if (restoring === controller) restoring = null;
      }
    },
  };
}

export type DraftRecoveryStore = ReturnType<typeof createDraftRecoveryStore>;
