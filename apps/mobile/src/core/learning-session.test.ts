import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blankWorkspace,
  type Answer,
  type Source,
  type Workspace,
} from "./contracts.ts";
import {
  discussionFor,
  filterLibrarySources,
  listLocationKey,
  pruneDiscussions,
  prepareDiscussionQuestion,
  completeQuestionRequest,
  recoverableQuestions,
  sourceStatusLabel,
  unsentQuestionCount,
  updateDiscussion,
  type Discussions,
  type PendingQuestions,
} from "./learning-session.ts";
import { createDraftRecoveryStore } from "./draft-recovery.ts";
import type { QuestionDraftInput } from "./draft-recovery.ts";

const date = "2026-09-21T00:00:00Z";
function source(id: string, spaceIds: string[]): Source {
  return {
    id,
    versionId: `${id}-v1`,
    title: `${id} 主动回忆`,
    kind: "text",
    filename: `${id}.txt`,
    text: "正文",
    chunks: [
      {
        id: `${id}-chunk`,
        sourceId: id,
        versionId: `${id}-v1`,
        text: "正文",
        section: "正文",
      },
    ],
    spaceIds,
    tags: ["学习"],
    status: "ready",
    aiAllowed: true,
    starred: false,
    createdAt: date,
    updatedAt: date,
    deletedAt: null,
  };
}
function workspace(): Workspace {
  return {
    ...blankWorkspace(),
    aiEnabled: true,
    spaces: [
      {
        id: "learning",
        name: "学习",
        color: "purple",
        goal: "",
        archived: false,
        createdAt: date,
      },
    ],
    sources: [
      source("library", ["learning"]),
      source("inbox", []),
      source("orphan", ["missing"]),
    ],
  };
}
const answer: Answer = {
  content: "上一条已完成回答",
  citations: [],
  mode: "extractive",
};

test("an unanswered submitted question survives authentication loss as input, without the old answer or a second request", async () => {
  const data = workspace(),
    target = data.sources[0];
  const discussions: Discussions = new Map();
  const pending: PendingQuestions = new Map();
  const initial = discussionFor(discussions, data, target);
  updateDiscussion(discussions, target.id, initial.scopeKey, {
    question: "  A new question?  ",
    questionDirty: true,
    answer,
    answerQuestion: "Earlier question",
  });
  const payload = prepareDiscussionQuestion(
    discussions,
    data,
    target,
    "request-one",
  );
  pending.set(target.id, {
    requestId: payload.requestId,
    scopeKey: initial.scopeKey,
    versionId: target.versionId,
    question: discussions.get(target.id)!.question,
  });
  const scope = { owner: "owner-a", generation: 1 };
  const recovery = createDraftRecoveryStore();
  recovery.activate(scope);
  recovery.capture(scope, {
    questions: recoverableQuestions(discussions, data, pending),
  });
  // Auth may close the screen before its request rejection handler gets to run.
  recovery.suspend(scope);
  const renewed = { ...scope, generation: 2 };
  recovery.activate(renewed);
  const result = await recovery.restoreExplicit({
    scope: renewed,
    confirmed: true,
    isCurrent: () => true,
    isFenceBlocked: async () => false,
    verifyUser: async () => scope.owner,
    loadWorkspace: async () => ({ data, revision: 4 }),
    sha256: async () => {
      throw new Error("No save receipt should be needed");
    },
  });
  assert.equal(result.status, "restored");
  if (result.status !== "restored") return;
  assert.deepEqual(result.drafts.questions, [
    {
      sourceId: target.id,
      versionId: target.versionId,
      question: "  A new question?  ",
      questionDirty: true,
      kind: "unanswered",
      context: "ready",
    },
  ]);
  assert.equal(JSON.stringify(result).includes(answer.content), false);
  assert.equal(JSON.stringify(result).includes("Earlier question"), false);
});

