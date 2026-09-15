// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileReplacementForm, { type FileReplacementFormProps } from "./file-replacement-form";
import { prepareFile } from "@/lib/import";
import type { Source } from "@/lib/types";

vi.mock("@/lib/import", () => ({ prepareFile: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function source(overrides: Partial<Source> = {}): Source {
  return {
    id: "source-one",
    versionId: "version-one",
    title: "保留的资料名称",
    filename: "old.txt",
    kind: "text",
    mime: "text/plain",
    size: 12,
    hash: "old-hash",
    spaceIds: ["space-one"],
    tags: ["学习"],
    status: "ready",
    text: "旧正文",
    chunks: [],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    ...overrides,
  };
}
function candidate(overrides: Partial<Source> = {}): Source {
  return source({
    id: "candidate-id",
    versionId: "candidate-version",
    title: "新文件默认名称",
    filename: "new.pdf",
    kind: "pdf",
    mime: "application/pdf",
    size: 4096,
    hash: "new-hash",
    blobKey: "new-original",
    pageCount: 2,
    parsedPages: 2,
    text: "新文件的解析正文",
    chunks: [
      {
        id: "new-chunk",
        sourceId: "candidate-id",
        versionId: "candidate-version",
        text: "新文件的解析正文",
        section: "第一页",
        order: 0,
        page: 1,
      },
    ],
    ...overrides,
  });
}

describe("FileReplacementForm confirmation and asynchronous boundaries", () => {
  let host: HTMLDivElement;
  let root: Root | null;
  let props: FileReplacementFormProps;
  let prepared: ReturnType<typeof deferred<Source>>[];
  const prepareMock = vi.mocked(prepareFile);

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    prepared = [];
    prepareMock.mockReset().mockImplementation(() => {
      const request = deferred<Source>();
      prepared.push(request);
      return request.promise;
    });
    props = {
      source: source(),
      targetSpaceId: "space-one",
      cloudUserId: "account-one",
      onReplace: vi.fn(async () => {}),
      onSaved: vi.fn(),
      onCancel: vi.fn(),
      onViewHistory: vi.fn(),
    };
  });
  afterEach(async () => {
    if (root)
      await act(async () => {
        root!.unmount();
        root = null;
      });
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(overrides: Partial<FileReplacementFormProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => {
      root!.render(createElement(FileReplacementForm, props));
    });
  }
  function button(label: string) {
    const match = [...host.querySelectorAll("button")].filter(
      (item) => item.textContent?.replace(/\s+/g, "") === label.replace(/\s+/g, ""),
    );
    expect(match, `button ${label}`).toHaveLength(1);
    return match[0];
  }
  async function click(control: HTMLElement) {
    await act(async () => {
      control.click();
    });
  }
  async function choose(name = "new.pdf") {
    const file = new File(["original bytes"], name, { type: "application/pdf" });
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return { file, request: prepared.at(-1)! };
  }
  async function ready(value = candidate()) {
    await render();
    const pending = await choose(value.filename);
    await act(async () => {
      pending.request.resolve(value);
    });
    return pending;
  }

  it("only previews until explicit confirmation, preserving the name and passing the actual original with expected version", async () => {
    const { file } = await ready();
    expect(prepareMock).toHaveBeenCalledWith(file, "space-one");
    expect(props.onReplace).not.toHaveBeenCalled();
    expect(host.textContent).toContain("new.pdf");
    expect(host.textContent).toContain("PDF");
    expect(host.textContent).toContain("4.0 KB");
    expect(host.textContent).toContain("2 / 2 页已解析");
    expect(host.querySelector("textarea")!.value).toBe("新文件的解析正文");
    expect(button("保存为新版本").disabled).toBe(false);
    await click(button("保存为新版本"));
    expect(props.onReplace).toHaveBeenCalledWith(
      expect.objectContaining({
        title: props.source.title,
        filename: "new.pdf",
        blobKey: "new-original",
        versionId: "candidate-version",
      }),
      file,
      props.source.versionId,
    );
    expect(props.onSaved).toHaveBeenCalledOnce();
  });

  it.each(["partial", "failed"] as const)(
    "requires explicit coverage acknowledgement for %s before saving the original",
    async (status) => {
      await ready(
        candidate({
          status,
          text: status === "failed" ? "" : "部分正文",
          chunks: status === "failed" ? [] : candidate().chunks,
          parsedPages: status === "failed" ? 0 : 1,
          error: "原文件尚未保存，部分页面无法解析。",
        }),
      );
      expect(button("保存为新版本").disabled).toBe(true);
      await act(async () => {
        host
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(props.onReplace).not.toHaveBeenCalled();
      expect(host.textContent).toContain(
        status === "failed" ? "新问答无法使用" : "新问答只使用已解析内容",
      );
      await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
      expect(button("保存为新版本").disabled).toBe(false);
      await click(button("保存为新版本"));
      expect(props.onReplace).toHaveBeenCalledOnce();
    },
  );

  it("rejects unchanged current file contents and offers history or cancellation", async () => {
    await ready(candidate({ hash: props.source.hash }));
    expect(host.textContent).toContain("内容与当前文件相同");
    expect(button("保存为新版本").disabled).toBe(true);
    await click(button("查看版本历史"));
    expect(props.onViewHistory).toHaveBeenCalledOnce();
    expect(props.onReplace).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="新文件预览"]')).toBeNull();
  });

  it("requires an explicit restore confirmation for content matching a retained historical file", async () => {
    const old = candidate({ filename: "earlier.pdf" });
    props.source.versions = [{ ...old, archivedAt: "2026-09-13T00:00:00.000Z" }];
    await ready();
    expect(host.textContent).toContain("内容与历史版本");
    expect(host.textContent).toContain("earlier.pdf");
    expect(button("保存为新版本").disabled).toBe(true);
    await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(button("保存为新版本"));
    expect(props.onReplace).toHaveBeenCalledOnce();
  });

  it("keeps the candidate after a save error for retry and prevents duplicate submissions", async () => {
    const write = deferred<void>();
    props.onReplace = vi.fn().mockReturnValueOnce(write.promise).mockResolvedValueOnce(undefined);
    await ready();
    const submit = button("保存为新版本");
    await act(async () => {
      submit.click();
      submit.click();
    });
    expect(props.onReplace).toHaveBeenCalledOnce();
    expect(props.onSaved).not.toHaveBeenCalled();
    await act(async () => {
      write.reject(new Error("原件上传失败，请重试。"));
    });
    expect(host.textContent).toContain("原件上传失败，请重试。");
    expect(host.querySelector("textarea")!.value).toBe(candidate().text);
    expect(props.onSaved).not.toHaveBeenCalled();
    await click(button("保存为新版本"));
    expect(props.onReplace).toHaveBeenCalledTimes(2);
    expect(props.onSaved).toHaveBeenCalledOnce();
    expect(prepareMock).toHaveBeenCalledOnce();
  });

  it("discards late parsing after cancellation without creating a version", async () => {
    await render();
    const pending = await choose();
    await click(button("取消"));
    expect(props.onCancel).toHaveBeenCalledOnce();
    await act(async () => {
      pending.request.resolve(candidate());
    });
    expect(host.querySelector('[aria-label="新文件预览"]')).toBeNull();
    expect(button("保存为新版本").disabled).toBe(true);
    expect(props.onReplace).not.toHaveBeenCalled();
  });

  it("accepts only the latest file selection and resets coverage confirmation", async () => {
    await render();
    const older = await choose("first.pdf");
    const newer = await choose("second.docx");
    await act(async () => {
      newer.request.resolve(candidate({ filename: "second.docx", kind: "docx" }));
      older.request.resolve(candidate({ filename: "first.pdf", status: "failed" }));
    });
    expect(host.textContent).toContain("second.docx");
    expect(host.textContent).not.toContain("first.pdf");
    const failed = await choose("failed.pdf");
    await act(async () => {
      failed.request.resolve(candidate({ status: "failed", text: "", chunks: [] }));
    });
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(button("保存为新版本").disabled).toBe(true);
  });

  it.each(["account", "destination", "source", "version", "membership", "deleted"] as const)(
    "invalidates a pending parse after %s changes",
    async (change) => {
      await render();
      const pending = await choose();
      if (change === "account") await render({ cloudUserId: "account-two" });
      if (change === "destination") await render({ targetSpaceId: "space-two" });
      if (change === "source") await render({ source: { ...props.source, id: "source-two" } });
      if (change === "version")
        await render({ source: { ...props.source, versionId: "version-two" } });
      if (change === "membership")
        await render({ source: { ...props.source, spaceIds: ["space-two"] } });
      if (change === "deleted")
        await render({ source: { ...props.source, deletedAt: "2026-09-13T00:00:00.000Z" } });
      await act(async () => {
        pending.request.resolve(candidate());
      });
      expect(host.querySelector('[aria-label="新文件预览"]')).toBeNull();
      expect(button("保存为新版本").disabled).toBe(true);
      expect(props.onReplace).not.toHaveBeenCalled();
      expect(props.onSaved).not.toHaveBeenCalled();
    },
  );

  it("discards late parse results after unmounting", async () => {
    await render();
    const pending = await choose();
    await act(async () => {
      root!.unmount();
      root = null;
      pending.request.resolve(candidate());
    });
    expect(props.onReplace).not.toHaveBeenCalled();
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it("can choose another file after a parser error without overwriting the current source", async () => {
    await render({ targetSpaceId: "inbox" });
    const pending = await choose("unsupported.bin");
    await act(async () => {
      pending.request.reject(new Error("暂不支持此文件格式。"));
    });
    expect(host.textContent).toContain("暂不支持此文件格式。");
    expect(button("保存为新版本").disabled).toBe(true);
    expect(props.onReplace).not.toHaveBeenCalled();
    const next = await choose("new.txt");
    await act(async () => {
      next.request.resolve(candidate({ filename: "new.txt", kind: "text" }));
    });
    expect(prepareMock).toHaveBeenLastCalledWith(next.file, "");
    expect(button("保存为新版本").disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not fire onSaved for a completed write from a closed session", async () => {
    const write = deferred<void>();
    props.onReplace = vi.fn(() => write.promise);
    await ready();
    await click(button("保存为新版本"));
    await act(async () => {
      root!.unmount();
      root = null;
      write.resolve();
    });
    expect(props.onReplace).toHaveBeenCalledOnce();
    expect(props.onSaved).not.toHaveBeenCalled();
  });
});
