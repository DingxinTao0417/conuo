export type CollectionCoverStyle = {
  "--collection-cover": string;
  "--collection-cover-text": string;
  "--collection-cover-muted": string;
};

type PaletteEntry = Pick<
  CollectionCoverStyle,
  "--collection-cover" | "--collection-cover-text" | "--collection-cover-muted"
>;

// These quiet book-cover treatments are intentionally separate from the
// navigation selection color. A collection should keep its visual identity
// when its position in the shelf changes.
const COVER_PALETTE: readonly PaletteEntry[] = [
  {
    "--collection-cover": "#7865cf",
    "--collection-cover-text": "#ffffff",
    "--collection-cover-muted": "#eee9ff",
  },
  {
    "--collection-cover": "#d5e0ed",
    "--collection-cover-text": "#354253",
    "--collection-cover-muted": "#617081",
  },
  {
    "--collection-cover": "#dce7e1",
    "--collection-cover-text": "#354253",
    "--collection-cover-muted": "#617081",
  },
  {
    "--collection-cover": "#e3e3e8",
    "--collection-cover-text": "#354253",
    "--collection-cover-muted": "#617081",
  },
  {
    "--collection-cover": "#e9e1d6",
    "--collection-cover-text": "#354253",
    "--collection-cover-muted": "#617081",
  },
  {
    "--collection-cover": "#dcdfee",
    "--collection-cover-text": "#354253",
    "--collection-cover-muted": "#617081",
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
      "--collection-cover-text": "var(--text-secondary)",
      "--collection-cover-muted": "var(--text-tertiary)",
    };
  }
  return { ...COVER_PALETTE[stablePaletteIndex(spaceId)] };
}

export const inboxCoverStyle: CollectionCoverStyle = {
  "--collection-cover": "var(--bg-base-tertiary)",
  "--collection-cover-text": "var(--text-secondary)",
  "--collection-cover-muted": "var(--text-tertiary)",
};
