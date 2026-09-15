"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Check, Crop, LoaderCircle, X } from "lucide-react";
import {
  capturePdfCanvasRegion,
  clampPdfCapturePoint,
  pdfCaptureRegionFromPoints,
  type PdfCaptureIdentity,
  type PdfCaptureLimits,
  type PdfCapturePoint,
  type PdfCaptureResult,
  type PdfCaptureSelection,
} from "./pdf-capture";
import styles from "./pdf-region-selector.module.css";

const MIN_SELECTION_CSS_PIXELS = 12;

interface StoredSelection {
  identityKey: string;
  region: PdfCaptureSelection["region"] | null;
}

interface DragState {
  identityKey: string;
  pointerId: number;
  anchor: PdfCapturePoint;
}

export interface PdfRegionSelectorProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  identity: PdfCaptureIdentity;
  ready?: boolean;
  busy?: boolean;
  limits?: Partial<PdfCaptureLimits>;
  onCapture: (capture: PdfCaptureResult) => void | Promise<void>;
  onCancel: () => void;
  onSelectionChange?: (selection: PdfCaptureSelection | null) => void;
}

function identityKey(identity: PdfCaptureIdentity) {
  return `${identity.sourceId}\u0000${identity.versionId}\u0000${identity.page}`;
}

function eventPoint(
  event: Pick<ReactPointerEvent<HTMLDivElement>, "clientX" | "clientY" | "currentTarget">,
) {
  const bounds = event.currentTarget.getBoundingClientRect();
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  return clampPdfCapturePoint({
    x: (event.clientX - bounds.left) / width,
    y: (event.clientY - bounds.top) / height,
  });
}

