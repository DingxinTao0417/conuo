export type ScrollRestoration = {
  phase: "waiting" | "applying" | "ready";
  target: number;
  viewport: number;
  content: number;
  applied: number | null;
  layoutVersion: number;
  /** User control lasts through momentum/reflow, until a new scope activation. */
  userControlled: boolean;
};
const offset = (value: number) =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

export function createScrollRestoration(saved: number): ScrollRestoration {
  return {
    phase: "waiting",
    target: offset(saved),
    viewport: 0,
    content: 0,
    applied: null,
    layoutVersion: 0,
    userControlled: false,
  };
}

/** Zero-sized hidden/unmounted views cannot replace the last usable geometry or bookmark. */
export function measureScroll(
  state: ScrollRestoration,
  viewport?: number,
  content?: number,
) {
  const nextViewport =
    viewport && Number.isFinite(viewport) && viewport > 0
      ? viewport
      : state.viewport;
  const nextContent =
    content && Number.isFinite(content) && content > 0
      ? content
      : state.content;
  if (state.viewport !== nextViewport || state.content !== nextContent) {
    state.viewport = nextViewport;
    state.content = nextContent;
    state.layoutVersion++;
    // A keyboard or width change may arrive in the same native event as a drag.
    // Keep accepting that event's offset once the user has taken control.
    if (!state.userControlled) state.phase = "waiting";
    state.applied = null;
  }
}

/** Call after layout has settled; both native viewport and content must have reported size. */
export function scrollRestoreTarget(state: ScrollRestoration) {
  if (state.phase === "ready" || state.viewport <= 0 || state.content <= 0)
    return null;
  state.applied = Math.min(
    state.target,
    Math.max(0, state.content - state.viewport),
  );
  state.phase = "applying";
  return state.applied;
}

/** Initial zero scroll events never win over a not-yet-restored bookmark. */
export function acceptScrollOffset(state: ScrollRestoration, value: number) {
  if (!Number.isFinite(value) || state.phase === "waiting") return false;
  const actual = offset(value);
  if (
    state.phase === "applying" &&
    (state.applied === null || Math.abs(actual - state.applied) > 1)
  )
    return false;
  state.target = actual;
  state.phase = "ready";
  return true;
}

/** An intentional drag takes control even while restoration was waiting for a native layout. */
export function beginScrollInteraction(
  state: ScrollRestoration,
  value: number,
) {
  state.target = offset(value);
  state.applied = null;
  state.phase = "ready";
  state.userControlled = true;
}
