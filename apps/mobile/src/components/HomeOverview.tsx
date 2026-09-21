import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  ArrowRight,
  BookOpen,
  Bookmark,
  ChevronRight,
  Link2,
  PenLine,
  Plus,
} from "lucide-react-native";
import type { Source, Workspace } from "../core/contracts";
import { colors as c, styles as s } from "../theme";

type Props = {
  workspace: Workspace;
  onOpenSource: (source: Source) => void;
  onOpenLibrary: (spaceId?: string) => void;
  onCreateNote: () => void;
  onImport: () => void;
  onCreateSpace: () => void;
  creatingSpace: boolean;
  renderSource: (source: Source) => React.ReactNode;
};

const palettes = [
  { background: c.purple, ink: "#5948a6" },
  { background: c.green, ink: "#287b69" },
  { background: c.blue, ink: "#396bb8" },
  { background: c.peach, ink: "#926127" },
];
function palette(id: string) {
  let hash = 0;
  for (const character of id)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return palettes[hash % palettes.length];
}

export default function HomeOverview(props: Props) {
  const spaces = props.workspace.spaces.filter((space) => !space.archived);
  const sources = props.workspace.sources.filter((source) => !source.deletedAt);
  const recent = [...sources].sort((a, b) =>
    (b.lastReadAt ?? b.updatedAt).localeCompare(a.lastReadAt ?? a.updatedAt),
  );
  const featured = recent.find(
    (source) =>
      ["ready", "partial"].includes(source.status) && source.text.trim(),
  );
  const others = recent
    .filter((source) => source.id !== featured?.id)
    .slice(0, 3);
  const inboxCount = sources.filter(
    (source) => source.spaceIds.length === 0,
  ).length;

  return (
    <View style={h.stack}>
      <View style={h.quickActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="添加网页资料"
          onPress={props.onImport}
          style={({ pressed }) => [h.quickAction, pressed && h.pressed]}
        >
          <View style={[h.actionIcon, { backgroundColor: c.blue }]}>
            <Link2 size={19} color="#396bb8" />
          </View>
          <Text style={h.actionText}>添加网页</Text>
          <Plus size={16} color={c.secondary} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            spaces.length ? "写一篇笔记" : "创建学习空间后写笔记"
          }
          onPress={spaces.length ? props.onCreateNote : props.onCreateSpace}
          disabled={props.creatingSpace}
          style={({ pressed }) => [
            h.quickAction,
            pressed && h.pressed,
            props.creatingSpace && { opacity: 0.5 },
          ]}
        >
          <View style={[h.actionIcon, { backgroundColor: c.green }]}>
            <PenLine size={19} color="#287b69" />
          </View>
          <Text style={h.actionText}>
            {spaces.length
              ? "写笔记"
              : props.creatingSpace
                ? "创建中…"
                : "建学习空间"}
          </Text>
        </Pressable>
      </View>

      {featured ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`继续阅读 ${featured.title}`}
          onPress={() => props.onOpenSource(featured)}
          style={({ pressed }) => [
            h.continueCard,
            pressed && { backgroundColor: "#e5dff8" },
          ]}
        >
          <View style={s.row}>
            <Bookmark size={16} color={c.brand} />
            <Text style={h.kicker}>
              {featured.lastReadAt ? "继续学习" : "从这份资料开始"}
            </Text>
          </View>
          <Text style={h.continueTitle} numberOfLines={3}>
            {featured.title}
          </Text>
          <View style={s.spread}>
            <Text
              style={[s.caption, { flex: 1, color: "#655886" }]}
              numberOfLines={2}
            >
              {spaces.find((space) => featured.spaceIds.includes(space.id))
                ?.name ?? "收件箱"}{" "}
              · {featured.status === "partial" ? "部分正文" : "正文已就绪"}
            </Text>
            <View style={h.continueAction}>
              <Text style={h.continueActionText}>继续阅读</Text>
              <ArrowRight size={16} color={c.brand} />
            </View>
          </View>
        </Pressable>
      ) : (
        <View style={h.continueCard}>
          <View style={s.row}>
            <BookOpen size={20} color={c.brand} />
            <Text style={h.kicker}>你的学习，从这里开始</Text>
          </View>
          <Text style={h.continueTitle}>留下一篇想读的文章。</Text>
          <Text style={s.secondary}>
            添加网页后，可以阅读正文、提出问题，再写下自己的理解。
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={props.onImport}
            style={({ pressed }) => [s.button, pressed && h.pressed]}
          >
            <Text style={s.buttonText}>添加第一份资料</Text>
            <ArrowRight size={17} color="white" />
          </Pressable>
        </View>
      )}

      <View style={{ gap: 10 }}>
        <View style={s.spread}>
          <Text accessibilityRole="header" style={s.section}>
            我的知识库
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="查看全部资料"
            onPress={() => props.onOpenLibrary()}
            style={h.textAction}
          >
            <Text style={h.textActionLabel}>全部资料</Text>
            <ChevronRight size={15} color={c.secondary} />
          </Pressable>
        </View>
        {spaces.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 10, paddingBottom: 2 }}
          >
            {spaces.map((space) => {
              const color = palette(space.id);
              return (
                <Pressable
                  key={space.id}
                  accessibilityRole="button"
                  accessibilityLabel={`打开知识库 ${space.name}`}
                  onPress={() => props.onOpenLibrary(space.id)}
                  style={({ pressed }) => [
                    h.libraryCard,
                    { backgroundColor: color.background },
                    pressed && h.pressed,
                  ]}
                >
                  <BookOpen size={20} color={color.ink} />
                  <Text numberOfLines={2} style={h.libraryTitle}>
                    {space.name}
                  </Text>
                  <Text style={s.caption}>
                    {
                      sources.filter((source) =>
                        source.spaceIds.includes(space.id),
                      ).length
                    }{" "}
                    份资料
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={props.creatingSpace}
            onPress={props.onCreateSpace}
            style={({ pressed }) => [h.emptyLibrary, pressed && h.pressed]}
          >
            <Plus size={20} color={c.brand} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.body}>
                {props.creatingSpace
                  ? "正在创建学习空间…"
                  : "建立第一个学习空间"}
              </Text>
              <Text style={s.caption}>把同一主题的资料放在一起。</Text>
            </View>
            <ChevronRight size={17} color={c.muted} />
          </Pressable>
        )}
        {inboxCount > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`打开收件箱，${inboxCount} 份资料`}
            onPress={() => props.onOpenLibrary("inbox")}
            style={({ pressed }) => [h.inbox, pressed && h.pressed]}
          >
            <Text style={s.secondary}>
              收件箱 · {inboxCount} 份尚未归入知识库的资料
            </Text>
            <ChevronRight size={17} color={c.secondary} />
          </Pressable>
        )}
      </View>

      {!!others.length && (
        <View>
          <Text accessibilityRole="header" style={s.section}>
            最近添加与阅读
          </Text>
          {others.map(props.renderSource)}
        </View>
      )}
      <View style={h.notePrompt}>
        <PenLine size={20} color="#287b69" />
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={[s.body, { fontWeight: "500" }]}>
            读过之后，留下一点理解。
          </Text>
          <Text style={s.caption}>一个新想法，或一个还想追问的问题。</Text>
        </View>
      </View>
    </View>
  );
}

