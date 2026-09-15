import { describe, expect, it } from "vitest";
import { persistConversation } from "./conversations";
import { createEmptyWorkspace } from "./seed";
import type { Conversation } from "./types";

const now = "2026-09-12T12:00:00.000Z";

function conversation(spaceId: string, messages = 1): Conversation {
  return {
    id: "conversation-one",
    spaceId,
    sourceId: "source-one",
    title: "问题",
    scope: "document",
    sourceIds: ["source-one"],
    messages: Array.from({ length: messages }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      content: `消息 ${index}`,
      citations: [],
      createdAt: now,
    })),
    resolved: false,
    updatedAt: now,
  };
}

function crossLibraryConversation(): Conversation {
  return {
    id: "cross-library-conversation",
    spaceId: "all",
    title: "跨库问题",
    scope: "cross-library-sources",
    sourceIds: ["source-one"],
    messages: [],
    resolved: false,
    updatedAt: now,
  };
}

function answeredCrossLibraryConversation(versionId = "version-one"): Conversation {
  return {
    ...crossLibraryConversation(),
    messages: [
      {
        id: "cross-library-question",
        role: "user",
        content: "跨库问题",
        citations: [],
        createdAt: now,
      },
      {
        id: "cross-library-answer",
        role: "assistant",
        content: "跨库回答",
        citations: [],
        createdAt: now,
        attempt: {
          id: "cross-library-attempt",
          questionMessageId: "cross-library-question",
          scopeSnapshot: {
            scope: "cross-library-sources",
            sourceIds: ["source-one"],
            sourceVersions: [{ sourceId: "source-one", versionId }],
            spaceId: "all",
          },
          status: "completed",
        },
      },
    ],
  };
}

function comparisonConversation(rightVersionId = "version-right"): Conversation {
  return {
    id: "comparison-conversation",
    spaceId: "space-one",
    title: "对照问题",
    scope: "sources",
    sourceIds: ["source-left", "source-right"],
    comparison: {
      leftSourceId: "source-left",
      leftVersionId: "version-left",
      rightSourceId: "source-right",
      rightVersionId,
    },
    messages: [],
    resolved: false,
    updatedAt: now,
  };
}

function answeredComparisonConversation(rightVersionId = "version-right"): Conversation {
  const thread = comparisonConversation(rightVersionId);
  return {
    ...thread,
    messages: [
      {
        id: "comparison-question",
        role: "user",
        content: "两份资料有什么不同？",
        citations: [],
        createdAt: now,
      },
      {
        id: "comparison-answer",
        role: "assistant",
        content: "对照回答",
        citations: [],
        createdAt: now,
        attempt: {
          id: "comparison-attempt",
          questionMessageId: "comparison-question",
          scopeSnapshot: {
            scope: "sources",
            sourceIds: [...thread.sourceIds],
            sourceVersions: [
              { sourceId: "source-left", versionId: "version-left" },
              { sourceId: "source-right", versionId: rightVersionId },
            ],
            comparison: thread.comparison,
            spaceId: thread.spaceId,
          },
          status: "completed",
        },
      },
    ],
  };
}

