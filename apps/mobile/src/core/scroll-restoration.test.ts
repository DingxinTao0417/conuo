import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptScrollOffset,
  beginScrollInteraction,
  createScrollRestoration,
  measureScroll,
  scrollRestoreTarget,
} from "./scroll-restoration.ts";

test("returning to a long library waits for both measurements and rejects initial zero scroll events", () => {
  const state = createScrollRestoration(3118);
  assert.equal(acceptScrollOffset(state, 0), false);
  assert.equal(state.target, 3118);
  measureScroll(state, 750);
  assert.equal(scrollRestoreTarget(state), null);
  assert.equal(acceptScrollOffset(state, 0), false);
  measureScroll(state, undefined, 8478);
  assert.equal(scrollRestoreTarget(state), 3118);
  assert.equal(acceptScrollOffset(state, 0), false);
  assert.equal(state.target, 3118);
  assert.equal(acceptScrollOffset(state, 3118), true);
  assert.equal(state.phase, "ready");
  assert.equal(acceptScrollOffset(state, 3200), true);
  assert.equal(state.target, 3200);
});

test("content reporting first does not restore before the viewport exists", () => {
  const state = createScrollRestoration(900);
  measureScroll(state, undefined, 5000);
  assert.equal(scrollRestoreTarget(state), null);
  measureScroll(state, 600);
  assert.equal(scrollRestoreTarget(state), 900);
  assert.equal(acceptScrollOffset(state, 899.5), true);
});

test("a late layout invalidates an in-flight acknowledgement without replacing the bookmark", () => {
  const state = createScrollRestoration(2400);
  measureScroll(state, 800, 5000);
  assert.equal(scrollRestoreTarget(state), 2400);
  measureScroll(state, 500, 8200);
  assert.equal(acceptScrollOffset(state, 0), false);
  assert.equal(acceptScrollOffset(state, 2400), false);
  assert.equal(scrollRestoreTarget(state), 2400);
  assert.equal(acceptScrollOffset(state, 2400), true);
});

test("content removal clamps only after measured layout and confirmation, while the empty viewport remains at top", () => {
  const shortened = createScrollRestoration(3118);
  measureScroll(shortened, 750, 1000);
  assert.equal(scrollRestoreTarget(shortened), 250);
  assert.equal(shortened.target, 3118);
  assert.equal(acceptScrollOffset(shortened, 250), true);
  assert.equal(shortened.target, 250);
  const empty = createScrollRestoration(500);
  measureScroll(empty, 750, 300);
  assert.equal(scrollRestoreTarget(empty), 0);
  assert.equal(acceptScrollOffset(empty, 0), true);
});

test("hidden AI geometry never records a zero bookmark and reactivation restores the saved answer position", () => {
  const previous = createScrollRestoration(1700);
  measureScroll(previous, 520, 9000);
  scrollRestoreTarget(previous);
  acceptScrollOffset(previous, 1700);
  measureScroll(previous, 0, 0);
  assert.equal(previous.target, 1700);
  assert.equal(previous.viewport, 520);
  const resumed = createScrollRestoration(previous.target);
  assert.equal(acceptScrollOffset(resumed, 0), false);
  measureScroll(resumed, 400, 11000);
  assert.equal(scrollRestoreTarget(resumed), 1700);
  assert.equal(acceptScrollOffset(resumed, 1700), true);
});

test("a new result or library context starts independently and explicit dragging takes control", () => {
  const old = createScrollRestoration(1200);
  const fresh = createScrollRestoration(0);
  measureScroll(fresh, 600, 4000);
  assert.equal(scrollRestoreTarget(fresh), 0);
  assert.equal(acceptScrollOffset(fresh, 0), true);
  assert.equal(old.target, 1200);
  beginScrollInteraction(old, 400);
  assert.equal(old.phase, "ready");
  assert.equal(acceptScrollOffset(old, 480), true);
  assert.equal(old.target, 480);
});

test("a drag retains control when the keyboard changes viewport size and content reflows", () => {
  const state = createScrollRestoration(900);
  measureScroll(state, 600, 5000);
  scrollRestoreTarget(state);
  acceptScrollOffset(state, 900);
  beginScrollInteraction(state, 900);

  // The drag's next event can report a new layout after keyboard dismissal.
  measureScroll(state, 500, 5000);
  assert.equal(acceptScrollOffset(state, 1200), true);
  assert.equal(scrollRestoreTarget(state), null);
  assert.equal(state.target, 1200);

  // Later text reflow or momentum must not restart restoration either.
  measureScroll(state, 500, 5200);
  assert.equal(acceptScrollOffset(state, 1350), true);
  assert.equal(scrollRestoreTarget(state), null);
  assert.equal(state.target, 1350);
});

test("dragging before native measurements wins only for the current activation", () => {
  const state = createScrollRestoration(2400);
  beginScrollInteraction(state, 100);
  measureScroll(state, 600, 5000);
  assert.equal(acceptScrollOffset(state, 200), true);
  assert.equal(scrollRestoreTarget(state), null);

  const resumed = createScrollRestoration(state.target);
  measureScroll(resumed, 600, 5000);
  assert.equal(acceptScrollOffset(resumed, 0), false);
  assert.equal(scrollRestoreTarget(resumed), 200);
  assert.equal(acceptScrollOffset(resumed, 200), true);
});
