import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Returns the URL of a private database cloned from the migrated template, so each
 * integration test file starts from the exact production schema with no shared state.
 */
export function freshDatabaseUrl(name: string): string {
  const base = readFileSync(join(__dirname, '.dburl'), 'utf8').trim();
  const u = new URL(base);
  const template = u.pathname.slice(1);
  const db = `t_${name}_${Date.now()}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const admin = new URL(base);
  admin.pathname = '/postgres';
  const script = `
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient({ datasources: { db: { url: process.argv[1] } } });
    p.$executeRawUnsafe('CREATE DATABASE "${db}" TEMPLATE "${template}"').then(() => p.$disconnect()).catch((e) => { console.error(e); process.exit(1); });`;
  execFileSync(process.execPath, ['-e', script, admin.toString()], { cwd: join(__dirname, '..', '..'), stdio: 'inherit' });
  u.pathname = `/${db}`;
  return u.toString();
}
