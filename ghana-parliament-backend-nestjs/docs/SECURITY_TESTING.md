# Security testing (T-079)

**This is automated and developer-run testing. It is not an independent penetration test, and it does not support the statement "no critical findings open".** That statement needs an independent tester, a scoped engagement and a staging environment, none of which exist yet.

## What is tested automatically

`test/integration/security.int-spec.ts` reads every route from the controllers (so new endpoints are covered without editing the test) and checks, against a real database:

| Check | Result |
|---|---|
| No route outside `/public`, `/health`, `/metrics` is reachable without a token, and none under `/internal` is public | enforced |
| Every internal route declares explicit roles (only `GET /internal/me` is open to any signed-in user) | enforced |
| Every public write has an explicit rate limit | enforced |
| Every internal route returns 401 without a token and 403 for an identity that is not provisioned | enforced for all routes |
| For every internal route and each of the six roles: a role that is not listed gets 403; a listed role is never 401 and never crashes (500) on an empty request | enforced for all routes (more than 300 denials and 150 permitted calls per run) |
| A deactivated user is refused immediately | enforced |
| Public error bodies do not contain stack traces or library paths | enforced for sampled routes |

Other suites cover: constituency scoping and "out of scope looks like not found" for cases; four-eyes publication approval; the audit ledger being append-only at the database; prompt-injection handling and PII redaction on the public Ask flow; attachment validation and the EICAR test file; tracking-code access to cases; rate limiting; CORS allow-list; helmet headers; Swagger disabled in production (smoke test against the compiled build).

Found and fixed by the matrix in Phase 5: `POST /internal/jobs/:id/retry` returned 500 for an unknown job instead of 404.

## Dependency audit (`npm run security:audit`, 12 Oct 2026)

| Project | Production findings |
|---|---|
| Admin console | none |
| Public app | none |
| Backend | 5 advisories, all through two packages |

Backend detail and assessment:

- `prisma` (CLI) / `@prisma/config` / `deepmerge-ts` (high, stack exhaustion when merging recursive objects). Reached through the Prisma CLI's configuration loading, which runs at build and migration time, not on request paths. The suggested "fix" is a downgrade to an old major version. Watch for a Prisma 6.x release that updates the dependency.
- `@nestjs/swagger` / `js-yaml` (moderate, CPU use on crafted YAML merge keys). Swagger is mounted only when `NODE_ENV` is not `production`. The fix is a major upgrade (`@nestjs/swagger` 12).

These are recorded, not dismissed: re-run the audit at each release and decide on the upgrade.

## Not covered (needs an independent tester and staging)

- Authentication against the real identity provider (token validation is tested with a stand-in verifier and a JWKS test; misconfiguration of the real realm is not).
- Infrastructure: TLS, network exposure, WAF, secrets handling, container hardening, database access controls.
- Business-logic abuse by a skilled attacker, and abuse of the public Ask flow beyond the injection patterns tested (the pattern list is a screen, not a guarantee).
- Real malware scanning (the built-in attachment checks are not an antivirus engine; ClamAV has never been run against a real daemon).
- Denial of service beyond per-route rate limits and the load test.
- Social engineering and operational security of the people holding ADMIN.

## Suggested scope for the independent test

Public surface (`/public/*`: Ask, search, constituencies, cases with tracking codes, attachments), the admin console and `/internal/*` with each role, the OIDC integration, the AI governance workflow (can a lower-privileged user cause a configuration to go live, read question text, or pause answering?), file upload, and the deployment environment.
