"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { priorUserQuestions } from "@/lib/answer-context";
import { noteAskScopes } from "@/lib/ask-scopes";
import {
  createKnowledgePageEvidenceAnswerRequest,
  resolveKnowledgePageOriginalEvidence,
} from "@/lib/knowledge-page-evidence";
import type {
  AnswerAttempt,
  AnswerRequest,
  AnswerResult,
  Citation,
  Conversation,
  Message,
  Note,
  WorkspaceData,
} from "@/lib/types";
import AskPanel from "../../ai/ask-panel";
import { useAskConversation } from "../../ai/use-ask-conversation";
import { citationProblem } from "../../reader-utils";

export interface NoteAskPanelProps {
  data: WorkspaceData;
  note: Note;
  onAsk: (request: AnswerRequest, signal: AbortSignal) => Promise<AnswerResult>;
  onConversationChange: (conversation: Conversation) => void;
  onOpenSource: (sourceId: string, versionId?: string, citation?: Citation) => void;
  onClose: () => void;
  expectedUserId?: string;
}

function conversationTitle(note: Note) {
  return `原始依据：${note.title.trim() || "未命名知识页"}`.slice(0, 512);
}

/**
 * The knowledge page's question surface, and the reason "基于原始依据提问" is
 * no longer a view of its own: it is the shared AskPanel restricted to a single
 * range, "本页引用的资料".
 *
 * The range is derived rather than picked, but it is still an ordinary bounded
 * `sources` request. The page body never travels with it — a synthesis is not
 * evidence — and the range is recomputed whenever the page's citations change,
 * which also aborts any answer that was still being generated for the old one.
 */
