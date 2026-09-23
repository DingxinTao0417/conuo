import { registerWebModule, NativeModule } from 'expo';

// ConuoPdfInkModule is not available on the web platform.
class ConuoPdfInkModule extends NativeModule<{}> {
  async extractPdfText() {
    throw new Error("PDFKit 文件导入只在 iOS 原生客户端提供。");
  }

  async extractPdfPageThumbnails(): Promise<{
    pageCount: number;
    thumbnails: string[];
  }> {
    return { pageCount: 0, thumbnails: [] };
  }
}

export default registerWebModule(ConuoPdfInkModule, 'ConuoPdfInkModule');

export type PdfTextExtraction = {
  pageCount: number;
  pages: string[];
};

export type PdfPageThumbnails = {
  pageCount: number;
  thumbnails: string[];
};

export async function extractPdfText() {
  throw new Error("PDFKit 文件导入只在 iOS 原生客户端提供。");
}

export async function extractPdfPageThumbnails(): Promise<PdfPageThumbnails> {
  return { pageCount: 0, thumbnails: [] };
}
