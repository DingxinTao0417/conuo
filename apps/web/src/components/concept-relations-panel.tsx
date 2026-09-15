"use client";

import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowLeftRight,
  BookOpen,
  Check,
  FileText,
  Info,
  Link2,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { Citation, Note, Source, WorkspaceData } from "@/lib/types";
import { sourceCoverageLabel } from "@/lib/source-coverage";
import type {
  ConceptRelation,
  RelationDraft,
  RelationInput,
  RelationType,
} from "@/lib/concept-relation-types";
import type { OrganizationJob, OrganizationRequest } from "@/lib/organization-types";
import type { KnowledgeNoteSnapshot } from "@/lib/knowledge-update-types";
import {
  relationAvailabilityReason,
  relationLabels,
  relationReviewReason,
} from "@/lib/concept-relations";
import { relationDraftSchema } from "@/lib/concept-relation-schema";
import { knowledgeNoteKey, snapshotKnowledgeNote } from "@/lib/knowledge-update";
import { organizationUnavailableReason } from "@/lib/organization";
import { resolveCitation } from "@/lib/retrieval";
import "./organization.css";
import "./concept-relations.css";

export interface ConceptRelationsPanelProps {
  data: WorkspaceData;
  noteId: string;
  status: { ready: boolean; running: boolean; message: string };
  onGenerate: (input: {
    kind: "relations";
    spaceId: string;
    sourceIds: string[];
    topic?: string;
    targetNoteId: string;
    compareNoteId: string;
  }) => Promise<void>;
  onAccept: (jobId: string, proposalId: string, patch?: RelationDraft) => void | Promise<void>;
  onIgnore: (jobId: string, proposalId: string) => void | Promise<void>;
  onSave: (
    input: RelationInput,
    existing?: { id: string; revision: number },
  ) => void | Promise<void>;
  onDelete: (id: string, revision: number) => void | Promise<void>;
  onRestore: (id: string, revision: number) => void | Promise<void>;
  onRetry: (jobId: string) => Promise<void>;
  onCheck: (jobId: string) => Promise<void>;
  onStop: (jobId: string) => void;
  onDismiss: (jobId: string) => void | Promise<void>;
  onRefreshStatus?: () => void | Promise<void>;
  onOpenNote: (id: string) => void;
  onOpenCitation: (citation: Citation) => void;
  onBack: () => void;
}

type NoteBasis = Note | KnowledgeNoteSnapshot;
type Run = (action: () => void | Promise<void>) => void;
const relationTypes: RelationType[] = ["synonym", "related", "prerequisite", "conflict"];
const jobLabels: Record<OrganizationJob["status"], string> = {
  queued: "等待分析",
  running: "正在分析",
  ready: "待审核",
  failed: "未完成",
  cancelled: "已停止",
  dismissed: "已收起",
};
const emptyDraft: RelationDraft = {
  type: "related",
  fromClaim: "",
  toClaim: "",
  fromCondition: "",
  toCondition: "",
  explanation: "",
  fromCitations: [],
  toCitations: [],
};
const citationKey = (citation: Citation) =>
  JSON.stringify([
    citation.sourceId,
    citation.versionId,
    citation.chunkId,
    citation.title,
    citation.quote,
    citation.page ?? null,
    citation.section,
  ]);
const uniqueCitations = (citations: Citation[]) => [
  ...new Map(citations.map((citation) => [citationKey(citation), citation])).values(),
];
const cleanText = (text: string) => text.replace(/\s+/g, " ").trim();
const formatDate = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const currentNote = (data: WorkspaceData, id: string) =>
  data.notes.find((note) => note.id === id && note.kind === "knowledge" && !note.deletedAt);

function citationCurrent(data: WorkspaceData, citation: Citation, spaceId: string) {
  const found = resolveCitation(data, citation);
  return Boolean(
    found &&
    cleanText(citation.quote) &&
    cleanText(found.source.text).includes(cleanText(citation.quote)) &&
    found.chunk.page === citation.page &&
    found.chunk.section === citation.section &&
    (spaceId === "inbox" ? !found.source.spaceIds.length : found.source.spaceIds.includes(spaceId)),
  );
}
function sourceReason(source: Source | undefined, spaceId: string) {
  if (!source || source.deletedAt) return "资料已删除或无法访问";
  if (spaceId === "inbox" ? source.spaceIds.length !== 0 : !source.spaceIds.includes(spaceId))
    return "已移出当前知识库";
  if (!source.aiAllowed) return "未允许 AI 使用";
  if (source.status === "saved" || source.status === "parsing") return "等待解析完成";
  if (source.status === "failed") return "解析未完成";
  if (source.status === "link-only") return "链接尚无可分析正文";
  if (!source.text.trim() || !source.chunks.length) return "没有可分析正文";
  return "";
}
function draftOf(value: RelationDraft): RelationDraft {
  return {
    type: value.type,
    fromClaim: value.fromClaim,
    toClaim: value.toClaim,
    fromCondition: value.fromCondition,
    toCondition: value.toCondition,
    explanation: value.explanation,
    fromCitations: [...value.fromCitations],
    toCitations: [...value.toCitations],
  };
}
function Basis({
  from,
  to,
  type,
  onOpen,
}: {
  from: NoteBasis;
  to: NoteBasis;
  type: RelationType;
  onOpen?: (id: string) => void;
}) {
  return (
    <div className="relations-basis">
      {onOpen ? (
        <button type="button" onClick={() => onOpen(from.id)}>
          <BookOpen size={13} />
          <span>{from.title || "未命名知识页"}</span>
        </button>
      ) : (
        <span>{from.title || "未命名知识页"}</span>
      )}
      {type === "prerequisite" ? <ArrowRight size={15} /> : <ArrowLeftRight size={15} />}
      {onOpen ? (
        <button type="button" onClick={() => onOpen(to.id)}>
          <BookOpen size={13} />
          <span>{to.title || "未命名知识页"}</span>
        </button>
      ) : (
        <span>{to.title || "未命名知识页"}</span>
      )}
      <small>{type === "prerequisite" ? "起点先于终点" : "双向关系"}</small>
    </div>
  );
}

