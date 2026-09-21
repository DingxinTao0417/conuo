type FenceStore = {
  getItem(): Promise<string | null>;
  setItem(value: string): Promise<void>;
  removeItem(): Promise<void>;
};

/** A transient Auth outage must not discard an already verified in-memory draft. */
export function isTransientAuthError(error: { status?: number }) {
  return (
    error.status === undefined ||
    error.status === 0 ||
    error.status === 429 ||
    error.status >= 500
  );
}

/** A durable logout marker never authorizes a session; only a verified login clears it. */
export function createSessionFence(store: FenceStore) {
  let blocked: boolean | null = null;
  let generation = 0;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => undefined);
    return result;
  }
  return {
    async isBlocked() {
      if (blocked !== null) return blocked;
      const expected = generation;
      try {
        const marker = await store.getItem();
        if (generation !== expected) return true;
        blocked = marker !== null;
        return blocked;
      } catch {
        blocked = true;
        throw new Error("无法读取安全登录状态，请先重试清理登录凭据。");
      }
    },
    block() {
      blocked = true;
      const expected = ++generation;
      return serial(async () => {
        await store.setItem("blocked");
        return expected;
      });
    },
    allowVerifiedLogin(expected: number) {
      return serial(async () => {
        if (expected !== generation) return false;
        await store.removeItem();
        if (expected !== generation) return false;
        blocked = false;
        return true;
      });
    },
  };
}
