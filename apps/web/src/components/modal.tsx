"use client";
import { useId, useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";

const focusOrigins = new WeakMap<HTMLDialogElement, HTMLElement[]>();

export default function Modal({
  title,
  onClose,
  children,
  wide = false,
  dismissible = true,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  dismissible?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const document = dialog.ownerDocument;
    const previous = document.activeElement;
    const origin = previous instanceof HTMLElement && previous !== document.body ? previous : null;
    const parentDialog = origin?.closest("dialog");
    // Keep the outer entry too: an explicit discard can unmount both dialogs together.
    const parentOrigins = parentDialog ? (focusOrigins.get(parentDialog) ?? []) : [];
    const origins = origin ? [origin, ...parentOrigins] : [];
    focusOrigins.set(dialog, origins);
    dialog.showModal();
    return () => {
      const active = document.activeElement;
      const ownedFocus = !active || active === document.body || dialog.contains(active);
      // A passive-effect cleanup runs after removal, too late for native dialog restoration.
      dialog.close();
      focusOrigins.delete(dialog);
      const current = document.activeElement;
      if (!ownedFocus || (current && current !== document.body && !dialog.contains(current)))
        return;
      for (const target of origins) {
        if (
          !target.isConnected ||
          target.closest("[inert], dialog:not([open])") ||
          target.matches(":disabled")
        )
          continue;
        target.focus({ preventScroll: true });
        if (document.activeElement === target) break;
      }
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`modal ${wide ? "modal-wide" : ""} ${className}`.trim()}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) {
          const rect = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="关闭" disabled={!dismissible}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
