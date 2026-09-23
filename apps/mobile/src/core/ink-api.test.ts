import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInkOperationId, createInkSyncQueue } from "./ink-api.ts";

test("operation id keeps the full drawing digest under the API limit", () => {
  const digest = "a".repeat(64);
  const id = buildInkOperationId(0, digest, 1);
  assert.equal(id, `p0g1-${digest}`);
  assert.ok(id.length <= 100);
});

test("operation id distinguishes pages and CAS generations", () => {
  const digest = "b".repeat(64);
  assert.notEqual(buildInkOperationId(0, digest, 1), buildInkOperationId(1, digest, 1));
  assert.notEqual(buildInkOperationId(0, digest, 1), buildInkOperationId(0, digest, 2));
});

test("same-page ink syncs run one after another", async () => {
  const enqueue = createInkSyncQueue();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const a = enqueue(1, async () => {
    order.push("a-start");
    await first;
    order.push("a-end");
  });
  const b = enqueue(1, async () => {
    order.push("b");
  });
  await Promise.resolve();
  assert.deepEqual(order.slice(), ["a-start"]);
  releaseFirst();
  await Promise.all([a, b]);
  assert.deepEqual(order.slice(), ["a-start", "a-end", "b"]);
});

test("different pages can sync in parallel", async () => {
  const enqueue = createInkSyncQueue();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const a = enqueue(1, async () => {
    order.push("p1-start");
    await first;
    order.push("p1-end");
  });
  const b = enqueue(2, async () => {
    order.push("p2");
  });
  await b;
  assert.deepEqual(order.slice(), ["p1-start", "p2"]);
  releaseFirst();
  await a;
  assert.deepEqual(order.slice(), ["p1-start", "p2", "p1-end"]);
});

test("page queue continues after a failed sync", async () => {
  const enqueue = createInkSyncQueue();
  const order: string[] = [];
  const failed = enqueue(3, async () => {
    order.push("fail");
    throw new Error("boom");
  });
  const next = enqueue(3, async () => {
    order.push("next");
  });
  await assert.rejects(failed, /boom/u);
  await next;
  assert.deepEqual(order.slice(), ["fail", "next"]);
});
