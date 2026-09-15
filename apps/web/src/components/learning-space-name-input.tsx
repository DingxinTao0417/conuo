"use client";

import { useState } from "react";
import type { Space } from "@/lib/types";
import "./learning-space-name-input.css";

export default function LearningSpaceNameInput({
  space,
  onRename,
  onInvalid,
}: {
  space: Space;
  onRename: (name: string, expectedName: string) => boolean;
  onInvalid: () => void;
}) {
  const [draft, setDraft] = useState<{ name: string; baseName: string } | null>(null);
  const conflict = !!draft && draft.baseName !== space.name && draft.name.trim() !== space.name;

  function commit(confirmCurrent = false) {
    if (!draft) return;
    if (!draft.name.trim()) {
      setDraft(null);
      onInvalid();
      return;
    }
    if (draft.name.trim() === space.name) {
      setDraft(null);
      return;
    }
    if (conflict && !confirmCurrent) return;
    if (onRename(draft.name, confirmCurrent ? space.name : draft.baseName)) setDraft(null);
  }

  return (
    <div className="learning-space-name-field">
      <input
        aria-label={`空间名称 ${space.name}`}
        className="field"
        value={draft?.name ?? space.name}
        onChange={(event) =>
          setDraft({ name: event.currentTarget.value, baseName: draft?.baseName ?? space.name })
        }
        onBlur={() => commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {conflict && (
        <div className="learning-space-name-conflict" role="status">
          <p>名称已更新为“{space.name}”。你的输入仍保留，请选择要使用的名称。</p>
          <div>
            <button className="text-button" onClick={() => setDraft(null)}>
              使用最新名称
            </button>
            <button className="text-button" onClick={() => commit(true)}>
              采用我的名称
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
