import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  client: vi.fn(),
  user: vi.fn(),
  rpc: vi.fn(),
  load: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
}));
vi.mock("./supabase/config", () => ({ getSupabaseConfig: mocks.config }));
vi.mock("./supabase/server", () => ({ createClient: mocks.client }));

import { POST } from "@/app/api/v1/search/route";
import { chunkText } from "./import";
import { createEmptyWorkspace } from "./seed";
import {
  materializeSearchCandidates,
  searchItemEligible,
  searchWorkspace,
  SearchBoundaryError,
} from "./search";
import { noteSearchCandidates, indexedSourceCandidates } from "./server-search";
import { searchRequestSchema } from "./search-types";
import { workspaceSchema } from "./supabase/validation";
import type { SearchCandidate, SearchRequest } from "./search-types";
import type { Note, Source, WorkspaceData } from "./types";

const owner = "derived-search-owner";
const range = { from: "2026-09-14T16:00:00.000Z", to: "2026-09-15T16:00:00.000Z" };
const updatedAt = "2026-09-15T18:00:00.000Z";
const access = {
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
let data: WorkspaceData;
let revision: number;

function note(id: string, createdAt: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    spaceId: "alpha",
    title: id,
    content: "<p>学习率 PRIVATE_NOTE_BODY。</p>",
    kind: "note",
    status: "accepted",
    aiGenerated: false,
    citations: [],
    contentRevision: 4,
    versions: [],
    createdAt,
    updatedAt,
    deletedAt: null,
    ...overrides,
  };
}
function source(id: string, createdAt = range.from): Source {
  const text = "学习率 PRIVATE_SOURCE_BODY。";
  return {
    id,
    versionId: `${id}-v1`,
    title: id,
    filename: `${id}.txt`,
    kind: "text",
    mime: "text/plain",
    size: new TextEncoder().encode(text).byteLength,
    hash: "a".repeat(64),
    spaceIds: ["alpha"],
    tags: ["优化"],
    status: "ready",
    text,
    chunks: chunkText(text, id, `${id}-v1`),
    createdAt,
    updatedAt,
    deletedAt: null,
    aiAllowed: false,
    starred: true,
  };
}
function fixture(window = range) {
  const start = Date.parse(window.from),
    end = Date.parse(window.to);
  const workspace = createEmptyWorkspace();
  workspace.aiEnabled = false;
  workspace.spaces = [
    {
      id: "alpha",
      name: "搜索库",
      goal: "",
      color: "blue",
      archived: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  workspace.sources = [source("source-one", new Date(start + 1).toISOString())];
  workspace.notes = [
    note("note-at-start", new Date(start).toISOString()),
    note("knowledge-inside", new Date(start + 1).toISOString(), {
      kind: "knowledge",
      aiGenerated: true,
    }),
    note("note-before", new Date(start - 1).toISOString()),
    note("knowledge-at-end", new Date(end).toISOString(), { kind: "knowledge" }),
    note("note-draft", new Date(start + 1).toISOString(), { status: "draft" }),
    note("knowledge-draft", new Date(start + 1).toISOString(), {
      kind: "knowledge",
      status: "draft",
      aiGenerated: true,
    }),
  ];
  const item = workspace.sources[0];
  const chunk = item.chunks[0];
  workspace.notes[1].citations = [
    {
      sourceId: item.id,
      versionId: item.versionId,
      chunkId: chunk.id,
      title: item.title,
      quote: chunk.text,
      section: chunk.section,
    },
  ];
  expect(workspaceSchema.safeParse(workspace).success).toBe(true);
  return workspace;
}
const request = (filters: SearchRequest["filters"] = {}): SearchRequest => ({
  query: "学习率",
  scope: { kind: "space", spaceId: "alpha" },
  filters,
});
const derivedRequest = (created = range) => request({ types: ["note", "knowledge"], created });
const identities = (items: { objectId: string }[]) => items.map((item) => item.objectId).sort();
function candidateRow(item: Source, score = 1) {
  return {
    source_id: item.id,
    version_id: item.versionId,
    chunk_id: item.chunks[0].id,
    score,
    workspace_revision: revision,
    title: "UNTRUSTED_DATABASE_TITLE",
    text: "UNTRUSTED_DATABASE_BODY",
  };
}
async function post(input: SearchRequest, payload: Record<string, unknown> = {}) {
  const response = await POST(
    new Request("http://localhost:3000/api/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Conuo-User": owner },
      body: JSON.stringify({ request: input, ...payload }),
    }),
  );
  return { response, body: await response.json() };
}

