import React, { useMemo, useState, type ReactNode } from "react";
import {
  Platform,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type TextProps,
} from "react-native";
import Markdown, {
  MarkdownIt,
  renderRules,
  type ASTNode,
  type RenderFunction,
  type RenderRules,
} from "react-native-markdown-display";
import { colors as c, styles as s } from "../theme";

function columnCount(node: ASTNode): number {
  if (node.type === "tr") return node.children.length;
  return Math.max(1, ...node.children.map(columnCount));
}

function MarkdownTable({
  node,
  children,
  fontSize,
  label,
}: {
  node: ASTNode;
  children: ReactNode;
  fontSize: number;
  label: string;
}) {
  const [availableWidth, setAvailableWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  const minimumWidth =
    columnCount(node) *
    144 *
    Math.max(1, fontScale) *
    Math.max(1, fontSize / 15);
  const overflow = availableWidth > 0 && minimumWidth > availableWidth;
  return (
    <View
      style={{ width: "100%", marginVertical: 8, gap: 6 }}
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
    >
      {overflow && (
        <Text style={s.caption}>表格较宽，可左右滑动查看全部列</Text>
      )}
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        accessibilityLabel={label}
        accessibilityHint={overflow ? "左右滑动查看其余列" : undefined}
        style={{ borderWidth: 1, borderColor: c.line, borderRadius: 8 }}
      >
        <View style={{ width: Math.max(availableWidth - 2, minimumWidth) }}>
          {children}
        </View>
      </ScrollView>
    </View>
  );
}

// Preserve the library's inherited inline styles while keeping native text selection.
const selectableRules: RenderRules = {};
for (const name of [
  "text",
  "textgroup",
  "strong",
  "em",
  "s",
  "link",
  "code_inline",
  "code_block",
  "fence",
  "hardbreak",
  "softbreak",
  "inline",
  "span",
]) {
  const selectableRule: RenderFunction = (...args) => {
    const element = renderRules[name]?.(...args);
    return React.isValidElement<TextProps>(element)
      ? React.cloneElement(element, { selectable: true })
      : element;
  };
  selectableRules[name] = selectableRule;
}
const markdownParser = MarkdownIt({ typographer: false, html: false });

type MarkdownContentProps = {
  children: string;
  fontSize?: number;
  lineHeight?: number;
  color?: string;
  tableLabel?: string;
};

/** Shared presentation only: source text, chunks, and citation identity stay untouched. */
export const MarkdownContent = React.memo(function MarkdownContent({
  children,
  fontSize = 15,
  lineHeight = 25,
  color = c.ink,
  tableLabel = "回答表格",
}: MarkdownContentProps) {
  const rules = useMemo<RenderRules>(
    () => ({
      ...selectableRules,
      image: () => null,
      table: (node, content) => (
        <MarkdownTable
          key={node.key}
          node={node}
          fontSize={fontSize}
          label={tableLabel}
        >
          {content}
        </MarkdownTable>
      ),
    }),
    [fontSize, tableLabel],
  );
  return (
    <Markdown
      markdownit={markdownParser}
      rules={rules}
      onLinkPress={() => false}
      style={{
        body: { color, fontSize, lineHeight },
        heading1: {
          fontSize: Math.round(fontSize * 1.53),
          lineHeight: Math.round(lineHeight * 1.28),
          fontWeight: "600",
          marginVertical: 12,
        },
        heading2: {
          fontSize: Math.round(fontSize * 1.33),
          lineHeight: Math.round(lineHeight * 1.16),
          fontWeight: "600",
          marginVertical: 12,
        },
        heading3: {
          fontSize: Math.round(fontSize * 1.13),
          lineHeight: Math.round(lineHeight * 1.04),
          fontWeight: "600",
          marginVertical: 10,
        },
        heading4: {
          fontSize,
          lineHeight,
          fontWeight: "600",
          marginVertical: 10,
        },
        heading5: {
          fontSize,
          lineHeight,
          fontWeight: "600",
          marginVertical: 8,
        },
        heading6: {
          fontSize,
          lineHeight,
          fontWeight: "600",
          marginVertical: 8,
        },
        thead: { backgroundColor: c.canvas },
        tr: { borderColor: c.line, borderBottomWidth: 1 },
        th: { padding: 12 },
        td: { padding: 12 },
        blockquote: {
          backgroundColor: c.canvas,
          borderColor: c.brand,
          borderLeftWidth: 3,
          paddingHorizontal: 12,
        },
        code_inline: { backgroundColor: c.purple, borderColor: c.line },
        fence: {
          backgroundColor: c.canvas,
          borderColor: c.line,
          borderRadius: 8,
          padding: 12,
          fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
        },
      }}
    >
      {children}
    </Markdown>
  );
});

export default MarkdownContent;
