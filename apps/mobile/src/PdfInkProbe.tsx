import { useEffect, useState } from "react";
import {
  CloudOff,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Highlighter,
  LassoSelect,
  Minus,
  MoreHorizontal,
  PanelsTopLeft,
  Pencil,
  PenLine,
  Plus,
  Redo2,
  Search,
  Share2,
  Sparkles,
  Undo2,
  type LucideIcon,
} from "lucide-react-native";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { ConuoPdfInkView, type InkTool } from "../modules/conuo-pdf-ink";

const colors = {
  ink: "#26272b",
  secondary: "#55575f",
  muted: "#6e7079",
  brand: "#5850cf",
  selected: "#eee9fc",
  canvas: "#f7f7f8",
  line: "#e8e8ec",
  paper: "#ffffff",
};

const toolItems: { id: InkTool; label: string; Icon: LucideIcon }[] = [
  { id: "pen", label: "钢笔", Icon: PenLine },
  { id: "pencil", label: "铅笔", Icon: Pencil },
  { id: "highlighter", label: "荧光笔", Icon: Highlighter },
  { id: "eraser", label: "橡皮擦", Icon: Eraser },
  { id: "lasso", label: "套索", Icon: LassoSelect },
];

const colorItems = [
  { label: "黑色", value: "#26272b" },
  { label: "深灰", value: "#686a73" },
  { label: "红色", value: "#dc4050" },
  { label: "蓝色", value: "#3278d4" },
  { label: "绿色", value: "#38986f" },
  { label: "黄色", value: "#e6b52f" },
];

