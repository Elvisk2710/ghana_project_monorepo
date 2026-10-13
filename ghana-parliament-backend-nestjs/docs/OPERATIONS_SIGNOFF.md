# Support ownership and operations sign-off (T-081)

**Nothing on this page has been agreed or signed.** It lists what operations must own before the platform can be called production-ready, with each item's current state. Names and signatures must come from Parliament; they have been left blank on purpose.

## Ownership (to be named by Parliament)

| Area | Responsibility | Owner | Backup | Contact / hours |
|---|---|---|---|---|
| Platform on-call | API, database, jobs, health, restores | _not named_ | _not named_ | _not set_ |
| AI incidents | pause or resume answering, roll back, withdraw answers (Decision #13) | _not named_ | _not named_ | _not set_ |
| AI release approval | reviewers who may approve deployments | _not named_ | _not named_ | |
| Content (Hansard) publication | approvers for public retrieval (Decision #2) | _not named_ | _not named_ | |
| Citizen cases | constituency staff, escalations, SLA | _per constituency_ | | |
| Privacy | erasure requests, retention, restores (Decision #10) | _not named_ | | |
| Identity provider | accounts, MFA, revocation | _not named_ | | |
| Security | vulnerability intake, penetration test | _not named_ | | |

## What exists and what does not

| Need | State |
|---|---|
| Runbooks (`RUNBOOKS.md`) | written by the developers; not exercised by operations |
| Alert rules (`alerting-rules.yml`) | written; never loaded into a monitoring stack or fired |
| Metrics endpoint and AI/ops gauges | implemented and tested; no Prometheus or dashboard connected |
| In-console alerts and incident workflow | implemented and tested |
| Paging or notification when an alert, a new case or an escalated case appears | **not built** |
| On-call rota, escalation path, severity definitions agreed with Parliament | **not agreed** (severity guide is in the runbooks as a proposal) |
| Backup schedule, off-site copy, restore owner | **not set up** (`DISASTER_RECOVERY.md` is a proposal and a local drill) |
| Staging environment | **does not exist** |
| Status page / citizen communication during an outage | **not built** (the public app shows a notice only when answering is paused) |
| Capacity and cost plan | load figures from one laptop only (`LOAD_TESTING.md`) |

## Sign-off checklist (operations)

Each line needs a name, a date and, where it says "evidence", a link. Do not tick a line because a document exists.

- [ ] A named on-call owner and backup for each area above, with hours and contact.
- [ ] Alert rules loaded in the real monitoring stack, each fired once in staging (evidence: alert history). Paging route confirmed.
- [ ] The operations team carried out runbook 1 (AI incident), 2 (rollback), 4 (database restore) and 5 (start-up failure) in staging (evidence: dated record, time taken).
- [ ] `npm run drill:rollback` passed in staging (evidence: output).
- [ ] A restore from a real backup was performed and `POST /internal/ai/reconstruction-test` passed on it (evidence: output, recovery time).
- [ ] The erasure ledger is exported on a schedule to storage outside the database (export schedule recorded here: ______), and its replay (`POST /internal/erasures/reapply`) was tested after a restore on staging.
- [ ] RPO and RTO agreed by Parliament and met in the restore test.
- [ ] Release thresholds (Decision #12) agreed; the load test was re-run against them in staging.
- [ ] An independent security test was completed and no critical finding is open (evidence: report).
- [ ] Parliament confirmed the data-residency position before any external model is approved (Decision #11).

Signed off by operations: ______________________  Date: ____________
