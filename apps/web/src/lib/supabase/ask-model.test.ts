import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import { resolveCitation, retrieveEvidence } from "@/lib/retrieval";
import {
  GROUNDING_CONTRACT_VERSION,
  buildGrounding,
  bindGeneratedAnswer,
} from "@/lib/ai/grounding";
import { ApiError } from "./api";
import type { AnswerRequest, AnswerResult, Note, WorkspaceData } from "@/lib/types";
import { questionContextKey } from "@/lib/question-context";
import { readEmbeddingConfig } from "@/lib/ai/embeddings";
import { workspaceSchema } from "./validation";

const mock = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  read: vi.fn(),
  rpc: vi.fn(),
  readModelConfig: vi.fn(),
  readModelProfile: vi.fn(),
  callModel: vi.fn(),
  callModelStream: vi.fn(),
  createRequestStore: vi.fn(),
  reserveRequest: vi.fn(),
  finishRequest: vi.fn(),
  embeddingConfig: vi.fn(),
  reserveEmbeddingUsage: vi.fn(),
  embedQuery: vi.fn(),
  readRerankConfig: vi.fn(),
  rerank: vi.fn(),
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
vi.mock("@/lib/ai/model", () => ({
  readModelConfig: mock.readModelConfig,
  readModelProfile: mock.readModelProfile,
  callModel: mock.callModel,
  callModelStream: mock.callModelStream,
}));
vi.mock("@/lib/ai/requests", () => ({
  createRequestStore: mock.createRequestStore,
  reserveRequest: mock.reserveRequest,
  finishRequest: mock.finishRequest,
}));
vi.mock("@/lib/ai/embeddings", () => ({
  readEmbeddingConfig: mock.embeddingConfig,
  reserveEmbeddingUsage: mock.reserveEmbeddingUsage,
  embedQuery: mock.embedQuery,
}));
vi.mock("@/lib/ai/rerank", () => ({
  readRerankConfig: mock.readRerankConfig,
  rerank: mock.rerank,
}));
import { POST } from "@/app/api/v1/ask/route";

type EvidencePrompt = {
  evidence: Array<{ id: string; kind?: string; title: string; text: string }>;
  question: string;
  priorAssistantAnswers?: Array<{ text: string }>;
};
type ModelMessage = { role: string; content: string };
const owner = "owner-a";
const store = { name: "server-ledger" };
const config = {
  baseUrl: "https://model.example/v1",
  model: "configured-model",
  apiKey: "server-secret",
  jsonMode: false,
  tokenLimitParameter: "max_completion_tokens",
  timeoutMs: 45000,
};
let workspace: WorkspaceData;
let workspaceRevision: number;
let currentUser: string | null;
function saveConcurrentQuestion() {
  const source = workspace.sources[0];
  const at = "2026-09-15T00:00:00.000Z";
  workspace = {
    ...workspace,
    conversations: [
      ...workspace.conversations,
      {
        id: "concurrent-question-conversation",
        spaceId: workspace.spaces[0].id,
        sourceId: source.id,
        scope: "document",
        sourceIds: [],
        title: "学习率过高会怎样？",
        messages: [
          {
            id: "concurrent-question-message",
            role: "user",
            content: "学习率过高会怎样？",
            citations: [],
            createdAt: at,
          },
        ],
        resolved: false,
        updatedAt: at,
      },
    ],
  };
  workspaceRevision += 1;
  workspaceSchema.parse(workspace);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function question(patch: Partial<AnswerRequest> = {}): AnswerRequest {
  const value: AnswerRequest = {
    requestId: "question-attempt-1",
    question: "学习率过高会怎样？",
    scope: "document",
    sourceId: workspace.sources[0].id,
    sourceIds: [],
    spaceId: workspace.spaces[0].id,
    ...patch,
  };
  const singleSourceScope =
    value.scope === "selection" || value.scope === "document" || value.scope === "document-notes";
  if (
    singleSourceScope &&
    value.sourceId &&
    !Object.prototype.hasOwnProperty.call(patch, "sourceVersions")
  )
    value.sourceVersions = [
      {
        sourceId: value.sourceId,
        versionId:
          workspace.sources.find((source) => source.id === value.sourceId)?.versionId ??
          "requested-source-version",
      },
    ];
  return value;
}
function request(
  patch: Partial<AnswerRequest> = {},
  signal?: AbortSignal,
  accept = "application/json",
) {
  return new Request("http://localhost/api/v1/ask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: accept,
      "X-Conuo-User": owner,
    },
    body: JSON.stringify(question(patch)),
    signal,
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
    sourceIds,
    sourceVersions: sourceIds.map((sourceId) => {
      const source = workspace.sources.find((item) => item.id === sourceId)!;
      return { sourceId, versionId: source.versionId };
    }),
  };
}
function crossLibraryQuestion(
  range: ReturnType<typeof configureCrossLibraryRange>,
  patch: Partial<AnswerRequest> = {},
) {
  return question({
    question: "两份资料如何帮助理解学习率？",
    scope: "cross-library-sources",
    sourceId: undefined,
    sourceIds: range.sourceIds,
    sourceVersions: range.sourceVersions,
    spaceId: "all",
    ...patch,
  });
}
function generated(text: string, ids = ["e1"], kind: "source" | "note" | "inference" = "source") {
  return JSON.stringify({
    status: "answered",
    paragraphs: [{ text, evidenceIds: ids, kind }],
  });
}
function prompt(): EvidencePrompt {
  const messages = mock.callModel.mock.calls[0][1] as ModelMessage[];
  return JSON.parse(messages.find((message) => message.role === "user")!.content) as EvidencePrompt;
}
function validAnswer(): AnswerResult {
  const grounding = buildGrounding(workspace, question());
  return bindGeneratedAnswer(generated(grounding.evidence[0].quote), grounding);
}
function documentNote(): Note {
  const source = workspace.sources[0];
  const chunk = source.chunks[0];
  return {
    id: "document-note",
    spaceId: workspace.spaces[0].id,
    title: "我的学习率复盘",
    content: "<p>我复盘：学习率过高时，损失可能反复上下波动。</p>",
    kind: "note",
    aiGenerated: false,
    status: "accepted",
    citations: [
      {
        sourceId: source.id,
        versionId: source.versionId,
        chunkId: chunk.id,
        title: source.title,
        quote: chunk.text,
        section: chunk.section,
        page: chunk.page,
      },
    ],
    versions: [],
    contentRevision: 3,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    deletedAt: null,
  };
}

