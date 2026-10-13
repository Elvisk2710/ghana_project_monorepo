import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { IS_PUBLIC } from '../auth/decorators';
import type { Principal } from '../auth/principal';

const ROLES = 'roles';
const CONSTITUENCY_SCOPE = 'constituencyScope';

/**
 * Restricts a route to callers holding at least one of the listed roles.
 * Routes without @Roles (and not @Public) are deny-by-default except for any
 * authenticated user, so internal routes should always declare their roles.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

/**
 * Requires the caller to be allowed to act on the constituency named by the given
 * route param, query or body field. ADMIN may act on any constituency; STAFF and MP
 * only on their assigned ones; other roles never.
 */
export const ConstituencyScoped = (field = 'constituencyId') => SetMetadata(CONSTITUENCY_SCOPE, field);

/** Pure authorisation rule so it can be reused by services (e.g. when loading a case by id). */
export function canAccessConstituency(principal: Principal, constituencyId: string): boolean {
  if (principal.roles.includes(Role.ADMIN)) return true;
  const scoped = principal.roles.includes(Role.STAFF) || principal.roles.includes(Role.MP);
  return scoped && principal.constituencyIds.includes(constituencyId);
}

export function assertConstituencyAccess(principal: Principal, constituencyId: string): void {
  if (!canAccessConstituency(principal, constituencyId)) {
    throw new ForbiddenException('Not permitted for this constituency');
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest();
    const principal: Principal | undefined = req.principal;
    if (!principal) throw new ForbiddenException('Not permitted');

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (required?.length && !required.some((r) => principal.roles.includes(r))) {
      await this.audit.recordSafe({ action: 'access.denied', outcome: 'denied', payload: { reason: 'role', required, path: req.url } });
      throw new ForbiddenException('Insufficient role');
    }

    const field = this.reflector.getAllAndOverride<string | undefined>(CONSTITUENCY_SCOPE, targets);
    if (field) {
      const constituencyId = req.params?.[field] ?? req.query?.[field] ?? req.body?.[field];
      if (typeof constituencyId !== 'string' || !canAccessConstituency(principal, constituencyId)) {
        await this.audit.recordSafe({ action: 'access.denied', outcome: 'denied', objectType: 'constituency', objectId: typeof constituencyId === 'string' ? constituencyId : undefined, payload: { reason: 'constituency_scope', path: req.url } });
        throw new ForbiddenException('Not permitted for this constituency');
      }
    }
    return true;
  }
}
