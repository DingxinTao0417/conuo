"use client";
import { ArrowLeft, Check, GitBranch, History, Sparkles, Trash2 } from "lucide-react";
import type { KnowledgePageOriginalEvidence } from "@/lib/knowledge-page-evidence";
import { acceptKnowledgePage } from "@/lib/organization-review";
import type { Citation, Note, WorkspaceData } from "@/lib/types";
import { citationProblem } from "../../reader-utils";
import { NoteEditor } from "../lazy-panels";
import { date } from "../shared";
import type { NoteSearchTarget, WorkspaceStore } from "../types";

export type NotePageProps = {
  data: WorkspaceData;
  currentNote: Note;
  status: WorkspaceStore["status"];
  cloudReadOnly: boolean;
  saveLabel: string;
  editorKey: number;
  noteSearchTarget: NoteSearchTarget | undefined;
  knowledgeEvidence: KnowledgePageOriginalEvidence | undefined;
  acceptanceReason: string;
  closeNote: (note: Note) => void;
  patchNote: (id: string, patch: Partial<Note>, record?: boolean) => void;
  reviewOrganization: (
    change: (workspace: WorkspaceData) => WorkspaceData,
    message: string,
  ) => boolean;
  openConceptRelations: (noteId: string) => void;
  openKnowledgeUpdate: (noteId: string) => void;
  setKnowledgeEvidenceAskOpen: (open: boolean) => void;
  setModal: (modal: "history") => void;
  openSource: (sourceId: string, versionId?: string, citation?: Citation) => void;
};

export default function NotePage({
  data,
  currentNote,
  status,
  cloudReadOnly,
  saveLabel,
  editorKey,
  noteSearchTarget,
  knowledgeEvidence,
  acceptanceReason,
  closeNote,
  patchNote,
  reviewOrganization,
  openConceptRelations,
  openKnowledgeUpdate,
  setKnowledgeEvidenceAskOpen,
  setModal,
  openSource,
}: NotePageProps) {
  return (
    <div className="note-page">
      <div className="content-toolbar">
        <button className="btn" onClick={() => closeNote(currentNote)}>
          <ArrowLeft size={15} />
          返回
        </button>
        <span className={`badge ${currentNote.status === "draft" ? "badge-warning" : ""}`}>
          {currentNote.status === "draft"
            ? "待审核草稿"
            : currentNote.kind === "knowledge"
              ? "已接受"
              : "个人笔记"}
        </span>
        <div className="grow" />
        {currentNote.kind === "knowledge" && (
          <button className="btn" onClick={() => openConceptRelations(currentNote.id)}>
            <GitBranch size={15} />
            知识关系
          </button>
        )}
        {currentNote.kind === "knowledge" && (
          <button className="btn" onClick={() => openKnowledgeUpdate(currentNote.id)}>
            <Sparkles size={15} />
            更新建议
          </button>
        )}
        {currentNote.kind === "knowledge" && currentNote.status === "accepted" && (
          <button
            className="btn"
            disabled={!knowledgeEvidence?.ok}
            title={
              knowledgeEvidence?.ok ? "只使用本页引用的原始资料提问" : knowledgeEvidence?.message
            }
            onClick={() => setKnowledgeEvidenceAskOpen(true)}
          >
            <Sparkles size={15} />
            基于原始依据提问
          </button>
        )}
        <button className="btn" onClick={() => setModal("history")}>
          <History size={15} />
          历史版本
        </button>
        {currentNote.kind === "knowledge" && currentNote.status === "draft" && (
          <button
            className="btn btn-primary"
            disabled={!!acceptanceReason}
            onClick={() => {
              reviewOrganization(
                (workspace) => acceptKnowledgePage(workspace, currentNote.id),
                "知识页已接受。当前问答仍只参考导入的原始资料。",
              );
            }}
          >
            <Check size={15} />
            接受知识页
          </button>
        )}
        <button
          className="icon-btn"
          aria-label="删除笔记"
          onClick={() => {
            patchNote(currentNote.id, { deletedAt: new Date().toISOString() }, false);
            closeNote(currentNote);
          }}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <article className="note-paper">
        <input
          className="note-title"
          aria-label="笔记标题"
          placeholder="未命名笔记"
          value={currentNote.title}
          onChange={(e) => patchNote(currentNote.id, { title: e.target.value })}
        />
        <p className="note-meta">
          <span>
            {currentNote.kind === "knowledge" ? "知识页" : "笔记"} · {date(currentNote.createdAt)}
            {currentNote.aiGenerated && " · 包含 AI 生成内容，可编辑与核对"}
            {currentNote.status === "draft" && " · 草稿不会进入检索"}
          </span>
          <span
            className={`note-save-status save-${cloudReadOnly ? "readonly" : status}`}
            role="status"
            aria-live="polite"
          >
            自动保存：{saveLabel}
          </span>
        </p>
        {acceptanceReason && (
          <p className="notice" role="status">
            {acceptanceReason}
          </p>
        )}
        {currentNote.kind === "knowledge" &&
          currentNote.status === "accepted" &&
          knowledgeEvidence &&
          !knowledgeEvidence.ok && (
            <p className="notice notice-warning" role="status">
              {knowledgeEvidence.message}
            </p>
          )}
        <NoteEditor
          key={`${currentNote.id}-${editorKey}`}
          content={currentNote.content}
          searchText={
            noteSearchTarget?.noteId === currentNote.id &&
            noteSearchTarget.revision === (currentNote.contentRevision ?? 0) &&
            noteSearchTarget.updatedAt === currentNote.updatedAt
              ? noteSearchTarget.text
              : undefined
          }
          onChange={(content) => patchNote(currentNote.id, { content })}
        />
        {currentNote.citations.length > 0 && (
          <div className="note-sources">
            <h3>原文依据</h3>
            {currentNote.citations.map((c, i) => {
              const problem = citationProblem(c, data.sources);
              const available = !problem;
              const historical = data.sources.some(
                (s) => s.id === c.sourceId && s.versionId !== c.versionId,
              );
              return (
                <button
                  key={`${c.chunkId}-${i}`}
                  className="citation-card"
                  disabled={!available}
                  onClick={() => {
                    openSource(c.sourceId, c.versionId, c);
                  }}
                >
                  <span>
                    {i + 1}. {c.title} · {c.page ? `第 ${c.page} 页` : c.section}
                  </span>
                  <p>{c.quote}</p>
                  {!available && <small>{problem}</small>}
                  {available && historical && <small>引用历史版本 · 打开当时的原文</small>}
                </button>
              );
            })}
          </div>
        )}
      </article>
    </div>
  );
}
