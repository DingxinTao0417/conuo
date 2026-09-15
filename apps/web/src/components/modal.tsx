"use client";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
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
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
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
        <h2>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="关闭" disabled={!dismissible}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