test("new edits and an explicit clear override an unanswered request, and its late completion cannot clear a newer request", () => {
  const data = workspace(),
    target = data.sources[0];
  const discussions: Discussions = new Map();
  const pending: PendingQuestions = new Map();
  const initial = discussionFor(discussions, data, target);
  updateDiscussion(discussions, target.id, initial.scopeKey, {
    question: "First",
    questionDirty: false,
  });
  pending.set(target.id, {
    requestId: "one",
    scopeKey: initial.scopeKey,
    versionId: target.versionId,
    question: "First",
  });
  updateDiscussion(discussions, target.id, initial.scopeKey, {
    question: "Second",
    questionDirty: true,
  });
  assert.equal(
    recoverableQuestions(discussions, data, pending)[0].question,
    "Second",
  );
  assert.equal(
    recoverableQuestions(discussions, data, pending)[0].kind,
    "unsent",
  );
  updateDiscussion(discussions, target.id, initial.scopeKey, {
    question: "",
    questionDirty: true,
  });
  assert.deepEqual(recoverableQuestions(discussions, data, pending), []);
  pending.set(target.id, {
    requestId: "two",
    scopeKey: initial.scopeKey,
    versionId: target.versionId,
    question: "Second",
  });
  assert.equal(completeQuestionRequest(pending, target.id, "one"), false);
  assert.equal(pending.get(target.id)?.requestId, "two");
});

test("discarding retained questions while an answer is pending cannot be undone by its late completion and reauthentication", async () => {
  const data = workspace(),
    target = data.sources[0];
  const discussions: Discussions = new Map();
  const pending: PendingQuestions = new Map();
  const initial = discussionFor(discussions, data, target);
  updateDiscussion(discussions, target.id, initial.scopeKey, {
    question: "Question awaiting answer",
    questionDirty: false,
  });
  pending.set(target.id, {
    requestId: "in-flight",
    scopeKey: initial.scopeKey,
    versionId: target.versionId,
    question: "Question awaiting answer",
  });
  const retained: { current: QuestionDraftInput[] } = {
    current: [
      {
        sourceId: "removed-source",
        versionId: "old",
        question: "Explicitly discarded words",
        questionDirty: true,
        kind: "unsent",
      },
    ],
  };
  const vault = createDraftRecoveryStore();
  const scope = { owner: "owner-a", generation: 1 };
  vault.activate(scope);
  // This callback is created before the user discards retained inputs, like an async render closure.
  const capture = () =>
    vault.capture(scope, {
      questions: recoverableQuestions(discussions, data, pending, retained),
    });
  capture();
  let finish!: () => void;
  const response = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const answerCompleted = (async () => {
    await response;
    updateDiscussion(discussions, target.id, initial.scopeKey, {
      answer,
      answerQuestion: "Question awaiting answer",
    });
    completeQuestionRequest(pending, target.id, "in-flight");
    capture();
  })();
  retained.current = [];
  capture();
  // Keep another, unrelated input so this assertion checks restored content, not only emptiness.
  vault.capture(scope, {
    note: {
      title: "Remaining draft",
      text: "My own input",
      spaceId: "learning",
    },
  });
  finish();
  await answerCompleted;
  vault.suspend(scope);
  const renewed = { ...scope, generation: 2 };
  vault.activate(renewed);
  const result = await vault.restoreExplicit({
    scope: renewed,
    confirmed: true,
    isCurrent: () => true,
    isFenceBlocked: async () => false,
    verifyUser: async () => scope.owner,
    loadWorkspace: async () => ({ data, revision: 4 }),
    sha256: async () => {
      throw new Error("No pending note was submitted");
    },
  });
  assert.equal(result.status, "restored");
  if (result.status !== "restored") return;
  assert.deepEqual(result.drafts.questions, []);
  assert.equal(result.drafts.note?.text, "My own input");
  assert.equal(
    JSON.stringify(result).includes("Explicitly discarded words"),
    false,
  );
});

