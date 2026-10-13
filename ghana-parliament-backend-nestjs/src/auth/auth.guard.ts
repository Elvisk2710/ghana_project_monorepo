import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
import type { RequestStore } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC } from './decorators';
import type { Principal } from './principal';
import { TokenVerifier } from './token-verifier';

/**
 * Global authentication guard. Identity comes from a verified OIDC token; roles and
 * constituency scope come from the database so that deactivation or role changes
 * take effect immediately and a token alone can never grant privilege.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    const match = header?.match(/^Bearer (.+)$/i);
    if (!match) {
      await this.audit.recordSafe({ action: 'auth.denied', outcome: 'denied', payload: { reason: 'missing_token', path: req.url } });
      throw new UnauthorizedException('Authentication required');
    }

    let sub: string;
    let tokenEmail: string | undefined;
    let verified = false;
    try {
      const t = await this.verifier.verify(match[1]);
      sub = t.sub;
      tokenEmail = t.email;
      verified = t.emailVerified === true;
    } catch (err) {
      await this.audit.recordSafe({ action: 'auth.denied', outcome: 'denied', payload: { reason: 'invalid_token', path: req.url } });
      throw err;
    }

    // First sign-in of an invited person: bind the invitation to this identity, only on a verified email.
    if (tokenEmail && verified) {
      await this.prisma.user.updateMany({ where: { email: tokenEmail.toLowerCase(), externalId: { startsWith: 'pending:' }, active: true }, data: { externalId: sub } });
    }
    const user = await this.prisma.user.findUnique({
      where: { externalId: sub },
      include: { constituencies: { select: { constituencyId: true } }, mp: { select: { constituencyId: true } } },
    });
    if (!user || !user.active) {
      await this.audit.recordSafe({ action: 'auth.denied', outcome: 'denied', payload: { reason: user ? 'inactive_user' : 'unknown_user', path: req.url } });
      throw new ForbiddenException('Account not authorised for this system');
    }

    if (!user.lastLoginAt || Date.now() - user.lastLoginAt.getTime() > 3600_000) {
      await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => undefined);
    }
    const constituencyIds = new Set(user.constituencies.map((c) => c.constituencyId));
    if (user.mp) constituencyIds.add(user.mp.constituencyId);

    const principal: Principal = {
      userId: user.id,
      externalId: user.externalId,
      email: user.email,
      roles: user.roles,
      constituencyIds: [...constituencyIds],
    };
    req.principal = principal;
    this.cls.set('principal', principal);
    return true;
  }
}
