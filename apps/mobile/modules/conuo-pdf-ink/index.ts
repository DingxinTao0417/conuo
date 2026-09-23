// Re-export the native module. On web, it will be resolved to ConuoPdfInkModule.web.ts
// and on native platforms to ConuoPdfInkModule.ts
export { default } from './src/ConuoPdfInkModule';
export { extractPdfText, extractPdfPageThumbnails } from './src/ConuoPdfInkModule';
export type { PdfPageThumbnails, PdfTextExtraction } from './src/ConuoPdfInkModule';
export { default as ConuoPdfInkView } from './src/ConuoPdfInkView';
export * from './src/ConuoPdfInk.types';
