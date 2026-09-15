"use client";
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  Plus,
  Sparkles,
  StickyNote,
  Upload,
} from "lucide-react";
import { isCrossLibraryConversation } from "@/lib/cross-library-ask";
import type { PrimaryLearningContinuation } from "@/lib/learning-continue";
import { createDemoWorkspace } from "@/lib/seed";
import type { Conversation, Note, Source, Space, WorkspaceData } from "@/lib/types";
import LearningContinuationCard from "../../learning-continuation-card";
import { SourceIcon, date, plain } from "../shared";
import type { WorkspaceStore } from "../types";

export type HomeSectionProps = {
  data: WorkspaceData;
  activeSpace: Space | undefined;
  visibleSources: Source[];
  scopedNotes: Note[];
  primaryContinuation: PrimaryLearningContinuation | null;
  secondaryContinuedSources: Source[];
  pendingQuestions: Conversation[];
  update: WorkspaceStore["update"];
  setToast: (message: string) => void;
  navigate: (section: "library" | "questions") => void;
  openImport: () => void;
  openSpaceCreation: (intent?: "browse" | "import") => void;
  openSource: (id: string) => void;
  openNote: (id: string) => void;
  openConversation: (conversation: Conversation) => void;
  newNote: (kind: "note") => void;
};

export default function HomeSection({
  data,
  activeSpace,
  visibleSources,
  scopedNotes,
  primaryContinuation,
  secondaryContinuedSources,
  pendingQuestions,
  update,
  setToast,
  navigate,
  openImport,
  openSpaceCreation,
  openSource,
  openNote,
  openConversation,
  newNote,
}: HomeSectionProps) {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">你的学习，从这里继续</p>
          <h1>{activeSpace?.name || "让知识，慢慢成为你的。"}</h1>
          <p>{activeSpace?.goal || "收集值得读的资料，把问题留给思考，把理解留在这里。"}</p>
        </div>
        <button className="btn btn-primary" onClick={openImport}>
          <Plus size={16} />
          导入资料
        </button>
      </div>
      <div className="section-heading">
        <h2>继续学习</h2>
        <button className="text-button" onClick={() => navigate("library")}>
          全部资料
          <ChevronRight size={14} />
        </button>
      </div>
      {primaryContinuation ? (
        <>
          <LearningContinuationCard
            continuation={primaryContinuation}
            icon={<SourceIcon source={primaryContinuation.source} />}
            onContinue={() =>
              primaryContinuation.conversation
                ? openConversation(primaryContinuation.conversation)
                : openSource(primaryContinuation.source.id)
            }
          />
          {secondaryContinuedSources.length > 0 && (
            <div className="continue-grid" aria-label="其他最近阅读">
              {secondaryContinuedSources.map((s) => (
                <button key={s.id} className="continue-card" onClick={() => openSource(s.id)}>
                  <SourceIcon source={s} />
                  <h3>{s.title}</h3>
                  <p>{s.text ? plain(s.text).slice(0, 95) : "打开资料，开始阅读"}</p>
                  <div>
                    <span>
                      {s.pageCount
                        ? `第 ${s.readPage || 1} / ${s.pageCount} 页`
                        : s.readOffset
                          ? "上次读到正文"
                          : "已保存阅读位置"}
                    </span>
                    <ArrowUpRight size={16} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      ) : visibleSources.length ? (
        <div className="empty-small continue-empty">
          还没有阅读记录。打开一份资料后，这里会按你最后停留的位置继续。
          <button className="text-button" onClick={() => navigate("library")}>
            打开资料库
            <ChevronRight size={14} />
          </button>
        </div>
      ) : (
        <div className="welcome-card">
          <div className="welcome-icon">
            <BookOpen size={31} />
          </div>
          <h2>每一份资料，都是一个新的开始</h2>
          <p>
            导入一本书、一篇文章或课堂笔记。
            <br />
            在原文旁找到依据，记下自己的理解。
          </p>
          <div className="button-row">
            <button className="btn btn-primary" onClick={() => openSpaceCreation("import")}>
              <Upload size={16} />
              添加第一份资料
            </button>
            <button
              className="btn"
              onClick={() => {
                const demo = createDemoWorkspace();
                update((d) => ({
                  ...d,
                  spaces: [...d.spaces, ...demo.spaces],
                  sources: [...d.sources, ...demo.sources],
                  notes: [...d.notes, ...demo.notes],
                }));
                setToast("已加入标有「示例」的资料，可随时移入回收站。");
              }}
            >
              先看看示例
            </button>
          </div>
          <small>支持 PDF、DOCX、Markdown、TXT 和网页链接</small>
        </div>
      )}
      <div className="section-heading pending-question-heading">
        <h2>待解决问题</h2>
        <button className="text-button" onClick={() => navigate("questions")}>
          全部问答
          <ChevronRight size={14} />
        </button>
      </div>
      {pendingQuestions.length ? (
        <div className="pending-question-list">
          {pendingQuestions.map((conversation) => {
            const crossLibrary = isCrossLibraryConversation(conversation);
            const source = conversation.sourceId
              ? data.sources.find((item) => item.id === conversation.sourceId && !item.deletedAt)
              : undefined;
            return (
              <button
                className="pending-question-card"
                key={conversation.id}
                onClick={() => openConversation(conversation)}
              >
                <Sparkles size={17} />
                <div>
                  <b>{conversation.title}</b>
                  <p>
                    {crossLibrary
                      ? `跨库 · ${conversation.sourceIds.length} 份固定资料`
                      : source
                        ? source.title
                        : "原资料不可用或未绑定资料"}{" "}
                    · {date(conversation.updatedAt)}
                  </p>
                </div>
                <ChevronRight size={15} />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty-small continue-empty">
          暂时没有待解决的问题。阅读时提出一个问题，它会保留在这里。
        </div>
      )}
      <div className="section-heading">
        <h2>最近的笔记</h2>
        <button className="text-button" onClick={() => newNote("note")}>
          <Plus size={14} />
          写笔记
        </button>
      </div>
      {scopedNotes.length ? (
        <div className="recent-note-grid">
          {scopedNotes.slice(0, 3).map((n) => (
            <button className="space-card" key={n.id} onClick={() => openNote(n.id)}>
              <StickyNote size={20} />
              <div>
                <b>{n.title}</b>
                <p>{plain(n.content).slice(0, 55) || "写下你的第一个想法"}</p>
              </div>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-small">读到有启发的地方，就把自己的理解写下来。</div>
      )}
    </>
  );
}
