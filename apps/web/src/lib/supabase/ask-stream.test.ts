import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "../seed";
import { retrieveEvidence, resolveCitation } from "../retrieval";
import { buildGrounding, bindGeneratedAnswer } from "../ai/grounding";
import { answerStreamResponse, ANSWER_STREAM_LIMITS } from "../ai/answer-response-stream";
import type { AnswerRequest, AnswerResult, WorkspaceData } from "../types";
import type { AnswerStreamEvent } from "../answer-stream-types";
import { ApiError } from "./api";
import { readAnswerResponse } from "../answer-stream";
import { workspaceSchema } from "./validation";

const mock = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  read: vi.fn(),
  rpc: vi.fn(),
  readModelConfig: vi.fn(),
  callModel: vi.fn(),
  callModelStream: vi.fn(),
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
  callModel: mock.callModel,
  callModelStream: mock.callModelStream,
}));
vi.mock("../ai/requests", () => ({
  createRequestStore: mock.createRequestStore,
  reserveRequest: mock.reserveRequest,
  finishRequest: mock.finishRequest,
}));
import { POST } from "@/app/api/v1/ask/route";

const owner = "owner-a",
  store = { name: "server-ledger" };
const config = {
  baseUrl: "https://model.example/v1",
  model: "configured-model",
  apiKey: "server-secret",
  jsonMode: false,
  tokenLimitParameter: "max_completion_tokens",
  timeoutMs: 45000,
};
let workspace: WorkspaceData;
let currentUser: string | null;
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function question(patch: Partial<AnswerRequest> = {}): AnswerRequest {
  const value: AnswerRequest = {
    requestId: "stream-request-1",
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
  headers?: Record<string, string>,
) {
  return new Request("http://localhost/api/v1/ask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Conuo-User": owner,
      Accept: "text/event-stream",
      ...headers,
    },
    body: JSON.stringify(question(patch)),
    signal,
  });
}
function indexedRows(data: WorkspaceData, revision: number, args: Record<string, unknown>) {
  return retrieveEvidence(data, {
    question: args.p_query as string,
    scope: "sources",
    sourceIds: args.p_source_ids as string[],
    spaceId: args.p_space_id as string,
  }).citations.map((citation) => ({
    source_id: citation.sourceId,
    version_id: citation.versionId,
    chunk_id: citation.chunkId,
    score: 1,
    workspace_revision: revision,
  }));
}
function appendQuestionConversation(data: WorkspaceData): WorkspaceData {
  const at = "2026-09-15T10:00:00.000Z";
  const latest: WorkspaceData = {
    ...data,
    conversations: [
      ...data.conversations,
      {
        id: "concurrent-question-conversation",
        title: "同步中的新问题",
        scope: "document",
        spaceId: data.spaces[0].id,
        sourceId: data.sources[0].id,
        sourceIds: [],
        resolved: false,
        updatedAt: at,
        messages: [
          {
            id: "concurrent-question-message",
            role: "user",
            content: "CONCURRENT_CONVERSATION_IS_NOT_EVIDENCE",
            citations: [],
            createdAt: at,
          },
        ],
      },
    ],
  };
  expect(workspaceSchema.safeParse(latest).success).toBe(true);
  return latest;
}
const paragraph = (text: string) => JSON.stringify({ text, evidenceIds: ["e1"], kind: "source" });
const firstDelta = `{"status":"answered","paragraphs":[${paragraph("学习率过高可能导致训练不稳定。")},`;
const lastDelta = `${paragraph("应结合当前资料中的条件判断。")}]}`;
const generated = firstDelta + lastDelta;
function readEvents(response: Response) {
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let buffered = "";
  return {
    reader,
    async next(): Promise<AnswerStreamEvent | null> {
      while (!buffered.includes("\n\n")) {
        const { done, value } = await reader.read();
        if (done) {
          expect(buffered).toBe("");
          return null;
        }
        buffered += decoder.decode(value, { stream: true });
      }
      const end = buffered.indexOf("\n\n"),
        record = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      expect(record.startsWith("data: ")).toBe(true);
      return JSON.parse(record.slice(6)) as AnswerStreamEvent;
    },
    async all() {
      const events: AnswerStreamEvent[] = [];
      let next;
      while ((next = await this.next()) !== null) events.push(next);
      return events;
    },
  };
}
async function nextDraft(events: ReturnType<typeof readEvents>) {
  for (let i = 0; i < 10; i++) {
    const event = await events.next();
    if (event?.type === "draft") return event.answer;
    expect(event?.type).toBe("progress");
  }
  throw new Error("No draft");
}
beforeEach(() => {
  Object.values(mock).forEach((fn) => fn.mockReset());
  workspace = createDemoWorkspace();
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
    data: { data: structuredClone(workspace), revision: 1 },
    error: null,
  }));
  mock.rpc.mockImplementation(async (_name, args) => ({
    data: retrieveEvidence(workspace, {
      question: args.p_query,
      scope: "sources",
      sourceIds: args.p_source_ids,
      spaceId: args.p_space_id,
    }).citations.map((citation) => ({
      source_id: citation.sourceId,
      version_id: citation.versionId,
      chunk_id: citation.chunkId,
      score: 1,
      workspace_revision: 1,
    })),
    error: null,
  }));
  mock.readModelConfig.mockReturnValue(config);
  mock.createRequestStore.mockReturnValue(store);
  mock.reserveRequest.mockResolvedValue({ kind: "reserved" });
  mock.finishRequest.mockResolvedValue(undefined);
  mock.callModelStream.mockImplementation(
    async (_config, _messages, _signal, onDelta: (text: string) => Promise<void>) => {
      await onDelta(firstDelta);
      await onDelta(lastDelta);
      return generated;
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("authenticated generated-answer SSE route", () => {
  it("binds each optional thinking mode into the SSE answer fingerprint", async () => {
    const fingerprints: string[] = [];
    for (const thinkingMode of [undefined, "enabled", "disabled"] as const) {
      mock.readModelConfig.mockReturnValue({
        ...config,
        ...(thinkingMode === undefined ? {} : { thinkingMode }),
      });
      const events = await readEvents(
        await POST(request({ requestId: `thinking-stream-${thinkingMode ?? "omitted"}` })),
      ).all();
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      const complete = events.at(-1);
      expect(complete?.type).toBe("complete");
      if (complete?.type !== "complete") throw new Error("No complete for thinking mode");
      expect(complete.answer.mode).toBe("model");
      fingerprints.push(mock.reserveRequest.mock.calls.at(-1)![3]);
      expect(mock.callModelStream.mock.calls.at(-1)![0]).toMatchObject({
        ...config,
        ...(thinkingMode === undefined ? {} : { thinkingMode }),
      });
    }
    expect(new Set(fingerprints).size).toBe(3);
    expect(mock.reserveRequest).toHaveBeenCalledTimes(3);
    expect(mock.callModelStream).toHaveBeenCalledTimes(3);
    expect(mock.finishRequest).toHaveBeenCalledTimes(3);
    expect(mock.callModel).not.toHaveBeenCalled();
  });
  it.each(["before-rpc-result", "after-rpc-result"])(
    "completes exactly one model attempt when only a legal conversation advances the revision %s",
    async (stage) => {
      const initial = workspace;
      let revision = 1,
        rpcReturned = false;
      const reads: { revision: number; conversations: number }[] = [];
      mock.read.mockImplementation(async () => {
        if (stage === "after-rpc-result" && rpcReturned && revision === 1) {
          workspace = appendQuestionConversation(workspace);
          revision = 2;
        }
        reads.push({ revision, conversations: workspace.conversations.length });
        return { data: { data: structuredClone(workspace), revision }, error: null };
      });
      mock.rpc.mockImplementation(async (_name, args) => {
        if (stage === "before-rpc-result") {
          workspace = appendQuestionConversation(workspace);
          revision = 2;
        }
        const rows = indexedRows(workspace, revision, args);
        expect(rows.length).toBeGreaterThan(0);
        rpcReturned = true;
        return { data: rows, error: null };
      });

      const response = await POST(request()),
        events = await readEvents(response).all(),
        complete = events.at(-1);
      expect(response.status).toBe(200);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(complete?.type).toBe("complete");
      if (complete?.type !== "complete") throw new Error("No complete after conversation save");
      expect(complete.answer.mode).toBe("model");
      expect(complete.answer.citations.length).toBeGreaterThan(0);
      expect(complete.answer.citations.every((cite) => resolveCitation(workspace, cite))).toBe(
        true,
      );
      expect(workspace).not.toBe(initial);
      expect(initial.conversations).toEqual([]);
      expect(workspace.sources).toBe(initial.sources);
      expect(reads[0]).toEqual({ revision: 1, conversations: 0 });
      expect(reads.slice(1).every((read) => read.revision === 2 && read.conversations === 1)).toBe(
        true,
      );
      expect(mock.rpc).toHaveBeenCalledOnce();
      expect(mock.reserveRequest).toHaveBeenCalledOnce();
      expect(mock.callModelStream).toHaveBeenCalledOnce();
      expect(mock.callModel).not.toHaveBeenCalled();
      expect(JSON.stringify(mock.callModelStream.mock.calls[0][1])).not.toContain(
        "CONCURRENT_CONVERSATION_IS_NOT_EVIDENCE",
      );
      expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
        store,
        owner,
        "stream-request-1",
        complete.answer,
      );
    },
  );
  it.each(["future", "mixed"])(
    "rejects %s index revisions even when a legal conversation is the only workspace change",
    async (mode) => {
      let revision = 1;
      mock.read.mockImplementation(async () => ({
        data: { data: structuredClone(workspace), revision },
        error: null,
      }));
      mock.rpc.mockImplementation(async (_name, args) => {
        workspace = appendQuestionConversation(workspace);
        revision = 2;
        const rows = indexedRows(workspace, mode === "future" ? 3 : 1, args);
        expect(rows.length).toBeGreaterThan(0);
        return {
          data: mode === "mixed" ? [rows[0], { ...rows[0], workspace_revision: 2 }] : rows,
          error: null,
        };
      });

      const events = await readEvents(await POST(request())).all();
      expect(events.at(-1)).toMatchObject({ type: "error", code: "SEARCH_CONTEXT_CHANGED" });
      expect(events.some((event) => event.type === "draft" || event.type === "complete")).toBe(
        false,
      );
      expect(mock.callModelStream).not.toHaveBeenCalled();
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.finishRequest).not.toHaveBeenCalled();
    },
  );
  it.each(["body", "permission", "deleted", "archived"])(
    "blocks the model when %s changes after matching index rows and a concurrent conversation save",
    async (mode) => {
      let revision = 1,
        rpcReturned = false;
      mock.read.mockImplementation(async () => {
        if (rpcReturned && revision === 1) {
          workspace = appendQuestionConversation(workspace);
          if (mode === "archived")
            workspace = {
              ...workspace,
              spaces: workspace.spaces.map((space, index) =>
                index === 0 ? { ...space, archived: true } : space,
              ),
            };
          else
            workspace = {
              ...workspace,
              sources: workspace.sources.map((source, index) => {
                if (index !== 0) return source;
                if (mode === "body") return { ...source, text: `${source.text}\nChanged evidence` };
                if (mode === "permission") return { ...source, aiAllowed: false };
                return { ...source, deletedAt: "2026-09-15T10:00:00.000Z" };
              }),
            };
          expect(workspaceSchema.safeParse(workspace).success).toBe(true);
          revision = 2;
        }
        return { data: { data: structuredClone(workspace), revision }, error: null };
      });
      mock.rpc.mockImplementation(async (_name, args) => {
        const rows = indexedRows(workspace, revision, args);
        expect(rows.length).toBeGreaterThan(0);
        rpcReturned = true;
        return { data: rows, error: null };
      });

      const events = await readEvents(await POST(request())).all();
      expect(events.at(-1)).toMatchObject({ type: "error", code: "QUESTION_CONTEXT_CHANGED" });
      expect(events.some((event) => event.type === "draft" || event.type === "complete")).toBe(
        false,
      );
      expect(mock.callModelStream).not.toHaveBeenCalled();
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.finishRequest).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["auth", "timeout"],
    ["auth", "cancel"],
    ["workspace", "timeout"],
    ["workspace", "cancel"],
    ["body", "timeout"],
    ["body", "cancel"],
  ])(
    "terminates permanently pending %s preflight on %s and ignores late results",
    async (stage, cause) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const auth = deferred<{ data: { user: { id: string } }; error: null }>();
      const cloud = deferred<{ data: { data: WorkspaceData; revision: number }; error: null }>();
      const controller = new AbortController(),
        cancelBody = vi.fn();
      let input = request({}, controller.signal);
      if (stage === "auth") mock.getUser.mockReturnValueOnce(auth.promise);
      if (stage === "workspace") mock.read.mockReturnValueOnce(cloud.promise);
      if (stage === "body") {
        const init: RequestInit & { duplex: "half" } = {
          method: "POST",
          headers: input.headers,
          signal: controller.signal,
          duplex: "half",
          body: new ReadableStream<Uint8Array>({ cancel: cancelBody }),
        };
        input = new Request(input.url, init);
      }
      const pending = POST(input);
      await vi.advanceTimersByTimeAsync(0);
      if (stage === "auth") expect(mock.getUser).toHaveBeenCalledOnce();
      if (stage === "workspace") expect(mock.read).toHaveBeenCalledOnce();
      if (cause === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(ANSWER_STREAM_LIMITS.durationMs);
      // Neither controlled dependency has resolved: this must be the race, not an after-await check.
      const response = await pending;
      expect(response.status).toBe(cause === "cancel" ? 499 : 504);
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(await response.json()).toMatchObject({
        code: cause === "cancel" ? "REQUEST_CANCELLED" : "ANSWER_STREAM_TIMEOUT",
      });
      auth.resolve({ data: { user: { id: owner } }, error: null });
      cloud.resolve({ data: { data: structuredClone(workspace), revision: 1 }, error: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.callModelStream).not.toHaveBeenCalled();
      if (stage === "auth" || stage === "body") expect(mock.read).not.toHaveBeenCalled();
      if (stage === "body") expect(cancelBody).toHaveBeenCalledOnce();
    },
  );
  it.each(["remaining", "expired"])(
    "deducts authentication and workspace preflight time from the stream deadline: %s",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const loading = deferred<{ data: { data: WorkspaceData; revision: number }; error: null }>();
      mock.read.mockReturnValueOnce(loading.promise);
      const modelWaiting = deferred<string>();
      mock.callModelStream.mockReturnValueOnce(modelWaiting.promise);
      const pending = POST(request());
      // Drain the short preflight microtasks until the controlled cloud read begins.
      for (let i = 0; i < 30 && !mock.read.mock.calls.length; i++) await Promise.resolve();
      expect(mock.read).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(mode === "expired" ? 55_001 : 54_000);
      loading.resolve({ data: { data: structuredClone(workspace), revision: 1 }, error: null });
      const response = await pending;
      if (mode === "expired") {
        expect(response.status).toBe(504);
        expect(await response.json()).toMatchObject({ code: "ANSWER_STREAM_TIMEOUT" });
        expect(mock.callModelStream).not.toHaveBeenCalled();
        expect(mock.reserveRequest).not.toHaveBeenCalled();
      } else {
        const events = readEvents(response),
          reading = events.all();
        await vi.advanceTimersByTimeAsync(0);
        expect(mock.callModelStream).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1000);
        expect((await reading).at(-1)).toMatchObject({
          type: "error",
          code: "ANSWER_STREAM_TIMEOUT",
        });
        expect((mock.callModelStream.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
      }
      modelWaiting.resolve(generated);
    },
  );
  it.each(["auth", "account", "json", "schema", "origin"])(
    "keeps %s preflight failures as HTTP JSON statuses",
    async (mode) => {
      let input = request(),
        status = 400;
      if (mode === "auth") {
        currentUser = null;
        status = 401;
      }
      if (mode === "account") {
        input = request({}, undefined, { "X-Conuo-User": "owner-b" });
        status = 409;
      }
      if (mode === "json")
        input = new Request(input.url, { method: "POST", headers: input.headers, body: "{" });
      if (mode === "schema") input = request({ question: "" });
      if (mode === "origin") {
        input = request({}, undefined, { Origin: "https://other.example" });
        status = 403;
      }
      const response = await POST(input);
      expect(response.status).toBe(status);
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(mock.reserveRequest).not.toHaveBeenCalled();
      expect(mock.callModelStream).not.toHaveBeenCalled();
    },
  );
  it("publishes bound cumulative paragraphs before completion and persists only the final answer", async () => {
    const finishModel = deferred();
    mock.callModelStream.mockImplementationOnce(
      async (_c, _m, _s, delta: (value: string) => Promise<void>) => {
        await delta(firstDelta);
        await finishModel.promise;
        await delta(lastDelta);
        return generated;
      },
    );
    const response = await POST(request()),
      events = readEvents(response);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const first = await nextDraft(events);
    expect(first.citations.every((cite) => resolveCitation(workspace, cite))).toBe(true);
    expect(first.content).toContain("训练不稳定");
    expect(first.content).not.toContain("当前资料中的条件");
    expect(mock.finishRequest).not.toHaveBeenCalled();
    expect(mock.callModel).not.toHaveBeenCalled();
    finishModel.resolve();
    const rest = await events.all(),
      last = rest.at(-1);
    expect(
      rest.find((e) => e.type === "draft" && e.answer.content.includes("当前资料中的条件")),
    ).toBeDefined();
    expect(last?.type).toBe("complete");
    if (last?.type !== "complete") throw new Error("No complete");
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "stream-request-1",
      last.answer,
    );
  });
  it("rejects a quantified self-rating before the first streamed draft and records a failed attempt", async () => {
    const selfRated = JSON.stringify({
      status: "answered",
      paragraphs: [{ text: "This answer is 95% reliable.", evidenceIds: ["e1"], kind: "source" }],
    });
    mock.callModelStream.mockImplementationOnce(
      async (_config, _messages, _signal, delta: (value: string) => Promise<void>) => {
        await delta(selfRated);
        return selfRated;
      },
    );

    const events = await readEvents(await POST(request())).all();
    expect(events.some((event) => event.type === "draft")).toBe(false);
    expect(events.some((event) => event.type === "complete")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      status: 502,
      code: "INVALID_MODEL_ANSWER",
      error: expect.stringContaining("不可核验的量化自评"),
    });
    expect(JSON.stringify(events)).not.toContain("95% reliable");
    await vi.waitFor(() => expect(mock.finishRequest).toHaveBeenCalledOnce());
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "stream-request-1",
      undefined,
      "INVALID_MODEL_ANSWER",
    );
  });
  it("terminates an earlier safe draft when a later paragraph contains a self-rating", async () => {
    const selfRatedLastDelta = `${paragraph("Confidence: 95%.")}]}`;
    mock.callModelStream.mockImplementationOnce(
      async (_config, _messages, _signal, delta: (value: string) => Promise<void>) => {
        await delta(firstDelta);
        await delta(selfRatedLastDelta);
        return firstDelta + selfRatedLastDelta;
      },
    );

    const events = await readEvents(await POST(request())).all();
    const drafts = events.filter((event) => event.type === "draft");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      type: "draft",
      answer: { content: expect.stringContaining("学习率过高可能导致训练不稳定") },
    });
    expect(events.some((event) => event.type === "complete")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      status: 502,
      code: "INVALID_MODEL_ANSWER",
    });
    expect(JSON.stringify(events)).not.toContain("Confidence: 95%");
    await vi.waitFor(() => expect(mock.finishRequest).toHaveBeenCalledOnce());
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      store,
      owner,
      "stream-request-1",
      undefined,
      "INVALID_MODEL_ANSWER",
    );
  });
  it("uses complete directly for extractive fallback and a validated cached result", async () => {
    mock.readModelConfig.mockReturnValueOnce(null);
    const fallback = await readEvents(await POST(request())).all();
    expect(fallback.at(-1)).toMatchObject({ type: "complete", answer: { mode: "extractive" } });
    expect(fallback.some((e) => e.type === "draft")).toBe(false);
    expect(mock.reserveRequest).not.toHaveBeenCalled();
    const cached = bindGeneratedAnswer(generated, buildGrounding(workspace, question()));
    mock.reserveRequest.mockResolvedValueOnce({ kind: "cached", result: cached });
    const reused = await readEvents(await POST(request())).all();
    expect(reused.at(-1)).toEqual({ type: "complete", answer: cached });
    expect(reused.some((e) => e.type === "draft")).toBe(false);
    expect(mock.callModelStream).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });
  it.each(["permission", "account", "deleted", "version"])(
    "discards subsequent drafts and fails the reservation after %s changes",
    async (mode) => {
      const response = await POST(request()),
        events = readEvents(response);
      await nextDraft(events);
      // The next callback is backpressured until the reader requests another event.
      if (mode === "permission") workspace.sources[0].aiAllowed = false;
      if (mode === "account") currentUser = "owner-b";
      if (mode === "deleted") workspace.sources[0].deletedAt = new Date().toISOString();
      if (mode === "version") workspace.sources[0].versionId = "new-version";
      const rest = await events.all();
      expect(rest.some((e) => e.type === "draft" || e.type === "complete")).toBe(false);
      expect(rest.at(-1)).toMatchObject({
        type: "error",
        status: 409,
        code: mode === "account" ? "SESSION_CHANGED" : "QUESTION_CONTEXT_CHANGED",
      });
      expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
        store,
        owner,
        "stream-request-1",
        undefined,
        expect.any(String),
      );
      expect((mock.callModelStream.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    },
  );
  it("never emits complete if permissions change during the completion ledger write", async () => {
    const writing = deferred();
    mock.finishRequest.mockReturnValueOnce(writing.promise);
    const events = readEvents(await POST(request())),
      reading = events.all();
    await vi.waitFor(() => expect(mock.finishRequest).toHaveBeenCalledOnce());
    workspace.sources[0].aiAllowed = false;
    writing.resolve();
    expect((await reading).at(-1)).toMatchObject({
      type: "error",
      code: "QUESTION_CONTEXT_CHANGED",
    });
    expect(mock.finishRequest).toHaveBeenCalledOnce();
  });
  it("reports a failed ledger write instead of confirming transient drafts", async () => {
    mock.finishRequest.mockRejectedValueOnce(
      new ApiError(503, "MODEL_RESULT_NOT_SAVED", "保存无法确认"),
    );
    const events = await readEvents(await POST(request())).all();
    expect(events.some((e) => e.type === "draft")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "MODEL_RESULT_NOT_SAVED" });
    expect(events.some((e) => e.type === "complete")).toBe(false);
    expect(mock.finishRequest).toHaveBeenCalledTimes(2);
  });
  it("publishes the original model error before bounded failure-ledger cleanup settles", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    mock.callModelStream.mockRejectedValueOnce(
      new ApiError(503, "MODEL_AUTH", "模型服务认证失败。"),
    );
    mock.finishRequest.mockReturnValue(new Promise(() => {}));
    const events = readEvents(await POST(request()));
    let failure: AnswerStreamEvent | null = null;
    for (let i = 0; i < 3 && !failure; i++) {
      const event = await events.next();
      if (event?.type === "error") failure = event;
      else expect(event?.type).toBe("progress");
    }
    expect(failure).toMatchObject({
      type: "error",
      status: 503,
      code: "MODEL_AUTH",
    });
    for (let i = 0; i < 10 && !mock.finishRequest.mock.calls.length; i++) await Promise.resolve();
    expect(mock.finishRequest).toHaveBeenCalledOnce();
    let closed = false;
    const ending = events.next().then((event) => {
      closed = event === null;
      return event;
    });
    await vi.advanceTimersByTimeAsync(ANSWER_STREAM_LIMITS.cleanupMs - 1);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ending).toBeNull();
    expect(closed).toBe(true);
    expect(mock.finishRequest).toHaveBeenCalledOnce();
    expect(mock.callModelStream).toHaveBeenCalledOnce();
  });
  it.each(["downstream", "request"])(
    "propagates %s cancellation upstream and fails the running ledger",
    async (mode) => {
      const controller = new AbortController(),
        modelWaiting = deferred();
      mock.callModelStream.mockImplementationOnce(
        async (_c, _m, _s, delta: (value: string) => Promise<void>) => {
          await delta(firstDelta);
          await modelWaiting.promise;
          return generated;
        },
      );
      const events = readEvents(await POST(request({}, controller.signal)));
      await nextDraft(events);
      if (mode === "downstream") await events.reader.cancel();
      else controller.abort();
      await vi.waitFor(() =>
        expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
          store,
          owner,
          "stream-request-1",
          undefined,
          "REQUEST_CANCELLED",
        ),
      );
      expect((mock.callModelStream.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
      if (mode === "request")
        expect((await events.all()).at(-1)).toMatchObject({ type: "error", status: 499 });
      modelWaiting.resolve();
    },
  );
  it("fails a reservation that arrives after downstream cancellation without calling the model", async () => {
    const reserve = deferred<{ kind: "reserved" }>();
    mock.reserveRequest.mockReturnValueOnce(reserve.promise);
    const events = readEvents(await POST(request()));
    await events.next();
    await vi.waitFor(() => expect(mock.reserveRequest).toHaveBeenCalledOnce());
    await events.reader.cancel();
    reserve.resolve({ kind: "reserved" });
    await vi.waitFor(() =>
      expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
        store,
        owner,
        "stream-request-1",
        undefined,
        "REQUEST_CANCELLED",
      ),
    );
    expect(mock.callModelStream).not.toHaveBeenCalled();
  });
  it("drops a valid preview when the complete model document is malformed", async () => {
    mock.callModelStream.mockImplementationOnce(
      async (_c, _m, _s, delta: (value: string) => Promise<void>) => {
        await delta(firstDelta);
        return firstDelta;
      },
    );
    const events = await readEvents(await POST(request())).all();
    expect(events.some((e) => e.type === "draft")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502 });
    expect(events.some((e) => e.type === "complete")).toBe(false);
    expect(mock.finishRequest.mock.calls[0][3]).toBeUndefined();
  });
  it("sanitizes unexpected producer errors without leaking model keys, URLs or database messages", async () => {
    mock.callModelStream.mockRejectedValueOnce(
      new Error("server-secret https://secret.example SQL owner_id"),
    );
    const events = await readEvents(await POST(request())).all();
    expect(events.at(-1)).toMatchObject({ type: "error", status: 500, code: "CLOUD_ERROR" });
    expect(JSON.stringify(events)).not.toMatch(/server-secret|secret\.example|owner_id/);
  });
});

