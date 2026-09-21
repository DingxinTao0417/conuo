import { useLayoutEffect, useRef } from "react";
import {
  Platform,
  ScrollView,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import {
  acceptScrollOffset,
  beginScrollInteraction,
  createScrollRestoration,
  measureScroll,
  scrollRestoreTarget,
} from "../core/scroll-restoration";

type Options = {
  key: string;
  enabled: boolean;
  read: () => number;
  write: (value: number) => void;
  resetToken?: unknown;
};
type WebScrollNode = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

/** Keep the bookmark guarded until real layout and a confirmed scroll agree. */
export function useRestoredScroll(options: Options) {
  const ref = useRef<ScrollView>(null);
  const state = useRef(createScrollRestoration(0));
  const active = useRef<{ write: Options["write"]; epoch: number } | null>(
    null,
  );
  const epoch = useRef(0);
  const latest = useRef(options);
  latest.current = options;
  const lastActivation = useRef<{ key: string; resetToken: unknown } | null>(
    null,
  );
  const frame = useRef<number | null>(null);
  const retries = useRef(0);
  const schedule = useRef<() => void>(() => {});
  const webNode = () =>
    Platform.OS === "web"
      ? (ref.current?.getScrollableNode() as WebScrollNode | undefined)
      : undefined;
  const save = (value: number) => {
    if (active.current && acceptScrollOffset(state.current, value))
      active.current.write(state.current.target);
  };
  const capture = () => {
    if (!active.current || state.current.phase !== "ready") return;
    const node = webNode();
    // Synchronously capture keyboard/focus scrolling before its throttled event or unmount.
    if (node && node.clientHeight > 0 && node.scrollHeight > 0)
      state.current.target = Math.max(0, node.scrollTop);
    active.current.write(state.current.target);
  };
  schedule.current = () => {
    if (!active.current || state.current.phase === "ready") return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    const currentEpoch = active.current.epoch;
    frame.current = requestAnimationFrame(() => {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (
          !active.current ||
          active.current.epoch !== currentEpoch ||
          !ref.current
        )
          return;
        const node = webNode();
        if (node) {
          if (node.clientHeight <= 0 || node.scrollHeight <= 0) return;
          measureScroll(state.current, node.clientHeight, node.scrollHeight);
        }
        const target = scrollRestoreTarget(state.current);
        if (target === null) return;
        const layoutVersion = state.current.layoutVersion;
        ref.current.scrollTo({ y: target, animated: false });
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          if (!active.current || active.current.epoch !== currentEpoch) return;
          const measured = webNode();
          if (
            measured &&
            measured.clientHeight > 0 &&
            measured.scrollHeight > 0
          ) {
            measureScroll(
              state.current,
              measured.clientHeight,
              measured.scrollHeight,
            );
            if (layoutVersion === state.current.layoutVersion)
              save(measured.scrollTop);
          } else if (Platform.OS !== "web" && target === 0) {
            // A native no-op scroll to the already-top position need not emit onScroll.
            save(0);
          }
          if (state.current.phase !== "ready" && retries.current++ < 4)
            schedule.current();
        });
      });
    });
  };
  useLayoutEffect(() => {
    const previous = state.current;
    const retainGeometry =
      lastActivation.current?.key === options.key &&
      lastActivation.current.resetToken !== options.resetToken;
    active.current = options.enabled
      ? { write: options.write, epoch: ++epoch.current }
      : null;
    state.current = createScrollRestoration(options.read());
    if (retainGeometry)
      measureScroll(state.current, previous.viewport, previous.content);
    lastActivation.current = {
      key: options.key,
      resetToken: options.resetToken,
    };
    retries.current = 0;
    if (active.current) schedule.current();
    return () => {
      if (
        latest.current.key === options.key &&
        latest.current.resetToken === options.resetToken
      )
        capture();
      active.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
    // Functions intentionally belong to this route/scope activation, not a later render.
  }, [options.key, options.enabled, options.resetToken]);
  return {
    ref,
    capture,
    onLayout: (event: LayoutChangeEvent) => {
      if (!active.current) return;
      measureScroll(state.current, event.nativeEvent.layout.height);
      retries.current = 0;
      schedule.current();
    },
    onContentSizeChange: (_width: number, height: number) => {
      if (!active.current) return;
      measureScroll(state.current, undefined, height);
      retries.current = 0;
      schedule.current();
    },
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!active.current) return;
      const { layoutMeasurement, contentSize, contentOffset } =
        event.nativeEvent;
      if (layoutMeasurement.height <= 0 || contentSize.height <= 0) return;
      measureScroll(
        state.current,
        layoutMeasurement.height,
        contentSize.height,
      );
      save(contentOffset.y);
      if (state.current.phase === "waiting") schedule.current();
    },
    onScrollBeginDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!active.current) return;
      beginScrollInteraction(state.current, event.nativeEvent.contentOffset.y);
      active.current.write(state.current.target);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
  };
}
