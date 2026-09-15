const EXTRACTIVE_CITATION_MARKER = /^\[\[conuo-citation:([1-9]\d*)\]\]$/u;
const ANSWER_NOTE_MARKER = /^\[\[conuo-note:([1-9]\d*)\]\]$/u;

/** A controlled marker used only by the local extractive-answer formatter. */
export function extractiveCitationMarker(index: number) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("引用标记必须使用非负整数索引。");
  }
  return `[[conuo-citation:${index + 1}]]`;
}

export function extractiveCitationMarkerIndex(value: string) {
  const match = EXTRACTIVE_CITATION_MARKER.exec(value.trim());
  if (!match) return null;
  const index = Number.parseInt(match[1], 10) - 1;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

/** A controlled marker for user-note evidence in a grounded model answer. */
export function answerNoteMarker(index: number) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("笔记依据标记必须使用非负整数索引。");
  }
  return `[[conuo-note:${index + 1}]]`;
}

export function answerNoteMarkerIndex(value: string) {
  const match = ANSWER_NOTE_MARKER.exec(value.trim());
  if (!match) return null;
  const index = Number.parseInt(match[1], 10) - 1;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}
