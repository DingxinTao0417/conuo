import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  restoreWindowState,
  readWindowState,
  writeWindowState,
} from "../dist/window-state.js";

const primary = { x: 0, y: 0, width: 1366, height: 728 };
test("first launch fits the usable screen rather than hiding the bottom of the window", () => {
  assert.deepEqual(restoreWindowState(null, [primary]).bounds, primary);
});
test("disconnected monitor and oversized saved window recover entirely on the primary screen", () => {
  const result = restoreWindowState(
    {
      bounds: { x: 4000, y: -200, width: 1440, height: 960 },
      zoom: 1,
      maximized: true,
    },
    [primary],
  );
  assert.deepEqual(result, { bounds: primary, zoom: 1, maximized: true });
});
test("negative-coordinate monitors are preserved and their taskbar area stays clear", () => {
  const secondary = { x: -1920, y: 0, width: 1920, height: 1040 };
  const bounds = { x: -1700, y: 50, width: 1200, height: 750 };
  assert.deepEqual(
    restoreWindowState({ bounds, zoom: 0, maximized: false }, [
      primary,
      secondary,
    ]).bounds,
    bounds,
  );
});
test("partial visibility is clamped to keep the title bar and controls reachable", () => {
  const result = restoreWindowState(
    {
      bounds: { x: 1200, y: -100, width: 1000, height: 700 },
      zoom: 0,
      maximized: false,
    },
    [primary],
  );
  assert.deepEqual(result.bounds, { x: 366, y: 0, width: 1000, height: 700 });
});
test("preference persistence contains only window geometry and tolerates corrupt or missing files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "conuo-window-test-"));
  const filename = path.join(directory, "window.json");
  try {
    assert.equal(readWindowState(filename), null);
    const expected = { bounds: primary, zoom: 0.5, maximized: false };
    assert.equal(writeWindowState(filename, expected), true);
    assert.deepEqual(readWindowState(filename), expected);
    assert.deepEqual(
      Object.keys(JSON.parse(readFileSync(filename, "utf8"))).sort(),
      ["bounds", "maximized", "zoom"],
    );
    for (const invalid of [
      "{",
      JSON.stringify({ ...expected, zoom: 999 }),
      JSON.stringify({ ...expected, bounds: { ...primary, x: 1e20 } }),
    ]) {
      writeFileSync(filename, invalid);
      assert.equal(readWindowState(filename), null);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
