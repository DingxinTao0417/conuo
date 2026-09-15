import { z } from "zod";
import type { SourceKind } from "./types";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const timestamp = z.string().datetime({ offset: true });
export const searchScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("space"), spaceId: id }).strict(),
  z.object({ kind: z.literal("inbox") }).strict(),
  z.object({ kind: z.literal("all") }).strict(),
]);
export type SearchScope = z.infer<typeof searchScopeSchema>;

const range = z
  .object({ from: timestamp.optional(), to: timestamp.optional() })
  .strict()
  .refine((value) => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to));
export const searchRequestSchema = z
  .object({
    query: z.string().trim().max(4000),
    scope: searchScopeSchema,
    filters: z
      .object({
        types: z
          .array(z.enum(["pdf", "docx", "markdown", "text", "web", "note", "knowledge"]))
          .max(7)
          .optional(),
        tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
        /** Source-only exact favorite state. Omitted means unrestricted; notes have no state. */
        starred: z.boolean().optional(),
        /** Inclusive from, exclusive to; callers convert date-only UI values to ISO instants. */
        created: range.optional(),
        updated: range.optional(),
      })
      .strict()
      .optional(),
    includeDrafts: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type SearchRequest = z.infer<typeof searchRequestSchema>;

const candidate = {
  objectId: id,
  blockId: id.nullable(),
  score: z.number().finite().min(0).max(1_000_000),
};
export const searchCandidateSchema = z.discriminatedUnion("kind", [
  z.object({ ...candidate, kind: z.literal("source"), versionId: id }).strict(),
  z
    .object({
      ...candidate,
      kind: z.literal("note"),
      revision: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER - 1),
      updatedAt: timestamp,
    })
    .strict(),
  z
    .object({
      ...candidate,
      kind: z.literal("knowledge"),
      revision: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER - 1),
      updatedAt: timestamp,
    })
    .strict(),
]);
export const searchCandidatesSchema = z.array(searchCandidateSchema).max(500);
export type SearchCandidate = z.infer<typeof searchCandidateSchema>;

export interface SearchProvenance {
  origin: "original" | "user" | "ai";
  label: string;
  referenceState: "none" | "current" | "historical" | "unavailable";
  historicalCount: number;
  unavailableCount: number;
  aiRestrictedCount: number;
}

interface SearchHitFields {
  id: string;
  title: string;
  snippet: string;
  tags: string[];
  spaceIds: string[];
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  provenance: SearchProvenance;
  warnings: string[];
}

/** Search hits are navigable content records, never interchangeable with AI evidence/Citation. */
export type SearchHit = SearchHitFields &
  (
    | (Extract<SearchCandidate, { kind: "source" }> & {
        sourceKind: SourceKind;
        locator:
          { kind: "metadata" } | { kind: "chunk"; section: string; order: number; page?: number };
      })
    | (Exclude<SearchCandidate, { kind: "source" }> & {
        locator: { kind: "metadata" } | { kind: "note-block"; start: number; end: number };
      })
  );

export interface SearchResult {
  query: string;
  scope: SearchScope;
  hits: SearchHit[];
  /** One best block per object. Exact local object count; null for a remote candidate window. */
  total: number | null;
  hasMore: boolean;
}
