import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionFence, isTransientAuthError } from "./session-fence.ts";

function setup() {
  let marker: string | null = null;
  const store = {
    async getItem() {
      return marker;
    },
    async setItem(value: string) {
      marker = value;
    },
    async removeItem() {
      marker = null;
    },
  };
  return { store, fence: createSessionFence(store) };
}

test("a logout fence survives app restart even if the SDK still retains credentials", async () => {
  const { store, fence } = setup();
  assert.equal(await fence.isBlocked(), false);
  await fence.block();
  assert.equal(await createSessionFence(store).isBlocked(), true);
});

test("failed or unverified login stays fenced; only the current verified attempt can clear it", async () => {
  const { store, fence } = setup();
  const earlier = await fence.block();
  const current = await fence.block();
  assert.equal(await fence.allowVerifiedLogin(earlier), false);
  assert.equal(await createSessionFence(store).isBlocked(), true);
  assert.equal(await fence.allowVerifiedLogin(current), true);
  assert.equal(await fence.isBlocked(), false);
  assert.equal(await createSessionFence(store).isBlocked(), false);
});

test("a newer logout wins while a verified login is clearing the previous marker", async () => {
  const { store, fence } = setup();
  const attempt = await fence.block();
  let release!: () => void;
  let started!: () => void;
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  store.removeItem = async () => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const accepted = fence.allowVerifiedLogin(attempt);
  await reached;
  const loggedOut = fence.block();
  release();
  assert.equal(await accepted, false);
  await loggedOut;
  assert.equal(await createSessionFence(store).isBlocked(), true);
});

test("keychain read, write and clear failures do not reopen an in-memory session", async () => {
  const { store, fence } = setup();
  store.getItem = async () => {
    throw new Error("storage read failed");
  };
  await assert.rejects(fence.isBlocked());
  assert.equal(await fence.isBlocked(), true);
  store.setItem = async () => {
    throw new Error("storage write failed");
  };
  await assert.rejects(fence.block());
  assert.equal(await fence.isBlocked(), true);
  store.setItem = async () => undefined;
  const attempt = await fence.block();
  store.removeItem = async () => {
    throw new Error("storage clear failed");
  };
  await assert.rejects(fence.allowVerifiedLogin(attempt));
  assert.equal(await fence.isBlocked(), true);
});

test("temporary Auth failures are distinct from confirmed expired or denied credentials", () => {
  for (const status of [undefined, 0, 429, 500, 503])
    assert.equal(isTransientAuthError({ status }), true);
  for (const status of [400, 401, 403, 404])
    assert.equal(isTransientAuthError({ status }), false);
});
