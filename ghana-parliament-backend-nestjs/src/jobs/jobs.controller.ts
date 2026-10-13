import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { JobStatus, Role } from '@prisma/client';
import { Audit } from '../audit/audit.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../rbac/rbac';
import { JobsService } from './jobs.service';

@Controller('internal/jobs')
export class JobsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  /** Operational view of the queue, including failed and dead-lettered jobs. */
  @Get()
  @Roles(Role.ADMIN, Role.STAFF)
  list(@Query('status') status?: string, @Query('type') type?: string) {
    const s = status && (Object.values(JobStatus) as string[]).includes(status) ? (status as JobStatus) : undefined;
    return this.prisma.job.findMany({ where: { status: s, type }, orderBy: { updatedAt: 'desc' }, take: 100 });
  }

  @Post(':id/retry')
  @HttpCode(202)
  @Roles(Role.ADMIN)
  @Audit({ action: 'job.retry', objectType: 'job' })
  retry(@Param('id') id: string) {
    return this.jobs.retry(id);
  }
}
