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
import { colors as c } from "../theme";

export type PdfPagesPanelProps = {
  visible: boolean;
  pageCount: number;
  currentPage: number;
  /** Base64 JPEG per 1-based page; empty string draws a blank page card. */
  thumbnails: string[];
  onSelectPage: (page: number) => void;
  onClose: () => void;
};

/** Left page overview rail (GoodNotes-style “所有页面”, placed on the left). */
export default function PdfPagesPanel({
  visible,
  pageCount,
  currentPage,
  thumbnails,
  onSelectPage,
  onClose,
}: PdfPagesPanelProps) {
  const [query, setQuery] = useState("");
  const pages = useMemo(() => {
    const all = Array.from({ length: Math.max(0, pageCount) }, (_, index) => index + 1);
    const needle = query.trim();
    if (!needle) return all;
    return all.filter((page) => String(page).includes(needle));
  }, [pageCount, query]);

  if (!visible) return null;

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
      <TextInput
        accessibilityLabel="搜索页码"
        value={query}
        onChangeText={setQuery}
        placeholder="搜索"
        placeholderTextColor={c.muted}
        style={g.search}
        keyboardType="number-pad"
        clearButtonMode="while-editing"
      />
      <FlatList
        data={pages}
        keyExtractor={(page) => String(page)}
        contentContainerStyle={g.list}
        style={g.listClip}
        initialNumToRender={8}
        windowSize={7}
        renderItem={({ item: page }) => {
          const active = page === currentPage;
          const thumb = thumbnails[page - 1];
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`第 ${page} 页`}
              accessibilityState={{ selected: active }}
              onPress={() => onSelectPage(page)}
              style={g.card}
            >
              {thumb ? (
                <Image
                  source={{ uri: `data:image/jpeg;base64,${thumb}` }}
                  style={[g.thumb, active && g.thumbActive]}
                  resizeMode="cover"
                />
              ) : (
                <View style={[g.thumb, g.thumbBlank, active && g.thumbActive]} />
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
    paddingBottom: 8,
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
  search: {
    marginHorizontal: 10,
    marginBottom: 8,
    paddingHorizontal: 10,
    height: 34,
    borderRadius: 8,
    backgroundColor: c.canvas,
    borderWidth: 1,
    borderColor: c.line,
    fontSize: 13,
    color: c.ink,
  },
  listClip: { flex: 1 },
  list: { paddingHorizontal: 10, paddingBottom: 16, gap: 12 },
  card: {
    alignItems: "center",
    gap: 4,
  },
  thumb: {
    width: "100%",
    aspectRatio: 0.72,
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
