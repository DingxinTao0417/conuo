// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import BulkSourceTagsPanel, { type BulkSourceTagsPanelProps } from "./bulk-source-tags-panel";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("durable batch-tag result panel", () => {
  let host: HTMLDivElement,
    root: Root,
    data: ReturnType<typeof createDemoWorkspace>,
    props: BulkSourceTagsPanelProps;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    data = createDemoWorkspace();
    data.sources.forEach((source) => (source.tags = []));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    props = {
      data,
      sourceIds: data.sources.map((source) => source.id),
      contextKey: "account-a:1",
      onApply: vi.fn(async (updater) => {
        data = updater(data);
      }),
      onClose: vi.fn(),
      onResult: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(extra: Partial<BulkSourceTagsPanelProps> = {}) {
    props = { ...props, data, ...extra };
    await act(async () => root.render(createElement(BulkSourceTagsPanel, props)));
  }
  function tags(value: string) {
    const input = host.querySelector<HTMLInputElement>('input[name="tags"]');
    expect(input).not.toBeNull();
    input!.value = value;
  }
  function button(text: string) {
    const found = [...host.querySelectorAll("button")].find((node) =>
      node.textContent?.includes(text),
    );
    expect(found).toBeDefined();
    return found!;
  }
  function submit() {
    const form = host.querySelector("form");
    expect(form).not.toBeNull();
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }
  it("shows the actual deduplicated selection and waits for local acknowledgement before any result", async () => {
    const wait = deferred();
    props.onApply = vi.fn(async (updater) => {
      data = updater(data);
      await wait.promise;
    });
    await render({ sourceIds: [data.sources[0].id, data.sources[0].id, data.sources[1].id] });
    expect(host.textContent).toContain("选中 2 份资料");
    tags("复习");
    await act(async () => {
      submit();
      submit();
    });
    expect(props.onApply).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[aria-label="批量标签结果"]')).toBeNull();
    expect(props.onResult).not.toHaveBeenCalled();
    expect(button("正在保存").disabled).toBe(true);
    await act(async () => wait.resolve());
    expect(host.textContent).toContain("本机保存已确认");
    expect(host.textContent).toContain("已修改 2");
    expect(props.onResult).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toMatch(/云端已|已同步云端/);
  });
  it("keeps every result with a reason and retries only failures against current data after a click", async () => {
    data.sources[0].tags = ["复习"];
    data.sources[1].tags = Array.from({ length: 100 }, (_, i) => `旧-${i}`);
    await render();
    tags("复习");
    await act(async () => submit());
    expect(host.textContent).toContain("无需修改 1");
    expect(host.textContent).toContain("失败 1");
    expect(host.textContent).toContain("100");
    const completed = data.sources[0];
    data = {
      ...data,
      sources: [
        { ...completed, tags: ["后来的独立编辑"], tagsRevision: 7 },
        { ...data.sources[1], tags: [], tagsRevision: 4 },
      ],
    };
    await render();
    expect(props.onApply).toHaveBeenCalledTimes(1);
    await act(async () => button("仅重试失败 1").click());
    expect(data.sources[0].tags).toEqual(["后来的独立编辑"]);
    expect(data.sources[0].tagsRevision).toBe(7);
    expect(data.sources[1]).toMatchObject({ tags: ["复习"], tagsRevision: 5 });
    expect(host.textContent).toContain("失败 0");
    expect(props.onApply).toHaveBeenCalledTimes(2);
  });
  it("rejects empty or too-long labels before invoking the durable callback", async () => {
    await render();
    tags(" , ， ");
    await act(async () => submit());
    expect(host.getElementsByClassName("bulk-source-tags-error")[0]?.textContent).toContain(
      "至少一个标签",
    );
    expect(props.onApply).not.toHaveBeenCalled();
    tags("x".repeat(101));
    await act(async () => submit());
    expect(host.textContent).toContain("100 字符");
    expect(props.onApply).not.toHaveBeenCalled();
  });
  it("never reports local success after persistence rejects, preserving the input for an explicit retry", async () => {
    props.onApply = vi.fn(async (updater) => {
      data = updater(data);
      throw new Error("磁盘写入失败");
    });
    await render();
    tags("复习");
    await act(async () => submit());
    expect(host.textContent).toContain("尚未确认本机保存");
    expect(host.querySelector('[aria-label="批量标签结果"]')).toBeNull();
    expect(props.onResult).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('input[name="tags"]')!.value).toBe("复习");
    props.onApply = vi.fn(async (updater) => {
      data = updater(data);
    });
    await render();
    await act(async () => submit());
    expect(host.textContent).toContain("本机保存已确认");
  });
  it("does not publish a late completed or failed result into a new account/context, including ABA", async () => {
    const wait = deferred();
    props.onApply = vi.fn(async (updater) => {
      data = updater(data);
      await wait.promise;
    });
    await render();
    tags("私密标签");
    await act(async () => submit());
    await render({ contextKey: "account-b:2" });
    await render({ contextKey: "account-a:3" });
    expect(host.querySelector<HTMLInputElement>('input[name="tags"]')!.value).toBe("");
    await act(async () => wait.resolve());
    expect(host.querySelector('[aria-label="批量标签结果"]')).toBeNull();
    expect(props.onResult).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("私密标签");
  });
  it("invalidates the review if selection or target version changes while a callback is waiting", async () => {
    const wait = deferred();
    props.onApply = vi.fn(async (updater) => {
      await wait.promise;
      data = updater(data);
    });
    await render();
    tags("旧上下文标签");
    await act(async () => submit());
    data = {
      ...data,
      sources: [{ ...data.sources[0], versionId: "new-current-version" }, data.sources[1]],
    };
    await render();
    await act(async () => wait.resolve());
    expect(data.sources[0].tags).toEqual([]);
    expect(props.onResult).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("旧上下文标签");
  });
  it("retains a deleted and missing row instead of silently reducing the reported selection", async () => {
    data.sources[0].deletedAt = "2026-09-15T00:00:00.000Z";
    await render({ sourceIds: [data.sources[0].id, "missing"] });
    tags("复习");
    await act(async () => submit());
    expect(host.textContent).toContain("选中 2 份资料");
    expect(host.textContent).toContain("失败 2");
    expect(host.textContent).toContain("回收站");
    expect(host.textContent).toContain("不可用");
    expect(host.querySelectorAll(".bulk-source-tags-item")).toHaveLength(2);
  });
  it("discards a late rejection after closing/unmounting the modal", async () => {
    const wait = deferred();
    props.onApply = vi.fn(async (updater) => {
      data = updater(data);
      await wait.promise;
    });
    await render();
    tags("标签");
    await act(async () => submit());
    await act(async () => root.render(null));
    await act(async () => wait.reject(new Error("旧账号磁盘失败")));
    expect(host.textContent).toBe("");
    expect(props.onResult).not.toHaveBeenCalled();
  });
  it("rejects an old submitted selection after an A→B→A selection change", async () => {
    const wait = deferred();
    props.onApply = vi.fn(async (updater) => {
      await wait.promise;
      data = updater(data);
    });
    await render();
    tags("旧选择");
    await act(async () => submit());
    const ids = props.sourceIds;
    await render({ sourceIds: [ids[0]] });
    await render({ sourceIds: ids });
    await act(async () => wait.resolve());
    expect(data.sources.every((source) => source.tags.length === 0)).toBe(true);
    expect(props.onResult).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('input[name="tags"]')!.value).toBe("");
  });
  it("resets an in-flight target review when a selected source is deleted and does not tag another current target", async () => {
    const wait = deferred();
    props.onApply = vi.fn(async (updater) => {
      await wait.promise;
      data = updater(data);
    });
    await render();
    tags("旧目标");
    await act(async () => submit());
    data = {
      ...data,
      sources: [{ ...data.sources[0], deletedAt: "2026-09-15T00:00:00.000Z" }, data.sources[1]],
    };
    await render();
    await act(async () => wait.resolve());
    expect(data.sources.every((source) => source.tags.length === 0)).toBe(true);
    expect(props.onResult).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="批量标签结果"]')).toBeNull();
  });
});
