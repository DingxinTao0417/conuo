import type { ComparisonRoute } from "./comparison-route";
import { getSourceVersion } from "./source-versions";
import type { Source, Space, WorkspaceData } from "./types";

export type ComparisonSide = "left" | "right";

/**
 * A route can become unavailable after it was copied: a learning space may be
 * archived, a source can be moved to the recycle bin, or a retained version
 * may no longer exist. Keep the reason structured so the comparison screen
 * can explain the exact recovery action without attempting a fallback read.
 */
export type ComparisonSourcesUnavailableReason =
  | "same-source"
  | "space-missing"
  | "space-archived"
  | "source-missing"
  | "source-recycled"
  | "source-not-in-space"
  | "version-missing";

/** A source as it existed at the exact version named in the route. */
export interface ResolvedComparisonSource {
  source: Source;
  isCurrentVersion: boolean;
}

/** Both sides are safe for a read-only comparison view. */
export interface ResolvedComparisonSources {
  ok: true;
  space: Space;
  left: ResolvedComparisonSource;
  right: ResolvedComparisonSource;
}

/** No source or version data is exposed when the route is no longer readable. */
export interface UnavailableComparisonSources {
  ok: false;
  reason: ComparisonSourcesUnavailableReason;
  /** Present when one particular side made an otherwise valid route unavailable. */
  side?: ComparisonSide;
}

export type ComparisonSourcesResolution = ResolvedComparisonSources | UnavailableComparisonSources;

function unavailable(
  reason: ComparisonSourcesUnavailableReason,
  side?: ComparisonSide,
): UnavailableComparisonSources {
  return side ? { ok: false, reason, side } : { ok: false, reason };
}

function resolveSide(
  data: WorkspaceData,
  route: ComparisonRoute,
  side: ComparisonSide,
): ResolvedComparisonSource | UnavailableComparisonSources {
  const sourceId = side === "left" ? route.leftSourceId : route.rightSourceId;
  const versionId = side === "left" ? route.leftVersionId : route.rightVersionId;
  // A permanently deleted source is absent from workspace data; both that
  // case and a never-existing ID are intentionally treated as unavailable.
  const current = data.sources.find((source) => source.id === sourceId);
  if (!current) return unavailable("source-missing", side);
  if (current.deletedAt) return unavailable("source-recycled", side);
  if (!current.spaceIds.includes(route.spaceId)) return unavailable("source-not-in-space", side);

  // Never fall through to the current source when a historical snapshot is
  // missing. `getSourceVersion` also rejects ambiguous retained IDs.
  const source = getSourceVersion(current, versionId);
  if (!source || source.id !== sourceId || source.versionId !== versionId)
    return unavailable("version-missing", side);

  return { source, isCurrentVersion: current.versionId === versionId };
}

/**
 * Resolves one canonical comparison route against its current workspace
 * snapshot. The function deliberately validates the route again even though
 * it normally comes from `parseComparisonRoute`, because a copied URL can be
 * stale and callers can construct this data directly.
 *
 * The returned sources are exact snapshots, never a best-effort replacement
 * with the latest version. Recycled and permanently deleted sources cannot be
 * used as comparison input.
 */
export function resolveComparisonSources(
  data: WorkspaceData,
  route: ComparisonRoute,
): ComparisonSourcesResolution {
  if (route.leftSourceId === route.rightSourceId) return unavailable("same-source");

  const space = data.spaces.find((item) => item.id === route.spaceId);
  if (!space) return unavailable("space-missing");
  if (space.archived) return unavailable("space-archived");

  const left = resolveSide(data, route, "left");
  if ("ok" in left) return left;
  const right = resolveSide(data, route, "right");
  if ("ok" in right) return right;

  return { ok: true, space, left, right };
}
