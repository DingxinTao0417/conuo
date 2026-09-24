import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createDemoWorkspace } from "@/lib/seed";
import { ApiError } from "./api";
import type { VisionStudyRequest, VisionStudyResult } from "@/lib/vision-region-contract";
import type { WorkspaceData } from "@/lib/types";

const mock = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  read: vi.fn(),
  rpc: vi.fn(),
  ledgerFrom: vi.fn(),
  ledgerSelect: vi.fn(),
  ledgerLimit: vi.fn(),
  readVisionModelConfig: vi.fn(),
  readModelProfile: vi.fn(),
  callVisionModel: vi.fn(),
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

vi.mock("./server", () => ({
  createClient: async () => ({
    auth: { getUser: mock.getUser },
    from: mock.from,
    rpc: (name: string, args: Record<string, unknown>) =>
      name === "account_deletion_access_status"
        ? Promise.resolve({ data: accountAccess, error: null })
        : mock.rpc(name, args),
  }),
}));
vi.mock("./config", () => ({
  getSupabaseConfig: () => ({ url: "https://example.supabase.co", key: "public-test-key" }),
}));
vi.mock("@/lib/ai/model", () => ({
  readVisionModelConfig: mock.readVisionModelConfig,
  readModelProfile: mock.readModelProfile,
  callVisionModel: mock.callVisionModel,
}));
vi.mock("@/lib/ai/requests", () => ({
  createRequestStore: mock.createRequestStore,
  reserveRequest: mock.reserveRequest,
  finishRequest: mock.finishRequest,
}));

import { GET, POST } from "@/app/api/v1/vision/region-study/route";

const owner = "owner-a";
const config = {
  baseUrl: "https://model.example/v1",
  model: "vision-model",
  apiKey: "server-secret",
  jsonMode: true,
  tokenLimitParameter: "max_tokens",
  timeoutMs: 45_000,
};
const ledger = { from: mock.ledgerFrom };
let workspace: WorkspaceData;
let currentUser: string | null;

function explanation() {
  return {
    task: "explain" as const,
    summary: "这一区域展示了变量之间的关系。",
    sections: [
      { kind: "observation", title: "图中信息", content: "图中出现变量 x、y 与箭头。" },
      { kind: "takeaway", title: "学习要点", content: "先辨认变量，再核对箭头的方向与图中条件。" },
    ],
  };
}

const explanationContent =
  "这一区域展示了变量之间的关系。\n\n## 图中信息\n\n图中出现变量 x、y 与箭头。\n\n## 学习要点\n\n先辨认变量，再核对箭头的方向与图中条件。";

