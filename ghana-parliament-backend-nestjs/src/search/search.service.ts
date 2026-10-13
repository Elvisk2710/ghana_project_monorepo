import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { cosine, Embedder } from '../documents/pipeline';
import { PrismaService } from '../prisma/prisma.service';

export interface SearchParams {
  q: string;
  limit?: number;
  language?: string;
  from?: Date;
  to?: Date;
}

export interface SearchHit {
  documentId: string;
  title: string;
  date: string | null;
  anchor: string | null;
  snippet: string;
  /** Full chunk text (used for answer generation; not returned by the public search API). */
  text: string;
  score: number;
  indexVersion: string | null;
}

const STOPWORDS = new Set(
  'a an and are as at be been but by did do does for from had has have how i if in into is it its me my of on or our parliament say said says so than that the their them then there these they this to was we were what when where which who whom why will with would you your about'.split(' '),
);
const tokens = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * While the placeholder hashing embedder is bound, a chunk must share at least one meaningful
 * (non-stopword) term with the question to count as evidence. Without this, filler words alone
 * could "ground" an unrelated question. Set SEARCH_REQUIRE_LEXICAL=false only once a real
 * semantic embedder with evaluated recall is in place.
 */
const requireLexical = () => process.env.SEARCH_REQUIRE_LEXICAL !== 'false';

interface CachedChunk {
  anchor: string | null;
  text: string;
  words: Set<string>;
  embedding: number[];
  indexVersion: string | null;
}
interface CachedDoc {
  version: number;
  chunks: CachedChunk[];
}

const MAX_CACHED_CHUNKS = 100_000;

/**
 * Hybrid retrieval over PUBLISHED documents only.
 *
 * Chunk content is cached in memory (it is immutable per document version), but the set of
 * documents that may be served is re-read from the database on every request. A document that is
 * unpublished, superseded or re-versioned therefore stops being retrievable immediately, and a
 * newly published one is loaded on first use. The published filter is applied in the query, so
 * drafts, rejected and unpublished records can never be returned.
 *
 * Scoring blends vector similarity with keyword overlap and runs in the application, which is
 * fine for the pilot corpus; move to pgvector or a search engine when that technology is chosen.
 */
@Injectable()
export class SearchService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SearchService.name);
  private readonly cache = new Map<string, CachedDoc>();
  private cachedChunks = 0;
  /** Single-flight guard: concurrent requests share one cache load instead of stampeding the database. */
  private loading: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedder: Embedder,
  ) {}

  /** Warm the cache in the background at start-up so the first public request is not slow. */
  onApplicationBootstrap(): void {
    if (process.env.SEARCH_WARMUP === 'false') return;
    void this.prisma.parliamentaryDocument
      .findMany({ where: { lifecycle: 'PUBLISHED', isPublished: true }, select: { id: true, version: true } })
      .then((docs) => this.chunksFor(docs))
      .catch((e) => this.logger.warn(`Search warm-up skipped: ${(e as Error).message}`));
  }

  private async chunksFor(docs: { id: string; version: number }[]): Promise<Map<string, CachedChunk[]>> {
    const live = new Set(docs.map((d) => d.id));
    for (const [id, c] of this.cache) {
      if (!live.has(id)) { this.cachedChunks -= c.chunks.length; this.cache.delete(id); }
    }
    const stale = () => docs.filter((d) => this.cache.get(d.id)?.version !== d.version);
    while (stale().length) {
      if (this.loading) { await this.loading; continue; }
      const missing = stale();
      this.loading = this.load(missing).finally(() => { this.loading = null; });
      await this.loading;
    }
    return new Map(docs.map((d) => [d.id, this.cache.get(d.id)!.chunks]));
  }

  private async load(missing: { id: string; version: number }[]): Promise<void> {
    if (this.cachedChunks > MAX_CACHED_CHUNKS) {
      this.logger.warn('Search cache limit reached; clearing');
      this.cache.clear();
      this.cachedChunks = 0;
    }
    const wanted = new Map(missing.map((d) => [d.id, d.version]));
    const rows = await this.prisma.documentChunk.findMany({
      where: { documentId: { in: [...wanted.keys()] } },
      orderBy: [{ documentId: 'asc' }, { sequence: 'asc' }],
      select: { documentId: true, documentVersion: true, anchor: true, text: true, embedding: true, indexVersion: true },
    });
    const byDoc = new Map<string, CachedChunk[]>();
    for (const r of rows) {
      if (r.documentVersion !== wanted.get(r.documentId)) continue; // only the currently published version
      const list = byDoc.get(r.documentId) ?? [];
      list.push({ anchor: r.anchor, text: r.text, words: new Set(tokens(r.text)), embedding: r.embedding, indexVersion: r.indexVersion });
      byDoc.set(r.documentId, list);
    }
    for (const d of missing) {
      const old = this.cache.get(d.id);
      if (old) this.cachedChunks -= old.chunks.length;
      const chunks = byDoc.get(d.id) ?? [];
      this.cache.set(d.id, { version: d.version, chunks });
      this.cachedChunks += chunks.length;
    }
  }

  async search(p: SearchParams): Promise<SearchHit[]> {
    const q = p.q.trim();
    if (!q) return [];
    const limit = Math.min(Math.max(p.limit ?? 10, 1), 25);

    // Authoritative, per-request: which documents are published right now.
    const published = await this.prisma.parliamentaryDocument.findMany({
      where: { lifecycle: 'PUBLISHED', isPublished: true },
      select: { id: true, publicId: true, title: true, documentDate: true, version: true, language: true },
    });
    const eligible = published.filter((d) =>
      (!p.language || d.language === p.language) &&
      (!p.from || (d.documentDate && d.documentDate >= p.from)) &&
      (!p.to || (d.documentDate && d.documentDate <= p.to)));
    if (!eligible.length) return [];
    const byDoc = await this.chunksFor(published.map((d) => ({ id: d.id, version: d.version })));

    const [qv] = await this.embedder.embed([q]);
    const allTerms = tokens(q);
    const content = allTerms.filter((t) => !STOPWORDS.has(t));
    const terms = [...new Set(content.length ? content : allTerms)];
    const gate = requireLexical();

    const scored: { d: (typeof eligible)[number]; c: CachedChunk; score: number }[] = [];
    for (const d of eligible) {
      for (const c of byDoc.get(d.id) ?? []) {
        let hit = 0;
        for (const t of terms) if (c.words.has(t)) hit++;
        if (gate && hit === 0) continue;
        const keyword = terms.length ? hit / terms.length : 0;
        const score = 0.6 * Math.max(cosine(qv, c.embedding), 0) + 0.4 * keyword;
        if (score > 0.05) scored.push({ d, c, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ d, c, score }) => ({
      documentId: d.publicId,
      title: d.title,
      date: d.documentDate ? d.documentDate.toISOString().slice(0, 10) : null,
      anchor: c.anchor,
      snippet: c.text.slice(0, 300),
      text: c.text,
      score: Math.round(score * 1000) / 1000,
      indexVersion: c.indexVersion,
    }));
  }
}
