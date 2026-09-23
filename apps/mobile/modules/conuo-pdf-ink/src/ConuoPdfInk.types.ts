import type { StyleProp, ViewStyle } from "react-native";

export type PageChangedEvent = {
  page: number;
  pageCount: number;
};

export type DrawingChangedEvent = {
  page: number;
  strokeCount: number;
  isEmpty: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

export type ZoomChangedEvent = {
  scaleFactor: number;
};

export type LocalSnapshotEvent = {
  page: number;
  drawingFileUri: string;
  drawingBytes: number;
  drawingSha256: string;
  previewFileUri: string;
  previewBytes: number;
  previewSha256: string;
  coordinateSpace: { version: 1; space: "pdf-crop-box" };
};

export type InkTool = "pen" | "pencil" | "highlighter" | "eraser" | "lasso";

export type ConuoPdfInkViewProps = {
  style?: StyleProp<ViewStyle>;
  /** Local file URI only. An empty value loads the safe, generated WP0 fixture. */
  documentUri?: string;
  /** Account-isolated digest used for local recovery files. */
  snapshotNamespace?: string;
  allowsFingerDrawing?: boolean;
  annotationMode?: boolean;
  displayMode?: "continuous" | "single";
  selectedTool?: InkTool;
  selectedColor?: string;
  currentPage?: number;
  zoomStep?: number;
  undoToken?: number;
  redoToken?: number;
  onPageChanged?: (event: { nativeEvent: PageChangedEvent }) => void;
  onDrawingChanged?: (event: { nativeEvent: DrawingChangedEvent }) => void;
  onZoomChanged?: (event: { nativeEvent: ZoomChangedEvent }) => void;
  onLocalSnapshot?: (event: { nativeEvent: LocalSnapshotEvent }) => void;
};
