import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import {
  ConuoPdfInkView,
  type LocalSnapshotEvent,
} from "../../modules/conuo-pdf-ink";
import type { PdfInkToolsState } from "./PdfInkToolbar";
import { File } from "expo-file-system";
import * as Crypto from "expo-crypto";
import type { Source } from "../core/contracts";
import { downloadPdfOriginal } from "../core/pdf-original";
import { createApi } from "../core/api";
import { apiUrl, getAuthClient } from "../session";
import {
  buildInkOperationId,
  createInkSyncQueue,
  inkErrorMessage,
  parseInkCommit,
  parseInkManifest,
  parseInkReservation,
} from "../core/ink-api";
import { colors as c } from "../theme";

export default function NativePdfReader({
  source,
  inkNamespace,
  visible,
  wide,
  tools,
  onReadingMove,
  onOpenOriginal,
}: {
  source: Source;
  inkNamespace?: string;
  visible: boolean;
  wide: boolean;
  tools: PdfInkToolsState;
  onReadingMove?: (page: number | undefined) => void;
  onOpenOriginal?: () => void;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(source.readPage ?? 1);
  const [pageCount, setPageCount] = useState(source.pageCount ?? 0);
  const [strokeCounts, setStrokeCounts] = useState<Record<number, number>>({});
  const [localProtected, setLocalProtected] = useState(false);
  const [cloudConfirmed, setCloudConfirmed] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [loadedKey, setLoadedKey] = useState("");
  const snapshotNamespace = `${inkNamespace ?? "demo"}-${source.id}-${source.versionId}`;
  const enqueueSync = useRef(createInkSyncQueue()).current;
  const pageUploads = useRef(
    new Map<number, { generation: number; syncedDrawingSha256: string | null }>(),
  );
  const strokeCount = strokeCounts[page] ?? 0;

  useEffect(() => {
    let cancelled = false;
    const key = `${source.id}:${source.versionId}:${source.storagePath ?? ""}`;
    setUri(null);
    setError("");
    setPage(source.readPage ?? 1);
    setPageCount(source.pageCount ?? 0);
    setStrokeCounts({});
    setLocalProtected(false);
    setCloudConfirmed(false);
    setSyncError("");
    pageUploads.current.clear();
    void downloadPdfOriginal(source)
      .then((next) => {
        if (!cancelled) {
          setLoadedKey(key);
          setUri(next);
        }
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "原件下载失败，请重试。");
      });
    return () => {
      cancelled = true;
    };
  }, [source.id, source.versionId, source.storagePath]);

  async function syncSnapshot(event: LocalSnapshotEvent) {
    setLocalProtected(true);
    setCloudConfirmed(false);
    setSyncError("");
    const auth = getAuthClient();
    if (!auth) return;
    try {
      const current = await auth.auth.getSession();
      const active = current.data.session;
      if (!active) throw new Error("SESSION_CHANGED");
      const owner = active.user.id;
      const api = createApi(apiUrl, async () => {
        const next = await auth.auth.getSession();
        const session = next.data.session;
        return session
          ? { userId: session.user.id, accessToken: session.access_token }
          : null;
      });
      const drawingBytes = await new File(event.drawingFileUri).bytes();
      const previewBytes = await new File(event.previewFileUri).bytes();
      const hash = async (bytes: Uint8Array) => {
        const digest = await Crypto.digest(
          Crypto.CryptoDigestAlgorithm.SHA256,
          Uint8Array.from(bytes),
        );
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      };
      if (
        (await hash(drawingBytes)) !== event.drawingSha256 ||
        (await hash(previewBytes)) !== event.previewSha256
      )
        throw new Error("INK_DIGEST_MISMATCH");
      // Empty PKDrawing payloads must not become a blank page head.
      if (event.drawingBytes < 80) {
        setLocalProtected(true);
        setCloudConfirmed(true);
        return;
      }
      const pageIndex = Math.max(0, event.page - 1);
      const prior = pageUploads.current.get(pageIndex) ?? {
        generation: 0,
        syncedDrawingSha256: null,
      };
      if (prior.syncedDrawingSha256 === event.drawingSha256) {
        setCloudConfirmed(true);
        setLocalProtected(true);
        setSyncError("");
        return;
      }
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fresh = parseInkManifest(
            await api.loadInkManifest(owner, source.id, source.versionId),
          );
          const head = fresh.pages.find((item) => item.pageIndex === pageIndex);
          const generation = prior.generation + 1 + attempt;
          const operationId = buildInkOperationId(pageIndex, event.drawingSha256, generation);
          const reservation = parseInkReservation(
            await api.reserveInkUpload(owner, source.id, source.versionId, {
              operationId,
              pageIndex,
              baseRevisionId: head?.headRevisionId ?? null,
              localGeneration: generation,
              drawing: { sha256: event.drawingSha256, bytes: event.drawingBytes },
              preview: {
                sha256: event.previewSha256,
                bytes: event.previewBytes,
                mimeType: "image/png",
              },
              coordinateSpace: event.coordinateSpace,
              pencilKitContentVersion: 1,
            }),
          );
          if (reservation.status !== "committed") {
            const toBuffer = (bytes: Uint8Array) =>
              bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
                ? (bytes.buffer as ArrayBuffer)
                : (bytes.buffer.slice(
                    bytes.byteOffset,
                    bytes.byteOffset + bytes.byteLength,
                  ) as ArrayBuffer);
            const drawingUpload = await auth.storage
              .from("ink")
              .upload(reservation.drawingStoragePath, toBuffer(drawingBytes), {
                contentType: "application/octet-stream",
                upsert: false,
              });
            if (drawingUpload.error && ![400, 409].includes(Number(drawingUpload.error.statusCode)))
              throw drawingUpload.error;
            const previewUpload = await auth.storage
              .from("ink")
              .upload(reservation.previewStoragePath, toBuffer(previewBytes), {
                contentType: "image/png",
                upsert: false,
              });
            if (previewUpload.error && ![400, 409].includes(Number(previewUpload.error.statusCode)))
              throw previewUpload.error;
            parseInkCommit(
              await api.commitInkUpload(owner, source.id, source.versionId, {
                operationId,
                intentId: reservation.intentId,
                reservationToken: reservation.reservationToken,
              }),
            );
          }
          pageUploads.current.set(pageIndex, {
            generation,
            syncedDrawingSha256: event.drawingSha256,
          });
          setCloudConfirmed(true);
          return;
        } catch (cause) {
          lastError = cause;
          const code = (cause as { code?: string } | null)?.code;
          if (code !== "INK_PAGE_CONFLICT" || attempt === 1) throw cause;
        }
      }
      throw lastError;
    } catch (cause) {
      const pageIndex = Math.max(0, event.page - 1);
      const prior = pageUploads.current.get(pageIndex);
      pageUploads.current.set(pageIndex, {
        generation: prior?.generation ?? 1,
        syncedDrawingSha256: null,
      });
      setSyncError(inkErrorMessage(cause));
    }
  }

  async function syncSnapshotWithRetry(event: LocalSnapshotEvent) {
    try {
      await syncSnapshot(event);
    } catch {
      // syncSnapshot already reports UI state; keep queue alive.
    }
  }

  const movePage = (delta: number) => {
    setPage((current) => Math.max(1, Math.min(pageCount || Number.MAX_SAFE_INTEGER, current + delta)));
  };

  return (
    <View style={[p.root, !visible && p.hidden]}>
      <View style={p.header}>
        <View style={p.pageControls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="上一页"
            disabled={page <= 1}
            onPress={() => movePage(-1)}
            style={[p.icon, page <= 1 && p.disabled]}
          >
            <ChevronLeft size={18} color={c.secondary} />
          </Pressable>
          <Text style={p.pageLabel}>
            {pageCount ? `${page} / ${pageCount}` : `${page}`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="下一页"
            disabled={pageCount > 0 && page >= pageCount}
            onPress={() => movePage(1)}
            style={[p.icon, pageCount > 0 && page >= pageCount && p.disabled]}
          >
            <ChevronRight size={18} color={c.secondary} />
          </Pressable>
        </View>
      </View>
      {error ? (
        <View style={p.message}>
          <Text style={p.error}>{error}</Text>
          {onOpenOriginal && (
            <Pressable accessibilityRole="link" onPress={onOpenOriginal}>
              <Text style={p.link}>在网页版打开原件</Text>
            </Pressable>
          )}
        </View>
      ) : !uri || loadedKey !== `${source.id}:${source.versionId}:${source.storagePath ?? ""}` ? (
        <View style={p.loading}>
          <ActivityIndicator color={c.brand} />
          <Text style={p.loadingText}>正在下载原始 PDF…</Text>
        </View>
      ) : (
        <ConuoPdfInkView
          key={uri}
          style={p.pdf}
          documentUri={uri}
          snapshotNamespace={snapshotNamespace}
          allowsFingerDrawing={false}
          annotationMode
          displayMode="continuous"
          selectedTool={tools.tool}
          selectedColor="#5850cf"
          currentPage={page}
          zoomStep={tools.zoomStep}
          undoToken={tools.undoToken}
          redoToken={tools.redoToken}
          onPageChanged={({ nativeEvent }) => {
            setPage(nativeEvent.page);
            setPageCount(nativeEvent.pageCount);
            onReadingMove?.(nativeEvent.page);
          }}
          onDrawingChanged={({ nativeEvent }) => {
            setStrokeCounts((prev) => ({
              ...prev,
              [nativeEvent.page]: nativeEvent.strokeCount,
            }));
            setLocalProtected(false);
          }}
          onLocalSnapshot={({ nativeEvent }) => {
            void enqueueSync(nativeEvent.page, () =>
              syncSnapshotWithRetry(nativeEvent),
            );
          }}
          onToolToggled={({ nativeEvent }) => {
            tools.setTool(nativeEvent.tool);
          }}
        />
      )}
    </View>
  );
}

const p = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#e9e9ec" },
  hidden: { display: "none" },
  header: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    borderBottomWidth: 1,
    borderBottomColor: c.line,
    backgroundColor: "#fcfcfd",
    gap: 10,
  },
  pageControls: { flexDirection: "row", alignItems: "center", gap: 2 },
  pageLabel: { minWidth: 52, textAlign: "center", color: c.secondary, fontSize: 12 },
  icon: { width: 36, height: 36, justifyContent: "center", alignItems: "center", borderRadius: 8 },
  disabled: { opacity: 0.3 },
  pdf: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  loadingText: { color: c.secondary, fontSize: 14 },
  message: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  error: { color: c.danger, fontSize: 14, textAlign: "center", lineHeight: 21 },
  link: { color: c.brand, fontSize: 14, fontWeight: "600" },
});
