/** A shareable, client-side route for opening two source versions side by side. */
export interface ComparisonRoute {
  leftSourceId: string;
  leftVersionId: string;
  rightSourceId: string;
  rightVersionId: string;
  spaceId: string;
}

function decodeRequiredSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const decoded = decodeURIComponent(value);
    return decoded ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isValidRoute(route: ComparisonRoute): boolean {
  return (
    typeof route.leftSourceId === "string" &&
    typeof route.leftVersionId === "string" &&
    typeof route.rightSourceId === "string" &&
    typeof route.rightVersionId === "string" &&
    typeof route.spaceId === "string" &&
    Boolean(route.leftSourceId) &&
    Boolean(route.leftVersionId) &&
    Boolean(route.rightSourceId) &&
    Boolean(route.rightVersionId) &&
    Boolean(route.spaceId) &&
    route.leftSourceId !== route.rightSourceId
  );
}

/**
 * Parses only the canonical comparison fragment. A comparison always belongs
 * to one space and contains two distinct sources, so malformed or incomplete
 * fragments are deliberately ignored instead of guessing at an adjacent view.
 */
export function parseComparisonRoute(hash: string): ComparisonRoute | undefined {
  if (typeof hash !== "string" || !hash.startsWith("#")) return undefined;

  const fragment = hash.slice(1);
  const queryStart = fragment.indexOf("?");
  if (queryStart === -1) return undefined;

  const path = fragment.slice(0, queryStart).split("/");
  if (
    path.length !== 8 ||
    path[0] !== "compare" ||
    path[2] !== "version" ||
    path[4] !== "with" ||
    path[6] !== "version"
  ) {
    return undefined;
  }

  const query = fragment.slice(queryStart + 1);
  if (!query.startsWith("space=") || query.includes("&")) return undefined;

  const leftSourceId = decodeRequiredSegment(path[1]);
  const leftVersionId = decodeRequiredSegment(path[3]);
  const rightSourceId = decodeRequiredSegment(path[5]);
  const rightVersionId = decodeRequiredSegment(path[7]);
  const spaceId = decodeRequiredSegment(query.slice("space=".length));
  if (!leftSourceId || !leftVersionId || !rightSourceId || !rightVersionId || !spaceId)
    return undefined;

  const route: ComparisonRoute = {
    leftSourceId,
    leftVersionId,
    rightSourceId,
    rightVersionId,
    spaceId,
  };
  return isValidRoute(route) ? route : undefined;
}

/** Returns the canonical, percent-encoded fragment for a source comparison. */
export function formatComparisonRoute(route: ComparisonRoute): string {
  if (!isValidRoute(route)) {
    throw new Error("A comparison route needs two distinct sources, versions, and a space.");
  }

  return `#compare/${encodeURIComponent(route.leftSourceId)}/version/${encodeURIComponent(
    route.leftVersionId,
  )}/with/${encodeURIComponent(route.rightSourceId)}/version/${encodeURIComponent(
    route.rightVersionId,
  )}?space=${encodeURIComponent(route.spaceId)}`;
}
