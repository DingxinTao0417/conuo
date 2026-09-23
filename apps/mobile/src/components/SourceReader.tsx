import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowUpRight, List, Minus, Plus, X } from "lucide-react-native";
import type { Source } from "../core/contracts";
import {
  createReaderSession,
  readerKey,
  readerModel,
  readingBookmark,
  readingOffset,
  READER_FONT_MAX,
  READER_FONT_MIN,
  type ReaderBlockLayout,
  type ReaderSession,
} from "../core/reader";
import { colors as c } from "../theme";
import { useReducedMotion } from "./useReducedMotion";
import { MarkdownContent } from "./AnswerMarkdown";
import NativePdfReader from "./NativePdfReader";

export type SourceReaderProps = {
  source: Source;
  /** Account-isolated namespace used by the native PDF ink recovery layer. */
  inkNamespace?: string;
  tools?: import("./PdfInkToolbar").PdfInkToolsState;
  pagesPanelOpen?: boolean;
  onTogglePagesPanel?: () => void;
  highlight: string | null;
  /** Increments when the same citation is selected again. */
  highlightRequest?: number;
  visible: boolean;
  wide: boolean;
  onOpenOriginal?: () => void;
  /** Reports the physical page of the current reading position for cloud progress. */
  onReadingMove?: (page: number | undefined) => void;
  session?: ReaderSession;
};

export function SourceReader(props: SourceReaderProps) {
  if (
    Platform.OS !== "web" &&
    props.source.kind === "pdf" &&
    !!props.source.storagePath
  ) {
    return (
      <NativePdfReader
        source={props.source}
        inkNamespace={props.inkNamespace}
        visible={props.visible}
        wide={props.wide}
        tools={props.tools!}
        pagesPanelOpen={props.pagesPanelOpen}
        onTogglePagesPanel={props.onTogglePagesPanel}
        onReadingMove={props.onReadingMove}
        onOpenOriginal={props.onOpenOriginal}
      />
    );
  }
  const fallbackSession = useRef<ReaderSession | null>(null);
  if (!fallbackSession.current) fallbackSession.current = createReaderSession();
  return (
    <ReaderDocument
      key={readerKey(props.source)}
      {...props}
      session={props.session ?? fallbackSession.current}
    />
  );
}

export default SourceReader;

