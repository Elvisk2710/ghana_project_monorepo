import { randomBytes, scrypt, timingSafeEqual } from 'crypto';

const KEYLEN = 64;
const COST = { N: 16384, r: 8, p: 1 };

const derive = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(password, salt, KEYLEN, COST, (err, key) => (err ? reject(err) : resolve(key))));

export const MIN_PASSWORD_LENGTH = 10;

/** Format: scrypt$<salt hex>$<hash hex>. The password is never stored or logged. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [scheme, saltHex, hashHex] = (stored ?? '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await derive(password, Buffer.from(saltHex, 'hex'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Verified against when the email is unknown, so a missing account takes as long as a wrong password. */
export const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(KEYLEN)}`;
