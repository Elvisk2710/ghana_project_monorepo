// Runs scripts/rollback-drill.mjs against a live HTTP server, so the script that will be used in staging
// is itself tested. Also covers the DR-relevant UTF-8 readiness check.
import { freshDatabaseUrl } from './db';

process.env.DATABASE_URL = freshDatabaseUrl('drill');
process.env.OIDC_ISSUER = 'https://idp.test/realm';
process.env.OIDC_AUDIENCE = 'parliament-api';
process.env.JOBS_ENABLED = 'false';
process.env.THROTTLE_LIMIT = '100000';
process.env.PUBLIC_RATE_LIMIT_OVERRIDE = '100000';

import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { execFile } from 'child_process';
import { join } from 'path';
import { AppModule } from '../../src/app.module';
import { TokenVerifier } from '../../src/auth/token-verifier';
import { DocumentsService } from '../../src/documents/documents.service';
import { JobsService } from '../../src/jobs/jobs.service';

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'rollback-drill.mjs');
// The script is run exactly as an operator would run it: as a separate process talking HTTP.
const drill = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args], { timeout: 110_000 }, (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, out: stdout + stderr }));
});

describe('Rollback drill script (T-077) against a live server', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let base: string;
  let worker: NodeJS.Timeout;
  const tokens: Record<string, { sub: string }> = { researcher: { sub: 'sub-res' }, reviewer: { sub: 'sub-rev' }, admin: { sub: 'sub-admin' } };

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
    await app.listen(0);
    base = `${await app.getUrl()}/api/v1`.replace('[::1]', '127.0.0.1');
    await prisma.user.create({ data: { externalId: 'sub-res', email: 'res@parliament.gh', displayName: 'Researcher', roles: ['RESEARCHER'] } });
    await prisma.user.create({ data: { externalId: 'sub-rev', email: 'rev@parliament.gh', displayName: 'Reviewer', roles: ['REVIEWER'] } });
    await prisma.user.create({ data: { externalId: 'sub-admin', email: 'admin@parliament.gh', displayName: 'Admin', roles: ['ADMIN'] } });
    const doc = await prisma.parliamentaryDocument.create({
      data: { publicId: 'HAN-FUEL0001', sourceUri: 'x', type: 'HANSARD', title: 'Fuel debate', documentDate: new Date('2024-03-14'), language: 'en', checksum: 'c1', lifecycle: 'APPROVED', extractedText: 'Hon. Member: The price of fuel at the pump has risen sharply in 2024 and families are struggling with transport costs.' },
    });
    await app.get(DocumentsService).indexDocument(doc.id);
    // Stand-in for the background worker that runs evaluations in a real deployment.
    worker = setInterval(() => { void app.get(JobsService).drain().catch(() => undefined); }, 200);
  });
  afterAll(async () => { clearInterval(worker); await app.close(); await prisma.$disconnect(); });

  it('passes end to end and leaves the audit record of the drill behind', async () => {
    const r = await drill(['--base', base, '--researcher', 'researcher', '--reviewer', 'reviewer', '--admin', 'admin']);
    expect(r.out).not.toMatch(/^FAIL/m);
    expect(r.out).toMatch(/Rollback drill passed/);
    expect(r.code).toBe(0);
    expect((r.out.match(/^PASS/gm) ?? []).length).toBeGreaterThanOrEqual(10);
    const ms = Number(/first answer under it (\d+) ms/.exec(r.out)?.[1]);
    expect(ms).toBeLessThan(5000);
    const actions = (await prisma.auditEvent.findMany({ select: { action: true } })).map((a) => a.action);
    for (const a of ['ai.eval.create', 'ai.deployment.request', 'ai.deployment.activate', 'ai.deployment.rollback']) expect(actions).toContain(a);
    expect(await prisma.aiDeployment.count({ where: { status: 'ACTIVE' } })).toBe(0);
  }, 120_000);

  it('fails loudly and says where when the approver is not independent', async () => {
    // The same person is both researcher and reviewer: the drill must not report success.
    await prisma.user.update({ where: { externalId: 'sub-res' }, data: { roles: ['RESEARCHER', 'REVIEWER'] } });
    tokens['both'] = { sub: 'sub-res' };
    const r = await drill(['--base', base, '--researcher', 'both', '--reviewer', 'both', '--admin', 'admin']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL\s+a different reviewer approves.*403/);
    expect(r.out).toMatch(/Rollback drill FAILED/);
  }, 120_000);

  it('reports ready only when the database is UTF-8', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up' });
    const enc = await prisma.$queryRaw<{ e: string }[]>`SELECT current_setting('server_encoding') AS e`;
    expect(enc[0].e).toBe('UTF8');
  });
});
