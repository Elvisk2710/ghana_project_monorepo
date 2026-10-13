// Disaster-recovery drill (T-080): back up a populated database, destroy the original, restore the
// backup into a fresh cluster, and prove the platform comes back with its data, its integrity rules
// and a working public service. Prints measured recovery time. Run: npm run build && npm run drill:dr
//
// This drill uses a cold physical backup (stop, copy the data directory) of a throw-away PostgreSQL.
// Production should use pg_basebackup/WAL archiving or the managed-database equivalent; the checks
// below (counts, immutability triggers, UTF-8, serving) apply to any restore and can be pointed at one.
import { execSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const require = createRequire(import.meta.url);
const PORT_A = Number(process.env.DR_PG_PORT_A ?? 54371);
const PORT_B = Number(process.env.DR_PG_PORT_B ?? 54372);
const PORT_API = 3997;
const work = mkdtempSync(join(tmpdir(), 'parl-dr-'));
const dirA = join(work, 'primary');
const dirBackup = join(work, 'backup');
const dirB = join(work, 'restored');
const url = (port) => `postgresql://postgres:postgres@localhost:${port}/drill?schema=public`;
const mk = (dir, port) => new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`);
  if (!ok) failures.push(name);
};
const baseEnv = (port) => ({
  ...process.env, NODE_ENV: 'production', PORT: String(PORT_API), DATABASE_URL: url(port), CORS_ORIGINS: 'http://localhost',
  OIDC_ISSUER: 'http://127.0.0.1:1/r', OIDC_AUDIENCE: 'x', JOBS_ENABLED: 'false', CASE_TOKEN_SECRET: 'drill-secret-0123456789abcdefghijklmn',
});

let server;
let a;
let b;
try {
  // ---- 1. Primary with realistic data
  a = mk(dirA, PORT_A);
  await a.initialise();
  await a.start();
  await a.createDatabase('drill');
  execSync('npx prisma migrate deploy', { env: baseEnv(PORT_A), stdio: 'ignore' });
  const { PrismaClient } = require('@prisma/client');
  const { chunkText, HashingEmbedder, sha256 } = require('../dist/documents/pipeline.js');
  const embedder = new HashingEmbedder();
  let prisma = new PrismaClient({ datasources: { db: { url: url(PORT_A) } } });

  const TWI = 'Dɛn na Mmarahyɛ Mfonini kyerɛɛ? Ɔmampanin Kofi ɛyɛ adwuma.';
  for (let i = 0; i < 25; i++) {
    const text = `Plenary sitting ${i}: Members debated fuel prices and the cost of transport. The Minister said the pricing formula would be published. ${i % 5 === 0 ? TWI : ''}`;
    const doc = await prisma.parliamentaryDocument.create({
      data: { publicId: `HAN-D${String(i).padStart(4, '0')}`, sourceUri: `drill://${i}`, type: 'HANSARD', title: `Sitting ${i}`, documentDate: new Date(Date.UTC(2024, i % 12, 1 + i)), language: 'en', checksum: sha256(text + i), lifecycle: 'PUBLISHED', isPublished: true, publishedAt: new Date(), extractedText: text },
    });
    const drafts = chunkText(text);
    const vectors = await embedder.embed(drafts.map((d) => d.text));
    await prisma.documentChunk.createMany({ data: drafts.map((d, k) => ({ documentId: doc.id, documentVersion: 1, sequence: d.sequence, text: d.text, anchor: d.anchor, embedding: vectors[k], indexVersion: embedder.version, language: 'en' })) });
  }
  const admin = await prisma.user.create({ data: { externalId: 'sub-admin', email: 'admin@parliament.gh', displayName: 'Admin', roles: ['ADMIN'] } });
  const con = await prisma.constituency.create({ data: { code: 'GA-TE', name: 'Tema East', region: 'Greater Accra' } });
  const mkCase = (n, extra = {}) => prisma.citizenCase.create({ data: { publicId: `GH-2026-00000${n}`, title: `Pothole ${n}`, category: 'roads_infrastructure', constituencyId: con.id, consentGivenAt: new Date(), consentPurpose: 'drill', ...extra } });
  const keepCase = await mkCase(1);
  const erasedCase = await mkCase(2);
  const model = await prisma.aiVersion.create({ data: { kind: 'MODEL', name: 'extractive', version: 'v1', ownerId: admin.id, config: { generator: 'extractive' }, checksum: 'drill' } });
  const sessions = [];
  for (let i = 0; i < 10; i++) {
    const text = `Passage ${i}`;
    sessions.push(await prisma.questionSession.create({ data: { question: `question ${i} ɛ`, language: 'en', status: 'GROUNDED', answer: `answer [1]`, citations: [{ n: 1, documentId: 'HAN-D0000' }], modelVersion: 'extractive', promptVersion: 'extractive-v1', retrieverVersion: 'x', sources: [{ n: 1, documentId: 'HAN-D0000', text, textSha256: sha256(text) }] } }));
  }
  for (let i = 0; i < 40; i++) await prisma.auditEvent.create({ data: { actorType: 'user', actorRoles: [], action: `drill.event.${i}`, requestId: `r${i}`, correlationId: `c${i}` } });
  // Erasure ledger: kept OUTSIDE the database, because a restored backup can pre-date an erasure.
  const erasureLedger = join(work, 'erasure-ledger.json');
  const snapshot = async (p) => ({
    docs: await p.parliamentaryDocument.count(), chunks: await p.documentChunk.count(), sessions: await p.questionSession.count(),
    audit: await p.auditEvent.count(), cases: await p.citizenCase.count(), versions: await p.aiVersion.count(), users: await p.user.count(),
    auditIds: (await p.auditEvent.findMany({ orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], select: { id: true } })).map((x) => x.id).join(','),
    twi: (await p.parliamentaryDocument.findFirst({ where: { publicId: 'HAN-D0000' }, select: { extractedText: true } }))?.extractedText.includes(TWI),
  });
  const before = await snapshot(prisma);
  console.log('Primary seeded:', JSON.stringify({ ...before, auditIds: undefined }));

  // ---- 2. Backup (cold physical copy) at time T
  await prisma.$disconnect();
  await a.stop();
  const tBackup = Date.now();
  cpSync(dirA, dirBackup, { recursive: true });
  check('backup taken', true);

  // ---- 3. Changes after the backup (these are the data a restore loses: the RPO)
  await a.start();
  prisma = new PrismaClient({ datasources: { db: { url: url(PORT_A) } } });
  await prisma.citizenCase.update({ where: { id: erasedCase.id }, data: { title: '[removed]', anonymizedAt: new Date() } });
  writeFileSync(erasureLedger, JSON.stringify([{ caseId: erasedCase.id, erasedAt: new Date().toISOString() }]));
  await prisma.questionSession.create({ data: { question: 'asked after the backup', language: 'en', status: 'NO_EVIDENCE' } });
  const lostAfterBackup = (await prisma.questionSession.count()) - before.sessions;
  await prisma.$disconnect();

  // ---- 4. Disaster: the primary is destroyed
  await a.stop();
  rmSync(dirA, { recursive: true, force: true });
  a = null;
  console.log('Primary destroyed. Restoring from backup...');

  // ---- 5. Restore into a fresh cluster and time how long until the service answers
  const tRestore = Date.now();
  cpSync(dirBackup, dirB, { recursive: true });
  b = mk(dirB, PORT_B);
  await b.start();
  prisma = new PrismaClient({ datasources: { db: { url: url(PORT_B) } } });
  const after = await snapshot(prisma);
  check('restored row counts match the backup point', ['docs', 'chunks', 'sessions', 'audit', 'cases', 'versions', 'users'].every((k) => after[k] === before[k]), JSON.stringify({ before, after }));
  check('audit ledger restored in the same order', after.auditIds === before.auditIds);
  check('Twi text survives backup and restore (UTF-8)', after.twi === true);
  const enc = await prisma.$queryRaw`SELECT current_setting('server_encoding') AS e`;
  check('restored database is UTF-8', enc[0].e === 'UTF8', enc[0].e);

  // Integrity rules must have come back with the data.
  const refuses = async (sql, pattern) => prisma.$executeRawUnsafe(sql).then(() => false, (e) => pattern.test(String(e.message)));
  check('audit ledger is still append-only after restore', await refuses(`UPDATE "AuditEvent" SET "action" = 'tampered'`, /append-only/));
  check('AI versions are still immutable after restore', await refuses(`UPDATE "AiVersion" SET "name" = 'x'`, /immutable/));
  check('one-live-deployment rule restored', (await prisma.$queryRaw`SELECT count(*)::int AS c FROM pg_indexes WHERE indexname = 'AiDeployment_single_active'`)[0].c === 1);
  const sessionsOk = (await prisma.questionSession.findMany({ where: { sources: { not: null } } })).every((s) => s.sources.every((x) => sha256(x.text) === x.textSha256));
  check('stored answer-source snapshots still match their hashes', sessionsOk);

  // Privacy: a restore pre-dating an erasure brings the erased data back until the ledger is replayed.
  const resurrected = await prisma.citizenCase.findUnique({ where: { id: erasedCase.id } });
  const ledger = JSON.parse((await import('node:fs')).readFileSync(erasureLedger, 'utf8'));
  check('erased personal data returned by the restore is identified by the external erasure ledger', resurrected.anonymizedAt === null && ledger.some((e) => e.caseId === erasedCase.id), 'ledger missing');
  console.log(`      -> ${ledger.length} erasure(s) must be re-applied after restore (POST /internal/cases/:id/erase for each ledger entry).`);
  await prisma.$disconnect();

  // The service runs on the restored database.
  server = spawn(process.execPath, ['dist/main.js'], { env: baseEnv(PORT_B), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${PORT_API}/api/v1`;
  let ready = false;
  for (let i = 0; i < 240 && !ready; i++) {
    try { ready = (await fetch(`${base}/health/ready`)).ok; } catch { /* starting */ }
    if (!ready) await new Promise((r) => setTimeout(r, 500));
  }
  check('service reports ready on the restored database', ready, log.slice(-500));
  const ans = await fetch(`${base}/public/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'What did Members say about fuel prices?' }) }).then((r) => r.json());
  const rtoMs = Date.now() - tRestore;
  check('public question answered from restored records, with citations', ans.status === 'grounded' && ans.citations?.length > 0, JSON.stringify(ans).slice(0, 300));
  check('restored answer is saved and can be re-opened', (await fetch(`${base}/public/answers/${ans.answerId}`)).status === 200);

  console.log(`\nMeasured on this machine (throw-away database, 25 documents):`);
  console.log(`  Recovery time (restore + service answering): ${(rtoMs / 1000).toFixed(1)} s`);
  console.log(`  Data lost since the backup (recovery point): ${lostAfterBackup} public answer(s) and 1 erasure to re-apply, i.e. everything after ${new Date(tBackup).toISOString()}`);
} catch (e) {
  console.error(e);
  failures.push('drill crashed');
} finally {
  server?.kill();
  await a?.stop().catch(() => {});
  await b?.stop().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll disaster-recovery checks passed');
process.exit(failures.length ? 1 : 0);
