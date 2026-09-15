"use client";
import { ChevronRight, FileText, StickyNote } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AnswerNoteEvidence, Citation, Message, Note, Source } from "@/lib/types";
import { markdownSourceComponents } from "../markdown-selection";
import {
  citationCardId,
  citationIndexFromHref,
  citationLocation,
  createRemarkCitationReferences,
  noteEvidenceCardId,
  noteEvidenceIndexFromHref,
} from "./citation-markdown";

export interface CitationChipProps {
  citation: Citation;
  index: number;
  cardId: string;
  expanded: boolean;
  issue: string | null;
  onToggle: () => void;
}

export function CitationChip({
  citation,
  index,
  cardId,
  expanded,
  issue,
  onToggle,
}: CitationChipProps) {
  return (
    <button
      type="button"
      className={`reader-inline-citation ${issue ? "reader-inline-citation-invalid" : ""}`}
      aria-label={`查看引用 ${index + 1}：${citation.title} · ${citationLocation(citation)}${
        issue ? "，当前不可用" : ""
      }`}
      aria-controls={cardId}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <FileText size={12} aria-hidden="true" />
      <span className="reader-inline-citation-title">{citation.title}</span>
      <span className="reader-inline-citation-location">{citationLocation(citation)}</span>
    </button>
  );
}

export function noteEvidenceProblem(
  evidence: AnswerNoteEvidence,
  notes: Note[],
  sources: Source[],
): string | null {
  const source = sources.find((item) => item.id === evidence.sourceId);
  if (!source || source.deletedAt) return "关联资料已删除，以下保留的是回答当时使用的笔记摘录。";
  const sourceInOriginalSpace =
    evidence.spaceId === "inbox"
      ? source.spaceIds.length === 0
      : source.spaceIds.includes(evidence.spaceId);
  if (!sourceInOriginalSpace) return "关联资料已移出原知识库，以下保留的是回答当时使用的笔记摘录。";
  if (!source.aiAllowed) return "关联资料已关闭 AI 使用，以下保留的是回答当时使用的笔记摘录。";
  if (source.versionId !== evidence.sourceVersionId)
    return "关联资料已更新，以下保留的是回答当时使用的笔记摘录。";
  const note = notes.find((item) => item.id === evidence.noteId);
  if (!note || note.deletedAt) return "这条个人笔记已删除，以下保留的是回答当时使用的摘录。";
  if (note.spaceId !== evidence.spaceId)
    return "这条个人笔记已移到其他知识库，以下保留的是回答当时使用的摘录。";
  if (note.kind !== "note" || note.status !== "accepted" || note.aiGenerated !== false)
    return "这条笔记已不再符合“我的笔记”依据条件，以下保留的是回答当时使用的摘录。";
  if (
    !note.citations.length ||
    note.citations.some(
      (citation) =>
        citation.sourceId !== evidence.sourceId || citation.versionId !== evidence.sourceVersionId,
    )
  )
    return "这条笔记的资料关联已变化，以下保留的是回答当时使用的摘录。";
  if (
    (note.contentRevision ?? 0) !== evidence.revision ||
    note.updatedAt !== evidence.updatedAt ||
    note.title !== evidence.title
  )
    return "这条个人笔记后来已修改，以下保留的是回答当时使用的摘录。";
  return null;
}

export interface NoteEvidenceChipProps {
  evidence: AnswerNoteEvidence;
  index: number;
  cardId: string;
  expanded: boolean;
  issue: string | null;
  onToggle: () => void;
}

export function NoteEvidenceChip({
  evidence,
  index,
  cardId,
  expanded,
  issue,
  onToggle,
}: NoteEvidenceChipProps) {
  return (
    <button
      type="button"
      className={`reader-inline-note-evidence ${issue ? "reader-inline-citation-invalid" : ""}`}
      aria-label={`查看我的笔记依据 ${index + 1}：${evidence.title}${issue ? "，笔记已变化" : ""}`}
      aria-controls={cardId}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <StickyNote size={12} aria-hidden="true" />
      <span>我的笔记</span>
      <span className="reader-inline-citation-title">{evidence.title}</span>
    </button>
  );
}

