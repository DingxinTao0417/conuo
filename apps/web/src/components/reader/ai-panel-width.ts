export const AI_PANEL_DEFAULT_WIDTH = 380;
export const AI_PANEL_LANDSCAPE_TABLET_WIDTH = 360;
export const AI_PANEL_MIN_WIDTH = 320;
export const AI_PANEL_MAX_WIDTH = 520;
export const AI_PANEL_KEYBOARD_STEP = 16;
export const AI_PANEL_RESIZER_WIDTH = 12;
export const AI_PANEL_MIN_DOCUMENT_WIDTH = 560;

export function maxAiPanelWidthForWorkspace(workspaceWidth: number | null | undefined) {
  if (!workspaceWidth || !Number.isFinite(workspaceWidth)) return AI_PANEL_MAX_WIDTH;
  return Math.min(
    AI_PANEL_MAX_WIDTH,
    Math.max(
      AI_PANEL_MIN_WIDTH,
      Math.floor(workspaceWidth) - AI_PANEL_RESIZER_WIDTH - AI_PANEL_MIN_DOCUMENT_WIDTH,
    ),
  );
}

export function defaultAiPanelWidthForViewport(viewportWidth: number | null | undefined) {
  if (
    viewportWidth &&
    Number.isFinite(viewportWidth) &&
    viewportWidth >= 1025 &&
    viewportWidth <= 1199
  ) {
    return AI_PANEL_LANDSCAPE_TABLET_WIDTH;
  }
  return AI_PANEL_DEFAULT_WIDTH;
}

export function clampAiPanelWidth(width: number, maximum = AI_PANEL_MAX_WIDTH) {
  return Math.min(maximum, Math.max(AI_PANEL_MIN_WIDTH, Math.round(width)));
}
