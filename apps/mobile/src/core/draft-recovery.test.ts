import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { blankWorkspace, createTextNote, type Snapshot } from "./contracts.ts";
import { createWebSource } from "./web-import.ts";
import {
  authInterruptionReason,
  createDraftRecoveryStore,
  noteSaveReceipt,
  webSaveReceipt,
} from "./draft-recovery.ts";
import { createApi } from "./api.ts";
import { createSessionFence } from "./session-fence.ts";

const sha256 = async (value: string) =>
  createHash("sha256").update(value).digest("hex");
const original = { owner: "owner-a", generation: 1 };
const renewed = { owner: "owner-a", generation: 3 };
const now = "2026-09-21T10:00:00.000Z";
const noteInput = {
  title: "My words",
  text: "Unsent note",
  spaceId: "space",
  identity: { id: "note-id", now },
};
const webInput = {
  url: "https://example.org/reading",
  title: "My title",
  titleEditedByUser: true,
  spaceId: "space",
  identity: { id: "web-id", versionId: "version-id", now },
};
function snapshot(): Snapshot {
  const workspace = blankWorkspace();
  workspace.spaces.push({
    id: "space",
    name: "Study",
    goal: "",
    color: "",
    archived: false,
    createdAt: now,
  });
  workspace.aiEnabled = true;
  return { data: workspace, revision: 4 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const store = createDraftRecoveryStore();
  store.activate(original);
  store.capture(original, { note: noteInput });
  store.suspend(original);
  store.activate(renewed);
  const calls: string[] = [];
  const options = {
    scope: renewed,
    confirmed: true,
    isCurrent: () => true,
    async isFenceBlocked() {
      calls.push("fence");
      return false;
    },
    async verifyUser(_signal: AbortSignal) {
      calls.push("user");
      return "owner-a";
    },
    async loadWorkspace(_owner: string, _signal: AbortSignal) {
      calls.push("workspace");
      return snapshot();
    },
    sha256,
  };
  return { store, options, calls };
}

test("only an explicit action after fence, online identity and workspace gates reveals input", async () => {
  const { store, options, calls } = setup();
  assert.equal(store.hasSealedDrafts(), true);
  assert.deepEqual(
    await store.restoreExplicit({ ...options, confirmed: false }),
    { status: "locked", reason: "confirmation-required" },
  );
  assert.deepEqual(calls, []);
  const result = await store.restoreExplicit(options);
  assert.equal(result.status, "restored");
  if (result.status !== "restored") return;
  assert.equal(result.drafts.note?.text, noteInput.text);
  assert.equal(result.drafts.note?.targetAvailable, true);
  assert.deepEqual(calls, [
    "fence",
    "user",
    "fence",
    "workspace",
    "fence",
    "fence",
  ]);
  assert.equal(store.hasSealedDrafts(), false);
  assert.deepEqual(await store.restoreExplicit(options), { status: "empty" });
  assert.equal("data" in result, false);
});

test("the vault strips server content, answers, credentials and automatic titles at capture", async () => {
  const { store, options } = setup();
  store.clear("discard");
  const scope = { ...renewed, generation: 4 };
  store.activate(scope);
  store.capture(scope, {
    note: { ...noteInput, content: "server note", accessToken: "secret" },
    web: {
      ...webInput,
      title: "Extracted server title",
      titleEditedByUser: false,
      preview: { text: "server body" },
      aiAllowed: true,
    },
    questions: [
      {
        sourceId: "one",
        versionId: "v1",
        question: "Unsent words",
        questionDirty: true,
        answer: "AI answer",
        token: "secret",
      },
      {
        sourceId: "two",
        versionId: "v2",
        question: "Sent question",
        questionDirty: false,
      },
    ],
    workspace: snapshot().data,
  } as never);
  store.suspend(scope);
  const next = { ...scope, generation: 5 };
  store.activate(next);
  const result = await store.restoreExplicit({ ...options, scope: next });
  assert.equal(result.status, "restored");
  if (result.status !== "restored") return;
  assert.equal(result.drafts.web?.title, "");
  assert.equal(result.drafts.web?.aiAllowed, false);
  assert.equal(result.drafts.web?.requiresPreview, true);
  assert.equal(result.drafts.questions.length, 1);
  const serialized = JSON.stringify(result);
  for (const excluded of [
    "server note",
    "secret",
    "server body",
    "AI answer",
    "Sent question",
    "Extracted server title",
  ])
    assert.equal(serialized.includes(excluded), false);
});

test("capture is a defensive copy, partial updates do not erase other forms, and locked input is not overwritten", async () => {
  const { store, options } = setup();
  store.clear("discard");
  const scope = { ...renewed, generation: 4 };
  store.activate(scope);
  const input = { ...noteInput, identity: { ...noteInput.identity } };
  store.capture(scope, { note: input });
  store.capture(scope, { web: webInput });
  input.text = "mutated";
  input.identity.id = "mutated";
  store.suspend(scope);
  const next = { ...scope, generation: 5 };
  store.activate(next);
  assert.equal(store.capture(next, { note: null }), false);
  const result = await store.restoreExplicit({ ...options, scope: next });
  assert.equal(result.status, "restored");
  if (result.status !== "restored") return;
  assert.equal(result.drafts.note?.text, "Unsent note");
  assert.equal(result.drafts.note?.identity?.id, "note-id");
  assert.equal(result.drafts.web?.url, webInput.url);
  result.drafts.note!.text = "returned object mutated";
  store.suspend(next);
  const finalScope = { ...next, generation: 6 };
  store.activate(finalScope);
  const again = await store.restoreExplicit({ ...options, scope: finalScope });
  assert.equal(
    again.status === "restored" && again.drafts.note?.text,
    "Unsent note",
  );
});

test("old scopes cannot capture, suspend, activate or restore after a newer session", async () => {
  const { store, options, calls } = setup();
  assert.equal(store.capture(original, { note: null }), false);
  assert.equal(store.suspend(original), false);
  assert.equal(store.activate(original), false);
  assert.equal(store.activate({ ...renewed, owner: "other" }), false);
  assert.deepEqual(
    await store.restoreExplicit({ ...options, scope: original }),
    { status: "locked", reason: "stale" },
  );
  assert.deepEqual(calls, []);
});

test("blocked or failing fence never reaches online identity or workspace", async () => {
  for (const failure of [true, "throw"]) {
    const { store, options, calls } = setup();
    const result = await store.restoreExplicit({
      ...options,
      isFenceBlocked: async () => {
        if (failure === "throw") throw new Error("private details");
        return true;
      },
    });
    assert.equal(result.status, "locked");
    assert.deepEqual(calls, []);
    assert.equal(store.hasSealedDrafts(), true);
    assert.equal(JSON.stringify(result).includes("private details"), false);
  }
});

test("unverified identity stays locked; another verified identity destroys old account input", async () => {
  for (const identity of [null, "owner-b"]) {
    const { store, options, calls } = setup();
    const result = await store.restoreExplicit({
      ...options,
      verifyUser: async () => identity,
    });
    assert.deepEqual(result, {
      status: "locked",
      reason: identity ? "account-changed" : "identity",
    });
    assert.equal(calls.includes("workspace"), false);
    assert.equal(store.hasSealedDrafts(), identity === null);
  }
  const { store, options } = setup();
  store.activate({ owner: "owner-b", generation: 4 });
  store.activate({ owner: "owner-a", generation: 5 });
  assert.deepEqual(
    await store.restoreExplicit({
      ...options,
      scope: { owner: "owner-a", generation: 5 },
    }),
    { status: "empty" },
  );
});

test("workspace 401/network/429/503 remain locked; 423 and identity change erase pending input", async () => {
  for (const failure of [
    { status: 401 },
    { status: 0 },
    { status: 429 },
    { status: 503 },
    { status: 423 },
    { code: "ACCOUNT_DELETION_PENDING" },
    { code: "SESSION_CHANGED", status: 409 },
  ]) {
    const { store, options } = setup();
    const result = await store.restoreExplicit({
      ...options,
      loadWorkspace: async () => {
        throw failure;
      },
    });
    assert.equal(result.status, "locked");
    const destroyed = failure.status === 423 || !!failure.code;
    assert.equal(store.hasSealedDrafts(), !destroyed);
  }
  const { store, options } = setup();
  const bad = await store.restoreExplicit({
    ...options,
    loadWorkspace: async () => ({ data: null, revision: 10 }),
  });
  assert.deepEqual(bad, { status: "locked", reason: "invalid-snapshot" });
  assert.equal(store.hasSealedDrafts(), true);
});

test("logout, account blocking and cancellation win over late identity/workspace responses", async () => {
  for (const phase of ["user", "workspace"] as const) {
    for (const reason of ["user", "account-blocked", "cancel"] as const) {
      const { store, options } = setup();
      const gate = deferred<void>();
      const reached = deferred<void>();
      let signal: AbortSignal | undefined;
      const pending = store.restoreExplicit({
        ...options,
        verifyUser: async (received) => {
          if (phase === "user") {
            signal = received;
            reached.resolve();
            await gate.promise;
          }
          return "owner-a";
        },
        loadWorkspace: async (_owner, received) => {
          if (phase === "workspace") {
            signal = received;
            reached.resolve();
            await gate.promise;
          }
          return snapshot();
        },
      });
      await reached.promise;
      if (reason === "cancel") store.cancelRestore();
      else store.clear(reason);
      assert.equal(signal?.aborted, true);
      gate.resolve();
      assert.deepEqual(await pending, { status: "locked", reason: "stale" });
      assert.equal(store.hasSealedDrafts(), reason === "cancel");
      assert.equal(store.capture(renewed, { note: noteInput }), false);
    }
  }
});

test("a stale rejected request cannot erase a newer account's drafts", async () => {
  const { store, options } = setup();
  const gate = deferred<Snapshot>();
  const reached = deferred<void>();
  const pending = store.restoreExplicit({
    ...options,
    loadWorkspace: async () => {
      reached.resolve();
      return gate.promise;
    },
  });
  await reached.promise;
  const other = { owner: "owner-b", generation: 4 };
  store.activate(other);
  store.capture(other, { note: { ...noteInput, text: "B's words" } });
  store.suspend(other);
  gate.reject({ status: 423 });
  assert.deepEqual(await pending, { status: "locked", reason: "stale" });
  store.activate({ ...other, generation: 5 });
  const result = await store.restoreExplicit({
    ...options,
    scope: { ...other, generation: 5 },
    verifyUser: async () => "owner-b",
  });
  assert.equal(
    result.status === "restored" && result.drafts.note?.text,
    "B's words",
  );
});

test("duplicate restore clicks produce only one GET and a fence change during GET denies disclosure", async () => {
  const { store, options } = setup();
  const gate = deferred<Snapshot>();
  const reached = deferred<void>();
  let blocked = false;
  let requests = 0;
  const pending = store.restoreExplicit({
    ...options,
    isFenceBlocked: async () => blocked,
    loadWorkspace: async () => {
      requests++;
      reached.resolve();
      return gate.promise;
    },
  });
  await reached.promise;
  assert.deepEqual(await store.restoreExplicit(options), {
    status: "locked",
    reason: "busy",
  });
  blocked = true;
  gate.resolve(snapshot());
  assert.deepEqual(await pending, { status: "locked", reason: "fence" });
  assert.equal(requests, 1);
  assert.equal(store.hasSealedDrafts(), true);
});

test("unknown notes are read back by stable identity without overwriting or resurrecting", async () => {
  const base = snapshot();
  const withNote = createTextNote(base.data!, {
    ...noteInput.identity,
    ...noteInput,
  });
  const saved = withNote.notes[0];
  const receipt = await noteSaveReceipt(saved, sha256);
  for (const expected of [
    "matched",
    "missing",
    "changed",
    "deleted",
  ] as const) {
    const store = createDraftRecoveryStore();
    store.activate(original);
    store.capture(original, { note: { ...noteInput, pending: receipt } });
    store.suspend(original);
    store.activate(renewed);
    const latest = snapshot();
    if (expected !== "missing")
      latest.data!.notes = [
        {
          ...saved,
          title: expected === "changed" ? "Other title" : saved.title,
          deletedAt: expected === "deleted" ? now : null,
        },
      ];
    const { options } = setup();
    const result = await store.restoreExplicit({
      ...options,
      loadWorkspace: async () => latest,
    });
    assert.equal(result.status, "restored");
    if (result.status !== "restored") continue;
    assert.equal(result.drafts.note?.pendingState, expected);
    assert.deepEqual(result.drafts.note?.pending, receipt);
    assert.equal(result.drafts.note?.identity?.id, "note-id");
    assert.equal(latest.data!.notes.length, expected === "missing" ? 0 : 1);
  }
});

test("unknown web imports retain only fingerprint; mismatched version/content/consent never match", async () => {
  const created = createWebSource(snapshot().data!, {
    ...webInput.identity,
    url: webInput.url,
    title: webInput.title,
    spaceId: webInput.spaceId,
    mode: "link",
  }).sources[0];
  const receipt = await webSaveReceipt(created, sha256);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "fingerprint",
    "id",
    "kind",
    "versionId",
  ]);
  for (const change of [
    "same",
    "missing",
    "version",
    "content",
    "consent",
    "deleted",
  ] as const) {
    const store = createDraftRecoveryStore();
    store.activate(original);
    store.capture(original, { web: { ...webInput, pending: receipt } });
    store.suspend(original);
    store.activate(renewed);
    const latest = snapshot();
    if (change !== "missing")
      latest.data!.sources = [
        {
          ...created,
          versionId: change === "version" ? "new-version" : created.versionId,
          text: change === "content" ? "changed server text" : created.text,
          aiAllowed: change === "consent",
          deletedAt: change === "deleted" ? now : null,
        },
      ];
    const { options } = setup();
    const result = await store.restoreExplicit({
      ...options,
      loadWorkspace: async () => latest,
    });
    assert.equal(result.status, "restored");
    if (result.status !== "restored") continue;
    assert.equal(
      result.drafts.web?.pendingState,
      change === "same"
        ? "matched"
        : change === "missing"
          ? "missing"
          : change === "deleted"
            ? "deleted"
            : "changed",
    );
    assert.equal(result.drafts.web?.aiAllowed, false);
    assert.equal(result.drafts.web?.requiresPreview, true);
    assert.equal("text" in result.drafts.web!, false);
  }
});

