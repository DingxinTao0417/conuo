import { createHash } from "node:crypto";

export const STAGING_ORIGIN = "https://conuo-staging.vercel.app";
export const SHELL_URL = "conuo-desktop://app/index.html";
export const TITLE_BAR_HEIGHT = 40;
// Matches Conuo's --bg-base-secondary surface.
export const TITLE_BAR_COLOR = "#f7f7f8";
export const DESKTOP_MENU_IDS = ["file", "edit", "view", "help"] as const;

export type DesktopConfig = {
  origin: string;
  startUrl: string;
  environment: "staging" | "development" | "production";
  partition: string;
};

function parseUrl(value: string): URL | null {
  try {
    if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value))
      return null;
    const url = new URL(value);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

export function resolveConfig(
  env: Record<string, string | undefined>,
  packaged: boolean,
): DesktopConfig {
  const mode = env.CONUO_DESKTOP_ENV || "staging";
  if (!["staging", "development", "production"].includes(mode))
    throw new Error("Invalid desktop environment");
  const value = env.CONUO_DESKTOP_URL || STAGING_ORIGIN;
  const url = parseUrl(value);
  if (!url || url.pathname !== "/" || url.search || url.hash)
    throw new Error(
      "Desktop URL must be an origin without credentials, path, query or fragment",
    );
  if (mode === "staging" && url.origin !== STAGING_ORIGIN)
    throw new Error("Staging is restricted to the configured staging origin");
  if (
    mode === "development" &&
    (packaged ||
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new Error("Development is restricted to unpackaged loopback HTTP");
  }
  if (
    mode === "production" &&
    (!env.CONUO_DESKTOP_URL ||
      url.protocol !== "https:" ||
      url.origin === STAGING_ORIGIN ||
      isPrivateHost(url.hostname))
  ) {
    throw new Error(
      "Production requires an explicitly configured public HTTPS origin",
    );
  }
  const environment = mode as DesktopConfig["environment"];
  const hash = createHash("sha256")
    .update(url.origin)
    .digest("hex")
    .slice(0, 12);
  return {
    origin: url.origin,
    startUrl: `${url.origin}/#home`,
    environment,
    partition: `persist:conuo-${mode}-${hash}`,
  };
}

export function isInternalUrl(value: string, origin: string): boolean {
  const url = parseUrl(value);
  return (
    !!url && url.origin === origin && ["http:", "https:"].includes(url.protocol)
  );
}

export function isPrivateHost(host: string): boolean {
  const name = host.toLowerCase();
  if (
    !name.includes(".") ||
    name.endsWith(".localhost") ||
    name.endsWith(".local")
  )
    return true;
  if (name.startsWith("[")) return true;
  const parts = name.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
    return false;
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function isSafeExternalUrl(value: string): boolean {
  const url = parseUrl(value);
  return (
    !!url &&
    ["http:", "https:"].includes(url.protocol) &&
    !isPrivateHost(url.hostname)
  );
}

export function isAllowedDownload(
  urlValue: string,
  initiator: string,
  origin: string,
): boolean {
  if (initiator !== origin) return false;
  const url = parseUrl(urlValue);
  if (!url) return false;
  if (url.protocol === "blob:") return url.origin === origin;
  return isInternalUrl(urlValue, origin);
}

export function sanitizeFilename(filename: string): string {
  const cleaned =
    filename
      .split(/[\\/]/u)
      .at(-1)
      ?.replace(/[<>:"|?*\u0000-\u001f\u007f]/gu, "_")
      .replace(/[. ]+$/u, "")
      .slice(0, 160) || "conuo-download";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleaned)
    ? `conuo-${cleaned}`
    : cleaned;
}

export type ShellAction =
  | "toggle-sidebar"
  | "menu"
  | "back"
  | "forward"
  | "reload"
  | "home"
  | "downloads"
  | "workspace"
  | "connection"
  | "browser"
  | "cancel-download"
  | "reveal-download";
export function validShellAction(value: unknown): value is {
  action: ShellAction;
  id?: string;
  anchor?: { x: number; y: number };
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const actions: string[] = [
    "toggle-sidebar",
    "menu",
    "back",
    "forward",
    "reload",
    "home",
    "downloads",
    "workspace",
    "connection",
    "browser",
    "cancel-download",
    "reveal-download",
  ];
  if (
    typeof candidate.action !== "string" ||
    !actions.includes(candidate.action)
  )
    return false;
  if (candidate.action === "menu") {
    const point = candidate.anchor as { x?: unknown; y?: unknown } | undefined;
    return (
      typeof candidate.id === "string" &&
      DESKTOP_MENU_IDS.some((id) => id === candidate.id) &&
      !!point &&
      Number.isInteger(point.x) &&
      Number.isInteger(point.y) &&
      (point.x as number) >= 0 &&
      (point.x as number) <= 16000 &&
      (point.y as number) >= 0 &&
      (point.y as number) <= TITLE_BAR_HEIGHT
    );
  }
  return (
    !candidate.action.endsWith("-download") ||
    (typeof candidate.id === "string" && /^[a-f0-9-]{36}$/u.test(candidate.id))
  );
}
