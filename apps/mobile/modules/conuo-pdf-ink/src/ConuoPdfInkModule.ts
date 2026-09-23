import { NativeModule, requireNativeModule } from 'expo';

export type PdfTextExtraction = {
  pageCount: number;
  pages: string[];
};

type ConuoPdfInkModuleType = NativeModule<{}> & {
  extractPdfText(uri: string): Promise<PdfTextExtraction>;
};

const module = requireNativeModule<ConuoPdfInkModuleType>('ConuoPdfInk');

export async function extractPdfText(uri: string) {
  return module.extractPdfText(uri);
}

export default module;