test("deleted/archived targets, changed versions and revoked AI are flagged while keeping only unsent words", async () => {
  const store = createDraftRecoveryStore();
  store.activate(original);
  store.capture(original, {
    note: noteInput,
    web: webInput,
    questions: ["ready", "changed", "revoked", "deleted", "archived"].map(
      (sourceId) => ({
        sourceId,
        versionId: "old",
        question: `Question ${sourceId}`,
        questionDirty: true,
      }),
    ),
  });
  store.suspend(original);
  store.activate(renewed);
  const latest = snapshot();
  latest.data!.spaces[0].archived = true;
  latest.data!.sources = [
    "ready",
    "changed",
    "revoked",
    "deleted",
    "archived",
  ].map((sourceId) => ({
    id: sourceId,
    versionId: sourceId === "changed" ? "new" : "old",
    title: "server title",
    kind: "text",
    filename: "read.txt",
    text: "server text",
    spaceIds: sourceId === "archived" ? ["space"] : [],
    tags: [],
    status: "ready",
    aiAllowed: sourceId !== "revoked",
    starred: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: sourceId === "deleted" ? now : null,
    chunks: [
      {
        id: "chunk",
        sourceId,
        versionId: "old",
        text: "server text",
        section: "",
      },
    ],
  }));
  const { options } = setup();
  const result = await store.restoreExplicit({
    ...options,
    loadWorkspace: async () => latest,
  });
  assert.equal(result.status, "restored");
  if (result.status !== "restored") return;
  assert.equal(result.drafts.note?.targetAvailable, false);
  assert.equal(result.drafts.web?.targetAvailable, false);
  assert.deepEqual(
    result.drafts.questions.map((item) => item.context),
    [
      "ready",
      "version-changed",
      "ai-unavailable",
      "source-unavailable",
      "source-unavailable",
    ],
  );
  assert.equal(JSON.stringify(result).includes("server text"), false);
});

