import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  config: vi.fn(),
  client: vi.fn(),
  user: vi.fn(),
  rpc: vi.fn(),
  load: vi.fn(),
  embeddingConfig: vi.fn(),
  reserve: vi.fn(),
  embed: vi.fn(),
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
vi.mock("./supabase/config", () => ({ getSupabaseConfig: mock.config }));
vi.mock("./supabase/server", () => ({ createClient: mock.client }));
vi.mock("./ai/embeddings", () => ({
  readEmbeddingConfig: mock.embeddingConfig,
  reserveEmbeddingUsage: mock.reserve,
  embedQuery: mock.embed,
}));

import { POST } from "@/app/api/v1/search/route";
import { chunkText } from "./import";
import { createEmptyWorkspace } from "./seed";
import { indexedCitations, indexedSourceCandidates, noteSearchCandidates } from "./server-search";
import { ApiError } from "./supabase/api";
import type { SearchCandidate, SearchRequest } from "./search-types";
import type { Note, Source, WorkspaceData } from "./types";

const owner = "owner-one";
const timestamp = "2026-09-12T00:00:00.000Z";
const fingerprint = "a".repeat(64);
const query: SearchRequest = { query: "学习率", scope: { kind: "space", spaceId: "alpha" } };
const embeddingConfig = {
  baseUrl: "https://embedding.example/v1",
  apiKey: "private-key",
  model: "model",
  fingerprint,
};
const vector = [1, ...Array<number>(1535).fill(0)];
let data: WorkspaceData;
let revision: number;
const select = vi.fn();
const eq = vi.fn();
const from = vi.fn();
const client = { rpc: mock.rpc, from, auth: { getUser: mock.user } };
function source(id: string, overrides: Partial<Source> = {}): Source {
  const text = `学习率是参数更新的步长。${id} 的私密原文不可回传在普通搜索 API 正文中。`;
  return {
    id,
    versionId: `${id}-current`,
    title: `${id}-私密标题`,
    filename: `${id}.txt`,
    kind: "text",
    mime: "text/plain",
    size: text.length,
    hash: "a".repeat(64),
    spaceIds: ["alpha"],
    tags: ["优化"],
    status: "ready",
    text,
    chunks: chunkText(text, id, `${id}-current`),
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    ...overrides,
  };
}
function note(id: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    spaceId: "alpha",
    title: id,
    content: "<p>学习率是我希望进一步研究的问题。</p>",
    kind: "note",
    status: "accepted",
    citations: [],
    contentRevision: 2,
    versions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    ...overrides,
  };
}
function row(item = data.sources[0], overrides: Record<string, unknown> = {}) {
  return {
    source_id: item.id,
    version_id: item.versionId,
    chunk_id: item.chunks[0]?.id ?? null,
    score: 1,
    workspace_revision: revision,
    // SQL text/title are untrusted transport fields, intentionally different from the snapshot.
    title: "UNTRUSTED_RPC_TITLE",
    text: "UNTRUSTED_RPC_TEXT",
    ...overrides,
  };
}
function candidate(item = data.sources[0]): Extract<SearchCandidate, { kind: "source" }> {
  return {
    kind: "source",
    objectId: item.id,
    versionId: item.versionId,
    blockId: item.chunks[0].id,
    score: 1,
  };
}
const semanticOptions = (assertCurrent = vi.fn().mockResolvedValue(undefined)) => ({
  mode: "semantic" as const,
  ownerId: owner,
  assertCurrent,
});
function searchRequest(
  input: unknown = { request: query },
  options: { headers?: HeadersInit; signal?: AbortSignal; body?: string } = {},
) {
  const headers = new Headers({ "Content-Type": "application/json", "X-Conuo-User": owner });
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  return new Request("http://localhost:3000/api/v1/search", {
    method: "POST",
    headers,
    body: options.body ?? JSON.stringify(input),
    signal: options.signal,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  revision = 12;
  data = createEmptyWorkspace();
  data.spaces = ["alpha", "beta"].map((id) => ({
    id,
    name: id,
    goal: "",
    color: "#7865cf",
    archived: false,
    createdAt: timestamp,
  }));
  data.sources = [
    source("one"),
    source("two", { spaceIds: ["beta"] }),
    source("inbox", { spaceIds: [] }),
  ];
  data.semanticSearch = true;
  mock.config.mockReturnValue({ url: "https://db.example", key: "public-key" });
  mock.client.mockResolvedValue({ ...client, rpc: rpcWithAccountAccess });
  mock.user.mockResolvedValue({ data: { user: { id: owner } }, error: null });
  from.mockReturnValue({ select });
  select.mockReturnValue({ eq });
  eq.mockReturnValue({ maybeSingle: mock.load });
  mock.load.mockImplementation(async () => ({
    data: { data: structuredClone(data), revision },
    error: null,
  }));
  mock.embeddingConfig.mockReturnValue(embeddingConfig);
  mock.reserve.mockResolvedValue(undefined);
  mock.embed.mockResolvedValue(vector);
  mock.rpc.mockImplementation(async (name) => ({
    data:
      name === "embedding_job_status"
        ? {
            jobs: [
              {
                sourceId: "one",
                versionId: "one-current",
                state: "succeeded",
                profileFingerprint: fingerprint,
              },
            ],
          }
        : [row()],
    error: null,
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe("indexed source selection before SQL top-K", () => {
  it("applies scope, file type, all tags, and both time windows before candidate retrieval", async () => {
    const eligible = data.sources[0];
    data.sources.push(
      source("wrong-type", { kind: "markdown", mime: "text/markdown" }),
      source("wrong-tag", { tags: ["其他"] }),
      source("old", { createdAt: "2020-01-01T00:00:00.000Z" }),
      source("future", { updatedAt: "2027-01-01T00:00:00.000Z" }),
      source("deleted", { deletedAt: timestamp }),
    );
    const request: SearchRequest = {
      ...query,
      filters: {
        types: ["text"],
        tags: ["优化"],
        created: { from: "2026-01-01T00:00:00.000Z" },
        updated: { to: "2027-01-01T00:00:00.000Z" },
      },
    };
    await indexedSourceCandidates(client as never, data, revision, request);
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("search_source_chunks", {
      p_source_ids: [eligible.id],
      p_space_id: "alpha",
      p_limit: 100,
      p_query: "学习率",
      p_for_ai: false,
    });
  });

  it.each([false, true])(
    "never passes an empty IDs array as implicit all-sources (AI=%s)",
    async (forAI) => {
      const result = await indexedSourceCandidates(
        client as never,
        data,
        revision,
        { ...query, filters: { tags: ["missing"] } },
        forAI,
      );
      expect(result).toEqual([]);
      expect(mock.rpc).not.toHaveBeenCalled();
    },
  );

  it("keeps ordinary search available when workspace and source AI consent are off", async () => {
    data.aiEnabled = false;
    data.sources[0].aiAllowed = false;
    const result = await indexedSourceCandidates(client as never, data, revision, query);
    expect(result).toEqual([candidate()]);
    expect(mock.rpc.mock.calls[0][1]).toMatchObject({ p_for_ai: false, p_source_ids: ["one"] });
    expect(mock.reserve).not.toHaveBeenCalled();
    expect(mock.embed).not.toHaveBeenCalled();
  });

  it("filters AI-ineligible and unparsed sources before the AI candidate limit", async () => {
    data.sources.push(
      source("off", { aiAllowed: false }),
      source("failed", { status: "failed", chunks: [], text: "" }),
    );
    await indexedSourceCandidates(client as never, data, revision, query, true);
    expect(mock.rpc.mock.calls[0][1]).toMatchObject({ p_for_ai: true, p_source_ids: ["one"] });
  });

  it.each([
    [{ kind: "inbox" }, "inbox", ["inbox"]],
    [{ kind: "all" }, "*", ["one", "two", "inbox"]],
  ] as const)("preserves explicit inbox/all scope in SQL", async (scope, sqlScope, ids) => {
    await indexedSourceCandidates(client as never, data, revision, { ...query, scope });
    expect(mock.rpc.mock.calls[0][1]).toMatchObject({ p_space_id: sqlScope, p_source_ids: ids });
  });

  it("preserves the SQL null metadata anchor without inventing a chunk", async () => {
    mock.rpc.mockResolvedValue({ data: [row(undefined, { chunk_id: null })], error: null });
    const result = await indexedSourceCandidates(client as never, data, revision, query);
    expect(result[0]).toMatchObject({ blockId: null, versionId: "one-current" });
    expect(result[0]).not.toHaveProperty("text");
    expect(result[0]).not.toHaveProperty("title");
  });

  it.each([
    [{ workspace_revision: 11 }, 409],
    [{ score: "not-a-number" }, 503],
    [{ chunk_id: "" }, 503],
    [{ source_id: "../outside" }, 503],
  ])("rejects malformed or mismatched revision SQL rows", async (override, status) => {
    mock.rpc.mockResolvedValue({ data: [row(undefined, override)], error: null });
    await expect(
      indexedSourceCandidates(client as never, data, revision, query),
    ).rejects.toMatchObject({ status });
  });

  it("awaits the answer-only validator before accepting a newer consistent RPC snapshot", async () => {
    const validation = Promise.withResolvers<boolean>();
    const validateSnapshotRevision = vi.fn(() => validation.promise);
    mock.rpc.mockResolvedValue({
      data: [row(undefined, { workspace_revision: revision + 1 })],
      error: null,
    });
    const result = indexedSourceCandidates(client as never, data, revision, query, true, {
      ...semanticOptions(),
      mode: "keyword",
      validateSnapshotRevision,
    });
    let completed = false;
    void result.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    await vi.waitFor(() =>
      expect(validateSnapshotRevision).toHaveBeenCalledExactlyOnceWith(revision + 1),
    );
    expect(completed).toBe(false);
    validation.resolve(true);
    expect(await result).toEqual([candidate()]);
    expect(mock.reserve).not.toHaveBeenCalled();
    expect(mock.embed).not.toHaveBeenCalled();
  });

  it.each(["old", "mixed", "ordinary", "unverified"] as const)(
    "keeps %s RPC snapshots blocked despite an optional answer validator",
    async (kind) => {
      const validateSnapshotRevision = vi.fn().mockResolvedValue(kind !== "unverified");
      const rows =
        kind === "mixed"
          ? [row(), row(undefined, { workspace_revision: revision + 1 })]
          : [row(undefined, { workspace_revision: kind === "old" ? revision - 1 : revision + 1 })];
      mock.rpc.mockResolvedValue({ data: rows, error: null });
      await expect(
        indexedSourceCandidates(client as never, data, revision, query, kind !== "ordinary", {
          ...semanticOptions(),
          mode: "keyword",
          validateSnapshotRevision,
        }),
      ).rejects.toMatchObject({ status: 409, code: "SEARCH_CONTEXT_CHANGED" });
      expect(validateSnapshotRevision).toHaveBeenCalledTimes(kind === "unverified" ? 1 : 0);
      expect(mock.reserve).not.toHaveBeenCalled();
      expect(mock.embed).not.toHaveBeenCalled();
    },
  );

  it.each(["source", "version", "chunk"] as const)(
    "rejects a newer answer RPC snapshot with an unverified %s identity",
    async (kind) => {
      const validateSnapshotRevision = vi.fn().mockResolvedValue(true);
      mock.rpc.mockResolvedValue({
        data: [
          row(undefined, {
            workspace_revision: revision + 1,
            ...(kind === "source" ? { source_id: "outside-selected-range" } : {}),
            ...(kind === "version" ? { version_id: "previous-source-version" } : {}),
            ...(kind === "chunk" ? { chunk_id: "previous-source-chunk" } : {}),
          }),
        ],
        error: null,
      });
      await expect(
        indexedSourceCandidates(client as never, data, revision, query, true, {
          ...semanticOptions(),
          mode: "keyword",
          validateSnapshotRevision,
        }),
      ).rejects.toMatchObject({ status: 409, code: "SEARCH_CONTEXT_CHANGED" });
      expect(validateSnapshotRevision).toHaveBeenCalledExactlyOnceWith(revision + 1);
      expect(mock.reserve).not.toHaveBeenCalled();
      expect(mock.embed).not.toHaveBeenCalled();
    },
  );
});

describe("semantic query disclosure and freshness", () => {
  it.each([false, true])(
    "rejects all-library semantic scope before RPC, including empty source sets (%s)",
    async (empty) => {
      if (empty) data.sources = [];
      await expect(
        indexedSourceCandidates(
          client as never,
          data,
          revision,
          { ...query, scope: { kind: "all" } },
          true,
          semanticOptions(),
        ),
      ).rejects.toMatchObject({ status: 400, code: "SEMANTIC_SCOPE_REQUIRED" });
      expect(mock.rpc).not.toHaveBeenCalled();
      expect(mock.embed).not.toHaveBeenCalled();
    },
  );

  it.each(["aiEnabled", "semanticSearch"] as const)(
    "requires %s before even checking the index",
    async (setting) => {
      data[setting] = false;
      await expect(
        indexedSourceCandidates(client as never, data, revision, query, true, semanticOptions()),
      ).rejects.toMatchObject({ status: 403, code: "SEMANTIC_DISABLED" });
      expect(mock.rpc).not.toHaveBeenCalled();
      expect(mock.embed).not.toHaveBeenCalled();
    },
  );

  it.each([
    { jobs: [], status: 409, code: "SEMANTIC_NOT_READY" },
    {
      jobs: [
        {
          sourceId: "one",
          versionId: "one-current",
          state: "queued",
          profileFingerprint: fingerprint,
        },
      ],
      status: 409,
      code: "SEMANTIC_NOT_READY",
    },
    {
      jobs: [
        {
          sourceId: "one",
          versionId: "one-historical",
          state: "succeeded",
          profileFingerprint: fingerprint,
        },
      ],
      status: 409,
      code: "SEMANTIC_NOT_READY",
    },
    {
      jobs: [
        {
          sourceId: "two",
          versionId: "two-current",
          state: "succeeded",
          profileFingerprint: fingerprint,
        },
      ],
      status: 409,
      code: "SEMANTIC_NOT_READY",
    },
    {
      jobs: [
        {
          sourceId: "one",
          versionId: "one-current",
          state: "succeeded",
          profileFingerprint: "b".repeat(64),
        },
      ],
      status: 409,
      code: "EMBEDDING_PROFILE_CHANGED",
    },
    {
      jobs: [{ sourceId: "one", versionId: "one-current", state: "succeeded" }],
      status: 503,
      code: "INVALID_INDEXING_STATUS",
    },
  ])(
    "requires a current in-scope published job for this exact provider profile",
    async ({ jobs, status, code }) => {
      mock.rpc.mockImplementation(async (name) => ({
        data: name === "embedding_job_status" ? { jobs } : [row()],
        error: null,
      }));
      await expect(
        indexedSourceCandidates(client as never, data, revision, query, true, semanticOptions()),
      ).rejects.toMatchObject({ status, code });
      expect(mock.reserve).not.toHaveBeenCalled();
      expect(mock.embed).not.toHaveBeenCalled();
    },
  );

  it("does not invoke the provider when quota admission fails", async () => {
    mock.reserve.mockRejectedValue(new ApiError(429, "EMBEDDING_DAILY_LIMIT", "额度已满"));
    await expect(
      indexedSourceCandidates(client as never, data, revision, query, true, semanticOptions()),
    ).rejects.toMatchObject({ status: 429 });
    expect(mock.embed).not.toHaveBeenCalled();
    expect(mock.rpc.mock.calls.map((call) => call[0])).toEqual([
      "search_source_chunks",
      "embedding_job_status",
    ]);
  });

  it("revalidates the account/source revision after quota admission before provider disclosure", async () => {
    const assertCurrent = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "SEARCH_CONTEXT_CHANGED", "资料改变"));
    await expect(
      indexedSourceCandidates(
        client as never,
        data,
        revision,
        query,
        true,
        semanticOptions(assertCurrent),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(mock.reserve).toHaveBeenCalledOnce();
    expect(mock.embed).not.toHaveBeenCalled();
  });

  it("revalidates after provider completion and refuses stale ANN lookup", async () => {
    const assertCurrent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ApiError(409, "SEARCH_CONTEXT_CHANGED", "资料改变"));
    await expect(
      indexedSourceCandidates(
        client as never,
        data,
        revision,
        query,
        true,
        semanticOptions(assertCurrent),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(mock.embed).toHaveBeenCalledOnce();
    expect(mock.rpc.mock.calls.map((call) => call[0])).not.toContain("semantic_source_chunks");
  });

  it("uses the same filtered IDs for lexical/status/ANN and fuses duplicate canonical chunks", async () => {
    const order: string[] = [];
    const assertCurrent = vi.fn(async () => {
      order.push("current");
    });
    mock.reserve.mockImplementation(async () => {
      order.push("budget");
    });
    mock.embed.mockImplementation(async () => {
      order.push("provider");
      return vector;
    });
    const result = await indexedSourceCandidates(
      client as never,
      data,
      revision,
      { ...query, query: "学习率😀" },
      true,
      semanticOptions(assertCurrent),
    );
    expect(order).toEqual(["budget", "current", "provider", "current"]);
    expect(mock.reserve).toHaveBeenCalledWith(owner, 4);
    expect(mock.embed).toHaveBeenCalledWith(embeddingConfig, "学习率😀", undefined);
    expect(mock.rpc).toHaveBeenCalledWith("embedding_job_status", { p_source_ids: ["one"] });
    expect(mock.rpc).toHaveBeenCalledWith("semantic_source_chunks", {
      p_space_id: "alpha",
      p_source_ids: ["one"],
      p_limit: 100,
      p_query_embedding: vector,
      p_profile_fingerprint: fingerprint,
    });
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeCloseTo(2 / 61);
    expect(result[0]).not.toHaveProperty("text");
  });
});

describe("ordinary search HTTP boundary (mock Supabase transport only)", () => {
  it.each(["unconfigured", "signed-out", "wrong-account"])(
    "refuses %s before database retrieval",
    async (state) => {
      if (state === "unconfigured") mock.config.mockReturnValue(null);
      if (state === "signed-out")
        mock.user.mockResolvedValue({ data: { user: null }, error: null });
      const req = searchRequest(undefined, {
        headers: { "X-Conuo-User": state === "wrong-account" ? "other" : owner },
      });
      const res = await POST(req);
      expect(res.status).toBe(state === "unconfigured" ? 503 : state === "signed-out" ? 401 : 409);
      expect(mock.load).not.toHaveBeenCalled();
      expect(mock.rpc).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { request: { ...query, query: "  " } },
    { request: { ...query, query: "x".repeat(4001) } },
    { request: { ...query, scope: undefined } },
    { request: query, ownerId: "other" },
  ])("rejects an invalid search envelope before loading any workspace", async (input) => {
    const res = await POST(searchRequest(input));
    expect(res.status).toBe(400);
    expect(mock.load).not.toHaveBeenCalled();
  });

  it.each([
    [{ Origin: "https://other.example" }, "{}", 403],
    [{ "Content-Type": "text/plain" }, "{}", 415],
    [{ "Content-Length": "20001" }, "{}", 413],
    [{}, "{", 400],
  ] as const)(
    "rejects cross-site or invalid transport without RPC",
    async (headers, body, status) => {
      const res = await POST(searchRequest(null, { headers, body }));
      expect(res.status).toBe(status);
      expect(mock.rpc).not.toHaveBeenCalled();
    },
  );

  it("returns only version-bound IDs while AI-disabled ordinary data remains searchable", async () => {
    data.aiEnabled = false;
    data.sources[0].aiAllowed = false;
    data.notes = [
      note("personal"),
      note("accepted-ai", { kind: "knowledge", aiGenerated: true }),
      note("draft", { status: "draft", aiGenerated: true }),
    ];
    const res = await POST(searchRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ mode: "keyword", revision: 12 });
    expect(body.candidates.map((hit: SearchCandidate) => [hit.objectId, hit.kind])).toEqual([
      ["one", "source"],
      ["accepted-ai", "knowledge"],
      ["personal", "note"],
    ]);
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("私密");
    expect(encoded).not.toContain("UNTRUSTED_RPC");
    expect(encoded).not.toContain("学习率是我");
    expect(mock.embed).not.toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith("owner_id", owner);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it.each(["workspace", "account"])(
    "rejects a changed %s before returning candidates",
    async (changed) => {
      if (changed === "workspace")
        mock.load
          .mockImplementationOnce(async () => ({
            data: { data: structuredClone(data), revision },
            error: null,
          }))
          .mockImplementationOnce(async () => ({
            data: { data: structuredClone(data), revision: revision + 1 },
            error: null,
          }));
      else
        mock.user
          .mockResolvedValueOnce({ data: { user: { id: owner } }, error: null })
          .mockResolvedValueOnce({ data: { user: { id: "other" } }, error: null });
      const res = await POST(searchRequest());
      expect(res.status).toBe(409);
      expect(await res.text()).not.toContain("candidates");
    },
  );

  it.each([
    { version_id: "one-historical" },
    { chunk_id: "invented-chunk" },
    { source_id: "two", version_id: "two-current" },
  ])("rechecks returned IDs against the current canonical snapshot and scope", async (override) => {
    mock.rpc.mockResolvedValue({ data: [row(undefined, override)], error: null });
    const res = await POST(searchRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SEARCH_CONTEXT_CHANGED");
  });

  it.each(["initial", "rpc", "final-load"])("honors cancellation during %s", async (stage) => {
    const controller = new AbortController();
    if (stage === "initial") controller.abort();
    if (stage === "rpc")
      mock.rpc.mockImplementation(async () => {
        controller.abort();
        return { data: [row()], error: null };
      });
    if (stage === "final-load")
      mock.load
        .mockImplementationOnce(async () => ({
          data: { data: structuredClone(data), revision },
          error: null,
        }))
        .mockImplementationOnce(async () => {
          controller.abort();
          return { data: { data: structuredClone(data), revision }, error: null };
        });
    const res = await POST(searchRequest(undefined, { signal: controller.signal }));
    expect(res.status).toBe(499);
    expect(await res.text()).not.toContain("candidates");
  });

  it("does not turn an empty filtered selection into a whole-library RPC", async () => {
    const res = await POST(searchRequest({ request: { ...query, filters: { tags: ["absent"] } } }));
    expect(res.status).toBe(200);
    expect((await res.json()).candidates).toEqual([]);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
});

describe("candidate provenance at the answer boundary", () => {
  it("keeps accepted AI knowledge and user notes typed, excluding drafts by default", () => {
    data.notes = [
      note("user"),
      note("ai", { kind: "knowledge", aiGenerated: true }),
      note("draft", { status: "draft" }),
    ];
    const hits = noteSearchCandidates(data, query);
    expect(hits.map((hit) => hit.kind).sort()).toEqual(["knowledge", "note"]);
    for (const hit of hits) {
      expect(hit).not.toHaveProperty("sourceId");
      expect(hit).not.toHaveProperty("quote");
      expect(hit).toHaveProperty("revision", 2);
      expect(hit).toHaveProperty("updatedAt", timestamp);
    }
  });

  it("only turns current canonical source chunks into model evidence", () => {
    const current = candidate();
    const foreign = candidate(data.sources[1]);
    const personal: SearchCandidate = {
      kind: "knowledge",
      objectId: "accepted-ai",
      revision: 2,
      updatedAt: timestamp,
      blockId: "b1",
      score: 100,
    };
    const hits: SearchCandidate[] = [
      current,
      current,
      foreign,
      personal,
      { ...current, kind: "source", versionId: "one-historical" },
      { ...current, kind: "source", blockId: "invented" },
      { ...current, kind: "source", blockId: null },
    ];
    const result = indexedCitations(
      data,
      { question: "学习率", scope: "space", spaceId: "alpha", sourceIds: [] },
      hits,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sourceId: "one",
      versionId: "one-current",
      quote: data.sources[0].chunks[0].text,
    });
    data.sources[0].aiAllowed = false;
    expect(
      indexedCitations(
        data,
        { question: "学习率", scope: "space", spaceId: "alpha", sourceIds: [] },
        hits,
      ),
    ).toEqual([]);
  });
});
