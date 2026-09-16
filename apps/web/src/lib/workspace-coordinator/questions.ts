import { answerStreamEventSchema, streamedAnswerSchema } from "../answer-stream";
import type { OnAnswerProgress } from "../answer-stream-types";
import {
  isCrossLibraryAnswerRequest,
  validateCrossLibraryAnswerRequest,
} from "../cross-library-ask";
import { questionContextKey } from "../question-context";
import {
  resolveAnswerNoteEvidence,
  resolveCitation,
  retrieveEvidence,
  selectedDocumentNoteEvidence,
  selectedSources,
} from "../retrieval";
import type { AnswerNoteEvidence, AnswerRequest } from "../types";
import type { WorkspaceCoordinator } from "./coordinator";
import type { PendingQuestion, Session } from "./types";

/**
 * Owns in-flight question requests. Evidence disclosure is fenced by the exact
 * context key captured when the request started, so a workspace change while
 * the model streams stops that answer instead of letting it cite new material.
 */
export class QuestionsController {
  private pendingQuestions = new Set<PendingQuestion>();

  constructor(private core: WorkspaceCoordinator) {}

  busy(token: number): boolean {
    return [...this.pendingQuestions].some((pending) => pending.session.token === token);
  }

  hasSession(session: Session): boolean {
    return [...this.pendingQuestions].some((item) => item.session === session);
  }

  /** Stops every request whose evidence boundary no longer matches the session. */
  abortInvalidated(): void {
    for (const pending of this.pendingQuestions) {
      const error = this.questionError(pending);
      if (error) pending.controller.abort(error);
    }
  }

  collectSessions(collect: (session: Session) => void): void {
    for (const pending of this.pendingQuestions) collect(pending.session);
  }

  redactAccount(accountId: string, stopped: DOMException): void {
    for (const pending of this.pendingQuestions) {
      if (pending.session.user?.id === accountId) {
        pending.controller.abort(stopped);
        this.pendingQuestions.delete(pending);
      }
    }
  }

