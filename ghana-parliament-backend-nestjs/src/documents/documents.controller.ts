import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentLifecycle, DocumentType, Role } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { Audit } from '../audit/audit.interceptor';
import { CurrentUser } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import type { RequestStore } from '../common/request-context';
import { Roles } from '../rbac/rbac';
import { SUPPORTED_TYPES } from './extractor';
import { DocumentsService } from './documents.service';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function parseDate(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid date: ${v}`);
  return d;
}

function enumOf<T extends object>(e: T, v: string | undefined, name: string): T[keyof T] | undefined {
  if (v === undefined || v === '') return undefined;
  if (!Object.values(e).includes(v)) throw new BadRequestException(`Invalid ${name}: ${v}`);
  return v as T[keyof T];
}

@Controller('internal/documents')
export class DocumentsController {
  constructor(
    private readonly docs: DocumentsService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  @Get()
  @Roles(Role.STAFF, Role.REVIEWER, Role.RESEARCHER, Role.ADMIN)
  list(@Query() q: Record<string, string>) {
    return this.docs.list({
      lifecycle: enumOf(DocumentLifecycle, q.lifecycle, 'lifecycle'),
      type: enumOf(DocumentType, q.type, 'type'),
      search: q.search,
      cursor: q.cursor,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
    });
  }

  @Get('stats')
  @Roles(Role.STAFF, Role.REVIEWER, Role.RESEARCHER, Role.ADMIN)
  stats() {
    return this.docs.stats();
  }

  @Get(':id')
  @Roles(Role.STAFF, Role.REVIEWER, Role.RESEARCHER, Role.ADMIN)
  async get(@Param('id') id: string) {
    const { extractedText, ...doc } = await this.docs.get(id);
    return { ...doc, hasText: !!extractedText, textPreview: extractedText?.slice(0, 2000) ?? null };
  }

  @Get(':id/review')
  @Roles(Role.STAFF, Role.REVIEWER, Role.ADMIN)
  review(@Param('id') id: string) {
    return this.docs.reviewReport(id);
  }

  /** Multipart upload: field "file" plus optional metadata fields. */
  @Post()
  @Roles(Role.STAFF, Role.ADMIN)
  @Audit({ action: 'document.ingest', objectType: 'document' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  ingest(@UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string } | undefined, @Body() body: Record<string, string>, @CurrentUser() user: Principal) {
    if (!file) throw new BadRequestException('A file is required (multipart field "file")');
    if (!SUPPORTED_TYPES.includes(file.mimetype)) throw new BadRequestException(`Unsupported file type ${file.mimetype}`);
    return this.docs.ingest(
      {
        data: file.buffer,
        filename: file.originalname,
        mimeType: file.mimetype,
        metadata: {
          title: body.title,
          type: enumOf(DocumentType, body.type, 'type') as DocumentType | undefined,
          documentDate: parseDate(body.documentDate),
          language: body.language,
          sittingId: body.sittingId,
          billId: body.billId,
          sensitivity: body.sensitivity,
        },
      },
      user,
      this.cls.get('correlationId'),
    );
  }

  @Patch(':id/metadata')
  @Roles(Role.STAFF, Role.REVIEWER, Role.ADMIN)
  @Audit({ action: 'document.metadata.update', objectType: 'document' })
  updateMetadata(@Param('id') id: string, @Body() b: Record<string, string>) {
    const patch: Record<string, unknown> = {};
    for (const k of ['title', 'language', 'sittingId', 'billId', 'sensitivity']) if (b[k] !== undefined) patch[k] = b[k];
    if (b.type !== undefined) patch.type = enumOf(DocumentType, b.type, 'type');
    if (b.documentDate !== undefined) patch.documentDate = parseDate(b.documentDate) ?? null;
    return this.docs.updateMetadata(id, patch);
  }

  @Post(':id/reprocess')
  @HttpCode(202)
  @Roles(Role.STAFF, Role.ADMIN)
  @Audit({ action: 'document.reprocess', objectType: 'document' })
  reprocess(@Param('id') id: string) {
    return this.docs.reprocess(id, this.cls.get('correlationId'));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles(Role.REVIEWER, Role.ADMIN)
  @Audit({ action: 'document.approve', objectType: 'document' })
  approve(@Param('id') id: string, @Body() b: { acknowledgeQualityIssues?: boolean; notes?: string }, @CurrentUser() user: Principal) {
    return this.docs.approve(id, user, { acknowledgeQualityIssues: b?.acknowledgeQualityIssues === true, notes: b?.notes });
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Roles(Role.REVIEWER, Role.ADMIN)
  @Audit({ action: 'document.reject', objectType: 'document' })
  reject(@Param('id') id: string, @Body() b: { reason: string }, @CurrentUser() user: Principal) {
    return this.docs.reject(id, user, b?.reason);
  }

  @Post(':id/publish')
  @HttpCode(202)
  @Roles(Role.REVIEWER, Role.ADMIN)
  @Audit({ action: 'document.publish', objectType: 'document' })
  publish(@Param('id') id: string) {
    return this.docs.publish(id, this.cls.get('correlationId'));
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @Roles(Role.REVIEWER, Role.ADMIN)
  @Audit({ action: 'document.unpublish', objectType: 'document' })
  unpublish(@Param('id') id: string, @Body() b: { reason: string }) {
    return this.docs.unpublish(id, b?.reason);
  }

  @Post(':id/supersede')
  @HttpCode(200)
  @Roles(Role.REVIEWER, Role.ADMIN)
  @Audit({ action: 'document.supersede', objectType: 'document' })
  supersede(@Param('id') id: string) {
    return this.docs.supersede(id);
  }
}
