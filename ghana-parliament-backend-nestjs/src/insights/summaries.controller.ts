import { Controller, Get, Param, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { Roles } from '../rbac/rbac';
import { SummariesService } from './summaries.service';

const READ = [Role.STAFF, Role.MP, Role.REVIEWER, Role.ADMIN] as const;
const WRITE = [Role.STAFF, Role.ADMIN] as const;

@Controller('internal/sittings/:id/summary')
export class SummariesController {
  constructor(private readonly summaries: SummariesService) {}

  @Get()
  @Roles(...READ)
  get(@Param('id') id: string) {
    return this.summaries.get(id);
  }

  @Post()
  @Roles(...WRITE)
  request(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.summaries.request(p, id);
  }
}
