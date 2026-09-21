import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// globals.css is an ordered list of imports; assert against the sheet it composes.
const css = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8")
  .split("\n")
  .flatMap((line) => {
    const local = /^@import "(\.\/[^"]+)";$/.exec(line.trim());
    return local ? [readFileSync(fileURLToPath(new URL(local[1], import.meta.url)), "utf8")] : [];
  })
  .join("\n");

function mediaBlock(query: string, selector: string) {
  let start = css.indexOf(query);
  while (start >= 0) {
    const open = css.indexOf("{", start);
    let depth = 0;
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") depth -= 1;
      if (depth === 0) {
        const block = css.slice(open + 1, index);
        if (block.includes(selector)) return block;
        start = css.indexOf(query, index + 1);
        break;
      }
    }
  }
  throw new Error(`missing ${selector} in ${query}`);
}

function declarations(block: string, selector: string) {
  const start = block.indexOf(selector);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const open = block.indexOf("{", start);
  const close = block.indexOf("}", open);
  return block.slice(open + 1, close);
}

describe("source row touch target styles", () => {
  const actionSelector = ".source-row > .star-btn,\n  .source-row > .icon-btn:last-child";

  it("keeps collection star and management controls at least 40px on tablet touch layouts", () => {
    const tablet = mediaBlock("@media (min-width: 621px) and (max-width: 1024px)", actionSelector);
    const rules = declarations(tablet, actionSelector);
    expect(rules).toContain("flex: 0 0 40px;");
    expect(rules).toContain("width: 40px;");
    expect(rules).toContain("min-width: 40px;");
    expect(rules).toContain("height: 40px;");
  });

  it("keeps 44px mobile actions in the row budget reserved for the source title", () => {
    const mobile = mediaBlock("@media (max-width: 620px)", actionSelector);
    const rules = declarations(mobile, actionSelector);
    expect(rules).toContain("flex: 0 0 44px;");
    expect(rules).toContain("width: 44px;");
    expect(rules).toContain("min-width: 44px;");
    expect(rules).toContain("height: 44px;");
    expect(declarations(mobile, ".source-open")).toContain("width: calc(100% - 125px);");
  });
});

describe("phone overlay and navigation styles", () => {
  it("keeps library filter and view panels inside the phone viewport", () => {
    const mobile = mediaBlock("@media (max-width: 620px)", ".library-menu-popover-sheet");
    const rules = declarations(mobile, ".library-menu-popover-sheet");

    expect(rules).toContain("position: fixed;");
    expect(rules).toContain("inset: auto 12px calc(64px + env(safe-area-inset-bottom));");
    expect(rules).toContain("width: auto;");
    expect(rules).toContain("overflow-y: auto;");
  });

  it("keeps settings panes on one horizontally scrollable row", () => {
    const mobile = mediaBlock("@media (max-width: 620px)", "overscroll-behavior-x: contain;");
    const rules = declarations(mobile, ".settings-panes");

    expect(rules).toContain("flex-wrap: nowrap;");
    expect(rules).toContain("overflow-x: auto;");
  });
});
