import { createHash } from 'crypto';

// ---------- Checksum ----------

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

// ---------- Quality report (T-027) ----------

export interface QualityReport {
  characters: number;
  words: number;
  pages: number | null;
  charsPerPage: number | null;
  issues: string[];
  passed: boolean;
}

const MIN_WORDS = 50;
const MIN_CHARS_PER_PAGE = 400; // below this a PDF is almost certainly a scan that needs OCR

export function assessQuality(text: string, pages: number | null): QualityReport {
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const issues: string[] = [];
  if (words === 0) issues.push('no_text_extracted');
  else if (words < MIN_WORDS) issues.push('very_little_text');
  const charsPerPage = pages && pages > 0 ? Math.round(trimmed.length / pages) : null;
  if (charsPerPage !== null && charsPerPage < MIN_CHARS_PER_PAGE) issues.push('low_text_density_possible_scan_needs_ocr');
  const replacement = (trimmed.match(/�/g) ?? []).length;
  if (trimmed.length > 0 && replacement / trimmed.length > 0.01) issues.push('encoding_errors');
  return { characters: trimmed.length, words, pages, charsPerPage, issues, passed: issues.length === 0 };
}

// ---------- Metadata validation (T-028) ----------

export interface MetadataFields {
  title?: string | null;
  type?: string | null;
  documentDate?: Date | null;
  language?: string | null;
  sittingId?: string | null;
  billId?: string | null;
  sensitivity?: string | null;
}

export interface MetadataIssue {
  field: string;
  message: string;
}

const LANGS = new Set(['en', 'tw', 'ee', 'gaa', 'dag', 'ha']);

/** Fields every document must have before it can leave REVIEW. */
export function validateMetadata(d: MetadataFields, now = new Date()): MetadataIssue[] {
  const out: MetadataIssue[] = [];
  if (!d.title || d.title.trim().length < 3) out.push({ field: 'title', message: 'Title is required' });
  if (!d.type) out.push({ field: 'type', message: 'Document type is required' });
  if (!d.documentDate) out.push({ field: 'documentDate', message: 'Document date is required' });
  else if (d.documentDate.getTime() > now.getTime() + 24 * 3600 * 1000) out.push({ field: 'documentDate', message: 'Document date cannot be in the future' });
  if (!d.language || !LANGS.has(d.language)) out.push({ field: 'language', message: `Language must be one of ${[...LANGS].join(', ')}` });
  if (d.type === 'HANSARD' && !d.sittingId) out.push({ field: 'sittingId', message: 'Hansard records must be linked to a sitting' });
  if (!d.sensitivity) out.push({ field: 'sensitivity', message: 'Sensitivity classification is required' });
  return out;
}

// ---------- Chunking (T-029) ----------

export interface ChunkDraft {
  sequence: number;
  text: string;
  anchor: string;
}

const MAX_CHARS = 1200;

/**
 * Splits on paragraph boundaries (speaker turns in Hansard are paragraphs), packing
 * paragraphs up to MAX_CHARS and splitting oversized ones on sentence boundaries.
 * The anchor records which paragraphs the chunk covers so citations can point back.
 */
export function chunkText(text: string, maxChars = MAX_CHARS): ChunkDraft[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const pieces: { text: string; para: number }[] = [];
  paragraphs.forEach((p, i) => {
    if (p.length <= maxChars) return void pieces.push({ text: p, para: i + 1 });
    let buf = '';
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if (sentence.length > maxChars) {
        if (buf) pieces.push({ text: buf, para: i + 1 }), (buf = '');
        for (let k = 0; k < sentence.length; k += maxChars) pieces.push({ text: sentence.slice(k, k + maxChars), para: i + 1 });
      } else if ((buf + ' ' + sentence).trim().length > maxChars) {
        pieces.push({ text: buf, para: i + 1 });
        buf = sentence;
      } else buf = (buf + ' ' + sentence).trim();
    }
    if (buf) pieces.push({ text: buf, para: i + 1 });
  });

  const chunks: ChunkDraft[] = [];
  let cur: { text: string; first: number; last: number } | null = null;
  const flush = () => {
    if (!cur) return;
    chunks.push({
      sequence: chunks.length,
      text: cur.text,
      anchor: cur.first === cur.last ? `paragraph ${cur.first}` : `paragraphs ${cur.first}-${cur.last}`,
    });
    cur = null;
  };
  for (const piece of pieces) {
    if (cur && cur.text.length + 2 + piece.text.length > maxChars) flush();
    cur = cur ? { text: `${cur.text}\n\n${piece.text}`, first: cur.first, last: piece.para } : { text: piece.text, first: piece.para, last: piece.para };
  }
  flush();
  return chunks;
}

// ---------- Embedding (T-029) ----------

export abstract class Embedder {
  abstract readonly version: string;
  abstract embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic feature-hashing embedder. It is a development/test default that gives
 * lexical-overlap similarity with no external service. It is NOT a semantic model:
 * production must bind a real Embedder once the model provider is decided (Phase 0 ADR).
 */
export class HashingEmbedder extends Embedder {
  readonly version = 'hashing-v1-256';
  constructor(private readonly dim = 256) {
    super();
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dim).fill(0);
      for (const tok of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        const h = createHash('md5').update(tok).digest();
        v[h.readUInt16BE(0) % this.dim] += h[2] % 2 ? 1 : -1;
      }
      return normalise(v);
    });
  }
}

export function normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s;
}
