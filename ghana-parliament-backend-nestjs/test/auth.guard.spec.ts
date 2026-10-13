import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { AuthGuard } from '../src/auth/auth.guard';
import { Public } from '../src/auth/decorators';
import { loadConfig } from '../src/config/env';

class C {
  @Public() open() {}
  closed() {}
}

function setup(user: any, verify: jest.Mock = jest.fn().mockResolvedValue({ sub: 'sub-1' })) {
  const audit = { recordSafe: jest.fn().mockResolvedValue(undefined) };
  const store: Record<string, unknown> = {};
  const cls = { set: (k: string, v: unknown) => (store[k] = v) };
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(user), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };
  const guard = new AuthGuard(new Reflector(), { verify } as any, prisma as any, audit as any, cls as any);
  const run = (handler: Function, headers: Record<string, string> = {}) => {
    const req: any = { headers, url: '/x' };
    const ctx: any = { getHandler: () => handler, getClass: () => C, switchToHttp: () => ({ getRequest: () => req }) };
    return { req, result: guard.canActivate(ctx) };
  };
  return { run, audit, store, verify, prisma };
}

const dbUser = (over: any = {}) => ({
  id: 'u1', externalId: 'sub-1', email: 'a@b.gh', roles: [Role.STAFF], active: true,
  constituencies: [{ constituencyId: 'c1' }], mp: { constituencyId: 'c2' }, ...over,
});

describe('AuthGuard', () => {
  it('lets @Public routes through without a token', async () => {
    const { run } = setup(null);
    await expect(run(C.prototype.open).result).resolves.toBe(true);
  });

  it('rejects a missing token and audits it', async () => {
    const { run, audit } = setup(null);
    await expect(run(C.prototype.closed).result).rejects.toThrow(UnauthorizedException);
    expect(audit.recordSafe).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.denied' }));
  });

  it('rejects an invalid token', async () => {
    const { run } = setup(null, jest.fn().mockRejectedValue(new UnauthorizedException()));
    await expect(run(C.prototype.closed, { authorization: 'Bearer bad' }).result).rejects.toThrow(UnauthorizedException);
  });

  it('forbids a valid token for an unknown or inactive user', async () => {
    await expect(setup(null).run(C.prototype.closed, { authorization: 'Bearer t' }).result).rejects.toThrow(ForbiddenException);
    await expect(setup(dbUser({ active: false })).run(C.prototype.closed, { authorization: 'Bearer t' }).result).rejects.toThrow(ForbiddenException);
  });

  it('builds the principal from the database, merging MP and staff constituencies', async () => {
    const { run, store } = setup(dbUser());
    const { req, result } = run(C.prototype.closed, { authorization: 'Bearer t' });
    await expect(result).resolves.toBe(true);
    expect(req.principal).toMatchObject({ userId: 'u1', roles: [Role.STAFF] });
    expect([...req.principal.constituencyIds].sort()).toEqual(['c1', 'c2']);
    expect(store.principal).toBe(req.principal);
  });
});

describe('loadConfig', () => {
  const base = { DATABASE_URL: 'postgresql://x', OIDC_ISSUER: 'https://idp/realm/', OIDC_AUDIENCE: 'api' };
  it('derives the JWKS URI and applies defaults', () => {
    const c = loadConfig(base as any);
    expect(c.oidc.jwksUri).toBe('https://idp/realm/.well-known/jwks.json');
    expect(c.port).toBe(3000);
  });
  it('fails fast on missing required variables', () => {
    expect(() => loadConfig({ ...base, OIDC_ISSUER: '' } as any)).toThrow(/OIDC_ISSUER/);
  });
  it('requires CORS origins in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' } as any)).toThrow(/CORS_ORIGINS/);
  });

  describe('invitations and sign-in tracking', () => {
    it('binds an invitation only when the token carries a verified email', async () => {
      const ok = setup(dbUser(), jest.fn().mockResolvedValue({ sub: 'sub-1', email: 'New@B.gh', emailVerified: true }));
      await ok.run(C.prototype.closed, { authorization: 'Bearer t' }).result;
      expect(ok.prisma.user.updateMany).toHaveBeenCalledWith({ where: { email: 'new@b.gh', externalId: { startsWith: 'pending:' }, active: true }, data: { externalId: 'sub-1' } });

      const unverified = setup(dbUser(), jest.fn().mockResolvedValue({ sub: 'sub-1', email: 'new@b.gh', emailVerified: false }));
      await unverified.run(C.prototype.closed, { authorization: 'Bearer t' }).result;
      expect(unverified.prisma.user.updateMany).not.toHaveBeenCalled();

      const none = setup(dbUser());
      await none.run(C.prototype.closed, { authorization: 'Bearer t' }).result;
      expect(none.prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('records the last sign-in at most once an hour, and a failed write never blocks access', async () => {
      const first = setup(dbUser({ lastLoginAt: null }));
      await first.run(C.prototype.closed, { authorization: 'Bearer t' }).result;
      expect(first.prisma.user.update).toHaveBeenCalledTimes(1);

      const recent = setup(dbUser({ lastLoginAt: new Date() }));
      await recent.run(C.prototype.closed, { authorization: 'Bearer t' }).result;
      expect(recent.prisma.user.update).not.toHaveBeenCalled();

      const failing = setup(dbUser({ lastLoginAt: null }));
      failing.prisma.user.update.mockRejectedValue(new Error('db'));
      await expect(failing.run(C.prototype.closed, { authorization: 'Bearer t' }).result).resolves.toBe(true);
    });
  });
});
