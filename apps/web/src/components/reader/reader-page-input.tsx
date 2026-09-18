"use client";

import { useId, useState } from "react";

export type ReaderPageInputProps = {
  page: number;
  pages: number;
  sourceKey: string;
  disabled?: boolean;
  onCommit: (page: number) => void;
};

/** Discard a pending jump when the document, version, or reading surface changes. */
export default function ReaderPageInput(props: ReaderPageInputProps) {
  return <PageInput key={`${props.sourceKey}:${Boolean(props.disabled)}`} {...props} />;
}

function PageInput({ page, pages, disabled, onCommit }: ReaderPageInputProps) {
  const hintId = useId();
  // A draft remains independent of the visible page while a continuous PDF scrolls.
  // null follows the actual page and also prevents Enter followed by blur from
  // committing the same navigation twice.
  const [draft, setDraft] = useState<string | null>(null);
  const hint = `共 ${pages} 页。输入正整数，按 Enter 或移开焦点跳转，按 Esc 取消。`;

  function commit(value: string) {
    setDraft(null);
    if (disabled || !/^\d+$/u.test(value)) return;
    const requested = Number(value);
    if (!Number.isSafeInteger(requested) || requested < 1) return;
    onCommit(Math.min(requested, Math.max(1, Math.floor(pages))));
  }

  return (
    <>
      <input
        aria-label="跳转页码"
        aria-describedby={hintId}
        title={hint}
        type="text"
        inputMode="numeric"
        enterKeyHint="go"
        autoComplete="off"
        pattern="[0-9]*"
        value={draft ?? String(page)}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => {
          if (draft !== null) commit(draft);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            commit(draft ?? String(page));
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(null);
          }
        }}
      />
      <span id={hintId} hidden>
        {hint}
      </span>
    </>
  );
}
