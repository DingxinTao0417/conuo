import assert from "node:assert/strict";
import test from "node:test";
import { blankWorkspace } from "./contracts.ts";
import {
  assertPdfWorkspaceCapacity,
  buildPdfSource,
  mergePdfIntoWorkspace,
  PDF_MAX_FILE_BYTES,
  validatePdfFile,
} from "./pdf-import.ts";

const id = "123e4567-e89b-42d3-a456-426614174000";
const versionId = "123e4567-e89b-42d3-a456-426614174001";
const hash = "a".repeat(64);
let chunkCounter = 0;

function source(overrides: Partial<Parameters<typeof buildPdfSource>[0]> = {}) {
  return buildPdfSource({
    id,
    versionId,
    filename: "signals.pdf",
    size: 1024,
    hash,
    spaceId: "",
    aiAllowed: false,
    pageCount: 2,
    pages: [
      { page: 1, text: "A periodic signal repeats after a fixed period." },
      { page: 2, text: "Frequency is the inverse of the period." },
    ],
    createId: () => `chunk-${++chunkCounter}`,
    now: "2026-09-23T12:00:00.000Z",
    ...overrides,
  });
}

test("native PDF import validates extension, name and the shared 30 MiB limit", () => {
  assert.equal(validatePdfFile("Notes.PDF", 1), "Notes.PDF");
  assert.throws(() => validatePdfFile("notes.docx", 1), /目前支持 PDF/u);
  assert.throws(() => validatePdfFile("notes.pdf", PDF_MAX_FILE_BYTES + 1), /30 MiB/u);
  assert.throws(() => validatePdfFile("  ", 1), /文件名/u);
  assert.throws(() => validatePdfFile("a".repeat(513) + ".pdf", 1), /512/u);
  assert.throws(() => validatePdfFile("notes.pdf", 0), /文件大小/u);
});

test("PDF page extraction keeps page identity, ordered text and citation chunks", () => {
  chunkCounter = 0;
  const imported = source();
  assert.equal(imported.status, "ready");
  assert.equal(imported.pageCount, 2);
  assert.equal(imported.parsedPages, 2);
  assert.deepEqual(imported.chunks.map((chunk) => chunk.page), [1, 2]);
  assert.deepEqual(imported.chunks.map((chunk) => chunk.order), [0, 1]);
  assert.equal(imported.text, "A periodic signal repeats after a fixed period.\n\nFrequency is the inverse of the period.");
});

test("a long page never splits a surrogate pair across citation chunks", () => {
  chunkCounter = 0;
  const longText = `${"a".repeat(1199)}😀${"b".repeat(80)}`;
  const imported = source({ pageCount: 1, pages: [{ page: 1, text: longText }] });
  assert.equal(imported.chunks.map((chunk) => chunk.text).join("").includes("😀"), true);
  assert.equal(imported.chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk.text)), true);
});

test("scanned or unreadable pages remain an explicit failed or partial source", () => {
  const partial = source({
    pageCount: 3,
    pages: [
      { page: 1, text: "Readable page." },
      { page: 2, text: "   " },
      { page: 3, text: "Also readable." },
    ],
  });
  assert.equal(partial.status, "partial");
  assert.equal(partial.coverage?.parseState, "partial");
  assert.deepEqual(partial.coverage?.unavailablePageRanges, [{ start: 2, end: 2 }]);

  const failed = source({ pageCount: 2, pages: [], parseError: "受密码保护" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.coverage?.parseState, "failed");
  assert.equal(failed.error?.includes("受密码保护"), true);
});

test("duplicate PDFs reuse the active source and only add explicit library membership", () => {
  const existing = source({ spaceId: "space-a" });
  const workspace = {
    ...blankWorkspace(),
    spaces: [
      { id: "space-a", name: "A", goal: "", color: "", archived: false, createdAt: "now" },
      { id: "space-b", name: "B", goal: "", color: "", archived: false, createdAt: "now" },
    ],
    sources: [existing],
  };
  const duplicate = source({ id: "different-id", versionId: "different-version" });
  const linked = mergePdfIntoWorkspace(workspace, duplicate, "space-b");
  assert.equal(linked.duplicate, true);
  assert.equal(linked.source.id, existing.id);
  assert.deepEqual(linked.source.spaceIds, ["space-a", "space-b"]);
  assert.equal(linked.workspace.sources.length, 1);
  const unchanged = mergePdfIntoWorkspace(linked.workspace, duplicate, "space-b");
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.workspace, linked.workspace);
});

test("a selected duplicate can restore a missing immutable PDF without replacing its identity", () => {
  const existing = source({ spaceId: "space-a" });
  const missing = { ...existing, storagePath: undefined, originalMissing: true };
  const workspace = {
    ...blankWorkspace(),
    spaces: [{ id: "space-a", name: "A", goal: "", color: "", archived: false, createdAt: "now" }],
    sources: [missing],
  };
  const incoming = { ...existing, storagePath: `${id}/${versionId}/${id}.pdf` };
  const restored = mergePdfIntoWorkspace(workspace, incoming, "");
  assert.equal(restored.source.id, existing.id);
  assert.equal(restored.source.storagePath, incoming.storagePath);
  assert.equal(restored.source.originalMissing, false);
  assert.equal(restored.workspace.sources.length, 1);
});

test("workspace capacity is checked before a new original is uploaded", () => {
  const largeExisting = { ...source(), text: "x".repeat(3 * 1024 * 1024) };
  const workspace = { ...blankWorkspace(), sources: [largeExisting] };
  const incoming = source({
    id: "new-pdf",
    versionId: "new-version",
    hash: "c".repeat(64),
  });
  assert.throws(
    () => assertPdfWorkspaceCapacity(workspace, incoming, ""),
    /3 MiB 云端容量/u,
  );
});
