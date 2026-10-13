/**
 * Per-route public rate limit. PUBLIC_RATE_LIMIT_OVERRIDE replaces every public limit
 * (tests and load tests set it high); unset in production so the defaults apply.
 */
export const rate = (limit: number, ttl = 60_000) => ({
  default: { limit: () => Number(process.env.PUBLIC_RATE_LIMIT_OVERRIDE ?? limit), ttl },
});
