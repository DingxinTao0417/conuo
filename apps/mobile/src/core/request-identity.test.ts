import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestIdentity } from "./request-identity.ts";
import { ClientError, createApi } from "./api.ts";
import {
  authInterruptionReason,
  createDraftRecoveryStore,
} from "./draft-recovery.ts";
import { blankWorkspace } from "./contracts.ts";

const session = { user: { id: "owner-a" }, access_token: "test-only" };
const defaultOptions = {
  owner: "owner-a",
  isCurrent: () => true,
  isFenceBlocked: async () => false,
  getSession: async () => ({ data: { session }, error: null }),
};

test("missing or temporarily unavailable credentials never imply a confirmed account switch", async () => {
  for (const status of [undefined, 0, 429, 503, 401, 400]) {
    const scope = { owner: "owner-a", generation: 1 };
    const store = createDraftRecoveryStore();
    store.activate(scope);
    store.capture(scope, {
      note: { title: "User words", text: "Do not discard", spaceId: "space" },
    });
    let requests = 0;
    const identity = createRequestIdentity({
      ...defaultOptions,
      getSession: async () => ({ data: { session: null }, error: { status } }),
    });
    const api = createApi("https://example.org", identity, (async () => {
      requests++;
      return Response.json({});
    }) as typeof fetch);
    let reason = null;
    await assert.rejects(api.load(scope.owner), (error) => {
      reason = authInterruptionReason(error);
      if (reason === "reauthentication") store.suspend(scope);
      else if (reason) store.clear(reason);
      assert.ok(error instanceof ClientError);
      assert.equal(error.code === "SESSION_CHANGED", false);
      return true;
    });
    assert.equal(requests, 0);
    assert.equal(
      reason,
      status === 401 || status === 400 ? "reauthentication" : null,
    );
    // Temporary failure leaves the mounted workspace; an eventual interruption can still seal it.
    if (!reason) store.suspend(scope);
    assert.equal(store.hasSealedDrafts(), true);
  }
  const absent = createRequestIdentity({
    ...defaultOptions,
    getSession: async () => ({ data: { session: null }, error: null }),
  });
  await assert.rejects(
    absent(),
    (error) => authInterruptionReason(error) === "reauthentication",
  );
});

test("a verified different account stays SESSION_CHANGED and clears rather than transfers drafts", async () => {
  const identity = createRequestIdentity({
    ...defaultOptions,
    getSession: async () => ({
      data: { session: { ...session, user: { id: "owner-b" } } },
      error: null,
    }),
  });
  let requested = false;
  const api = createApi("https://example.org", identity, (async () => {
    requested = true;
    return Response.json({});
  }) as typeof fetch);
  await assert.rejects(
    api.load("owner-a"),
    (error) => authInterruptionReason(error) === "account-changed",
  );
  assert.equal(requested, false);
});

test("an unavailable fence stops requests, and a fence set during session lookup wins", async () => {
  let lookups = 0;
  const blocked = createRequestIdentity({
    ...defaultOptions,
    isFenceBlocked: async () => true,
    getSession: async () => {
      lookups++;
      return { data: { session }, error: null };
    },
  });
  await assert.rejects(
    blocked(),
    (error) => authInterruptionReason(error) === "reauthentication",
  );
  assert.equal(lookups, 0);
  let fenced = false;
  const midflight = createRequestIdentity({
    ...defaultOptions,
    isFenceBlocked: async () => fenced,
    getSession: async () => {
      fenced = true;
      return { data: { session }, error: null };
    },
  });
  await assert.rejects(
    midflight(),
    (error) => authInterruptionReason(error) === "reauthentication",
  );
  const unavailable = createRequestIdentity({
    ...defaultOptions,
    isFenceBlocked: async () => {
      throw new Error("private keychain details");
    },
  });
  await assert.rejects(
    unavailable(),
    (error) =>
      error instanceof Error &&
      !error.message.includes("private") &&
      authInterruptionReason(error) === "reauthentication",
  );
});

test("thrown refresh failures stay temporary; an explicit account block is destructive", async () => {
  for (const cause of [null, new Error("Network unavailable"), { status: 0 }]) {
    const identity = createRequestIdentity({
      ...defaultOptions,
      getSession: async () => {
        throw cause;
      },
    });
    await assert.rejects(
      identity(),
      (error) =>
        error instanceof ClientError &&
        error.status === 503 &&
        authInterruptionReason(error) === null,
    );
  }
  const blocked = createRequestIdentity({
    ...defaultOptions,
    getSession: async () => ({
      data: { session: null },
      error: { status: 423 },
    }),
  });
  await assert.rejects(
    blocked(),
    (error) => authInterruptionReason(error) === "account-blocked",
  );
});

test("identity loss after a successful response yields reauthentication without exposing the response", async () => {
  let lookups = 0;
  const identity = createRequestIdentity({
    ...defaultOptions,
    getSession: async () => ({
      data: { session: ++lookups === 1 ? session : null },
      error: null,
    }),
  });
  const api = createApi("https://example.org", identity, (async () =>
    Response.json({ data: blankWorkspace(), revision: 2 })) as typeof fetch);
  await assert.rejects(
    api.load("owner-a"),
    (error) => authInterruptionReason(error) === "reauthentication",
  );
  assert.equal(lookups, 2);
});

test("an invalidated generation cannot authorize a request even with otherwise valid credentials", async () => {
  let current = true;
  const identity = createRequestIdentity({
    ...defaultOptions,
    isCurrent: () => current,
    getSession: async () => {
      current = false;
      return { data: { session }, error: null };
    },
  });
  assert.equal(await identity(), null);
});
