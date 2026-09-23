import { registerWebModule, NativeModule } from 'expo';

// ConuoPdfInkModule is not available on the web platform.
class ConuoPdfInkModule extends NativeModule<{}> {
  async extractPdfText() {
    throw new Error("PDFKit 文件导入只在 iOS 原生客户端提供。");
  }
}

export default registerWebModule(ConuoPdfInkModule, 'ConuoPdfInkModule');

export async function extractPdfText() {
  throw new Error("PDFKit 文件导入只在 iOS 原生客户端提供。");
}
