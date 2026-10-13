import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { DocumentType, Prisma } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { rate } from '../common/rate';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from './search.service';

/** Public API surface: published records only, no authentication, stricter rate limits. */
@Public()
@Controller('public')
export class PublicController {
  constructor(
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('search')
  @Throttle(rate(30))
  async doSearch(@Query('q') q?: string, @Query('language') language?: string, @Query('limit') limit?: string) {
    if (!q || q.trim().length < 2) throw new BadRequestException('q must be at least 2 characters');
    if (q.length > 500) throw new BadRequestException('q is too long');
    return { query: q, results: (await this.search.search({ q, language, limit: limit ? parseInt(limit, 10) : undefined })).map(({ text, ...hit }) => hit) };
  }

  /** Browse published records. Deterministic order (date desc, then ID), filterable and paginated. */
  @Get('documents')
  @Throttle(rate(60))
  async list(@Query() q: Record<string, string>) {
    const page = Math.max(parseInt(q.page ?? '1', 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(q.pageSize ?? '20', 10) || 20, 1), 50);
    const type = (Object.values(DocumentType) as string[]).includes(q.type) ? (q.type as DocumentType) : undefined;
    const dateOk = (v?: string) => (v && !Number.isNaN(new Date(v).getTime()) ? new Date(v) : undefined);
    const from = dateOk(q.from);
    const to = dateOk(q.to);
    if ((q.from && !from) || (q.to && !to)) throw new BadRequestException('from/to must be valid dates');
    const term = q.q?.trim().slice(0, 200);
    const where: Prisma.ParliamentaryDocumentWhereInput = {
      lifecycle: 'PUBLISHED',
      isPublished: true,
      type,
      language: q.language,
      documentDate: from || to ? { gte: from, lte: to } : undefined,
      ...(term ? { title: { contains: term, mode: 'insensitive' } } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.parliamentaryDocument.count({ where }),
      this.prisma.parliamentaryDocument.findMany({
        where,
        select: { publicId: true, title: true, type: true, documentDate: true, language: true, publishedAt: true },
        orderBy: [{ documentDate: { sort: 'desc', nulls: 'last' } }, { publicId: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
  }

  /** Source inspection: the exact passage a citation points to. */
  @Get('documents/:publicId/passages')
  @Throttle(rate(60))
  async passages(@Param('publicId') publicId: string, @Query('anchor') anchor?: string) {
    if (!anchor) throw new BadRequestException('anchor is required');
    const doc = await this.prisma.parliamentaryDocument.findFirst({
      where: { publicId, lifecycle: 'PUBLISHED', isPublished: true },
      select: { id: true, version: true, title: true, documentDate: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    const chunks = await this.prisma.documentChunk.findMany({
      where: { documentId: doc.id, documentVersion: doc.version, anchor },
      orderBy: { sequence: 'asc' },
      select: { anchor: true, text: true },
    });
    if (!chunks.length) throw new NotFoundException('Passage not found');
    return { documentId: publicId, title: doc.title, date: doc.documentDate, passages: chunks };
  }

  @Get('documents/:publicId')
  @Throttle(rate(60))
  async document(@Param('publicId') publicId: string) {
    const d = await this.prisma.parliamentaryDocument.findFirst({
      where: { publicId, lifecycle: 'PUBLISHED', isPublished: true },
      select: { publicId: true, title: true, type: true, documentDate: true, language: true, version: true, publishedAt: true, extractedText: true },
    });
    if (!d) throw new NotFoundException('Document not found');
    return d;
  }
}
