import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import type { AppConfig } from '../config/env';
import { LOCAL_AUDIENCE, LOCAL_ISSUER } from './local-auth';
import { APP_CONFIG } from './token-verifier-config';

export { APP_CONFIG };

export interface VerifiedToken {
  sub: string;
  email?: string;
  emailVerified?: boolean;
}

export abstract class TokenVerifier {
  abstract verify(token: string): Promise<VerifiedToken>;
}

/** Verifies OIDC access tokens (signature, issuer, audience, expiry) against the IdP's JWKS. */
@Injectable()
export class OidcTokenVerifier extends TokenVerifier {
  private readonly jwks;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
    this.jwks = createRemoteJWKSet(new URL(config.oidc.jwksUri));
  }

  async verify(token: string): Promise<VerifiedToken> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.oidc.issuer,
        audience: this.config.oidc.audience,
        algorithms: ['RS256', 'ES256'],
      });
      if (!payload.sub) throw new Error('token has no subject');
      return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined, emailVerified: payload.email_verified === true };
    } catch {
      // Never leak verification details to the caller.
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

/**
 * Accepts tokens minted by this API's own email-and-password login (HS256) when that is enabled,
 * and everything else through the identity provider. The two never share a signing key or issuer.
 */
@Injectable()
export class CompositeTokenVerifier extends TokenVerifier {
  private readonly oidc: OidcTokenVerifier;
  private readonly key: Uint8Array | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.oidc = new OidcTokenVerifier(config);
    this.key = config.localAuth.secret ? new TextEncoder().encode(config.localAuth.secret) : null;
  }

  async verify(token: string): Promise<VerifiedToken> {
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (alg !== 'HS256') return this.oidc.verify(token);
    if (!this.key) throw new UnauthorizedException('Invalid or expired token');
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: LOCAL_ISSUER, audience: LOCAL_AUDIENCE, algorithms: ['HS256'] });
      if (!payload.sub) throw new Error('no subject');
      return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined, emailVerified: true };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
