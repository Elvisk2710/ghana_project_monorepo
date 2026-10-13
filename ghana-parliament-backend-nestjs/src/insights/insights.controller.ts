import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ConstituencyScoped, Roles } from '../rbac/rbac';
import { InsightsService } from './insights.service';

const CONSTITUENCY_ROLES = [Role.STAFF, Role.MP, Role.ADMIN] as const;

/** Internal, authenticated insights endpoints behind the admin console: the MP dashboard, issue
 *  clustering, the national heatmap, and constituency sentiment. */
@Controller('internal/insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('mp-overview')
  @Roles(...CONSTITUENCY_ROLES)
  @ConstituencyScoped('constituencyId')
  mpOverview(@CurrentUser() p: Principal, @Query('constituencyId') constituencyId: string) {
    return this.insights.mpOverview(p, constituencyId);
  }

  @Get('clusters')
  @Roles(...CONSTITUENCY_ROLES)
  @ConstituencyScoped('constituencyId')
  clusters(@CurrentUser() p: Principal, @Query('constituencyId') constituencyId: string) {
    return this.insights.clusters(p, constituencyId);
  }

  @Get('sentiment')
  @Roles(...CONSTITUENCY_ROLES)
  @ConstituencyScoped('constituencyId')
  sentiment(@CurrentUser() p: Principal, @Query('constituencyId') constituencyId: string) {
    return this.insights.constituencySentiment(p, constituencyId);
  }

  @Get('heatmap')
  @Roles(Role.ADMIN, Role.REVIEWER)
  heatmap(@CurrentUser() p: Principal) {
    return this.insights.nationalHeatmap(p);
  }
}
