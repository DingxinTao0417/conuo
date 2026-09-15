import { isAccountDeletionPendingError } from "./account-deletion";
import { clearAccountLocalCache, markAccountLocalDeletion } from "./local-store";
import { webSessionStore } from "./web-session-store";
import { webReviewDraftStore } from "./web-review-draft-store";

export type AccountDeletionObservation = { confirmed: boolean; cleanupFailed: boolean };
type ConfirmedAccountDeletionListener = (actorId: string) => void | Promise<void>;
const listeners = new Set<ConfirmedAccountDeletionListener>();
const cleanupTasks = new Map<string, Promise<AccountDeletionObservation>>();

/** Only actor identity crosses this same-tab signal; it does not depend on DOM or BroadcastChannel. */
export function subscribeConfirmedAccountDeletions(
  listener: ConfirmedAccountDeletionListener,
): () => void {
  if (typeof listener !== "function") throw new TypeError("缺少账号注销观察函数。");
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called only with the actor already captured in an authenticated same-origin adapter request. */
export async function observeAccountDeletionFailure(
  reason: unknown,
  actorId: string,
): Promise<AccountDeletionObservation> {
  let confirmed = false;
  try {
    confirmed = isAccountDeletionPendingError(reason);
  } catch {
    /* An unreadable error is not proof. */
  }
  if (
    !confirmed ||
    typeof actorId !== "string" ||
    !actorId ||
    actorId.trim() !== actorId ||
    actorId === "local" ||
    actorId.startsWith("recovery:")
  )
    return { confirmed: false, cleanupFailed: false };

  for (const listener of [...listeners]) {
    try {
      // Redaction runs before the first await. Observe asynchronous cleanup,
      // but never wait on its drains: they may need this adapter to reject.
      void Promise.resolve(listener(actorId)).catch(() => {});
    } catch {
      /* One broken consumer must not suppress other consumers or the durable fence. */
    }
  }

  const running = cleanupTasks.get(actorId);
  if (running) return running;
  const task = (async (): Promise<AccountDeletionObservation> => {
    try {
      if (webSessionStore.managesAccount(actorId)) {
        await webSessionStore.markAccountLocalDeletion(actorId);
        await webSessionStore.clearAccountLocalCache(actorId);
        await webReviewDraftStore.clear(actorId, { blockReload: true });
      } else {
        await markAccountLocalDeletion(actorId);
        await clearAccountLocalCache(actorId);
      }
      return { confirmed: true, cleanupFailed: false };
    } catch {
      return { confirmed: true, cleanupFailed: true };
    }
  })();
  cleanupTasks.set(actorId, task);
  const release = () => {
    if (cleanupTasks.get(actorId) === task) cleanupTasks.delete(actorId);
  };
  void task.then(release, release);
  return task;
}