function knowledgeNavigationNote(overrides: Partial<Note> = {}): Note {
  const source = workspace.sources[0];
  const chunk = source.chunks.find((item) => item.text.trim() && !item.text.startsWith("#"))!;
  return {
    id: "knowledge-navigation-note",
    spaceId: workspace.spaces[0].id,
    title: "学习率导航页",
    content: "<p>KNOWLEDGE_NAVIGATION_BODY_ONLY</p><p>学习率过高时损失会振荡。</p>",
    kind: "knowledge",
    aiGenerated: true,
    status: "accepted",
    citations: [
      {
        sourceId: source.id,
        versionId: source.versionId,
        chunkId: chunk.id,
        title: source.title,
        quote: chunk.text,
        section: chunk.section,
        page: chunk.page,
      },
    ],
    versions: [],
    contentRevision: 4,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
}

describe("generated answer route with canonical source and request-ledger boundaries", () => {
  beforeEach(() => {
    vi.stubEnv("CONUO_FEATURE_RICH_ANSWERS", "off");
    vi.stubEnv("CONUO_FEATURE_CROSS_LIBRARY_SEMANTIC", "off");
    Object.values(mock).forEach((fn) => fn.mockReset());
    mock.readModelProfile.mockImplementation(() => {
      const config = mock.readModelConfig();
      return config ? { profile: "default", config } : null;
    });
    workspace = createDemoWorkspace();
    workspaceRevision = 1;
    mock.embeddingConfig.mockReturnValue(null);
    mock.readRerankConfig.mockReturnValue(null);
    currentUser = owner;
    const chain = { select: mock.select, eq: mock.eq, maybeSingle: mock.read };
    mock.from.mockReturnValue(chain);
    mock.select.mockReturnValue(chain);
    mock.eq.mockReturnValue(chain);
    mock.getUser.mockImplementation(async () => ({
      data: { user: currentUser ? { id: currentUser } : null },
      error: null,
    }));
    // Every read is a point-in-time cloud snapshot. Mutations below simulate
    // another device changing the canonical workspace while generation awaits.
    mock.read.mockImplementation(async () => ({
      data: { data: structuredClone(workspace), revision: workspaceRevision },
      error: null,
    }));
    mock.readModelConfig.mockReturnValue(config);
    mock.rpc.mockImplementation(async (name, args) => {
      if (name === "list_glossary_terms") return { data: [], error: null };
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
          workspace_revision: workspaceRevision,
        })),
        error: null,
      };
    });
    mock.createRequestStore.mockReturnValue(store);
    mock.reserveRequest.mockResolvedValue({ kind: "reserved" });
    mock.finishRequest.mockResolvedValue(undefined);
    mock.callModel.mockImplementation(async (_config: unknown, messages: ModelMessage[]) => {
      const value = JSON.parse(
        messages.find((message) => message.role === "user")!.content,
      ) as EvidencePrompt;
      return generated(value.evidence[0].text);
    });
    mock.callModelStream.mockImplementation(
      async (
        _config: unknown,
        messages: ModelMessage[],
        _signal: AbortSignal,
        onDelta: (delta: string) => Promise<void>,
      ) => {
        const value = JSON.parse(
          messages.find((message) => message.role === "user")!.content,
        ) as EvidencePrompt;
        await onDelta(generated(value.evidence[0].text));
        return generated(value.evidence[0].text);
      },
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a grounded model answer with real quotes and saves only the owner's result", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    const answer = (await response.json()) as AnswerResult;
    expect(answer.mode).toBe("model");
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations.every((citation) => resolveCitation(workspace, citation))).toBe(true);
    expect(mock.eq.mock.calls.every((args) => args[0] === "owner_id" && args[1] === owner)).toBe(
      true,
    );
    expect(mock.reserveRequest).toHaveBeenCalledWith(
      store,
      owner,
      "question-attempt-1",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      { route: "ask", features: [] },
    );
    expect(GROUNDING_CONTRACT_VERSION).toBe("grounding-v11");
    const actualFingerprint = mock.reserveRequest.mock.calls[0][3];
    const embeddingFingerprint = readEmbeddingConfig()?.fingerprint ?? null;
    const searchMode = workspace.semanticSearch && embeddingFingerprint ? "semantic" : "keyword";
    const fingerprintFor = (contract: string) =>
      createHash("sha256")
        .update(
          JSON.stringify([
            contract,
            "plain",
            config.baseUrl,
            config.model,
            config.jsonMode,
            null,
            "default",
            "retrieval",
            "neighbor:0",
            questionContextKey(workspace, question()),
            searchMode,
            embeddingFingerprint,
            "depth:standard",
          ]),
        )
        .digest("hex");
    expect(actualFingerprint).toBe(fingerprintFor(GROUNDING_CONTRACT_VERSION));
    expect(actualFingerprint).not.toBe(fingerprintFor("grounding-v5"));
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "question-attempt-1",
      answer,
    );
    expect(JSON.stringify(answer)).not.toContain(config.apiKey);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("adds citations from accepted knowledge navigation without sending its body", async () => {
    vi.stubEnv("CONUO_FEATURE_KNOWLEDGE_NAVIGATION", "on");
    workspace.notes = [knowledgeNavigationNote()];
    const response = await POST(request({ requestId: "knowledge-navigation" }));
    expect(response.status).toBe(200);
    const value = prompt();
    const sourceEvidence = workspace.sources[0].chunks.find(
      (chunk) => chunk.text.trim() && !chunk.text.startsWith("#"),
    )!;
    expect(value.evidence.length).toBeGreaterThan(0);
    expect(value.evidence.some((item) => item.text === sourceEvidence.text)).toBe(true);
    expect(JSON.stringify(value)).not.toContain("KNOWLEDGE_NAVIGATION_BODY_ONLY");
    const navigationFingerprint = mock.reserveRequest.mock.calls[0]![3];
    expect(navigationFingerprint).toEqual(expect.any(String));

    vi.stubEnv("CONUO_FEATURE_KNOWLEDGE_NAVIGATION", "off");
    const baseline = await POST(request({ requestId: "knowledge-navigation-off" }));
    expect(baseline.status).toBe(200);
    const baselineFingerprint = mock.reserveRequest.mock.calls.at(-1)![3];
    expect(navigationFingerprint).not.toBe(baselineFingerprint);
  });

  it("ignores draft, foreign-space, and stale-version knowledge pages", async () => {
    vi.stubEnv("CONUO_FEATURE_KNOWLEDGE_NAVIGATION", "on");
    workspace.notes = [];
    await POST(request({ requestId: "knowledge-navigation-empty" }));
    const emptyFingerprint = mock.reserveRequest.mock.calls.at(-1)![3];

    const foreignSpace = { ...workspace.spaces[0], id: "foreign-space" };
    workspace.spaces.push(foreignSpace);
    const stale = knowledgeNavigationNote({
      id: "stale-knowledge-navigation-note",
      citations: knowledgeNavigationNote().citations.map((citation) => ({
        ...citation,
        versionId: "old-version",
      })),
    });
    workspace.notes = [
      knowledgeNavigationNote({ id: "draft-knowledge-navigation-note", status: "draft" }),
      knowledgeNavigationNote({
        id: "foreign-knowledge-navigation-note",
        spaceId: foreignSpace.id,
      }),
      stale,
    ];
    await POST(request({ requestId: "knowledge-navigation-invalid" }));
    const invalidFingerprint = mock.reserveRequest.mock.calls.at(-1)![3];
    expect(invalidFingerprint).toBe(emptyFingerprint);
  });

  it("loads only saved completed answers when answer memory is enabled", async () => {
    vi.stubEnv("CONUO_FEATURE_ANSWER_MEMORY", "on");
    const source = workspace.sources[0]!;
    const chunk = source.chunks.find((item) => item.text.trim() && !item.text.startsWith("#"))!;
    workspace.conversations = [
      {
        id: "conversation-memory",
        spaceId: workspace.spaces[0]!.id,
        sourceId: source.id,
        title: "学习率问题",
        scope: "document",
        sourceIds: [],
        messages: [
          {
            id: "saved-question",
            role: "user",
            content: "学习率怎么解释？",
            citations: [],
            createdAt: "2026-09-23T00:00:00.000Z",
          },
          {
            id: "saved-answer",
            role: "assistant",
            content: "上一轮已经解释过学习率。\n\n---\n\n依据范围：1/1 [1]",
            citations: [
              {
                sourceId: source.id,
                versionId: source.versionId,
                chunkId: chunk.id,
                title: source.title,
                quote: chunk.text,
                section: chunk.section,
                page: chunk.page,
              },
            ],
            createdAt: "2026-09-23T00:00:00.000Z",
            mode: "model",
            attempt: {
              id: "saved-attempt",
              questionMessageId: "saved-question",
              scopeSnapshot: {
                scope: "document",
                sourceId: source.id,
                sourceIds: [],
                spaceId: workspace.spaces[0]!.id,
              },
              status: "completed",
            },
          },
        ],
        resolved: false,
        updatedAt: "2026-09-23T00:00:00.000Z",
      },
    ];
    const response = await POST(request({ conversationId: "conversation-memory" }));
    expect(response.status).toBe(200);
    expect(prompt().priorAssistantAnswers).toEqual([{ text: "上一轮已经解释过学习率。" }]);
    expect(mock.callModel.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("They are not evidence"),
        }),
      ]),
    );
  });

  it("uses tutor instructions and a distinct fingerprint only when the server switch is on", async () => {
    vi.stubEnv("CONUO_FEATURE_TUTOR_MODE", "on");
    const enabled = await POST(request({ mode: "tutor", requestId: "tutor-enabled" }));
    expect(enabled.status).toBe(200);
    const enabledMessages = mock.callModel.mock.calls.at(-1)?.[1] as ModelMessage[];
    expect(enabledMessages[0]?.content).toContain("Tutor mode: help the learner reason");
    const enabledFingerprint = mock.reserveRequest.mock.calls.at(-1)?.[3];

    vi.stubEnv("CONUO_FEATURE_TUTOR_MODE", "off");
    const disabled = await POST(request({ mode: "tutor", requestId: "tutor-disabled" }));
    expect(disabled.status).toBe(200);
    const disabledMessages = mock.callModel.mock.calls.at(-1)?.[1] as ModelMessage[];
    expect(disabledMessages[0]?.content).not.toContain("Tutor mode: help the learner reason");
    const disabledFingerprint = mock.reserveRequest.mock.calls.at(-1)?.[3];
    expect(enabledFingerprint).not.toBe(disabledFingerprint);
  });

  it("relabels a source paragraph when the fast verifier marks it unsupported", async () => {
    vi.stubEnv("CONUO_FEATURE_ANSWER_VERIFY", "on");
    mock.callModel
      .mockImplementationOnce(async (_config: unknown, messages: ModelMessage[]) => {
        const value = JSON.parse(
          messages.find((message) => message.role === "user")!.content,
        ) as EvidencePrompt;
        return generated(value.evidence[0].text);
      })
      .mockResolvedValueOnce(
        JSON.stringify({ results: [{ paragraph: 1, verdict: "unsupported" }] }),
      );

    const response = await POST(request());
    expect(response.status).toBe(200);
    const answer = (await response.json()) as AnswerResult;
    expect(answer.content).toContain("**推断（原文未直接支持，请核对）：**");
    expect(mock.callModel).toHaveBeenCalledTimes(2);
  });

  it("keeps the answer when verification fails", async () => {
    vi.stubEnv("CONUO_FEATURE_ANSWER_VERIFY", "on");
    mock.callModel
      .mockImplementationOnce(async (_config: unknown, messages: ModelMessage[]) => {
        const value = JSON.parse(
          messages.find((message) => message.role === "user")!.content,
        ) as EvidencePrompt;
        return generated(value.evidence[0].text);
      })
      .mockRejectedValueOnce(new DOMException("verification timed out", "TimeoutError"));

    const response = await POST(request());
    expect(response.status).toBe(200);
    const answer = (await response.json()) as AnswerResult;
    expect(answer.content).not.toContain("原文未直接支持");
    expect(answer.citations.length).toBeGreaterThan(0);
  });

  it("does not call the verifier when the feature is off", async () => {
    vi.stubEnv("CONUO_FEATURE_ANSWER_VERIFY", "off");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mock.callModel).toHaveBeenCalledOnce();
  });

  it("routes deep thinking through the reasoning profile and longer ledger TTL", async () => {
    vi.stubEnv("CONUO_FEATURE_DEEP_THINKING", "on");
    mock.readModelProfile.mockImplementation((profile: string) =>
      profile === "reasoning" ? { profile, config } : { profile: "default", config },
    );
    const response = await POST(request({ depth: "deep" }, undefined, "text/event-stream"));
    expect(response.status).toBe(200);
    await response.text();
    expect(mock.callModelStream).toHaveBeenCalledOnce();
    expect(mock.readModelProfile).toHaveBeenCalledWith("reasoning");
    expect(mock.reserveRequest.mock.calls[0][4]).toEqual({
      route: "ask",
      features: ["deep_thinking"],
      ttlSeconds: 330,
    });
    expect(mock.reserveRequest.mock.calls[0][3]).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
  });

  it("requires SSE for deep thinking", async () => {
    vi.stubEnv("CONUO_FEATURE_DEEP_THINKING", "on");
    await expectError(await POST(request({ depth: "deep" })), 400, "DEEP_REQUIRES_STREAM");
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it("throttles reasoning heartbeats to one progress event per five seconds", async () => {
    vi.stubEnv("CONUO_FEATURE_DEEP_THINKING", "on");
    mock.readModelProfile.mockImplementation((profile: string) =>
      profile === "reasoning" ? { profile, config } : { profile: "default", config },
    );
    mock.callModelStream.mockImplementationOnce(
      async (
        _config: unknown,
        messages: ModelMessage[],
        _signal: AbortSignal,
        onDelta: (delta: string) => Promise<void>,
        observer: { onReasoningDelta?: () => Promise<void> },
      ) => {
        await observer.onReasoningDelta?.();
        await observer.onReasoningDelta?.();
        const value = JSON.parse(
          messages.find((message) => message.role === "user")!.content,
        ) as EvidencePrompt;
        await onDelta(generated(value.evidence[0].text));
        return generated(value.evidence[0].text);
      },
    );
    const response = await POST(request({ depth: "deep" }, undefined, "text/event-stream"));
    const body = await response.text();
    expect(body.match(/"phase":"reasoning"/g)).toHaveLength(1);
  });

  it("uses the rich format only when the server switch is enabled", async () => {
    vi.stubEnv("CONUO_FEATURE_RICH_ANSWERS", "on");
    mock.callModel.mockImplementationOnce(async () => generated("设 $x^2$ 为平方"));
    const richResponse = await POST(request({ requestId: "rich-answer" }));
    expect(richResponse.status).toBe(200);
    const richAnswer = (await richResponse.json()) as AnswerResult;
    expect(richAnswer.content).toContain("$$x^2$$");
    expect((mock.callModel.mock.calls.at(-1)![1] as ModelMessage[])[0]!.content).toContain(
      "Each paragraph text may use this safe Markdown subset only",
    );
    const richFingerprint = mock.reserveRequest.mock.calls.at(-1)![3];

    vi.stubEnv("CONUO_FEATURE_RICH_ANSWERS", "off");
    const plainResponse = await POST(request({ requestId: "plain-answer" }));
    expect(plainResponse.status).toBe(200);
    const plainFingerprint = mock.reserveRequest.mock.calls.at(-1)![3];
    expect(plainFingerprint).not.toBe(richFingerprint);
    expect((mock.callModel.mock.calls.at(-1)![1] as ModelMessage[])[0]!.content).toContain(
      "Plain text only, no markdown",
    );
  });

  it("binds neighbor expansion to the answer grounding and request fingerprint", async () => {
    const offResponse = await POST(request({ requestId: "neighbor-off" }));
    expect(offResponse.status).toBe(200);
    const offFingerprint = mock.reserveRequest.mock.calls.at(-1)![3];

    vi.stubEnv("CONUO_FEATURE_NEIGHBOR_EXPANSION", "on");
    const onResponse = await POST(request({ requestId: "neighbor-on" }));
    expect(onResponse.status).toBe(200);
    const onFingerprint = mock.reserveRequest.mock.calls.at(-1)![3];
    expect(onFingerprint).not.toBe(offFingerprint);
  });

  it("uses semantic retrieval for a fixed cross-library range only when enabled", async () => {
    const range = configureCrossLibraryRange();
    workspace.semanticSearch = true;
    const embedding = {
      baseUrl: "https://embedding.example/v1",
      apiKey: "test-only-embedding-key",
      model: "test-only-embedding",
      fingerprint: "a".repeat(64),
    };
    mock.embeddingConfig.mockReturnValue(embedding);
    mock.reserveEmbeddingUsage.mockResolvedValue(undefined);
    mock.embedQuery.mockResolvedValue([1, ...Array<number>(1535).fill(0)]);
    const rows = (sourceIds: string[]) =>
      sourceIds.map((sourceId) => {
        const source = workspace.sources.find((item) => item.id === sourceId)!;
        const chunk = source.chunks.find((item) => item.text.length > 80) ?? source.chunks[0]!;
        return {
          source_id: source.id,
          version_id: source.versionId,
          chunk_id: chunk.id,
          score: 1,
          workspace_revision: workspaceRevision,
        };
      });
    mock.rpc.mockImplementation(async (name, args) => {
      if (name === "list_glossary_terms") return { data: [], error: null };
      const sourceIds = args.p_source_ids as string[];
      if (name === "search_source_chunks") return { data: rows(sourceIds), error: null };
      if (name === "embedding_job_status")
        return {
          data: {
            jobs: sourceIds.map((sourceId) => ({
              sourceId,
              versionId: workspace.sources.find((item) => item.id === sourceId)!.versionId,
              state: "succeeded",
              profileFingerprint: embedding.fingerprint,
            })),
          },
          error: null,
        };
      if (name === "semantic_source_chunks") return { data: rows(sourceIds), error: null };
      throw new Error(`unexpected RPC ${name}`);
    });

    const keywordResponse = await POST(request(crossLibraryQuestion(range)));
    expect(keywordResponse.status).toBe(200);
    expect(mock.rpc.mock.calls.map(([name]) => name)).toEqual(["search_source_chunks"]);
    expect(mock.embedQuery).not.toHaveBeenCalled();

    mock.rpc.mockClear();
    mock.embedQuery.mockClear();
    vi.stubEnv("CONUO_FEATURE_CROSS_LIBRARY_SEMANTIC", "on");
    const semanticResponse = await POST(
      request({
        ...crossLibraryQuestion(range),
        requestId: "cross-library-semantic-on",
      }),
    );
    expect(semanticResponse.status).toBe(200);
    expect(mock.rpc.mock.calls.map(([name]) => name)).toEqual([
      "search_source_chunks",
      "embedding_job_status",
      "semantic_source_chunks",
    ]);
    expect(mock.rpc).toHaveBeenCalledWith(
      "semantic_source_chunks",
      expect.objectContaining({
        p_space_id: "*",
        p_source_ids: range.sourceIds,
      }),
    );
    expect(mock.embedQuery).toHaveBeenCalledOnce();
  });

  it("binds omitted, enabled and disabled thinking modes to distinct answer fingerprints", async () => {
    const fingerprints: string[] = [];
    for (const thinkingMode of [undefined, "enabled", "disabled"] as const) {
      mock.readModelConfig.mockReturnValue({
        ...config,
        ...(thinkingMode === undefined ? {} : { thinkingMode }),
      });
      const response = await POST(
        request({ requestId: `thinking-answer-${thinkingMode ?? "omitted"}` }),
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as AnswerResult).mode).toBe("model");
      fingerprints.push(mock.reserveRequest.mock.calls.at(-1)![3]);
      expect(mock.callModel.mock.calls.at(-1)![0]).toMatchObject({
        ...config,
        ...(thinkingMode === undefined ? {} : { thinkingMode }),
      });
    }
    expect(new Set(fingerprints).size).toBe(3);
    expect(mock.reserveRequest).toHaveBeenCalledTimes(3);
    expect(mock.callModel).toHaveBeenCalledTimes(3);
    expect(mock.finishRequest).toHaveBeenCalledTimes(3);
  });

  it.each([
    [undefined, "disabled"],
    ["enabled", "disabled"],
    ["disabled", "enabled"],
  ] as const)(
    "cannot reuse a %s answer cache when thinking changes to %s",
    async (priorMode, nextMode) => {
      let storedFingerprint: string | undefined;
      mock.reserveRequest.mockImplementation(async (_store, _owner, _request, fingerprint) => {
        if (storedFingerprint === undefined) {
          storedFingerprint = fingerprint;
          return { kind: "reserved" };
        }
        if (storedFingerprint !== fingerprint)
          throw new ApiError(409, "REQUEST_CHANGED", "资料或请求内容已改变，请重新发起模型请求。");
        return { kind: "cached", result: cached };
      });
      mock.readModelConfig.mockReturnValue({
        ...config,
        ...(priorMode === undefined ? {} : { thinkingMode: priorMode }),
      });
      const first = await POST(request());
      expect(first.status).toBe(200);
      const cached = (await first.json()) as AnswerResult;
      mock.readModelConfig.mockReturnValue({ ...config, thinkingMode: nextMode });
      await expectError(await POST(request()), 409, "REQUEST_CHANGED");
      expect(mock.reserveRequest).toHaveBeenCalledTimes(2);
      expect(mock.callModel).toHaveBeenCalledOnce();
      expect(mock.finishRequest).toHaveBeenCalledOnce();
    },
  );

  it.each(["before-rpc-read", "after-rpc-read"] as const)(
    "allows the first question's legitimate concurrent conversation save %s",
    async (phase) => {
      const originalRpc = mock.rpc.getMockImplementation()!;
      const evidenceBefore = structuredClone(workspace.sources);
      const contextBefore = questionContextKey(workspace, question());
      let searchHandled = false;
      mock.rpc.mockImplementation(async (...args) => {
        if (args[0] === "list_glossary_terms") return { data: [], error: null };
        if (searchHandled) return originalRpc(...args);
        searchHandled = true;
        if (phase === "before-rpc-read") saveConcurrentQuestion();
        const result = await originalRpc(...args);
        if (phase === "after-rpc-read") saveConcurrentQuestion();
        return result;
      });
      const response = await POST(request());
      expect(response.status).toBe(200);
      const answer = (await response.json()) as AnswerResult;
      expect(answer.mode).toBe("model");
      expect(answer.citations.length).toBeGreaterThan(0);
      expect(workspace.sources).toEqual(evidenceBefore);
      expect(questionContextKey(workspace, question())).toBe(contextBefore);
      expect(workspaceRevision).toBe(2);
      expect(workspace.conversations.at(-1)?.messages[0].role).toBe("user");
      expect(mock.rpc.mock.calls.filter(([name]) => name !== "list_glossary_terms")).toHaveLength(
        1,
      );
      expect(mock.reserveRequest).toHaveBeenCalledOnce();
      expect(mock.callModel).toHaveBeenCalledOnce();
      expect(mock.finishRequest).toHaveBeenCalledOnce();
    },
  );

  it.each(["future", "mixed", "old", "old-source-version", "old-source-chunk"] as const)(
    "rejects %s RPC revisions before reserving or calling the model",
    async (kind) => {
      if (kind === "old") workspaceRevision = 2;
      const originalRpc = mock.rpc.getMockImplementation()!;
      let searchHandled = false;
      mock.rpc.mockImplementation(async (...args) => {
        if (args[0] === "list_glossary_terms") return { data: [], error: null };
        if (searchHandled) return originalRpc(...args);
        searchHandled = true;
        const result = await originalRpc(...args);
        const first = result.data[0];
        expect(first).toBeDefined();
        if (kind === "old-source-version" || kind === "old-source-chunk") saveConcurrentQuestion();
        return {
          ...result,
          data:
            kind === "mixed"
              ? [first, { ...first, workspace_revision: 2 }]
              : [
                  {
                    ...first,
                    workspace_revision: kind === "future" ? 3 : kind === "old" ? 1 : 2,
                    ...(kind === "old-source-version"
                      ? { version_id: "previous-source-version" }
                      : {}),
                    ...(kind === "old-source-chunk" ? { chunk_id: "previous-source-chunk" } : {}),
                  },
                ],
        };
      });
      await expectError(await POST(request()), 409, "SEARCH_CONTEXT_CHANGED");
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );

  it("keeps snapshot validation when unavailable semantic retrieval falls back to keyword", async () => {
    workspace = { ...workspace, semanticSearch: true };
    mock.embeddingConfig.mockReturnValue({
      baseUrl: "https://embedding.example/v1",
      apiKey: "test-only-embedding-key",
      model: "test-only-embedding",
      fingerprint: "a".repeat(64),
    });
    const originalRpc = mock.rpc.getMockImplementation()!;
    let searches = 0;
    mock.rpc.mockImplementation(async (name, args) => {
      if (name === "list_glossary_terms") return { data: [], error: null };
      if (name === "embedding_job_status") return { data: { jobs: [] }, error: null };
      searches += 1;
      if (searches === 2) saveConcurrentQuestion();
      return originalRpc(name, args);
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(((await response.json()) as AnswerResult).mode).toBe("model");
    expect(
      mock.rpc.mock.calls.filter(([name]) => name !== "list_glossary_terms").map(([name]) => name),
    ).toEqual(["search_source_chunks", "embedding_job_status", "search_source_chunks"]);
    expect(mock.reserveEmbeddingUsage).not.toHaveBeenCalled();
    expect(mock.embedQuery).not.toHaveBeenCalled();
    expect(mock.reserveRequest).toHaveBeenCalledOnce();
    expect(mock.callModel).toHaveBeenCalledOnce();
    expect(mock.finishRequest).toHaveBeenCalledOnce();
  });

  it("does not treat a newer source AI revocation as a harmless conversation save", async () => {
    const originalRpc = mock.rpc.getMockImplementation()!;
    let searchHandled = false;
    mock.rpc.mockImplementation(async (...args) => {
      if (args[0] === "list_glossary_terms") return { data: [], error: null };
      if (searchHandled) return originalRpc(...args);
      searchHandled = true;
      const result = await originalRpc(...args);
      workspace = {
        ...workspace,
        sources: workspace.sources.map((source, index) =>
          index === 0 ? { ...source, aiAllowed: false } : source,
        ),
      };
      workspaceRevision = 2;
      workspaceSchema.parse(workspace);
      return {
        ...result,
        data: result.data.map((row: Record<string, unknown>) => ({
          ...row,
          workspace_revision: 2,
        })),
      };
    });
    const response = await POST(request());
    expect([403, 409]).toContain(response.status);
    expect(mock.reserveRequest).not.toHaveBeenCalled();
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it("rejects a fixed-version selection changed before the first cloud snapshot", async () => {
    const original = workspace.sources[0];
    const expectedVersion = original.versionId;
    workspace.sources[0] = {
      ...original,
      versionId: "replacement-version",
      chunks: original.chunks.map((chunk) => ({ ...chunk, versionId: "replacement-version" })),
    };

    await expectError(
      await POST(
        request({
          scope: "sources",
          sourceId: undefined,
          sourceIds: [original.id],
          sourceVersions: [{ sourceId: original.id, versionId: expectedVersion }],
        }),
      ),
      409,
      "SOURCE_VERSION_CHANGED",
    );
    expect(mock.reserveRequest).not.toHaveBeenCalled();
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it("rejects a single-document request whose frozen version changed before the first cloud snapshot", async () => {
    const original = workspace.sources[0];
    const expectedVersion = original.versionId;
    workspace.sources[0] = {
      ...original,
      versionId: "replacement-document-version",
      chunks: original.chunks.map((chunk) => ({
        ...chunk,
        versionId: "replacement-document-version",
      })),
    };

    await expectError(
      await POST(
        request({
          sourceVersions: [{ sourceId: original.id, versionId: expectedVersion }],
        }),
      ),
      409,
      "SOURCE_VERSION_CHANGED",
    );
    expect(mock.reserveRequest).not.toHaveBeenCalled();
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it("rejects a comparison request expanded beyond its fixed two-source identity", async () => {
    const [left, right] = workspace.sources;
    await expectError(
      await POST(
        request({
          scope: "sources",
          sourceId: undefined,
          sourceIds: [left.id, right.id, "extra-source"],
          sourceVersions: [
            { sourceId: left.id, versionId: left.versionId },
            { sourceId: right.id, versionId: right.versionId },
            { sourceId: "extra-source", versionId: "extra-version" },
          ],
          comparison: {
            leftSourceId: left.id,
            leftVersionId: left.versionId,
            rightSourceId: right.id,
            rightVersionId: right.versionId,
          },
        }),
      ),
      400,
      "INVALID_QUESTION",
    );
    expect(mock.reserveRequest).not.toHaveBeenCalled();
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it.each([
    [
      "AI permission revoked",
      403,
      "SOURCE_AI_DISABLED",
      (source: (typeof workspace.sources)[number]) => {
        source.aiAllowed = false;
      },
    ],
    [
      "source no longer parsed",
      409,
      "SOURCE_NOT_READY",
      (source: (typeof workspace.sources)[number]) => {
        source.status = "parsing";
      },
    ],
  ])(
    "does not shrink a fixed-version selection when %s before the first cloud snapshot",
    async (_label, status, code, change) => {
      const source = workspace.sources[0];
      change(source);

      await expectError(
        await POST(
          request({
            scope: "sources",
            sourceId: undefined,
            sourceIds: [source.id],
            sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
          }),
        ),
        status,
        code,
      );
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );

  it("sends only document-scope evidence, never the other source or old conversations", async () => {
    workspace.conversations.push({
      id: "old-conversation",
      title: "以前的问题",
      scope: "space",
      spaceId: workspace.spaces[0].id,
      sourceIds: [],
      resolved: false,
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "old-message",
          role: "assistant",
          content: "HIDDEN_PRIOR_CONTEXT",
          citations: [],
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect((await POST(request())).status).toBe(200);
    expect(prompt().evidence.every((item) => item.title === workspace.sources[0].title)).toBe(true);
    expect(JSON.stringify(mock.callModel.mock.calls[0][1])).not.toContain("HIDDEN_PRIOR_CONTEXT");
    expect(JSON.stringify(mock.callModel.mock.calls[0][1])).not.toContain(
      workspace.sources[1].text,
    );
  });

  it("supports generic summary questions using bounded current-source passages", async () => {
    expect((await POST(request({ question: "总结" }))).status).toBe(200);
    expect(mock.callModel).toHaveBeenCalledOnce();
    expect(prompt().question).toBe("总结");
    expect(prompt().evidence.length).toBeGreaterThan(1);
    expect(prompt().evidence.every((item) => item.title === workspace.sources[0].title)).toBe(true);
  });

  it("does not disclose explicitly selected out-of-scope sources to a model", async () => {
    const source = workspace.sources[1];
    source.spaceIds = ["another-space"];
    await expectError(
      await POST(
        request({
          scope: "sources",
          sourceId: undefined,
          sourceIds: [source.id],
          sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
        }),
      ),
      404,
      "INVALID_SCOPE",
    );
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.reserveRequest).not.toHaveBeenCalled();
  });

  it("keeps current human note evidence separate from original-source citations", async () => {
    workspace.notes = [documentNote()];
    mock.callModel.mockImplementationOnce(async (_config: unknown, messages: ModelMessage[]) => {
      const body = JSON.parse(
        messages.find((message) => message.role === "user")!.content,
      ) as EvidencePrompt;
      const note = body.evidence.find((item) => item.id === "n1");
      expect(note).toMatchObject({ kind: "personal_note", title: "我的学习率复盘" });
      return generated("我记录过损失可能振荡。", [note!.id], "note");
    });

    const response = await POST(request({ scope: "document-notes" }));
    expect(response.status).toBe(200);
    const answer = (await response.json()) as AnswerResult;
    expect(answer.citations).toEqual([]);
    expect(answer.noteEvidence).toEqual([
      expect.objectContaining({
        noteId: "document-note",
        sourceId: workspace.sources[0].id,
        revision: 3,
      }),
    ]);
    expect(answer.content).toContain("**来自我的笔记：**");
    expect(answer.content).toContain("[[conuo-note:1]]");
  });

  it("rejects document-notes scope when it carries a second source or a text selection", async () => {
    await expectError(
      await POST(
        request({
          scope: "document-notes",
          sourceIds: [workspace.sources[1].id],
          selection: "不应被带入的选段",
        }),
      ),
      400,
      "INVALID_SCOPE",
    );
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it("requires a request ID before reserving a paid generation", async () => {
    await expectError(await POST(request({ requestId: undefined })), 400, "REQUEST_ID_REQUIRED");
    expect(mock.reserveRequest).not.toHaveBeenCalled();
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it.each(["global", "source"])(
    "never calls the model with %s AI permission disabled",
    async (level) => {
      if (level === "global") workspace.aiEnabled = false;
      else workspace.sources[0].aiAllowed = false;
      const response = await POST(request());
      if (level === "global") {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ mode: "extractive", citations: [] });
      } else {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "SOURCE_AI_DISABLED" });
      }
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.callModel).not.toHaveBeenCalled();
    },
  );

  it("does not send deleted evidence after a reservation wait", async () => {
    const reserve = deferred<{ kind: "reserved" }>();
    mock.reserveRequest.mockReturnValueOnce(reserve.promise);
    const pending = POST(request());
    await vi.waitFor(() => expect(mock.reserveRequest).toHaveBeenCalledOnce());
    workspace.sources[0].deletedAt = new Date().toISOString();
    workspaceRevision += 1;
    reserve.resolve({ kind: "reserved" });
    await expectError(await pending, 409, "QUESTION_CONTEXT_CHANGED");
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "question-attempt-1",
      undefined,
      "QUESTION_CONTEXT_CHANGED",
    );
  });

  const evidenceChanges: [string, (current: WorkspaceData) => void][] = [
    [
      "deletion",
      (current) => {
        current.sources[0].deletedAt = new Date().toISOString();
      },
    ],
    [
      "source permission revocation",
      (current) => {
        current.sources[0].aiAllowed = false;
      },
    ],
    [
      "global shutdown",
      (current) => {
        current.aiEnabled = false;
      },
    ],
    [
      "version replacement",
      (current) => {
        current.sources[0].versionId = "replacement-version";
      },
    ],
    [
      "space reassignment",
      (current) => {
        current.sources[0].spaceIds = [];
      },
    ],
  ];
  it.each(evidenceChanges)("discards a generated answer after %s", async (_label, change) => {
    const model = deferred<string>();
    mock.callModel.mockReturnValueOnce(model.promise);
    const pending = POST(request());
    await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
    const raw = generated(prompt().evidence[0].text);
    change(workspace);
    workspaceRevision += 1;
    model.resolve(raw);
    await expectError(await pending, 409, "QUESTION_CONTEXT_CHANGED");
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "question-attempt-1",
      undefined,
      "QUESTION_CONTEXT_CHANGED",
    );
  });

  it("discards the result when the authenticated account changes during generation", async () => {
    const model = deferred<string>();
    mock.callModel.mockReturnValueOnce(model.promise);
    const pending = POST(request());
    await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
    currentUser = "owner-b";
    model.resolve(generated(prompt().evidence[0].text));
    await expectError(await pending, 409, "SESSION_CHANGED");
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "question-attempt-1",
      undefined,
      "SESSION_CHANGED",
    );
  });

  it("does not discard a valid result for unrelated note edits", async () => {
    const model = deferred<string>();
    mock.callModel.mockReturnValueOnce(model.promise);
    const pending = POST(request());
    await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
    workspace.notes.push({
      id: "unrelated-note",
      title: "我的笔记",
      content: "<p>独立笔记</p>",
      kind: "note",
      status: "accepted",
      spaceId: workspace.spaces[0].id,
      citations: [],
      versions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    });
    model.resolve(generated(prompt().evidence[0].text));
    expect((await pending).status).toBe(200);
  });

  it("does not return generated output after the user stops", async () => {
    const controller = new AbortController();
    const model = deferred<string>();
    mock.callModel.mockReturnValueOnce(model.promise);
    const pending = POST(request({}, controller.signal));
    await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
    controller.abort();
    expect((mock.callModel.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    model.resolve(generated(prompt().evidence[0].text));
    await expectError(await pending, 499, "REQUEST_CANCELLED");
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "question-attempt-1",
      undefined,
      "REQUEST_CANCELLED",
    );
  });

  it("returns the original model error without waiting for a stalled failure ledger cleanup", async () => {
    const model = deferred<string>();
    mock.callModel.mockReturnValueOnce(model.promise);
    mock.finishRequest.mockReturnValue(new Promise<void>(() => {}));
    const pending = POST(request());
    await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
    let response: Response | undefined;
    void pending.then((result) => {
      response = result;
    });
    model.reject(new ApiError(503, "MODEL_AUTH", "模型服务认证失败。"));
    for (let i = 0; i < 20 && !response; i++) await Promise.resolve();
    expect(response).toBeDefined();
    if (!response) throw new Error("The original model failure was delayed by ledger cleanup.");
    await expectError(response, 503, "MODEL_AUTH");
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "question-attempt-1",
      undefined,
      "MODEL_AUTH",
    );
  });

  it("rejects invented evidence IDs instead of saving their answer", async () => {
    mock.callModel.mockResolvedValueOnce(generated("一个没有支持的断言", ["e999"]));
    await expectError(await POST(request()), 502, "INVALID_MODEL_CITATION");
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "question-attempt-1",
      undefined,
      "INVALID_MODEL_CITATION",
    );
  });

  it("rejects a quantified self-rating without saving a non-streamed answer", async () => {
    mock.callModel.mockResolvedValueOnce(generated("Confidence: 95%."));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "INVALID_MODEL_ANSWER",
      error: expect.stringContaining("不可核验的量化自评"),
    });
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "question-attempt-1",
      undefined,
      "INVALID_MODEL_ANSWER",
    );
  });

  it("reuses a valid cached answer without another model invocation or completion write", async () => {
    const cached = validAnswer();
    mock.reserveRequest.mockResolvedValueOnce({ kind: "cached", result: cached });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cached);
    expect(mock.getUser.mock.calls.length).toBeGreaterThan(1);
    expect(mock.read.mock.calls.length).toBeGreaterThan(1);
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });

  it("rewrites follow-up queries, fuses each search, and reserves the ledger once", async () => {
    vi.stubEnv("CONUO_FEATURE_QUERY_REWRITE", "on");
    mock.callModel.mockImplementationOnce(async () =>
      JSON.stringify({ query: "学习率过高", alternates: ["learning rate too high"] }),
    );
    const response = await POST(
      request({ question: "为什么？", userContext: ["学习率过高会怎样？"] }),
    );
    expect(response.status).toBe(200);
    expect(mock.reserveRequest).toHaveBeenCalledOnce();
    expect(mock.callModel).toHaveBeenCalledTimes(2);
    expect(
      mock.rpc.mock.calls
        .filter(([name]) => name !== "list_glossary_terms")
        .map(([, args]) => args.p_query),
    ).toEqual(["学习率过高", "learning rate too high"]);
  });

  it("does not call the rewrite model when the rewritten request is cached", async () => {
    vi.stubEnv("CONUO_FEATURE_QUERY_REWRITE", "on");
    mock.reserveRequest.mockResolvedValueOnce({ kind: "cached", result: validAnswer() });
    const response = await POST(
      request({ question: "为什么？", userContext: ["学习率过高会怎样？"] }),
    );
    expect(response.status).toBe(200);
    expect(mock.reserveRequest).toHaveBeenCalledOnce();
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.rpc.mock.calls.filter(([name]) => name !== "list_glossary_terms")).toHaveLength(0);
  });

  it("falls back to the bounded original retrieval query when rewrite JSON is invalid", async () => {
    vi.stubEnv("CONUO_FEATURE_QUERY_REWRITE", "on");
    mock.callModel.mockResolvedValueOnce("not-json");
    const response = await POST(
      request({ question: "为什么？", userContext: ["学习率过高会怎样？"] }),
    );
    expect(response.status).toBe(200);
    expect(mock.rpc.mock.calls.find(([name]) => name === "search_source_chunks")?.[1].p_query).toBe(
      "为什么？\n学习率过高会怎样？",
    );
    expect(mock.reserveRequest).toHaveBeenCalledOnce();
  });

  it("reranks citations before applying the existing evidence budget", async () => {
    vi.stubEnv("CONUO_FEATURE_RERANK", "on");
    const source = workspace.sources[0]!;
    const chunks = source.chunks.filter((chunk) => chunk.text.length > 80).slice(0, 2);
    expect(chunks).toHaveLength(2);
    mock.readRerankConfig.mockReturnValue({
      baseUrl: "https://rerank.example/v1",
      apiKey: "secret",
      model: "rerank-model",
      maxCandidates: 40,
      topN: 12,
    });
    mock.rerank.mockResolvedValueOnce([1, 0]);
    mock.rpc.mockImplementation(async (name) => {
      if (name === "list_glossary_terms") return { data: [], error: null };
      expect(name).toBe("search_source_chunks");
      return {
        data: chunks.map((chunk, index) => ({
          source_id: source.id,
          version_id: source.versionId,
          chunk_id: chunk.id,
          score: 1 - index / 10,
          workspace_revision: workspaceRevision,
        })),
        error: null,
      };
    });
    const response = await POST(request({ requestId: "rerank-request" }));
    expect(response.status).toBe(200);
    expect(mock.rerank).toHaveBeenCalledOnce();
    expect(mock.rerank).toHaveBeenCalledWith(
      expect.anything(),
      "学习率过高会怎样？",
      chunks.map((chunk) => chunk.text),
      expect.any(AbortSignal),
    );
    expect(prompt().evidence[0]!.text).toBe(chunks[1]!.text);
  });

  it("keeps the indexed citation order when reranking fails", async () => {
    vi.stubEnv("CONUO_FEATURE_RERANK", "on");
    const source = workspace.sources[0]!;
    const chunks = source.chunks.filter((chunk) => chunk.text.length > 80).slice(0, 2);
    mock.readRerankConfig.mockReturnValue({
      baseUrl: "https://rerank.example/v1",
      apiKey: "secret",
      model: "rerank-model",
      maxCandidates: 40,
      topN: 12,
    });
    mock.rerank.mockRejectedValueOnce(new Error("provider unavailable"));
    mock.rpc.mockImplementation(async (name) => {
      if (name === "list_glossary_terms") return { data: [], error: null };
      expect(name).toBe("search_source_chunks");
      return {
        data: chunks.map((chunk, index) => ({
          source_id: source.id,
          version_id: source.versionId,
          chunk_id: chunk.id,
          score: 1 - index / 10,
          workspace_revision: workspaceRevision,
        })),
        error: null,
      };
    });
    const response = await POST(request({ requestId: "rerank-failure" }));
    expect(response.status).toBe(200);
    expect(prompt().evidence[0]!.text).toBe(chunks[0]!.text);
  });

  it("rechecks source permission before disclosing a cached result", async () => {
    const cached = validAnswer();
    const reserve = deferred<{ kind: "cached"; result: AnswerResult }>();
    mock.reserveRequest.mockReturnValueOnce(reserve.promise);
    const pending = POST(request());
    await vi.waitFor(() => expect(mock.reserveRequest).toHaveBeenCalledOnce());
    workspace.sources[0].aiAllowed = false;
    workspaceRevision += 1;
    reserve.resolve({ kind: "cached", result: cached });
    await expectError(await pending, 409, "QUESTION_CONTEXT_CHANGED");
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });

  it("rejects a cached citation whose quote is no longer canonical", async () => {
    const cached = validAnswer();
    cached.citations[0].quote = "伪造原文";
    mock.reserveRequest.mockResolvedValueOnce({ kind: "cached", result: cached });
    await expectError(await POST(request()), 409, "INVALID_CURRENT_CITATION");
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it("rejects cached personal-note evidence that is no longer canonical", async () => {
    workspace.notes = [documentNote()];
    const noteQuestion = question({ scope: "document-notes" });
    const grounding = buildGrounding(workspace, noteQuestion);
    const cached = bindGeneratedAnswer(generated("我当时的笔记结论。", ["n1"], "note"), grounding);
    cached.noteEvidence![0].quote = "伪造的笔记摘录";
    mock.reserveRequest.mockResolvedValueOnce({ kind: "cached", result: cached });

    await expectError(
      await POST(request({ scope: "document-notes" })),
      409,
      "INVALID_CURRENT_CITATION",
    );
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it("discards a document-notes response when its selected note changes during generation", async () => {
    workspace.notes = [documentNote()];
    const model = deferred<string>();
    mock.callModel.mockReturnValueOnce(model.promise);
    const pending = POST(request({ scope: "document-notes" }));
    await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
    const note = prompt().evidence.find((item) => item.id === "n1");
    expect(note).toBeTruthy();
    workspace.notes[0] = {
      ...workspace.notes[0],
      content: "<p>我已经修改了这条笔记。</p>",
      contentRevision: 4,
      updatedAt: "2026-09-13T00:01:00.000Z",
    };
    workspaceRevision += 1;
    model.resolve(generated("我当时的笔记结论。", [note!.id], "note"));

    await expectError(await pending, 409, "QUESTION_CONTEXT_CHANGED");
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "question-attempt-1",
      undefined,
      "QUESTION_CONTEXT_CHANGED",
    );
  });

  it.each([
    null,
    {},
    { mode: "model", content: "不完整缓存" },
    { mode: "extractive", content: "错误模式", citations: [] },
  ])("fails closed for incomplete cached data %#", async (cached) => {
    mock.reserveRequest.mockResolvedValueOnce({ kind: "cached", result: cached });
    await expectError(await POST(request()), 503, "INVALID_SAVED_ANSWER");
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });

  it("does not invoke a model when reservation cannot be confirmed", async () => {
    mock.reserveRequest.mockRejectedValueOnce(
      new ApiError(503, "MODEL_LEDGER_UNAVAILABLE", "请求记录服务不可用"),
    );
    await expectError(await POST(request()), 503, "MODEL_LEDGER_UNAVAILABLE");
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });

  it("never returns success if the generated result cannot be saved", async () => {
    mock.finishRequest.mockRejectedValue(
      new ApiError(503, "MODEL_RESULT_NOT_SAVED", "保存无法确认"),
    );
    await expectError(await POST(request()), 503, "MODEL_RESULT_NOT_SAVED");
    expect(mock.callModel).toHaveBeenCalledOnce();
    expect(mock.finishRequest).toHaveBeenCalledTimes(2);
  });

  it("checks again when permissions change while saving the generated result", async () => {
    const finishing = deferred<void>();
    mock.finishRequest.mockReturnValueOnce(finishing.promise);
    const pending = POST(request());
    await vi.waitFor(() => expect(mock.finishRequest).toHaveBeenCalledOnce());
    workspace.sources[0].aiAllowed = false;
    workspaceRevision += 1;
    finishing.resolve();
    await expectError(await pending, 409, "QUESTION_CONTEXT_CHANGED");
    expect(mock.finishRequest).toHaveBeenCalledOnce();
  });

  it("does not return success when Stop arrives during the final workspace read", async () => {
    const controller = new AbortController();
    mock.read.mockImplementation(async () => {
      if (mock.finishRequest.mock.calls.some((args) => args[3]?.mode === "model"))
        controller.abort();
      return { data: { data: structuredClone(workspace), revision: 1 }, error: null };
    });
    await expectError(await POST(request({}, controller.signal)), 499, "REQUEST_CANCELLED");
  });
});
