import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../rbac/rbac';
import { PrismaService } from '../prisma/prisma.service';

@Controller('internal/audit-events')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  /** Read-only, newest first, cursor-paginated. Audit events can never be modified through the API. */
  @Get()
  @Roles(Role.ADMIN)
  async list(
    @Query('correlationId') correlationId?: string,
    @Query('objectType') objectType?: string,
    @Query('objectId') objectId?: string,
    @Query('actorId') actorId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200);
    const items = await this.prisma.auditEvent.findMany({
      where: { correlationId, objectType, objectId, actorId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }
}