test("hashing is fenced and clear is irreversible for that scope, including delayed SIGNED_OUT", async () => {
  const { store, options } = setup();
  store.clear("user");
  assert.equal(store.suspend(renewed), false);
  assert.equal(store.activate(renewed), false);
  assert.equal(store.hasSealedDrafts(), false);
  assert.equal(createDraftRecoveryStore().hasSealedDrafts(), false);
  const scope = { ...renewed, generation: 5 };
  store.activate(scope);
  const note = createTextNote(snapshot().data!, {
    ...noteInput,
    ...noteInput.identity,
  }).notes[0];
  store.capture(scope, {
    note: { ...noteInput, pending: await noteSaveReceipt(note, sha256) },
  });
  store.suspend(scope);
  const next = { ...scope, generation: 6 };
  store.activate(next);
  const hash = deferred<string>();
  const reached = deferred<void>();
  const pending = store.restoreExplicit({
    ...options,
    scope: next,
    loadWorkspace: async () => ({
      data: { ...snapshot().data!, notes: [note] },
      revision: 6,
    }),
    sha256: async () => {
      reached.resolve();
      return hash.promise;
    },
  });
  await reached.promise;
  store.clear("account-blocked");
  hash.resolve("a".repeat(64));
  assert.deepEqual(await pending, { status: "locked", reason: "stale" });
  assert.equal(store.hasSealedDrafts(), false);
});

