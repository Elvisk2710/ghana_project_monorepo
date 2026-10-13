export interface AppConfig {
  nodeEnv: string;
  port: number;
  corsOrigins: string[];
  throttleTtlMs: number;
  throttleLimit: number;
  oidc: {
    issuer: string;
    audience: string;
    jwksUri: string;
  };
  /** Email-and-password sign-in. Off unless LOCAL_AUTH_SECRET is set. */
  localAuth: { secret: string | null; ttlMinutes: number };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable ${key}`);
  return value;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
  return n;
}

/** Validates the environment at boot so misconfiguration fails fast. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  required(env, 'DATABASE_URL');
  const issuer = required(env, 'OIDC_ISSUER');
  const corsOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (env.NODE_ENV === 'production' && corsOrigins.length === 0) {
    throw new Error('CORS_ORIGINS must be set in production');
  }
  const localSecret = env.LOCAL_AUTH_SECRET?.trim() || null;
  if (localSecret && localSecret.length < 32) throw new Error('LOCAL_AUTH_SECRET must be at least 32 characters');
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: int(env, 'PORT', 3000),
    corsOrigins,
    throttleTtlMs: int(env, 'THROTTLE_TTL_MS', 60_000),
    throttleLimit: int(env, 'THROTTLE_LIMIT', 100),
    oidc: {
      issuer,
      audience: required(env, 'OIDC_AUDIENCE'),
      jwksUri: env.OIDC_JWKS_URI || `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`,
    },
    localAuth: { secret: localSecret, ttlMinutes: int(env, 'LOCAL_AUTH_TTL_MINUTES', 480) },
  };
}
