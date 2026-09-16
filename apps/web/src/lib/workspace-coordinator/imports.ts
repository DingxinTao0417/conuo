// SHA-256 identity is the user-visible duplicate rule. Serialize only the
// short reservation/persistence transaction so two simultaneous file picks
// cannot both miss the same existing source before either one is published.
const importHashQueues = new Map<string, Promise<void>>();

export async function withImportHashReservation<T>(
  hash: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = importHashQueues.get(hash) ?? Promise.resolve();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => barrier);
  importHashQueues.set(hash, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (importHashQueues.get(hash) === current) importHashQueues.delete(hash);
  }
}

// Quota is calculated from the live workspace, so serialize admission and its
// persistence per account. Otherwise two different hashes can both see the
// same remaining bytes and each publish an over-limit original.
const importAccountQueues = new Map<string, Promise<void>>();

export async function withImportAccountReservation<T>(
  accountId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = importAccountQueues.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => barrier);
  importAccountQueues.set(accountId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (importAccountQueues.get(accountId) === current) importAccountQueues.delete(accountId);
  }
}
