import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createDemoWorkspace } from "../seed";
import { deleteLearningSpace } from "../space-lifecycle";
import { organizationCitations, organizationContextKey } from "../organization";
import { resolveCitation } from "../retrieval";
import { snapshotKnowledgeNote } from "../knowledge-update";
import { bindOrganizationResult, buildOrganizationGrounding } from "../ai/organization";
import type { OrganizationRequest, OrganizationResult } from "../organization-types";
import type { WorkspaceData } from "../types";
import { ApiError } from "./api";

const mock = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  read: vi.fn(),
  readModelConfig: vi.fn(),
  readModelProfile: vi.fn(),
  callModel: vi.fn(),
  createRequestStore: vi.fn(),
  reserveRequest: vi.fn(),
  finishRequest: vi.fn(),
}));
const accountAccess = {
  state: null,
  allowed: true,
  sources: 0,
  versions: 0,
  notes: 0,
  conversations: 0,
  annotations: 0,
  spaces: 0,
  currentStorageObjects: 0,
  pendingSourcePurgeObjects: 0,
  totalStorageObjects: 0,
};
function rpcWithAccountAccess(name: string, args: Record<string, unknown>) {
  if (name === "account_deletion_access_status")
    return Promise.resolve({ data: accountAccess, error: null });
  return mock.rpc(name, args);
}
vi.mock("./server", () => ({
  createClient: async () => ({
    auth: { getUser: mock.getUser },
    from: mock.from,
    rpc: rpcWithAccountAccess,
  }),
}));
vi.mock("./config", () => ({
  getSupabaseConfig: () => ({ url: "https://example.supabase.co", key: "public-test-key" }),
}));
vi.mock("../ai/model", () => ({
  readModelConfig: mock.readModelConfig,
  readModelProfile: mock.readModelProfile,
  callModel: mock.callModel,
}));
vi.mock("../ai/requests", () => ({
  createRequestStore: mock.createRequestStore,
  reserveRequest: mock.reserveRequest,
  finishRequest: mock.finishRequest,
}));
import { POST } from "@/app/api/v1/organize/route";

