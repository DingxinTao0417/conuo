import { describe, expect, it } from "vitest";
import {
  formatQuestionHistoryRoute,
  parseQuestionHistoryFilter,
  questionHistoryCounts,
  questionHistoryItems,
  recentDiscussionSummary,
} from "./question-history";
import { createEmptyWorkspace } from "./seed";
import type { Conversation, Source } from "./types";

const earlier = "2026-09-12T08:00:00.000Z";
const later = "2026-09-12T09:00:00.000Z";

function source(id: string, spaceId: string, deletedAt: string | null = null): Source {
  return {
    id,
    versionId: `${id}-version`,
    title: `资料 ${id}`,
    filename: `${id}.txt`,
    kind: "text",
    mime: "text/plain",
    size: 1,
    hash: id,
    spaceIds: [spaceId],
    tags: [],
    status: "ready",
    text: id,
    chunks: [],
    createdAt: earlier,
    updatedAt: later,
    deletedAt,
    aiAllowed: true,
    starred: false,
  };
}

function conversation(
  id: string,
  spaceId: string,
  sourceId: string,
  options: Partial<Conversation> = {},
): Conversation {
  return {
    id,
    spaceId,
    sourceId,
    title: `问题 ${id}`,
    scope: "document",
    sourceIds: [sourceId],
    messages: [],
    resolved: false,
    updatedAt: earlier,
    ...options,
  };
}

describe("question history", () => {
  it("serializes every status and restores valid filters from question routes", () => {
    expect(formatQuestionHistoryRoute("all", "all")).toBe("#questions?status=all");
    expect(formatQuestionHistoryRoute("space-a", "pending")).toBe(
      "#questions?space=space-a&status=pending",
    );
    expect(formatQuestionHistoryRoute("space-a", "resolved")).toBe(
      "#questions?space=space-a&status=resolved",
    );
    expect(parseQuestionHistoryFilter("#questions?status=pending")).toBe("pending");
    expect(parseQuestionHistoryFilter("#questions?status=resolved&space=space-a")).toBe("resolved");
    expect(parseQuestionHistoryFilter("#questions")).toBe("all");
    expect(parseQuestionHistoryFilter("#questions?status=unknown")).toBe("all");
    expect(parseQuestionHistoryFilter("#knowledge?status=resolved")).toBe("all");
  });

  it("applies space and status filters before sorting by the newest update", () => {
    const data = createEmptyWorkspace();
    const [space] = data.spaces;
    const activeSource = source("active", space.id);
    data.sources = [activeSource];
    data.conversations = [
      conversation("pending-earlier", space.id, activeSource.id),
      conversation("other-space", "inbox", activeSource.id, { updatedAt: later }),
      conversation("resolved-later", space.id, activeSource.id, {
        resolved: true,
        updatedAt: later,
      }),
    ];

    expect(questionHistoryItems(data, space.id, "all").map((item) => item.conversation.id)).toEqual(
      ["resolved-later", "pending-earlier"],
    );
    expect(
      questionHistoryItems(data, space.id, "pending").map((item) => item.conversation.id),
    ).toEqual(["pending-earlier"]);
    expect(questionHistoryCounts(data, space.id)).toEqual({ all: 2, pending: 1, resolved: 1 });
  });

  it("shows associated sources and exposes an original only after route resolution succeeds", () => {
    const data = createEmptyWorkspace();
    const [space] = data.spaces;
    const activeSource = source("active", space.id);
    const deletedSource = source("deleted", space.id, later);
    data.sources = [activeSource, deletedSource];
    data.conversations = [
      conversation("active-thread", space.id, activeSource.id, {
        messages: [
          {
            id: "answer",
            role: "assistant",
            content: "  最近的回答包含  原文依据。 ",
            citations: [],
            createdAt: later,
          },
        ],
      }),
      conversation("deleted-thread", space.id, deletedSource.id),
    ];

    const [active, deleted] = questionHistoryItems(data, space.id, "all");
    expect(active.sourceSummary).toBe("资料 active");
    expect(active.recentDiscussionSummary).toBe("最近回答：最近的回答包含 原文依据。");
    expect(active.originalSource?.id).toBe(activeSource.id);
    expect(active.action).toBe("continue");
    expect(deleted.sourceSummary).toContain("资料 deleted（已删除）");
    expect(deleted.sourceSummary).toContain("原资料已删除，可查看记录");
    expect(deleted.originalSource).toBeUndefined();
    expect(deleted.action).toBe("history");
    expect(recentDiscussionSummary(deleted.conversation)).toBe("还没有讨论内容。");
  });
});
