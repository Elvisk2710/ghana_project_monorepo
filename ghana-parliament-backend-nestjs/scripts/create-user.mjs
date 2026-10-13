// Creates or updates an admin-console user who signs in with email and password.
//   node --env-file=.env scripts/create-user.mjs <email> "<display name>" <password> [ROLE,ROLE]   (default role ADMIN)
// Needs a build first (npm run build): it reuses the API's own password hashing.
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { hashPassword, MIN_PASSWORD_LENGTH } = require('../dist/auth/password.js');

const [email, displayName, password, rolesArg] = process.argv.slice(2);
if (!email || !displayName || !password) {
  console.error('Usage: node --env-file=.env scripts/create-user.mjs <email> "<display name>" <password> [ROLE,ROLE]');
  process.exit(1);
}
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  process.exit(1);
}
const roles = (rolesArg || 'ADMIN').split(',').map((r) => r.trim().toUpperCase());
const prisma = new PrismaClient();
const passwordHash = await hashPassword(password);
const e = email.trim().toLowerCase();
const user = await prisma.user.upsert({
  where: { email: e },
  update: { passwordHash, failedLogins: 0, lockedUntil: null, active: true, displayName, roles },
  create: { email: e, displayName, roles, passwordHash, externalId: `local:${randomUUID()}` },
});
console.log(`Ready: ${user.email} (${user.roles.join(', ')})`);
await prisma.$disconnect();
