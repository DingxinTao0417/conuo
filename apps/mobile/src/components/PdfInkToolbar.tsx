import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Eraser, Minus, Pencil, Plus, Redo2, Undo2 } from "lucide-react-native";
import type { InkTool } from "../../modules/conuo-pdf-ink";
import { colors as c } from "../theme";

export type PdfInkToolsState = {
  tool: InkTool;
  setTool: (tool: InkTool) => void;
  zoomStep: number;
  zoomIn: () => void;
  zoomOut: () => void;
  undoToken: number;
  redoToken: number;
  undo: () => void;
  redo: () => void;
};

/** Double-tap eraser ↔ last pen; also used by the native Pencil interaction. */
export function toggleEraserTool(tool: InkTool, lastInkTool: InkTool): InkTool {
  if (tool === "eraser") return lastInkTool === "eraser" ? "pen" : lastInkTool;
  return "eraser";
}

function ToolButton({
  label,
  active = false,
  onPress,
  children,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[t.tool, active && t.toolActive]}
    >
      {children}
    </Pressable>
  );
}

/** Centered brush controls for the document title bar. */
export default function PdfInkToolbar({ tools }: { tools: PdfInkToolsState }) {
  return (
    <View style={t.bar}>
      <ToolButton label="钢笔" active={tools.tool === "pen"} onPress={() => tools.setTool("pen")}>
        <Pencil size={16} color={tools.tool === "pen" ? c.brand : c.secondary} />
      </ToolButton>
      <ToolButton
        label="铅笔"
        active={tools.tool === "pencil"}
        onPress={() => tools.setTool("pencil")}
      >
        <Pencil size={16} color={tools.tool === "pencil" ? c.brand : c.secondary} />
      </ToolButton>
      <ToolButton
        label="橡皮擦"
        active={tools.tool === "eraser"}
        onPress={() => tools.setTool("eraser")}
      >
        <Eraser size={16} color={tools.tool === "eraser" ? c.brand : c.secondary} />
      </ToolButton>
      <View style={t.divider} />
      <ToolButton label="撤销" onPress={tools.undo}>
        <Undo2 size={16} color={c.secondary} />
      </ToolButton>
      <ToolButton label="重做" onPress={tools.redo}>
        <Redo2 size={16} color={c.secondary} />
      </ToolButton>
      <View style={t.divider} />
      <ToolButton label="缩小" onPress={tools.zoomOut}>
        <Minus size={16} color={c.secondary} />
      </ToolButton>
      <ToolButton label="放大" onPress={tools.zoomIn}>
        <Plus size={16} color={c.secondary} />
      </ToolButton>
    </View>
  );
}

const t = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 4,
  },
  tool: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  toolActive: { backgroundColor: c.purple },
  divider: { width: 1, height: 18, backgroundColor: c.line, marginHorizontal: 3 },
});
