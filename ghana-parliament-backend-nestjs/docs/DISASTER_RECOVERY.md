# Disaster recovery, backups and retention (T-080)

**Status of the numbers below:** the recovery targets are *proposals* for Parliament to accept or change (Decisions sheet #10 covers retention; there is no agreed RPO/RTO). The measurements are from a throw-away database on a developer laptop, not from Parliament's infrastructure.

## What must be recoverable

| Data | Where | Notes |
|---|---|---|
| Everything transactional (documents, chunks, cases, approvals, AI registry, audit ledger, answers) | PostgreSQL | one database; the only store that must be backed up for the platform to come back |
| Document files | Alfresco (or the chosen repository) | backed up by the repository's owner; the platform stores a reference and an extracted copy |
| Case attachments | PostgreSQL today | move to an object store when chosen; back that up too |
| Secrets (`CASE_TOKEN_SECRET`, OIDC and provider keys) | secret store | losing `CASE_TOKEN_SECRET` invalidates every citizen tracking code |

## Proposed targets (to be agreed)

| | Proposed | Why |
|---|---|---|
| RPO (data you can lose) | 15 minutes | continuous WAL archiving or managed point-in-time recovery; citizen cases are the data that hurts to lose |
| RTO (time to serve again) | 4 hours | includes provisioning and checking; the measured technical restore is minutes |
| Backup retention | 35 days of PITR plus monthly fulls for 12 months | subject to the privacy and retention decision (#10) |

## Procedure

1. Declare the incident (see `RUNBOOKS.md`, "Database loss or corruption"). Pause public answering so no new answers are written against a database about to be replaced.
2. Provision PostgreSQL 14+ with **UTF-8** encoding. Restore the chosen backup or recovery point. Do not start the API yet.
3. Run `npx prisma migrate deploy`. It must report nothing to apply on a current backup; on an older one it applies the missing migrations.
4. Start the API. `/health/ready` must return `ok`.
5. **Re-apply erasures made after the backup** (below).
6. Run the checks in "What the drill verifies" against the restored database.
7. Run `POST /internal/ai/reconstruction-test` and the rollback drill when staging exists.
8. Resume answering, record the recovery point and time in the incident.

### Erasures and restores

A citizen's erasure request anonymises their case in the database. Restoring a backup taken before the erasure **brings the personal data back**. The platform therefore keeps an **erasure ledger**: an append-only table (`ErasureLedger`, enforced by database triggers) with one row per erased case: the case ID, its public reference, why it was erased and when. It holds no personal data, so it can be stored anywhere.

- **Export** (ADMIN): `GET /internal/erasures/ledger` (optionally `?since=<time>`), or *Settings → Download erasure ledger* in the console. The file carries a SHA-256 checksum of its entries. Export it on a schedule (at least as often as backups) and keep it **outside the database and outside the backup**, for example in object storage with retention locks.
- **Replay after a restore** (ADMIN): `POST /internal/erasures/reapply` with `{ "entries": [...] }` taken from the latest export. Every listed case that still holds personal data is erased again; cases already erased are counted, unknown cases are reported, and repeating the call is safe. The replay is written to the audit trail (`case.erasure_reapply`).
- Erasures newer than your last export cannot be replayed: the schedule of exports sets how much can be lost. Operations must record the export schedule in OPERATIONS_SIGNOFF.md.

## The drill (`npm run build && npm run drill:dr`)

Seeds a database (25 published documents with chunks, a case, an erased case, answers with source snapshots, audit events, an AI version, Twi text), takes a cold physical backup, makes further changes, destroys the primary, restores the backup into a fresh cluster and checks:

- row counts and the audit ledger order match the backup point;
- Twi text survives and the database is UTF-8;
- the audit append-only trigger, the AI-version immutability trigger and the one-live-deployment rule are still enforced after restore;
- stored answer-source snapshots still match their hashes;
- an erasure made after the backup is identified as needing re-application;
- the compiled API starts on the restored database, reports ready, answers a public question with citations, and the answer can be re-opened.

Last measured run: restore to first correct public answer **20.6 s** (cluster start, API start, first question), 25 documents. Data after the backup point was lost as expected (1 answer; 1 erasure to re-apply).

**Not proven:** restore from a real production backup, point-in-time recovery, a managed-database restore, restoring Alfresco, behaviour at production data volumes (restore time grows with size), and the restore procedure being carried out by the operations team rather than by the developers. `pg_dump` and `pg_basebackup` are not available in this environment, so the drill uses a cold copy of the data directory; production should use the database provider's backup tooling.

## Retention verification

Case retention is enforced by `POST /internal/retention/sweep` (ADMIN), tested in the integration suite: cases past `retainUntil` and closed are anonymised, others untouched, and each is audited. The retention period (730 days) is a provisional default. Verify after any restore that cases past their retention date are swept again (`retainUntil < now()` and `anonymizedAt IS NULL` and status `CLOSED`). Audit events are never deleted; their retention is a separate decision still open.
