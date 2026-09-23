import { NativeModule, requireNativeModule } from 'expo';

export type PdfTextExtraction = {
  pageCount: number;
  pages: string[];
};

export type PdfPageThumbnails = {
  pageCount: number;
  /** Base64 JPEG per page (1-based order); empty string when a page failed. */
  thumbnails: string[];
};

type ConuoPdfInkModuleType = NativeModule<{}> & {
  extractPdfText(uri: string): Promise<PdfTextExtraction>;
  extractPdfPageThumbnails(uri: string, maxWidth: number): Promise<PdfPageThumbnails>;
};

const module = requireNativeModule<ConuoPdfInkModuleType>('ConuoPdfInk');

export async function extractPdfText(uri: string) {
  return module.extractPdfText(uri);
}

export async function extractPdfPageThumbnails(uri: string, maxWidth = 120) {
  return module.extractPdfPageThumbnails(uri, maxWidth);
}

export default module;
