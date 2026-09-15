import { describe, expect, it } from "vitest";
import { createDemoWorkspace } from "./seed";
import { createRecoverableSourceAnnotationDraft } from "./recoverable-drafts";

const deletedAt = "2026-09-14T08:00:00.000Z";
const text = "😀目标\n目标";
function fixture() {
  const source = { ...createDemoWorkspace().sources[0], text, chunks: [], deletedAt };
  const annotation = {
    id: "anchor-a",
    sourceId: source.id,
    versionId: source.versionId,
    quote: "目标",
    note: "第二处的离线批注",
    createdAt: deletedAt,
    textAnchor: { start: 5, end: 7 },
  };
  return { source, annotation };
}

describe("anchored recoverable annotations", () => {
  it("keeps a detached exact position in the deleted source without normalizing quote", () => {
    const { source, annotation } = fixture();
    const draft = createRecoverableSourceAnnotationDraft(source, deletedAt, annotation);
    expect(draft).toMatchObject({ quote: "目标", textAnchor: { start: 5, end: 7 } });
    annotation.textAnchor.start = 0;
    expect(draft).toMatchObject({ textAnchor: { start: 5, end: 7 } });
  });
  it("rejects a forged offset despite matching text elsewhere in the deleted source", () => {
    const { source, annotation } = fixture();
    expect(() =>
      createRecoverableSourceAnnotationDraft(source, deletedAt, {
        ...annotation,
        textAnchor: { start: 0, end: 2 },
      }),
    ).toThrow("原文位置");
  });
});
