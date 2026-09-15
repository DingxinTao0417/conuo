import { describe, expect, it } from "vitest";
import { markdownToEditorHtml } from "./markdown";

describe("Markdown answer to editor HTML", () => {
  it("preserves structured learning content instead of saving literal Markdown syntax", () => {
    const html = markdownToEditorHtml(
      `# 学习率\n\n**重点**与*解释*，以及~~旧说法~~。\n\n> 学习率过高可能引起振荡。\n\n- 观察损失\n- 调小步长\n\n3. 保持其他设置不变\n4. 比较曲线\n\n\`\`\`typescript\nconst rate = 0.1;\n\`\`\`\n\n| 参数 | 数值 |\n| --- | ---: |\n| rate | 0.1 |`,
    );
    expect(html).toContain("<h1>学习率</h1>");
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<em>解释</em>");
    expect(html).toContain("<del>旧说法</del>");
    expect(html).toContain("<blockquote>\n<p>学习率过高可能引起振荡。</p>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>观察损失</li>");
    expect(html).toContain('<ol start="3">');
    expect(html).toContain('<pre><code class="language-typescript">const rate = 0.1;');
    expect(html).toContain("<table>");
    expect(html).toContain('<th align="right">数值</th>');
    expect(html).not.toContain("**重点**");
  });

  it("drops raw HTML, scripts, event handlers and executable embedded elements", () => {
    const html = markdownToEditorHtml(
      `<script>alert("x")</script>\n\n<img src="https://tracker.example/pixel" onerror="alert(1)">\n\n<iframe src="https://tracker.example/frame"></iframe>\n\n普通<span onclick="alert(1)">文字</span>与 **重点**。`,
    );
    expect(html).not.toMatch(/<script|<img|<iframe|onclick|onerror|tracker\.example|alert\(/i);
    expect(html).toContain("普通文字与 <strong>重点</strong>。");
  });

  it.each([
    "[危险](javascript:alert%281%29)",
    "[危险](JaVaScRiPt:alert%281%29)",
    "[危险](javascript&#58;alert%281%29)",
    "[危险](java&#x09;script:alert%281%29)",
    "[危险](java%73cript%3Aalert%281%29)",
    "[危险](data:text/html;base64,PHNjcmlwdD4=)",
    "[危险](vbscript:msgbox%281%29)",
    "[危险][ref]\n\n[ref]: javascript:alert%281%29",
  ])("removes a dangerous destination while preserving its label: %s", (markdown) => {
    const html = markdownToEditorHtml(markdown);
    expect(html).toContain("危险");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<a");
  });

  it("preserves ordinary links, fragments and relative paths", () => {
    const html = markdownToEditorHtml(
      '[资料](https://example.com/article?a=1&b=2 "阅读资料")、[邮箱](mailto:hello@example.com)、[章节](#chapter)、[站内](/notes/one)',
    );
    expect(html).toContain('href="https://example.com/article?a=1&#x26;b=2"');
    expect(html).toContain('title="阅读资料"');
    expect(html).toContain('href="mailto:hello@example.com"');
    expect(html).toContain('href="#chapter"');
    expect(html).toContain('href="/notes/one"');
  });

  it("renders image descriptions as text without issuing remote or data image loads", () => {
    const html = markdownToEditorHtml(
      "![学习曲线](https://tracker.example/pixel.png)\n\n![参考图][picture]\n\n![](data:image/svg+xml;base64,PHN2Zz4=)\n\n[picture]: https://tracker.example/second.png",
    );
    expect(html).toContain("学习曲线");
    expect(html).toContain("参考图");
    expect(html).toContain("[图片]");
    expect(html).not.toMatch(/<img|src=|tracker\.example|data:image/i);
  });

  it("keeps code examples inert even when the example contains script syntax", () => {
    const html = markdownToEditorHtml(
      '代码：`<img src=x onerror=alert(1)>`\n\n```html\n<script>alert("example")</script>\n```',
    );
    expect(html).toContain("<code>&#x3C;img");
    expect(html).toContain("&#x3C;script>");
    expect(html).not.toMatch(/<img|<script/i);
  });

  it("handles empty content and repeated calls without leaking processor state", () => {
    expect(markdownToEditorHtml("")).toBe("");
    expect(markdownToEditorHtml("**一次**")).toBe("<p><strong>一次</strong></p>");
    expect(markdownToEditorHtml("第二次")).toBe("<p>第二次</p>");
  });
});
