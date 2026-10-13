import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators';
import type { Principal } from '../auth/principal';

@Controller('internal/me')
export class MeController {
  /** Returns the caller's resolved identity, roles and constituency scope (used by the admin console). */
  @Get()
  me(@CurrentUser() principal: Principal) {
    return principal;
  }
}
