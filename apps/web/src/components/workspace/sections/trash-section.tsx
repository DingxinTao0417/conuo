"use client";
import { StickyNote, Trash2 } from "lucide-react";
import type { Note, Source, WorkspaceData } from "@/lib/types";
import RecoverableDraftsPanel, { type RecoverableDraftItem } from "../../recoverable-drafts-panel";
import { Empty, SourceIcon, date } from "../shared";

export type TrashSectionProps = {
  data: WorkspaceData;
  ready: boolean;
  cloudReadOnly: boolean;
  recoverableDraftItems: RecoverableDraftItem[];
  restoreRecoverableDraft: (item: RecoverableDraftItem) => Promise<void>;
  saveRecoveredDraft: (item: RecoverableDraftItem) => Promise<void>;
  discardRecoveredDraft: (item: RecoverableDraftItem) => Promise<void>;
  restoreRecycledSource: (source: Source) => Promise<void>;
  openSourcePurge: (source: Source) => void;
  patchNote: (id: string, patch: Partial<Note>, record?: boolean) => void;
};

export default function TrashSection({
  data,
  ready,
  cloudReadOnly,
  recoverableDraftItems,
  restoreRecoverableDraft,
  saveRecoveredDraft,
  discardRecoveredDraft,
  restoreRecycledSource,
  openSourcePurge,
  patchNote,
}: TrashSectionProps) {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">为误删留一个回头的机会</p>
          <h1>回收站</h1>
          <p>此处资料不会参与新的检索；跨设备冲突保留的文字可单独取回。</p>
        </div>
      </div>
      {recoverableDraftItems.length > 0 && (
        <RecoverableDraftsPanel
          drafts={recoverableDraftItems}
          disabled={!ready}
          readOnly={cloudReadOnly}
          onRestoreSource={restoreRecoverableDraft}
          onSaveAsNote={saveRecoveredDraft}
          onDiscard={discardRecoveredDraft}
        />
      )}
      {!data.sources.some((s) => s.deletedAt) && !data.notes.some((n) => n.deletedAt) ? (
        <Empty
          icon={<Trash2 size={32} />}
          title="回收站是空的"
          text="删除的资料与笔记会出现在这里。"
        />
      ) : (
        <div className="trash-list">
          {data.sources
            .filter((s) => s.deletedAt)
            .map((s) => (
              <div key={s.id} className="trash-row">
                <SourceIcon source={s} />
                <div className="grow">
                  <b>{s.title}</b>
                  <p>
                    {date(s.deletedAt!)} 移入回收站
                    {(data.recoverableDrafts ?? []).some((draft) => draft.sourceId === s.id) &&
                      " · 含可恢复的离线文字"}
                  </p>
                </div>
                <button className="btn" onClick={() => void restoreRecycledSource(s)}>
                  恢复资料
                </button>
                <button className="btn btn-danger" onClick={() => openSourcePurge(s)}>
                  彻底删除
                </button>
              </div>
            ))}
          {data.notes
            .filter((n) => n.deletedAt)
            .map((n) => (
              <div key={n.id} className="trash-row">
                <StickyNote size={20} />
                <div className="grow">
                  <b>{n.title}</b>
                  <p>已删除的笔记</p>
                </div>
                <button className="btn" onClick={() => patchNote(n.id, { deletedAt: null }, false)}>
                  恢复笔记
                </button>
              </div>
            ))}
        </div>
      )}
    </>
  );
}