function Evidence({
  citations,
  onOpen,
  data,
  spaceId,
}: {
  citations: Citation[];
  onOpen: (citation: Citation) => void;
  data: WorkspaceData;
  spaceId: string;
}) {
  if (!citations.length)
    return <p className="relations-missing-evidence">此侧暂未附原文依据 · 待核对</p>;
  return (
    <details className="relations-evidence">
      <summary>原文依据 · {citations.length} 处</summary>
      {citations.map((citation, index) => (
        <div className="relations-quote" key={`${citationKey(citation)}-${index}`}>
          <blockquote>{citation.quote}</blockquote>
          <button
            type="button"
            className="organization-citation"
            onClick={() => onOpen(citation)}
            title={`${citation.title} · ${citation.section}`}
          >
            <span>{index + 1}</span>
            <span>{citation.title}</span>
            {citation.page && <small>p.{citation.page}</small>}
          </button>
          {!citationCurrent(data, citation, spaceId) && (
            <p className="relations-missing-evidence">这处依据已变化或不可访问，请核对。</p>
          )}
        </div>
      ))}
    </details>
  );
}

function RelationBody({
  draft,
  from,
  to,
  data,
  onOpenCitation,
}: {
  draft: RelationDraft;
  from: NoteBasis;
  to: NoteBasis;
  data: WorkspaceData;
  onOpenCitation: (citation: Citation) => void;
}) {
  return (
    <div className="relations-body">
      <p className="relations-explanation">{draft.explanation}</p>
      <div className={`relations-sides${draft.type === "conflict" ? " relations-conflict" : ""}`}>
        {(["from", "to"] as const).map((side, index) => (
          <section className="relations-side" key={side}>
            <h4>
              <span>{index === 0 ? "起点" : "终点"}</span>
              {(index === 0 ? from : to).title || "未命名知识页"}
            </h4>
            <p className="relations-claim">{draft[`${side}Claim`] || "观点待核对"}</p>
            <div className="relations-condition">
              <strong>适用条件</strong>
              <p>{draft[`${side}Condition`] || "尚未记录，需结合原文核对"}</p>
            </div>
            <Evidence
              data={data}
              spaceId={from.spaceId}
              citations={draft[`${side}Citations`]}
              onOpen={onOpenCitation}
            />
          </section>
        ))}
      </div>
    </div>
  );
}

function CitationPicker({
  data,
  spaceId,
  options,
  selected,
  onChange,
  label,
  disabled,
}: {
  data: WorkspaceData;
  spaceId: string;
  options: Citation[];
  selected: Citation[];
  onChange: (citations: Citation[]) => void;
  label: string;
  disabled: boolean;
}) {
  const all = uniqueCitations([...selected, ...options]);
  return (
    <fieldset className="relations-citation-picker" disabled={disabled}>
      <legend>
        {label}
        <small>已选 {selected.length} / 6</small>
      </legend>
      {all.length ? (
        <div>
          {all.map((citation) => {
            const key = citationKey(citation);
            const checked = selected.some((item) => citationKey(item) === key);
            const valid = citationCurrent(data, citation, spaceId);
            return (
              <label key={key} className={checked ? "relations-citation-selected" : ""}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && (!valid || selected.length >= 6)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, citation]
                        : selected.filter((item) => citationKey(item) !== key),
                    )
                  }
                />
                <span>
                  <strong>
                    {citation.title}
                    {citation.page ? ` · 第 ${citation.page} 页` : ""}
                  </strong>
                  <span>{citation.quote}</span>
                  {!valid && <small>依据已失效，保留显示，请移除或重新选择。</small>}
                </span>
              </label>
            );
          })}
        </div>
      ) : (
        <p className="organization-subtle">
          两页目前都没有原文引用。请先为知识页补充可核对的引用。
        </p>
      )}
    </fieldset>
  );
}

