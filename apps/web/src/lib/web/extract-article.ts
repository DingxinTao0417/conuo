import "server-only";

import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";

const MAX_ELEMENTS = 20_000;
const MAX_TEXT = 120_000;
const MIN_TEXT = 100;
const COVERAGE_WARNING = "提取内容可能不含图片、嵌入或动态区块，请核对正文。";
const NON_CONTENT = [
  "script",
  "style",
  "template",
  "noscript",
  "form",
  "iframe",
  "object",
  "embed",
  "svg",
  "canvas",
  "video",
  "audio",
  "link",
  "base",
  "nav",
  "aside",
  "footer",
  "button",
  "input",
  "textarea",
  "select",
  "option",
  "[hidden]",
  '[aria-hidden="true"]',
  '[role="navigation"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="banner"]',
].join(",");
const BLOCKS = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "MAIN",
  "BLOCKQUOTE",
  "PRE",
  "DL",
  "DT",
  "DD",
  "UL",
  "OL",
  "TABLE",
]);

export interface ExtractedArticle {
  title: string;
  text: string;
  excerpt: string;
  byline?: string;
  siteName?: string;
  warnings: string[];
  kind: "article" | "link-only";
}

function inline(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanDom(root: ParentNode) {
  // No CSS/layout engine is trusted to identify all invisible or dynamic content.
  for (const element of root.querySelectorAll<HTMLElement>("[style]")) {
    if (
      element.style.display === "none" ||
      ["hidden", "collapse"].includes(element.style.visibility) ||
      element.style.contentVisibility === "hidden"
    )
      element.remove();
  }
  for (const element of root.querySelectorAll(NON_CONTENT)) element.remove();
}

function metadata(document: Document, value: string | null | undefined, limit: number): string {
  const holder = document.createElement("div");
  holder.innerHTML = value ?? "";
  cleanDom(holder);
  return inline(holder.textContent ?? "")
    .slice(0, limit)
    .replace(/[\ud800-\udbff]$/, "");
}

/** Serialize only DOM text nodes; no extracted HTML is returned to the caller. */
function plainText(root: Node): string {
  function visit(node: Node): string {
    if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
    if (node.nodeType !== 1) return "";
    const element = node as Element;
    const tag = element.tagName;
    if (tag === "BR") return "\n";
    const text = Array.from(element.childNodes, visit).join("");
    if (/^H[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${inline(text)}\n\n`;
    if (tag === "LI") {
      const parent = element.parentElement;
      const number =
        parent?.tagName === "OL"
          ? Array.from(parent.children).indexOf(element) +
            (Number(parent.getAttribute("start")) || 1)
          : null;
      return `\n${number === null ? "-" : `${number}.`} ${text.trim()}\n`;
    }
    if (tag === "TD" || tag === "TH") return `${text.trim()}\t`;
    if (tag === "TR") return `\n${text.trim()}\n`;
    return BLOCKS.has(tag) ? `\n\n${text.trim()}\n\n` : text;
  }
  return visit(root)
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function effectiveLength(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

function accessWall(document: Document): boolean {
  const headings = [
    document.title,
    ...Array.from(document.querySelectorAll("h1"), (h) => h.textContent ?? ""),
  ];
  const gate =
    /^(?:请(?:先)?登录|登录(?:后|以|\s|$)|用户登录|账号登录|身份验证|安全验证|验证码|访问受限|拒绝访问|sign\s*in\b|log\s*in\b|login\b|access denied\b|verify (?:you are|that you are|your identity)\b|just a moment\b|security check\b|captcha\b)/i;
  if (headings.some((text) => gate.test(inline(text)))) return true;
  if (document.querySelector('input[type="password"]')) {
    const copy = document.body.cloneNode(true) as HTMLElement;
    cleanDom(copy);
    if (effectiveLength(plainText(copy)) < MIN_TEXT) return true;
  }
  return false;
}

/** Offline extraction only: the fetch layer owns URL validation, limits, and redirects. */
export function extractArticle(html: string, finalUrl: string): ExtractedArticle {
  let dom: JSDOM | undefined;
  let extracted: JSDOM | undefined;
  let title = "网页链接";
  const linkOnly = (warning: string): ExtractedArticle => ({
    title,
    text: "",
    excerpt: "",
    kind: "link-only",
    warnings: [warning],
  });
  try {
    const url = new URL(finalUrl);
    if (!["http:", "https:"].includes(url.protocol)) return linkOnly("网页地址无效，未提取正文。");
    title = url.hostname.slice(0, 512);
    // Omitting runScripts and resources keeps both disabled. Never use JSDOM.fromURL.
    dom = new JSDOM(html, { url: url.href, virtualConsole: new VirtualConsole() });
    const document = dom.window.document;
    if (document.querySelectorAll("*").length > MAX_ELEMENTS)
      return linkOnly("页面超过 20000 个 DOM 元素，结构过于复杂；仅保留链接，请手动提供正文。");
    title = metadata(document, document.title, 512) || title;
    if (accessWall(document))
      return linkOnly("页面需要登录、身份验证或验证码，未获取可用文章；仅保留链接。");
    cleanDom(document);
    const body = plainText(document.body);
    const links = Array.from(document.body.querySelectorAll("a"), (a) => a.textContent ?? "").join(
      "",
    );
    if (effectiveLength(body) < MIN_TEXT || effectiveLength(links) > effectiveLength(body) * 0.65)
      return linkOnly(
        "未找到足够的文章正文，页面可能只有导航、需要 JavaScript 或内容过短；仅保留链接。",
      );
    const article = new Readability(document, {
      maxElemsToParse: MAX_ELEMENTS,
      charThreshold: MIN_TEXT,
      disableJSONLD: true,
    }).parse();
    if (!article?.content)
      return linkOnly("无法识别文章正文；页面可能依赖动态加载，请手动提供正文或仅保留链接。");
    extracted = new JSDOM(article.content, { url: url.href, virtualConsole: new VirtualConsole() });
    cleanDom(extracted.window.document);
    const text = plainText(extracted.window.document.body);
    if (text.length > MAX_TEXT)
      return linkOnly("提取正文超过 120000 字符，未保存截断文章；请分段提供正文或仅保留链接。");
    if (effectiveLength(text) < MIN_TEXT)
      return linkOnly("提取到的有效正文不足 100 字符，不能确认是完整文章；仅保留链接。");
    const byline = metadata(document, article.byline, 512);
    const siteName = metadata(document, article.siteName, 512);
    return {
      title: metadata(document, article.title, 512) || title,
      text,
      excerpt: metadata(document, article.excerpt, 500) || inline(text).slice(0, 500),
      ...(byline ? { byline } : {}),
      ...(siteName ? { siteName } : {}),
      warnings: [COVERAGE_WARNING],
      kind: "article",
    };
  } catch {
    return linkOnly("页面解析失败，未提取正文；请手动提供正文或仅保留链接。");
  } finally {
    extracted?.window.close();
    dom?.window.close();
  }
}
