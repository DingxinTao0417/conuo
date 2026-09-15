import { z } from "zod";

export const accountDeletionStateSchema = z.enum([
  "storage_pending",
  "storage_processing",
  "ready_for_auth_deletion",
  "auth_deletion_processing",
  "failed",
  "completed",
]);

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Only the authenticated, explicit access gate proves deletion is pending. */
export function isAccountDeletionPendingError(reason: unknown): boolean {
  return (
    reason !== null &&
    typeof reason === "object" &&
    "status" in reason &&
    reason.status === 423 &&
    "code" in reason &&
    reason.code === "ACCOUNT_DELETION_PENDING"
  );
}

function consistentAccess(value: { state: string | null; allowed: boolean }) {
  return value.allowed === (value.state === null);
}

/**
 * This deliberately contains counts only. Object paths, titles, note bodies and
 * other account content stay inside the deletion transaction and worker queue.
 */
export const accountDeletionAccessSchema = z
  .object({
    state: accountDeletionStateSchema.nullable(),
    allowed: z.boolean(),
  })
  .passthrough()
  .refine(consistentAccess, { message: "账号注销状态与访问权限不一致。" });

export const accountDeletionCountsSchema = z
  .object({
    state: accountDeletionStateSchema.nullable(),
    sources: count,
    versions: count,
    notes: count,
    conversations: count,
    annotations: count,
    spaces: count,
    currentStorageObjects: count,
    pendingSourcePurgeObjects: count,
    totalStorageObjects: count,
  })
  .strict();

/** API-level impact preview combines database counts with the access gate. */
export const accountDeletionPreviewSchema = accountDeletionCountsSchema
  .extend({ allowed: z.boolean() })
  .strict()
  .refine(consistentAccess, { message: "账号注销状态与访问权限不一致。" });

export type AccountDeletionAccess = z.infer<typeof accountDeletionAccessSchema>;
export type AccountDeletionCounts = z.infer<typeof accountDeletionCountsSchema>;

export type AccountDeletionPreview = z.infer<typeof accountDeletionPreviewSchema>;

export const accountDeletionConfirmationSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(128),
    confirmation: z.literal("DELETE"),
  })
  .strict();

export type AccountDeletionConfirmation = z.infer<typeof accountDeletionConfirmationSchema>;

export const accountDeletionPrepareSchema = z
  .object({
    deletionId: z.uuid(),
    state: accountDeletionStateSchema,
    storageObjects: count,
    readyForAuthDeletion: z.boolean(),
  })
  .strict();

export type AccountDeletionPreparation = z.infer<typeof accountDeletionPrepareSchema>;
