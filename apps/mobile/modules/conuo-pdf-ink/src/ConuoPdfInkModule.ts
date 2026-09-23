import { NativeModule, requireNativeModule } from 'expo';

export type PdfTextExtraction = {
  pageCount: number;
  pages: string[];
};

export type PdfPageThumb = {
  /** Base64 JPEG without the data: prefix. */
  jpeg: string;
  /** cropBox width / height — landscape pages stay landscape in the rail. */
  aspectRatio: number;
};

export type PdfPageThumbnails = {
  pageCount: number;
  pages: PdfPageThumb[];
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
