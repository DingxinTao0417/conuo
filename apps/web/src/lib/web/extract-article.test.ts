import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { getGlobalDispatcher } from "undici";
import { extractArticle } from "./extract-article";

const url = "https://example.test/lessons/chapter-one";
const chinese =
  "学习新概念时，可以先阅读定义，再用具体例子检验自己的理解。记录疑问和原文出处能够帮助之后复习。不要把一个例子当作全部结论，还需要核对适用条件以及不同材料给出的限制。";
const english =
  "Reading a definition is only the beginning of learning. A concrete example helps readers test their understanding, while a counterexample exposes the limits of a claim. Keep the source and the relevant conditions beside each observation for later review.";
const page = (content: string, head = "<title>学习笔记</title>") =>
  `<!doctype html><html><head>${head}</head><body><main><article>${content}</article></main></body></html>`;
const paragraphs = `<p>${chinese.repeat(3)}</p><p>${english}</p>`;

afterEach(() => vi.restoreAllMocks());

describe("extractArticle", () => {
  it.each([chinese.repeat(3), english])(
    "extracts authored Chinese and English paragraphs without requiring a network",
    (content) => {
      const result = extractArticle(page(`<p>${content}</p>`), url);
      expect(result.kind).toBe("article");
      expect(result.text).toContain(content);
      expect(result.title).toBe("学习笔记");
      expect(result.warnings).toContain("提取内容可能不含图片、嵌入或动态区块，请核对正文。");
      expect(result).not.toHaveProperty("html");
    },
  );

  it("keeps paragraph, heading and list boundaries for later section-aware chunks", () => {
    const result = extractArticle(
      page(
        `<h1>学习笔记</h1>${paragraphs}<h2>检查理解</h2><p>${chinese.repeat(2)}</p><ul><li>写下例子</li><li>核对条件</li></ul><h3>继续复习</h3><ol start="3"><li>返回原文</li><li>记录疑问</li></ol>`,
      ),
      url,
    );
    expect(result.kind).toBe("article");
    expect(result.text).toContain("\n\n## 检查理解\n\n");
    expect(result.text).toContain("- 写下例子\n\n- 核对条件");
    expect(result.text).toContain("### 继续复习");
    expect(result.text).toContain("3. 返回原文");
    expect(result.text).toContain("4. 记录疑问");
    expect(result.text).not.toMatch(/<\/?(?:p|h\d|li|ul|ol)\b/);
  });

  it("removes scripts, forms, hidden controls and navigation instead of leaking their text", () => {
    const bad = [
      "script",
      "style",
      "template",
      "noscript",
      "form",
      "iframe",
      "nav",
      "aside",
      "footer",
      "svg",
      "canvas",
      "textarea",
    ]
      .map((tag) => `<${tag}>PRIVATE_${tag} ${english.repeat(2)}</${tag}>`)
      .join("");
    const result = extractArticle(
      page(
        `${paragraphs}${bad}<p hidden>PRIVATE_hidden</p><p aria-hidden="true">PRIVATE_aria</p><p style="display: none !important">PRIVATE_display</p><div style="visibility:hidden">PRIVATE_visibility</div><div role="navigation">PRIVATE_navrole</div>`,
      ),
      url,
    );
    expect(result.kind).toBe("article");
    expect(result.text).toContain(chinese);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it.each([
    ["登录", '<form><input type="password"><p>请登录后阅读</p></form>'],
    ["Verify you are human", `<p>${english.repeat(2)}</p>`],
    ["安全验证", `<p>${chinese.repeat(3)}</p>`],
    ["Login", `<p>${english.repeat(2)}</p>`],
  ])("returns only a link for an access gate: %s", (title, content) => {
    const result = extractArticle(page(content, `<title>${title}</title>`), url);
    expect(result.kind).toBe("link-only");
    expect(result.text).toBe("");
    expect(result.warnings.join("")).toMatch(/登录|验证/);
  });

  it.each([
    "",
    "<p>一句很短的介绍。</p>",
    `<nav>${english.repeat(5)}</nav>`,
    `<div>${Array.from({ length: 20 }, (_, i) => `<a href="/item-${i}">第${i}条网站导航链接</a>`).join("")}</div>`,
    '<div id="root"></div><script>document.body.innerHTML="DYNAMIC_ONLY";</script>',
    "<p>。！？...    </p>".repeat(100),
  ])(
    "does not mark empty, dynamic, navigation-only or short pages as successful articles",
    (content) => {
      expect(extractArticle(page(content), url)).toMatchObject({
        kind: "link-only",
        text: "",
        excerpt: "",
      });
    },
  );

  it("does not misclassify a long article with a separate login form as an access gate", () => {
    const result = extractArticle(
      page(`${paragraphs}<form><h2>Sign in to comment</h2><input type="password"></form>`),
      url,
    );
    expect(result.kind).toBe("article");
  });

  it("rejects an overlong article rather than silently truncating it", () => {
    const result = extractArticle(page(`<p>${chinese.repeat(1800)}</p>`), url);
    expect(result).toMatchObject({ kind: "link-only", text: "", excerpt: "" });
    expect(result.warnings.join("")).toContain("120000");
  });

  it("counts all elements before cleaning and refuses a page beyond the DOM limit", () => {
    const result = extractArticle(
      page(`${paragraphs}<nav>${"<span>链接</span>".repeat(20000)}</nav>`),
      url,
    );
    expect(result).toMatchObject({ kind: "link-only", text: "" });
    expect(result.warnings.join("")).toContain("20000");
  });

  it("bounds metadata and treats markup-bearing metadata only as text", () => {
    const result = extractArticle(
      page(
        paragraphs,
        `<title>${"标题".repeat(400)}</title><meta name="description" content="${"摘要".repeat(400)}"><meta name="author" content="作者甲"><meta property="og:site_name" content="&lt;b&gt;学习站点&lt;/b&gt;">`,
      ),
      url,
    );
    expect(result.kind).toBe("article");
    expect(result.title.length).toBeLessThanOrEqual(512);
    expect(result.excerpt.length).toBeLessThanOrEqual(500);
    expect(result.byline).toBe("作者甲");
    expect(result.siteName).toBe("学习站点");
  });

  it("does not execute scripts, event handlers or fetch any external subresource", async () => {
    const dispatch = vi.spyOn(getGlobalDispatcher(), "dispatch").mockImplementation(() => {
      throw new Error("Network must remain disabled");
    });
    const fromUrl = vi.spyOn(JSDOM, "fromURL");
    const result = extractArticle(
      page(
        `${paragraphs}<script>document.querySelector("article").innerHTML="EXECUTED_SCRIPT_SENTINEL";</script><script src="https://external.invalid/track.js"></script><link rel="stylesheet" href="https://external.invalid/track.css"><img src="https://external.invalid/image.png" onerror="document.body.textContent='EXECUTED_HANDLER_SENTINEL'"><iframe src="https://external.invalid/frame"></iframe>`,
      ),
      url,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.kind).toBe("article");
    expect(result.text).toContain(chinese);
    expect(JSON.stringify(result)).not.toContain("EXECUTED_");
    expect(dispatch).not.toHaveBeenCalled();
    expect(fromUrl).not.toHaveBeenCalled();
  });

  it.each(["not a URL", "file:///etc/passwd", "data:text/html,hello"])(
    "fails closed for invalid final URL %s",
    (finalUrl) => {
      expect(extractArticle(page(paragraphs), finalUrl)).toMatchObject({
        kind: "link-only",
        text: "",
      });
    },
  );
});
