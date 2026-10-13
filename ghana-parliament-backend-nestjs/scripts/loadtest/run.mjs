// Boots a throw-away PostgreSQL, seeds a published corpus, starts the compiled server and runs k6.
// Usage: npm run build && node scripts/loadtest/run.mjs [documents=200]
// The corpus uses synthetic parliamentary-style text; numbers are indicative of this machine only.
import { execSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { drive } from './node-driver.mjs';

const require = createRequire(import.meta.url);
const DOCS = Number(process.argv[2] ?? 200);
const PORT_DB = 54360;
const PORT_API = 3998;
const dir = mkdtempSync(join(tmpdir(), 'parl-load-'));
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT_DB, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
let server;
let log = '';

const TOPICS = ['fuel prices and petroleum levies', 'water and sanitation funding', 'healthcare budget allocation', 'free senior high school policy', 'cost of living and transport fares', 'cocoa farmgate prices', 'road infrastructure and maintenance', 'energy sector debt and power supply'];
const SPEAKERS = ['Hon. Member for Tema East', 'Minister for Finance', 'Hon. Member for Tamale Central', 'Minister for Energy', 'Hon. Member for Cape Coast South'];
const body = (i) => Array.from({ length: 24 }, (_, p) => `${SPEAKERS[(i + p) % SPEAKERS.length]}: On the matter of ${TOPICS[(i + p) % TOPICS.length]}, the House has heard that the allocation for year ${2020 + (i % 6)} must be reviewed, and Members asked how ${TOPICS[(i * 3 + p) % TOPICS.length]} will be addressed in the coming quarter.`).join('\n\n');

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('load');
  const url = `postgresql://postgres:postgres@localhost:${PORT_DB}/load?schema=public`;
  const env = { ...process.env, NODE_ENV: 'production', PORT: String(PORT_API), DATABASE_URL: url, CORS_ORIGINS: 'http://localhost', OIDC_ISSUER: 'http://127.0.0.1:1/r', OIDC_AUDIENCE: 'x', JOBS_ENABLED: 'false', CASE_TOKEN_SECRET: 'loadtest-secret-0123456789abcdefghijklmn', PUBLIC_RATE_LIMIT_OVERRIDE: '1000000', THROTTLE_LIMIT: '1000000' };
  execSync('npx prisma migrate deploy', { env, stdio: 'ignore' });

  const { PrismaClient } = require('@prisma/client');
  const { chunkText, HashingEmbedder, sha256 } = require('../../dist/documents/pipeline.js');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const embedder = new HashingEmbedder();
  const t0 = Date.now();
  let chunks = 0;
  for (let i = 0; i < DOCS; i++) {
    const text = body(i);
    const doc = await prisma.parliamentaryDocument.create({
      data: { publicId: `HAN-L${String(i).padStart(5, '0')}`, sourceUri: `load://${i}`, type: 'HANSARD', title: `Plenary sitting ${i + 1}: ${TOPICS[i % TOPICS.length]}`, documentDate: new Date(Date.UTC(2020 + (i % 6), i % 12, 1 + (i % 27))), language: 'en', checksum: sha256(text + i), lifecycle: 'PUBLISHED', isPublished: true, publishedAt: new Date(), extractedText: text },
    });
    const drafts = chunkText(text);
    const vectors = await embedder.embed(drafts.map((d) => d.text));
    await prisma.documentChunk.createMany({ data: drafts.map((d, k) => ({ documentId: doc.id, documentVersion: 1, sequence: d.sequence, text: d.text, anchor: d.anchor, embedding: vectors[k], indexVersion: embedder.version, language: 'en' })) });
    chunks += drafts.length;
  }
  await prisma.$disconnect();
  console.log(`Seeded ${DOCS} documents / ${chunks} chunks in ${Math.round((Date.now() - t0) / 1000)}s`);

  server = spawn(process.execPath, ['dist/main.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT_API}/api/v1/health/live`)).ok; } catch { /* starting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error('The server did not start');
  if (process.env.LOAD_DRIVER === 'node') {
    const res = await drive(`http://127.0.0.1:${PORT_API}/api/v1/public`, { clients: Number(process.env.LOAD_CLIENTS ?? 20), seconds: Number(process.env.LOAD_SECONDS ?? 20), thinkMs: Number(process.env.LOAD_THINK_MS ?? 0) });
    console.log(JSON.stringify(res, null, 2));
    const ok = res.ask.errors + res.search.errors + res.list.errors === 0 && res.ask.p95 < 1500 && res.search.p95 < 800 && res.list.p95 < 500;
    console.log(ok ? 'Targets met (ask p95<1500ms, search p95<800ms, list p95<500ms, no errors)' : 'Targets NOT met');
    process.exitCode = ok ? 0 : 1;
  } else {
    const r = spawnSync('k6', ['run', '--quiet', process.argv[3] ?? join('scripts', 'loadtest', 'public.k6.js')], { env: { ...process.env, BASE_URL: `http://127.0.0.1:${PORT_API}/api/v1/public` }, stdio: 'inherit' });
    process.exitCode = r.status ?? 1;
  }
} catch (e) {
  console.error(e);
  console.error('--- server output ---\n' + log.slice(-2000));
  process.exitCode = 1;
} finally {
  server?.kill();
  await pg.stop().catch(() => {});
}