test("received answers and invalidated source scopes cannot become recoverable unanswered questions", () => {
  const data = workspace(),
    target = data.sources[0];
  const discussions: Discussions = new Map();
  const pending: PendingQuestions = new Map();
  const initial = discussionFor(discussions, data, target);
  updateDiscussion(discussions, target.id, initial.scopeKey, {
    question: "Question",
    questionDirty: false,
  });
  const request = {
    requestId: "one",
    scopeKey: initial.scopeKey,
    versionId: target.versionId,
    question: "Question",
  };
  pending.set(target.id, request);
  updateDiscussion(discussions, target.id, initial.scopeKey, {
    answer,
    answerQuestion: "Question",
  });
  assert.equal(completeQuestionRequest(pending, target.id, "one"), true);
  assert.deepEqual(recoverableQuestions(discussions, data, pending), []);
  pending.set(target.id, request);
  data.sources[0] = {
    ...target,
    versionId: "changed-version",
    aiAllowed: false,
  };
  pruneDiscussions(discussions, data);
  assert.deepEqual(recoverableQuestions(discussions, data, pending), []);
  data.sources[0].deletedAt = date;
  assert.deepEqual(recoverableQuestions(discussions, data, pending), []);
});

test("inbox contains only active unassigned sources, while whitespace searches remain useful", () => {
  const data = workspace();
  data.sources.push({ ...source("deleted", []), deletedAt: date });
  assert.deepEqual(
    filterLibrarySources(data, "inbox", "  ").map((item) => item.id),
    ["inbox"],
  );
  assert.deepEqual(
    filterLibrarySources(data, "learning", " 主动 ").map((item) => item.id),
    ["library"],
  );
  assert.equal(filterLibrarySources(data, "all", "学习").length, 3);
  assert.equal(filterLibrarySources(data, "learning", "无匹配").length, 0);
});

test("list positions have separate global, library, search and note destinations", () => {
  const make = (filter: string, search = "") =>
    listLocationKey({ tab: "library", filter, search });
  assert.notEqual(make("all"), make("inbox"));
  assert.notEqual(make("learning"), make("learning", "主动"));
  assert.equal(make("learning", "  A  "), make("learning", "a"));
  assert.equal(
    listLocationKey({ tab: "home", filter: "learning", search: "old" }),
    listLocationKey({ tab: "home", filter: "all", search: "" }),
  );
  assert.notEqual(
    listLocationKey({ tab: "knowledge", filter: "all", search: "" }),
    make("all"),
  );
});

test("drafts, answered question and answer position survive revisiting a source but not another account session", () => {
  const data = workspace();
  const store: Discussions = new Map();
  const first = discussionFor(store, data, data.sources[0]);
  updateDiscussion(store, data.sources[0].id, first.scopeKey, {
    question: "还没发送的问题",
    questionDirty: true,
    answer,
    answerQuestion: "原先已答的问题",
    scrollOffset: 320,
  });
  const another = discussionFor(store, data, data.sources[1]);
  assert.equal(another.question, "");
  const restored = discussionFor(store, data, data.sources[0]);
  assert.equal(restored.question, "还没发送的问题");
  assert.equal(restored.answerQuestion, "原先已答的问题");
  assert.equal(restored.scrollOffset, 320);
  assert.equal(discussionFor(new Map(), data, data.sources[0]).answer, null);
});

test("failed or stopped follow-up keeps the completed answer paired with its original question", () => {
  const data = workspace();
  const store: Discussions = new Map();
  const original = discussionFor(store, data, data.sources[0]);
  updateDiscussion(store, "library", original.scopeKey, {
    answer,
    answerQuestion: "第一问",
    question: "第二问",
  });
  updateDiscussion(store, "library", original.scopeKey, { error: "连接失败" });
  const state = discussionFor(store, data, data.sources[0]);
  assert.equal(state.question, "第二问");
  assert.equal(state.answerQuestion, "第一问");
  assert.equal(state.answer, answer);
  assert.equal(state.error, "连接失败");
});

