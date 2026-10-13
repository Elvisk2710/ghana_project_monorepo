import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { Roles } from '../rbac/rbac';
import { SettingsService } from './settings.service';

/** Administrator settings. Only values Parliament owns and that are safe to change live are editable here. */
@Controller('internal/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get() @Roles(Role.ADMIN, Role.REVIEWER)
  overview() {
    return this.settings.overview();
  }

  /** Replaces the case retention and response-time settings. Each change is written to the audit ledger. */
  @Put('cases') @HttpCode(200) @Roles(Role.ADMIN)
  updateCases(@CurrentUser() p: Principal, @Body() body: Record<string, unknown>) {
    return this.settings.updateCases(p, body);
  }
}
