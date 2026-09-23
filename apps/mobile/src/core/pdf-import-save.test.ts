import assert from "node:assert/strict";
import test from "node:test";
import { blankWorkspace, type Snapshot, type Source, type Workspace } from "./contracts.ts";
import { saveImportedPdfWithCAS } from "./pdf-import-save.ts";

const sourceId = "pdf-import-1";
const sourceVersion = "pdf-version-1";
const hash = "a".repeat(64);

function pdf(overrides: Partial<Source> = {}): Source {
  return {
    id: sourceId,
    versionId: sourceVersion,
    title: "Safe test PDF",
    filename: "safe-test.pdf",
    kind: "pdf",
    mime: "application/pdf",
    size: 40,
    hash,
    spaceIds: [],
    tags: [],
    status: "ready",
    coverage: { captureScope: "full", parseState: "complete" },
    text: "A harmless test document.",
    chunks: [],
    createdAt: "2026-09-23T12:00:00.000Z",
    updatedAt: "2026-09-23T12:00:00.000Z",
    deletedAt: null,
    aiAllowed: false,
    starred: false,
    storagePath: "owner/version/source.pdf",
    ...overrides,
  };
}

function space(id: string) {
  return { id, name: id, goal: "", color: "", archived: false, createdAt: "now" };
}

function apiFor(initial: Snapshot, save: (snapshot: Snapshot, data: Workspace) => Promise<Snapshot>) {
  let cloud = initial;
  return {
    get cloud() {
      return cloud;
    },
    setCloud(next: Snapshot) {
      cloud = next;
    },
    load: async () => structuredClone(cloud),
    save: async (_owner: string, snapshot: Snapshot, data: Workspace) => {
      const saved = await save(snapshot, data);
      cloud = saved;
      return saved;
    },
  };
}

const current = () => true;

test("PDF CAS retries after a revision conflict and preserves unrelated cloud sources", async () => {
  const other: Source = pdf({
    id: "other-pdf",
    versionId: "other-version",
    hash: "c".repeat(64),
    storagePath: "owner/other-version/other-pdf.pdf",
  });
  const initial: Snapshot = { data: blankWorkspace(), revision: 1 };
  let saves = 0;
  const api = apiFor(initial, async (snapshot, data) => {
    saves++;
    if (saves === 1) {
      apiState.setCloud({
        data: { ...blankWorkspace(), sources: [other] },
        revision: 2,
      });
      throw { status: 409, code: "REVISION_CONFLICT" };
    }
    assert.equal(snapshot.revision, 2);
    return { data, revision: 3 };
  });
  const apiState = api;
  const result = await saveImportedPdfWithCAS({
    owner: "user",
    source: pdf(),
    spaceId: "",
    initial,
    api,
    isCurrent: current,
  });
  assert.equal(result.duplicate, false);
  assert.deepEqual(
    api.cloud.data?.sources.map((item) => item.id).sort(),
    ["other-pdf", sourceId].sort(),
  );
});

test("an unknown save outcome is read back and confirmed without retrying the write", async () => {
  const initial: Snapshot = { data: blankWorkspace(), revision: 1 };
  let saves = 0;
  const api = apiFor(initial, async (_snapshot, data) => {
    saves++;
    apiState.setCloud({ data, revision: 2 });
    throw { status: 0, code: "CONNECTION_FAILED" };
  });
  const apiState = api;
  const result = await saveImportedPdfWithCAS({
    owner: "user",
    source: pdf(),
    spaceId: "",
    initial,
    api,
    isCurrent: current,
  });
  assert.equal(saves, 1);
  assert.equal(result.source.id, sourceId);
  assert.equal(result.snapshot.revision, 2);
});

test("a concurrent identical import reuses the cloud source and its storage path", async () => {
  const initialData = { ...blankWorkspace(), spaces: [space("space-a")] };
  const initial: Snapshot = { data: initialData, revision: 4 };
  const existing = pdf({
    id: "existing-pdf",
    versionId: "existing-version",
    spaceIds: [],
    storagePath: "owner/existing-version/existing-pdf.pdf",
  });
  let saves = 0;
  const api = apiFor(initial, async (_snapshot, data) => {
    saves++;
    if (saves === 1) {
      apiState.setCloud({
        data: { ...initialData, sources: [existing] },
        revision: 5,
      });
      throw { status: 409, code: "REVISION_CONFLICT" };
    }
    return { data, revision: 6 };
  });
  const apiState = api;
  const result = await saveImportedPdfWithCAS({
    owner: "user",
    source: pdf(),
    spaceId: "space-a",
    initial,
    api,
    isCurrent: current,
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.source.id, existing.id);
  assert.equal(result.source.storagePath, existing.storagePath);
  assert.deepEqual(result.source.spaceIds, ["space-a"]);
  assert.equal(api.cloud.data?.sources.length, 1);
});

test("a permanent workspace rejection is not retried or turned into a false success", async () => {
  const initial: Snapshot = { data: blankWorkspace(), revision: 1 };
  let loads = 0;
  const api = {
    load: async () => {
      loads++;
      return initial;
    },
    save: async () => {
      throw { status: 413, code: "WORKSPACE_TOO_LARGE" };
    },
  };
  await assert.rejects(
    saveImportedPdfWithCAS({
      owner: "user",
      source: pdf(),
      spaceId: "",
      initial,
      api,
      isCurrent: current,
    }),
    (error: unknown) =>
      !!error && typeof error === "object" && "status" in error && error.status === 413,
  );
  assert.equal(loads, 0);
});
