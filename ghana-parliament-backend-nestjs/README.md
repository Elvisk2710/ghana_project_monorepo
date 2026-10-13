# Ghana Parliament AI Engagement - Backend API

NestJS + Prisma + PostgreSQL. Shared API for the public app and the admin console
(see `../GHANA_PARLIAMENT_AI_PRODUCT_SCOPE.md`). Phase 1 scope: tasks T-019 to T-033. Phases 2 and 3 add the public Ask API and constituency engagement.

## Run
```
cp .env.example .env          # set OIDC_* and ALFRESCO_* values
docker compose up -d postgres  # or point DATABASE_URL at any PostgreSQL 14+
npm install
npx prisma migrate deploy
npm run start:dev              # http://localhost:3000/api/v1, Swagger at /docs (non-production)
```

Alfresco (server-side only): `ALFRESCO_BASE_URL`, `ALFRESCO_USER`, `ALFRESCO_PASSWORD`, optional `ALFRESCO_FOLDER_ID`.
Metrics scrape token: `METRICS_TOKEN`. Set `JOBS_ENABLED=false` to disable the in-process queue worker.

## Test
```
npm test          # unit tests (no database)
npm run test:int  # real PostgreSQL via embedded-postgres, or set TEST_DATABASE_URL
npm run typecheck
```

## API surfaces
- `/api/v1/public/*` - anonymous, published records only, stricter rate limits.
- `/api/v1/internal/*` - OIDC bearer token; roles and constituency scope come from the `User` table, never the token.
- `/api/v1/health/{live,ready}`, `/api/v1/metrics` (bearer `METRICS_TOKEN`).

## Known limits
- Embeddings use a deterministic hashing placeholder (`HashingEmbedder`), not a semantic model. Bind a real `Embedder` once the provider is chosen.
- Search scores chunks in the application; move to pgvector/a search engine for a large corpus.
- No OCR: scanned PDFs are flagged by the quality report, not read.
- Users must be provisioned in the `User` table (matched on the OIDC `sub`); there is no self-service signup.

## Public Ask Parliament API (Phase 2)
- `POST /public/answers` `{question, language?}` -> cited answer or a typed non-answer status (`no_evidence`, `needs_clarification`, `conflicting_sources`, `unsupported_language`, `safety_refusal`, `service_unavailable` = HTTP 503).
- `GET /public/answers/:id`, `POST /public/answers/:id/feedback`, `GET /public/languages`, `GET /public/documents` (browse), `GET /public/documents/:id/passages?anchor=` (source inspection).
- Default generator is extractive (quotes passages, cannot invent). A model is used only through an **approved AI deployment** (Phase 5); the old `ANSWER_GENERATOR` switch was removed. A model also needs `ANTHROPIC_API_KEY` and sends the redacted question and public passages to the provider, so it needs the data-residency decision first.
- `PUBLIC_RATE_LIMIT_OVERRIDE` replaces all public per-route limits (tests/load tests only).
- `npm run loadtest` seeds a synthetic corpus and runs k6 against the compiled server (needs `npm run build` and k6).

