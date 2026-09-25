"use client";

import Image from "next/image";
import { Cloud, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import AccountPanel, { type AccountEntryMode } from "./account-panel";
import { authCopy, type Lang } from "./landing/auth-copy";

const ignorePanelAction = () => {};

/**
 * Account dialog layered over the homepage. It only collects credentials;
 * the workspace still opens solely after WebCloudEntry's own verification.
 */
export default function WebCloudAuthDialog({
  initialMode,
  lang,
  unavailable,
  onClose,
  onRetry,
}: {
  initialMode: AccountEntryMode;
  lang: Lang;
  unavailable: boolean;
  onClose: () => void;
  onRetry: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<AccountEntryMode>(initialMode);
  const t = authCopy[lang];

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const origin = dialog.ownerDocument.activeElement;
    if (!dialog.open) dialog.showModal?.();
    return () => {
      dialog.close?.();
      if (origin instanceof HTMLElement && origin.isConnected && !origin.closest("[inert]"))
        origin.focus({ preventScroll: true });
    };
  }, []);

  const title = unavailable ? t.titles.unavailable : t.titles[mode];
  return (
    <dialog
      ref={ref}
      className="web-cloud-auth"
      aria-labelledby="web-cloud-entry-title"
      data-lenis-prevent
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <div className="web-cloud-auth-art" aria-hidden="true">
        <Image src="/conuo-icon-192.png" alt="" width={48} height={48} />
        <p className="web-cloud-auth-tagline">{t.tagline}</p>
        <ol>
          {t.flow.map((step, index) => (
            <li key={step}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {step}
            </li>
          ))}
        </ol>
      </div>
      <div className="web-cloud-auth-body">
        <button
          type="button"
          className="web-cloud-auth-close"
          aria-label={t.close}
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <div className="web-cloud-brand" aria-label="Conuo">
          <Image src="/conuo-icon-192.png" alt="" width={32} height={32} />
          <span>Conuo</span>
        </div>
        <div className="web-cloud-entry-intro">
          <span className="web-cloud-entry-label">
            <Cloud size={15} />
            {t.label}
          </span>
          <h2 id="web-cloud-entry-title">{title}</h2>
          <p>{!unavailable && mode === "reset" ? t.resetLead : t.lead}</p>
        </div>
        {unavailable ? (
          <div className="web-cloud-entry-unavailable">
            <p role="alert">{t.unavailable}</p>
            <button type="button" className="btn primary" onClick={onRetry}>
              {t.retry}
            </button>
          </div>
        ) : (
          <div className="web-cloud-login">
            <AccountPanel
              appearance="entry"
              initialMode={initialMode}
              onModeChange={setMode}
              onSessionChange={ignorePanelAction}
              onClose={ignorePanelAction}
            />
          </div>
        )}
        {t.localeNote ? <p className="web-cloud-auth-note">{t.localeNote}</p> : null}
      </div>
    </dialog>
  );
}
