"use client";
import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  GitBranch,
  History,
  MoreHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { KnowledgePageOriginalEvidence } from "@/lib/knowledge-page-evidence";
import { acceptKnowledgePage } from "@/lib/organization-review";
import type { Citation, Note, WorkspaceData } from "@/lib/types";
import { citationProblem } from "../../reader-utils";
import { useMenuDismissal } from "../hooks/use-menu-dismissal";
import { NoteEditor } from "../lazy-panels";
import { date } from "../shared";
import type { NotePanel, NoteSearchTarget, WorkspaceStore } from "../types";
import "./note-page.css";

const panelTitles: Record<NonNullable<NotePanel>, string> = {
  relations: "知识关系",
  update: "更新建议",
  ask: "基于原始依据提问",
};

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
  notePanel: NotePanel;
  /** The panel body the shell has already built for `notePanel`. */
  panel: ReactNode;
  openNotePanel: (panel: NotePanel) => void;
  closeNote: (note: Note) => void;
  patchNote: (id: string, patch: Partial<Note>, record?: boolean) => void;
  reviewOrganization: (
    change: (workspace: WorkspaceData) => WorkspaceData,
    message: string,
  ) => boolean;
  setModal: (modal: "history") => void;
  openSource: (sourceId: string, versionId?: string, citation?: Citation) => void;
};

/** The three AI reviews a knowledge page can open, behind one toolbar control. */
function NoteAiMenu({
  active,
  evidenceReason,
  canAskEvidence,
  onOpen,
}: {
  active: NotePanel;
  evidenceReason: string | undefined;
  canAskEvidence: boolean;
  onOpen: (panel: NotePanel) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismissal(open, container, close);
  const choose = (panel: NotePanel) => {
    close();
    onOpen(panel);
  };
  return (
    <div className="library-menu note-ai-menu" ref={container}>
      <button
        type="button"
        className={`btn library-menu-trigger${active ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="知识页 AI"
        onClick={() => setOpen((current) => !current)}
      >
        <Sparkles size={15} aria-hidden="true" />
        AI
      </button>
      {open && (
        <div className="library-menu-popover library-menu-list" role="group" aria-label="知识页 AI">
          <button
            type="button"
            className="library-menu-item"
            aria-pressed={active === "relations"}
            onClick={() => choose("relations")}
          >
            <GitBranch size={15} aria-hidden="true" />
            知识关系
          </button>
          <button
            type="button"
            className="library-menu-item"
            aria-pressed={active === "update"}
            onClick={() => choose("update")}
          >
            <Sparkles size={15} aria-hidden="true" />
            更新建议
          </button>
          <button
            type="button"
            className="library-menu-item"
            aria-pressed={active === "ask"}
            disabled={!canAskEvidence}
            title={canAskEvidence ? "只使用本页引用的原始资料提问" : evidenceReason}
            onClick={() => choose("ask")}
          >
            <Sparkles size={15} aria-hidden="true" />
            基于原始依据提问
          </button>
        </div>
      )}
    </div>
  );
}

/** Version history and deletion: infrequent next to reading and reviewing. */
function NoteMoreMenu({
  onOpenHistory,
  onDelete,
}: {
  onOpenHistory: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismissal(open, container, close);
  return (
    <div className="library-menu note-more-menu" ref={container}>
      <button
        type="button"
        className="icon-btn library-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多笔记操作"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div
          className="library-menu-popover library-menu-list"
          role="group"
          aria-label="更多笔记操作"
        >
          <button
            type="button"
            className="library-menu-item"
            onClick={() => {
              close();
              onOpenHistory();
            }}
          >
            <History size={15} aria-hidden="true" />
            历史版本
          </button>
          <button
            type="button"
            className="library-menu-item"
            aria-label="删除笔记"
            onClick={() => {
              close();
              onDelete();
            }}
          >
            <Trash2 size={15} aria-hidden="true" />
            移入回收站
          </button>
        </div>
      )}
    </div>
  );
}

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
  notePanel,
  panel,
  openNotePanel,
  closeNote,
  patchNote,
  reviewOrganization,
  setModal,
  openSource,
}: NotePageProps) {
  const knowledge = currentNote.kind === "knowledge";
  // A page must be accepted before its citations form a stable evidence range.
  const canAskEvidence = knowledge && currentNote.status === "accepted" && !!knowledgeEvidence?.ok;
  return (
    <div className="note-page">
      <div className="content-toolbar">
        <button className="btn" onClick={() => closeNote(currentNote)}>
          <ArrowLeft size={15} />
          返回
        </button>
        <span className={`badge ${currentNote.status === "draft" ? "badge-warning" : ""}`}>
          {currentNote.status === "draft" ? "待审核草稿" : knowledge ? "已接受" : "个人笔记"}
        </span>
        <div className="grow" />
        {knowledge && (
          <NoteAiMenu
            active={notePanel}
            canAskEvidence={canAskEvidence}
            evidenceReason={
              currentNote.status === "accepted"
                ? knowledgeEvidence?.ok
                  ? undefined
                  : knowledgeEvidence?.message
                : "请先接受知识页，再基于其原始依据提问。"
            }
            onOpen={openNotePanel}
          />
        )}
        {knowledge && currentNote.status === "draft" && (
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
        <NoteMoreMenu
          onOpenHistory={() => setModal("history")}
          onDelete={() => {
            patchNote(currentNote.id, { deletedAt: new Date().toISOString() }, false);
            closeNote(currentNote);
          }}
        />
      </div>
      <div className="note-page-body">
        <div className="note-page-main">
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
                {knowledge ? "知识页" : "笔记"} · {date(currentNote.createdAt)}
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
            {knowledge &&
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
        {notePanel && (
          <aside
            className="note-side-panel"
            data-note-panel={notePanel}
            aria-label={panelTitles[notePanel]}
          >
            {notePanel !== "ask" && (
              <div className="note-panel-header">
                <strong>{panelTitles[notePanel]}</strong>
                <div className="grow" />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`收起${panelTitles[notePanel]}面板`}
                  onClick={() => openNotePanel(null)}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            <div className="note-panel-body">{panel}</div>
          </aside>
        )}
      </div>
    </div>
  );
}