let workspace: WorkspaceData;
let currentUser: string | null;
const owner = "owner-a";
const store = { name: "shared-request-ledger" };
const config = {
  baseUrl: "https://model.example/v1",
  model: "configured-model",
  apiKey: "private-server-key",
  jsonMode: false,
  tokenLimitParameter: "max_completion_tokens",
  timeoutMs: 45_000,
};
type EvidencePrompt = {
  kind: string;
  evidence: Array<{ id: string; sourceId: string; title: string; text: string }>;
};
type ModelMessage = { role: string; content: string };
function input(patch: Partial<OrganizationRequest> = {}): OrganizationRequest {
  return {
    requestId: "organize-attempt-1",
    kind: "source",
    trigger: "manual",
    spaceId: workspace.spaces[0].id,
    sourceIds: [workspace.sources[0].id],
    sourceVersions: [
      { sourceId: workspace.sources[0].id, versionId: workspace.sources[0].versionId },
    ],
    ...patch,
  };
}
function knowledge(): OrganizationRequest {
  return input({
    kind: "knowledge",
    sourceIds: workspace.sources.slice(0, 2).map((source) => source.id),
    sourceVersions: workspace.sources
      .slice(0, 2)
      .map((source) => ({ sourceId: source.id, versionId: source.versionId })),
  });
}
function request(patch: Partial<OrganizationRequest> = {}, signal?: AbortSignal, user = owner) {
  return new Request("http://localhost/api/v1/organize", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Conuo-User": user },
    body: JSON.stringify(input(patch)),
    signal,
  });
}
const paragraph = (evidenceIds = ["e1"]) => ({
  text: "有资料依据的解释",
  evidenceIds,
  kind: "source",
});
function generatedSource() {
  return JSON.stringify({
    status: "ready",
    kind: "source",
    summary: { title: "摘要", paragraphs: [paragraph()] },
    tags: [{ label: "学习率", evidenceIds: ["e1"] }],
    topics: [{ label: "优化", evidenceIds: ["e1"] }],
  });
}
function generatedKnowledge() {
  return JSON.stringify({
    status: "ready",
    kind: "knowledge",
    pages: ["e1", "e2"].map((id, index) => ({
      title: `主题${index + 1}`,
      sections: [
        { section: "concept", paragraphs: [paragraph([id])] },
        { section: "explanation", paragraphs: [paragraph([id])] },
      ],
    })),
  });
}
function generatedUpdate(
  changes = [
    {
      type: "replace",
      blockId: "b2",
      after: "学习率是参数更新的步长系数。",
      reason: "依据原文补充步长含义。",
      evidenceIds: ["e1"],
    },
  ],
) {
  return JSON.stringify({ status: "ready", kind: "update", changes });
}
function generatedRelations(
  relations = [
    {
      type: "related",
      fromClaim: "起点概念",
      toClaim: "终点概念",
      fromCondition: "条件一",
      toCondition: "条件二",
      explanation: "AI 建议：可对照两处原文核对关联。",
      fromEvidenceIds: ["e1"],
      toEvidenceIds: ["e2"],
    },
  ],
) {
  return JSON.stringify({ status: "ready", kind: "relations", relations });
}
function cachedResult(): OrganizationResult {
  const value = input();
  return bindOrganizationResult(
    generatedSource(),
    buildOrganizationGrounding(workspace, value),
    value,
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
}

beforeEach(() => {
  Object.values(mock).forEach((fn) => fn.mockReset());
  mock.readModelProfile.mockImplementation(() => {
    const config = mock.readModelConfig();
    return config ? { profile: "default", config } : null;
  });
  workspace = createDemoWorkspace();
  workspace.autoOrganize = true;
  currentUser = owner;
  const chain = { select: mock.select, eq: mock.eq, maybeSingle: mock.read };
  mock.from.mockReturnValue(chain);
  mock.select.mockReturnValue(chain);
  mock.eq.mockReturnValue(chain);
  mock.getUser.mockImplementation(async () => ({
    data: { user: currentUser ? { id: currentUser } : null },
    error: null,
  }));
  mock.read.mockImplementation(async () => ({
    data: { data: structuredClone(workspace) },
    error: null,
  }));
  mock.readModelConfig.mockReturnValue(config);
  mock.createRequestStore.mockReturnValue(store);
  mock.reserveRequest.mockResolvedValue({ kind: "reserved" });
  mock.finishRequest.mockResolvedValue(undefined);
  mock.callModel.mockImplementation(async (_config: unknown, messages: ModelMessage[]) => {
    const prompt = JSON.parse(
      messages.find((message) => message.role === "user")!.content,
    ) as EvidencePrompt;
    return prompt.kind === "source"
      ? generatedSource()
      : prompt.kind === "update"
        ? generatedUpdate()
        : prompt.kind === "relations"
          ? generatedRelations()
          : generatedKnowledge();
  });
});

describe("concept relation API binds both owned endpoints", () => {
  const target = () => workspace.notes[0];
  const compare = () => workspace.notes[1];
  const relationInput = () => ({
    ...knowledge(),
    kind: "relations" as const,
    targetNote: {
      id: target().id,
      revision: target().contentRevision ?? 0,
      updatedAt: target().updatedAt,
    },
    compareNote: {
      id: compare().id,
      revision: compare().contentRevision ?? 0,
      updatedAt: compare().updatedAt,
    },
  });
  function cachedRelations() {
    const value = relationInput();
    return bindOrganizationResult(
      generatedRelations(),
      buildOrganizationGrounding(workspace, value),
      value,
      snapshotKnowledgeNote(target()),
      snapshotKnowledgeNote(compare()),
    );
  }
  beforeEach(() => {
    const now = new Date().toISOString();
    workspace.notes = ["from-note", "to-note"].map((id) => ({
      id,
      spaceId: workspace.spaces[0].id,
      title: id,
      content: `<p>${id} 的用户知识页内容</p>`,
      kind: "knowledge",
      status: "accepted",
      contentRevision: 4,
      citations: [],
      versions: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }));
  });
  it("returns separately grounded AI suggestions without changing either note", async () => {
    const original = structuredClone(workspace.notes);
    const response = await POST(request(relationInput()));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      kind: "relations",
      mode: "model",
      target: snapshotKnowledgeNote(original[0]),
      compare: snapshotKnowledgeNote(original[1]),
      relations: [{ id: "r1", type: "related" }],
    });
    expect(workspace.notes).toEqual(original);
    expect(mock.finishRequest).toHaveBeenCalledWith(store, owner, "organize-attempt-1", result);
    const prompt = JSON.parse(mock.callModel.mock.calls[0][1][1].content);
    expect(prompt.target.title).toBe(original[0].title);
    expect(prompt.compare.title).toBe(original[1].title);
  });
  it("returns zero proposals without calling them an error", async () => {
    mock.callModel.mockResolvedValue(generatedRelations([]));
    const response = await POST(request(relationInput()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "relations", relations: [] });
  });
  it.each(["same-note", "automatic", "missing-compare", "extra-snapshot"])(
    "rejects invalid endpoint request %s before reading workspace",
    async (condition) => {
      const value: Partial<OrganizationRequest> = relationInput();
      if (condition === "same-note") value.compareNote = value.targetNote;
      else if (condition === "automatic") value.trigger = "automatic";
      else if (condition === "missing-compare") delete value.compareNote;
      else Object.assign(value.compareNote!, { content: "FORGED" });
      await expectError(await POST(request(value)), 400, "INVALID_ORGANIZATION");
      expect(mock.read).not.toHaveBeenCalled();
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );
  it.each(["missing", "deleted", "kind", "space", "revision", "updatedAt"])(
    "rejects an unavailable compare endpoint before reserving: %s",
    async (condition) => {
      const value = relationInput();
      if (condition === "missing") workspace.notes.pop();
      else if (condition === "deleted") compare().deletedAt = new Date().toISOString();
      else if (condition === "kind") compare().kind = "note";
      else if (condition === "space") compare().spaceId = "other-space";
      else if (condition === "revision") compare().contentRevision! += 1;
      else compare().updatedAt = "2020-01-01T00:00:00.000Z";
      expect((await POST(request(value))).status).toBe(409);
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );
  it.each(["target", "compare"])(
    "requires all inherited citation sources from %s",
    async (side) => {
      const cite = buildOrganizationGrounding(workspace, knowledge()).evidence[1];
      (side === "target" ? target() : compare()).citations = [cite];
      const value = relationInput();
      value.sourceIds = [workspace.sources[0].id];
      value.sourceVersions = [
        { sourceId: workspace.sources[0].id, versionId: workspace.sources[0].versionId },
      ];
      expect((await POST(request(value))).status).toBe(409);
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );
  it.each(["old-version", "stale-quote", "revoked"])(
    "does not disclose compare contents with unusable inherited evidence: %s",
    async (condition) => {
      const cite = structuredClone(buildOrganizationGrounding(workspace, knowledge()).evidence[1]);
      compare().citations = [cite];
      if (condition === "old-version") cite.versionId = "old-source-version";
      else if (condition === "stale-quote") cite.quote = "invented historical quote";
      else workspace.sources[1].aiAllowed = false;
      expect((await POST(request(relationInput()))).ok).toBe(false);
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );
  it.each(["target", "compare"])(
    "rechecks %s edits during reservation wait before sending either page",
    async (side) => {
      const gate = deferred<{ kind: "reserved" }>();
      mock.reserveRequest.mockReturnValue(gate.promise);
      const pending = POST(request(relationInput()));
      await vi.waitFor(() => expect(mock.reserveRequest).toHaveBeenCalledOnce());
      (side === "target" ? target() : compare()).content = "<p>人工编辑</p>";
      gate.resolve({ kind: "reserved" });
      await expectError(await pending, 409, "ORGANIZATION_CONTEXT_CHANGED");
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );
  it.each([
    "content",
    "title",
    "revision",
    "updatedAt",
    "citations",
    "status",
    "space",
    "delete",
    "kind",
    "ai-permission",
  ])(
    "discards relation output when the compare %s changes during generation",
    async (condition) => {
      const gate = deferred<string>();
      mock.callModel.mockReturnValue(gate.promise);
      const pending = POST(request(relationInput()));
      await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
      if (condition === "content") compare().content = "<p>人工新正文</p>";
      else if (condition === "title") compare().title = "新标题";
      else if (condition === "revision") compare().contentRevision! += 1;
      else if (condition === "updatedAt") compare().updatedAt = "2020-01-01T00:00:00.000Z";
      else if (condition === "citations")
        compare().citations = [buildOrganizationGrounding(workspace, knowledge()).evidence[1]];
      else if (condition === "status") compare().status = "draft";
      else if (condition === "space") compare().spaceId = "other-space";
      else if (condition === "delete") compare().deletedAt = new Date().toISOString();
      else if (condition === "kind") compare().kind = "note";
      else workspace.sources[1].aiAllowed = false;
      gate.resolve(generatedRelations());
      await expectError(await pending, 409, "ORGANIZATION_CONTEXT_CHANGED");
      expect(mock.finishRequest.mock.calls.every((args) => args[3] === undefined)).toBe(true);
    },
  );
  it("refuses a note change during ledger persistence", async () => {
    mock.finishRequest.mockImplementation(async () => {
      compare().contentRevision! += 1;
    });
    await expectError(await POST(request(relationInput())), 409, "ORGANIZATION_CONTEXT_CHANGED");
    expect(mock.finishRequest).toHaveBeenCalledOnce();
  });
  it("returns a current same-kind cache without another model call", async () => {
    const cached = cachedRelations();
    mock.reserveRequest.mockResolvedValue({ kind: "cached", result: cached });
    const response = await POST(request(relationInput()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cached);
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });
  it.each(["target", "compare", "quote", "wrong-kind"])(
    "does not restore an invalid relation cache: %s",
    async (condition) => {
      let cached = cachedRelations();
      if (cached.kind !== "relations") throw new Error("Expected relations");
      if (condition === "target" || condition === "compare")
        cached[condition].content = "<p>wrong baseline</p>";
      else if (condition === "quote") cached.relations[0].toCitations[0].quote = "forged";
      else cached = cachedResult();
      mock.reserveRequest.mockResolvedValue({ kind: "cached", result: cached });
      expect((await POST(request(relationInput()))).status).toBe(502);
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );
  it("rechecks both endpoints while restoring cache and binds compare revision in fingerprint", async () => {
    const gate = deferred<{ kind: "cached"; result: OrganizationResult }>();
    const cached = cachedRelations();
    mock.reserveRequest.mockReturnValueOnce(gate.promise);
    const pending = POST(request(relationInput()));
    await vi.waitFor(() => expect(mock.reserveRequest).toHaveBeenCalledOnce());
    const firstFingerprint = mock.reserveRequest.mock.calls[0][3];
    compare().contentRevision! += 1;
    gate.resolve({ kind: "cached", result: cached });
    await expectError(await pending, 409, "ORGANIZATION_CONTEXT_CHANGED");
    expect(mock.callModel).not.toHaveBeenCalled();
    mock.reserveRequest.mockResolvedValue({ kind: "reserved" });
    expect(
      (await POST(request({ ...relationInput(), requestId: "new-relation-request" }))).status,
    ).toBe(200);
    expect(mock.reserveRequest.mock.calls[1][3]).not.toBe(firstFingerprint);
  });
});

describe("knowledge update API preserves owned note versions", () => {
  const target = () => workspace.notes.find((note) => note.id === "update-target")!;
  const update = () =>
    input({
      kind: "update",
      targetNote: {
        id: target().id,
        revision: target().contentRevision ?? 0,
        updatedAt: target().updatedAt,
      },
    });
  const cachedUpdate = () => {
    const value = update();
    return bindOrganizationResult(
      generatedUpdate(),
      buildOrganizationGrounding(workspace, value),
      value,
      snapshotKnowledgeNote(target()),
    );
  };
  beforeEach(() => {
    const now = new Date().toISOString();
    workspace.notes.push({
      id: "update-target",
      spaceId: workspace.spaces[0].id,
      title: "学习率知识页",
      content: "<h2>学习率</h2><p>步长</p>",
      kind: "knowledge",
      status: "accepted",
      contentRevision: 2,
      aiGenerated: false,
      citations: [],
      versions: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  });

  it("reads the target from the owned workspace and returns unapplied anchored suggestions", async () => {
    const original = structuredClone(target());
    const response = await POST(request(update()));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      kind: "update",
      target: snapshotKnowledgeNote(original),
      changes: [{ id: "c1", before: "<p>步长</p>" }],
    });
    expect(target()).toEqual(original);
    expect(mock.finishRequest).toHaveBeenCalledWith(store, owner, "organize-attempt-1", result);
    const prompt = JSON.parse(mock.callModel.mock.calls[0][1][1].content);
    expect(prompt.target).toEqual({
      title: original.title,
      blocks: [
        { id: "b1", text: "学习率" },
        { id: "b2", text: "步长" },
      ],
    });
  });

  it("supports zero updates without inventing a change or requiring output citation coverage", async () => {
    mock.callModel.mockResolvedValue(generatedUpdate([]));
    const response = await POST(
      request({ ...knowledge(), kind: "update", targetNote: update().targetNote }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "update", changes: [] });
  });

  it.each(["missing", "deleted", "kind", "space", "revision", "updatedAt"])(
    "rejects an unavailable target or stale request before reserving: %s",
    async (condition) => {
      const value = update();
      if (condition === "missing") workspace.notes = [];
      else if (condition === "deleted") target().deletedAt = new Date().toISOString();
      else if (condition === "kind") target().kind = "note";
      else if (condition === "space") target().spaceId = "different-space";
      else if (condition === "revision") target().contentRevision! += 1;
      else target().updatedAt = "2020-01-01T00:00:00.000Z";
      expect((await POST(request(value))).status).toBe(409);
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );

  it("refuses client-supplied target body and automatic update requests", async () => {
    await expectError(
      await POST(
        request({
          ...update(),
          targetNote: {
            ...update().targetNote!,
            content: "FORGED",
          } as OrganizationRequest["targetNote"],
        }),
      ),
      400,
      "INVALID_ORGANIZATION",
    );
    await expectError(
      await POST(request({ ...update(), trigger: "automatic" })),
      400,
      "INVALID_ORGANIZATION",
    );
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it.each(["outside-selection", "revoked", "old-version", "stale-quote", "deleted"])(
    "does not disclose target text when existing citations are unusable: %s",
    async (condition) => {
      const citation = structuredClone(buildOrganizationGrounding(workspace, input()).evidence[0]);
      target().citations = [citation];
      let value = update();
      if (condition === "outside-selection") {
        value = {
          ...value,
          sourceIds: [workspace.sources[1].id],
          sourceVersions: [
            { sourceId: workspace.sources[1].id, versionId: workspace.sources[1].versionId },
          ],
        };
      } else if (condition === "revoked") workspace.sources[0].aiAllowed = false;
      else if (condition === "old-version") citation.versionId = "old-version";
      else if (condition === "stale-quote") citation.quote = "not present in current source";
      else workspace.sources[0].deletedAt = new Date().toISOString();
      expect((await POST(request(value))).ok).toBe(false);
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );

  it("rechecks target editing during the reservation wait before disclosing evidence", async () => {
    const gate = deferred<{ kind: "reserved" }>();
    mock.reserveRequest.mockReturnValue(gate.promise);
    const pending = POST(request(update()));
    await vi.waitFor(() => expect(mock.reserveRequest).toHaveBeenCalledOnce());
    target().content = "<p>人工刚修改</p>";
    gate.resolve({ kind: "reserved" });
    await expectError(await pending, 409, "ORGANIZATION_CONTEXT_CHANGED");
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it.each([
    "content",
    "title",
    "revision",
    "updatedAt",
    "citations",
    "status",
    "delete",
    "space",
    "kind",
    "source-ai",
    "global-ai",
  ])("does not publish generated updates after a %s change", async (condition) => {
    const gate = deferred<string>();
    mock.callModel.mockReturnValue(gate.promise);
    const pending = POST(request(update()));
    await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
    if (condition === "content") target().content = "<h2>人工修改</h2><p>新内容</p>";
    else if (condition === "title") target().title = "刚刚改名";
    else if (condition === "revision") target().contentRevision! += 1;
    else if (condition === "updatedAt") target().updatedAt = "2020-01-01T00:00:00.000Z";
    else if (condition === "citations")
      target().citations = [buildOrganizationGrounding(workspace, input()).evidence[0]];
    else if (condition === "status") target().status = "draft";
    else if (condition === "delete") target().deletedAt = new Date().toISOString();
    else if (condition === "space") target().spaceId = "other-space";
    else if (condition === "kind") target().kind = "note";
    else if (condition === "source-ai") workspace.sources[0].aiAllowed = false;
    else workspace.aiEnabled = false;
    gate.resolve(generatedUpdate());
    await expectError(await pending, 409, "ORGANIZATION_CONTEXT_CHANGED");
    expect(mock.finishRequest.mock.calls.every((args) => args[3] === undefined)).toBe(true);
  });

  it("rejects an edit during result ledger persistence", async () => {
    mock.finishRequest.mockImplementation(async () => {
      target().contentRevision! += 1;
    });
    await expectError(await POST(request(update())), 409, "ORGANIZATION_CONTEXT_CHANGED");
    expect(mock.finishRequest).toHaveBeenCalledOnce();
  });

  it("restores only an exact current target cache without another model invocation", async () => {
    const cached = cachedUpdate();
    mock.reserveRequest.mockResolvedValue({ kind: "cached", result: cached });
    const response = await POST(request(update()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cached);
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });

  it.each(["body", "baseline", "quote", "source-cache"])(
    "rejects an invalid update cache %s instead of calling the model again",
    async (condition) => {
      let cached = cachedUpdate();
      if (cached.kind !== "update") throw new Error("Expected update");
      if (condition === "body") cached.target.content = "<p>old content</p>";
      else if (condition === "baseline") cached.changes[0].before = "<p>fake baseline</p>";
      else if (condition === "quote") cached.changes[0].citations[0].quote = "forged quote";
      else cached = cachedResult();
      mock.reserveRequest.mockResolvedValue({ kind: "cached", result: cached });
      expect((await POST(request(update()))).status).toBe(502);
      expect(mock.callModel).not.toHaveBeenCalled();
      expect(mock.finishRequest).not.toHaveBeenCalled();
    },
  );

  it("refuses a current cache if the note changes while waiting on reservation", async () => {
    const gate = deferred<{ kind: "cached"; result: OrganizationResult }>();
    const cached = cachedUpdate();
    mock.reserveRequest.mockReturnValue(gate.promise);
    const pending = POST(request(update()));
    await vi.waitFor(() => expect(mock.reserveRequest).toHaveBeenCalledOnce());
    target().contentRevision! += 1;
    gate.resolve({ kind: "cached", result: cached });
    await expectError(await pending, 409, "ORGANIZATION_CONTEXT_CHANGED");
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it("binds note content and revision into the shared request fingerprint", async () => {
    expect((await POST(request(update()))).status).toBe(200);
    const first = mock.reserveRequest.mock.calls[0][3];
    target().contentRevision! += 1;
    expect((await POST(request({ ...update(), requestId: "new-attempt" }))).status).toBe(200);
    expect(mock.reserveRequest.mock.calls[1][3]).not.toBe(first);
    target().content = "<h2>学习率</h2><p>人工新内容</p>";
    expect((await POST(request({ ...update(), requestId: "third-attempt" }))).status).toBe(200);
    expect(mock.reserveRequest.mock.calls[2][3]).not.toBe(mock.reserveRequest.mock.calls[1][3]);
  });
});

describe("organization API account, evidence, and shared-ledger boundaries", () => {
  it("versions the model output contract in the interactive organization fingerprint", async () => {
    const organizationInput = input();
    const response = await POST(request());
    expect(response.status).toBe(200);
    const fingerprintFor = (contract: string) =>
      createHash("sha256")
        .update(
          JSON.stringify([
            contract,
            config.baseUrl,
            config.model,
            config.jsonMode,
            ...(contract === "organization-v2" ? [null] : []),
            "default",
            organizationContextKey(workspace, organizationInput),
          ]),
        )
        .digest("hex");
    expect(mock.reserveRequest.mock.calls[0][3]).toBe(fingerprintFor("organization-v2"));
    expect(mock.reserveRequest.mock.calls[0][3]).not.toBe(fingerprintFor("organization-v1"));
    expect(mock.callModel).toHaveBeenCalledOnce();
  });

  it("gives omitted, enabled and disabled thinking modes distinct v2 organization ledger identities", async () => {
    const fingerprints: string[] = [];
    const expected: string[] = [];
    const contextKey = organizationContextKey(workspace, input());
    for (const [index, mode] of ([undefined, "enabled", "disabled"] as const).entries()) {
      const effectiveConfig = mode === undefined ? config : { ...config, thinkingMode: mode };
      mock.readModelConfig.mockReturnValue(effectiveConfig);
      const response = await POST(request());
      expect(response.status).toBe(200);
      fingerprints.push(mock.reserveRequest.mock.calls[index][3]);
      expected.push(
        createHash("sha256")
          .update(
            JSON.stringify([
              "organization-v2",
              config.baseUrl,
              config.model,
              config.jsonMode,
              mode ?? null,
              "default",
              contextKey,
            ]),
          )
          .digest("hex"),
      );
      expect(mock.callModel.mock.calls[index][0]).toEqual(effectiveConfig);
    }
    expect(new Set(fingerprints).size).toBe(3);
    expect(fingerprints).toEqual(expected);
    expect(mock.reserveRequest).toHaveBeenCalledTimes(3);
    expect(mock.callModel).toHaveBeenCalledTimes(3);
    expect(mock.finishRequest).toHaveBeenCalledTimes(3);
  });

  it.each([
    [undefined, "enabled"],
    [undefined, "disabled"],
    ["enabled", "disabled"],
  ] as const)(
    "rejects a cached request when thinking changes from %s to %s",
    async (before, after) => {
      mock.readModelConfig.mockReturnValue(
        before === undefined ? config : { ...config, thinkingMode: before },
      );
      const first = await POST(request());
      expect(first.status).toBe(200);
      const cached = await first.json();
      const firstFingerprint = mock.reserveRequest.mock.calls[0][3];
      mock.reserveRequest.mockImplementationOnce(async (_ledger, _owner, _request, fingerprint) => {
        if (fingerprint === firstFingerprint) return { kind: "cached", result: cached };
        throw new ApiError(409, "REQUEST_CHANGED", "请重新发起模型请求。");
      });
      mock.readModelConfig.mockReturnValue({ ...config, thinkingMode: after });
      await expectError(await POST(request()), 409, "REQUEST_CHANGED");
      expect(mock.reserveRequest.mock.calls[1][3]).not.toBe(firstFingerprint);
      expect(mock.callModel).toHaveBeenCalledOnce();
      expect(mock.finishRequest).toHaveBeenCalledOnce();
    },
  );

  it("returns real source suggestions and saves the result in the shared owner request ledger", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    const result = (await response.json()) as OrganizationResult;
    expect(result.kind).toBe("source");
    expect(result.mode).toBe("model");
    expect(
      organizationCitations(result).every((citation) => resolveCitation(workspace, citation)),
    ).toBe(true);
    expect(mock.reserveRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "organize-attempt-1",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "organize-attempt-1",
      result,
    );
    expect(mock.eq.mock.calls.every((args) => args[0] === "owner_id" && args[1] === owner)).toBe(
      true,
    );
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
  });

  it("rejects an extra summary kind without repairing or retrying the generated result", async () => {
    const generated = JSON.parse(generatedSource());
    generated.summary.kind = "source";
    mock.callModel.mockResolvedValueOnce(JSON.stringify(generated));
    const original = structuredClone(workspace);
    await expectError(await POST(request()), 502, "INVALID_MODEL_ORGANIZATION");
    expect(workspace).toEqual(original);
    expect(mock.reserveRequest).toHaveBeenCalledOnce();
    expect(mock.callModel).toHaveBeenCalledOnce();
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "organize-attempt-1",
      undefined,
      "INVALID_MODEL_ORGANIZATION",
    );
  });

  it("never reuses an old model-contract cache or calls the provider after its ledger mismatch", async () => {
    const oldFingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          "organization-v1",
          config.baseUrl,
          config.model,
          config.jsonMode,
          organizationContextKey(workspace, input()),
        ]),
      )
      .digest("hex");
    const cached = cachedResult();
    mock.reserveRequest.mockImplementation(async (_store, _owner, _request, fingerprint) => {
      if (fingerprint === oldFingerprint) return { kind: "cached", result: cached };
      throw new ApiError(409, "REQUEST_CHANGED", "资料或请求内容已改变，请重新发起模型请求。");
    });
    await expectError(await POST(request()), 409, "REQUEST_CHANGED");
    expect(mock.reserveRequest).toHaveBeenCalledOnce();
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });

  it("generates separate knowledge topic drafts covering both selected sources", async () => {
    const response = await POST(request(knowledge()));
    expect(response.status).toBe(200);
    const result = (await response.json()) as OrganizationResult;
    if (result.kind !== "knowledge") throw new Error("Expected knowledge");
    expect(result.pages).toHaveLength(2);
    expect(new Set(organizationCitations(result).map((citation) => citation.sourceId)).size).toBe(
      2,
    );
    const messages = mock.callModel.mock.calls[0][1] as ModelMessage[];
    const prompt = JSON.parse(messages[1].content) as EvidencePrompt;
    expect(new Set(prompt.evidence.map((citation) => citation.sourceId)).size).toBe(2);
  });

  it.each([null, "owner-b"])(
    "rejects a missing or changed login %s before workspace access",
    async (user) => {
      currentUser = user;
      const response = await POST(request());
      expect(response.status).toBe(user ? 409 : 401);
      expect(mock.from).not.toHaveBeenCalled();
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );

  it("checks the account header against the authenticated owner", async () => {
    await expectError(await POST(request({}, undefined, "other-owner")), 409, "SESSION_CHANGED");
    expect(mock.from).not.toHaveBeenCalled();
  });

  it("reports missing model setup instead of fabricating extracted organization", async () => {
    mock.readModelConfig.mockReturnValue(null);
    await expectError(await POST(request()), 503, "MODEL_NOT_CONFIGURED");
    expect(mock.reserveRequest).not.toHaveBeenCalled();
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it.each(["global", "source", "automatic"])(
    "does not disclose evidence when %s AI permission is off",
    async (kind) => {
      if (kind === "global") workspace.aiEnabled = false;
      else if (kind === "source") workspace.sources[0].aiAllowed = false;
      else workspace.autoOrganize = false;
      expect(
        (await POST(request({ trigger: kind === "automatic" ? "automatic" : "manual" }))).status,
      ).toBe(403);
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );

  it("permits a manual analysis with automatic organization disabled", async () => {
    workspace.autoOrganize = false;
    expect((await POST(request())).status).toBe(200);
  });

  it("rejects a disabled source in a multiple-source selection without shrinking it", async () => {
    workspace.sources[1].aiAllowed = false;
    await expectError(await POST(request(knowledge())), 403, "SOURCE_AI_DISABLED");
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it.each(["deleted", "wrong-space", "missing", "archived"])(
    "rejects %s selected evidence",
    async (condition) => {
      const value = input();
      if (condition === "deleted") workspace.sources[0].deletedAt = new Date().toISOString();
      else if (condition === "wrong-space") workspace.sources[0].spaceIds = ["another-space"];
      else if (condition === "missing") workspace.sources = workspace.sources.slice(1);
      else workspace.spaces[0].archived = true;
      await expectError(await POST(request(value)), 404, "INVALID_SCOPE");
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );

  it("binds explicit requested source versions before reserving a model request", async () => {
    const value = input();
    value.sourceVersions[0].versionId = "stale-version";
    await expectError(await POST(request(value)), 409, "SOURCE_VERSION_CHANGED");
    expect(mock.reserveRequest).not.toHaveBeenCalled();
  });

  it("keeps inbox scope limited to explicitly unassigned sources", async () => {
    await expectError(await POST(request({ spaceId: "inbox" })), 404, "INVALID_SCOPE");
    workspace.sources[0].spaceIds = [];
    expect((await POST(request({ spaceId: "inbox" }))).status).toBe(200);
  });

  it.each(["saved", "parsing", "failed", "link-only"] as const)(
    "rejects %s sources before using any fallback source",
    async (status) => {
      workspace.sources[0].status = status;
      await expectError(await POST(request()), 409, "SOURCE_NOT_READY");
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );

  it("requires every selected source to be represented in the bounded prompt", async () => {
    workspace.sources[1].chunks.forEach((chunk) => {
      chunk.versionId = "wrong-version";
    });
    await expectError(await POST(request(knowledge())), 409, "ORGANIZATION_SCOPE_TOO_LARGE");
    expect(mock.reserveRequest).not.toHaveBeenCalled();
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it.each(["too-many", "source-multiple", "duplicate", "version-map", "automatic-knowledge"])(
    "rejects invalid request combination %s",
    async (condition) => {
      const value = knowledge();
      if (condition === "too-many") {
        value.sourceIds = Array.from({ length: 11 }, (_, i) => `source-${i}`);
        value.sourceVersions = value.sourceIds.map((sourceId) => ({
          sourceId,
          versionId: "version",
        }));
      } else if (condition === "source-multiple") value.kind = "source";
      else if (condition === "duplicate") value.sourceIds[1] = value.sourceIds[0];
      else if (condition === "version-map") value.sourceVersions[1].sourceId = "not-selected";
      else value.trigger = "automatic";
      await expectError(await POST(request(value)), 400, "INVALID_ORGANIZATION");
      expect(mock.callModel).not.toHaveBeenCalled();
      expect(mock.read).not.toHaveBeenCalled();
    },
  );

  it("returns a current same-kind cached organization without another model invocation", async () => {
    const cached = cachedResult();
    mock.reserveRequest.mockResolvedValue({ kind: "cached", result: cached });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cached);
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });

  it.each([
    null,
    undefined,
    { mode: "model", content: "prior question answer", citations: [] },
    { kind: "knowledge", mode: "model", pages: [], coverage: "wrong" },
  ])(
    "does not treat invalid or cross-kind cached result as a new model request %#",
    async (cached) => {
      mock.reserveRequest.mockResolvedValue({ kind: "cached", result: cached });
      await expectError(await POST(request()), 502, "INVALID_MODEL_ORGANIZATION");
      expect(mock.callModel).not.toHaveBeenCalled();
      expect(mock.finishRequest).not.toHaveBeenCalled();
    },
  );

  it("refuses a cached quote that no longer matches its canonical evidence", async () => {
    const cached = cachedResult();
    if (cached.kind !== "source") throw new Error("Expected source");
    cached.summary.citations[0].quote = "Fabricated cache quote";
    mock.reserveRequest.mockResolvedValue({ kind: "cached", result: cached });
    await expectError(await POST(request()), 502, "INVALID_ORGANIZATION_CITATION");
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it("rechecks permission after a reservation wait before sending text to a model", async () => {
    const gate = deferred<{ kind: "reserved" }>();
    mock.reserveRequest.mockReturnValue(gate.promise);
    const pending = POST(request());
    await vi.waitFor(() => expect(mock.reserveRequest).toHaveBeenCalledOnce());
    workspace.sources[0].aiAllowed = false;
    gate.resolve({ kind: "reserved" });
    await expectError(await pending, 409, "ORGANIZATION_CONTEXT_CHANGED");
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).toHaveBeenCalledWith(
      store,
      owner,
      "organize-attempt-1",
      undefined,
      "ORGANIZATION_CONTEXT_CHANGED",
    );
  });

  it.each(["text", "version", "delete", "global", "source", "space", "archive", "automatic"])(
    "discards late generated results after a %s boundary change",
    async (change) => {
      const gate = deferred<string>();
      mock.callModel.mockReturnValue(gate.promise);
      const pending = POST(request({ trigger: change === "automatic" ? "automatic" : "manual" }));
      await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
      if (change === "text") workspace.sources[0].text += " changed";
      else if (change === "version") workspace.sources[0].versionId = "new-version";
      else if (change === "delete") workspace.sources[0].deletedAt = new Date().toISOString();
      else if (change === "global") workspace.aiEnabled = false;
      else if (change === "source") workspace.sources[0].aiAllowed = false;
      else if (change === "space") workspace.sources[0].spaceIds = [];
      else if (change === "archive") workspace.spaces[0].archived = true;
      else workspace.autoOrganize = false;
      gate.resolve(generatedSource());
      await expectError(await pending, 409, "ORGANIZATION_CONTEXT_CHANGED");
      expect(mock.finishRequest.mock.calls.every((args) => args[3] === undefined)).toBe(true);
    },
  );

  it("does not invalidate a manual request when only the automatic switch changes", async () => {
    const gate = deferred<string>();
    mock.callModel.mockReturnValue(gate.promise);
    const pending = POST(request());
    await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
    workspace.autoOrganize = false;
    gate.resolve(generatedSource());
    expect((await pending).status).toBe(200);
  });

  it("keeps a request current when a shared source only leaves another knowledge base", async () => {
    const removedSpaceId = "removed-space";
    workspace.spaces.push({
      ...workspace.spaces[0],
      id: removedSpaceId,
      name: "将删除的知识库",
    });
    workspace.sources[0].spaceIds.push(removedSpaceId);
    const gate = deferred<string>();
    mock.callModel.mockReturnValue(gate.promise);
    const pending = POST(request());
    await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());

    workspace = deleteLearningSpace(workspace, removedSpaceId);
    gate.resolve(generatedSource());

    expect((await pending).status).toBe(200);
  });

  it("rejects a changed account before returning a generated result", async () => {
    const gate = deferred<string>();
    mock.callModel.mockReturnValue(gate.promise);
    const pending = POST(request());
    await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
    currentUser = "owner-b";
    gate.resolve(generatedSource());
    await expectError(await pending, 409, "SESSION_CHANGED");
    expect(mock.finishRequest.mock.calls.every((args) => args[3] === undefined)).toBe(true);
  });

  it("checks the interval spent saving a result before publishing it to the browser", async () => {
    mock.finishRequest.mockImplementation(async () => {
      workspace.sources[0].aiAllowed = false;
    });
    await expectError(await POST(request()), 409, "ORGANIZATION_CONTEXT_CHANGED");
    expect(mock.finishRequest).toHaveBeenCalledOnce();
  });

  it("does not claim a saved suggestion when the shared ledger save fails", async () => {
    mock.finishRequest.mockRejectedValue(new ApiError(503, "MODEL_RESULT_NOT_SAVED", "未确认保存"));
    await expectError(await POST(request()), 503, "MODEL_RESULT_NOT_SAVED");
    expect(mock.callModel).toHaveBeenCalledOnce();
  });

  it.each(["REQUEST_RUNNING", "REQUEST_FINISHED", "AI_DAILY_LIMIT"])(
    "respects shared ledger rejection %s without calling the model",
    async (code) => {
      mock.reserveRequest.mockRejectedValue(
        new ApiError(code === "AI_DAILY_LIMIT" ? 429 : 409, code, "模型请求不可执行"),
      );
      const response = await POST(request());
      expect((await response.json()).code).toBe(code);
      expect(mock.callModel).not.toHaveBeenCalled();
      expect(mock.finishRequest).not.toHaveBeenCalled();
    },
  );

  it("passes cancellation to the model and rejects a late response", async () => {
    const controller = new AbortController();
    const gate = deferred<string>();
    mock.callModel.mockReturnValue(gate.promise);
    const pending = POST(request({}, controller.signal));
    await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
    controller.abort();
    gate.resolve(generatedSource());
    await expectError(await pending, 499, "REQUEST_CANCELLED");
    expect(mock.callModel.mock.calls[0][2].aborted).toBe(true);
    expect(mock.finishRequest.mock.calls.every((args) => args[3] === undefined)).toBe(true);
  });
});
