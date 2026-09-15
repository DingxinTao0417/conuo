"use client";

import { useEffect, useRef, useState } from "react";
import {
  clearAccountKnowledgeUpdateReviewDrafts,
  currentKnowledgeUpdateReviewDraft,
  knowledgeUpdateDraftContract,
  knowledgeUpdateDraftKey,
  knowledgeUpdateReviewDraftSchema,
  loadKnowledgeUpdateReviewDrafts,
  saveKnowledgeUpdateReviewDraft,
  type KnowledgeUpdateDraftSession,
  type KnowledgeUpdateReviewDraft,
  type StoredKnowledgeUpdateReviewDraft,
} from "./knowledge-update-review-drafts";
import type { WorkspaceData } from "./types";
import type { KnowledgeUpdateReviewDraftStore } from "./web-review-draft-store";

export interface KnowledgeUpdateDraftSaveStatus {
  kind: "loading" | "idle" | "saving" | "saved" | "error";
  message: string;
}

interface DraftContext {
  accountId: string;
  active: boolean;
  entries: Record<string, StoredKnowledgeUpdateReviewDraft>;
  touched: Set<string>;
  session?: Promise<KnowledgeUpdateDraftSession>;
  loadedSession?: KnowledgeUpdateDraftSession;
  hydrated: boolean;
  queue: Promise<void>;
  pending: number;
  error: string;
  saveErrors: Map<string, string>;
  intents: Map<
    string,
    { noteId: string; jobId: string; entry: StoredKnowledgeUpdateReviewDraft | null }
  >;
  cleanup: { pending: number; accounts: Set<string>; barriers: Map<string, Promise<void>> };
}