export default function NoteAskPanel({
  data,
  note,
  onAsk,
  onConversationChange,
  onOpenSource,
  onClose,
  expectedUserId,
}: NoteAskPanelProps) {
  const ask = useAskConversation();
  const evidence = useMemo(() => resolveKnowledgePageOriginalEvidence(data, note), [data, note]);
  const identity = evidence.ok
    ? `${note.id}:${note.spaceId}:${evidence.sourceVersions
        .map((reference) => `${reference.sourceId}:${reference.versionId}`)
        .join("|")}`
    : `${note.id}:unavailable`;
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const activeIdentity = useRef(identity);
  const { reset, focusInput } = ask;

  useEffect(() => {
    if (activeIdentity.current === identity) return;
    activeIdentity.current = identity;
    // The page's citations changed underneath an open thread; drop it rather
    // than keep answers that were grounded in a range that no longer applies.
    setConversation(null);
    reset();
  }, [identity, reset]);
  useEffect(() => focusInput(), [focusInput]);

  const messages = conversation?.messages ?? [];
  const sources = evidence.ok ? evidence.sources : [];
  const unavailable = evidence.ok ? "" : evidence.message;

  async function send() {
    const question = ask.input.trim();
    if (!question || ask.busy || ask.running() || !evidence.ok) return;
    if (!data.aiEnabled) {
      ask.setError("资料问答已关闭，请先在设置中开启。");
      return;
    }

    const userContext = priorUserQuestions(messages);
    let request: AnswerRequest;
    try {
      request = createKnowledgePageEvidenceAnswerRequest(data, note, {
        question,
        requestId: crypto.randomUUID(),
        ...(userContext.length ? { userContext } : {}),
      });
    } catch (cause) {
      ask.setError(cause instanceof Error ? cause.message : "请重新确认原始资料范围。");
      return;
    }

    const now = new Date().toISOString();
    const questionMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
      citations: [],
      createdAt: now,
    };
    const next: Conversation = {
      ...(conversation ?? {
        id: crypto.randomUUID(),
        spaceId: note.spaceId,
        title: conversationTitle(note),
        scope: "sources" as const,
        sourceIds: [...request.sourceIds],
        messages: [],
        resolved: false,
      }),
      scope: "sources",
      sourceIds: [...request.sourceIds],
      messages: [...messages, questionMessage],
      updatedAt: now,
    };
    const attempt: AnswerAttempt = {
      id: request.requestId!,
      questionMessageId: questionMessage.id,
      scopeSnapshot: {
        scope: "sources",
        sourceIds: [...request.sourceIds],
        sourceVersions: request.sourceVersions?.map((reference) => ({ ...reference })),
        spaceId: request.spaceId,
        ...(userContext.length ? { userContext: [...userContext] } : {}),
      },
      status: "completed",
    };
    setConversation(next);
    onConversationChange(next);
    ask.setInput("");

    const requestIdentity = activeIdentity.current;
    const publish = (message: Message) => {
      const updated = {
        ...next,
        messages: [...next.messages, message],
        updatedAt: message.createdAt,
      };
      setConversation(updated);
      onConversationChange(updated);
    };
    await ask.run({
      accepts: () => activeIdentity.current === requestIdentity,
      dispatch: (signal) => onAsk(request, signal),
      onAnswer: (answer) => {
        if (activeIdentity.current !== requestIdentity) return;
        publish({
          id: crypto.randomUUID(),
          role: "assistant",
          content: answer.content,
          citations: answer.citations,
          mode: answer.mode,
          attempt,
          createdAt: new Date().toISOString(),
        });
      },
      onFailure: ({ message, stoppedByUser }) => {
        if (activeIdentity.current !== requestIdentity) return;
        publish({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          citations: [],
          error: message,
          attempt: { ...attempt, status: stoppedByUser ? "stopped" : "failed" },
          createdAt: new Date().toISOString(),
        });
      },
    });
  }

  return (
    <AskPanel
      ask={ask}
      feedbackUserId={expectedUserId}
      surface={{
        id: "note-ask-panel",
        label: "基于原始依据提问",
        title: "基于原始依据提问",
        description: "回答只检索本页引用且仍有效的原始资料。知识页正文不会发送给 AI。",
        placeholder: "提出一个需要回到原始资料核对的问题…",
        composerLabel: "基于原始依据提问",
        footnote: "回答只引用下方锁定的资料版本；请回到原文核对结论。",
        historyTitle: "本页的依据问答",
        historyEmpty: "发送第一个问题后，对话会保存在这里。",
        empty: {
          title: "从原始资料开始核对",
          text: "例如：这些资料分别如何解释同一个概念？",
          prompts: ["这些资料分别如何解释同一个概念？", "它们之间有哪些不一致？"],
        },
      }}
      scope={{
        active: "note-evidence",
        options: noteAskScopes,
        locked: true,
        onChange: () => {},
        blockedMessage: unavailable || undefined,
        // An unavailable evidence range will not resolve itself; there is
        // nothing useful to draft against until the page's citations change.
        blocksComposer: true,
        detail: evidence.ok ? (
          <div className="reader-source-picker" aria-label="固定原始资料范围">
            <p>已锁定 {sources.length} 份原始资料，只会引用它们的当前版本。</p>
            {sources.map((source) => (
              <span key={source.id} className="note-evidence-source">
                <FileText size={14} aria-hidden="true" />
                <span title={source.title}>{source.title}</span>
                <small>版本 {source.versionId.slice(0, 8)}</small>
              </span>
            ))}
          </div>
        ) : undefined,
      }}
      conversation={{ current: conversation ?? undefined }}
      messages={messages}
      evidence={{
        citationIssue: (citation) =>
          !sources.some(
            (source) => source.id === citation.sourceId && source.versionId === citation.versionId,
          )
            ? "这条引用不属于本页锁定的原始资料范围，不能打开。"
            : citationProblem(citation, data.sources),
        noteEvidenceIssue: () => "本页问答不会使用个人笔记作为依据。",
        onOpenCitation: (citation) => onOpenSource(citation.sourceId, citation.versionId, citation),
      }}
      composer={{
        readOnly: false,
        disabledMessage: data.aiEnabled ? undefined : "资料问答已关闭，请先在设置中开启。",
        onSubmit: () => void send(),
      }}
      onClose={onClose}
    />
  );
}
