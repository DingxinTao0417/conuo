import type { ReadingPositionAlternative, Source } from "./types";

type ReadingProgress = Pick<Source, "readPage" | "readOffset" | "lastReadAt">;

export interface ReadingPositionSelectionPatch extends ReadingProgress {
  readingPositionAlternatives: ReadingPositionAlternative[];
}

function hasReadingProgress(progress: ReadingProgress): boolean {
  return (
    progress.readPage !== undefined ||
    progress.readOffset !== undefined ||
    progress.lastReadAt !== undefined
  );
}

function readingProgress(progress: ReadingProgress): ReadingProgress {
  return {
    ...(progress.readPage !== undefined ? { readPage: progress.readPage } : {}),
    ...(progress.readOffset !== undefined ? { readOffset: progress.readOffset } : {}),
    ...(progress.lastReadAt !== undefined ? { lastReadAt: progress.lastReadAt } : {}),
  };
}

function progressKey(progress: ReadingProgress): string {
  return JSON.stringify([
    progress.readPage ?? null,
    progress.readOffset ?? null,
    progress.lastReadAt ?? null,
  ]);
}

/**
 * Promotes one retained reading position and keeps the displaced active position recoverable.
 * Candidate provenance is display metadata; it does not affect identity or ordering.
 */
export function selectReadingPositionAlternative(
  source: Pick<Source, "readPage" | "readOffset" | "lastReadAt" | "readingPositionAlternatives">,
  selectedIndex: number,
): ReadingPositionSelectionPatch {
  const alternatives = source.readingPositionAlternatives ?? [];
  const selected = alternatives[selectedIndex];
  if (!selected) throw new Error("选择的阅读位置已不存在，请重新打开后再试。");

  const active = readingProgress(selected);
  const activeKey = progressKey(active);
  const candidates: ReadingPositionAlternative[] = [];
  const seen = new Set<string>();
  const current = readingProgress(source);
  const remaining = alternatives.filter((_, index) => index !== selectedIndex);
  const nextCandidates = [
    ...(hasReadingProgress(current) ? [{ origin: "previous" as const, ...current }] : []),
    ...remaining,
  ];

  for (const candidate of nextCandidates) {
    const key = progressKey(candidate);
    if (key === activeKey || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...candidate });
    if (candidates.length === 8) break;
  }

  return {
    readPage: active.readPage,
    readOffset: active.readOffset,
    lastReadAt: active.lastReadAt,
    readingPositionAlternatives: candidates,
  };
}