beforeEach(() => {
  vi.resetAllMocks();
  data = fixture();
  revision = 12;
  const client = { rpc: mocks.rpc, from: mocks.from, auth: { getUser: mocks.user } };
  mocks.config.mockReturnValue({ url: "https://search.example", key: "public-key" });
  mocks.client.mockResolvedValue(client);
  mocks.user.mockResolvedValue({ data: { user: { id: owner } }, error: null });
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockReturnValue({ maybeSingle: mocks.load });
  mocks.load.mockImplementation(async () => ({
    data: { data: structuredClone(data), revision },
    error: null,
  }));
  mocks.rpc.mockImplementation(async (name, args) => {
    if (name === "account_deletion_access_status") return { data: access, error: null };
    if (name !== "search_source_chunks") throw new Error("Unexpected provider/index call");
    return {
      data: data.sources
        .filter((item) => args.p_source_ids.includes(item.id))
        .map((item) => candidateRow(item)),
      error: null,
    };
  });
});

describe("derived ordinary search types and time filters", () => {
  it("searches saved notes and accepted AI knowledge with global/source AI disabled", () => {
    const input = request({ types: ["note", "knowledge"] });
    const local = searchWorkspace(data, input);
    expect(identities(local.hits)).toEqual([
      "knowledge-at-end",
      "knowledge-inside",
      "note-at-start",
      "note-before",
    ]);
    expect(local.hits.find((hit) => hit.objectId === "knowledge-inside")?.provenance).toMatchObject(
      { origin: "ai", aiRestrictedCount: 1 },
    );
    const server = noteSearchCandidates(data, input);
    expect(identities(server)).toEqual(identities(local.hits));
    expect(identities(materializeSearchCandidates(data, input, server).hits)).toEqual(
      identities(local.hits),
    );
  });

  it.each([
    ["China local day", range],
    [
      "Pacific daylight-saving 23-hour day",
      { from: "2026-03-08T08:00:00.000Z", to: "2026-03-09T07:00:00.000Z" },
    ],
    [
      "Pacific daylight-saving 25-hour day",
      { from: "2026-11-01T07:00:00.000Z", to: "2026-11-02T08:00:00.000Z" },
    ],
  ])("uses start-inclusive/end-exclusive ISO instants for %s", (_, window) => {
    const workspace = fixture(window),
      input = derivedRequest(window);
    const expected = ["knowledge-inside", "note-at-start"];
    expect(identities(searchWorkspace(workspace, input).hits)).toEqual(expected);
    expect(identities(noteSearchCandidates(workspace, input))).toEqual(expected);
    expect(searchItemEligible(workspace.notes[0], input)).toBe(true);
    expect(searchItemEligible(workspace.notes[3], input)).toBe(false);
    expect(searchItemEligible(workspace.notes[2], input)).toBe(false);
  });

  it("treats offset ISO timestamps as the same instants without substituting update dates", () => {
    const input = derivedRequest({
      from: "2026-09-15T00:00:00+08:00",
      to: "2026-09-16T00:00:00+08:00",
    });
    expect(identities(searchWorkspace(data, input).hits)).toEqual([
      "knowledge-inside",
      "note-at-start",
    ]);
    expect(identities(noteSearchCandidates(data, input))).toEqual([
      "knowledge-inside",
      "note-at-start",
    ]);
    const createdAndUpdated = { ...input, filters: { ...input.filters, updated: range } };
    expect(searchWorkspace(data, createdAndUpdated).hits).toEqual([]);
    expect(noteSearchCandidates(data, createdAndUpdated)).toEqual([]);
  });

  it.each(["note", "knowledge"] as const)("applies exact %s type before date matching", (type) => {
    const input = request({ types: [type], created: range });
    const expected = type === "note" ? ["note-at-start"] : ["knowledge-inside"];
    expect(identities(searchWorkspace(data, input).hits)).toEqual(expected);
    expect(identities(noteSearchCandidates(data, input))).toEqual(expected);
  });

  it("excludes both draft kinds by default and includes them only with explicit opt-in", () => {
    const input = { ...derivedRequest(), includeDrafts: true };
    const expected = ["knowledge-draft", "knowledge-inside", "note-at-start", "note-draft"];
    expect(identities(searchWorkspace(data, input).hits)).toEqual(expected);
    expect(identities(noteSearchCandidates(data, input))).toEqual(expected);
  });

  it("does not inherit source tags, stars or file kinds onto cited notes/knowledge", () => {
    const input = request({ tags: ["优化"], created: range });
    expect(identities(searchWorkspace(data, input).hits)).toEqual(["source-one"]);
    expect(noteSearchCandidates(data, input)).toEqual([]);
    expect(
      searchWorkspace(
        data,
        request({ types: ["pdf", "docx", "markdown", "text", "web"] }),
      ).hits.every((hit) => hit.kind === "source"),
    ).toBe(true);
    expect(searchWorkspace(data, derivedRequest()).hits.every((hit) => hit.tags.length === 0)).toBe(
      true,
    );
    expect(
      searchRequestSchema.safeParse({ ...input, filters: { ...input.filters, starred: true } })
        .success,
    ).toBe(true);
  });

  it.each([
    { revision: 3 },
    { updatedAt: "2026-09-15T17:00:00.000Z" },
    { kind: "knowledge" as const },
  ])("rejects stale or wrong derived identity during browser materialization: %j", (patch) => {
    const input = derivedRequest(),
      candidates = noteSearchCandidates(data, input);
    const original = candidates.find((item) => item.objectId === "note-at-start")!;
    expect(() =>
      materializeSearchCandidates(data, { ...input, limit: 1 }, [
        candidates.find((item) => item.objectId === "knowledge-inside"),
        { ...original, ...patch, score: 0 },
      ]),
    ).toThrow(SearchBoundaryError);
  });

  it("rejects previously generated candidates after the creation date moves outside the filter", () => {
    const input = derivedRequest(),
      candidates = noteSearchCandidates(data, input);
    data.notes[0].createdAt = range.to;
    expect(() => materializeSearchCandidates(data, input, candidates)).toThrow(SearchBoundaryError);
  });
});

