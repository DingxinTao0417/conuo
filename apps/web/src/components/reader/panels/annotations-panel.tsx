"use client";
import type { Annotation, Source } from "@/lib/types";
import { markdownQuoteText } from "../../markdown-selection";
import type { ReaderProps } from "../reader-types";

export type AnnotationsPanelProps = {
  sourceAnnotations: Annotation[];
  source: Source;
  historical: boolean;
  editingAnnotationId: string | null;
  editingAnnotationNote: string;
  onAnnotationUpdate: ReaderProps["onAnnotationUpdate"];
  onAnnotationDelete: ReaderProps["onAnnotationDelete"];
  isWideReaderLayout: () => boolean;
  changePage: (value: number, preserveCitation?: boolean) => void;
  beginAnnotationEdit: (annotation: Annotation) => void;
  saveAnnotationEdit: (annotation: Annotation) => void;
  deleteAnnotation: (annotation: Annotation) => void;
  setEditingAnnotationId: (id: string | null) => void;
  setEditingAnnotationNote: (note: string) => void;
  setFocusedAnnotationId: (id: string | null) => void;
  setAnnotationFocusEpoch: (epoch: number | ((current: number) => number)) => void;
  setFocusedCitation: (citation: null) => void;
  setAiOpen: (open: boolean) => void;
  setMobileTab: (tab: "reading" | "ai" | "citation") => void;
};

export default function AnnotationsPanel({
  sourceAnnotations,
  source,
  historical,
  editingAnnotationId,
  editingAnnotationNote,
  onAnnotationUpdate,
  onAnnotationDelete,
  isWideReaderLayout,
  changePage,
  beginAnnotationEdit,
  saveAnnotationEdit,
  deleteAnnotation,
  setEditingAnnotationId,
  setEditingAnnotationNote,
  setFocusedAnnotationId,
  setAnnotationFocusEpoch,
  setFocusedCitation,
  setAiOpen,
  setMobileTab,
}: AnnotationsPanelProps) {
  return (
    <aside id="reader-annotations-panel" className="reader-annotations" aria-label="我的标注">
      <h3>
        我的标注 <span>{sourceAnnotations.length}</span>
      </h3>
      {!sourceAnnotations.length && (
        <p className="muted">
          {historical
            ? "这个历史版本没有已保存的标注；如需记录原文，可以保存独立笔记。"
            : "选择原文后点击“高亮”，标注会保存在这里。"}
        </p>
      )}
      {sourceAnnotations.map((item) => {
        const editing = editingAnnotationId === item.id;
        return (
          <article className="reader-annotation-card" key={item.id}>
            <button
              type="button"
              className="reader-annotation-locate"
              aria-label={`定位批注：${markdownQuoteText(source, item.quote).slice(0, 32)}`}
              onClick={() => {
                if (item.page) changePage(item.page);
                setFocusedCitation(null);
                setFocusedAnnotationId(item.id);
                setAnnotationFocusEpoch((current) => current + 1);
                setMobileTab("reading");
                if (!isWideReaderLayout()) setAiOpen(false);
              }}
            >
              <blockquote>{markdownQuoteText(source, item.quote)}</blockquote>
              <span className="reader-annotation-meta">
                {item.page ? `第 ${item.page} 页 · ` : ""}
                {new Date(item.createdAt).toLocaleDateString("zh-CN")}
              </span>
            </button>
            {editing ? (
              <form
                className="reader-annotation-editor"
                aria-label="编辑批注"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveAnnotationEdit(item);
                }}
              >
                <textarea
                  aria-label="编辑批注内容"
                  value={editingAnnotationNote}
                  maxLength={4_000}
                  placeholder="写下你的理解、疑问或下一步行动"
                  onChange={(event) => setEditingAnnotationNote(event.target.value)}
                />
                <div className="reader-annotation-form-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingAnnotationId(null);
                      setEditingAnnotationNote("");
                    }}
                  >
                    取消
                  </button>
                  <button type="submit" className="btn btn-primary">
                    保存修改
                  </button>
                </div>
              </form>
            ) : (
              <p className={item.note ? "reader-annotation-note" : "reader-annotation-note muted"}>
                {item.note || "未添加说明"}
              </p>
            )}
            <div className="reader-annotation-actions">
              <button
                type="button"
                aria-label="编辑批注"
                disabled={historical || !onAnnotationUpdate}
                onClick={() => beginAnnotationEdit(item)}
              >
                编辑
              </button>
              <button
                type="button"
                aria-label="删除批注"
                disabled={historical || !onAnnotationDelete}
                onClick={() => deleteAnnotation(item)}
              >
                删除
              </button>
            </div>
          </article>
        );
      })}
    </aside>
  );
}
