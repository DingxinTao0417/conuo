import { describe, expect, it } from "vitest";
import { createDemoWorkspace } from "./seed";
import { setSourceTags } from "./organization-review";
import { MAX_WORKSPACE_BYTES } from "./supabase/validation";
import {
  applyBulkSourceTags,
  normalizeBulkSourceTags,
  retryBulkSourceTags,
} from "./bulk-source-tags";

describe("batch manual tags with explicit per-source results", () => {
  it("replaces the current reduce/all-or-nothing failure with real success, noop, deleted, missing and overflow rows", () => {
    const data = createDemoWorkspace();
    const first = data.sources[0];
    first.tags = ["现有"];
    first.tagsLocked = true;
    const second = data.sources[1];
    second.tags = ["复习"];
    second.tagsRevision = 4;
    data.sources.push(
      { ...first, id: "deleted", deletedAt: "2026-09-15T00:00:00.000Z" },
      { ...first, id: "full", tags: Array.from({ length: 100 }, (_, i) => `标签-${i}`) },
    );
    const ids = [first.id, second.id, "deleted", "missing", "full", first.id],
      before = structuredClone(data);
    expect(() =>
      ids.reduce((current, id) => {
        const source = current.sources.find((s) => s.id === id);
        if (!source) throw new Error("missing");
        return setSourceTags(current, id, [...source.tags, "复习"]);
      }, data),
    ).toThrow();
    const applied = applyBulkSourceTags(data, ids, " 复习，复习 ");
    expect(applied.result.selectedCount).toBe(5);
    expect(applied.result.items.map((item) => item.status)).toEqual([
      "accepted",
      "noop",
      "failed",
      "failed",
      "failed",
    ]);
    expect(applied.result.acceptedSourceIds).toEqual([first.id]);
    expect(applied.result.noopSourceIds).toEqual([second.id]);
    expect(applied.data.sources[0]).toMatchObject({
      tags: ["现有", "复习"],
      tagsLocked: true,
      tagsRevision: 1,
    });
    expect(applied.data.sources[1]).toEqual(second);
    expect(data).toEqual(before);
    expect(applied.result.items[2].reason).toMatch(/回收站/);
    expect(applied.result.items[3].reason).toMatch(/不可用/);
    expect(applied.result.items[4].reason).toMatch(/100/);
    expect(Object.isFrozen(applied.result.items[0])).toBe(true);
  });
  it("normalizes the whole input before any write without silently changing existing case-sensitive labels", () => {
    const data = createDemoWorkspace();
    data.sources[0].tags = ["AI", "ai"];
    expect(normalizeBulkSourceTags(" 学习， 学习, AI , ai ")).toEqual(["学习", "AI", "ai"]);
    const applied = applyBulkSourceTags(data, [data.sources[0].id], [" AI ", "ai"]);
    expect(applied.result.items[0].status).toBe("noop");
    expect(applied.data).toBe(data);
    for (const bad of [
      " , ， ",
      "x".repeat(101),
      Array.from({ length: 101 }, (_, i) => `tag-${i}`),
    ])
      expect(() =>
        applyBulkSourceTags(
          data,
          data.sources.map((s) => s.id),
          bad,
        ),
      ).toThrow(/标签|字符/);
    expect(data.sources[0].tags).toEqual(["AI", "ai"]);
  });
  it("retries only failed IDs against current data, preserving successful rows and later edits without repeat revisions", () => {
    const data = createDemoWorkspace();
    data.sources[1].tags = Array.from({ length: 100 }, (_, i) => `旧-${i}`);
    const first = applyBulkSourceTags(
      data,
      data.sources.map((s) => s.id),
      "复习",
    );
    const current = {
      ...first.data,
      sources: first.data.sources.map((source, i) =>
        i === 0
          ? { ...source, tags: ["后来独立编辑"], tagsRevision: 9 }
          : { ...source, tags: [], tagsRevision: 5 },
      ),
    };
    const retried = retryBulkSourceTags(current, first.result);
    expect(retried.result.items.map((item) => item.status)).toEqual(["accepted", "accepted"]);
    expect(retried.result.items[0]).toEqual(first.result.items[0]);
    expect(retried.data.sources[0]).toEqual(current.sources[0]);
    expect(retried.data.sources[1]).toMatchObject({ tags: ["复习"], tagsRevision: 6 });
    expect(first.result.failedSourceIds).toEqual([data.sources[1].id]);
    expect(retryBulkSourceTags(retried.data, retried.result).data).toBe(retried.data);
  });
  it("reports a bad revision on only that source while allowing human edits to fixed, parsing and AI-disabled sources", () => {
    const data = createDemoWorkspace();
    data.sources[0].tagsRevision = Number.MAX_SAFE_INTEGER - 1;
    data.sources[1].tags = [];
    data.sources[1].tagsLocked = true;
    data.sources[1].status = "parsing";
    data.sources[1].aiAllowed = false;
    const applied = applyBulkSourceTags(
      data,
      data.sources.map((s) => s.id),
      "手工",
    );
    expect(applied.result.items.map((item) => item.status)).toEqual(["failed", "accepted"]);
    expect(applied.result.items[0].reason).toMatch(/版本/);
    expect(applied.data.sources[1].tags).toEqual(["手工"]);
  });
  it("preflights the entire batch capacity atomically, returning no fake partial success", () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    source.tags = [];
    data.sources[1].tags = [];
    const size = new TextEncoder().encode(JSON.stringify(data)).byteLength;
    source.error = "x".repeat(MAX_WORKSPACE_BYTES - size - 30);
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBeLessThan(
      MAX_WORKSPACE_BYTES,
    );
    const before = structuredClone(data);
    expect(() =>
      applyBulkSourceTags(
        data,
        data.sources.map((s) => s.id),
        "中".repeat(100),
      ),
    ).toThrow(/容量/);
    expect(data).toEqual(before);
  });
  it("rejects unknown selection identities and empty input without truncating a legal 5000-source selection", () => {
    const data = createDemoWorkspace();
    const source = data.sources[0];
    data.sources = Array.from({ length: 5000 }, (_, i) => ({
      ...source,
      id: `bulk-${i}`,
      tags: ["复习"],
      title: "",
      filename: "",
      text: "",
      chunks: [],
      hash: "",
      mime: "",
      size: 0,
    }));
    const applied = applyBulkSourceTags(
      data,
      data.sources.map((s) => s.id),
      "复习",
    );
    expect(applied.result.selectedCount).toBe(5000);
    expect(applied.result.items).toHaveLength(5000);
    expect(() => applyBulkSourceTags(data, [], "复习")).toThrow(/选择/);
    expect(() => applyBulkSourceTags(data, ["bad/id"], "复习")).toThrow(/身份/);
    expect(() =>
      applyBulkSourceTags(
        data,
        Array.from({ length: 5001 }, (_, i) => `source-${i}`),
        "复习",
      ),
    ).toThrow(/5000/);
  });
  it("rejects a forged retry partition and preserves a still-deleted failed row until the user restores it", () => {
    const data = createDemoWorkspace();
    data.sources[0].deletedAt = "2026-09-15T00:00:00.000Z";
    const first = applyBulkSourceTags(
      data,
      data.sources.map((source) => source.id),
      "复习",
    );
    const repeated = retryBulkSourceTags(first.data, first.result);
    expect(repeated.result.failedSourceIds).toEqual([data.sources[0].id]);
    expect(repeated.data).toBe(first.data);
    expect(() =>
      retryBulkSourceTags(first.data, { ...first.result, failedSourceIds: [data.sources[1].id] }),
    ).toThrow(/列表不一致/);
    const restored = {
        ...first.data,
        sources: first.data.sources.map((source) => ({ ...source, deletedAt: null })),
      },
      retried = retryBulkSourceTags(restored, first.result);
    expect(retried.result.failedSourceIds).toEqual([]);
    expect(retried.data.sources[0].tags).toContain("复习");
    expect(retried.data.sources[1]).toEqual(restored.sources[1]);
  });
  it("rejects a retry batch capacity overflow without changing its acknowledged successes or prior failures", () => {
    const data = createDemoWorkspace();
    data.sources[1].tags = Array.from({ length: 100 }, (_, i) => `旧-${i}`);
    const first = applyBulkSourceTags(
      data,
      data.sources.map((source) => source.id),
      "中".repeat(100),
    );
    const current = {
      ...first.data,
      sources: [first.data.sources[0], { ...first.data.sources[1], tags: [] }],
    };
    const size = new TextEncoder().encode(JSON.stringify(current)).byteLength;
    current.sources[0] = {
      ...current.sources[0],
      error: "x".repeat(MAX_WORKSPACE_BYTES - size - 30),
    };
    const before = structuredClone(current),
      previous = structuredClone(first.result);
    expect(() => retryBulkSourceTags(current, first.result)).toThrow(/容量/);
    expect(current).toEqual(before);
    expect(first.result).toEqual(previous);
  });
});