/** Keeps review drafts outside workspace, cloud synchronization, and backups. */
export function useKnowledgeUpdateReviewDrafts(
  accountId: string,
  data: WorkspaceData,
  ready: boolean,
  transientStore?: KnowledgeUpdateReviewDraftStore,
) {
  const store = transientStore ?? {
    load: (...args: Parameters<typeof loadKnowledgeUpdateReviewDrafts>) =>
      loadKnowledgeUpdateReviewDrafts(...args),
    save: (...args: Parameters<typeof saveKnowledgeUpdateReviewDraft>) =>
      saveKnowledgeUpdateReviewDraft(...args),
    clear: (...args: Parameters<typeof clearAccountKnowledgeUpdateReviewDrafts>) =>
      clearAccountKnowledgeUpdateReviewDrafts(...args),
  };
  const idleStatus: KnowledgeUpdateDraftSaveStatus = transientStore
    ? { kind: "idle", message: "审核勾选和编辑仅暂存在当前页面，应用后保存到云端。" }
    : { kind: "idle", message: "审核勾选和编辑会保存在本机；切换账号时会清除。" };
  const savingStatus: KnowledgeUpdateDraftSaveStatus = transientStore
    ? { kind: "saving", message: "正在更新当前页面的审核编辑。" }
    : { kind: "saving", message: "正在保存本机审核草稿，完成前刷新可能丢失最新修改。" };
  const ownerRef = useRef(accountId);
  const dataRef = useRef(data);
  const readyRef = useRef(ready);
  const mountedRef = useRef(false);
  const contextRef = useRef<DraftContext | null>(null);
  const cleanupRef = useRef({
    pending: 0,
    accounts: new Set<string>(),
    barriers: new Map<string, Promise<void>>(),
  });
  ownerRef.current = accountId;
  dataRef.current = data;
  readyRef.current = ready;
  const [view, setView] = useState<{
    accountId: string;
    entries: Record<string, StoredKnowledgeUpdateReviewDraft>;
    status: KnowledgeUpdateDraftSaveStatus;
  }>({ accountId, entries: {}, status: idleStatus });

  function current(context: DraftContext): boolean {
    return (
      context.active && contextRef.current === context && ownerRef.current === context.accountId
    );
  }

  function publish(context: DraftContext, status?: KnowledgeUpdateDraftSaveStatus) {
    if (!current(context) || !mountedRef.current) return;
    setView((previous) => ({
      accountId: context.accountId,
      entries: { ...context.entries },
      status: status ?? (previous.accountId === context.accountId ? previous.status : idleStatus),
    }));
  }

  function settledStatus(context: DraftContext): KnowledgeUpdateDraftSaveStatus {
    if (context.pending) return savingStatus;
    if (context.cleanup.pending)
      return {
        kind: "saving",
        message: "正在清理之前账号的本机审核草稿，当前账号的编辑保持可见。",
      };
    if (context.cleanup.accounts.size)
      return {
        kind: "error",
        message: "之前账号的本机审核草稿尚未清理成功，当前账号不会读取这些草稿。",
      };
    const saveError = context.saveErrors.values().next().value;
    if (saveError) return { kind: "error", message: saveError };
    if (context.error) return { kind: "error", message: context.error };
    return Object.keys(context.entries).length
      ? {
          kind: "saved",
          message: transientStore
            ? "当前审核编辑已暂存；应用后才会保存到云端，刷新会清除未提交的编辑。"
            : "审核勾选和编辑已保存到本机，刷新后可恢复。",
        }
      : idleStatus;
  }

  function load(context: DraftContext): Promise<KnowledgeUpdateDraftSession> {
    if (context.session) return context.session;
    context.session = (async () => {
      // A quick A -> B -> A must not recover A's record before its outgoing
      // cleanup has committed. A failed barrier remains until explicit retry.
      const barrier = cleanupRef.current.barriers.get(context.accountId);
      if (barrier) await barrier;
      if (cleanupRef.current.accounts.has(context.accountId))
        throw new Error("该账号之前的本机审核草稿尚未清理成功。");
      return store.load(context.accountId);
    })()
      .then((session) => {
        context.loadedSession = session;
        hydrate(context, session);
        return session;
      })
      .catch((cause: unknown) => {
        if (current(context)) {
          context.error =
            "未能读取本机审核草稿。当前勾选和编辑仍保留在页面中，刷新可能丢失；已保存的记录未被覆盖。";
          publish(context, settledStatus(context));
        }
        throw cause;
      });
    return context.session;
  }

  function hydrate(context: DraftContext, session: KnowledgeUpdateDraftSession) {
    if (!current(context) || !readyRef.current || context.hydrated) return;
    context.hydrated = true;
    for (const stored of session.drafts) {
      const key = knowledgeUpdateDraftKey(context.accountId, stored.noteId, stored.jobId);
      if (context.touched.has(key)) continue;
      const entry = currentKnowledgeUpdateReviewDraft(dataRef.current, stored, context.accountId);
      if (entry) context.entries[key] = entry;
      if (!entry || JSON.stringify(entry.draft) !== JSON.stringify(stored.draft))
        enqueue(context, stored.noteId, stored.jobId, entry);
    }
    publish(context, settledStatus(context));
  }

  function enqueue(
    context: DraftContext,
    noteId: string,
    jobId: string,
    entry: StoredKnowledgeUpdateReviewDraft | null,
  ) {
    context.pending += 1;
    context.error = "";
    const snapshot = entry ? structuredClone(entry) : null;
    const key = knowledgeUpdateDraftKey(context.accountId, noteId, jobId);
    const intent = { noteId, jobId, entry: snapshot };
    context.intents.set(key, intent);
    publish(context, savingStatus);
    context.queue = context.queue
      .then(async () => {
        const session = await load(context);
        if (!current(context)) return;
        if (!readyRef.current) throw new Error("工作区尚未恢复，停止修改本机审核草稿。");
        const valid = snapshot
          ? currentKnowledgeUpdateReviewDraft(dataRef.current, snapshot, context.accountId)
          : null;
        await store.save(session, noteId, jobId, valid);
        if (context.intents.get(key) === intent) {
          context.intents.delete(key);
          context.saveErrors.delete(key);
        }
      })
      .catch(() => {
        if (!current(context)) return;
        context.saveErrors.set(
          key,
          snapshot
            ? "本机审核草稿未能保存。当前勾选和编辑仍保留在页面中，刷新可能丢失最新修改。"
            : "本机审核草稿未能清理。当前页面已移除该草稿，旧勾选或改写可能在刷新后再次出现；失效建议不会恢复。",
        );
      })
      .finally(() => {
        context.pending -= 1;
        publish(context, settledStatus(context));
      });
  }

  function cleanupOwner(owner: string): Promise<void> {
    cleanupRef.current.pending += 1;
    const context = contextRef.current;
    if (context) publish(context, settledStatus(context));
    const previous = cleanupRef.current.barriers.get(owner);
    const barrier: Promise<void> = (async () => {
      try {
        if (previous) await previous.catch(() => {});
        await store.clear(owner);
        cleanupRef.current.accounts.delete(owner);
      } catch (cause) {
        cleanupRef.current.accounts.add(owner);
        throw cause;
      } finally {
        cleanupRef.current.pending -= 1;
        const latest = contextRef.current;
        if (latest) publish(latest, settledStatus(latest));
      }
    })();
    cleanupRef.current.barriers.set(owner, barrier);
    void barrier
      .then(() => {
        if (cleanupRef.current.barriers.get(owner) === barrier)
          cleanupRef.current.barriers.delete(owner);
      })
      .catch(() => {});
    return barrier;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Already requested saves may finish; stale UI callbacks are refused.
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!transientStore) return;
    return () => {
      const context = contextRef.current;
      if (context?.accountId === accountId) context.active = false;
      void transientStore.clear(accountId).catch(() => {});
    };
  }, [accountId, transientStore]);

  useEffect(() => {
    let context = contextRef.current;
    if (!context || context.accountId !== accountId) {
      const previous = context;
      if (previous) previous.active = false;
      context = {
        accountId,
        active: true,
        entries: {},
        touched: new Set(),
        hydrated: false,
        queue: Promise.resolve(),
        pending: 0,
        error: "",
        saveErrors: new Map(),
        intents: new Map(),
        cleanup: cleanupRef.current,
      };
      contextRef.current = context;
      publish(context, idleStatus);
      if (previous) {
        void cleanupOwner(previous.accountId).catch(() => {});
      }
    }
    if (ready && !context.session) {
      publish(context, { kind: "loading", message: "正在读取本机审核草稿。" });
      void load(context).catch(() => {});
    }
    if (ready && context.loadedSession) hydrate(context, context.loadedSession);
    // Persistence is driven by the account/load boundary, not render closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, ready]);

  useEffect(() => {
    const context = contextRef.current;
    if (!context || !ready || !current(context)) return;
    for (const [key, stored] of Object.entries(context.entries)) {
      const entry = currentKnowledgeUpdateReviewDraft(data, stored, accountId);
      if (entry && JSON.stringify(entry.draft) === JSON.stringify(stored.draft)) continue;
      context.touched.add(key);
      if (entry) context.entries[key] = entry;
      else delete context.entries[key];
      enqueue(context, stored.noteId, stored.jobId, entry);
    }
    // Exact current validity decides which persisted tasks may remain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, data, ready]);

  function change(noteId: string, jobId: string, draft: KnowledgeUpdateReviewDraft | null) {
    const context = contextRef.current;
    if (!context || !current(context) || !readyRef.current || !mountedRef.current) return;
    const key = knowledgeUpdateDraftKey(accountId, noteId, jobId);
    context.touched.add(key);
    const job = dataRef.current.organizationJobs?.find((item) => item.id === jobId);
    const parsed = draft ? knowledgeUpdateReviewDraftSchema.safeParse(draft) : null;
    // Invalid new input cannot replace a still usable in-memory edit.
    if (parsed && !parsed.success) {
      context.error = "审核草稿超出建议数量或文字长度限制，当前编辑未被替换。";
      publish(context, settledStatus(context));
      return;
    }
    const entry =
      job && parsed?.success
        ? currentKnowledgeUpdateReviewDraft(
            dataRef.current,
            {
              accountId,
              noteId,
              jobId,
              contract: knowledgeUpdateDraftContract(job),
              draft: parsed.data,
            },
            accountId,
          )
        : null;
    if (entry) context.entries[key] = entry;
    else delete context.entries[key];
    enqueue(context, noteId, jobId, entry);
  }

  function removeChanges(noteId: string, jobId: string, ids: string[]) {
    const context = contextRef.current;
    if (!context || !current(context)) return;
    const stored = context.entries[knowledgeUpdateDraftKey(accountId, noteId, jobId)];
    if (!stored) return;
    const removed = new Set(ids);
    change(noteId, jobId, {
      selectedChangeIds: stored.draft.selectedChangeIds.filter((id) => !removed.has(id)),
      editedTexts: Object.fromEntries(
        Object.entries(stored.draft.editedTexts).filter(([id]) => !removed.has(id)),
      ),
    });
  }

  function retry() {
    const context = contextRef.current;
    if (
      !context ||
      !current(context) ||
      !readyRef.current ||
      context.pending ||
      context.cleanup.pending
    )
      return;
    context.error = "";
    context.pending += 1;
    publish(context, savingStatus);
    void (async () => {
      try {
        await Promise.all([...context.cleanup.accounts].map(cleanupOwner));
        if (!current(context) || !readyRef.current) return;
        context.session = undefined;
        context.loadedSession = undefined;
        context.hydrated = false;
        await load(context);
        // Retry uses the latest intent after every awaited boundary. An edit
        // made while loading must not be followed by a stale replay snapshot.
        const replay = new Map(context.intents);
        for (const [key, entry] of Object.entries(context.entries))
          if (!replay.has(key))
            replay.set(key, { noteId: entry.noteId, jobId: entry.jobId, entry });
        for (const intent of replay.values())
          enqueue(context, intent.noteId, intent.jobId, intent.entry);
        await context.queue;
      } catch {
        // Read/save/cleanup keeps its precise failure state and every intent.
      } finally {
        context.pending -= 1;
        publish(context, settledStatus(context));
      }
    })();
  }

  function draftsFor(noteId: string): Record<string, KnowledgeUpdateReviewDraft> {
    if (view.accountId !== accountId) return {};
    return Object.fromEntries(
      Object.values(view.entries)
        .filter(
          (entry) =>
            entry.noteId === noteId && currentKnowledgeUpdateReviewDraft(data, entry, accountId),
        )
        .map((entry) => [entry.jobId, entry.draft]),
    );
  }

  return {
    draftsFor,
    change,
    removeChanges,
    retry,
    status: view.accountId === accountId ? view.status : idleStatus,
  };
}
