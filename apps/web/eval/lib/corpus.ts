import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chunkText } from "../../src/lib/import";
import { createEmptyWorkspace } from "../../src/lib/seed";
import type { Source, WorkspaceData } from "../../src/lib/types";

interface ManifestEntry {
  doc: string;
  file: string;
  kind: "markdown" | "pdf";
  space: string;
  aiAllowed: boolean;
}

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));

function pageChunks(text: string, sourceId: string, versionId: string) {
  const pages = [...text.matchAll(/=== 第 (\d+) 页 ===\s*([\s\S]*?)(?=\n=== 第 |$)/g)];
  const chunks = [];
  let order = 0;
  const unavailablePageRanges: { start: number; end: number }[] = [];
  const pageTexts: string[] = [];
  for (const match of pages) {
    const page = Number(match[1]);
    const pageText = match[2].trim();
    pageTexts.push(pageText);
    if (!pageText) {
      unavailablePageRanges.push({ start: page, end: page });
      continue;
    }
    for (const chunk of chunkText(pageText, sourceId, versionId)) {
      chunks.push({ ...chunk, id: `${sourceId}-c${order}`, page, section: `第 ${page} 页`, order });
      order += 1;
    }
  }
  return { chunks, text: pageTexts.filter(Boolean).join("\n\n"), unavailablePageRanges };
}

/** Deterministic IDs keep evaluation reports comparable across runs. */
export function buildEvalWorkspace(): WorkspaceData {
  const manifest = JSON.parse(
    readFileSync(`${corpusDir}/manifest.json`, "utf8"),
  ) as ManifestEntry[];
  const data = createEmptyWorkspace();
  data.spaces = [];
  const now = "2026-01-01T00:00:00.000Z";
  for (const name of [...new Set(manifest.map((item) => item.space))])
    data.spaces.push({
      id: `space-${name}`,
      name,
      goal: "离线评测资料",
      color: "#4B3FE3",
      archived: false,
      createdAt: now,
    });
  for (const item of manifest) {
    const id = `src-${item.doc}`;
    const versionId = `ver-${item.doc}-1`;
    const raw = readFileSync(`${corpusDir}/${item.file}`, "utf8");
    const parsed =
      item.kind === "pdf"
        ? pageChunks(raw, id, versionId)
        : { chunks: chunkText(raw, id, versionId), text: raw.trim(), unavailablePageRanges: [] };
    parsed.chunks = parsed.chunks.map((chunk) => ({ ...chunk, id: `${id}-c${chunk.order}` }));
    const source: Source = {
      id,
      versionId,
      title: item.doc,
      filename: item.file,
      kind: item.kind === "pdf" ? "pdf" : "markdown",
      mime: item.kind === "pdf" ? "application/pdf" : "text/markdown",
      size: new TextEncoder().encode(parsed.text).byteLength,
      hash: `eval-${item.doc}`,
      spaceIds: [`space-${item.space}`],
      tags: ["evaluation"],
      status: parsed.unavailablePageRanges.length ? "partial" : "ready",
      coverage: {
        captureScope: "full",
        parseState: parsed.unavailablePageRanges.length ? "partial" : "complete",
        ...(parsed.unavailablePageRanges.length
          ? { unavailablePageRanges: parsed.unavailablePageRanges }
          : {}),
      },
      text: parsed.text,
      chunks: parsed.chunks,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      aiAllowed: item.aiAllowed,
      starred: false,
    };
    data.sources.push(source);
  }
  return data;
}