export default function PdfInkProbe({ onExit }: { onExit: () => void }) {
  const { width } = useWindowDimensions();
  const compactPalette = width < 600;
  const compactHeader = width < 1100;
  const narrowHeader = width < 720;
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(3);
  const [drawing, setDrawing] = useState("尚未落笔");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [selectedTool, setSelectedTool] = useState<InkTool>("pen");
  const [selectedColor, setSelectedColor] = useState(colorItems[0].value);
  const [annotationMode, setAnnotationMode] = useState(true);
  const [displayMode, setDisplayMode] = useState<"continuous" | "single">(
    "continuous",
  );
  const [pageEntry, setPageEntry] = useState("1");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [zoomPercent, setZoomPercent] = useState<number | null>(null);
  const [zoomStep, setZoomStep] = useState(0);
  const [undoToken, setUndoToken] = useState(0);
  const [redoToken, setRedoToken] = useState(0);

  useEffect(() => setPageEntry(String(page)), [page]);

  const commitPageEntry = () => {
    const nextPage = Number.parseInt(pageEntry, 10);
    if (Number.isInteger(nextPage) && nextPage >= 1 && nextPage <= pageCount) {
      setPage(nextPage);
    } else {
      setPageEntry(String(page));
    }
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView
        style={styles.root}
        edges={["top", "left", "right", "bottom"]}
      >
        <View style={styles.topBar}>
          <View
            style={[
              styles.documentIdentity,
              narrowHeader && styles.documentIdentityNarrow,
            ]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="返回 Conuo"
              onPress={onExit}
              style={styles.backButton}
            >
              <ChevronLeft size={20} color={colors.ink} />
            </Pressable>
            <View style={styles.documentTitleGroup}>
              <Text numberOfLines={1} style={styles.documentTitle}>
                WP0 测试资料.pdf
              </Text>
              {!narrowHeader && (
                <Text style={styles.documentSubtitle}>PDF · 3 页</Text>
              )}
            </View>
          </View>

          <View style={styles.topControls}>
            {!compactHeader && (
              <View style={styles.modeGroup}>
                <ModeButton
                  label="连续"
                  selected={displayMode === "continuous"}
                  onPress={() => setDisplayMode("continuous")}
                />
                <ModeButton
                  label="单页"
                  selected={displayMode === "single"}
                  onPress={() => setDisplayMode("single")}
                />
              </View>
            )}

            <View style={styles.pageControls}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="上一页"
                accessibilityState={{ disabled: page <= 1 }}
                disabled={page <= 1}
                onPress={() => setPage((value) => Math.max(1, value - 1))}
                style={styles.pageButton}
              >
                <ChevronLeft
                  size={18}
                  color={page <= 1 ? colors.muted : colors.ink}
                />
              </Pressable>
              <View style={styles.pageEntryGroup}>
                <TextInput
                  accessibilityLabel="当前页码"
                  keyboardType="number-pad"
                  returnKeyType="done"
                  selectTextOnFocus
                  value={pageEntry}
                  onChangeText={(value) =>
                    setPageEntry(value.replace(/\D/g, ""))
                  }
                  onBlur={commitPageEntry}
                  onSubmitEditing={commitPageEntry}
                  style={styles.pageEntry}
                />
                <Text style={styles.pageCount}>/ {pageCount}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="下一页"
                accessibilityState={{ disabled: page >= pageCount }}
                disabled={page >= pageCount}
                onPress={() =>
                  setPage((value) => Math.min(pageCount, value + 1))
                }
                style={styles.pageButton}
              >
                <ChevronRight
                  size={18}
                  color={page >= pageCount ? colors.muted : colors.ink}
                />
              </Pressable>
            </View>

            {compactHeader ? (
              <>
                <ToolbarAction
                  label={annotationMode ? "关闭标注" : "开启标注"}
                  visibleLabel="标注"
                  Icon={PenLine}
                  selected={annotationMode}
                  onPress={() => setAnnotationMode((value) => !value)}
                />
                <ToolbarAction
                  label="AI 区域（尚未接入）"
                  visibleLabel="AI 区域"
                  Icon={Sparkles}
                  disabled
                />
              </>
            ) : (
              <View style={styles.commandGroup}>
                <ToolbarAction
                  label="搜索（尚未接入）"
                  visibleLabel="搜索"
                  Icon={Search}
                  disabled
                />
                <ToolbarAction
                  label={annotationMode ? "关闭标注" : "开启标注"}
                  visibleLabel="标注"
                  Icon={PenLine}
                  selected={annotationMode}
                  onPress={() => setAnnotationMode((value) => !value)}
                />
                <ToolbarAction
                  label="AI 区域（尚未接入）"
                  visibleLabel="AI 区域"
                  Icon={Sparkles}
                  disabled
                />
                <ToolbarAction
                  label="侧边面板（尚未接入）"
                  visibleLabel="面板"
                  Icon={PanelsTopLeft}
                  disabled
                />
                <ToolbarAction
                  label="分享（尚未接入）"
                  visibleLabel="分享"
                  Icon={Share2}
                  disabled
                />
                <ToolbarAction
                  label="更多（尚未接入）"
                  visibleLabel="更多"
                  Icon={MoreHorizontal}
                  disabled
                />
              </View>
            )}
          </View>

          <View style={styles.saveStatus}>
            <CloudOff size={14} color={colors.muted} />
            <View style={styles.saveStatusCopy}>
              <Text style={styles.saveStatusText}>
                {drawing === "尚未落笔" ? "仅本机" : "未保存"}
              </Text>
              {!narrowHeader && (
                <Text numberOfLines={1} style={styles.saveStatusDetail}>
                  {drawing === "尚未落笔" ? drawing : `${drawing} · 仅本机内存`}
                </Text>
              )}
            </View>
          </View>

          {compactHeader && (
            <ToolbarAction
              label={moreOpen ? "关闭更多菜单" : "更多"}
              visibleLabel="更多"
              Icon={MoreHorizontal}
              selected={moreOpen}
              onPress={() => setMoreOpen((value) => !value)}
            />
          )}

          {!compactHeader && (
            <View style={styles.zoomGroup}>
              <IconButton
                label="缩小 PDF"
                Icon={Minus}
                onPress={() => setZoomStep((value) => value - 1)}
              />
              <Text
                accessibilityLabel={`缩放 ${zoomPercent ?? 100}%`}
                style={styles.zoomValue}
              >
                {zoomPercent === null ? "适合宽度" : `${zoomPercent}%`}
              </Text>
              <IconButton
                label="放大 PDF"
                Icon={Plus}
                onPress={() => setZoomStep((value) => value + 1)}
              />
            </View>
          )}

          {compactHeader && moreOpen && (
            <View style={styles.moreMenu}>
              <View style={styles.moreMenuSection}>
                <Text style={styles.moreMenuTitle}>阅读模式</Text>
                <View style={styles.modeGroup}>
                  <ModeButton
                    label="连续"
                    selected={displayMode === "continuous"}
                    onPress={() => setDisplayMode("continuous")}
                  />
                  <ModeButton
                    label="单页"
                    selected={displayMode === "single"}
                    onPress={() => setDisplayMode("single")}
                  />
                </View>
              </View>
              <View style={styles.moreMenuSection}>
                <Text style={styles.moreMenuTitle}>缩放</Text>
                <View style={styles.zoomGroup}>
                  <IconButton
                    label="缩小 PDF"
                    Icon={Minus}
                    onPress={() => setZoomStep((value) => value - 1)}
                  />
                  <Text style={styles.zoomValue}>
                    {zoomPercent === null ? "适合宽度" : `${zoomPercent}%`}
                  </Text>
                  <IconButton
                    label="放大 PDF"
                    Icon={Plus}
                    onPress={() => setZoomStep((value) => value + 1)}
                  />
                </View>
              </View>
              <View style={styles.moreMenuSection}>
                <Text style={styles.moreMenuTitle}>文档工具</Text>
                <View style={styles.commandGroup}>
                  <ToolbarAction
                    label="搜索（尚未接入）"
                    visibleLabel="搜索"
                    Icon={Search}
                    disabled
                  />
                  <ToolbarAction
                    label="侧边面板（尚未接入）"
                    visibleLabel="面板"
                    Icon={PanelsTopLeft}
                    disabled
                  />
                  <ToolbarAction
                    label="分享（尚未接入）"
                    visibleLabel="分享"
                    Icon={Share2}
                    disabled
                  />
                </View>
              </View>
              <Text style={styles.moreMenuHint}>尚未接入的操作当前不可用</Text>
            </View>
          )}
        </View>

        <View style={styles.workArea}>
          {!compactPalette && (
            <ToolRail
              collapsed={railCollapsed}
              annotationMode={annotationMode}
              selectedTool={selectedTool}
              selectedColor={selectedColor}
              canUndo={canUndo}
              canRedo={canRedo}
              onSelectTool={setSelectedTool}
              onSelectColor={setSelectedColor}
              onUndo={() => setUndoToken((value) => value + 1)}
              onRedo={() => setRedoToken((value) => value + 1)}
              onToggleCollapsed={() => setRailCollapsed((value) => !value)}
            />
          )}

          <View style={styles.readerColumn}>
            <View style={styles.pdfStage}>
              <ConuoPdfInkView
                style={styles.reader}
                allowsFingerDrawing={false}
                annotationMode={annotationMode}
                displayMode={displayMode}
                selectedTool={selectedTool}
                selectedColor={selectedColor}
                currentPage={page}
                zoomStep={zoomStep}
                undoToken={undoToken}
                redoToken={redoToken}
                onPageChanged={(event) => {
                  const { page: nextPage, pageCount: nextPageCount } =
                    event.nativeEvent;
                  setPageCount(nextPageCount);
                  setPage(nextPage);
                }}
                onDrawingChanged={(event) => {
                  const {
                    strokeCount: nextCount,
                    isEmpty,
                    canUndo: nextCanUndo,
                    canRedo: nextCanRedo,
                  } = event.nativeEvent;
                  setCanUndo(nextCanUndo);
                  setCanRedo(nextCanRedo);
                  setDrawing(isEmpty ? "尚未落笔" : `${nextCount} 笔`);
                }}
                onZoomChanged={(event) => {
                  setZoomPercent(
                    Math.round(event.nativeEvent.scaleFactor * 100),
                  );
                }}
              />
            </View>

            {compactPalette && (
              <View style={styles.compactTools}>
                {toolItems.map(({ id, label, Icon }) => (
                  <IconButton
                    key={id}
                    label={label}
                    Icon={Icon}
                    selected={selectedTool === id}
                    disabled={!annotationMode}
                    onPress={() => setSelectedTool(id)}
                  />
                ))}
                <IconButton
                  label="撤销"
                  Icon={Undo2}
                  disabled={!canUndo}
                  onPress={() => setUndoToken((value) => value + 1)}
                />
                <IconButton
                  label="重做"
                  Icon={Redo2}
                  disabled={!canRedo}
                  onPress={() => setRedoToken((value) => value + 1)}
                />
              </View>
            )}
          </View>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function ToolRail({
  collapsed,
  annotationMode,
  selectedTool,
  selectedColor,
  canUndo,
  canRedo,
  onSelectTool,
  onSelectColor,
  onUndo,
  onRedo,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  annotationMode: boolean;
  selectedTool: InkTool;
  selectedColor: string;
  canUndo: boolean;
  canRedo: boolean;
  onSelectTool: (tool: InkTool) => void;
  onSelectColor: (color: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleCollapsed: () => void;
}) {
  const activeTool = toolItems.find((item) => item.id === selectedTool)!;

  return (
    <View
      style={[styles.toolRail, collapsed && styles.toolRailCollapsed]}
      accessibilityLabel="手写工具栏"
    >
      {collapsed ? (
        <>
          <ToolButton
            label={`${activeTool.label}，展开工具栏`}
            Icon={activeTool.Icon}
            selected
            disabled={!annotationMode}
            onPress={onToggleCollapsed}
          />
          <View style={styles.railDivider} />
          <IconButton
            label="展开手写工具栏"
            Icon={ChevronRight}
            onPress={onToggleCollapsed}
          />
        </>
      ) : (
        <>
          <View style={styles.toolRailHeader}>
            <Text style={styles.toolRailTitle}>笔</Text>
            <IconButton
              label="收起手写工具栏"
              Icon={ChevronLeft}
              onPress={onToggleCollapsed}
            />
          </View>
          <View style={styles.toolRailSection}>
            <IconButton
              label="撤销"
              Icon={Undo2}
              disabled={!canUndo}
              onPress={onUndo}
            />
            <IconButton
              label="重做"
              Icon={Redo2}
              disabled={!canRedo}
              onPress={onRedo}
            />
          </View>
          <View style={styles.railDivider} />
          <View style={styles.toolRailSection}>
            {toolItems.map(({ id, label, Icon }) => (
              <ToolButton
                key={id}
                label={label}
                Icon={Icon}
                selected={selectedTool === id}
                disabled={!annotationMode}
                onPress={() => onSelectTool(id)}
              />
            ))}
          </View>
          <View style={styles.railDivider} />
          <View style={styles.widthBadge}>
            <Text style={styles.widthValue}>
              {selectedTool === "highlighter" ? "8" : "2"}
            </Text>
            <Text style={styles.widthUnit}>pt</Text>
          </View>
          <View style={styles.colorSection}>
            {colorItems.map((color) => (
              <Pressable
                key={color.value}
                accessibilityRole="button"
                accessibilityLabel={`${color.label}笔色`}
                accessibilityState={{
                  selected: selectedColor === color.value,
                  disabled: !annotationMode,
                }}
                disabled={!annotationMode}
                onPress={() => onSelectColor(color.value)}
                style={[
                  styles.colorTarget,
                  selectedColor === color.value && styles.colorTargetSelected,
                  !annotationMode && styles.disabled,
                ]}
              >
                <View
                  style={[styles.colorSwatch, { backgroundColor: color.value }]}
                />
              </Pressable>
            ))}
          </View>
          <View style={styles.moreColors}>
            <IconButton
              label="更多颜色（尚未接入）"
              Icon={Plus}
              disabled
              onPress={() => undefined}
            />
            <Text style={styles.moreColorsLabel}>更多颜色</Text>
          </View>
        </>
      )}
    </View>
  );
}

function ToolbarAction({
  label,
  visibleLabel,
  Icon,
  selected = false,
  disabled = false,
  onPress,
}: {
  label: string;
  visibleLabel: string;
  Icon: LucideIcon;
  selected?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolbarAction,
        selected && styles.toolSelected,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon size={17} color={selected ? colors.brand : colors.secondary} />
      <Text
        style={[
          styles.toolbarActionLabel,
          selected && styles.toolLabelSelected,
        ]}
      >
        {visibleLabel}
      </Text>
    </Pressable>
  );
}

function ToolButton({
  label,
  Icon,
  selected = false,
  disabled = false,
  onPress,
}: {
  label: string;
  Icon: LucideIcon;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolButton,
        selected && styles.toolSelected,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon size={19} color={selected ? colors.brand : colors.secondary} />
      <Text style={[styles.toolLabel, selected && styles.toolLabelSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

function IconButton({
  label,
  Icon,
  selected = false,
  disabled = false,
  onPress,
}: {
  label: string;
  Icon: LucideIcon;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        selected && styles.toolSelected,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon size={18} color={selected ? colors.brand : colors.secondary} />
    </Pressable>
  );
}

function ModeButton({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}阅读模式`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.modeButton, selected && styles.modeSelected]}
    >
      <Text style={[styles.modeText, selected && styles.modeTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  topBar: {
    minHeight: 64,
    position: "relative",
    zIndex: 10,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  documentIdentity: {
    flex: 1,
    minWidth: 160,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  documentIdentityNarrow: { minWidth: 100 },
  backButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  documentTitleGroup: { minWidth: 0, gap: 1 },
  documentTitle: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  documentSubtitle: { color: colors.muted, fontSize: 11 },
  topControls: { flexDirection: "row", alignItems: "center", gap: 8 },
  pageControls: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 6,
    backgroundColor: "#f7f7f8",
  },
  pageButton: {
    width: 32,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  pageEntryGroup: {
    minWidth: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  pageEntry: {
    minWidth: 24,
    padding: 0,
    textAlign: "right",
    color: colors.ink,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  pageCount: {
    color: colors.secondary,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  modeGroup: {
    flexDirection: "row",
    padding: 3,
    borderRadius: 6,
    backgroundColor: "#f7f7f8",
  },
  modeButton: {
    minWidth: 48,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  modeSelected: {
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
  },
  modeText: { color: colors.secondary, fontSize: 12 },
  modeTextSelected: { color: colors.ink, fontWeight: "600" },
  commandGroup: { flexDirection: "row", alignItems: "center", gap: 2 },
  toolbarAction: {
    width: 56,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    borderRadius: 6,
  },
  toolbarActionLabel: { color: colors.secondary, fontSize: 11, lineHeight: 13 },
  zoomGroup: { flexDirection: "row", alignItems: "center", gap: 2 },
  zoomValue: {
    minWidth: 70,
    textAlign: "center",
    color: colors.secondary,
    fontSize: 12,
  },
  saveStatus: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 4,
    maxWidth: 154,
  },
  saveStatusCopy: { minWidth: 0, gap: 1 },
  saveStatusText: { color: colors.secondary, fontSize: 12, fontWeight: "500" },
  saveStatusDetail: { color: colors.muted, fontSize: 10 },
  moreMenu: {
    position: "absolute",
    zIndex: 20,
    elevation: 8,
    top: 58,
    right: 16,
    width: 252,
    padding: 12,
    gap: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
    shadowColor: "#171721",
    shadowOpacity: 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  moreMenuSection: { gap: 6 },
  moreMenuTitle: { color: colors.secondary, fontSize: 12, fontWeight: "600" },
  moreMenuHint: { color: colors.muted, fontSize: 11 },
  workArea: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
    backgroundColor: colors.canvas,
  },
  toolRail: {
    width: 76,
    marginLeft: 16,
    marginVertical: 14,
    alignSelf: "center",
    paddingVertical: 6,
    alignItems: "center",
    gap: 4,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
    shadowColor: "#171721",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  toolRailCollapsed: { width: 58 },
  toolRailHeader: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  toolRailTitle: { color: colors.secondary, fontSize: 12, fontWeight: "600" },
  toolRailSection: { alignItems: "center", gap: 2 },
  railDivider: {
    width: 38,
    height: 1,
    backgroundColor: colors.line,
    marginVertical: 4,
  },
  widthBadge: {
    minWidth: 44,
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  widthValue: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  widthUnit: { color: colors.muted, fontSize: 10 },
  moreColors: { alignItems: "center", marginTop: 2 },
  moreColorsLabel: { color: colors.muted, fontSize: 10 },
  toolButton: {
    width: 60,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    borderRadius: 10,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  toolSelected: {
    backgroundColor: colors.selected,
    borderWidth: 1,
    borderColor: "#d7cef8",
  },
  toolLabel: { color: colors.secondary, fontSize: 11, lineHeight: 14 },
  toolLabelSelected: { color: colors.brand, fontWeight: "600" },
  colorSection: { alignItems: "center", gap: 2 },
  colorTarget: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "transparent",
  },
  colorTargetSelected: { borderColor: colors.brand },
  colorSwatch: {
    width: 16,
    height: 16,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "#00000018",
  },
  readerColumn: {
    flex: 1,
    minWidth: 0,
    margin: 16,
    marginLeft: 12,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
  },
  pdfStage: { flex: 1, minHeight: 0, backgroundColor: colors.canvas },
  reader: { flex: 1 },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.38 },
  compactTools: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    backgroundColor: colors.paper,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
});