test("auth reasons distinguish expiry, explicit blocking, identity change and ordinary conflicts", () => {
  assert.equal(authInterruptionReason({ status: 401 }), "reauthentication");
  assert.equal(authInterruptionReason({ status: 423 }), "account-blocked");
  assert.equal(
    authInterruptionReason({ code: "SESSION_CHANGED", status: 409 }),
    "account-changed",
  );
  for (const status of [0, 409, 429, 500, 503])
    assert.equal(authInterruptionReason({ status }), null);
  assert.equal(authInterruptionReason(null), null);
});

test("a discarded prompt allows fresh input, but never resurrects the discarded text", async () => {
  const { store, options } = setup();
  assert.equal(store.discardSealed(original), false);
  assert.equal(store.discardSealed(renewed), true);
  assert.equal(store.capture(renewed, { web: webInput }), true);
  store.suspend(renewed);
  const next = { ...renewed, generation: 4 };
  store.activate(next);
  const result = await store.restoreExplicit({ ...options, scope: next });
  assert.equal(result.status, "restored");
  if (result.status !== "restored") return;
  assert.equal(result.drafts.note, null);
  assert.equal(result.drafts.web?.url, webInput.url);
});

test("a different online-verified owner destroys old drafts even when its login never clears the fence", async () => {
  const { store, options } = setup();
  assert.equal(store.clearIfDifferentOwner("owner-a"), false);
  assert.equal(store.hasSealedDrafts(), true);
  assert.equal(store.clearIfDifferentOwner("owner-b"), true);
  assert.equal(store.hasSealedDrafts(), false);
  const next = { owner: "owner-a", generation: 5 };
  store.activate(next);
  assert.deepEqual(await store.restoreExplicit({ ...options, scope: next }), {
    status: "empty",
  });
});

