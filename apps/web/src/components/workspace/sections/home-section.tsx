"use client";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  CalendarClock,
  ChevronRight,
  Plus,
  Sparkles,
  StickyNote,
  Target,
  Upload,
} from "lucide-react";
import { getLearningOverview } from "@/lib/cloud";
import { citationSchema } from "@/lib/citation-schema";
import { isCrossLibraryConversation } from "@/lib/cross-library-ask";
import { buildLearningPath } from "@/lib/learning-path";
import {
  recentUnresolvedConversations,
  type PrimaryLearningContinuation,
} from "@/lib/learning-continue";
import { hasLearningOverviewData, type LearningOverview } from "@/lib/learning/overview";
import { resolveSavedCitation } from "@/lib/retrieval";
import { createDemoWorkspace } from "@/lib/seed";
import type { Citation, Conversation, Note, Source, Space, WorkspaceData } from "@/lib/types";
import type { WorkspaceExportScope } from "@/lib/export-scope";
import LearningContinuationCard from "../../learning-continuation-card";
import { SourceIcon, date } from "../shared";
import type { WorkspaceStore, WorkspaceUser } from "../types";
import SpaceSettingsCard from "./space-settings-card";

export type HomeSectionProps = {
  data: WorkspaceData;
  activeSpace: Space | undefined;
  user: WorkspaceUser;
  busy: boolean;
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
  openSource: (id: string, versionId?: string, citation?: Citation) => void;
  openNote: (id: string) => void;
  openConversation: (conversation: Conversation) => void;
  newNote: (kind: "note") => void;
  openExport: (scope: WorkspaceExportScope) => void;
  setSpaceToDeleteId: (spaceId: string) => void;
  setModal: (modal: "delete-space") => void;
  startReview: () => void;
  openTargetedPractice: (target: { focus: string; itemIds: string[]; spaceId: string }) => void;
};

