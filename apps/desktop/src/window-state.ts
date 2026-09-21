import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type Bounds = { x: number; y: number; width: number; height: number };
export type WindowState = { bounds: Bounds; maximized: boolean; zoom: number };

function validBounds(value: unknown): value is Bounds {
  if (!value || typeof value !== "object") return false;
  const bounds = value as Bounds;
  return (
    [bounds.x, bounds.y, bounds.width, bounds.height].every(
      Number.isSafeInteger,
    ) &&
    bounds.width >= 400 &&
    bounds.height >= 300 &&
    bounds.width <= 16000 &&
    bounds.height <= 16000 &&
    Math.abs(bounds.x) <= 100000 &&
    Math.abs(bounds.y) <= 100000
  );
}

/** Persist window preferences only: no account, document or navigation data. */
export function readWindowState(filename: string): WindowState | null {
  try {
    const value = JSON.parse(readFileSync(filename, "utf8"));
    if (
      !validBounds(value.bounds) ||
      typeof value.maximized !== "boolean" ||
      !Number.isFinite(value.zoom) ||
      value.zoom < -2 ||
      value.zoom > 3
    )
      return null;
    return {
      bounds: value.bounds,
      maximized: value.maximized,
      zoom: value.zoom,
    };
  } catch {
    return null;
  }
}

export function writeWindowState(
  filename: string,
  state: WindowState,
): boolean {
  try {
    mkdirSync(path.dirname(filename), { recursive: true });
    // Write a small replacement before renaming; a failed write leaves the prior state intact.
    writeFileSync(`${filename}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${filename}.tmp`, filename);
    return true;
  } catch {
    return false;
  }
}

export function restoreWindowState(
  saved: WindowState | null,
  areas: Bounds[],
): WindowState {
  const primary = areas[0] ?? { x: 0, y: 0, width: 1280, height: 800 };
  const old = saved?.bounds;
  const overlap = (area: Bounds) =>
    old
      ? Math.max(
          0,
          Math.min(old.x + old.width, area.x + area.width) -
            Math.max(old.x, area.x),
        ) *
        Math.max(
          0,
          Math.min(old.y + old.height, area.y + area.height) -
            Math.max(old.y, area.y),
        )
      : 0;
  const target = old
    ? areas.reduce(
        (best, area) => (overlap(area) > overlap(best) ? area : best),
        primary,
      )
    : primary;
  const width = Math.min(target.width, Math.max(880, old?.width ?? 1440));
  const height = Math.min(target.height, Math.max(600, old?.height ?? 960));
  const visible = old && overlap(target) > 0;
  const x = visible
    ? Math.min(Math.max(old.x, target.x), target.x + target.width - width)
    : target.x + Math.floor((target.width - width) / 2);
  const y = visible
    ? Math.min(Math.max(old.y, target.y), target.y + target.height - height)
    : target.y + Math.floor((target.height - height) / 2);
  return {
    bounds: { x, y, width, height },
    maximized: saved?.maximized ?? false,
    zoom: saved?.zoom ?? 0,
  };
}