## Constituency engagement API (Phase 3)
Public (anonymous):
- `GET /public/regions`, `/public/constituencies`, `/public/constituencies/lookup?q=`, `/public/constituencies/:id` - approved constituencies and the published MP; `lookup` returns `matchedOn` and a plain-language `explanation`.
- `GET /public/case-categories`, `POST /public/cases/suggest` (suggestion only; the citizen's text is never altered).
- `POST /public/cases` - needs `consent: true`, a category, a constituency and a contact channel. Returns `reference` (GH-YYYY-NNNNNN) and a `trackingCode`. Send a client-generated `submissionKey` (UUID) so a retry returns the same case.
- With header `X-Case-Token: <trackingCode>`: `GET /public/cases/:reference`, `POST .../messages`, `POST .../attachments` (multipart `file`; PDF/PNG/JPEG, 5 MB, 5 per case), `GET .../attachments/:id`, `GET .../export`, `POST .../erasure-request`. A wrong code and an unknown reference both return 404.

Internal (OIDC; roles STAFF, MP, ADMIN; access is limited to the caller's constituencies, ADMIN sees all; an out-of-scope case is reported as 404):
- `GET /internal/cases` (filters: status, assignee=me|none|id, escalated, overdue, search, cursor), `/cases/stats`, `/cases/:id`.
- `PATCH /cases/:id` (category, priority), `POST /cases/:id/{assign,status,notes,responses,escalation}`, `GET /cases/:id/export` (history + audit trail), `GET /cases/:id/attachments/:aid`.
- ADMIN only: `POST /cases/:id/reroute`, `POST /cases/:id/erase`, `POST /retention/sweep`, `POST /constituencies/import`, `POST|PATCH /mps`, `POST|PATCH /message-templates`.

Configuration: `CASE_TOKEN_SECRET` (required in production, 32+ chars; rotating it invalidates every tracking code), `CASE_RETENTION_DAYS` (default 730), `CASE_SLA_HOURS` (120) and `CASE_SLA_URGENT_HOURS` (24), `NOTIFICATION_PROVIDER` (`webhook` or `smtp` for real delivery, `log` for development only; unset means every delivery fails visibly; see `.env.example` for the provider settings), `STAFF_ALERTS`, `ADMIN_APP_URL`, `OPS_ALERT_EMAILS`, `PUBLIC_APP_URL`, optional `CLAMD_HOST`/`CLAMD_PORT` (ClamAV; if set and unreachable, uploads are refused). Boundary updates: see `docs/BOUNDARY_CHANGES.md`.

### Phase 3 known limits
- Retention period, SLA hours, category list, escalation rules and emergency wording are **provisional defaults** pending Parliament's decisions.
- No real notification provider is bound (email/SMS vendor undecided) and there are no delivery receipts, so a message is `SENT`, never `DELIVERED`.
- Built-in attachment checks are not an antivirus engine; real malware scanning needs ClamAV (`CLAMD_HOST`). Files are stored in PostgreSQL until an object store is chosen.
- The AI suggestion is a keyword heuristic, not a model. Escalation rules are English-only and deliberately broad.
- Constituency matching is by name/code/alias, not geographic.

## Parliamentary operations API (Phase 4)
Internal (read: STAFF/MP/REVIEWER/ADMIN; write: STAFF/ADMIN): `/internal/sittings`, `/bills`, `/committees` (list, get, create, PATCH); `/internal/mps` (write is ADMIN only).
- **Publication is gated.** There is no writable `isPublished`. `POST /internal/approvals {objectType: sitting|bill|committee|mp, objectId, action: publish|unpublish, reason?}` creates a request; `POST /internal/approvals/:id/decision {decision, notes?}` (REVIEWER/ADMIN, never the requester) applies it. A decision is void if the record was edited after the request. `GET /internal/approvals?decision=` is the ledger.
- Users (ADMIN): `GET /internal/users`, `POST /internal/users/invitations`, `PATCH /internal/users/:id`, `POST /internal/users/:id/active`. An invitation is a user row with a placeholder identity; it binds to the first sign-in whose token has the same email and `email_verified: true`. The last active administrator cannot be removed or deactivated.
- `GET /internal/overview` (live counts, scoped for non-admins). `GET /internal/audit-events` (ADMIN).
Public: `/public/bills[/:id]`, `/public/sittings[/:id]`, `/public/committees[/:id]`: published records only; cross-links to unpublished records are dropped.

### Phase 4 known limits
Editing a record that is already published takes effect immediately (audited, not re-approved). Documents keep their own review/publish lifecycle. Speakers are not modelled. No invitation email is sent.

## AI governance and release readiness API (Phase 5)
Internal (`/internal/ai/*`; read: RESEARCHER, REVIEWER, ADMIN): see `docs/AI_GOVERNANCE.md`.
- Registry: `GET|POST /versions`, `POST /versions/:id/retire`, `POST /registry/baseline` (ADMIN), `POST /datasets`, `GET /datasets/:id`. Versions are immutable and owned.
- Evaluation: `POST /evaluations`, `GET /evaluations[/:id[/results?failed=true]]`. Reports per language, constituency and tag, plus a release gate.
- Deployment: `POST /deployments` (needs a passing evaluation) creates an approval; a different reviewer decides it through `POST /internal/approvals/:id/decision` with `reviewedEvidence: true`. `POST /deployments/:id/rollback`, `GET /deployments[/active]`.
- Control: `GET /answering`, `POST /answering/pause|resume` (kill switch). Public: `GET /public/answering-status`; asking while paused returns 503 `answering_paused`.
- Monitoring: `GET /monitoring`, `POST /monitoring/evaluate`, `GET /alerts`, `POST /alerts/:id/acknowledge`. Gauges `ai_alerts_open`, `ai_answering_enabled`, `ops_*` on `/metrics`.
- Incidents: `POST|GET /incidents`, `GET /incidents/:id[/affected]`, `POST /incidents/:id/status|withdraw-answers`.
- Audit reconstruction: `GET /answers/:id/reconstruction`, `POST /reconstruction-test`.

Scripts: `npm run drill:rollback` (against a live API), `npm run drill:dr` (backup, destroy, restore, verify), `npm run security:audit`, `npm run loadtest`, `npm run smoke`. Documents: `docs/AI_GOVERNANCE.md`, `DISASTER_RECOVERY.md`, `SECURITY_TESTING.md`, `LOAD_TESTING.md`, `RUNBOOKS.md`, `alerting-rules.yml`, `OPERATIONS_SIGNOFF.md`.

### Phase 5 behaviour changes
- `ANSWER_GENERATOR` is gone; models arrive only through approved deployments. Without one, citizens get the extractive baseline.
- The extractive baseline now quotes the part of each passage that best matches the question instead of the first 320 characters (found by the evaluation harness: answers to "water and sanitation funding" were quoting the start of a chunk that never mentioned water).
- `/health/ready` also requires the database to be UTF-8.
- Each stored answer records its deployment, failure reason, best retrieval score and a snapshot of the exact passages it relied on.

### Phase 5 known limits
- Nothing has run in a staging environment (none exists): rollback, alerts and the restore have been demonstrated locally only.
- Release thresholds, monitoring thresholds, the incident owner and the RPO/RTO are provisional until Parliament decides (#11, #12, #13).
- No alert, new case or escalated case notifies anyone; monitoring is in-console and on `/metrics`.
- Evaluation quality is rule-based (expected status, required and forbidden text, citations); there is no model grader or human rating, and cost is token counts only.
- Only English is `supported`, so cross-language bias cannot yet be measured; Ghanaian languages are evaluated only for honest refusal.
- Not an independent penetration test; two advisories remain in build-time and non-production dependencies (see `docs/SECURITY_TESTING.md`).

## Settings, staff alerts and the erasure ledger

- `GET /internal/settings` (ADMIN, REVIEWER) shows the effective case, retrieval, language, notification and scanner settings and where each comes from. `PUT /internal/settings/cases` (ADMIN) changes retention days and response times; the change is audited and applies to new cases and closures at once. Retrieval and model settings are deliberately not editable here: they change only through an evaluated, approved AI deployment.
- Staff alerts: a new or escalated case emails the constituency's staff and MP; AI alerts and incidents email administrators (and `OPS_ALERT_EMAILS`). Messages carry a reference and a link, never the citizen's words.
- Erasure ledger: `GET /internal/erasures/ledger` and `POST /internal/erasures/reapply` (ADMIN); see `docs/DISASTER_RECOVERY.md`.
