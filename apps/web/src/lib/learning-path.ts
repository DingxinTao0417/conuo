import type { ConceptRelation } from "./concept-relation-types";
import type { Note } from "./types";

export interface LearningPathItem {
  note: Note;
  prerequisites: Note[];
  cycle: boolean;
}

export interface LearningPath {
  items: LearningPathItem[];
  hasPrerequisites: boolean;
  hasCycle: boolean;
}

const noteTime = (note: Note) => Date.parse(note.createdAt) || 0;

function compareNotes(left: Note, right: Note): number {
  return noteTime(left) - noteTime(right) || left.id.localeCompare(right.id);
}

/** Builds a deterministic prerequisite order without changing workspace data. */
export function buildLearningPath(
  notes: readonly Note[],
  relations: readonly ConceptRelation[],
  spaceId: string,
): LearningPath {
  const nodes = notes
    .filter((note) => note.kind === "knowledge" && !note.deletedAt && note.spaceId === spaceId)
    .sort(compareNotes);
  const byId = new Map(nodes.map((note) => [note.id, note]));
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const note of nodes) {
    outgoing.set(note.id, new Set());
    incoming.set(note.id, new Set());
  }
  for (const relation of relations) {
    if (relation.deletedAt || relation.type !== "prerequisite" || relation.spaceId !== spaceId)
      continue;
    const from = relation.from.id;
    const to = relation.to.id;
    if (from === to || !byId.has(from) || !byId.has(to)) continue;
    outgoing.get(from)!.add(to);
    incoming.get(to)!.add(from);
  }
  const hasPrerequisites = [...outgoing.values()].some((targets) => targets.size > 0);
  if (!hasPrerequisites) return { items: [], hasPrerequisites: false, hasCycle: false };
  const originalPrerequisites = new Map(
    [...incoming].map(([id, values]) => [id, new Set(values)] as const),
  );

  const remaining = new Set(byId.keys());
  const ready: Note[] = nodes.filter((note) => incoming.get(note.id)!.size === 0);
  const cycleNodes = new Set<string>();
  const order: Note[] = [];
  const enqueue = (note: Note) => {
    if (!ready.some((item) => item.id === note.id)) ready.push(note);
    ready.sort(compareNotes);
  };

  while (remaining.size) {
    if (!ready.length) {
      const oldest = [...remaining].map((id) => byId.get(id)!).sort(compareNotes)[0]!;
      cycleNodes.add(oldest.id);
      // Remove all incoming edges to the oldest remaining node. This is the
      // deterministic Kahn break point for a cycle.
      for (const prerequisite of incoming.get(oldest.id) ?? []) {
        outgoing.get(prerequisite)?.delete(oldest.id);
      }
      incoming.set(oldest.id, new Set());
      enqueue(oldest);
    }
    const current = ready.shift()!;
    if (!remaining.delete(current.id)) continue;
    order.push(current);
    for (const next of outgoing.get(current.id) ?? []) {
      const prerequisites = incoming.get(next)!;
      prerequisites.delete(current.id);
      if (prerequisites.size === 0 && remaining.has(next)) enqueue(byId.get(next)!);
    }
  }

  return {
    items: order.map((note) => ({
      note,
      prerequisites: [...(originalPrerequisites.get(note.id) ?? [])]
        .map((id) => byId.get(id)!)
        .filter(Boolean)
        .sort(compareNotes),
      cycle: cycleNodes.has(note.id),
    })),
    hasPrerequisites: true,
    hasCycle: cycleNodes.size > 0,
  };
}
