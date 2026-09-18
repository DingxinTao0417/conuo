export type CollectionCoverStyle = {
  "--collection-cover": string;
  "--collection-cover-text": string;
  "--collection-cover-muted": string;
};

type PaletteEntry = Pick<
  CollectionCoverStyle,
  "--collection-cover" | "--collection-cover-text" | "--collection-cover-muted"
>;

// These book-cover treatments are intentionally separate from the
// navigation selection color. A collection should keep its visual identity
// when its position in the shelf changes.
const COVER_PALETTE: readonly PaletteEntry[] = [
  {
    "--collection-cover": "#705bc2",
    "--collection-cover-text": "#ffffff",
    "--collection-cover-muted": "#f0ebff",
  },
  {
    "--collection-cover": "#cbdffd",
    "--collection-cover-text": "#204f89",
    "--collection-cover-muted": "#4b607d",
  },
  {
    "--collection-cover": "#c7e8dc",
    "--collection-cover-text": "#205f51",
    "--collection-cover-muted": "#486b60",
  },
  {
    "--collection-cover": "#f7d9c9",
    "--collection-cover-text": "#7d4530",
    "--collection-cover-muted": "#775444",
  },
  {
    "--collection-cover": "#f4e4b5",
    "--collection-cover-text": "#755522",
    "--collection-cover-muted": "#706039",
  },
  {
    "--collection-cover": "#e2d6f8",
    "--collection-cover-text": "#594187",
    "--collection-cover-muted": "#655184",
  },
];

function stablePaletteIndex(id: string): number {
  let value = 0;
  for (const character of id) value = (value * 31 + character.codePointAt(0)!) >>> 0;
  return value % COVER_PALETTE.length;
}

function isCustomColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value) && !["#4b3fe3", "#7865cf"].includes(value.toLowerCase());
}

/**
 * Derive a stable shelf treatment from the persisted collection identity.
 * A user-selected color remains a soft tint, while legacy/default colors use
 * a deterministic palette so adding or removing another collection is safe.
 */
export function collectionCoverStyle(spaceId: string, color: string): CollectionCoverStyle {
  if (isCustomColor(color)) {
    return {
      "--collection-cover": `color-mix(in srgb, ${color} 20%, var(--bg-base-secondary))`,
      "--collection-cover-text": "#333844",
      "--collection-cover-muted": "#4b505c",
    };
  }
  return { ...COVER_PALETTE[stablePaletteIndex(spaceId)] };
}

export const inboxCoverStyle: CollectionCoverStyle = {
  "--collection-cover": "#e1edf7",
  "--collection-cover-text": "#365c7b",
  "--collection-cover-muted": "#536b80",
};
