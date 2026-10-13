// Authorization matrix over EVERY route the API declares (T-079). The route list is read from the
// controllers themselves, so a new endpoint is covered automatically and a forgotten @Roles, an
// accidentally public internal route, or an unthrottled public write fails here.
import { freshDatabaseUrl } from './db';

process.env.DATABASE_URL = freshDatabaseUrl('security');
process.env.OIDC_ISSUER = 'https://idp.test/realm';
process.env.OIDC_AUDIENCE = 'parliament-api';
process.env.JOBS_ENABLED = 'false';
process.env.THROTTLE_LIMIT = '1000000';
process.env.PUBLIC_RATE_LIMIT_OVERRIDE = '1000000';
process.env.CASE_TOKEN_SECRET = 'integration-test-secret-0123456789abcdef';

import { INestApplication, RequestMethod, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { IS_PUBLIC } from '../../src/auth/decorators';
import { TokenVerifier } from '../../src/auth/token-verifier';

interface RouteInfo { method: string; path: string; isPublic: boolean; roles: Role[] | undefined; scoped: boolean; throttled: boolean; skipThrottle: boolean; label: string }

const ZERO = '00000000-0000-4000-8000-000000000000';
const METHODS: Record<number, string> = { [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put', [RequestMethod.DELETE]: 'delete', [RequestMethod.PATCH]: 'patch' };

function discover(): RouteInfo[] {
  const controllers: Function[] = Reflect.getMetadata('controllers', AppModule);
  const out: RouteInfo[] = [];
  for (const ctrl of controllers) {
    const base = [Reflect.getMetadata('path', ctrl)].flat()[0] ?? '';
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      if (name === 'constructor') continue;
      const fn = ctrl.prototype[name];
      const method = Reflect.getMetadata('method', fn);
      if (method === undefined) continue;
      const sub = [Reflect.getMetadata('path', fn)].flat()[0] ?? '';
      const path = `/api/v1/${[base, sub].filter((p) => p && p !== '/').join('/')}`.replace(/\/+$/, '').replace(/:[A-Za-z]+/g, ZERO);
      out.push({
        method: METHODS[method], path,
        isPublic: !!(Reflect.getMetadata(IS_PUBLIC, fn) ?? Reflect.getMetadata(IS_PUBLIC, ctrl)),
        roles: Reflect.getMetadata('roles', fn) ?? Reflect.getMetadata('roles', ctrl),
        scoped: !!(Reflect.getMetadata('constituencyScope', fn) ?? Reflect.getMetadata('constituencyScope', ctrl)),
        throttled: Reflect.getMetadata('THROTTLER:LIMITdefault', fn) !== undefined,
        skipThrottle: !!(Reflect.getMetadata('THROTTLER:SKIPdefault', fn) ?? Reflect.getMetadata('THROTTLER:SKIPdefault', ctrl)),
        label: `${ctrl.name}.${name}`,
      });
    }
  }
  return out;
}

describe('Authorization matrix (every declared route)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const routes = discover();
  const internal = routes.filter((r) => r.path.startsWith('/api/v1/internal'));
  const publicRoutes = routes.filter((r) => r.isPublic);
  const allRoles = Object.values(Role);
  const tokens: Record<string, { sub: string }> = { unknown: { sub: 'sub-nobody' } };
  for (const r of allRoles) tokens[r] = { sub: `sub-${r}` };
  const as = (r: RouteInfo, token?: string) => {
    const req = (request(app.getHttpServer()) as any)[r.method](r.path);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(r.method === 'get' ? undefined : {});
  };

  beforeAll(async () => {
    prisma = new PrismaClient();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue({ verify: async (t: string) => { if (!tokens[t]) throw new UnauthorizedException(); return tokens[t]; } })
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // One administrator exists so ADMIN-allowed mutations cannot strip the last one in this run.
    for (const r of allRoles) await prisma.user.create({ data: { externalId: `sub-${r}`, email: `${r.toLowerCase()}@parliament.gh`, displayName: r, roles: [r] } });
    await prisma.user.create({ data: { externalId: 'sub-keepadmin', email: 'keep@parliament.gh', displayName: 'Keep', roles: [Role.ADMIN] } });
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('finds the whole API surface', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(internal.length).toBeGreaterThan(80);
    expect(publicRoutes.length).toBeGreaterThan(20);
  });

  it('exposes only /public, /health and /metrics without a token', () => {
    const stray = publicRoutes.filter((r) => !/^\/api\/v1\/(public|health|metrics)(\/|$)/.test(r.path)).map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(stray).toEqual([]);
    expect(internal.filter((r) => r.isPublic).map((r) => r.label)).toEqual([]);
  });

  it('gives every internal route an explicit role list (only "me" is open to any signed-in user)', () => {
    const open = internal.filter((r) => !r.roles?.length).map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(open).toEqual(['GET /api/v1/internal/me']);
  });

  it('rate-limits every public write', () => {
    const unthrottled = publicRoutes.filter((r) => r.method !== 'get' && !r.throttled && !r.skipThrottle).map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(unthrottled).toEqual([]);
  });

  it('refuses every internal route without a token (401) and for an unprovisioned identity (403)', async () => {
    const wrong: string[] = [];
    for (const r of internal) {
      const a = (await as(r)).status;
      const b = (await as(r, 'unknown')).status;
      if (a !== 401) wrong.push(`${r.method} ${r.path} without token -> ${a}`);
      if (b !== 403) wrong.push(`${r.method} ${r.path} unprovisioned -> ${b}`);
    }
    expect(wrong).toEqual([]);
  });

  it('denies each role every internal route it is not listed for, and never crashes for those it is', async () => {
    const wrong: string[] = [];
    let denied = 0;
    let allowed = 0;
    for (const r of internal) {
      for (const role of allRoles) {
        const status = (await as(r, role)).status;
        const permitted = !r.roles?.length || r.roles.includes(role);
        if (!permitted) {
          denied++;
          if (status !== 403) wrong.push(`${role} ${r.method} ${r.path} should be 403, got ${status}`);
        } else {
          allowed++;
          if (status === 401) wrong.push(`${role} ${r.method} ${r.path} unexpectedly 401`);
          if (status === 403 && !r.scoped) wrong.push(`${role} ${r.method} ${r.path} is listed for the role but got 403`);
          // 503 is the honest answer when a dependency (the document repository) is not configured.
          if (status >= 500 && status !== 503) wrong.push(`${role} ${r.method} ${r.path} crashed with ${status} on an empty request`);
        }
      }
    }
    expect(denied).toBeGreaterThan(300);
    expect(allowed).toBeGreaterThan(150);
    expect(wrong).toEqual([]);
  }, 300_000);

  it('does not leak stack traces or internals in public error responses', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/public/answers/not-a-uuid`).expect(404);
    expect(JSON.stringify(res.body)).not.toMatch(/node_modules|\bat \w|prisma/i);
    const bad = await request(app.getHttpServer()).post('/api/v1/public/answers').send({ question: 5 }).expect(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/node_modules|prisma/i);
  });

  it('denies a deactivated user at once, whatever their token says', async () => {
    const r = internal.find((x) => x.path.endsWith('/internal/ai/versions') && x.method === 'get')!;
    await as(r, Role.ADMIN).expect(200);
    await prisma.user.update({ where: { externalId: `sub-${Role.ADMIN}` }, data: { active: false } });
    await as(r, Role.ADMIN).expect(403);
  });
});
