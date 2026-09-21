import { test } from "node:test";
import assert from "node:assert/strict";
import { createChunkedStorage } from "./secure-storage.ts";
function setup() {
  const values = new Map<string, string>();
  let generation = 0,
    fail = false;
  const storage = createChunkedStorage(
    {
      async getItem(key) {
        return values.get(key) ?? null;
      },
      async setItem(key, value) {
        if (fail && key.endsWith(".1"))
          throw new Error("Keychain write failed");
        values.set(key, value);
      },
      async removeItem(key) {
        values.delete(key);
      },
    },
    () => `generation-${++generation}`,
  );
  return {
    values,
    storage,
    failNext: () => {
      fail = true;
    },
  };
}
test("large sessions roundtrip in bounded chunks without splitting Unicode pairs", async () => {
  const { storage, values } = setup(),
    content = "学习📖".repeat(1200);
  await storage.setItem("auth", content);
  assert.equal(await storage.getItem("auth"), content);
  assert.ok(
    [...values.values()].every(
      (value) => Buffer.byteLength(value, "utf8") < 2048,
    ),
  );
  await storage.removeItem("auth");
  assert.equal(await storage.getItem("auth"), null);
  assert.equal(values.size, 0);
});
test("partial replacement failure preserves the previously committed session", async () => {
  const { storage, failNext } = setup();
  await storage.setItem("auth", "old-value");
  failNext();
  await assert.rejects(storage.setItem("auth", "new-value".repeat(400)));
  assert.equal(await storage.getItem("auth"), "old-value");
});
test("missing chunks fail closed instead of returning partial credentials", async () => {
  const { storage, values } = setup();
  await storage.setItem("auth", "large-value".repeat(200));
  values.delete("auth.generation-1.1");
  assert.equal(await storage.getItem("auth"), null);
});
test("concurrent writes and sign-out serialize; no earlier session resurrects", async () => {
  const { storage, values } = setup();
  await Promise.all([
    storage.setItem("auth", "one"),
    storage.setItem("auth", "two"),
    storage.removeItem("auth"),
  ]);
  assert.equal(await storage.getItem("auth"), null);
  assert.equal(values.size, 0);
});