const h = StyleSheet.create({
  stack: { gap: 22 },
  quickActions: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  quickAction: {
    flex: 1,
    minWidth: 120,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: c.white,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 12,
    padding: 10,
  },
  actionIcon: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  actionText: { flex: 1, fontSize: 14, fontWeight: "500", color: c.ink },
  pressed: { opacity: 0.75 },
  continueCard: {
    backgroundColor: c.purple,
    borderWidth: 1,
    borderColor: "#e0d9f7",
    borderRadius: 16,
    padding: 20,
    gap: 14,
  },
  kicker: { fontSize: 13, fontWeight: "500", color: "#5948a6" },
  continueTitle: {
    fontSize: 23,
    fontWeight: "600",
    lineHeight: 32,
    letterSpacing: -0.3,
    color: "#393175",
  },
  continueAction: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    gap: 7,
  },
  continueActionText: { fontSize: 13, fontWeight: "600", color: c.brand },
  textAction: {
    flexDirection: "row",
    minHeight: 44,
    alignItems: "center",
    gap: 3,
  },
  textActionLabel: { fontSize: 13, color: c.secondary },
  libraryCard: {
    width: 150,
    minHeight: 130,
    padding: 16,
    borderRadius: 12,
    justifyContent: "space-between",
    gap: 10,
  },
  libraryTitle: {
    fontSize: 16,
    lineHeight: 23,
    fontWeight: "600",
    color: c.ink,
  },
  emptyLibrary: {
    paddingVertical: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  inbox: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  notePrompt: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: c.green,
    borderRadius: 12,
    padding: 16,
  },
});