function RelationEditor({
  data,
  from,
  to,
  initial = emptyDraft,
  ai,
  blockedReason = "",
  pending,
  allowReverse = false,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  data: WorkspaceData;
  from: NoteBasis;
  to: NoteBasis;
  initial?: RelationDraft;
  ai: boolean;
  blockedReason?: string;
  pending: boolean;
  allowReverse?: boolean;
  onSubmit: (draft: RelationDraft, reversed: boolean) => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  const [draft, setDraft] = useState(() => draftOf(initial));
  const [reversed, setReversed] = useState(false);
  const [basis] = useState(() => ({ from: knowledgeNoteKey(from), to: knowledgeNoteKey(to) }));
  const [options] = useState(() =>
    uniqueCitations([...initial.fromCitations, ...initial.toCitations]),
  );
  const liveFrom = currentNote(data, from.id);
  const liveTo = currentNote(data, to.id);
  const changed =
    !liveFrom ||
    !liveTo ||
    knowledgeNoteKey(liveFrom) !== basis.from ||
    knowledgeNoteKey(liveTo) !== basis.to;
  const shownFrom = reversed ? to : from;
  const shownTo = reversed ? from : to;
  const references = uniqueCitations([
    ...(liveFrom?.citations || []),
    ...(liveTo?.citations || []),
    ...options,
  ]);
  const parsed = relationDraftSchema.safeParse(draft);
  const reason =
    blockedReason ||
    (changed
      ? "两页内容已变化，请关闭表单，核对当前页面后重新编辑。"
      : !draft.fromClaim.trim() || !draft.toClaim.trim() || !draft.explanation.trim()
        ? "请填写两侧观点和关系说明。"
        : !ai && !draft.fromCitations.length && !draft.toCitations.length
          ? "手动关系至少需要一处原文依据。"
          : [...draft.fromCitations, ...draft.toCitations].some(
                (citation) => !citationCurrent(data, citation, from.spaceId),
              )
            ? "所选引用包含已失效的依据，请核对并重新选择。"
            : !parsed.success
              ? parsed.error.issues[0]?.message || "请核对关系内容。"
              : "");
  return (
    <form
      className="relations-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason && !pending) onSubmit(draftOf(draft), reversed);
      }}
    >
      <div className="relations-editor-heading">
        <strong>{ai ? "核对 AI 关系" : "编辑知识关系"}</strong>
        {ai && (
          <span className="relations-ai-badge">
            <Sparkles size={11} />
            AI 来源保留
          </span>
        )}
        <button type="button" className="icon-btn" aria-label="关闭关系编辑" onClick={onCancel}>
          <X size={14} />
        </button>
      </div>
      {ai && !draft.fromCitations.length && !draft.toCitations.length && (
        <p className="relations-missing-evidence relations-editor-warning">
          缺少原文依据，保存后仍需核对。你可以在下方补选引用。
        </p>
      )}
      <label className="relations-field">
        <span>关系类型</span>
        <select
          value={draft.type}
          onChange={(event) =>
            setDraft((value) => ({ ...value, type: event.target.value as RelationType }))
          }
        >
          {relationTypes.map((type) => (
            <option value={type} key={type}>
              {relationLabels[type]}
            </option>
          ))}
        </select>
      </label>
      <Basis from={shownFrom} to={shownTo} type={draft.type} />
      {allowReverse && (
        <button
          type="button"
          className="organization-text-button"
          onClick={() => {
            setReversed((value) => !value);
            setDraft((value) => ({
              ...value,
              fromClaim: value.toClaim,
              toClaim: value.fromClaim,
              fromCondition: value.toCondition,
              toCondition: value.fromCondition,
              fromCitations: value.toCitations,
              toCitations: value.fromCitations,
            }));
          }}
        >
          <ArrowLeftRight size={12} />
          交换起点与终点
        </button>
      )}
      <label className="relations-field">
        <span>关系说明</span>
        <textarea
          value={draft.explanation}
          maxLength={2000}
          rows={3}
          onChange={(event) => setDraft((value) => ({ ...value, explanation: event.target.value }))}
          placeholder="说明两页如何关联，以及依据是什么"
        />
      </label>
      {draft.type === "conflict" && (
        <p className="relations-conflict-hint">
          请分别填写两侧观点与适用条件；原文没交代条件时可写“原文未说明”。双方各需至少一处独立的原文片段，观点相同不能标记为冲突。
        </p>
      )}
      <div className="relations-editor-sides">
        {(["from", "to"] as const).map((side, index) => (
          <section key={side}>
            <h4>
              {index === 0 ? "起点" : "终点"} ·{" "}
              {(index === 0 ? shownFrom : shownTo).title || "未命名知识页"}
            </h4>
            <label className="relations-field">
              <span>观点或概念</span>
              <textarea
                value={draft[`${side}Claim`]}
                maxLength={2000}
                rows={3}
                onChange={(event) =>
                  setDraft((value) => ({ ...value, [`${side}Claim`]: event.target.value }))
                }
                placeholder="用简短文字表述这一侧的观点"
              />
            </label>
            <label className="relations-field">
              <span>适用条件{draft.type !== "conflict" && <small>选填</small>}</span>
              <textarea
                value={draft[`${side}Condition`]}
                maxLength={1000}
                rows={2}
                onChange={(event) =>
                  setDraft((value) => ({ ...value, [`${side}Condition`]: event.target.value }))
                }
                placeholder="例如：讨论范围、成立前提；原文未说明时如实记录"
              />
            </label>
            <CitationPicker
              data={data}
              spaceId={from.spaceId}
              options={references}
              selected={draft[`${side}Citations`]}
              onChange={(citations) =>
                setDraft((value) => ({ ...value, [`${side}Citations`]: citations }))
              }
              label="原文依据"
              disabled={pending}
            />
          </section>
        ))}
      </div>
      <div className="relations-form-actions">
        <p role="status">{reason || "保存会基于当前两页记录关系和原文依据。"}</p>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending || Boolean(reason)}>
          <Check size={13} />
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function SavedRelation({
  relation,
  data,
  pending,
  run,
  onSave,
  onDelete,
  onRestore,
  onOpenNote,
  onOpenCitation,
}: Pick<
  ConceptRelationsPanelProps,
  "data" | "onSave" | "onDelete" | "onRestore" | "onOpenNote" | "onOpenCitation"
> & { relation: ConceptRelation; pending: boolean; run: Run }) {
  const [editing, setEditing] = useState<{
    relation: ConceptRelation;
    from: Note;
    to: Note;
  } | null>(null);
  const from = currentNote(data, relation.from.id);
  const to = currentNote(data, relation.to.id);
  const unavailable = relationAvailabilityReason(data, relation);
  const canEdit = from && to && from.spaceId === to.spaceId && from.spaceId === relation.spaceId;
  return (
    <article
      className={`organization-result-card relations-saved${relation.deletedAt ? " relations-deleted" : ""}`}
    >
      <div className="relations-card-heading">
        <span className={`relations-type relations-type-${relation.type}`}>
          {relationLabels[relation.type]}
        </span>
        {relation.origin === "ai" ? (
          <span className="relations-ai-badge">
            <Sparkles size={11} />
            AI 生成 · 已接受
          </span>
        ) : (
          <span className="relations-manual-badge">手动建立</span>
        )}
        {relation.deletedAt && <span className="organization-badge">已删除</span>}
        <small>{formatDate(relation.updatedAt)}</small>
      </div>
      <Basis
        from={from || relation.from}
        to={to || relation.to}
        type={relation.type}
        onOpen={onOpenNote}
      />
      {unavailable && (
        <div className="organization-warning" role="status">
          <Info size={14} />
          <span>
            {unavailable} {!relation.deletedAt && "请打开两页核对，并在编辑关系中按当前版本保存。"}
          </span>
        </div>
      )}
      {!relation.fromCitations.length && !relation.toCitations.length && (
        <p className="relations-missing-evidence relations-card-missing">缺少原文依据 · 待核对</p>
      )}
      {editing && !relation.deletedAt ? (
        <RelationEditor
          data={data}
          from={editing.from}
          to={editing.to}
          initial={editing.relation}
          ai={editing.relation.origin === "ai"}
          allowReverse
          pending={pending}
          blockedReason={
            relation.revision !== editing.relation.revision
              ? "这条关系已被修改，请关闭后重新核对。"
              : ""
          }
          onCancel={() => setEditing(null)}
          submitLabel="保存关系"
          onSubmit={(draft, reversed) =>
            run(async () => {
              await onSave(
                {
                  ...draft,
                  fromNoteId: reversed ? editing.to.id : editing.from.id,
                  toNoteId: reversed ? editing.from.id : editing.to.id,
                },
                { id: editing.relation.id, revision: editing.relation.revision },
              );
              setEditing(null);
            })
          }
        />
      ) : (
        <RelationBody
          data={data}
          draft={relation}
          from={from || relation.from}
          to={to || relation.to}
          onOpenCitation={onOpenCitation}
        />
      )}
      <div className="relations-card-actions">
        {relation.deletedAt ? (
          <>
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => run(() => onRestore(relation.id, relation.revision))}
            >
              <RotateCcw size={13} />
              恢复关系
            </button>
            <span>恢复后仍保留原始来源与审核状态。</span>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              disabled={pending || !canEdit || Boolean(editing)}
              onClick={() => {
                if (from && to) setEditing({ relation, from, to });
              }}
            >
              <Pencil size={13} />
              编辑关系
            </button>
            <button
              type="button"
              className="organization-text-button"
              disabled={pending}
              onClick={() => run(() => onDelete(relation.id, relation.revision))}
            >
              <Trash2 size={12} />
              删除关系
            </button>
            <span>删除后可在“已删除”中恢复。</span>
          </>
        )}
      </div>
    </article>
  );
}