test("changed versions, permissions and scope retain unsent words but invalidate prior evidence", () => {
  for (const change of [
    (data: Workspace) => {
      data.sources[0].versionId = "v2";
    },
    (data: Workspace) => {
      data.sources[0].aiAllowed = false;
    },
    (data: Workspace) => {
      data.aiEnabled = false;
    },
    (data: Workspace) => {
      data.spaces[0].archived = true;
    },
    (data: Workspace) => {
      data.sources[0].spaceIds = [];
    },
    (data: Workspace) => {
      data.sources[0].status = "failed";
    },
  ]) {
    const data = workspace();
    const store: Discussions = new Map();
    const old = discussionFor(store, data, data.sources[0]);
    updateDiscussion(store, "library", old.scopeKey, {
      question: "旧输入",
      questionDirty: true,
      answer,
    });
    change(data);
    pruneDiscussions(store, data);
    assert.equal(
      updateDiscussion(store, "library", old.scopeKey, { answer }),
      false,
    );
    assert.equal(discussionFor(store, data, data.sources[0]).answer, null);
    const revised = discussionFor(store, data, data.sources[0]);
    assert.equal(revised.question, "旧输入");
    assert.equal(revised.questionDirty, true);
    assert.equal(revised.answerQuestion, "");
    assert.match(revised.contextNotice, /未发送的问题已保留/);
  }
});

test("unrelated library changes do not erase drafts, but deletion and revoked-then-restored permission cannot resurrect evidence", () => {
  const data = workspace();
  const store: Discussions = new Map();
  const first = discussionFor(store, data, data.sources[0]);
  updateDiscussion(store, "library", first.scopeKey, {
    question: "保留",
    questionDirty: true,
    answer,
  });
  data.spaces.push({ ...data.spaces[0], id: "unrelated" });
  pruneDiscussions(store, data);
  assert.equal(discussionFor(store, data, data.sources[0]).question, "保留");
  data.sources[0].aiAllowed = false;
  pruneDiscussions(store, data);
  data.sources[0].aiAllowed = true;
  assert.equal(discussionFor(store, data, data.sources[0]).answer, null);
  data.sources[0].deletedAt = date;
  pruneDiscussions(store, data);
  assert.equal(store.size, 0);
});

test("processing states remain explicit regardless of tags", () => {
  for (const [status, label] of [
    ["ready", "可阅读"],
    ["partial", "部分正文"],
    ["failed", "解析失败"],
    ["link-only", "仅收藏链接"],
    ["pending", "正在处理"],
  ]) {
    assert.equal(sourceStatusLabel({ ...source("tagged", []), status }), label);
  }
});

test("only unsubmitted drafts ask for confirmation before an intentional sign-out", () => {
  const data = workspace();
  const store: Discussions = new Map();
  const first = discussionFor(store, data, data.sources[0]);
  assert.equal(unsentQuestionCount(store), 0);
  updateDiscussion(store, "library", first.scopeKey, {
    question: " 新的问题 ",
    questionDirty: true,
  });
  assert.equal(unsentQuestionCount(store), 1);
  prepareDiscussionQuestion(store, data, data.sources[0], "explicit-send");
  updateDiscussion(store, "library", first.scopeKey, {
    answer,
    answerQuestion: "新的问题",
  });
  assert.equal(unsentQuestionCount(store), 0);
  updateDiscussion(store, "library", first.scopeKey, {
    question: "下一问",
    questionDirty: true,
    error: "连接中断",
  });
  assert.equal(unsentQuestionCount(store), 1);
  updateDiscussion(store, "library", first.scopeKey, { question: "  " });
  assert.equal(unsentQuestionCount(store), 0);
});

test("changing the primary active library invalidates the old question scope", () => {
  const data = workspace();
  data.spaces.push({ ...data.spaces[0], id: "another" });
  data.sources[0].spaceIds = ["learning", "another"];
  const store: Discussions = new Map();
  const original = discussionFor(store, data, data.sources[0]);
  updateDiscussion(store, "library", original.scopeKey, {
    answer,
    question: "旧范围",
  });
  data.sources[0].spaceIds.reverse();
  pruneDiscussions(store, data);
  assert.equal(
    updateDiscussion(store, "library", original.scopeKey, { answer }),
    false,
  );
  assert.equal(discussionFor(store, data, data.sources[0]).answer, null);
});

