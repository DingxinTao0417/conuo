import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import {
  makeCapturedWebSource,
  addWebSource,
  webPreviewSchema,
  type WebPreview,
} from "./web-import";
import { makeWebSource } from "./import";
import { createEmptyWorkspace } from "./seed";
import { workspaceSchema } from "./supabase/validation";
import { buildWorkspaceArchive } from "./export";
import { resolveCitation, retrieveEvidence } from "./retrieval";
vi.mock("./local-store", () => ({ putBlob: vi.fn(), getBlob: vi.fn() }));

const preview = (): WebPreview => ({
  originalUrl: "https://example.org/start#reading",
  finalUrl: "https://example.org/article",
  title: "学习率说明",
  text: "# 学习率\n\n学习率控制更新步长。\n\n较大的步长可能使损失振荡。",
  excerpt: "学习率控制更新步长。",
  capturedAt: "2026-09-12T12:00:00.000Z",
  warnings: ["未保存嵌入图片或动态内容。"],
  kind: "article",
  byline: "测试作者",
  siteName: "测试资料",
});

describe("explicit web captures", () => {
  it("requires an explicit opt-in before a captured webpage may be used by AI", () => {
    const defaultSource = makeCapturedWebSource({
      preview: preview(),
      scope: "article",
      spaceId: "",
    });
    const allowedSource = makeCapturedWebSource({
      preview: preview(),
      scope: "article",
      spaceId: "",
      aiAllowed: true,
    });

    expect(defaultSource.aiAllowed).toBe(false);
    expect(allowedSource.aiAllowed).toBe(true);
  });

  it("preserves URL, capture time, original text and canonical chunk version", () => {
    const data = createEmptyWorkspace();
    const source = makeCapturedWebSource({
      preview: preview(),
      scope: "article",
      spaceId: data.spaces[0].id,
    });
    const next = addWebSource(data, source);
    expect(data.sources).toEqual([]);
    expect(source.webSnapshot).toMatchObject({
      method: "server",
      scope: "article",
      finalUrl: preview().finalUrl,
      capturedAt: preview().capturedAt,
    });
    expect(source.text).toBe(preview().text);
    expect(
      source.chunks.every(
        (c) =>
          c.sourceId === source.id &&
          c.versionId === source.versionId &&
          source.text.includes(c.text),
      ),
    ).toBe(true);
    expect(workspaceSchema.safeParse(next).success).toBe(true);
    const cited = source.chunks[1];
    expect(
      resolveCitation(next, {
        sourceId: source.id,
        versionId: source.versionId,
        chunkId: cited.id,
        quote: cited.text,
        title: source.title,
        section: cited.section,
      }),
    ).toMatchObject({ source });
  });
  it("only stores the selected continuous excerpt without pretending it is a parser failure", () => {
    const source = makeCapturedWebSource({
      preview: preview(),
      scope: "selection",
      text: "较大的步长可能使损失振荡。",
      spaceId: "",
    });
    expect(source.text).toBe("较大的步长可能使损失振荡。");
    expect(source.status).toBe("ready");
    expect(source.error).toBeUndefined();
    expect(source.coverage).toEqual({ captureScope: "selection", parseState: "complete" });
    expect(source.webSnapshot?.scope).toBe("selection");
    expect(() =>
      makeCapturedWebSource({
        preview: preview(),
        scope: "selection",
        text: "学习率一定越大越好",
        spaceId: "",
      }),
    ).toThrow("连续");
    expect(() =>
      makeCapturedWebSource({ preview: preview(), scope: "article", text: "changed", spaceId: "" }),
    ).toThrow("修改");
  });
  it("bare links never retain hidden preview text or enter retrieval", () => {
    const source = makeCapturedWebSource({ preview: preview(), scope: "link", spaceId: "" });
    expect(source).toMatchObject({ text: "", chunks: [], status: "link-only", hash: "" });
    const data = { ...createEmptyWorkspace(), sources: [source] };
    const result = retrieveEvidence(data, {
      question: "学习率",
      sourceId: source.id,
      sourceIds: [source.id],
      spaceId: "inbox",
      scope: "document",
    });
    expect(result.citations).toEqual([]);
  });
  it("keeps failed extraction as link-only until a user supplies independent text", () => {
    const failed: WebPreview = {
      ...preview(),
      kind: "link-only",
      text: "",
      excerpt: "",
      warnings: ["此网页需要登录。"],
    };
    expect(() => makeCapturedWebSource({ preview: failed, scope: "article", spaceId: "" })).toThrow(
      "正文",
    );
    expect(
      makeCapturedWebSource({ preview: failed, scope: "link", spaceId: "" }).webSnapshot?.warnings,
    ).toContain("此网页需要登录。");
    const manual = makeWebSource({
      url: failed.originalUrl,
      title: "自己粘贴",
      text: "用户提供的原文",
      spaceId: "",
    });
    expect(manual.webSnapshot).toMatchObject({
      method: "manual",
      scope: "pasted",
      finalUrl: failed.originalUrl,
    });
  });
  it("does not overwrite previous captures when the same URL changes", () => {
    const old = makeCapturedWebSource({ preview: preview(), scope: "article", spaceId: "" });
    const fresh = makeCapturedWebSource({
      preview: { ...preview(), text: "另一份网页正文", capturedAt: "2026-09-13T12:00:00Z" },
      scope: "article",
      spaceId: "",
    });
    const data = addWebSource(addWebSource(createEmptyWorkspace(), old), fresh);
    expect(data.sources).toHaveLength(2);
    expect(old.id).not.toBe(fresh.id);
    expect(old.versionId).not.toBe(fresh.versionId);
    expect(data.sources[1].text).toBe(preview().text);
    expect(() => addWebSource(data, fresh)).toThrow("已经保存");
  });
  it("rejects changed target libraries and whole-workspace overflow atomically", () => {
    const data = createEmptyWorkspace();
    const source = makeCapturedWebSource({
      preview: preview(),
      scope: "article",
      spaceId: data.spaces[0].id,
    });
    data.spaces[0].archived = true;
    expect(() => addWebSource(data, source)).toThrow("不可用");
    data.spaces[0].archived = false;
    const enormous = {
      ...data,
      sources: Array.from({ length: 20 }, (_, i) => ({
        ...source,
        id: `old-${i}`,
        text: "中".repeat(120000),
      })),
    };
    expect(() => addWebSource(enormous, source)).toThrow("3 MiB");
    expect(enormous.sources).toHaveLength(20);
  });
  it("rejects credential-bearing, executable, invalid and oversized inputs", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///secret",
      "https://user:secret@example.org/",
      "https://exa\nmple.org/",
    ]) {
      expect(() => makeWebSource({ url, title: "x", text: "x", spaceId: "" })).toThrow();
    }
    expect(() =>
      makeWebSource({
        url: preview().originalUrl,
        title: "x",
        text: "x".repeat(120001),
        spaceId: "",
      }),
    ).toThrow("12 万");
    const source = makeWebSource({
      url: preview().originalUrl,
      title: "x".repeat(512),
      text: "x",
      spaceId: "",
    });
    expect(source.title).toHaveLength(512);
    expect(source.filename).toHaveLength(512);
    expect(webPreviewSchema.safeParse({ ...preview(), kind: "link-only" }).success).toBe(false);
  });
  it("allows legacy web records but rejects contradictory snapshot metadata", () => {
    const data = createEmptyWorkspace();
    const source = makeCapturedWebSource({ preview: preview(), scope: "article", spaceId: "" });
    data.sources.push(source);
    expect(workspaceSchema.safeParse(data).success).toBe(true);
    source.webSnapshot!.scope = "link";
    expect(workspaceSchema.safeParse(data).success).toBe(false);
    delete source.webSnapshot;
    expect(workspaceSchema.safeParse(data).success).toBe(true);
  });
  it("exports capture metadata, selected text and missing resources without fetching anything", async () => {
    const source = makeCapturedWebSource({
      preview: preview(),
      scope: "selection",
      text: "学习率控制更新步长。",
      spaceId: "",
    });
    const data = addWebSource(createEmptyWorkspace(), source);
    const zip = await JSZip.loadAsync(await buildWorkspaceArchive(data), { checkCRC32: true });
    const metadata = JSON.parse(
      await zip.file(`sources/${source.id}/web-snapshot.json`)!.async("string"),
    );
    expect(metadata).toMatchObject({
      scope: "selection",
      sourceId: source.id,
      versionId: source.versionId,
      resources: [],
      extractedText: "extracted.txt",
    });
    expect(await zip.file(`sources/${source.id}/extracted.txt`)!.async("string")).toBe(source.text);
    const mapping = JSON.parse(await zip.file("source-mapping.json")!.async("string"))[0];
    expect(mapping.webSnapshot).toBe(`sources/${source.id}/web-snapshot.json`);
    expect(mapping.originalStatus).toContain("未保存原站 HTML");
  });
});
