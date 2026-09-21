type Adapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};
type Manifest = { generation: string; count: number };

/** A manifest swap avoids adopting partially written Keychain chunks after a crash. */
export function createChunkedStorage(adapter: Adapter, nonce: () => string) {
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }
  function validateKey(key: string) {
    if (!/^[a-zA-Z0-9._-]+$/.test(key))
      throw new Error("Invalid secure storage key");
  }
  async function manifest(key: string): Promise<Manifest | null> {
    const raw = await adapter.getItem(key);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      return typeof data.generation === "string" &&
        /^[a-zA-Z0-9-]+$/.test(data.generation) &&
        Number.isInteger(data.count) &&
        data.count > 0 &&
        data.count <= 320
        ? data
        : null;
    } catch {
      return null;
    }
  }
  const chunkKey = (key: string, value: Manifest, index: number) =>
    `${key}.${value.generation}.${index}`;
  async function clean(key: string, value: Manifest | null) {
    if (!value) return;
    for (let index = 0; index < value.count; index++)
      await adapter.removeItem(chunkKey(key, value, index));
  }
  return {
    getItem(key: string) {
      return serial(async () => {
        validateKey(key);
        const value = await manifest(key);
        if (!value) return null;
        let output = "";
        for (let index = 0; index < value.count; index++) {
          const chunk = await adapter.getItem(chunkKey(key, value, index));
          if (chunk === null) return null;
          output += chunk;
        }
        return output;
      });
    },
    setItem(key: string, text: string) {
      return serial(async () => {
        validateKey(key);
        if (!text.length || text.length > 128_000)
          throw new Error("Session exceeds secure storage limit");
        const characters = Array.from(text);
        const old = await manifest(key),
          value = {
            generation: nonce(),
            count: Math.ceil(characters.length / 400),
          };
        if (!/^[a-zA-Z0-9-]+$/.test(value.generation))
          throw new Error("Invalid secure storage generation");
        try {
          for (let index = 0; index < value.count; index++)
            await adapter.setItem(
              chunkKey(key, value, index),
              characters.slice(index * 400, (index + 1) * 400).join(""),
            );
          await adapter.setItem(key, JSON.stringify(value));
        } catch (error) {
          await clean(key, value).catch(() => undefined);
          throw error;
        }
        // Old chunks remain encrypted and unreachable if best-effort reclamation fails.
        await clean(key, old).catch(() => undefined);
      });
    },
    removeItem(key: string) {
      return serial(async () => {
        validateKey(key);
        const old = await manifest(key);
        await adapter.removeItem(key);
        await clean(key, old);
      });
    },
  };
}