export interface AnswerMarkdownProps {
  content: string;
  citations: Citation[];
  noteEvidence: AnswerNoteEvidence[];
  mode: Message["mode"];
  messageId: string;
  expandedCitationIndex: number | null;
  expandedNoteEvidenceIndex: number | null;
  citationIssues: Array<string | null>;
  noteEvidenceIssues: Array<string | null>;
  onCitationToggle: (index: number) => void;
  onNoteEvidenceToggle: (index: number) => void;
}

export function AnswerMarkdown({
  content,
  citations,
  noteEvidence,
  mode,
  messageId,
  expandedCitationIndex,
  expandedNoteEvidenceIndex,
  citationIssues,
  noteEvidenceIssues,
  onCitationToggle,
  onNoteEvidenceToggle,
}: AnswerMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, createRemarkCitationReferences(citations, noteEvidence, mode)]}
      components={{
        a: ({ href, children }) => {
          const index = citationIndexFromHref(href);
          const citation = index === null ? undefined : citations[index];
          if (index !== null && citation) {
            return (
              <CitationChip
                citation={citation}
                index={index}
                cardId={citationCardId(messageId, index)}
                expanded={expandedCitationIndex === index}
                issue={citationIssues[index] || null}
                onToggle={() => onCitationToggle(index)}
              />
            );
          }
          if (index !== null) return <>{children}</>;
          const noteIndex = noteEvidenceIndexFromHref(href);
          const evidence = noteIndex === null ? undefined : noteEvidence[noteIndex];
          if (noteIndex !== null && evidence) {
            return (
              <NoteEvidenceChip
                evidence={evidence}
                index={noteIndex}
                cardId={noteEvidenceCardId(messageId, noteIndex)}
                expanded={expandedNoteEvidenceIndex === noteIndex}
                issue={noteEvidenceIssues[noteIndex] || null}
                onToggle={() => onNoteEvidenceToggle(noteIndex)}
              />
            );
          }
          if (noteIndex !== null) return <>{children}</>;
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        },
        img: ({ alt }) => (
          <span className="reader-image-placeholder">[图片{alt ? `：${alt}` : ""}]</span>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export interface CitationCardProps {
  citation: Citation;
  index: number;
  id: string;
  issue: string | null;
  onOpen: () => void;
}

export function CitationCard({ citation, index, id, issue, onOpen }: CitationCardProps) {
  return (
    <section
      id={id}
      className={`reader-citation-card ${issue ? "reader-citation-card-invalid" : ""}`}
      role="region"
      aria-label={`引用 ${index + 1} 原文`}
    >
      <header className="reader-citation-card-header">
        <FileText size={14} aria-hidden="true" />
        <div>
          <strong>{citation.title}</strong>
          <span>{citationLocation(citation)}</span>
        </div>
      </header>
      <blockquote>{citation.quote}</blockquote>
      {issue ? (
        <p className="reader-citation-invalid">{issue}</p>
      ) : (
        <button type="button" onClick={onOpen}>
          打开原文位置 <ChevronRight size={14} />
        </button>
      )}
    </section>
  );
}

export function NoteEvidenceCard({
  evidence,
  index,
  id,
  issue,
}: {
  evidence: AnswerNoteEvidence;
  index: number;
  id: string;
  issue: string | null;
}) {
  return (
    <section
      id={id}
      className={`reader-note-evidence-card ${issue ? "reader-citation-card-invalid" : ""}`}
      role="region"
      aria-label={`我的笔记依据 ${index + 1}`}
    >
      <header className="reader-citation-card-header">
        <StickyNote size={14} aria-hidden="true" />
        <div>
          <strong>{evidence.title}</strong>
          <span>回答时保存的个人笔记摘录</span>
        </div>
      </header>
      <blockquote>{evidence.quote}</blockquote>
      <p className={issue ? "reader-citation-invalid" : "reader-note-evidence-disclosure"}>
        {issue || "这是你的个人笔记，不是原始资料。"}
      </p>
    </section>
  );
}

export function Markdown({
  content,
  sourceAnchors = false,
}: {
  content: string;
  sourceAnchors?: boolean;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        ...(sourceAnchors ? markdownSourceComponents : {}),
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        img: ({ alt }) => (
          <span className="reader-image-placeholder">[图片{alt ? `：${alt}` : ""}]</span>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
