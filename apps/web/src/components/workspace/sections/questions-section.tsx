"use client";
import type { QuestionHistoryFilter } from "@/lib/question-history";
import type { Conversation, WorkspaceData } from "@/lib/types";
import QuestionHistoryList from "../../question-history-list";
import type { WorkspaceStore } from "../types";

export type QuestionsSectionProps = {
  data: WorkspaceData;
  spaceId: string;
  questionHistoryFilter: QuestionHistoryFilter;
  conversationRouteIssue: string;
  update: WorkspaceStore["update"];
  navigate: (section: "questions" | "library") => void;
  changeQuestionHistoryFilter: (next: QuestionHistoryFilter) => void;
  openConversation: (conversation: Conversation) => void;
  openSource: (id: string) => void;
};

export default function QuestionsSection({
  data,
  spaceId,
  questionHistoryFilter,
  conversationRouteIssue,
  update,
  navigate,
  changeQuestionHistoryFilter,
  openConversation,
  openSource,
}: QuestionsSectionProps) {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">带着问题，继续学习</p>
          <h1>我的问答</h1>
          <p>每次讨论都保留资料范围与原文依据。</p>
        </div>
      </div>
      {conversationRouteIssue && (
        <div className="notice notice-warning" role="status">
          <span>{conversationRouteIssue}</span>
          <button className="text-button" onClick={() => navigate("questions")}>
            返回我的问答
          </button>
        </div>
      )}
      <QuestionHistoryList
        data={data}
        spaceId={spaceId}
        filter={questionHistoryFilter}
        onFilterChange={changeQuestionHistoryFilter}
        onContinue={openConversation}
        onOpenOriginal={(source) => openSource(source.id)}
        onToggleResolved={(conversation) =>
          update((workspace) => ({
            ...workspace,
            conversations: workspace.conversations.map((item) =>
              item.id === conversation.id ? { ...item, resolved: !item.resolved } : item,
            ),
          }))
        }
        onOpenLibrary={() => navigate("library")}
      />
    </>
  );
}