test("partial-to-ready refresh keeps a draft pending explicit send against the new context", () => {
  const data = workspace();
  data.sources[0].status = "partial";
  const store: Discussions = new Map();
  const previous = discussionFor(store, data, data.sources[0]);
  updateDiscussion(store, "library", previous.scopeKey, {
    question: "补全后如何理解？",
    questionDirty: true,
    answer,
    answerQuestion: "旧问题",
  });
  data.sources[0].status = "ready";
  data.sources[0].versionId = "library-v2";
  pruneDiscussions(store, data);
  const next = discussionFor(store, data, data.sources[0]);
  assert.equal(next.question, "补全后如何理解？");
  assert.equal(next.answer, null);
  assert.equal(unsentQuestionCount(store), 1);
  assert.match(next.contextNotice, /核对当前资料后再发送/);
  const payload = prepareDiscussionQuestion(
    store,
    data,
    data.sources[0],
    "new-explicit-send",
  );
  assert.equal(payload.question, "补全后如何理解？");
  assert.equal(payload.sourceVersions[0].versionId, "library-v2");
  assert.equal(discussionFor(store, data, data.sources[0]).contextNotice, "");
  assert.equal(unsentQuestionCount(store), 0);
});

test("a submitted or failed request is never silently migrated as a new pending question", () => {
  for (const error of ["", "已停止", "连接失败"]) {
    const data = workspace();
    const store: Discussions = new Map();
    const previous = discussionFor(store, data, data.sources[0]);
    updateDiscussion(store, "library", previous.scopeKey, {
      question: "已经发送",
      questionDirty: true,
    });
    prepareDiscussionQuestion(store, data, data.sources[0], "explicit-send");
    updateDiscussion(store, "library", previous.scopeKey, { error });
    data.sources[0].versionId = "v2";
    pruneDiscussions(store, data);
    const next = discussionFor(store, data, data.sources[0]);
    assert.equal(next.question, "");
    assert.equal(next.questionDirty, false);
    assert.equal(unsentQuestionCount(store), 0);
  }
});

test("local refusal does not mark a never-sent draft as submitted", () => {
  const data = workspace();
  data.sources[0].aiAllowed = false;
  const store: Discussions = new Map();
  const original = discussionFor(store, data, data.sources[0]);
  updateDiscussion(store, "library", original.scopeKey, {
    question: "尚未提交的问题",
    questionDirty: true,
  });
  assert.throws(() =>
    prepareDiscussionQuestion(
      store,
      data,
      data.sources[0],
      "not-a-network-request",
    ),
  );
  assert.equal(unsentQuestionCount(store), 1);
  data.sources[0].aiAllowed = true;
  pruneDiscussions(store, data);
  assert.equal(
    discussionFor(store, data, data.sources[0]).question,
    "尚未提交的问题",
  );
});

test("an explicitly reedited identical question remains a draft, while deletion never revives it", () => {
  const data = workspace();
  const store: Discussions = new Map();
  const original = discussionFor(store, data, data.sources[0]);
  updateDiscussion(store, "library", original.scopeKey, {
    question: "再解释一下",
    questionDirty: true,
  });
  prepareDiscussionQuestion(store, data, data.sources[0], "sent");
  updateDiscussion(store, "library", original.scopeKey, {
    answer,
    answerQuestion: "再解释一下",
  });
  updateDiscussion(store, "library", original.scopeKey, {
    question: "再解释一下",
    questionDirty: true,
  });
  data.sources[0].versionId = "v2";
  pruneDiscussions(store, data);
  assert.equal(
    discussionFor(store, data, data.sources[0]).question,
    "再解释一下",
  );
  data.sources[0].deletedAt = date;
  pruneDiscussions(store, data);
  data.sources[0].deletedAt = null;
  assert.equal(discussionFor(store, data, data.sources[0]).question, "");
  assert.equal(discussionFor(new Map(), data, data.sources[0]).question, "");
});