export default function HomeSection({
  data,
  activeSpace,
  user,
  busy,
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
  openExport,
  setSpaceToDeleteId,
  setModal,
  startReview,
  openTargetedPractice,
}: HomeSectionProps) {
  const [learningOverviewState, setLearningOverviewState] = useState<{
    key: string;
    overview: LearningOverview | null;
    error: string;
  }>({ key: "", overview: null, error: "" });
  const learningPath = activeSpace
    ? buildLearningPath(data.notes, data.conceptRelations ?? [], activeSpace.id)
    : null;
  const learningSpaceId = activeSpace?.id ?? "all";
  const recentQuestions = recentUnresolvedConversations(data, learningSpaceId, 3);
  const learningOverviewKey = `${process.env.NEXT_PUBLIC_CONUO_FEATURE_LEARNING === "on" ? "on" : "off"}:${user?.id ?? ""}:${learningSpaceId}`;
  const learningOverview =
    learningOverviewState.key === learningOverviewKey ? learningOverviewState.overview : null;
  const learningOverviewError =
    learningOverviewState.key === learningOverviewKey ? learningOverviewState.error : "";
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_CONUO_FEATURE_LEARNING !== "on" || !user?.id) return;
    const controller = new AbortController();
    void getLearningOverview(learningSpaceId, user.id, controller.signal)
      .then((overview) =>
        setLearningOverviewState({ key: learningOverviewKey, overview, error: "" }),
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLearningOverviewState({
            key: learningOverviewKey,
            overview: null,
            error: error instanceof Error ? error.message : "学习概览暂时无法读取。",
          });
      });
    return () => controller.abort();
  }, [learningOverviewKey, learningSpaceId, user?.id]);
  const showTodayLearning =
    learningOverview !== null &&
    (hasLearningOverviewData(learningOverview) || recentQuestions.length > 0);

  function openWeakSource(concept: LearningOverview["weakConcepts"][number]) {
    const citation = concept.citations
      .map((value) => citationSchema.safeParse(value))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data)
      .find((value) => resolveSavedCitation(data, value));
    if (!citation) {
      setToast("相关原文已删除或换版，暂时无法回看。");
      return;
    }
    openSource(citation.sourceId, citation.versionId, citation);
  }
  return (
    <div className="home-workspace">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{activeSpace ? "空间概览" : "学习概览"}</p>
          <h1>{activeSpace?.name || "让知识，慢慢成为你的。"}</h1>
          <p>{activeSpace?.goal || "收集值得读的资料，把问题留给思考，把理解留在这里。"}</p>
        </div>
        <button className="btn btn-primary" onClick={openImport}>
          <Plus size={16} />
          导入资料
        </button>
      </div>
      <div className="home-learning-row">
        <section className="home-learning-continue" aria-labelledby="home-continue-heading">
          <div className="section-heading">
            <h2 id="home-continue-heading">继续学习</h2>
            <button className="text-button" onClick={() => navigate("library")}>
              全部资料
              <ChevronRight size={14} />
            </button>
          </div>
          {primaryContinuation ? (
            <div
              className={`home-reading-grid${secondaryContinuedSources.length ? " has-recent" : ""}`}
            >
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
                      <div className="continue-card-copy">
                        <h3>{s.title}</h3>
                        <span>
                          {s.pageCount
                            ? `第 ${s.readPage || 1} / ${s.pageCount} 页`
                            : s.readOffset
                              ? "上次读到正文"
                              : "已保存阅读位置"}
                        </span>
                      </div>
                      <ArrowUpRight size={16} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
            </div>
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
        </section>
        {showTodayLearning && learningOverview && (
          <section className="home-today-learning" aria-labelledby="home-today-learning-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">今天安排</p>
                <h2 id="home-today-learning-heading">今日学习</h2>
              </div>
              <CalendarClock size={20} aria-hidden="true" />
            </div>
            <div className="home-today-learning-due">
              <div>
                <strong>今日到期 {learningOverview.dueCount} 道</strong>
                <span>新题 {learningOverview.newCount} 道</span>
              </div>
              <button
                className="btn btn-primary"
                type="button"
                disabled={learningOverview.dueCount === 0}
                onClick={startReview}
              >
                开始复习
              </button>
            </div>
            {recentQuestions.length > 0 && (
              <div className="home-today-learning-block">
                <h3>最近未解决的问题</h3>
                <div className="home-today-question-list">
                  {recentQuestions.map((conversation) => (
                    <button
                      key={conversation.id}
                      type="button"
                      onClick={() => openConversation(conversation)}
                    >
                      <Sparkles size={15} aria-hidden="true" />
                      <span>{conversation.title}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {learningOverview.weakConcepts.length > 0 && (
              <div className="home-today-learning-block">
                <h3>最近答错较多</h3>
                <div className="home-weak-concept-list">
                  {learningOverview.weakConcepts.map((concept) => (
                    <div className="home-weak-concept" key={concept.conceptKey}>
                      <div>
                        <Target size={15} aria-hidden="true" />
                        <strong>{concept.conceptKey}</strong>
                      </div>
                      <span>最近五次中忘了 {concept.forgottenCount} 次</span>
                      <div className="home-weak-concept-actions">
                        <button type="button" onClick={() => openWeakSource(concept)}>
                          回看原文
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            openTargetedPractice({
                              focus: concept.conceptKey,
                              itemIds: concept.itemIds,
                              spaceId: concept.spaceId,
                            })
                          }
                        >
                          针对性练习
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {learningOverviewError && (
              <p className="muted" role="status">
                {learningOverviewError}
              </p>
            )}
          </section>
        )}
      </div>
      {activeSpace && learningPath?.hasPrerequisites && (
        <section className="home-learning-path" aria-labelledby="home-learning-path-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">按前置关系排列</p>
              <h2 id="home-learning-path-heading">学习路径</h2>
            </div>
            {learningPath.hasCycle && (
              <span className="home-learning-path-warning" role="status">
                存在循环依赖，已按创建时间断开
              </span>
            )}
          </div>
          <ol className="home-learning-path-list">
            {learningPath.items.map((item, index) => (
              <li key={item.note.id}>
                <span className="home-learning-path-index">{index + 1}</span>
                <button type="button" onClick={() => openNote(item.note.id)}>
                  <strong>{item.note.title || "未命名知识页"}</strong>
                  {item.prerequisites.length > 0 && (
                    <small>
                      先学：
                      {item.prerequisites.map((prerequisite) => prerequisite.title).join("、")}
                    </small>
                  )}
                </button>
                {item.cycle && <span className="home-learning-path-cycle">循环</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className="home-columns">
        <section
          className="home-panel home-panel-questions"
          aria-labelledby="home-questions-heading"
        >
          <div className="section-heading pending-question-heading">
            <h2 id="home-questions-heading">
              <Sparkles size={16} aria-hidden="true" />
              待解决问题
            </h2>
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
                  ? data.sources.find(
                      (item) => item.id === conversation.sourceId && !item.deletedAt,
                    )
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
        </section>
        <section className="home-panel home-panel-notes" aria-labelledby="home-notes-heading">
          <div className="section-heading">
            <h2 id="home-notes-heading">
              <StickyNote size={16} aria-hidden="true" />
              最近的笔记
            </h2>
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
                    <p>
                      {n.kind === "knowledge" ? "知识页" : "笔记"} · {date(n.updatedAt)}更新
                    </p>
                  </div>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-small">读到有启发的地方，就把自己的理解写下来。</div>
          )}
        </section>
      </div>
      {activeSpace && (
        <SpaceSettingsCard
          space={activeSpace}
          user={user}
          busy={busy}
          update={update}
          setToast={setToast}
          openExport={openExport}
          setSpaceToDeleteId={setSpaceToDeleteId}
          setModal={setModal}
        />
      )}
    </div>
  );
}
