import React, { useMemo, useState } from "react";
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { colors as c } from "../theme";
import type { PdfPageThumb } from "../../modules/conuo-pdf-ink";

export type PdfPagesPanelProps = {
  visible: boolean;
  pageCount: number;
  currentPage: number;
  pages: PdfPageThumb[];
  onSelectPage: (page: number) => void;
  onClose: () => void;
};

/** Left page overview rail: page jump, current/total, spaced landscape-aware thumbs. */
export default function PdfPagesPanel({
  visible,
  pageCount,
  currentPage,
  pages: thumbs,
  onSelectPage,
  onClose,
}: PdfPagesPanelProps) {
  const [jump, setJump] = useState("");
  const items = useMemo(
    () => Array.from({ length: Math.max(0, pageCount) }, (_, index) => index + 1),
    [pageCount],
  );

  if (!visible) return null;

  const commitJump = () => {
    const parsed = Number.parseInt(jump.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > pageCount) return;
    onSelectPage(parsed);
    setJump("");
  };

  return (
    <View style={g.panel}>
      <View style={g.header}>
        <Text style={g.title}>所有页面</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭页面列表"
          onPress={onClose}
          style={g.close}
        >
          <Text style={g.closeText}>×</Text>
        </Pressable>
      </View>
      <View style={g.jumpRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="上一页"
          disabled={currentPage <= 1}
          onPress={() => onSelectPage(currentPage - 1)}
          style={[g.step, currentPage <= 1 && g.stepOff]}
        >
          <ChevronLeft size={16} color={c.secondary} />
        </Pressable>
        <TextInput
          accessibilityLabel="跳至页码"
          value={jump}
          onChangeText={setJump}
          onSubmitEditing={commitJump}
          onBlur={commitJump}
          placeholder={String(currentPage)}
          placeholderTextColor={c.muted}
          keyboardType="number-pad"
          returnKeyType="go"
          selectTextOnFocus
          style={g.jumpInput}
        />
        <Text style={g.pageCount}>/ {pageCount || "—"}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="下一页"
          disabled={pageCount > 0 && currentPage >= pageCount}
          onPress={() => onSelectPage(currentPage + 1)}
          style={[g.step, pageCount > 0 && currentPage >= pageCount && g.stepOff]}
        >
          <ChevronRight size={16} color={c.secondary} />
        </Pressable>
      </View>
      <FlatList
        data={items}
        keyExtractor={(page) => String(page)}
        contentContainerStyle={g.list}
        style={g.listClip}
        initialNumToRender={6}
        windowSize={7}
        ItemSeparatorComponent={() => <View style={g.gap} />}
        renderItem={({ item: page }) => {
          const active = page === currentPage;
          const thumb = thumbs[page - 1];
          const ratio =
            thumb && thumb.aspectRatio > 0.15 ? thumb.aspectRatio : 0.72;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`第 ${page} 页`}
              accessibilityState={{ selected: active }}
              onPress={() => onSelectPage(page)}
              style={g.card}
            >
              {thumb?.jpeg ? (
                <Image
                  source={{ uri: `data:image/jpeg;base64,${thumb.jpeg}` }}
                  style={[
                    { aspectRatio: ratio },
                    g.thumb,
                    active && g.thumbActive,
                  ]}
                  resizeMode="cover"
                />
              ) : (
                <View
                  style={[
                    { aspectRatio: ratio },
                    g.thumb,
                    g.thumbBlank,
                    active && g.thumbActive,
                  ]}
                />
              )}
              <Text style={[g.page, active && g.pageActive]}>{page}</Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const g = StyleSheet.create({
  panel: {
    width: 196,
    backgroundColor: c.white,
    borderRightWidth: 1,
    borderRightColor: c.line,
    paddingTop: 10,
  },
  header: {
    paddingHorizontal: 12,
    paddingBottom: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { fontSize: 13, fontWeight: "600", color: c.ink },
  close: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  closeText: { fontSize: 20, color: c.muted, lineHeight: 22 },
  jumpRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    marginBottom: 10,
  },
  step: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  stepOff: { opacity: 0.3 },
  jumpInput: {
    width: 48,
    height: 30,
    paddingHorizontal: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.canvas,
    fontSize: 13,
    color: c.ink,
    textAlign: "center",
  },
  pageCount: {
    flex: 1,
    fontSize: 12,
    color: c.secondary,
    fontVariant: ["tabular-nums"],
  },
  listClip: { flex: 1 },
  list: { paddingHorizontal: 10, paddingBottom: 16 },
  gap: { height: 10 },
  card: {
    alignItems: "center",
    gap: 4,
  },
  thumb: {
    width: "100%",
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "transparent",
    backgroundColor: c.canvas,
  },
  thumbBlank: {
    borderColor: c.line,
    borderStyle: "solid",
  },
  thumbActive: {
    borderColor: c.brand,
  },
  page: { fontSize: 11, color: c.secondary },
  pageActive: { color: c.brand, fontWeight: "600" },
});
