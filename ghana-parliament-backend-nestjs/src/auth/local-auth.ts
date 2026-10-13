import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { SignJWT } from 'jose';
import { AuditService } from '../audit/audit.service';
import type { AppConfig } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { DUMMY_HASH, verifyPassword } from './password';
import { APP_CONFIG } from './token-verifier-config';

export const LOCAL_ISSUER = 'parliament-admin-local';
export const LOCAL_AUDIENCE = 'parliament-api';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
// One message for every failure, so the response never says which part was wrong.
const BAD = 'Incorrect email or password';

@Injectable()
export class LocalAuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  get enabled(): boolean {
    return !!this.config.localAuth.secret;
  }

  async login(emailRaw: string, password: string): Promise<{ accessToken: string; expiresIn: number }> {
    if (!this.enabled) throw new UnauthorizedException('Email sign-in is not enabled');
    const email = emailRaw.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.audit.recordSafe({ action: 'auth.login', outcome: 'denied', payload: { reason: 'locked' } });
      throw new UnauthorizedException('Too many attempts. Try again in a few minutes.');
    }

    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.passwordHash || !user.active || !ok) {
      if (user) {
        const failed = user.failedLogins + 1;
        const data = failed >= MAX_FAILURES ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } : { failedLogins: failed };
        await this.prisma.user.update({ where: { id: user.id }, data }).catch(() => undefined);
      }
      await this.audit.recordSafe({ action: 'auth.login', outcome: 'denied', payload: { reason: 'bad_credentials' } });
      throw new UnauthorizedException(BAD);
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    const ttl = this.config.localAuth.ttlMinutes * 60;
    const accessToken = await new SignJWT({ email: user.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.externalId)
      .setIssuer(LOCAL_ISSUER)
      .setAudience(LOCAL_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(new TextEncoder().encode(this.config.localAuth.secret!));
    await this.audit.recordSafe({ action: 'auth.login', outcome: 'success', objectType: 'user', objectId: user.id });
    return { accessToken, expiresIn: ttl };
  }
}
