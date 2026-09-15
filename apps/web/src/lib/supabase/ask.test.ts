import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import { extractiveCitationMarker } from "@/lib/citation-markers";
import type { AnswerRequest, WorkspaceData } from "@/lib/types";
import { retrieveEvidence } from "@/lib/retrieval";

const mock = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  read: vi.fn(),
  rpc: vi.fn(),
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
vi.mock("@/lib/ai/model", () => ({ readModelConfig: () => null, callModel: vi.fn() }));
import { POST } from "@/app/api/v1/ask/route";

let workspace: WorkspaceData;
function request(override: Partial<AnswerRequest> = {}, user = "owner-a") {
  const body: AnswerRequest = {
    question: "学习率",
    scope: "document",
    sourceId: workspace.sources[0]?.id,
    sourceIds: [],
    spaceId: "inbox",
    ...override,
  };
  const singleSourceScope =
    body.scope === "selection" || body.scope === "document" || body.scope === "document-notes";
  if (
    singleSourceScope &&
    body.sourceId &&
    !Object.prototype.hasOwnProperty.call(override, "sourceVersions")
  ) {
    body.sourceVersions = [
      {
        sourceId: body.sourceId,
        versionId:
          workspace.sources.find((source) => source.id === body.sourceId)?.versionId ??
          "requested-source-version",
      },
    ];
  }
  return new Request("http://localhost/api/v1/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Conuo-User": user },
    body: JSON.stringify(body),
  });
}

function configureCrossLibraryRange() {
  const firstSpace = workspace.spaces[0]!;
  const secondSpace = {
    ...firstSpace,
    id: "cross-library-space-two",
    name: "第二个知识库",
  };
  workspace.spaces.push(secondSpace);
  const [first, second] = workspace.sources;
  first!.spaceIds = [firstSpace.id];
  second!.spaceIds = [secondSpace.id];
  const sourceIds = [first!.id, second!.id];
  return {
    first: first!,
    second: second!,
    sourceIds,
    sourceVersions: sourceIds.map((sourceId) => {
      const source = workspace.sources.find((item) => item.id === sourceId)!;
      return { sourceId, versionId: source.versionId };
    }),
  };
}

function crossLibraryRequest(
  range: ReturnType<typeof configureCrossLibraryRange>,
  override: Partial<AnswerRequest> = {},
) {
  return request({
    question: "两份资料如何帮助理解学习率？",
    scope: "cross-library-sources",
    sourceId: undefined,
    sourceIds: range.sourceIds,
    sourceVersions: range.sourceVersions,
    spaceId: "all",
    ...override,
  });
}

