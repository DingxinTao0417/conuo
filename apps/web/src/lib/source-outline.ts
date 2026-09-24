export interface OutlineItem {
  title: string;
  level: number;
  page?: number;
}

export type SourceOutlineMethod =
  "pdf-outline" | "heading-heuristic" | "docx-headings" | "markdown-headings";

export interface SourceOutlineRecord {
  method: SourceOutlineMethod;
  items: OutlineItem[];
}

/** The parsed result lives only for the active import/read task until the API saves it. */
export const sourceOutlineCache = new WeakMap<object, SourceOutlineRecord>();

/** Flattens a PDF.js outline tree and resolves each destination to a 1-based page. */
export async function readPdfOutline(pdf: {
  getOutline(): Promise<unknown[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}): Promise<OutlineItem[]> {
  if (
    typeof pdf.getOutline !== "function" ||
    typeof pdf.getDestination !== "function" ||
    typeof pdf.getPageIndex !== "function"
  )
    return [];
  const outline = await pdf.getOutline().catch(() => null);
  if (!Array.isArray(outline)) return [];
  const result: OutlineItem[] = [];

  const visit = async (entries: unknown[], level: number): Promise<void> => {
    for (const entry of entries) {
      if (result.length >= 1_000) return;
      if (!entry || typeof entry !== "object") continue;
      const value = entry as {
        title?: unknown;
        dest?: unknown;
        items?: unknown;
      };
      const title = typeof value.title === "string" ? value.title.trim().slice(0, 200) : "";
      let page: number | undefined;
      let valid = true;
      if (typeof value.dest === "string") {
        try {
          const destination = await pdf.getDestination(value.dest);
          if (Array.isArray(destination) && destination.length > 0) {
            const index = await pdf.getPageIndex(destination[0]);
            if (Number.isInteger(index) && index >= 0) page = index + 1;
          }
        } catch {
          valid = false;
        }
      } else if (Array.isArray(value.dest) && value.dest.length > 0) {
        try {
          const index = await pdf.getPageIndex(value.dest[0]);
          if (Number.isInteger(index) && index >= 0) page = index + 1;
        } catch {
          valid = false;
        }
      }
      if (title && valid)
        result.push({ title, level: Math.min(6, Math.max(1, level)), ...(page ? { page } : {}) });
      if (Array.isArray(value.items) && level < 6) await visit(value.items, level + 1);
    }
  };

  await visit(outline, 1);
  return result;
}

/** The deepest outline entry that starts on or before the page. */
export function sectionPathForPage(items: readonly OutlineItem[], page: number): string | null {
  if (!Number.isInteger(page) || page < 1) return null;
  const current = new Map<number, string>();
  for (const item of items) {
    if (item.page === undefined) continue;
    if (item.page > page) break;
    const level = Math.max(1, Math.min(6, item.level));
    current.set(level, item.title.trim().slice(0, 200));
    for (const key of [...current.keys()]) if (key > level) current.delete(key);
  }
  const path = [...current.entries()]
    .sort(([left], [right]) => left - right)
    .slice(0, 3)
    .map(([, title]) => title)
    .filter(Boolean)
    .join(" › ");
  return path ? path.slice(0, 200) : null;
}
