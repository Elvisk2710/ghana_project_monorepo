// Boots the compiled server (dist/main.js) against a throw-away PostgreSQL and checks
// the bootstrap behaviour that unit tests do not reach: helmet, CORS allow-list, health.
// Usage: npm run build && node scripts/smoke.mjs
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const PORT_DB = Number(process.env.SMOKE_PG_PORT ?? 54340);
const PORT_API = 3999;
const dir = mkdtempSync(join(tmpdir(), 'parl-smoke-'));
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT_DB, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
let server;
let log = '';
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`);
  if (!ok) failures.push(name);
};

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('smoke');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT_API),
    DATABASE_URL: `postgresql://postgres:postgres@localhost:${PORT_DB}/smoke?schema=public`,
    CORS_ORIGINS: 'https://admin.parliament.example,https://connect.parliament.example',
    CASE_TOKEN_SECRET: 'smoke-test-secret-0123456789abcdefghij',
    OIDC_ISSUER: 'http://127.0.0.1:1/realm',
    OIDC_AUDIENCE: 'parliament-api',
    JOBS_ENABLED: 'false',
    THROTTLE_LIMIT: '5',
    METRICS_TOKEN: 'scrape',
  };
  execSync('npx prisma migrate deploy', { env, stdio: 'ignore' });
  server = spawn(process.execPath, ['dist/main.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${PORT_API}/api/v1`;
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/health/live`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  const ready = await fetch(`${base}/health/ready`);
  check('readiness reports database up', ready.status === 200 && (await ready.json()).database === 'up');
  check('helmet security headers present', (await fetch(`${base}/health/live`)).headers.get('x-content-type-options') === 'nosniff');
  check('swagger disabled in production', (await fetch(`http://127.0.0.1:${PORT_API}/docs`)).status === 404);

  const ok = await fetch(`${base}/internal/me`, { method: 'OPTIONS', headers: { Origin: 'https://admin.parliament.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  check('CORS allows the configured admin origin', ok.headers.get('access-control-allow-origin') === 'https://admin.parliament.example');
  const bad = await fetch(`${base}/internal/me`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
  check('CORS refuses other origins', !bad.headers.get('access-control-allow-origin'));

  check('internal routes require authentication', (await fetch(`${base}/internal/documents`)).status === 401);
  check('metrics require the scrape token', (await fetch(`${base}/metrics`)).status === 401 && (await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer scrape' } })).status === 200);
  const c = await fetch(`${base}/public/search?q=fuel`);
  check('correlation + request IDs returned', !!c.headers.get('x-request-id') && !!c.headers.get('x-correlation-id'));

  // Phase 3 over real HTTP against the compiled production build.
  const { PrismaClient } = createRequire(import.meta.url)('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  const con = await prisma.constituency.create({ data: { code: 'GA-TE', name: 'Tema East', region: 'Greater Accra' } });
  const pre = await fetch(`${base}/public/cases/GH-2026-000001`, { method: 'OPTIONS', headers: { Origin: 'https://connect.parliament.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-case-token' } });
  check('CORS allows the tracking-code header from the public app', (pre.headers.get('access-control-allow-headers') ?? '').toLowerCase().includes('x-case-token'));
  const submit = await fetch(`${base}/public/cases`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ constituencyId: con.id, category: 'roads_infrastructure', title: 'Potholes', description: 'The road to the market has deep potholes.', consent: true, contact: { channel: 'NONE' }, submissionKey: '3f1c1b0e-5a0c-4a53-9d0f-1d2f2b0f7a11' }),
  });
  const made = await submit.json();
  check('a citizen can submit an issue and gets a reference and tracking code', submit.status === 201 && /^GH-\d{4}-\d{6}$/.test(made.reference) && made.trackingCode?.length > 20, JSON.stringify(made));
  check('the case is not readable without the tracking code', (await fetch(`${base}/public/cases/${made.reference}`)).status === 404);
  const seen = await fetch(`${base}/public/cases/${made.reference}`, { headers: { 'X-Case-Token': made.trackingCode } });
  check('the case is readable with the tracking code', seen.status === 200 && (await seen.json()).status === 'RECEIVED');
  const form = new FormData();
  const eicar = String.raw`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`;
  form.append('file', new Blob([Buffer.from(`%PDF-1.4\n${eicar}`)], { type: 'application/pdf' }), 'invoice.pdf');
  const mal = await fetch(`${base}/public/cases/${made.reference}/attachments`, { method: 'POST', headers: { 'X-Case-Token': made.trackingCode }, body: form });
  check('a malicious attachment is rejected by the production build', mal.status === 422, String(mal.status));
  check('internal case routes require authentication', (await fetch(`${base}/internal/cases`)).status === 401);

  // Phase 5 over real HTTP against the compiled production build.
  const status = await fetch(`${base}/public/answering-status`);
  check('answering status is public and says answering is on by default', status.status === 200 && (await status.json()).enabled === true);
  check('AI governance routes require authentication', (await fetch(`${base}/internal/ai/versions`)).status === 401 && (await fetch(`${base}/internal/ai/answering/pause`, { method: 'POST' })).status === 401);
  const asked = await fetch(`${base}/public/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'What did Parliament say about fuel prices?' }) });
  const answer = await asked.json();
  check('the baseline answers (or honestly finds nothing) with no deployment approved, and records no deployment', asked.status === 200 && ['grounded', 'no_evidence'].includes(answer.status));
  const row = await prisma.questionSession.findUnique({ where: { id: answer.answerId } });
  check('the stored answer is linked to the baseline, not to any deployment', row?.deploymentId === null);
  await prisma.systemFlag.upsert({ where: { key: 'ai.answering' }, create: { key: 'ai.answering', value: { enabled: false, reason: 'smoke' } }, update: { value: { enabled: false, reason: 'smoke' } } });
  const paused = await fetch(`${base}/public/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'What did Parliament say about fuel prices?' }) });
  check('the kill switch takes effect on the next question (503, answering_paused)', paused.status === 503 && (await paused.json()).status === 'answering_paused');
  await prisma.systemFlag.delete({ where: { key: 'ai.answering' } });

  const codes = [];
  for (let i = 0; i < 35; i++) codes.push((await fetch(`${base}/public/search?q=fuel`)).status);
  check('rate limiting returns 429 when exceeded', codes.includes(429), codes.join(','));
  const denied = await prisma.auditEvent.count({ where: { action: 'auth.denied' } });
  await prisma.$disconnect();
  check('unauthenticated attempts were audited', denied >= 1, String(denied));
} catch (e) {
  console.error(e);
  console.error('--- server output ---\n' + log);
  failures.push('smoke crashed');
} finally {
  server?.kill();
  await pg.stop().catch(() => {});
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll smoke checks passed');
process.exit(failures.length ? 1 : 0);