describe("authenticated server candidates for derived filtered search", () => {
  it("uses the authenticated snapshot for note-only search without a source-index RPC", async () => {
    const input = derivedRequest();
    const { response, body } = await post(input);
    expect(response.status).toBe(200);
    expect(identities(body.candidates)).toEqual(["knowledge-inside", "note-at-start"]);
    expect(body.revision).toBe(revision);
    expect(mocks.rpc.mock.calls.every(([name]) => name === "account_deletion_access_status")).toBe(
      true,
    );
    expect(mocks.eq.mock.calls).toEqual([
      ["owner_id", owner],
      ["owner_id", owner],
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /PRIVATE_NOTE_BODY|PRIVATE_SOURCE_BODY|citations|snippet|title/,
    );
    expect(identities(materializeSearchCandidates(data, input, body.candidates).hits)).toEqual([
      "knowledge-inside",
      "note-at-start",
    ]);
  });

  it("keeps derived candidates in the merged server window even when source top-K is full", async () => {
    data.sources = Array.from({ length: 100 }, (_, index) => source(`source-${index}`));
    const input = { ...request({ created: range }), limit: 1 };
    const { response, body } = await post(input);
    expect(response.status).toBe(200);
    expect(body.candidates).toHaveLength(102);
    expect(body.candidates.filter((item: SearchCandidate) => item.kind !== "source")).toHaveLength(
      2,
    );
    const call = mocks.rpc.mock.calls.find(([name]) => name === "search_source_chunks")!;
    expect(call[1].p_limit).toBe(100);
    expect(call[1].p_for_ai).toBe(false);
    const merged = materializeSearchCandidates(data, input, body.candidates);
    expect(merged.hits[0].kind).not.toBe("source");
    expect(merged.hasMore).toBe(true);
  });

  it("applies tag/file restrictions before RPC and never adds synthetic derived candidates", async () => {
    const input = request({ tags: ["优化"], types: ["text", "note", "knowledge"], created: range });
    const { response, body } = await post(input);
    expect(response.status).toBe(200);
    expect(identities(body.candidates)).toEqual(["source-one"]);
    expect(body.candidates[0].kind).toBe("source");
    const client = await mocks.client();
    expect(await indexedSourceCandidates(client, data, revision, derivedRequest())).toEqual([]);
  });

  it("rejects a changed authoritative revision before releasing note-only candidates", async () => {
    mocks.load.mockResolvedValueOnce({
      data: { data: structuredClone(data), revision },
      error: null,
    });
    mocks.load.mockResolvedValueOnce({
      data: { data: structuredClone(data), revision: revision + 1 },
      error: null,
    });
    const { response, body } = await post(derivedRequest());
    expect(response.status).toBe(409);
    expect(body.code).toBe("SEARCH_CONTEXT_CHANGED");
    expect(body.candidates).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("PRIVATE_NOTE_BODY");
  });

  it("rejects client-supplied note candidates instead of treating the request as authority", async () => {
    const { response, body } = await post(derivedRequest(), {
      candidates: noteSearchCandidates(data, derivedRequest()),
    });
    expect(response.status).toBe(400);
    expect(body.code).toBe("INVALID_SEARCH");
    expect(mocks.load).not.toHaveBeenCalled();
  });
});

describe("source favorite filter before local and remote candidate limits", () => {
  it("accepts optional exact booleans while retaining old requests and rejecting coercion", () => {
    const original = request({ created: range });
    expect(searchRequestSchema.parse(original)).toEqual(original);
    for (const starred of [true, false])
      expect(
        searchRequestSchema.safeParse({ ...original, filters: { ...original.filters, starred } })
          .success,
      ).toBe(true);
    for (const starred of ["true", "false", 0, 1, null])
      expect(
        searchRequestSchema.safeParse({ ...original, filters: { ...original.filters, starred } })
          .success,
      ).toBe(false);
  });

  it.each([true, false])("matches starred=%s exactly and excludes all derived kinds", (starred) => {
    const favorite = source("favorite");
    const ordinary = { ...source("ordinary"), starred: false };
    data.sources = [favorite, ordinary];
    const input = {
      ...request({ created: range }),
      includeDrafts: true,
      filters: { created: range, starred },
    };
    const expected = starred ? [favorite.id] : [ordinary.id];
    expect(identities(searchWorkspace(data, input).hits)).toEqual(expected);
    expect(noteSearchCandidates(data, input)).toEqual([]);
    expect(data.notes.every((item) => !searchItemEligible(item, input))).toBe(true);
    expect(searchItemEligible(favorite, input)).toBe(starred);
    expect(searchItemEligible(ordinary, input)).toBe(!starred);
    const noFilter = searchWorkspace(data, { ...input, filters: { created: range } });
    expect(noFilter.hits.some((hit) => hit.kind === "note")).toBe(true);
    expect(noFilter.hits.some((hit) => hit.kind === "knowledge")).toBe(true);
    expect(noFilter.hits.filter((hit) => hit.kind === "source")).toHaveLength(2);
  });

  it("retrieves a low-ranked favorite beyond 100 high-ranked nonfavorites by filtering RPC IDs first", async () => {
    const favorite = source("low-ranked-favorite");
    data.sources = [
      ...Array.from({ length: 101 }, (_, index) => ({
        ...source(`unstarred-${index}`),
        starred: false,
      })),
      favorite,
    ];
    mocks.rpc.mockImplementation(async (name, args) => {
      if (name === "account_deletion_access_status") return { data: access, error: null };
      if (name !== "search_source_chunks") throw new Error("Unexpected provider/index call");
      return {
        data: data.sources
          .filter((item) => args.p_source_ids.includes(item.id))
          .map((item) => candidateRow(item, item.starred ? 1 : 1000))
          .sort((a, b) => b.score - a.score)
          .slice(0, args.p_limit),
        error: null,
      };
    });
    const original = request({ created: range });
    const unfiltered = await post(original);
    expect(unfiltered.response.status).toBe(200);
    expect(
      unfiltered.body.candidates.filter((item: SearchCandidate) => item.kind === "source"),
    ).toHaveLength(100);
    expect(
      unfiltered.body.candidates.some((item: SearchCandidate) => item.objectId === favorite.id),
    ).toBe(false);
    const input = { ...original, filters: { ...original.filters, starred: true } };
    const filtered = await post(input);
    expect(filtered.response.status).toBe(200);
    expect(identities(filtered.body.candidates)).toEqual([favorite.id]);
    const calls = mocks.rpc.mock.calls.filter(([name]) => name === "search_source_chunks");
    expect(calls.at(-1)![1]).toMatchObject({
      p_source_ids: [favorite.id],
      p_limit: 100,
      p_for_ai: false,
    });
    expect(
      identities(materializeSearchCandidates(data, input, filtered.body.candidates).hits),
    ).toEqual([favorite.id]);
    expect(identities(searchWorkspace(data, input).hits)).toEqual([favorite.id]);
  });

  it.each([true, false])("sends only exact starred=%s source IDs to the index", async (starred) => {
    data.sources = [source("favorite"), { ...source("ordinary"), starred: false }];
    const input = { ...request({ created: range }), filters: { created: range, starred } };
    const { response, body } = await post(input);
    const expected = starred ? ["favorite"] : ["ordinary"];
    expect(response.status).toBe(200);
    expect(identities(body.candidates)).toEqual(expected);
    const call = mocks.rpc.mock.calls.find(([name]) => name === "search_source_chunks")!;
    expect(call[1].p_source_ids).toEqual(expected);
    expect(body.candidates.every((item: SearchCandidate) => item.kind === "source")).toBe(true);
  });

  it("intersects favorite scope, file type, tags and creation date before the index window", async () => {
    const eligible = source("eligible");
    data.sources = [
      eligible,
      { ...source("other-space"), spaceIds: ["beta"] },
      { ...source("wrong-type"), kind: "pdf" },
      { ...source("wrong-tag"), tags: ["其他"] },
      { ...source("too-late", range.to) },
      { ...source("nonfavorite"), starred: false },
    ];
    const input = {
      ...request({ types: ["text", "note", "knowledge"], tags: ["优化"], created: range }),
      filters: {
        types: ["text", "note", "knowledge"] as const,
        tags: ["优化"],
        created: range,
        starred: true,
      },
    };
    const parsed = searchRequestSchema.parse(input);
    const { response, body } = await post(parsed);
    expect(response.status).toBe(200);
    expect(identities(body.candidates)).toEqual([eligible.id]);
    const call = mocks.rpc.mock.calls.find(([name]) => name === "search_source_chunks")!;
    expect(call[1].p_source_ids).toEqual([eligible.id]);
    expect(identities(searchWorkspace(data, parsed).hits)).toEqual([eligible.id]);
  });

  it("rejects a previously valid favorite candidate after its favorite flag changes", () => {
    const input = { ...request(), filters: { starred: true } };
    const candidate: SearchCandidate = {
      kind: "source",
      objectId: data.sources[0].id,
      versionId: data.sources[0].versionId,
      blockId: data.sources[0].chunks[0].id,
      score: 1,
    };
    expect(materializeSearchCandidates(data, input, [candidate]).hits).toHaveLength(1);
    data.sources[0].starred = false;
    expect(() => materializeSearchCandidates(data, input, [candidate])).toThrow(
      SearchBoundaryError,
    );
  });
});