describe("conversation persistence", () => {
  it("keeps a lifecycle-migrated inbox space when a late reader response arrives", () => {
    const data = createEmptyWorkspace();
    data.conversations = [conversation("inbox")];

    const saved = persistConversation(data, conversation("deleted-space", 2));

    expect(saved.conversations).toHaveLength(1);
    expect(saved.conversations[0]).toMatchObject({
      spaceId: "inbox",
      messages: [{ content: "消息 0" }, { content: "消息 1" }],
    });
  });

  it("moves a delayed first write out of a space that no longer exists", () => {
    const saved = persistConversation(createEmptyWorkspace(), conversation("deleted-space"));
    expect(saved.conversations[0].spaceId).toBe("inbox");
  });

  it("retains the all-library virtual space only for an explicit cross-library conversation", () => {
    const data = createEmptyWorkspace();
    const saved = persistConversation(data, crossLibraryConversation());

    expect(saved.conversations[0]).toMatchObject({
      id: "cross-library-conversation",
      scope: "cross-library-sources",
      spaceId: "all",
    });
  });

  it("does not let an ordinary conversation forge the all-library virtual space", () => {
    const saved = persistConversation(createEmptyWorkspace(), conversation("all"));
    expect(saved.conversations[0]).toMatchObject({
      scope: "document",
      spaceId: "inbox",
    });
  });

  it("drops an incomplete cross-library identity instead of persisting it as inbox history", () => {
    const data = createEmptyWorkspace();

    expect(
      persistConversation(data, {
        ...crossLibraryConversation(),
        sourceIds: [],
      }),
    ).toBe(data);
  });

  it("does not let a late write turn a fixed cross-library thread into another scope or range", () => {
    const data = createEmptyWorkspace();
    data.conversations = [crossLibraryConversation()];

    expect(
      persistConversation(data, {
        ...conversation("inbox", 2),
        id: "cross-library-conversation",
      }),
    ).toBe(data);
    expect(
      persistConversation(data, {
        ...crossLibraryConversation(),
        sourceIds: ["different-source"],
      }),
    ).toBe(data);
  });

  it("rejects a delayed cross-library write that changes an established source version", () => {
    const initial = createEmptyWorkspace();
    initial.conversations = [crossLibraryConversation()];
    const first = persistConversation(initial, answeredCrossLibraryConversation("version-one"));
    expect(first).not.toBe(initial);

    const late: Conversation = {
      ...answeredCrossLibraryConversation("version-one"),
      messages: [
        ...answeredCrossLibraryConversation("version-one").messages,
        {
          id: "follow-up-question",
          role: "user",
          content: "继续追问",
          citations: [],
          createdAt: now,
        },
        {
          id: "late-version-answer",
          role: "assistant",
          content: "迟到的不同版本回答",
          citations: [],
          createdAt: now,
          attempt: {
            id: "late-version-attempt",
            questionMessageId: "follow-up-question",
            scopeSnapshot: {
              scope: "cross-library-sources",
              sourceIds: ["source-one"],
              sourceVersions: [{ sourceId: "source-one", versionId: "version-two" }],
              spaceId: "all",
            },
            status: "completed",
          },
        },
      ],
    };

    expect(persistConversation(first, late)).toBe(first);
  });

  it("rejects a delayed comparison write that changes one fixed source version", () => {
    const initial = createEmptyWorkspace();
    initial.conversations = [comparisonConversation()];
    const first = persistConversation(initial, answeredComparisonConversation());
    expect(first).not.toBe(initial);

    const late = answeredComparisonConversation();
    late.messages = [
      ...late.messages,
      {
        id: "comparison-follow-up-question",
        role: "user",
        content: "继续比较",
        citations: [],
        createdAt: now,
      },
      {
        id: "comparison-late-answer",
        role: "assistant",
        content: "错误版本的回答",
        citations: [],
        createdAt: now,
        attempt: {
          id: "comparison-late-attempt",
          questionMessageId: "comparison-follow-up-question",
          scopeSnapshot: {
            scope: "sources",
            sourceIds: ["source-left", "source-right"],
            sourceVersions: [
              { sourceId: "source-left", versionId: "version-left" },
              { sourceId: "source-right", versionId: "version-right-v2" },
            ],
            comparison: {
              ...comparisonConversation().comparison!,
              rightVersionId: "version-right-v2",
            },
            spaceId: "space-one",
          },
          status: "completed",
        },
      },
    ];

    expect(persistConversation(first, late)).toBe(first);
  });

  it("does not let an old comparison draft replace a completed fixed-pair thread", () => {
    const initial = createEmptyWorkspace();
    initial.conversations = [comparisonConversation()];
    const answered = persistConversation(initial, answeredComparisonConversation());

    expect(persistConversation(answered, comparisonConversation())).toBe(answered);
  });
});
