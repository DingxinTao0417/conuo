import type { Citation } from "../types";

const citationKey = (citation: Citation) => `${citation.sourceId}\u0000${citation.chunkId}`;

/** Keeps first occurrences: earlier, higher-priority evidence wins. */
export function uniqueCitations(items: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  const result: Citation[] = [];
  for (const item of items) {
    const key = citationKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** Evenly spaced picks in document order; always includes the first item. */
export function stratifiedSample<T>(items: readonly T[], count: number): T[] {
  if (count <= 0 || !items.length) return [];
  if (items.length <= count) return [...items];
  if (count === 1) return [items[0]!];
  const picked = new Set<number>();
  for (let index = 0; index < count; index++)
    picked.add(Math.round((index * (items.length - 1)) / (count - 1)));
  return [...picked].sort((a, b) => a - b).map((index) => items[index]!);
}

/** Round-robin so no single source consumes the whole context. */
export function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const result: T[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index++)
    for (const list of lists) if (index < list.length) result.push(list[index]!);
  return result;
}

/** The chunks just before and after each anchor inside its own source queue. */
export function adjacentCitations(
  anchors: readonly Citation[],
  queues: readonly (readonly Citation[])[],
  radius = 1,
): Citation[] {
  const result: Citation[] = [];
  for (const anchor of anchors) {
    const queue = queues.find((list) => list[0]?.sourceId === anchor.sourceId);
    const index = queue?.findIndex((item) => item.chunkId === anchor.chunkId) ?? -1;
    if (!queue || index < 0) continue;
    for (let offset = -radius; offset <= radius; offset++) {
      const neighbor = offset === 0 ? undefined : queue[index + offset];
      if (neighbor) result.push(neighbor);
    }
  }
  return result;
}