  async ask(
    request: AnswerRequest,
    signal: AbortSignal,
    token: number,
    onProgress?: OnAnswerProgress,
  ) {
    const session = this.core.active;
    if (!session?.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开问答。");
    if (this.core.isCloudReadOnly(session)) throw new Error(this.core.readOnlyMessage());
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    if (this.core.organizationBusy(token))
      throw new Error("资料整理正在进行，请等待完成或先停止整理，再发起问答。");
    // The all-library panel validates before it creates a conversation, but a
    // current local snapshot can change before this adapter runs. Recheck the
    // exact cross-library range here for both local and cloud paths; never
    // send a stale range and let it silently narrow downstream.
    if (isCrossLibraryAnswerRequest(request)) {
      const checked = validateCrossLibraryAnswerRequest(session.data, request);
      if (!checked.ok) throw checked.error;
    }
    if (session.user) {
      const contextKey = questionContextKey(session.data, request);
      // Reader saves the question before calling ask(). That conversation write
      // may still be pending; only unsynced evidence must block disclosure.
      if (
        session.blocked ||
        !session.knownRevision ||
        !session.confirmedCloud ||
        questionContextKey(session.confirmedCloud, request) !== contextKey
      )
        throw new Error("资料尚未同步，请保存成功后再检索云端资料。");
      const userId = session.user.id;
      const pending: PendingQuestion = {
        session,
        request: structuredClone(request),
        contextKey,
        controller: new AbortController(),
      };
      const stop = () => pending.controller.abort(new DOMException("已停止", "AbortError"));
      signal.addEventListener("abort", stop, { once: true });
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const rejectStopped = () => rejectAbort(pending.controller.signal.reason);
      pending.controller.signal.addEventListener("abort", rejectStopped, { once: true });
      this.pendingQuestions.add(pending);
      this.core.publish(session);
      let settled = false;
      const report: OnAnswerProgress = (value) => {
        if (settled) return;
        try {
          const error = this.questionError(pending);
          if (error) throw error;
          const event = answerStreamEventSchema.safeParse(value);
          if (!event.success || (event.data.type !== "progress" && event.data.type !== "draft"))
            throw new Error("问答进度格式无效，本次回答已停止。");
          if (event.data.type === "draft") this.validateQuestionAnswer(pending, event.data.answer);
          // Progress is temporary UI state, never a workspace write. Extractive
          // responses and disabled AI do not imitate model generation.
          if (
            session.data.aiEnabled &&
            (event.data.type !== "draft" || event.data.answer.mode === "model")
          )
            onProgress?.(structuredClone(event.data));
          const changed = this.questionError(pending);
          if (changed) throw changed;
        } catch (cause) {
          // A late asynchronous adapter callback must not throw outside ask().
          // Aborting also settles the request when an adapter ignores its signal.
          pending.controller.abort(
            cause instanceof Error ? cause : new Error("问答进度处理失败。"),
          );
        }
      };
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => {
            const error = this.questionError(pending);
            if (error) throw error;
            return this.core.io.askCloud(
              pending.request,
              pending.controller.signal,
              userId,
              report,
            );
          }),
          aborted,
        ]);
        const error = this.questionError(pending);
        if (error) throw error;
        return this.validateQuestionAnswer(pending, result);
      } catch (cause) {
        // A fetch rejection must not hide the more useful account/permission
        // change reason. An adapter ignoring abort must never publish late output.
        throw this.questionError(pending) ?? cause;
      } finally {
        settled = true;
        signal.removeEventListener("abort", stop);
        pending.controller.signal.removeEventListener("abort", rejectStopped);
        this.pendingQuestions.delete(pending);
        this.core.publish(session);
      }
    }
    const result = retrieveEvidence(session.data, request);
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    return result;
  }

  private validateQuestionAnswer(pending: PendingQuestion, value: unknown) {
    const answer = streamedAnswerSchema.safeParse(value);
    const data = pending.session.data;
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    const available = new Map(
      selectedSources(data, pending.request).map((source) => [source.id, source]),
    );
    const noteKey = (item: AnswerNoteEvidence) =>
      JSON.stringify([
        item.noteId,
        item.spaceId,
        item.sourceId,
        item.sourceVersionId,
        item.revision,
        item.updatedAt,
        item.blockId,
        item.title,
        item.quote,
      ]);
    const availableNotes = new Set(
      selectedDocumentNoteEvidence(data, pending.request).map(noteKey),
    );
    if (
      !answer.success ||
      answer.data.citations.some((citation) => {
        const source = available.get(citation.sourceId);
        const resolved = resolveCitation(data, citation);
        return (
          !data.aiEnabled ||
          !source ||
          (source.status !== "ready" && source.status !== "partial") ||
          !resolved ||
          resolved.source !== source ||
          !normalize(source.text).includes(normalize(resolved.chunk.text)) ||
          citation.title !== source.title ||
          citation.page !== resolved.chunk.page ||
          citation.section !== resolved.chunk.section
        );
      }) ||
      answer.data.noteEvidence?.some(
        (evidence) =>
          !data.aiEnabled ||
          evidence.sourceId !== pending.request.sourceId ||
          !availableNotes.has(noteKey(evidence)) ||
          !resolveAnswerNoteEvidence(data, evidence),
      )
    )
      throw new Error("回答依据不属于当前范围的确切资料或笔记版本，本次回答已停止。");
    return answer.data;
  }

  private questionError(pending: PendingQuestion): Error | null {
    if (pending.controller.signal.aborted) return pending.controller.signal.reason as Error;
    if (!this.core.isActive(pending.session))
      return new Error("当前账号已改变，本次回答已停止。请在当前账号重新提问。");
    if (!pending.session.ready)
      return new Error("资料正在更新，本次回答已停止。请在更新完成后重新提问。");
    if (this.core.isCloudReadOnly(pending.session)) return new Error(this.core.readOnlyMessage());
    if (this.core.hasNewerLocalUpdate(pending.session) || pending.session.loadingLocalUpdate)
      return new Error("另一个标签页已保存更新，本次回答已停止。请载入最新数据后重新提问。");
    if (questionContextKey(pending.session.data, pending.request) !== pending.contextKey)
      return new Error("本次问答的资料、版本或 AI 权限已改变，回答已停止。请确认当前范围后重试。");
    return null;
  }
}
