import { registerWebModule, NativeModule } from 'expo';

// ConuoPdfInkModule is not available on the web platform.
class ConuoPdfInkModule extends NativeModule<{}> {
  async extractPdfText() {
    throw new Error("PDFKit 文件导入只在 iOS 原生客户端提供。");
  }

  async extractPdfPageThumbnails(): Promise<{
    pageCount: number;
    pages: { jpeg: string; aspectRatio: number }[];
  }> {
    return { pageCount: 0, pages: [] };
  }
}

export default registerWebModule(ConuoPdfInkModule, 'ConuoPdfInkModule');

export type PdfTextExtraction = {
  pageCount: number;
  pages: string[];
};

export type PdfPageThumb = {
  jpeg: string;
  aspectRatio: number;
};

export type PdfPageThumbnails = {
  pageCount: number;
  pages: PdfPageThumb[];
};

export async function extractPdfText() {
  throw new Error("PDFKit 文件导入只在 iOS 原生客户端提供。");
}

export async function extractPdfPageThumbnails(): Promise<PdfPageThumbnails> {
  return { pageCount: 0, pages: [] };
}