test("a late original web save can match a retained receipt after a new extraction", async () => {
  const created = createWebSource(snapshot().data!, {
    ...webInput.identity,
    url: webInput.url,
    mode: "link",
  }).sources[0];
  const firstReceipt = await webSaveReceipt(created, sha256);
  const changed = {
    ...created,
    versionId: "second-version",
    title: "New user title",
  };
  const secondReceipt = await webSaveReceipt(changed, sha256);
  const { store, options } = setup();
  store.clear("discard");
  const scope = { ...renewed, generation: 4 };
  store.activate(scope);
  assert.equal(
    store.capture(scope, {
      web: {
        ...webInput,
        identity: { ...webInput.identity, versionId: "second-version" },
        pending: secondReceipt,
        previousPending: [firstReceipt],
      },
    }),
    true,
  );
  assert.equal(
    store.capture(scope, { web: { ...webInput, pending: secondReceipt } }),
    false,
  );
  store.suspend(scope);
  const next = { ...scope, generation: 5 };
  store.activate(next);
  const result = await store.restoreExplicit({
    ...options,
    scope: next,
    loadWorkspace: async () => ({
      data: { ...snapshot().data!, sources: [created] },
      revision: 7,
    }),
  });
  assert.equal(
    result.status === "restored" && result.drafts.web?.pendingState,
    "matched",
  );
});

test("real API GET and session fence cooperate to reconcile an unknown save without any write request", async () => {
  const { store, options } = setup();
  let marker: string | null = null;
  const fence = createSessionFence({
    async getItem() {
      return marker;
    },
    async setItem(value) {
      marker = value;
    },
    async removeItem() {
      marker = null;
    },
  });
  const login = await fence.block();
  const methods: string[] = [];
  const api = createApi(
    "https://example.org",
    async () => ({ userId: renewed.owner, accessToken: "test-only" }),
    (async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json(snapshot());
    }) as typeof fetch,
  );
  const gated = {
    ...options,
    isFenceBlocked: () => fence.isBlocked(),
    loadWorkspace: (owner: string, signal: AbortSignal) =>
      api.load(owner, signal),
  };
  assert.deepEqual(await store.restoreExplicit(gated), {
    status: "locked",
    reason: "fence",
  });
  assert.deepEqual(methods, []);
  assert.equal(await fence.allowVerifiedLogin(login), true);
  const result = await store.restoreExplicit(gated);
  assert.equal(result.status, "restored");
  assert.deepEqual(methods, ["GET"]);
});