function ReaderDocument({
  source,
  highlight,
  highlightRequest = 0,
  visible,
  wide,
  onOpenOriginal,
  onReadingMove,
  session,
}: SourceReaderProps & { session: ReaderSession }) {
  const key = readerKey(source);
  const model = useMemo(() => readerModel(source), [source]);
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [fontSize, setFontSize] = useState(session.fontSize);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [activeChunk, setActiveChunk] = useState<string | null>(highlight);
  const [position, setPosition] = useState(0);
  const scroll = useRef<ScrollView>(null);
  const layouts = useRef(new Map<number, ReaderBlockLayout>());
  const viewport = useRef({ width: 0, height: 0 });
  const contentHeight = useRef(0);
  const pendingRestore = useRef(true);
  const bookmark = useRef(
    session.positions.get(key) ?? { block: -1, fraction: 0, offset: 0 },
  );
  const pendingChunk = useRef<{ id: string; animated: boolean } | null>(null);
  const frame = useRef<number | null>(null);
  const restore = useRef<() => void>(() => {});

  // Layout events settle across the viewport and paragraph children before restoring.
  // The ScrollView stays mounted while the narrow-screen AI pane covers it.
  const scheduleRestore = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        restore.current();
      });
    });
  }, []);

  const preservePosition = () => {
    if (!pendingRestore.current)
      bookmark.current = session.positions.get(key) ?? bookmark.current;
    pendingRestore.current = true;
  };

  restore.current = () => {
    if (
      !visible ||
      !viewport.current.height ||
      !contentHeight.current ||
      layouts.current.size <
        model.blocks.filter((block) => block.text.trim()).length ||
      (!pendingRestore.current && !pendingChunk.current)
    )
      return;
    const maximum = Math.max(
      0,
      contentHeight.current - viewport.current.height,
    );
    const blocks = [...layouts.current.values()];
    const requested = pendingChunk.current;
    const anchor = requested
      ? model.contents.find((item) => item.chunkId === requested.id)
      : undefined;
    const paragraph = anchor ? layouts.current.get(anchor.block) : undefined;
    const offset = paragraph
      ? Math.min(maximum, Math.max(0, paragraph.y - 16))
      : readingOffset(bookmark.current, blocks, maximum);
    pendingChunk.current = null;
    pendingRestore.current = false;
    session.positions.set(key, readingBookmark(blocks, offset));
    setPosition(maximum > 0 ? Math.round((offset / maximum) * 100) : 0);
    scroll.current?.scrollTo({
      y: offset,
      animated: !reducedMotion && !!paragraph && !!requested?.animated,
    });
  };

  useLayoutEffect(() => {
    setActiveChunk(highlight);
    if (highlight) pendingChunk.current = { id: highlight, animated: false };
    else pendingChunk.current = null;
    scheduleRestore();
  }, [highlight, highlightRequest, scheduleRestore]);

  useLayoutEffect(() => {
    if (visible) {
      bookmark.current = session.positions.get(key) ?? bookmark.current;
      pendingRestore.current = true;
      scheduleRestore();
    } else setContentsOpen(false);
  }, [visible, key, session, scheduleRestore]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const changeFont = (change: number) => {
    preservePosition();
    const next = Math.max(
      READER_FONT_MIN,
      Math.min(READER_FONT_MAX, fontSize + change),
    );
    session.fontSize = next;
    setFontSize(next);
    scheduleRestore();
  };

  const unresolved =
    !!activeChunk &&
    !model.contents.some((item) => item.chunkId === activeChunk);
  const linkOnly = source.kind === "web" && source.status === "link-only";

  return (
    <View style={[r.root, !visible && r.hidden]}>
      <View style={r.toolbar}>
        <View style={r.toolbarLabel}>
          <Text style={r.toolbarTitle}>正文阅读</Text>
          <Text style={r.micro}>位置 {position}%</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="打开段落目录"
          accessibilityState={{ expanded: contentsOpen }}
          onPress={() => setContentsOpen(true)}
          style={({ pressed }) => [
            r.tool,
            r.contentsButton,
            pressed && r.pressed,
          ]}
        >
          <List size={19} color={c.secondary} />
          {wide && <Text style={r.toolText}>目录</Text>}
        </Pressable>
        <View style={r.fontTools}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="缩小正文字号"
            accessibilityState={{ disabled: fontSize <= READER_FONT_MIN }}
            disabled={fontSize <= READER_FONT_MIN}
            onPress={() => changeFont(-2)}
            style={({ pressed }) => [
              r.tool,
              pressed && r.pressed,
              fontSize <= READER_FONT_MIN && r.disabled,
            ]}
          >
            <Minus size={17} color={c.secondary} />
          </Pressable>
          <Text accessibilityLabel={`当前字号 ${fontSize}`} style={r.fontValue}>
            {fontSize}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="放大正文字号"
            accessibilityState={{ disabled: fontSize >= READER_FONT_MAX }}
            disabled={fontSize >= READER_FONT_MAX}
            onPress={() => changeFont(2)}
            style={({ pressed }) => [
              r.tool,
              pressed && r.pressed,
              fontSize >= READER_FONT_MAX && r.disabled,
            ]}
          >
            <Plus size={17} color={c.secondary} />
          </Pressable>
        </View>
      </View>
      <ScrollView
        ref={scroll}
        style={r.scroll}
        contentContainerStyle={[r.document, wide && r.documentWide]}
        scrollEventThrottle={32}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          if (!visible || width <= 0 || height <= 0) return;
          if (
            viewport.current.width !== width ||
            viewport.current.height !== height
          )
            preservePosition();
          viewport.current = { width, height };
          scheduleRestore();
        }}
        onContentSizeChange={(_, height) => {
          if (!visible || height <= 0) return;
          if (contentHeight.current !== height) preservePosition();
          contentHeight.current = height;
          scheduleRestore();
        }}
        onScroll={(event) => {
          if (!visible || pendingRestore.current) return;
          const { contentOffset, contentSize, layoutMeasurement } =
            event.nativeEvent;
          const maximum = Math.max(
            0,
            contentSize.height - layoutMeasurement.height,
          );
          const offset = Math.min(maximum, Math.max(0, contentOffset.y));
          const next = readingBookmark([...layouts.current.values()], offset);
          bookmark.current = next;
          session.positions.set(key, next);
          setPosition(maximum > 0 ? Math.round((offset / maximum) * 100) : 0);
          const page =
            next.block >= 0 ? model.blocks[next.block]?.page : undefined;
          onReadingMove?.(page);
        }}
      >
        <View style={r.documentHeader}>
          <Text style={r.eyebrow}>READ & UNDERSTAND</Text>
          <Text accessibilityRole="header" style={r.title}>
            {source.title}
          </Text>
          <View style={r.metadata}>
            <Text style={r.kind}>{source.kind.toUpperCase()}</Text>
            <Text style={r.caption}>
              {linkOnly ? "链接收藏 · 尚无正文" : "解析正文"}
              {source.status === "partial" ? " · 部分内容未解析" : ""}
            </Text>
          </View>
          {(source.kind === "pdf" || source.kind === "docx") && (
            <Text style={r.caption}>
              以下为提取的文字，图表与原始排版请打开原件查看。
            </Text>
          )}
        </View>
        {unresolved && (
          <View accessibilityRole="alert" style={r.notice}>
            <Text style={r.noticeText}>
              这条引用无法在当前正文中唯一定位，请结合引用文字核对原件。
            </Text>
          </View>
        )}
        {!source.text.trim() && (
          <View style={r.empty}>
            <Text style={r.emptyTitle}>
              {linkOnly ? "已收藏链接，尚无正文" : "正文还没有准备好"}
            </Text>
            <Text style={r.caption}>
              {linkOnly
                ? "当前仅保存了网页链接，尚不能用于资料问答。请在网页版继续获取正文。"
                : "可以先打开网页版原件，或在网页版继续处理解析任务。"}
            </Text>
          </View>
        )}
        {model.blocks.map((block, index) =>
          block.text.trim() ? (
            <View
              key={`${index}-${block.chunkId ?? "text"}`}
              onLayout={(event) => {
                const { y, height } = event.nativeEvent.layout;
                if (height <= 0) return;
                layouts.current.set(index, { index, y, height });
                scheduleRestore();
              }}
              style={[
                r.paragraph,
                activeChunk === block.chunkId && r.highlight,
              ]}
            >
              {block.section &&
                block.section !== "正文" &&
                (index === 0 ||
                  block.section !== model.blocks[index - 1]?.section ||
                  block.page !== model.blocks[index - 1]?.page) && (
                  <Text style={r.section}>
                    {block.section}
                    {block.page ? ` · 原文第 ${block.page} 页` : ""}
                  </Text>
                )}
              {source.kind === "markdown" ? (
                <MarkdownContent
                  fontSize={fontSize}
                  lineHeight={Math.round(fontSize * 1.82)}
                  color="#36373d"
                  tableLabel="正文表格"
                >
                  {block.text}
                </MarkdownContent>
              ) : (
                <Text
                  selectable
                  style={[
                    r.body,
                    { fontSize, lineHeight: Math.round(fontSize * 1.82) },
                  ]}
                >
                  {block.text.trim()}
                </Text>
              )}
            </View>
          ) : null,
        )}
        {onOpenOriginal && (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="在网页版打开原件"
            onPress={onOpenOriginal}
            style={({ pressed }) => [r.original, pressed && r.pressed]}
          >
            <Text style={r.originalText}>在网页版打开原件</Text>
            <ArrowUpRight size={17} color={c.brand} />
          </Pressable>
        )}
        {!!source.text.trim() && <Text style={r.endMark}>— 本文结束 —</Text>}
      </ScrollView>
      <Modal
        visible={contentsOpen && visible}
        accessibilityLabel="段落目录"
        transparent
        animationType={reducedMotion ? "none" : "fade"}
        onRequestClose={() => setContentsOpen(false)}
      >
        <View style={[r.modal, wide && r.modalWide]}>
          <Pressable
            accessibilityLabel="关闭段落目录"
            accessibilityRole="button"
            onPress={() => setContentsOpen(false)}
            style={StyleSheet.absoluteFill}
          />
          <View
            accessibilityViewIsModal
            style={[
              r.contents,
              wide && r.contentsWide,
              { paddingBottom: Math.max(16, insets.bottom) },
            ]}
          >
            <View style={r.contentsHeader}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text accessibilityRole="header" style={r.contentsTitle}>
                  段落目录
                </Text>
                <Text style={r.caption}>选择段落，跳到对应原文</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭目录"
                onPress={() => setContentsOpen(false)}
                style={r.tool}
              >
                <X size={21} color={c.secondary} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={r.contentsList}>
              {model.contents.length ? (
                model.contents.map((item, index) => (
                  <Pressable
                    key={item.chunkId}
                    accessibilityRole="button"
                    accessibilityLabel={`定位第 ${index + 1} 段：${item.title}${item.page ? `，原文第 ${item.page} 页` : ""}`}
                    accessibilityState={{
                      selected: activeChunk === item.chunkId,
                    }}
                    onPress={() => {
                      setActiveChunk(item.chunkId);
                      pendingChunk.current = {
                        id: item.chunkId,
                        animated: true,
                      };
                      setContentsOpen(false);
                      scheduleRestore();
                    }}
                    style={({ pressed }) => [
                      r.contentsRow,
                      activeChunk === item.chunkId && r.contentsSelected,
                      pressed && r.pressed,
                    ]}
                  >
                    <Text style={r.contentsNumber}>
                      {String(index + 1).padStart(2, "0")}
                    </Text>
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={r.contentsLabel}>{item.title}</Text>
                      <Text numberOfLines={2} style={r.caption}>
                        {item.preview}
                      </Text>
                      {!!item.page && (
                        <Text style={r.micro}>原文第 {item.page} 页</Text>
                      )}
                    </View>
                  </Pressable>
                ))
              ) : (
                <View style={r.empty}>
                  <Text style={r.emptyTitle}>暂时没有可定位的段落</Text>
                  <Text style={r.caption}>
                    可以继续向下阅读，或打开原件查看完整内容。
                  </Text>
                </View>
              )}
            </ScrollView>
            <Text style={r.sessionHint}>
              阅读位置会按资料版本回写云端；字号仅保留在本次使用中。
            </Text>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const r = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.canvas, minWidth: 0 },
  hidden: { display: "none" },
  toolbar: {
    minHeight: 58,
    paddingHorizontal: 14,
    paddingVertical: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
    backgroundColor: "#fcfcfd",
  },
  toolbarLabel: { flex: 1, minWidth: 58, gap: 2 },
  toolbarTitle: { fontSize: 12, fontWeight: "500", color: c.secondary },
  micro: { fontSize: 11, lineHeight: 16, color: c.muted },
  tool: {
    minWidth: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
  },
  contentsButton: { flexDirection: "row", gap: 7, paddingHorizontal: 10 },
  toolText: { fontSize: 13, color: c.secondary },
  fontTools: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 10,
    backgroundColor: c.white,
  },
  fontValue: {
    minWidth: 22,
    textAlign: "center",
    fontSize: 12,
    color: c.secondary,
    fontVariant: ["tabular-nums"],
  },
  disabled: { opacity: 0.3 },
  pressed: { backgroundColor: "#eceaf5" },
  scroll: { flex: 1 },
  document: {
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 48,
    gap: 18,
  },
  documentWide: { paddingHorizontal: 38, paddingTop: 40 },
  documentHeader: { gap: 14, paddingBottom: 12 },
  eyebrow: {
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 1.7,
    color: c.brand,
  },
  title: {
    fontSize: 27,
    lineHeight: 38,
    fontWeight: "700",
    color: c.ink,
    letterSpacing: -0.6,
  },
  metadata: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    flexWrap: "wrap",
  },
  kind: {
    fontSize: 10,
    letterSpacing: 0.6,
    fontWeight: "600",
    color: c.brand,
    backgroundColor: c.purple,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
  },
  caption: { fontSize: 12, lineHeight: 20, color: c.secondary },
  paragraph: {
    gap: 10,
    borderLeftWidth: 3,
    borderLeftColor: "transparent",
    paddingLeft: 13,
    marginLeft: -16,
    paddingVertical: 2,
  },
  highlight: {
    borderLeftColor: c.brand,
    backgroundColor: "#f0edfb",
    borderRadius: 4,
  },
  section: { fontSize: 12, lineHeight: 20, fontWeight: "500", color: c.brand },
  body: { color: "#36373d" },
  original: {
    alignSelf: "flex-start",
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    marginLeft: -12,
    borderRadius: 8,
  },
  originalText: { fontSize: 13, color: c.brand, fontWeight: "500" },
  endMark: {
    textAlign: "center",
    fontSize: 11,
    color: c.muted,
    paddingVertical: 16,
  },
  notice: { padding: 12, borderRadius: 9, backgroundColor: c.peach },
  noticeText: { fontSize: 12, lineHeight: 20, color: "#865823" },
  empty: { gap: 10, paddingVertical: 28 },
  emptyTitle: { fontSize: 16, fontWeight: "500", color: c.ink },
  modal: { flex: 1, backgroundColor: "#20203455", justifyContent: "flex-end" },
  modalWide: { justifyContent: "center", alignItems: "center", padding: 32 },
  contents: {
    maxHeight: "85%",
    backgroundColor: c.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
  },
  contentsWide: { width: "100%", maxWidth: 480, borderRadius: 20 },
  contentsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
  },
  contentsTitle: { fontSize: 19, fontWeight: "600", color: c.ink },
  contentsList: { padding: 12, gap: 4 },
  contentsRow: {
    minHeight: 66,
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 13,
    gap: 12,
    borderRadius: 10,
  },
  contentsSelected: { backgroundColor: "#f2effb" },
  contentsNumber: {
    width: 24,
    fontSize: 12,
    lineHeight: 22,
    color: c.muted,
    fontVariant: ["tabular-nums"],
  },
  contentsLabel: {
    fontSize: 14,
    lineHeight: 22,
    fontWeight: "500",
    color: c.ink,
  },
  sessionHint: {
    paddingHorizontal: 24,
    paddingTop: 12,
    fontSize: 11,
    lineHeight: 17,
    color: c.muted,
  },
});
