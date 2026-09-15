import type { Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { markdownToEditorHtml } from "./markdown";
import { renderNoteForExport } from "./note-markdown";

const parser = unified().use(remarkParse).use(remarkGfm);
function parse(content: string): Root {
  return parser.parse(content);
}
function nodes(tree: Root | RootContent, type: string): RootContent[] {
  const matches: RootContent[] = tree.type === type && tree.type !== "root" ? [tree] : [];
  if ("children" in tree) for (const child of tree.children) matches.push(...nodes(child, type));
  return matches;
}
function plain(node: Root | RootContent): string {
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map(plain).join("") : "";
}

describe("portable rich-text Markdown", () => {
  it("preserves title, heading, paragraphs, emphasis, deletion, and explicit line breaks", () => {
    const result = renderNoteForExport(
      "*literal* [title]\nnext",
      "<h2>学习目标</h2><p><strong>重点</strong>和<em>说明</em><s>旧观点</s><br>第二行</p><hr><p>新段落</p>",
    );
    const tree = parse(result.markdown);
    expect(result.originalFormat).toBe("html");
    expect(plain(tree.children[0])).toBe("*literal* [title] next");
    expect(nodes(tree.children[0], "emphasis")).toHaveLength(0);
    expect(nodes(tree, "heading").map(plain)).toEqual(["*literal* [title] next", "学习目标"]);
    expect(nodes(tree, "strong").map(plain)).toEqual(["重点"]);
    expect(nodes(tree, "emphasis").map(plain)).toEqual(["说明"]);
    expect(nodes(tree, "delete").map(plain)).toEqual(["旧观点"]);
    expect(nodes(tree, "break")).toHaveLength(1);
    expect(nodes(tree, "thematicBreak")).toHaveLength(1);
  });

  it("retains ordered starts, nested list structure, multi-paragraph items and blockquotes", () => {
    const result = renderNoteForExport(
      "结构",
      '<ol start="3"><li><p>第三项</p><p>补充</p><ul><li><p>子项</p><ol start="7"><li><p>深层</p></li></ol></li></ul></li><li><p>第四项</p></li></ol><blockquote><p>引用</p><blockquote><p>内层引用</p></blockquote></blockquote>',
    );
    const tree = parse(result.markdown);
    const lists = nodes(tree, "list");
    expect(lists).toHaveLength(3);
    expect(lists[0]).toMatchObject({ ordered: true, start: 3 });
    expect(lists[1]).toMatchObject({ ordered: false });
    expect(lists[2]).toMatchObject({ ordered: true, start: 7 });
    expect(nodes(tree, "listItem")).toHaveLength(4);
    expect(nodes(tree, "blockquote")).toHaveLength(2);
    expect(plain(tree)).toContain("第三项补充子项深层第四项");
  });

  it("round-trips literal Markdown punctuation and code containing fences and HTML", () => {
    const body = '# not a heading\n```\nconst a = "<script> & `code`";\n```';
    const result = renderNoteForExport(
      "代码",
      '<p>*literal* [link](javascript:alert) # title ![image](x) &amp; &lt;script&gt;</p><p><code>a`b &lt;c&gt;</code></p><pre><code class="language-typescript">' +
        body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") +
        "</code></pre>",
    );
    const tree = parse(result.markdown);
    expect(nodes(tree, "code")).toEqual([
      expect.objectContaining({ lang: "typescript", value: body }),
    ]);
    expect(nodes(tree, "inlineCode")).toEqual([expect.objectContaining({ value: "a`b <c>" })]);
    expect(nodes(tree, "link")).toHaveLength(0);
    expect(nodes(tree, "image")).toHaveLength(0);
    expect(nodes(tree, "html")).toHaveLength(0);
    expect(plain(tree)).toContain(
      "*literal* [link](javascript:alert) # title ![image](x) & <script>",
    );
  });

  it("keeps valid links and titles, including escaped parentheses and anchors", () => {
    const result = renderNoteForExport(
      "链接",
      '<p><a href="https://example.org/a(b)?x=1&amp;y=2" title="说明 &quot;引号&quot;">链接 [标签]</a> <a href="#local">本节</a> <a href="mailto:reader@example.org">邮箱</a></p>',
    );
    const links = nodes(parse(result.markdown), "link");
    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({
      url: "https://example.org/a(b)?x=1&y=2",
      title: '说明 "引号"',
    });
    expect(plain(links[0])).toBe("链接 [标签]");
    expect(links[1]).toMatchObject({ url: "#local" });
    expect(links[2]).toMatchObject({ url: "mailto:reader@example.org" });
  });

  it("preserves GFM table alignment, cell pipes, code and multiple lines", () => {
    const result = renderNoteForExport(
      "表格",
      '<table><thead><tr><th align="left"><p>定义</p></th><th align="right">值</th></tr></thead><tbody><tr><td><p>A | B<br>下一行</p></td><td><p><code>x|y</code></p></td></tr></tbody></table>',
    );
    const tables = nodes(parse(result.markdown), "table");
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({ align: ["left", "right"] });
    const cells = nodes(tables[0], "tableCell");
    expect(cells).toHaveLength(4);
    expect(plain(cells[2])).toBe("A | B<br>下一行");
    expect(nodes(cells[3], "inlineCode")).toEqual([expect.objectContaining({ value: "x|y" })]);
  });

  it("does not lose the first data row in a table without headers or merged-cell content", () => {
    const result = renderNoteForExport(
      "数据",
      '<table><tr><td colspan="2">合并文字</td></tr><tr><td>第一列</td><td>第二列</td></tr></table>',
    );
    const rows = nodes(parse(result.markdown), "tableRow");
    expect(rows).toHaveLength(3);
    expect(plain(rows[1])).toBe("合并文字");
    expect(nodes(rows[1], "tableCell")).toHaveLength(2);
    expect(plain(rows[2])).toBe("第一列第二列");
  });

  it("removes executable markup, tracking images and obfuscated unsafe URL schemes", () => {
    const result = renderNoteForExport(
      "<img src=x onerror=alert(1)>",
      '<p onclick="evil()">正文<script>alert(1)</script><style>hidden</style><iframe src="https://tracker.invalid">frame</iframe><svg><script>svg</script></svg><img src="https://tracker.invalid/a" alt="图示"></p><p><a href="java&#x09;script:alert(1)">危险一</a><a href="&#106;avascript:alert(2)">危险二</a><a href="%6a%61vascript:alert(3)">危险三</a><a href="data:text/html,script">危险四</a><a href="vbscript:alert(1)">危险五</a></p>',
    );
    const tree = parse(result.markdown);
    expect(nodes(tree, "link")).toHaveLength(0);
    expect(nodes(tree, "image")).toHaveLength(0);
    expect(nodes(tree, "html")).toHaveLength(0);
    expect(plain(tree)).toContain("正文图示危险一危险二危险三危险四危险五");
    expect(result.htmlBody).not.toMatch(/script|onclick|iframe|tracker|<img|<svg|<style/i);
    expect(markdownToEditorHtml(result.markdown)).not.toMatch(/<img|<script|onclick=/i);
  });

  it("uses parsed Markdown for legacy notes, retaining autolinks and fenced code", () => {
    const result = renderNoteForExport(
      "旧笔记",
      "**重点**\n\n<https://example.org>\n\n```html\n<p>Literal code</p>\n```\n\n[bad](javascript:alert)",
    );
    const tree = parse(result.markdown);
    expect(result.originalFormat).toBe("markdown");
    expect(nodes(tree, "strong").map(plain)).toEqual(["重点"]);
    expect(nodes(tree, "link")).toEqual([expect.objectContaining({ url: "https://example.org" })]);
    expect(nodes(tree, "code")).toEqual([
      expect.objectContaining({ lang: "html", value: "<p>Literal code</p>" }),
    ]);
  });

  it("does not misclassify a legacy Markdown code example as rich text", () => {
    const result = renderNoteForExport(
      "例子",
      "## HTML 示例\n\n```html\n<p>Literal content</p>\n```",
    );
    expect(result.originalFormat).toBe("markdown");
    expect(nodes(parse(result.markdown), "code")).toEqual([
      expect.objectContaining({ lang: "html", value: "<p>Literal content</p>" }),
    ]);
  });

  it("includes exact citation identifiers and quote text without treating source text as Markdown", () => {
    const result = renderNoteForExport("笔记", "<p>总结 [1]</p>", [
      {
        title: "资料 [1]",
        quote: "*原话* <script>alert(1)</script>",
        sourceId: "s-1",
        versionId: "v-1",
        chunkId: "c-1",
        page: 2,
        section: "第一节",
        metadataPath: "../../sources/s-1/metadata.json",
      },
    ]);
    const tree = parse(result.markdown);
    expect(nodes(tree, "link")).toEqual([
      expect.objectContaining({ url: "../../sources/s-1/metadata.json" }),
    ]);
    expect(nodes(tree, "inlineCode").map(plain)).toEqual(["s-1", "v-1", "c-1"]);
    expect(plain(nodes(tree, "blockquote")[0])).toBe("*原话* <script>alert(1)</script>");
    expect(nodes(tree, "html")).toHaveLength(0);
  });
});
