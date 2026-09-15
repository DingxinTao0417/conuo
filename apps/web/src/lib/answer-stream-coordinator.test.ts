import { describe, expect, it, vi } from "vitest";
import { WorkspaceCoordinator, type WorkspaceIO } from "./use-workspace";
import { createDemoWorkspace } from "./seed";
import { retrieveEvidence } from "./retrieval";
import type { AnswerRequest, AnswerResult, Citation, WorkspaceData } from "./types";
import type { AnswerProgress, OnAnswerProgress } from "./answer-stream-types";

vi.mock("./cloud", () => ({
  askCloud: vi.fn(),
  cancelOrganizationJob: vi.fn(),
  cancelImportParse: vi.fn(),
  claimImportParse: vi.fn(),
  enqueueOrganizationJob: vi.fn(),
  finishImportParse: vi.fn(),
  heartbeatImportParse: vi.fn(),
  releaseImportParse: vi.fn(),
  retryImportParse: vi.fn(),
  organizeCloud: vi.fn(),
  getModelStatus: vi.fn(),
  downloadSourceBlob: vi.fn(),
  isCloudConfigured: () => false,
  loadCloudWorkspace: vi.fn(),
  previewSourcePurge: vi.fn(),
  requestSourcePurge: vi.fn(),
  previewSourceVersionPurge: vi.fn(),
  requestSourceVersionPurge: vi.fn(),
  reconcileOrganizationJobs: vi.fn(),
  saveCloudWorkspace: vi.fn(),
  subscribeSession: vi.fn(),
  uploadSourceBlob: vi.fn(),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(options: { local?: boolean; patch?: (data: WorkspaceData) => void } = {}) {
  const workspace = createDemoWorkspace();
  options.patch?.(workspace);
  const network = deferred<AnswerResult>();
  let report!: OnAnswerProgress;
  let networkSignal!: AbortSignal;
  const io: WorkspaceIO = {
    loadLocal: vi.fn(async () => (options.local ? structuredClone(workspace) : null)),
    saveLocal: vi.fn(async () => {}),
    loadCloud: vi.fn(async () => ({ data: structuredClone(workspace), revision: 1 })),
    saveCloud: vi.fn(async (_data, revision) => ({ revision: revision + 1 })),
    getBlob: vi.fn(async () => undefined),
    uploadBlob: vi.fn(async () => "path"),
    downloadBlob: vi.fn(async () => undefined),
    askCloud: vi.fn(async (_request, signal, _user, progress) => {
      report = progress!;
      networkSignal = signal!;
      return network.promise;
    }),
    organizeCloud: vi.fn(),
    getModelStatus: vi.fn(async () => ({ mode: "model", message: "fixture" })),
    readLegacyMeta: () => null,
  };
  const coordinator = new WorkspaceCoordinator(io);
  await coordinator.activate(options.local ? null : { id: "A", email: "a@example.test" });
  vi.mocked(io.saveLocal).mockClear();
  vi.mocked(io.saveCloud).mockClear();
  const request: AnswerRequest = {
    question: "学习率过高会怎样？",
    scope: "document",
    spaceId: workspace.spaces[0].id,
    sourceId: workspace.sources[0].id,
    sourceIds: [],
  };
  const result: AnswerResult = { ...retrieveEvidence(workspace, request), mode: "model" };
  const controller = new AbortController();
  const progress = vi.fn<OnAnswerProgress>();
  const start = async (callback: OnAnswerProgress = progress, selected = request) => {
    const outcome = coordinator
      .ask(selected, controller.signal, coordinator.getSnapshot().token, callback)
      .then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
    if (!options.local) await vi.waitFor(() => expect(io.askCloud).toHaveBeenCalledOnce());
    return {
      outcome,
      emit: (event: AnswerProgress) => report(event),
      networkSignal: () => networkSignal,
    };
  };
  const update = (change: (data: WorkspaceData) => void) =>
    coordinator.update((data) => {
      const next = structuredClone(data);
      change(next);
      return next;
    }, coordinator.getSnapshot().token);
  return {
    coordinator,
    io,
    workspace,
    request,
    result,
    network,
    controller,
    progress,
    start,
    update,
  };
}

describe("transient question progress and current evidence boundary", () => {
  it("drafts never enter workspace or save queues; only complete returns to the caller", async () => {
    const f = await fixture();
    const before = structuredClone(f.coordinator.getSnapshot().data);
    const run = await f.start();
    run.emit({ type: "progress", phase: "retrieving" });
    run.emit({ type: "draft", answer: f.result });
    expect(f.progress).toHaveBeenCalledTimes(2);
    expect(f.coordinator.getSnapshot().data).toEqual(before);
    expect(f.io.saveLocal).not.toHaveBeenCalled();
    expect(f.io.saveCloud).not.toHaveBeenCalled();
    f.network.resolve(f.result);
    expect(await run.outcome).toEqual({ value: f.result, error: null });
    expect(f.coordinator.getSnapshot().data.conversations).toEqual(before.conversations);
    expect(f.io.saveLocal).not.toHaveBeenCalled();
    run.emit({ type: "draft", answer: f.result });
    expect(f.progress).toHaveBeenCalledTimes(2);
  });

  it("callback receives an isolated value and cannot mutate the final answer or source", async () => {
    const f = await fixture();
    const original = structuredClone(f.result);
    const run = await f.start((event) => {
      if (event.type === "draft") {
        event.answer.content = "mutated";
        event.answer.citations[0].quote = "mutated";
      }
    });
    run.emit({ type: "draft", answer: f.result });
    f.network.resolve(f.result);
    expect((await run.outcome).value).toEqual(original);
    expect(f.result).toEqual(original);
  });

  it.each<[string, (data: WorkspaceData) => void]>([
    [
      "global permission",
      (data) => {
        data.aiEnabled = false;
      },
    ],
    [
      "source permission",
      (data) => {
        data.sources[0].aiAllowed = false;
      },
    ],
    [
      "deleted source",
      (data) => {
        data.sources[0].deletedAt = new Date().toISOString();
      },
    ],
    [
      "new version",
      (data) => {
        data.sources[0].versionId = "new-version";
      },
    ],
    [
      "source moved",
      (data) => {
        data.sources[0].spaceIds = [];
      },
    ],
    [
      "archived space",
      (data) => {
        data.spaces[0].archived = true;
      },
    ],
  ])("stops draft and complete after %s changes", async (_name, change) => {
    const f = await fixture();
    const run = await f.start();
    run.emit({ type: "draft", answer: f.result });
    f.update(change);
    expect((await run.outcome).error).toBeInstanceOf(Error);
    expect(run.networkSignal().aborted).toBe(true);
    run.emit({ type: "draft", answer: f.result });
    f.network.resolve(f.result);
    expect(f.progress).toHaveBeenCalledOnce();
    expect(f.coordinator.getSnapshot().data.conversations).toHaveLength(0);
  });

  it("checks raw context changes at callback time even without a publish notification", async () => {
    const f = await fixture();
    const run = await f.start();
    f.coordinator.getSnapshot().data.sources[0].aiAllowed = false;
    expect(() => run.emit({ type: "draft", answer: f.result })).not.toThrow();
    expect((await run.outcome).error).toBeInstanceOf(Error);
    expect(f.progress).not.toHaveBeenCalled();
  });

  it("checks again after a callback changes the scope and suppresses later output", async () => {
    const f = await fixture();
    const callback = vi.fn(() =>
      f.update((data) => {
        data.sources[0].aiAllowed = false;
      }),
    );
    const run = await f.start(callback);
    run.emit({ type: "draft", answer: f.result });
    expect((await run.outcome).error).toBeInstanceOf(Error);
    run.emit({ type: "progress", phase: "validating" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("account switch blocks all subsequent updates even if the adapter ignores abort", async () => {
    const f = await fixture();
    const run = await f.start();
    run.emit({ type: "draft", answer: f.result });
    await f.coordinator.activate({ id: "B", email: "b@example.test" });
    expect((await run.outcome).error).toBeInstanceOf(Error);
    run.emit({ type: "draft", answer: f.result });
    f.network.resolve(f.result);
    expect(f.progress).toHaveBeenCalledOnce();
    expect(f.coordinator.getSnapshot().user?.id).toBe("B");
  });

  it.each<[string, (citation: Citation) => void]>([
    [
      "quote",
      (citation) => {
        citation.quote += " forged";
      },
    ],
    [
      "version",
      (citation) => {
        citation.versionId = "historic-version";
      },
    ],
    [
      "chunk",
      (citation) => {
        citation.chunkId = "foreign-chunk";
      },
    ],
    [
      "title",
      (citation) => {
        citation.title = "forged title";
      },
    ],
    [
      "page",
      (citation) => {
        citation.page = 99;
      },
    ],
    [
      "section",
      (citation) => {
        citation.section = "forged section";
      },
    ],
  ])("rejects a draft with mismatched canonical %s", async (_name, change) => {
    const f = await fixture();
    const run = await f.start();
    const wrong = structuredClone(f.result);
    change(wrong.citations[0]);
    expect(() => run.emit({ type: "draft", answer: wrong })).not.toThrow();
    expect((await run.outcome).error).toBeInstanceOf(Error);
    expect(f.progress).not.toHaveBeenCalled();
    expect(run.networkSignal().aborted).toBe(true);
  });

  it("rejects genuine evidence from a source outside this document scope", async () => {
    const f = await fixture();
    const run = await f.start();
    const outside = f.workspace.sources[1];
    const chunk = outside.chunks[0];
    const citation = {
      sourceId: outside.id,
      versionId: outside.versionId,
      chunkId: chunk.id,
      title: outside.title,
      quote: chunk.text,
      page: chunk.page,
      section: chunk.section,
    };
    run.emit({ type: "draft", answer: { ...f.result, citations: [citation] } });
    expect((await run.outcome).error).toBeInstanceOf(Error);
    expect(f.progress).not.toHaveBeenCalled();
  });

  it("accepts canonical chunk quotes when source text differs only by normalized whitespace", async () => {
    const f = await fixture({
      patch: (data) => {
        data.sources[0].text = data.sources[0].text.replace(/\n/g, "\n  \t");
      },
    });
    const run = await f.start();
    expect(f.result.citations.length).toBeGreaterThan(0);
    run.emit({ type: "draft", answer: f.result });
    f.network.resolve(f.result);
    expect((await run.outcome).value).toEqual(f.result);
    expect(f.progress).toHaveBeenCalledOnce();
  });

  it("rejects a chunk that is absent from the current source text", async () => {
    const f = await fixture();
    const run = await f.start();
    // A tampered canonical chunk is never sufficient just because its ID exists.
    const data = f.coordinator.getSnapshot().data;
    const chunk = data.sources[0].chunks.find((item) => item.id === f.result.citations[0].chunkId)!;
    chunk.text = "unrelated material";
    run.emit({
      type: "draft",
      answer: { ...f.result, citations: [{ ...f.result.citations[0], quote: chunk.text }] },
    });
    expect((await run.outcome).error).toBeInstanceOf(Error);
    expect(f.progress).not.toHaveBeenCalled();
  });

  it("validates final JSON/complete citations even when no drafts arrive", async () => {
    const f = await fixture();
    const run = await f.start();
    f.network.resolve({ ...f.result, citations: [{ ...f.result.citations[0], title: "forged" }] });
    expect((await run.outcome).error).toBeInstanceOf(Error);
    expect(f.io.saveLocal).not.toHaveBeenCalled();
  });

  it("rejects invalid progress shape without uncaught callbacks", async () => {
    const f = await fixture();
    const run = await f.start();
    expect(() =>
      run.emit({ type: "progress", phase: "unknown" } as unknown as AnswerProgress),
    ).not.toThrow();
    expect((await run.outcome).error).toBeInstanceOf(Error);
  });

  it("ignores callbacks after cancellation or transport failure", async () => {
    for (const cancel of [true, false]) {
      const f = await fixture();
      const run = await f.start();
      if (cancel) f.controller.abort();
      else f.network.reject(new Error("broken connection"));
      expect((await run.outcome).error).toBeInstanceOf(Error);
      run.emit({ type: "draft", answer: f.result });
      expect(f.progress).not.toHaveBeenCalled();
    }
  });

  it("unrelated reading progress and note edits do not interrupt a valid stream", async () => {
    const f = await fixture();
    const run = await f.start();
    f.update((data) => {
      data.sources[0].readOffset = 100;
      data.notes.push({
        id: "note",
        spaceId: data.spaces[0].id,
        title: "个人笔记",
        content: "已编辑",
        kind: "note",
        status: "accepted",
        citations: [],
        versions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });
    });
    run.emit({ type: "draft", answer: f.result });
    f.network.resolve(f.result);
    expect((await run.outcome).value).toEqual(f.result);
    expect(f.progress).toHaveBeenCalledOnce();
  });

  it("local extractive answers do not call cloud or simulate a stream", async () => {
    const f = await fixture({ local: true });
    const run = await f.start();
    expect((await run.outcome).value?.mode).toBe("extractive");
    expect(f.progress).not.toHaveBeenCalled();
    expect(f.io.askCloud).not.toHaveBeenCalled();
  });

  it("disabled global AI suppresses progress and extractive drafts", async () => {
    const f = await fixture({
      patch: (data) => {
        data.aiEnabled = false;
      },
    });
    const run = await f.start();
    const result: AnswerResult = { content: "AI 功能已关闭。", citations: [], mode: "extractive" };
    run.emit({ type: "progress", phase: "generating" });
    run.emit({ type: "draft", answer: result });
    f.network.resolve(result);
    expect((await run.outcome).value).toEqual(result);
    expect(f.progress).not.toHaveBeenCalled();
  });
});
