// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RegionStudyMarkdown from "./region-study-markdown";

describe("RegionStudyMarkdown", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(content: string) {
    await act(async () => root.render(createElement(RegionStudyMarkdown, { content })));
  }

  function expectNoActiveContent() {
    expect(host.querySelector("a,img,script,iframe,object,embed,style,link,form")).toBeNull();
    expect(host.querySelector("[href],[src],[srcset],[action],[formaction]")).toBeNull();
    for (const element of host.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.name).not.toMatch(/^on/i);
        if (attribute.name === "style") expect(attribute.value).not.toMatch(/url\s*\(/i);
      }
    }
  }

  it("renders readable paragraphs, lists, emphasis and code without escaping their syntax", async () => {
    await render(
      "先看 **关键条件**，再读 *解释* 和 `x > 0`。\n\n第二段。\n\n- 核对条件\n- 推导结论\n\n1. 代入\n2. 验证\n\n```ts\nconst x = 1;\n```",
    );
    expect(host.querySelector(".region-study-markdown")).toBeTruthy();
    expect([...host.querySelectorAll("p")].map((node) => node.textContent)).toEqual([
      "先看 关键条件，再读 解释 和 x > 0。",
      "第二段。",
    ]);
    expect(host.querySelector("strong")?.textContent).toBe("关键条件");
    expect(host.querySelector("em")?.textContent).toBe("解释");
    expect(host.querySelector("p code")?.textContent).toBe("x > 0");
    expect(host.querySelectorAll("ul li")).toHaveLength(2);
    expect(host.querySelectorAll("ol li")).toHaveLength(2);
    expect(host.querySelector("pre code")?.textContent).toBe("const x = 1;\n");
  });

  it("keeps model headings beneath result and section headings", async () => {
    await render("# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六");
    expect(host.querySelector("h1,h2,h3,h4")).toBeNull();
    expect(
      [...host.querySelectorAll("h5,h6")].map((node) => [node.tagName, node.textContent]),
    ).toEqual([
      ["H5", "一"],
      ["H5", "二"],
      ["H5", "三"],
      ["H5", "四"],
      ["H5", "五"],
      ["H6", "六"],
    ]);
  });

  it("renders GFM tables inside a scroll container and keeps task lists noninteractive", async () => {
    await render("| 条件 | 结论 |\n| --- | --- |\n| x > 0 | ~~错误~~ |\n\n- [x] 已核对");
    const table = host.querySelector(".region-study-table > table");
    expect(table).toBeTruthy();
    expect([...table!.querySelectorAll("th")].map((node) => node.textContent)).toEqual([
      "条件",
      "结论",
    ]);
    expect(table!.querySelector("td")?.textContent).toBe("x > 0");
    expect(table!.querySelector("del")?.textContent).toBe("错误");
    const checkbox = host.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(checkbox?.disabled).toBe(true);
    expect(checkbox?.checked).toBe(true);
  });

  it("renders inline and display formulas with accessible MathML", async () => {
    await render("行内 $x^2 + 1$。\n\n$$\n\\frac{1}{2} + \\sqrt{x}\n$$");
    expect(host.querySelectorAll(".katex")).toHaveLength(2);
    expect(host.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(host.querySelectorAll("math")).toHaveLength(2);
    expect([...host.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual([
      "x^2 + 1",
      "\\frac{1}{2} + \\sqrt{x}",
    ]);
    expect(host.querySelector(".katex-mathml mi")?.textContent).toBe("x");
    expectNoActiveContent();
  });

  it("keeps invalid formulas readable without losing neighboring text", async () => {
    await render("说明之前。\n\n$\\frac{1}{$\n\n说明之后。");
    expect(host.querySelector(".katex-error")?.textContent).toBe("\\frac{1}{");
    expect(host.textContent).toContain("说明之前。");
    expect(host.textContent).toContain("说明之后。");
    expectNoActiveContent();
  });

  it("reduces every Markdown URL to wording and drops images and raw HTML", async () => {
    await render(
      "[外部](https://tracker.invalid/pixel) [相对](/account) [邮件](mailto:test@example.invalid) [脚本](javascript:alert%281%29) [内联数据](data:text/html,unsafe)\n\nhttps://tracker.invalid/auto\n\n![远程图](https://tracker.invalid/image) ![内联图](data:image/png;base64,aGVsbG8=)\n\n<img src='https://tracker.invalid/raw' onerror='alert(1)'>\n\n<script>alert(1)</script>\n\n<iframe src='https://tracker.invalid/frame'></iframe>",
    );
    for (const label of [
      "外部",
      "相对",
      "邮件",
      "脚本",
      "内联数据",
      "https://tracker.invalid/auto",
    ])
      expect(host.textContent).toContain(label);
    expect(host.querySelectorAll("p span").length).toBeGreaterThanOrEqual(6);
    expect(host.textContent).not.toContain("远程图");
    expect(host.textContent).not.toContain("内联图");
    expectNoActiveContent();
  });

  it.each([
    ["\\href{https://tracker.invalid/tex}{remote}", "\\href"],
    ["\\url{data:text/html,unsafe}", "\\url"],
    ["\\includegraphics{https://tracker.invalid/tex.png}", "\\includegraphics"],
    ["\\htmlStyle{background-image:url(https://tracker.invalid/css)}{x}", "\\htmlStyle"],
    ["\\htmlClass{injected-class}{x}", "\\htmlClass"],
    ["\\htmlId{injected-id}{x}", "\\htmlId"],
    ["\\htmlData{exploit=active}{x}", "\\htmlData"],
  ])("does not trust the TeX command %s", async (formula, command) => {
    await render(`$${formula}$`);
    expect(host.textContent).toContain(command);
    expect(host.querySelector(".injected-class,#injected-id,[data-exploit]")).toBeNull();
    expectNoActiveContent();
  });

  it("bounds recursive expansion and oversized dimensions instead of breaking the result", async () => {
    await render("$\\def\\recurse{\\recurse}\\recurse$\n\n$\\rule{999em}{999em}$");
    expect(host.querySelector(".katex-error")?.textContent).toContain("\\recurse");
    expect(host.querySelectorAll("math")).toHaveLength(1);
    expect(host.querySelector("[style*='999']")).toBeNull();
    expect(host.querySelector("[style*='10em']")).toBeTruthy();
    expectNoActiveContent();
  });

  it("does not share user-defined TeX macros across content updates", async () => {
    await render("$\\gdef\\temporary{private}\\temporary$");
    expect(host.querySelector("math")).toBeTruthy();
    await render("$\\temporary$");
    expect(host.textContent).not.toContain("private");
    expect(host.querySelector(".katex")?.textContent).toContain("\\temporary");
    expect(host.querySelector("annotation")?.textContent).toBe("\\temporary");
  });
});