function write32be(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function png(width = 640, height = 480): string {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  write32be(bytes, 8, 13);
  bytes.set([73, 72, 68, 82], 12);
  write32be(bytes, 16, width);
  write32be(bytes, 20, height);
  bytes.set([73, 69, 78, 68], bytes.length - 8);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function payload(patch: Partial<VisionStudyRequest> = {}): VisionStudyRequest {
  const source = workspace.sources[0];
  return {
    requestId: "vision-request-1",
    task: "explain",
    provenance: {
      sourceId: source.id,
      versionId: source.versionId,
      page: 2,
      region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
    },
    image: { dataUrl: png(), width: 640, height: 480 },
    ...patch,
  };
}

function post(input: unknown, signal?: AbortSignal) {
  return new Request("http://localhost/api/v1/vision/region-study", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Conuo-User": owner },
    body: JSON.stringify(input),
    signal,
  });
}

function get() {
  return new Request("http://localhost/api/v1/vision/region-study", {
    headers: { "X-Conuo-User": owner },
  });
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("region visual-learning route", () => {
  beforeEach(() => {
    Object.values(mock).forEach((fn) => fn.mockReset());
    mock.readModelProfile.mockImplementation(() => {
      const config = mock.readVisionModelConfig();
      return config ? { profile: "vision", config } : null;
    });
    workspace = createDemoWorkspace();
    workspace.sources[0].kind = "pdf";
    workspace.sources[0].mime = "application/pdf";
    workspace.sources[0].pageCount = 5;
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
    mock.ledgerFrom.mockReturnValue({ select: mock.ledgerSelect });
    mock.ledgerSelect.mockReturnValue({ limit: mock.ledgerLimit });
    mock.ledgerLimit.mockResolvedValue({ data: [], error: null });
    mock.readVisionModelConfig.mockReturnValue(config);
    mock.createRequestStore.mockReturnValue(ledger);
    mock.reserveRequest.mockResolvedValue({ kind: "reserved" });
    mock.finishRequest.mockResolvedValue(undefined);
    mock.callVisionModel.mockResolvedValue(
      JSON.stringify({
        ...explanation(),
        visibleText: "x 与 y",
      }),
    );
  });

  it("binds a structured explanation to server-owned canonical content and saves the full result", async () => {
    const input = payload();
    const generated = {
      task: "explain",
      visibleText: "x 与 y",
      summary: "这一区域展示了变量之间的关系。",
      sections: [
        { kind: "observation", title: "图中信息", content: "图中出现变量 x、y 与箭头。" },
        { kind: "reasoning", title: "逐步解读", content: "箭头指向 y，提示从 x 到 y 的影响方向。" },
        {
          kind: "takeaway",
          title: "学习要点",
          content: "先辨认变量，再核对箭头的方向与图中条件。",
        },
      ],
    };
    mock.callVisionModel.mockResolvedValueOnce(JSON.stringify(generated));
    const response = await POST(post(input));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({
      mode: "vision",
      provenance: input.provenance,
      ...generated,
      content:
        "这一区域展示了变量之间的关系。\n\n## 图中信息\n\n图中出现变量 x、y 与箭头。\n\n## 逐步解读\n\n箭头指向 y，提示从 x 到 y 的影响方向。\n\n## 学习要点\n\n先辨认变量，再核对箭头的方向与图中条件。",
    });
    expect(mock.callVisionModel).toHaveBeenCalledOnce();
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      ledger,
      owner,
      input.requestId,
      result,
    );
    expect(JSON.stringify(result)).not.toContain(input.image.dataUrl);
  });

  it("sends only the current requested page text and bounded follow-up history", async () => {
    const source = workspace.sources[0];
    source.chunks = [
      { ...source.chunks[0]!, id: "page-two-late", page: 2, order: 2, text: "当前页后半段。" },
      { ...source.chunks[0]!, id: "page-one", page: 1, order: 1, text: "其他页不应发送。" },
      { ...source.chunks[0]!, id: "page-two-early", page: 2, order: 1, text: "当前页前半段。" },
    ];
    const input = payload({
      task: "ask",
      question: "为什么？",
      history: [{ question: "上一问", answer: "上一答" }],
    });
    mock.callVisionModel.mockImplementationOnce(async (_config, messages) => {
      const user = JSON.parse(messages[1].content);
      expect(user.pageText).toBe("当前页前半段。\n\n当前页后半段。");
      expect(user.history).toEqual([{ question: "上一问", answer: "上一答" }]);
      return JSON.stringify({ task: "ask", content: "因为当前页的条件如此。" });
    });
    const response = await POST(post(input));
    expect(response.status).toBe(200);
  });

  it("truncates the current page text layer to 6000 characters", async () => {
    const source = workspace.sources[0];
    source.chunks = [
      { ...source.chunks[0]!, id: "page-two-long", page: 2, order: 1, text: "x".repeat(7000) },
    ];
    const input = payload({ task: "ask", question: "这页写了什么？" });
    mock.callVisionModel.mockImplementationOnce(async (_config, messages) => {
      const user = JSON.parse(messages[1].content);
      expect(user.pageText).toHaveLength(6000);
      return JSON.stringify({ task: "ask", content: "当前页内容已读取。" });
    });
    const response = await POST(post(input));
    expect(response.status).toBe(200);
  });

  it("escapes model section headings while deriving canonical content on the server", async () => {
    const input = payload();
    const generated = explanation();
    generated.sections[0].title = "观察 *变量* [x]";
    mock.callVisionModel.mockResolvedValueOnce(JSON.stringify(generated));
    const response = await POST(post(input));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({
      mode: "vision",
      provenance: input.provenance,
      ...generated,
      content:
        "这一区域展示了变量之间的关系。\n\n## 观察 \\*变量\\* \\[x\\]\n\n图中出现变量 x、y 与箭头。\n\n## 学习要点\n\n先辨认变量，再核对箭头的方向与图中条件。",
    });
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      ledger,
      owner,
      input.requestId,
      result,
    );
  });

  it("rejects a previous plain model explanation and marks the reservation failed without repairing it", async () => {
    const input = payload();
    const original = structuredClone(workspace);
    mock.callVisionModel.mockResolvedValueOnce(
      JSON.stringify({ task: "explain", content: "旧版纯文本模型解读。" }),
    );
    await expectError(await POST(post(input)), 502, "INVALID_VISION_RESULT");
    expect(workspace).toEqual(original);
    expect(mock.reserveRequest).toHaveBeenCalledOnce();
    expect(mock.callVisionModel).toHaveBeenCalledOnce();
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      ledger,
      owner,
      input.requestId,
      undefined,
      "INVALID_VISION_RESULT",
    );
  });

  it.each([
    ["empty summary", () => ({ ...explanation(), summary: "" })],
    ["blank summary", () => ({ ...explanation(), summary: " \n " })],
    ["overlong summary", () => ({ ...explanation(), summary: "s".repeat(1201) })],
    ["missing summary", () => ({ task: "explain", sections: explanation().sections })],
    ["missing sections", () => ({ task: "explain", summary: explanation().summary })],
    ["empty sections", () => ({ ...explanation(), sections: [] })],
    ["one section", () => ({ ...explanation(), sections: [explanation().sections[0]] })],
    [
      "nine sections",
      () => ({
        ...explanation(),
        sections: Array.from({ length: 9 }, (_, index) => ({
          ...explanation().sections[index === 8 ? 1 : 0],
          title: `Part ${index}`,
        })),
      }),
    ],
    [
      "missing observation",
      () => ({
        ...explanation(),
        sections: [{ ...explanation().sections[0], kind: "reasoning" }, explanation().sections[1]],
      }),
    ],
    [
      "missing takeaway",
      () => ({
        ...explanation(),
        sections: [explanation().sections[0], { ...explanation().sections[1], kind: "reasoning" }],
      }),
    ],
    [
      "unknown section kind",
      () => ({
        ...explanation(),
        sections: [{ ...explanation().sections[0], kind: "conclusion" }, explanation().sections[1]],
      }),
    ],
    [
      "empty section title",
      () => ({
        ...explanation(),
        sections: [{ ...explanation().sections[0], title: "" }, explanation().sections[1]],
      }),
    ],
    [
      "overlong section title",
      () => ({
        ...explanation(),
        sections: [
          { ...explanation().sections[0], title: "t".repeat(121) },
          explanation().sections[1],
        ],
      }),
    ],
    [
      "line-feed section title",
      () => ({
        ...explanation(),
        sections: [
          { ...explanation().sections[0], title: "标题\n另一行" },
          explanation().sections[1],
        ],
      }),
    ],
    [
      "carriage-return section title",
      () => ({
        ...explanation(),
        sections: [
          { ...explanation().sections[0], title: "标题\r另一行" },
          explanation().sections[1],
        ],
      }),
    ],
    [
      "empty section content",
      () => ({
        ...explanation(),
        sections: [{ ...explanation().sections[0], content: "" }, explanation().sections[1]],
      }),
    ],
    [
      "overlong section content",
      () => ({
        ...explanation(),
        sections: [
          { ...explanation().sections[0], content: "c".repeat(4001) },
          explanation().sections[1],
        ],
      }),
    ],
    [
      "overlong canonical content from individually valid sections",
      () => ({
        ...explanation(),
        sections: Array.from({ length: 4 }, (_, index) => ({
          kind: index === 0 ? "observation" : index === 3 ? "takeaway" : "reasoning",
          title: `Part ${index}`,
          content: "c".repeat(4000),
        })),
      }),
    ],
    ["model-owned content", () => ({ ...explanation(), content: explanationContent })],
    ["model-owned provenance", () => ({ ...explanation(), provenance: payload().provenance })],
    [
      "extra section metadata",
      () => ({
        ...explanation(),
        sections: [{ ...explanation().sections[0], page: 999 }, explanation().sections[1]],
      }),
    ],
    ["another task", () => ({ task: "ask", content: "这是一段问答结果。" })],
  ] as const)("rejects %s and closes the model reservation", async (_label, make) => {
    const input = payload();
    mock.callVisionModel.mockResolvedValueOnce(JSON.stringify(make()));
    await expectError(await POST(post(input)), 502, "INVALID_VISION_RESULT");
    expect(mock.callVisionModel).toHaveBeenCalledOnce();
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      ledger,
      owner,
      input.requestId,
      undefined,
      "INVALID_VISION_RESULT",
    );
  });

  it("accepts exactly 16000 canonical characters with all individual fields in bounds", async () => {
    const input = payload();
    const generated = {
      task: "explain",
      summary: "S",
      sections: [
        { kind: "observation", title: "A", content: "a".repeat(4000) },
        { kind: "reasoning", title: "B", content: "b".repeat(4000) },
        { kind: "reasoning", title: "C", content: "c".repeat(4000) },
        { kind: "takeaway", title: "D", content: "d".repeat(3967) },
      ],
    };
    mock.callVisionModel.mockResolvedValueOnce(JSON.stringify(generated));
    const response = await POST(post(input));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.content.length).toBe(16000);
    expect(result.summary).toBe("S");
    expect(result.sections).toEqual(generated.sections);
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      ledger,
      owner,
      input.requestId,
      result,
    );
  });

  it("reports readiness only after auth, vision config and ledger access succeed", async () => {
    const response = await GET(get());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: true,
      message: "区域视觉学习配置已就绪；确认操作后才会上传区域图片，实际调用以模型响应为准。",
    });
    expect(mock.ledgerLimit).toHaveBeenCalledOnce();
  });

  it("reports unavailable without accepting image bytes when capability or ledger is missing", async () => {
    mock.readVisionModelConfig.mockReturnValueOnce(null);
    const missingModel = await GET(get());
    expect(await missingModel.json()).toMatchObject({ available: false });
    expect(mock.createRequestStore).not.toHaveBeenCalled();

    mock.createRequestStore.mockImplementationOnce(() => {
      throw new ApiError(503, "MODEL_LEDGER_NOT_CONFIGURED", "private configuration detail");
    });
    const missingLedger = await GET(get());
    const body = await missingLedger.json();
    expect(body).toMatchObject({ available: false });
    expect(JSON.stringify(body)).not.toContain("private configuration detail");
  });

  it("authenticates, reserves the shared ledger and stores a provenance-bound result", async () => {
    const input = payload();
    const response = await POST(post(input));
    expect(response.status).toBe(200);
    const result = (await response.json()) as VisionStudyResult;
    expect(result).toEqual({
      mode: "vision",
      provenance: input.provenance,
      ...explanation(),
      visibleText: "x 与 y",
      content: explanationContent,
    });
    expect(mock.reserveRequest).toHaveBeenCalledWith(
      ledger,
      owner,
      input.requestId,
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(mock.callVisionModel).toHaveBeenCalledWith(
      config,
      expect.any(Array),
      expect.objectContaining({
        mimeType: "image/png",
        base64: expect.not.stringContaining("data:"),
      }),
      expect.any(AbortSignal),
    );
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      ledger,
      owner,
      input.requestId,
      result,
    );
    expect(JSON.stringify(result)).not.toContain(input.image.dataUrl);
  });

  it("gives omitted, enabled and disabled thinking modes distinct provenance-bound ledger identities", async () => {
    const input = payload();
    const imageHash = createHash("sha256")
      .update(Buffer.from(input.image.dataUrl.split(",")[1], "base64"))
      .digest("hex");
    const fingerprints: string[] = [];
    const expected: string[] = [];
    for (const [index, mode] of ([undefined, "enabled", "disabled"] as const).entries()) {
      const effectiveConfig = mode === undefined ? config : { ...config, thinkingMode: mode };
      mock.readVisionModelConfig.mockReturnValue(effectiveConfig);
      const response = await POST(post(input));
      expect(response.status).toBe(200);
      fingerprints.push(mock.reserveRequest.mock.calls[index][3]);
      expected.push(
        createHash("sha256")
          .update(
            JSON.stringify([
              "vision-region-v5",
              config.baseUrl,
              config.model,
              config.jsonMode,
              mode ?? null,
              config.tokenLimitParameter,
              "vision",
              input.task,
              input.question ?? null,
              input.provenance,
              null,
              null,
              "image/png",
              input.image.width,
              input.image.height,
              imageHash,
            ]),
          )
          .digest("hex"),
      );
      expect(mock.callVisionModel.mock.calls[index][0]).toEqual(effectiveConfig);
    }
    expect(new Set(fingerprints).size).toBe(3);
    expect(fingerprints).toEqual(expected);
    expect(mock.reserveRequest).toHaveBeenCalledTimes(3);
    expect(mock.callVisionModel).toHaveBeenCalledTimes(3);
    expect(mock.finishRequest).toHaveBeenCalledTimes(3);
  });

  it.each([
    [undefined, "enabled"],
    [undefined, "disabled"],
    ["enabled", "disabled"],
  ] as const)(
    "rejects a cached request when thinking changes from %s to %s",
    async (before, after) => {
      mock.readVisionModelConfig.mockReturnValue(
        before === undefined ? config : { ...config, thinkingMode: before },
      );
      const first = await POST(post(payload()));
      expect(first.status).toBe(200);
      const cached = await first.json();
      const firstFingerprint = mock.reserveRequest.mock.calls[0][3];
      mock.reserveRequest.mockImplementationOnce(async (_ledger, _owner, _request, fingerprint) => {
        if (fingerprint === firstFingerprint) return { kind: "cached", result: cached };
        throw new ApiError(409, "REQUEST_CHANGED", "请重新发起模型请求。");
      });
      mock.readVisionModelConfig.mockReturnValue({ ...config, thinkingMode: after });
      await expectError(await POST(post(payload())), 409, "REQUEST_CHANGED");
      expect(mock.reserveRequest.mock.calls[1][3]).not.toBe(firstFingerprint);
      expect(mock.callVisionModel).toHaveBeenCalledOnce();
      expect(mock.finishRequest).toHaveBeenCalledOnce();
    },
  );

  it("does not reuse a completed result from the previous language semantics", async () => {
    const input = payload({ task: "quiz" });
    const imageBytes = Buffer.from(input.image.dataUrl.split(",")[1], "base64");
    // This is the deployed v1 ledger identity, before the Chinese-default policy.
    const oldFingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          "vision-region-v1",
          config.baseUrl,
          config.model,
          config.jsonMode,
          config.tokenLimitParameter,
          input.task,
          null,
          input.provenance,
          "image/png",
          input.image.width,
          input.image.height,
          createHash("sha256").update(imageBytes).digest("hex"),
        ]),
      )
      .digest("hex");
    mock.reserveRequest.mockImplementationOnce(
      async (_store: unknown, _owner: string, _requestId: string, fingerprint: string) => {
        if (fingerprint !== oldFingerprint)
          throw new ApiError(409, "REQUEST_CHANGED", "请重新发起模型请求。");
        return {
          kind: "cached",
          result: {
            mode: "vision",
            task: "quiz",
            provenance: input.provenance,
            questions: [
              { question: "What is x?", answer: "A variable.", explanation: "It varies." },
            ],
          },
        };
      },
    );
    await expectError(await POST(post(input)), 409, "REQUEST_CHANGED");
    expect(mock.reserveRequest.mock.calls[0][3]).not.toBe(oldFingerprint);
    expect(mock.callVisionModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });

  it.each([undefined, "enabled", "disabled"] as const)(
    "isolates the structured v3 explanation from a plain v2 cache with thinking %s",
    async (mode) => {
      const input = payload();
      const imageBytes = Buffer.from(input.image.dataUrl.split(",")[1], "base64");
      const oldFingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            "vision-region-v2",
            config.baseUrl,
            config.model,
            config.jsonMode,
            mode ?? null,
            config.tokenLimitParameter,
            input.task,
            input.question ?? null,
            input.provenance,
            "image/png",
            input.image.width,
            input.image.height,
            createHash("sha256").update(imageBytes).digest("hex"),
          ]),
        )
        .digest("hex");
      mock.readVisionModelConfig.mockReturnValue(
        mode === undefined ? config : { ...config, thinkingMode: mode },
      );
      mock.reserveRequest.mockImplementationOnce(async (_ledger, _owner, _request, fingerprint) => {
        if (fingerprint === oldFingerprint)
          return {
            kind: "cached",
            result: {
              mode: "vision",
              task: "explain",
              provenance: input.provenance,
              content: "合法的旧版纯文本公共解读。",
            },
          };
        throw new ApiError(409, "REQUEST_CHANGED", "请重新发起模型请求。");
      });
      await expectError(await POST(post(input)), 409, "REQUEST_CHANGED");
      expect(mock.reserveRequest.mock.calls[0][3]).not.toBe(oldFingerprint);
      expect(mock.callVisionModel).not.toHaveBeenCalled();
      expect(mock.finishRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["explain", "ask", "quiz", "grade_work"] as const)(
    "publishes and records %s for a scan with no indexed text or transcription",
    async (task) => {
      const source = workspace.sources[0];
      source.text = "";
      source.chunks = [];
      source.status = "failed";
      source.parsedPages = 0;
      source.coverage = {
        captureScope: "full",
        parseState: "failed",
        unavailablePageRanges: [{ start: 1, end: source.pageCount! }],
      };
      source.error = "扫描 PDF 暂无可提取正文，可查看原页并框选区域。";
      const input = payload(task === "ask" ? { task, question: "箭头的含义是什么？" } : { task });
      const generated =
        task === "quiz"
          ? {
              task,
              questions: [
                {
                  question: "箭头表示什么？",
                  answer: "影响方向。",
                  explanation: "图示中的箭头指向结果。",
                },
              ],
            }
          : task === "grade_work"
            ? {
                task,
                problem: "解方程 2x + 1 = 5。",
                steps: [
                  { index: 1, transcription: "2x + 1 = 5", verdict: "ok", comment: "抄写正确。" },
                  { index: 2, transcription: "2x = 4", verdict: "ok", comment: "两边同时减 1。" },
                  { index: 3, transcription: "x = 3", verdict: "error", comment: "应为 x = 2。" },
                ],
                firstErrorStep: 3,
                overall: "partially_correct",
                hint: "检查最后一步除以 2 的计算。",
              }
            : task === "explain"
              ? explanation()
              : { task, content: "箭头表示图中变量之间的影响方向。" };
      mock.callVisionModel.mockResolvedValueOnce(JSON.stringify(generated));

      const response = await POST(post(input));
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toEqual({
        mode: "vision",
        provenance: input.provenance,
        ...generated,
        ...(task === "explain" ? { content: explanationContent } : {}),
      });
      expect(result).not.toHaveProperty("visibleText");
      if (task === "grade_work") {
        const system = mock.callVisionModel.mock.calls[0][1][0].content;
        expect(system).toContain("transcribe each visible handwritten step in order");
        expect(system).toContain("Do not provide the complete solution");
      }
      expect(mock.callVisionModel).toHaveBeenCalledExactlyOnceWith(
        config,
        expect.any(Array),
        { mimeType: "image/png", base64: input.image.dataUrl.split(",")[1] },
        expect.any(AbortSignal),
      );
      expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
        ledger,
        owner,
        input.requestId,
        result,
      );
      expect(JSON.stringify(result)).not.toContain(input.image.dataUrl);
    },
  );

  it("never calls a model when the privileged ledger is unavailable", async () => {
    mock.createRequestStore.mockImplementationOnce(() => {
      throw new ApiError(503, "MODEL_LEDGER_NOT_CONFIGURED", "ledger unavailable");
    });
    await expectError(await POST(post(payload())), 503, "MODEL_LEDGER_NOT_CONFIGURED");
    expect(mock.reserveRequest).not.toHaveBeenCalled();
    expect(mock.callVisionModel).not.toHaveBeenCalled();
  });

  it.each([
    [
      "external URL",
      () =>
        payload({ image: { dataUrl: "https://attacker.example/a.png", width: 640, height: 480 } }),
      "INVALID_VISION_IMAGE",
    ],
    [
      "non-PDF source",
      () => {
        workspace.sources[0].kind = "markdown";
        return payload();
      },
      "VISION_PDF_REQUIRED",
    ],
    [
      "changed version",
      () => {
        const value = payload();
        workspace.sources[0].versionId = "new-version";
        return value;
      },
      "VISION_SOURCE_VERSION_CHANGED",
    ],
    [
      "disabled source AI",
      () => {
        workspace.sources[0].aiAllowed = false;
        return payload();
      },
      "SOURCE_AI_DISABLED",
    ],
  ])("rejects %s before sending pixels", async (_label, make, code) => {
    await expectError(
      await POST(post(make())),
      code === "VISION_PDF_REQUIRED"
        ? 422
        : code === "SOURCE_AI_DISABLED"
          ? 403
          : code === "VISION_SOURCE_VERSION_CHANGED"
            ? 409
            : 400,
      code,
    );
    expect(mock.callVisionModel).not.toHaveBeenCalled();
  });

  it("revalidates permission after a reservation wait and closes the ledger entry", async () => {
    const waiting = deferred<{ kind: "reserved" }>();
    mock.reserveRequest.mockReturnValueOnce(waiting.promise);
    const pending = POST(post(payload()));
    await vi.waitFor(() => expect(mock.reserveRequest).toHaveBeenCalledOnce());
    workspace.sources[0].aiAllowed = false;
    waiting.resolve({ kind: "reserved" });
    await expectError(await pending, 403, "SOURCE_AI_DISABLED");
    expect(mock.callVisionModel).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(mock.finishRequest).toHaveBeenCalledWith(
        ledger,
        owner,
        "vision-request-1",
        undefined,
        "SOURCE_AI_DISABLED",
      ),
    );
  });

  it("reuses only a cached result with the exact task and provenance", async () => {
    const input = payload();
    mock.reserveRequest.mockResolvedValueOnce({
      kind: "cached",
      result: {
        mode: "vision",
        task: "explain",
        provenance: input.provenance,
        content: "缓存解释",
      },
    });
    const response = await POST(post(input));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: "缓存解释" });
    expect(mock.callVisionModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();

    mock.reserveRequest.mockResolvedValueOnce({
      kind: "cached",
      result: {
        mode: "vision",
        task: "explain",
        provenance: { ...input.provenance, page: 3 },
        content: "错绑缓存",
      },
    });
    await expectError(await POST(post(input)), 503, "INVALID_SAVED_VISION_RESULT");
    expect(mock.callVisionModel).not.toHaveBeenCalled();
  });

  it("restores a canonical structured public result without another model call or ledger write", async () => {
    const input = payload();
    const cached = {
      mode: "vision",
      provenance: input.provenance,
      ...explanation(),
      content: explanationContent,
    };
    mock.reserveRequest.mockResolvedValueOnce({ kind: "cached", result: cached });
    const response = await POST(post(input));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cached);
    expect(mock.callVisionModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["summary without sections", () => ({ ...explanation(), sections: undefined })],
    ["sections without summary", () => ({ ...explanation(), summary: undefined })],
    ["summary mismatched with content", () => ({ ...explanation(), summary: "变更后的摘要。" })],
    [
      "section content mismatched with content",
      () => ({
        ...explanation(),
        sections: [
          { ...explanation().sections[0], content: "变更后的观察内容。" },
          explanation().sections[1],
        ],
      }),
    ],
    [
      "section title mismatched with content",
      () => ({
        ...explanation(),
        sections: [{ ...explanation().sections[0], title: "另一标题" }, explanation().sections[1]],
      }),
    ],
    [
      "server content mismatched with structured fields",
      () => ({ ...explanation(), content: "另一段仍符合纯文本长度限制的解释。" }),
    ],
    ["extra public metadata", () => ({ ...explanation(), page: 999 })],
  ] as const)("rejects cached %s without replaying or repairing it", async (_label, make) => {
    const input = payload();
    mock.reserveRequest.mockResolvedValueOnce({
      kind: "cached",
      result: {
        mode: "vision",
        provenance: input.provenance,
        content: explanationContent,
        ...make(),
      },
    });
    await expectError(await POST(post(input)), 503, "INVALID_SAVED_VISION_RESULT");
    expect(mock.callVisionModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });

  it("does not save or return a result when provenance changes during generation", async () => {
    const generated = deferred<string>();
    mock.callVisionModel.mockReturnValueOnce(generated.promise);
    const pending = POST(post(payload()));
    await vi.waitFor(() => expect(mock.callVisionModel).toHaveBeenCalledOnce());
    workspace.sources[0].versionId = "replacement-version";
    generated.resolve(JSON.stringify(explanation()));
    await expectError(await pending, 409, "VISION_SOURCE_VERSION_CHANGED");
    await vi.waitFor(() =>
      expect(mock.finishRequest).toHaveBeenCalledWith(
        ledger,
        owner,
        "vision-request-1",
        undefined,
        "VISION_SOURCE_VERSION_CHANGED",
      ),
    );
  });

  it("marks a reserved request failed when the learner cancels generation", async () => {
    const generated = deferred<string>();
    mock.callVisionModel.mockReturnValueOnce(generated.promise);
    const controller = new AbortController();
    const pending = POST(post(payload(), controller.signal));
    await vi.waitFor(() => expect(mock.callVisionModel).toHaveBeenCalledOnce());
    controller.abort();
    generated.resolve(JSON.stringify(explanation()));
    await expectError(await pending, 499, "REQUEST_CANCELLED");
    expect(mock.finishRequest).toHaveBeenCalledExactlyOnceWith(
      ledger,
      owner,
      "vision-request-1",
      undefined,
      "REQUEST_CANCELLED",
    );
  });

  it("bounds a stalled failure-ledger write before returning the original safe error", async () => {
    vi.useFakeTimers();
    try {
      mock.callVisionModel.mockRejectedValueOnce(
        new ApiError(503, "MODEL_UNAVAILABLE", "模型服务暂时不可用，请稍后重试。"),
      );
      mock.finishRequest.mockReturnValueOnce(new Promise<void>(() => undefined));
      const pending = POST(post(payload()));
      for (let index = 0; index < 20 && !mock.finishRequest.mock.calls.length; index += 1)
        await Promise.resolve();
      expect(mock.finishRequest).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_000);
      await expectError(await pending, 503, "MODEL_UNAVAILABLE");
    } finally {
      vi.useRealTimers();
    }
  });
});