function RelationSuggestions({
  job,
  data,
  pending,
  run,
  onAccept,
  onIgnore,
  onOpenNote,
  onOpenCitation,
}: Pick<
  ConceptRelationsPanelProps,
  "data" | "onAccept" | "onIgnore" | "onOpenNote" | "onOpenCitation"
> & { job: OrganizationJob; pending: boolean; run: Run }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const result = job.result;
  if (!result || result.kind !== "relations") return null;
  const reason = relationReviewReason(data, job);
  return (
    <>
      {reason && (
        <div className="organization-warning" role="status">
          <Info size={14} />
          <span>{reason} 请核对双页后重新生成。</span>
        </div>
      )}
      {!result.relations.length ? (
        <div className="organization-small-empty">
          <Check size={23} />
          <p>未发现有充分依据的知识关系</p>
          <span>本次没有建立关系，可补充资料后再分析。</span>
        </div>
      ) : (
        <div className="relations-proposals">
          {result.relations.map((proposal) => {
            const saved = job.savedRelations?.find((item) => item.proposalId === proposal.id);
            const ignored = job.ignoredRelations?.includes(proposal.id);
            const savedRelation =
              saved && data.conceptRelations?.find((item) => item.id === saved.relationId);
            const editing = !saved && !ignored && editingId === proposal.id;
            return (
              <section className="relations-proposal" key={proposal.id}>
                <div className="relations-card-heading">
                  <span className={`relations-type relations-type-${proposal.type}`}>
                    {relationLabels[proposal.type]}
                  </span>
                  <span className="relations-ai-badge">
                    <Sparkles size={11} />
                    AI 建议
                  </span>
                  {saved ? (
                    <span className="organization-badge organization-badge-success">
                      {savedRelation?.deletedAt ? "已接受 · 已删除" : "已接受"}
                    </span>
                  ) : ignored ? (
                    <span className="organization-badge">已忽略</span>
                  ) : null}
                </div>
                <Basis
                  from={result.target}
                  to={result.compare}
                  type={proposal.type}
                  onOpen={onOpenNote}
                />
                {editing ? (
                  <RelationEditor
                    data={data}
                    from={result.target}
                    to={result.compare}
                    initial={proposal}
                    ai
                    pending={pending}
                    blockedReason={reason}
                    submitLabel="接受编辑后的关系"
                    onCancel={() => setEditingId(null)}
                    onSubmit={(draft) =>
                      run(async () => {
                        await onAccept(job.id, proposal.id, draft);
                        setEditingId(null);
                      })
                    }
                  />
                ) : (
                  <RelationBody
                    data={data}
                    draft={proposal}
                    from={result.target}
                    to={result.compare}
                    onOpenCitation={onOpenCitation}
                  />
                )}
                {!saved && !ignored && !editing && (
                  <div className="relations-proposal-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={pending || Boolean(reason)}
                      onClick={() => run(() => onAccept(job.id, proposal.id))}
                    >
                      <Check size={13} />
                      接受关系
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={pending || Boolean(reason)}
                      onClick={() => setEditingId(proposal.id)}
                    >
                      <Pencil size={13} />
                      编辑后接受
                    </button>
                    <button
                      type="button"
                      className="organization-text-button"
                      disabled={pending || Boolean(reason)}
                      onClick={() => run(() => onIgnore(job.id, proposal.id))}
                    >
                      忽略此项
                    </button>
                  </div>
                )}
                {saved && (
                  <p className="relations-reviewed-note">
                    此项已处理。后续核对请编辑已保存的关系；原建议不会重复接受。
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}
      <div className="organization-result-footer">
        <Info size={14} />
        <span>{result.coverage}</span>
      </div>
    </>
  );
}

function GenerateRelations({
  data,
  from,
  to,
  status,
  pending,
  run,
  onGenerate,
}: Pick<ConceptRelationsPanelProps, "data" | "status" | "onGenerate"> & {
  from: Note;
  to: Note;
  pending: boolean;
  run: Run;
}) {
  const cited = [
    ...new Set([...from.citations, ...to.citations].map((citation) => citation.sourceId)),
  ];
  const [selected, setSelected] = useState<string[]>(() => cited);
  const [topic, setTopic] = useState("");
  const [search, setSearch] = useState("");
  const ids = [
    ...new Set([
      ...data.sources
        .filter(
          (source) =>
            !source.deletedAt &&
            (from.spaceId === "inbox"
              ? !source.spaceIds.length
              : source.spaceIds.includes(from.spaceId)),
        )
        .map((source) => source.id),
      ...selected,
      ...cited,
    ]),
  ];
  const titleOf = (id: string) =>
    data.sources.find((source) => source.id === id)?.title ||
    [...from.citations, ...to.citations].find((citation) => citation.sourceId === id)?.title ||
    "原引用资料（已不可用）";
  const invalid = selected.filter((id) =>
    sourceReason(
      data.sources.find((source) => source.id === id),
      from.spaceId,
    ),
  );
  const missing = cited.filter((id) => !selected.includes(id));
  const request: OrganizationRequest = {
    requestId: "relations-preview",
    kind: "relations",
    trigger: "manual",
    spaceId: from.spaceId,
    sourceIds: selected,
    sourceVersions: selected.map((sourceId) => ({
      sourceId,
      versionId: data.sources.find((source) => source.id === sourceId)?.versionId || "unavailable",
    })),
    targetNote: {
      id: from.id,
      revision: snapshotKnowledgeNote(from).revision,
      updatedAt: from.updatedAt,
    },
    compareNote: {
      id: to.id,
      revision: snapshotKnowledgeNote(to).revision,
      updatedAt: to.updatedAt,
    },
    ...(topic.trim() ? { topic: topic.trim() } : {}),
  };
  const reason = !data.aiEnabled
    ? "AI 使用已关闭；仍可手动建立和核对关系。"
    : !status.ready
      ? status.message || "云端模型尚未配置，暂时无法生成 AI 建议。"
      : status.running
        ? "已有模型任务正在执行，请等待完成或停止。"
        : !selected.length
          ? "请选择 1–10 份资料作为分析依据。"
          : selected.length > 10
            ? "最多选择 10 份资料，请手动调整选集。"
            : invalid.length
              ? "选集中有不可用资料，请核对下方状态。"
              : missing.length
                ? "请保留两页现有引用涉及的全部资料。"
                : organizationUnavailableReason(data, request);
  const shownIds = ids.filter(
    (id) =>
      selected.includes(id) ||
      titleOf(id).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <div className="relations-generation">
      <div className="organization-compose-heading">
        <h3>AI 关系建议</h3>
        <span>已选 {selected.length} / 10 份</span>
      </div>
      <p className="organization-subtle">
        默认合并两页全部原引用资料；只有你接受的建议才会加入关系列表。
      </p>
      {(invalid.length > 0 || missing.length > 0) && (
        <div className="organization-selection-warning">
          <Info size={14} />
          <div>
            {invalid.length > 0 && (
              <>
                <p>不可用的已选资料仍保留在列表中：</p>
                <ul>
                  {invalid.map((id) => (
                    <li key={id}>
                      {titleOf(id)}：
                      {sourceReason(
                        data.sources.find((source) => source.id === id),
                        from.spaceId,
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {missing.length > 0 && (
              <>
                <p>有 {missing.length} 份原引用资料尚未选中。</p>
                <button
                  type="button"
                  className="organization-text-button"
                  onClick={() => setSelected((values) => [...new Set([...values, ...cited])])}
                >
                  加入两页全部原引用资料
                </button>
              </>
            )}
          </div>
        </div>
      )}
      <div className="organization-source-tools">
        <input
          type="search"
          aria-label="搜索关系分析资料"
          placeholder="搜索同库资料"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span className="organization-subtle">已选资料始终显示</span>
      </div>
      {shownIds.length ? (
        <div className="organization-source-list">
          {shownIds.map((id) => {
            const source = data.sources.find((item) => item.id === id);
            const blocked = sourceReason(source, from.spaceId);
            const checked = selected.includes(id);
            return (
              <label
                key={id}
                className={`organization-source-row${checked ? " organization-source-selected" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={pending || (!checked && (Boolean(blocked) || selected.length >= 10))}
                  onChange={(event) =>
                    setSelected((values) =>
                      event.target.checked
                        ? [...values, id]
                        : values.filter((value) => value !== id),
                    )
                  }
                />
                <FileText size={17} />
                <span className="organization-source-copy">
                  <strong>{titleOf(id)}</strong>
                  <small>
                    {blocked ||
                      (source ? sourceCoverageLabel(source) || "可用于分析" : "可用于分析")}
                    {cited.includes(id) ? " · 原引用资料" : ""}
                  </small>
                </span>
              </label>
            );
          })}
        </div>
      ) : (
        <div className="organization-small-empty">
          <FileText size={22} />
          <p>没有可选资料</p>
          <span>请先导入资料并完成文字解析。</span>
        </div>
      )}
      <label className="organization-topic-input">
        <span>
          本次关注<small>选填</small>
        </span>
        <input
          maxLength={200}
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          placeholder="例如：术语是否同义，两种结论的成立条件有何不同"
        />
      </label>
      <div className="organization-generate-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending || Boolean(reason)}
          onClick={() =>
            run(() =>
              onGenerate({
                kind: "relations",
                spaceId: from.spaceId,
                sourceIds: [...selected],
                ...(topic.trim() ? { topic: topic.trim() } : {}),
                targetNoteId: from.id,
                compareNoteId: to.id,
              }),
            )
          }
        >
          <Sparkles size={14} />
          分析两页关系
        </button>
        <span>{reason || "将对照两页和所选资料，生成有引用依据的关系建议。"}</span>
      </div>
    </div>
  );
}

export function ConceptRelationsPanel({
  data,
  noteId,
  status,
  onGenerate,
  onAccept,
  onIgnore,
  onSave,
  onDelete,
  onRestore,
  onRetry,
  onCheck,
  onStop,
  onDismiss,
  onRefreshStatus,
  onOpenNote,
  onOpenCitation,
  onBack,
}: ConceptRelationsPanelProps) {
  const note = currentNote(data, noteId);
  const [compareId, setCompareId] = useState("");
  const [manual, setManual] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => void | Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成，请稍后再试。");
    } finally {
      setPending(false);
    }
  }
  if (!note)
    return (
      <div className="organization-panel concept-relations-panel">
        <button type="button" className="organization-text-button" onClick={onBack}>
          <ArrowLeft size={14} />
          返回知识页
        </button>
        <div className="organization-empty">
          <span>
            <BookOpen size={22} />
          </span>
          <h3>这份知识页已不可用</h3>
          <p>页面可能已删除或不再属于当前工作区。</p>
        </div>
      </div>
    );
  const others = data.notes.filter(
    (item) =>
      item.id !== noteId &&
      item.kind === "knowledge" &&
      !item.deletedAt &&
      item.spaceId === note.spaceId,
  );
  const compare = currentNote(data, compareId);
  const availableCompare = compare && compare.spaceId === note.spaceId ? compare : undefined;
  const relations = (data.conceptRelations || [])
    .filter((relation) => relation.from.id === noteId || relation.to.id === noteId)
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const visible = relations.filter((relation) => Boolean(relation.deletedAt) === showDeleted);
  const jobs = (data.organizationJobs || [])
    .filter(
      (job) =>
        job.request.kind === "relations" &&
        job.status !== "dismissed" &&
        (job.request.targetNote?.id === noteId || job.request.compareNote?.id === noteId),
    )
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="organization-panel concept-relations-panel">
      <button type="button" className="organization-text-button relations-back" onClick={onBack}>
        <ArrowLeft size={14} />
        返回知识页
      </button>
      <header className="organization-heading">
        <div>
          <span className="organization-eyebrow">
            <Link2 size={13} />
            知识关系
          </span>
          <h2>{note.title || "未命名知识页"}</h2>
          <p>把相关概念连接起来，保留不同观点的条件和依据。</p>
        </div>
      </header>
      <div className="relations-intro">
        <Link2 size={17} />
        <p>
          同义、相关、冲突关系可双向查看；前置关系表示“起点先于终点”。AI
          建议需逐项接受，接受和编辑后仍保留 AI 来源标记。
        </p>
      </div>
      {error && (
        <div className="organization-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭关系操作提示"
            onClick={() => setError("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="organization-review-heading relations-list-heading">
        <div>
          <h3>
            已建立的关系{" "}
            <span className="relations-count">
              {relations.filter((relation) => !relation.deletedAt).length}
            </span>
          </h3>
          <p>从任意一侧知识页，都可以查看并维护这些关系。</p>
        </div>
        <div className="organization-filters" aria-label="关系列表范围">
          <button type="button" aria-pressed={!showDeleted} onClick={() => setShowDeleted(false)}>
            当前关系
          </button>
          <button type="button" aria-pressed={showDeleted} onClick={() => setShowDeleted(true)}>
            已删除 {relations.filter((relation) => relation.deletedAt).length || ""}
          </button>
        </div>
      </div>
      {visible.length ? (
        <div className="organization-results">
          {visible.map((relation) => (
            <SavedRelation
              key={relation.id}
              relation={relation}
              data={data}
              pending={pending}
              run={(action) => void run(action)}
              onSave={onSave}
              onDelete={onDelete}
              onRestore={onRestore}
              onOpenNote={onOpenNote}
              onOpenCitation={onOpenCitation}
            />
          ))}
        </div>
      ) : (
        <div className="organization-empty relations-empty">
          <span>
            <Link2 size={22} />
          </span>
          <h3>{showDeleted ? "没有已删除的关系" : "这份知识页还没有关系"}</h3>
          <p>
            {showDeleted
              ? "删除后的关系会保留在这里，可按需恢复。"
              : "在下方选择另一份知识页，手动建立关系或让 AI 提出建议。"}
          </p>
        </div>
      )}
      <section className="organization-compose relations-compose">
        <div className="organization-compose-heading">
          <h3>连接另一份知识页</h3>
          <span>同一知识库</span>
        </div>
        <label className="relations-field relations-compare-picker">
          <span>另一份知识页</span>
          <select
            value={compareId}
            onChange={(event) => {
              setCompareId(event.target.value);
              setManual(false);
            }}
          >
            <option value="">请选择知识页</option>
            {compareId && !others.some((item) => item.id === compareId) && (
              <option value={compareId}>原选知识页已不可用</option>
            )}
            {others.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title || "未命名知识页"}
              </option>
            ))}
          </select>
        </label>
        {!others.length && (
          <p className="organization-subtle">当前知识库还没有另一份知识页，创建后即可建立关系。</p>
        )}
        {compareId && !availableCompare && (
          <div className="organization-selection-warning">
            <Info size={14} />
            <span>原选知识页已删除或移出当前知识库，请手动重新选择。</span>
          </div>
        )}
        {availableCompare && (
          <>
            <Basis from={note} to={availableCompare} type="related" onOpen={onOpenNote} />
            <div className="relations-manual-actions">
              <button
                type="button"
                className="btn"
                disabled={pending || manual}
                onClick={() => setManual(true)}
              >
                <Plus size={14} />
                手动建立关系
              </button>
              <span>手动关系不需要调用模型，需至少一处原文依据。</span>
            </div>
            {manual && (
              <RelationEditor
                key={`${note.id}:${availableCompare.id}`}
                data={data}
                from={note}
                to={availableCompare}
                ai={false}
                allowReverse
                pending={pending}
                onCancel={() => setManual(false)}
                submitLabel="建立关系"
                onSubmit={(draft, reversed) =>
                  void run(async () => {
                    await onSave({
                      ...draft,
                      fromNoteId: reversed ? availableCompare.id : note.id,
                      toNoteId: reversed ? note.id : availableCompare.id,
                    });
                    setManual(false);
                  })
                }
              />
            )}
            <div
              className={`organization-status${status.ready ? "" : " organization-status-muted"}`}
              role="status"
            >
              <Info size={14} />
              <span>
                {status.message ||
                  (status.ready
                    ? "模型服务已就绪，点击下方按钮开始分析。"
                    : "正在读取模型服务状态。")}
              </span>
              {onRefreshStatus && (
                <button
                  type="button"
                  className="organization-text-button"
                  disabled={pending}
                  onClick={() => void run(onRefreshStatus)}
                >
                  <RotateCcw size={12} />
                  刷新状态
                </button>
              )}
            </div>
            <GenerateRelations
              key={`generate:${note.id}:${availableCompare.id}`}
              data={data}
              from={note}
              to={availableCompare}
              status={status}
              pending={pending}
              run={(action) => void run(action)}
              onGenerate={onGenerate}
            />
          </>
        )}
      </section>
      <div className="organization-review-heading">
        <div>
          <h3>
            AI 关系建议 <span className="relations-count">{jobs.length}</span>
          </h3>
          <p>每次分析绑定两份知识页与资料版本，未接受的建议不会加入关系列表。</p>
        </div>
      </div>
      {jobs.length ? (
        <div className="organization-results">
          {jobs.map((job) => {
            const active = job.status === "queued" || job.status === "running";
            const target = currentNote(data, job.request.targetNote?.id || "");
            const comparison = currentNote(data, job.request.compareNote?.id || "");
            const result = job.result?.kind === "relations" ? job.result : undefined;
            const reviewReason = job.status === "ready" ? relationReviewReason(data, job) : "";
            const retryRequest: OrganizationRequest = {
              ...job.request,
              targetNote: target
                ? {
                    id: target.id,
                    revision: snapshotKnowledgeNote(target).revision,
                    updatedAt: target.updatedAt,
                  }
                : job.request.targetNote,
              compareNote: comparison
                ? {
                    id: comparison.id,
                    revision: snapshotKnowledgeNote(comparison).revision,
                    updatedAt: comparison.updatedAt,
                  }
                : job.request.compareNote,
              sourceVersions: job.request.sourceIds.map((sourceId) => ({
                sourceId,
                versionId:
                  data.sources.find((source) => source.id === sourceId)?.versionId || "unavailable",
              })),
            };
            const retryReason = organizationUnavailableReason(data, retryRequest);
            const checkReason = organizationUnavailableReason(data, job.request);
            const modelDisabled = pending || status.running || !status.ready || !data.aiEnabled;
            return (
              <article className="organization-result-card relations-job" key={job.id}>
                <div className="organization-result-heading">
                  <span className="organization-result-icon">
                    {active ? (
                      <LoaderCircle size={17} className="organization-spinner" />
                    ) : (
                      <Sparkles size={17} />
                    )}
                  </span>
                  <div>
                    <h3>
                      {jobLabels[job.status]}
                      {result ? ` · ${result.relations.length} 条关系建议` : ""}
                    </h3>
                    <p>
                      {formatDate(job.createdAt)} · {job.request.sourceIds.length} 份资料
                      {job.request.topic ? ` · ${job.request.topic}` : ""}
                    </p>
                    <p>
                      {target?.title || result?.target.title || "原知识页"} ↔{" "}
                      {comparison?.title || result?.compare.title || "另一知识页"}
                    </p>
                  </div>
                  {!active && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="收起这次关系建议"
                      title="收起建议，已接受的关系会保留"
                      disabled={pending}
                      onClick={() => void run(() => onDismiss(job.id))}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                {job.status === "ready" && result ? (
                  <RelationSuggestions
                    data={data}
                    job={job}
                    pending={pending}
                    run={(action) => void run(action)}
                    onAccept={onAccept}
                    onIgnore={onIgnore}
                    onOpenNote={onOpenNote}
                    onOpenCitation={onOpenCitation}
                  />
                ) : (
                  <p className="relations-job-message">
                    {active
                      ? "正在对照两页观点和所选原文，生成结束后可逐项审核。"
                      : job.error || "这次分析尚未得到可审核的关系建议。"}
                  </p>
                )}
                {(active || job.status !== "ready" || reviewReason) && (
                  <div className="relations-job-actions">
                    {active && (
                      <button type="button" className="btn" onClick={() => onStop(job.id)}>
                        <Square size={12} />
                        停止分析
                      </button>
                    )}
                    {!job.restoredFromBackup &&
                      job.status !== "queued" &&
                      job.status !== "ready" && (
                        <button
                          type="button"
                          className="btn"
                          disabled={modelDisabled || Boolean(checkReason)}
                          onClick={() => void run(() => onCheck(job.id))}
                        >
                          <RotateCcw size={12} />
                          检查原请求
                        </button>
                      )}
                    {!active && (
                      <button
                        type="button"
                        className="btn"
                        disabled={modelDisabled || Boolean(retryReason)}
                        onClick={() => void run(() => onRetry(job.id))}
                      >
                        <Sparkles size={13} />
                        按当前双页重新生成
                      </button>
                    )}
                    {!active && (
                      <p>
                        {job.restoredFromBackup && "这是备份中的任务记录，无法检查原工作区请求。"}
                        {retryReason ||
                          "重新生成沿用这次资料选集，绑定当前双页版本并创建新任务。也可在上方调整分析范围。"}
                      </p>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="organization-empty relations-empty">
          <span>
            <Sparkles size={22} />
          </span>
          <h3>还没有 AI 关系建议</h3>
          <p>选好两份知识页和原文资料后，主动发起一次分析。</p>
        </div>
      )}
    </div>
  );
}

export default ConceptRelationsPanel;
