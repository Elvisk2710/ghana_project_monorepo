import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import type { Principal } from '../src/auth/principal';
import { assertConstituencyAccess, canAccessConstituency, ConstituencyScoped, Roles, RolesGuard } from '../src/rbac/rbac';

const p = (roles: Role[], constituencyIds: string[] = []): Principal => ({
  userId: 'u1',
  externalId: 'sub-1',
  email: 'a@b.gh',
  roles,
  constituencyIds,
});

describe('canAccessConstituency', () => {
  it('lets ADMIN act on any constituency', () => {
    expect(canAccessConstituency(p([Role.ADMIN]), 'c9')).toBe(true);
  });
  it('limits STAFF and MP to assigned constituencies', () => {
    expect(canAccessConstituency(p([Role.STAFF], ['c1']), 'c1')).toBe(true);
    expect(canAccessConstituency(p([Role.STAFF], ['c1']), 'c2')).toBe(false);
    expect(canAccessConstituency(p([Role.MP], ['c1']), 'c2')).toBe(false);
  });
  it('never grants constituency access to reviewer, researcher or public roles', () => {
    for (const r of [Role.REVIEWER, Role.RESEARCHER, Role.PUBLIC]) {
      expect(canAccessConstituency(p([r], ['c1']), 'c1')).toBe(false);
    }
  });
  it('assertConstituencyAccess throws Forbidden', () => {
    expect(() => assertConstituencyAccess(p([Role.STAFF], ['c1']), 'c2')).toThrow(ForbiddenException);
  });
});

class RoleOnly {
  @Roles(Role.ADMIN, Role.REVIEWER)
  handler() {}
  @ConstituencyScoped('constituencyId')
  @Roles(Role.STAFF, Role.ADMIN)
  scoped() {}
  open() {}
}

function ctx(handler: Function, request: any): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => RoleOnly,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const audit = { recordSafe: jest.fn().mockResolvedValue(undefined) };
  const guard = new RolesGuard(new Reflector(), audit as any);
  const t = new RoleOnly();
  beforeEach(() => audit.recordSafe.mockClear());

  it('allows a caller with a required role', async () => {
    await expect(guard.canActivate(ctx(t.handler, { principal: p([Role.REVIEWER]), params: {} }))).resolves.toBe(true);
  });

  it('denies and audits a caller without the role', async () => {
    await expect(guard.canActivate(ctx(t.handler, { principal: p([Role.STAFF]), params: {}, url: '/x' }))).rejects.toThrow(ForbiddenException);
    expect(audit.recordSafe).toHaveBeenCalledWith(expect.objectContaining({ action: 'access.denied', outcome: 'denied' }));
  });

  it('denies when there is no principal', async () => {
    await expect(guard.canActivate(ctx(t.handler, { params: {} }))).rejects.toThrow(ForbiddenException);
  });

  it('enforces constituency scope from params, query or body', async () => {
    const principal = p([Role.STAFF], ['c1']);
    await expect(guard.canActivate(ctx(t.scoped, { principal, params: { constituencyId: 'c1' } }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx(t.scoped, { principal, params: {}, body: { constituencyId: 'c2' } }))).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(ctx(t.scoped, { principal, params: {}, query: {} }))).rejects.toThrow(ForbiddenException);
  });
});
