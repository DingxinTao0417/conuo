import { describe, expect, it } from "vitest";
import {
  createWebSource,
  webPreviewSchema as mobilePreviewSchema,
} from "../../../../mobile/src/core/web-import";
import { snapshotSchema as mobileSnapshotSchema } from "../../../../mobile/src/core/contracts";
import { webPreviewSchema } from "@/lib/web-types";
import { createDemoWorkspace } from "@/lib/seed";
import { saveRequestSchema, workspaceSchema } from "./validation";

const now = "2026-09-21T10:00:00.000Z";
const preview = webPreviewSchema.parse({
  originalUrl: "https://example.test/article",
  finalUrl: "https://example.test/read/1",
  capturedAt: now,
  title: "移动端收集的公开网页",
  text: "# 学习资料\n\n保留原文 😀 与出处。\n\n" + "分段正文。".repeat(500),
  excerpt: "保留原文与出处。",
  kind: "article",
  warnings: ["不包含网页中的动态组件。"],
  byline: "作者",
  siteName: "公开学习站点",
});

describe("native web import / real Web schemas", () => {
  it.each(["article", "captured-link", "manual-link"] as const)(
    "%s saves without removing Web-only fields and without requiring a new server API",
    (kind) => {
      const original = workspaceSchema.parse(JSON.parse(JSON.stringify(createDemoWorkspace())));
      const loaded = mobileSnapshotSchema.parse({ data: original, revision: 23 });
      const nativePreview = mobilePreviewSchema.parse(JSON.parse(JSON.stringify(preview)));
      const next = createWebSource(loaded.data!, {
        id: `native-web-${kind}`,
        versionId: `native-web-version-${kind}`,
        url: preview.originalUrl,
        now,
        ...(kind !== "manual-link" ? { preview: nativePreview } : {}),
        mode: kind === "article" ? "article" : "link",
      });
      const parsed = saveRequestSchema.parse(
        JSON.parse(
          JSON.stringify({
            data: next,
            expectedRevision: loaded.revision,
          }),
        ),
      );
      expect(parsed.expectedRevision).toBe(23);
      expect({ ...parsed.data, sources: parsed.data.sources.slice(1) }).toEqual(original);
      expect(loaded.data).toEqual(original);
      expect(parsed.data.sources[0]).toMatchObject({
        kind: "web",
        hash: "",
        mime: "text/plain",
        aiAllowed: false,
        status: kind === "article" ? "ready" : "link-only",
        spaceIds: [],
        webSnapshot: {
          method: kind === "manual-link" ? "manual" : "server",
          scope: kind === "article" ? "article" : "link",
        },
      });
      for (const chunk of parsed.data.sources[0].chunks) {
        expect(chunk.sourceId).toBe(parsed.data.sources[0].id);
        expect(chunk.versionId).toBe(parsed.data.sources[0].versionId);
        expect(parsed.data.sources[0].text).toContain(chunk.text);
      }
    },
  );

  it("explicit article AI consent and an active library still satisfy the server contract", () => {
    const original = createDemoWorkspace();
    original.aiEnabled = true;
    const loaded = mobileSnapshotSchema.parse({ data: original, revision: 3 });
    const next = createWebSource(loaded.data!, {
      id: "native-opt-in-source",
      versionId: "native-opt-in-version",
      url: preview.originalUrl,
      preview: mobilePreviewSchema.parse(preview),
      now,
      spaceId: original.spaces[0].id,
      aiAllowed: true,
    });
    const parsed = workspaceSchema.parse(JSON.parse(JSON.stringify(next)));
    expect(parsed.sources[0].aiAllowed).toBe(true);
    expect(parsed.sources[0].spaceIds).toEqual([original.spaces[0].id]);
  });

  it("future fields survive the native edit and are rejected by an older server rather than silently lost", () => {
    const original = createDemoWorkspace();
    const loaded = mobileSnapshotSchema.parse({
      data: { ...original, futureProperty: { version: 3 } },
      revision: 23,
    });
    const next = createWebSource(loaded.data!, {
      id: "native-future-source",
      versionId: "native-future-version",
      url: preview.originalUrl,
      now,
    });
    expect(next.futureProperty).toEqual({ version: 3 });
    expect(workspaceSchema.safeParse(next).success).toBe(false);
  });
});
