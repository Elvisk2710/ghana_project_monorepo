import { Injectable, UnsupportedMediaTypeException } from '@nestjs/common';

export interface Extracted {
  text: string;
  pages: number | null;
}

export const SUPPORTED_TYPES = ['application/pdf', 'text/plain'];

export abstract class TextExtractor {
  abstract extract(data: Buffer, mimeType: string): Promise<Extracted>;
}

/**
 * Plain text and born-digital PDF extraction. Scanned PDFs yield little text and are
 * flagged by the quality report; OCR is a pluggable extension (separate TextExtractor).
 */
@Injectable()
export class DefaultTextExtractor extends TextExtractor {
  async extract(data: Buffer, mimeType: string): Promise<Extracted> {
    if (mimeType === 'text/plain') return { text: data.toString('utf8'), pages: null };
    if (mimeType === 'application/pdf') {
      // Imported lazily and from the inner module to avoid pdf-parse's debug-mode file read on import.
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js' as string)).default as (b: Buffer) => Promise<{ text: string; numpages: number }>;
      const out = await pdfParse(data);
      return { text: out.text, pages: out.numpages };
    }
    throw new UnsupportedMediaTypeException(`Unsupported file type ${mimeType}. Supported: ${SUPPORTED_TYPES.join(', ')}`);
  }
}
