import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Starts a throw-away real PostgreSQL (embedded-postgres) and applies the committed
 * migrations with `prisma migrate deploy`, so integration tests run against the exact
 * production schema, including the audit append-only trigger.
 * If TEST_DATABASE_URL is set it is used instead (e.g. CI service container).
 */
export default async function setup() {
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  } else {
    // embedded-postgres is ESM-only; a real dynamic import is needed from this CommonJS context.
    const { default: EmbeddedPostgres } = await (new Function('m', 'return import(m)') as (m: string) => Promise<any>)('embedded-postgres');
    const dir = mkdtempSync(join(tmpdir(), 'parl-pg-'));
    const port = Number(process.env.TEST_PG_PORT ?? 54329);
    const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('parliament_test');
    (globalThis as any).__PG__ = pg;
    process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost:${port}/parliament_test?schema=public`;
  }
  // Child processes and workers read the URL from this file/env.
  writeFileSync(join(__dirname, '.dburl'), process.env.DATABASE_URL!);
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });
}

export async function teardown() {
  await (globalThis as any).__PG__?.stop();
}
