import { describe, expect, it } from "vitest";
import {
  primaryLearningContinuation,
  recentlyReadSources,
  unresolvedConversations,
} from "./learning-continue";
import { createEmptyWorkspace } from "./seed";

const earlier = "2026-09-12T08:00:00.000Z";
const later = "2026-09-12T09:00:00.000Z";

function source(id: string, spaceIds: string[], lastReadAt?: string) {
  return {
    id,
    versionId: `${id}-version`,
    title: id,
    filename: `${id}.txt`,
    kind: "text" as const,
    mime: "text/plain",
    size: 1,
    hash: "",
    spaceIds,
    tags: [],
    status: "ready" as const,
    text: id,
    chunks: [],
    createdAt: earlier,
    updatedAt: "2026-09-12T10:00:00.000Z",
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    ...(lastReadAt ? { lastReadAt } : {}),
  };
}

function conversation(
  id: string,
  sourceId: string,
  spaceId: string,
  updatedAt: string,
  resolved = false,
) {
  return {
    id,
    spaceId,
    sourceId,
    title: id,
    scope: "document" as const,
    sourceIds: [sourceId],
    messages: [],
    resolved,
    updatedAt,
  };
}

describe("learning continuation", () => {
  it("orders source cards by actual reading activity instead of incidental metadata changes", () => {
    const data = createEmptyWorkspace();
    const [space] = data.spaces;
    data.sources.push(
      source("read-earlier", [space.id], earlier),
      source("read-later", [space.id], later),
      source("renamed-but-never-read", [space.id]),
      source("invalid-activity", [space.id], "not-a-timestamp"),
      { ...source("trashed", [space.id], "2026-09-12T11:00:00.000Z"), deletedAt: later },
    );

    expect(recentlyReadSources(data, "all").map((item) => item.id)).toEqual([
      "read-later",
      "read-earlier",
    ]);
    expect(recentlyReadSources(data, space.id).map((item) => item.id)).toEqual([
      "read-later",
      "read-earlier",
    ]);
  });

  it("keeps the inbox and space scopes separate", () => {
    const data = createEmptyWorkspace();
    const [space] = data.spaces;
    data.sources.push(source("inbox", [], later), source("space", [space.id], earlier));
    expect(recentlyReadSources(data, "inbox").map((item) => item.id)).toEqual(["inbox"]);
    expect(recentlyReadSources(data, space.id).map((item) => item.id)).toEqual(["space"]);
  });

  it("keeps user-marked unresolved questions in newest-first order", () => {
    const data = createEmptyWorkspace();
    const [space] = data.spaces;
    data.conversations.push(
      {
        id: "open-earlier",
        spaceId: space.id,
        title: "早的问题",
        scope: "space",
        sourceIds: [],
        messages: [],
        resolved: false,
        updatedAt: earlier,
      },
      {
        id: "open-later",
        spaceId: "inbox",
        title: "新的问题",
        scope: "space",
        sourceIds: [],
        messages: [],
        resolved: false,
        updatedAt: later,
      },
      {
        id: "resolved",
        spaceId: space.id,
        title: "已解决",
        scope: "space",
        sourceIds: [],
        messages: [],
        resolved: true,
        updatedAt: "2026-09-12T12:00:00.000Z",
      },
    );
    expect(unresolvedConversations(data, "all").map((item) => item.id)).toEqual([
      "open-later",
      "open-earlier",
    ]);
    expect(unresolvedConversations(data, space.id).map((item) => item.id)).toEqual([
      "open-earlier",
    ]);
  });

  it("binds the newest read source to its latest safely resumable unresolved question", () => {
    const data = createEmptyWorkspace();
    const [space] = data.spaces;
    const read = source("read-source", [space.id], later);
    data.sources.push(read);
    data.conversations.push(
      conversation("older-open-question", read.id, space.id, earlier),
      conversation("newer-resolved-question", read.id, space.id, "2026-09-12T12:00:00.000Z", true),
    );

    expect(primaryLearningContinuation(data, "all")).toEqual({
      source: read,
      spaceId: space.id,
      spaceName: space.name,
      conversation: data.conversations[0],
    });
  });

  it("does not attach questions from another source, space or unavailable route", () => {
    const data = createEmptyWorkspace();
    const [space] = data.spaces;
    const otherSpace = { ...space, id: "other-space", name: "另一个空间" };
    data.spaces.push(otherSpace);
    const read = source("read-source", [space.id], later);
    const other = source("other-source", [space.id], earlier);
    data.sources.push(read, other);
    data.conversations.push(
      conversation("other-source-question", other.id, space.id, "2026-09-12T13:00:00.000Z"),
      conversation("other-space-question", read.id, otherSpace.id, "2026-09-12T12:00:00.000Z"),
      {
        ...conversation("out-of-scope-question", read.id, space.id, "2026-09-12T11:00:00.000Z"),
        sourceIds: [],
      },
    );

    expect(primaryLearningContinuation(data, space.id)).toEqual({
      source: read,
      spaceId: space.id,
      spaceName: space.name,
    });
  });

  it("keeps a reading-only continuation and labels an inbox source", () => {
    const data = createEmptyWorkspace();
    const read = source("inbox-source", [], later);
    data.sources.push(read);

    expect(primaryLearningContinuation(data, "inbox")).toEqual({
      source: read,
      spaceId: "inbox",
      spaceName: "收件箱",
    });
    expect(primaryLearningContinuation(createEmptyWorkspace(), "all")).toBeNull();
  });
});
