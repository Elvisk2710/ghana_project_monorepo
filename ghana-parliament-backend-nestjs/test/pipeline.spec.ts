import { canTransition, isPubliclyVisible } from '../src/documents/lifecycle';
import { assessQuality, chunkText, cosine, HashingEmbedder, sha256, validateMetadata } from '../src/documents/pipeline';
import { backoffMs } from '../src/jobs/jobs.service';

describe('lifecycle', () => {
  it('allows the documented path and nothing else', () => {
    expect(canTransition('DRAFT', 'PROCESSING')).toBe(true);
    expect(canTransition('PROCESSING', 'REVIEW')).toBe(true);
    expect(canTransition('REVIEW', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'PUBLISHED')).toBe(true);
    expect(canTransition('DRAFT', 'PUBLISHED')).toBe(false);
    expect(canTransition('REVIEW', 'PUBLISHED')).toBe(false);
    expect(canTransition('REJECTED', 'APPROVED')).toBe(false);
    expect(canTransition('SUPERSEDED', 'PUBLISHED')).toBe(false);
  });
  it('supports rollback PUBLISHED -> APPROVED', () => expect(canTransition('PUBLISHED', 'APPROVED')).toBe(true));
  it('only PUBLISHED + flagged is publicly visible', () => {
    expect(isPubliclyVisible('PUBLISHED', true)).toBe(true);
    expect(isPubliclyVisible('PUBLISHED', false)).toBe(false);
    expect(isPubliclyVisible('APPROVED', true)).toBe(false);
    expect(isPubliclyVisible('REJECTED', false)).toBe(false);
  });
});

describe('quality report', () => {
  it('flags empty and thin text', () => {
    expect(assessQuality('', 3).issues).toContain('no_text_extracted');
    expect(assessQuality('too short', null).issues).toContain('very_little_text');
  });
  it('flags probable scans by text density', () => {
    const r = assessQuality('word '.repeat(60), 10);
    expect(r.issues).toContain('low_text_density_possible_scan_needs_ocr');
    expect(r.passed).toBe(false);
  });
  it('passes substantial text', () => expect(assessQuality('lorem ipsum '.repeat(400), 2).passed).toBe(true));
});

describe('metadata validation', () => {
  const ok = { title: 'Petroleum Pricing', type: 'HANSARD', documentDate: new Date('2024-03-14'), language: 'en', sittingId: 's1', sensitivity: 'public' };
  it('accepts complete metadata', () => expect(validateMetadata(ok)).toEqual([]));
  it('reports each missing field', () => {
    const fields = validateMetadata({}).map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(['title', 'type', 'documentDate', 'language', 'sensitivity']));
  });
  it('requires a sitting for Hansards and rejects future dates and unknown languages', () => {
    expect(validateMetadata({ ...ok, sittingId: null }).map((i) => i.field)).toContain('sittingId');
    expect(validateMetadata({ ...ok, documentDate: new Date(Date.now() + 10 * 864e5) }).map((i) => i.field)).toContain('documentDate');
    expect(validateMetadata({ ...ok, language: 'xx' }).map((i) => i.field)).toContain('language');
  });
});

describe('chunking', () => {
  it('keeps paragraphs together, numbers anchors and respects max size', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1}. ` + 'The Honourable Member spoke at length. '.repeat(8)).join('\n\n');
    const chunks = chunkText(text, 600);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.sequence).toBe(i);
      expect(c.text.length).toBeLessThanOrEqual(600);
      expect(c.anchor).toMatch(/^paragraphs? \d+/);
    });
    expect(chunks.map((c) => c.text).join('\n\n')).toContain('Paragraph 10.');
  });
  it('splits an oversized single sentence and returns nothing for blank input', () => {
    expect(chunkText('x'.repeat(2500), 1000).length).toBe(3);
    expect(chunkText('  \n\n  ')).toEqual([]);
  });
  it('is deterministic (idempotent re-indexing)', () => {
    const t = 'a b c.\n\nd e f.\n\n' + 'g '.repeat(900);
    expect(chunkText(t)).toEqual(chunkText(t));
  });
});

describe('embedder and checksum', () => {
  it('is deterministic and ranks lexical overlap higher', async () => {
    const e = new HashingEmbedder();
    const [a, b, c] = await e.embed(['fuel price regulation debate', 'fuel price regulation', 'agricultural subsidy for cocoa farmers']);
    expect(await e.embed(['fuel price regulation'])).toEqual([b]);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });
  it('sha256 is stable', () => expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
});

describe('job backoff', () => {
  it('grows exponentially and caps', () => {
    expect(backoffMs(1)).toBe(5000);
    expect(backoffMs(2)).toBe(10000);
    expect(backoffMs(3)).toBe(20000);
    expect(backoffMs(20)).toBe(15 * 60000);
  });
});