describe("cloud question scope integration", () => {
  beforeEach(() => {
    Object.values(mock).forEach((fn) => fn.mockReset());
    const chain = { select: mock.select, eq: mock.eq, maybeSingle: mock.read };
    mock.from.mockReturnValue(chain);
    mock.select.mockReturnValue(chain);
    mock.eq.mockReturnValue(chain);
    mock.getUser.mockResolvedValue({ data: { user: { id: "owner-a" } }, error: null });
    workspace = createDemoWorkspace();
    workspace.sources[0].spaceIds = [];
    mock.read.mockImplementation(async () => ({
      data: { data: workspace, revision: 1 },
      error: null,
    }));
    mock.rpc.mockImplementation(async (name, args) => {
      expect(name).toBe("search_source_chunks");
      const evidence = retrieveEvidence(workspace, {
        question: args.p_query,
        scope: "sources",
        sourceIds: args.p_source_ids,
        spaceId: args.p_space_id,
      });
      return {
        data: evidence.citations.map((citation) => ({
          source_id: citation.sourceId,
          version_id: citation.versionId,
          chunk_id: citation.chunkId,
          score: 1,
          workspace_revision: 1,
        })),
        error: null,
      };
    });
  });
  it("returns real extractive evidence for an unassigned inbox document", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.mode).toBe("extractive");
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.content).toContain(`**${extractiveCitationMarker(0)}**`);
    expect(
      body.citations.every(
        (citation: { sourceId: string }) => citation.sourceId === workspace.sources[0].id,
      ),
    ).toBe(true);
    expect(mock.eq.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      mock.eq.mock.calls.every((args) => args[0] === "owner_id" && args[1] === "owner-a"),
    ).toBe(true);
  });
  it("allows an empty inbox and returns no evidence instead of treating it as a missing space", async () => {
    workspace.sources = [];
    const response = await POST(request({ scope: "space", sourceId: undefined }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "extractive", citations: [] });
  });
  it("never includes assigned documents when searching the whole inbox", async () => {
    const response = await POST(request({ scope: "space", sourceId: undefined }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.citations.length).toBeGreaterThan(0);
    expect(
      body.citations.every(
        (citation: { sourceId: string }) => citation.sourceId === workspace.sources[0].id,
      ),
    ).toBe(true);
  });
  it("rejects an ordinary selected-source request without exact versions before reading a workspace", async () => {
    const response = await POST(
      request({ scope: "sources", sourceId: undefined, sourceIds: [workspace.sources[0].id] }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_QUESTION" });
    expect(mock.read).not.toHaveBeenCalled();
  });
  it.each(["selection", "document", "document-notes"] as const)(
    "rejects a live %s request without its exact source version before reading a workspace",
    async (scope) => {
      const response = await POST(
        request({
          scope,
          sourceVersions: undefined,
          ...(scope === "selection" ? { selection: workspace.sources[0].text.slice(0, 24) } : {}),
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_QUESTION" });
      expect(mock.read).not.toHaveBeenCalled();
    },
  );
  it("rejects assigned sources explicitly passed to the inbox", async () => {
    const source = workspace.sources[1];
    const response = await POST(
      request({
        scope: "sources",
        sourceId: undefined,
        sourceIds: [source.id],
        sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "INVALID_SCOPE" });
  });
  it("does not use the inbox as a fallback for unknown or archived spaces", async () => {
    expect((await POST(request({ spaceId: "unknown-space" }))).status).toBe(404);
    workspace.spaces[0].archived = true;
    expect(
      (await POST(request({ spaceId: workspace.spaces[0].id, sourceId: workspace.sources[1].id })))
        .status,
    ).toBe(404);
  });
  it("rejects deleted and missing source selections", async () => {
    workspace.sources[0].deletedAt = new Date().toISOString();
    expect((await POST(request())).status).toBe(404);
    expect((await POST(request({ sourceId: "another-users-source" }))).status).toBe(404);
  });
  it("rejects expired sessions before reading any workspace", async () => {
    mock.getUser.mockResolvedValue({ data: { user: null }, error: { message: "expired" } });
    expect((await POST(request())).status).toBe(401);
    expect(mock.from).not.toHaveBeenCalled();
  });
  it("rejects a different account header before reading any workspace", async () => {
    const response = await POST(request({}, "owner-b"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SESSION_CHANGED" });
    expect(mock.from).not.toHaveBeenCalled();
  });

  it("uses only the explicitly selected sources across two active libraries and sends the all-scope keyword boundary", async () => {
    const range = configureCrossLibraryRange();
    mock.rpc.mockImplementationOnce(async (name, args) => {
      expect(name).toBe("search_source_chunks");
      expect(args).toMatchObject({
        p_space_id: "*",
        p_source_ids: range.sourceIds,
        p_for_ai: true,
      });
      return {
        data: [range.first, range.second].map((source) => ({
          source_id: source.id,
          version_id: source.versionId,
          // Heading-only chunks are correctly rejected by indexedCitations;
          // use a body chunk to verify the cross-library boundary itself.
          chunk_id: source.chunks.find((chunk) => chunk.text.length > 80)!.id,
          score: 1,
          workspace_revision: 1,
        })),
        error: null,
      };
    });

    const response = await POST(crossLibraryRequest(range));
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(answer.citations).toHaveLength(2);
    expect(
      answer.citations.map((citation: { sourceId: string }) => citation.sourceId).sort(),
    ).toEqual([...range.sourceIds].sort());
  });

  it.each([
    [
      "a fabricated other-account source",
      404,
      "INVALID_SCOPE",
      (range: ReturnType<typeof configureCrossLibraryRange>) => ({
        sourceIds: [range.first.id, "another-account-source"],
        sourceVersions: [
          { sourceId: range.first.id, versionId: range.first.versionId },
          { sourceId: "another-account-source", versionId: "another-account-version" },
        ],
      }),
    ],
    [
      "a recycled source",
      404,
      "INVALID_SCOPE",
      (range: ReturnType<typeof configureCrossLibraryRange>) => {
        range.second.deletedAt = new Date().toISOString();
        return {};
      },
    ],
    [
      "an AI-disabled source",
      403,
      "SOURCE_AI_DISABLED",
      (range: ReturnType<typeof configureCrossLibraryRange>) => {
        range.second.aiAllowed = false;
        return {};
      },
    ],
    [
      "an unparsed source",
      409,
      "SOURCE_NOT_READY",
      (range: ReturnType<typeof configureCrossLibraryRange>) => {
        range.first.status = "saved";
        range.first.text = "";
        range.first.chunks = [];
        return {};
      },
    ],
    [
      "a source whose only library is archived",
      404,
      "INVALID_SCOPE",
      (range: ReturnType<typeof configureCrossLibraryRange>) => {
        workspace.spaces.find((space) => space.id === range.second.spaceIds[0])!.archived = true;
        return {};
      },
    ],
    [
      "a source whose fixed version changed",
      409,
      "SOURCE_VERSION_CHANGED",
      (range: ReturnType<typeof configureCrossLibraryRange>) => {
        range.second.versionId = "replacement-version";
        range.second.chunks = range.second.chunks.map((chunk) => ({
          ...chunk,
          versionId: "replacement-version",
        }));
        return {};
      },
    ],
  ])(
    "rejects cross-library range containing %s before retrieval",
    async (_label, status, code, mutate) => {
      const range = configureCrossLibraryRange();
      const override = mutate(range);
      const response = await POST(crossLibraryRequest(range, override));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(mock.rpc).not.toHaveBeenCalled();
    },
  );
});
