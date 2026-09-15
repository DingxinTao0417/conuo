"use client";
import type { Dispatch, SetStateAction } from "react";
import { restoreNoteVersion } from "@/lib/note-versions";
import type { Note } from "@/lib/types";
import Modal from "../../modal";
import { plain } from "../shared";
import type { WorkspaceStore } from "../types";

export type NoteHistoryModalProps = {
  currentNote: Note;
  update: WorkspaceStore["update"];
  setEditorKey: Dispatch<SetStateAction<number>>;
  setModal: (modal: null) => void;
};

export default function NoteHistoryModal({
  currentNote,
  update,
  setEditorKey,
  setModal,
}: NoteHistoryModalProps) {
  return (
    <Modal title="笔记历史版本" onClose={() => setModal(null)}>
      <div className="modal-body">
        <p className="muted">
          编辑期间每分钟保留一个历史快照；接受更新时立即保存旧版本，最多保留 30
          个。恢复前保留当前内容。旧记录若无引用快照，恢复时会清空引用并将知识页设为待审核。
        </p>
        {currentNote.versions.length ? (
          [...currentNote.versions].reverse().map((v) => (
            <div className="version-row" key={v.id}>
              <div>
                <b>{v.title}</b>
                <p>{new Date(v.savedAt).toLocaleString("zh-CN")}</p>
                <p>{plain(v.content).slice(0, 100)}</p>
              </div>
              <button
                className="btn"
                onClick={() => {
                  update((d) => ({
                    ...d,
                    notes: d.notes.map((n) =>
                      n.id === currentNote.id ? restoreNoteVersion(n, v.id) : n,
                    ),
                  }));
                  setEditorKey((k) => k + 1);
                  setModal(null);
                }}
              >
                恢复
              </button>
            </div>
          ))
        ) : (
          <p>还没有历史版本。</p>
        )}
      </div>
    </Modal>
  );
}
