import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { DocumentType, Role } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { RepositoryClient } from '../alfresco/alfresco.client';
import { Audit } from '../audit/audit.interceptor';
import { CurrentUser } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import type { RequestStore } from '../common/request-context';
import { Roles } from '../rbac/rbac';
import { SUPPORTED_TYPES } from './extractor';
import { DocumentsService } from './documents.service';

/** Browse and synchronise files from the document repository. The browser never talks to Alfresco directly. */
@Controller('internal/repository')
export class RepositoryController {
  constructor(
    private readonly repo: RepositoryClient,
    private readonly docs: DocumentsService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  @Get('nodes')
  @Roles(Role.STAFF, Role.ADMIN)
  nodes() {
    return this.repo.listFolder();
  }

  @Post('sync')
  @Roles(Role.STAFF, Role.ADMIN)
  @Audit({ action: 'document.sync', objectType: 'document' })
  async sync(@Body() b: { nodeId: string; type?: DocumentType; title?: string; language?: string }, @CurrentUser() user: Principal) {
    if (!b?.nodeId) throw new BadRequestException('nodeId is required');
    const node = await this.repo.getNode(b.nodeId);
    const mimeType = node.mimeType ?? '';
    if (!SUPPORTED_TYPES.includes(mimeType)) throw new BadRequestException(`Unsupported file type ${mimeType || 'unknown'}`);
    const data = await this.repo.download(b.nodeId);
    return this.docs.ingest(
      { data, filename: node.name, mimeType, nodeId: b.nodeId, metadata: { title: b.title, type: b.type, language: b.language } },
      user,
      this.cls.get('correlationId'),
    );
  }
}