export default function PdfRegionSelector({
  canvasRef,
  identity,
  ready = true,
  busy = false,
  limits,
  onCapture,
  onCancel,
  onSelectionChange,
}: PdfRegionSelectorProps) {
  const currentIdentityKey = identityKey(identity);
  const identityKeyRef = useRef(currentIdentityKey);
  const previousIdentityKey = useRef(currentIdentityKey);
  const drag = useRef<DragState | null>(null);
  const operation = useRef(0);
  const [storedSelection, setStoredSelection] = useState<StoredSelection>({
    identityKey: currentIdentityKey,
    region: null,
  });
  const [working, setWorking] = useState(false);
  const [storedError, setStoredError] = useState({ identityKey: currentIdentityKey, message: "" });
  const selection =
    storedSelection.identityKey === currentIdentityKey ? storedSelection.region : null;
  const error = storedError.identityKey === currentIdentityKey ? storedError.message : "";
  const unavailable = busy || working || !ready;

  useEffect(() => {
    identityKeyRef.current = currentIdentityKey;
  }, [currentIdentityKey]);

  const updateSelection = useCallback(
    (region: PdfCaptureSelection["region"] | null) => {
      setStoredSelection({ identityKey: currentIdentityKey, region });
      onSelectionChange?.(region ? { identity: { ...identity }, region } : null);
    },
    [currentIdentityKey, identity, onSelectionChange],
  );

  const cancel = useCallback(() => {
    operation.current += 1;
    drag.current = null;
    setWorking(false);
    setStoredError({ identityKey: currentIdentityKey, message: "" });
    updateSelection(null);
    onCancel();
  }, [currentIdentityKey, onCancel, updateSelection]);

  useEffect(() => {
    if (previousIdentityKey.current === currentIdentityKey) return;
    previousIdentityKey.current = currentIdentityKey;
    drag.current = null;
    operation.current += 1;
    onSelectionChange?.(null);
  }, [currentIdentityKey, onSelectionChange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel]);

  function startSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (unavailable || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    const anchor = eventPoint(event);
    drag.current = {
      identityKey: currentIdentityKey,
      pointerId: event.pointerId,
      anchor,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setStoredError({ identityKey: currentIdentityKey, message: "" });
    updateSelection(pdfCaptureRegionFromPoints(anchor, anchor));
  }

  function moveSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const activeDrag = drag.current;
    if (
      unavailable ||
      !activeDrag ||
      activeDrag.identityKey !== currentIdentityKey ||
      activeDrag.pointerId !== event.pointerId
    )
      return;
    event.preventDefault();
    updateSelection(pdfCaptureRegionFromPoints(activeDrag.anchor, eventPoint(event)));
  }

  function finishSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const activeDrag = drag.current;
    if (
      !activeDrag ||
      activeDrag.identityKey !== currentIdentityKey ||
      activeDrag.pointerId !== event.pointerId
    )
      return;
    event.preventDefault();
    const region = pdfCaptureRegionFromPoints(activeDrag.anchor, eventPoint(event));
    const bounds = event.currentTarget.getBoundingClientRect();
    const largeEnough =
      region.width * bounds.width >= MIN_SELECTION_CSS_PIXELS &&
      region.height * bounds.height >= MIN_SELECTION_CSS_PIXELS;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    updateSelection(largeEnough ? region : null);
  }

  function abandonDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    updateSelection(null);
  }

  async function submitCapture() {
    const canvas = canvasRef.current;
    if (!canvas || !selection || unavailable) return;
    const captureOperation = operation.current + 1;
    operation.current = captureOperation;
    setWorking(true);
    setStoredError({ identityKey: currentIdentityKey, message: "" });
    try {
      const result = await capturePdfCanvasRegion(
        canvas,
        { identity: { ...identity }, region: selection },
        limits,
      );
      if (operation.current !== captureOperation || identityKeyRef.current !== currentIdentityKey)
        return;
      await onCapture(result);
    } catch (cause) {
      if (operation.current !== captureOperation || identityKeyRef.current !== currentIdentityKey)
        return;
      setStoredError({
        identityKey: currentIdentityKey,
        message: cause instanceof Error ? cause.message : "区域截图失败，请重新框选。",
      });
    } finally {
      if (operation.current === captureOperation && identityKeyRef.current === currentIdentityKey)
        setWorking(false);
    }
  }

  const selectionStyle = selection
    ? {
        left: `${selection.x * 100}%`,
        top: `${selection.y * 100}%`,
        width: `${selection.width * 100}%`,
        height: `${selection.height * 100}%`,
      }
    : undefined;

  return (
    <div
      className={`${styles.overlay} ${unavailable ? styles.unavailable : ""}`}
      data-pdf-region-selector="true"
      data-source-id={identity.sourceId}
      data-version-id={identity.versionId}
      data-page={identity.page}
      role="region"
      aria-label={`框选 PDF 第 ${identity.page} 页区域`}
      aria-busy={busy || working}
      onPointerDown={startSelection}
      onPointerMove={moveSelection}
      onPointerUp={finishSelection}
      onPointerCancel={abandonDrag}
    >
      <div className={styles.instructions} aria-hidden="true">
        <Crop size={14} />
        {ready ? "拖动框选要交给 AI 的区域" : "页面更新中，请稍候…"}
      </div>

      {selection && selection.width > 0 && selection.height > 0 && (
        <div
          className={styles.selection}
          style={selectionStyle}
          data-pdf-capture-selection="true"
          aria-hidden="true"
        >
          <span className={`${styles.handle} ${styles.handleNorthWest}`} />
          <span className={`${styles.handle} ${styles.handleNorthEast}`} />
          <span className={`${styles.handle} ${styles.handleSouthWest}`} />
          <span className={`${styles.handle} ${styles.handleSouthEast}`} />
        </div>
      )}

      <div
        className={styles.actions}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <button type="button" className={styles.cancel} onClick={cancel} disabled={busy}>
          <X size={14} />
          取消
        </button>
        <button
          type="button"
          className={styles.confirm}
          onClick={() => void submitCapture()}
          disabled={!selection || unavailable}
        >
          {working || busy ? (
            <LoaderCircle size={14} className={styles.spin} />
          ) : (
            <Check size={14} />
          )}
          使用这一区域
        </button>
      </div>
      <span className={styles.status} role="status" aria-live="polite">
        {selection
          ? `已框选页面宽度的 ${Math.round(selection.width * 100)}%，高度的 ${Math.round(selection.height * 100)}%`
          : "尚未框选区域"}
      </span>
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