describe("bounded server SSE transport", () => {
  it("returns bounded ledger cleanup from downstream cancellation even if the database never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const events = readEvents(
      answerStreamResponse(
        new AbortController().signal,
        async (_signal, send) => {
          await send({ type: "progress", phase: "generating" });
          await new Promise(() => {});
        },
        async () => {
          await new Promise(() => {});
        },
      ),
    );
    await events.next();
    let cleaned = false;
    const cancelling = events.reader.cancel().then(() => {
      cleaned = true;
    });
    await vi.advanceTimersByTimeAsync(ANSWER_STREAM_LIMITS.cleanupMs - 1);
    expect(cleaned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await cancelling;
    expect(cleaned).toBe(true);
  });
  it("does not publish a draft whose disclosure guard resolves after the absolute deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const guard = deferred(),
      entered = deferred();
    const events = readEvents(
      answerStreamResponse(
        new AbortController().signal,
        async (_signal, send) => {
          await send(
            { type: "draft", answer: { mode: "model", content: "late draft", citations: [] } },
            async () => {
              entered.resolve();
              await guard.promise;
            },
          );
        },
        async () => {},
      ),
    );
    const reading = events.all();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(ANSWER_STREAM_LIMITS.durationMs);
    guard.resolve();
    expect(await reading).toEqual([
      expect.objectContaining({ type: "error", code: "ANSWER_STREAM_TIMEOUT" }),
    ]);
  });
  it("enforces a total deadline and aborts a producer that never resolves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let upstream!: AbortSignal;
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const events = readEvents(
      answerStreamResponse(
        new AbortController().signal,
        async (signal, send) => {
          upstream = signal;
          await send({ type: "progress", phase: "generating" });
          await new Promise(() => {});
        },
        cleanup,
      ),
    );
    await events.next();
    await vi.advanceTimersByTimeAsync(ANSWER_STREAM_LIMITS.durationMs);
    expect(await events.next()).toMatchObject({
      type: "error",
      code: "ANSWER_STREAM_TIMEOUT",
      status: 504,
    });
    expect(await events.next()).toBeNull();
    expect(upstream.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it("bounds events and total bytes while preserving space for a sanitized terminal error", async () => {
    for (const count of [1, 40]) {
      const answer: AnswerResult = {
        content: "x".repeat(count === 1 ? ANSWER_STREAM_LIMITS.eventBytes : 500_000),
        citations: [],
        mode: "model",
      };
      const events = readEvents(
        answerStreamResponse(
          new AbortController().signal,
          async (_signal, send) => {
            for (let i = 0; i < count; i++) await send({ type: "draft", answer });
            await send({ type: "complete", answer });
          },
          async () => {},
        ),
      );
      const result = await events.all();
      expect(result.at(-1)).toMatchObject({ type: "error", code: "ANSWER_STREAM_LIMIT" });
      expect(result.filter((e) => e.type === "draft").length).toBeLessThan(count);
    }
  });
  it("does not execute a disclosure guard or advance the producer without reader demand", async () => {
    const guard = vi.fn().mockResolvedValue(undefined),
      advanced = vi.fn(),
      cleanup = vi.fn().mockResolvedValue(undefined);
    const events = readEvents(
      answerStreamResponse(
        new AbortController().signal,
        async (_signal, send) => {
          await send({ type: "progress", phase: "retrieving" });
          await send(
            { type: "draft", answer: { mode: "model", content: "guarded", citations: [] } },
            guard,
          );
          advanced();
        },
        cleanup,
      ),
    );
    await events.next();
    await Promise.resolve();
    await Promise.resolve();
    expect(guard).not.toHaveBeenCalled();
    expect(advanced).not.toHaveBeenCalled();
    await events.reader.cancel();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });
  it("treats consumer cancellation after complete as normal cleanup", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    let signal!: AbortSignal;
    const events = readEvents(
      answerStreamResponse(
        new AbortController().signal,
        async (upstream, send) => {
          signal = upstream;
          await send({
            type: "complete",
            answer: { mode: "extractive", content: "complete", citations: [] },
          });
        },
        cleanup,
      ),
    );
    expect((await events.next())?.type).toBe("complete");
    await events.reader.cancel();
    expect(signal.aborted).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });
});

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local port");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
it("delivers a real HTTP provider paragraph through the actual route socket before upstream completion", async () => {
  const actual = await vi.importActual<typeof import("../ai/model")>("../ai/model");
  mock.callModelStream.mockImplementation(actual.callModelStream);
  const release = deferred(),
    sockets: Server[] = [];
  let providerCompleted = false,
    callCount = 0;
  const provider = createServer((_input, output) => {
    callCount++;
    void (async () => {
      output.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (content: string | undefined, finish: string | null = null) =>
        output.write(
          `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: content === undefined ? {} : { content }, finish_reason: finish }] })}\n\n`,
        );
      frame(firstDelta);
      await release.promise;
      frame(lastDelta);
      frame(undefined, "stop");
      output.end("data: [DONE]\n\n");
      providerCompleted = true;
    })().catch(() => output.destroy());
  });
  sockets.push(provider);
  const relay = createServer((input, output) => {
    const abort = new AbortController();
    output.on("close", () => {
      if (!output.writableEnded) abort.abort();
    });
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of input) chunks.push(Buffer.from(chunk));
      const response = await POST(
        new Request("http://localhost/api/v1/ask", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Conuo-User": owner,
            Accept: "text/event-stream",
          },
          body: Buffer.concat(chunks),
          signal: abort.signal,
        }),
      );
      output.writeHead(response.status, Object.fromEntries(response.headers));
      const reader = response.body!.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!output.write(value)) await once(output, "drain");
        }
        output.end();
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    })().catch(() => output.destroy());
  });
  sockets.push(relay);
  try {
    mock.readModelConfig.mockReturnValue({ ...config, baseUrl: `${await listen(provider)}/v1` });
    const response = await fetch(`${await listen(relay)}/api/v1/ask`, {
      method: "POST",
      body: JSON.stringify(question()),
    });
    const first = deferred<AnswerResult>();
    const reading = readAnswerResponse(response, {
      onProgress: (event) => {
        if (event.type === "draft") first.resolve(event.answer);
      },
    });
    void reading.catch(first.reject);
    const draft = await first.promise;
    expect(draft.content).toContain("训练不稳定");
    expect(providerCompleted).toBe(false);
    expect(mock.finishRequest).not.toHaveBeenCalled();
    release.resolve();
    const final = await reading;
    expect(final.mode).toBe("model");
    expect(final.content).toContain("当前资料中的条件");
    expect(final.citations.every((cite) => resolveCitation(workspace, cite))).toBe(true);
    expect(providerCompleted).toBe(true);
    expect(callCount).toBe(1);
    expect(mock.callModelStream).toHaveBeenCalledOnce();
    expect(mock.finishRequest).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    for (const server of sockets.reverse()) await close(server);
  }
}, 10_000);
