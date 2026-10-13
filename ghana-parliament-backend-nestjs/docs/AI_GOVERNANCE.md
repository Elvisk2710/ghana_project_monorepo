# AI governance (Phase 5)

How a model, prompt or retrieval setting reaches citizens, and how it is taken away again. Everything here is enforced by the backend, not by the admin screens.

## The rule

Nothing that changes what citizens are told goes live because a job finished or someone clicked a button. It needs, in order:

1. **Registered, immutable versions** with a named owner (model, prompt, retriever, evaluation dataset). A different setting is a new version. The database rejects edits and deletes.
2. **An evaluation** of that exact model + prompt + retriever on a registered dataset, through the same pipeline citizens use. Reported overall and per language, constituency and tag.
3. **A passed release gate.** Failing runs cannot be put forward.
4. **A deployment request**, which creates an approval carrying the evidence.
5. **A decision by a different reviewer** who is not the requester, not the owner, and did not run the evaluation, and who confirms they read the failure cases and the group results (`reviewedEvidence: true`).
6. **A rollback target** recorded at activation (the previous deployment, or the built-in baseline).

Until then citizens get the built-in baseline: extractive answers that quote published passages and cannot invent facts. There is no environment switch for a model any more (`ANSWER_GENERATOR` was removed). A model-backed generator also needs `ANTHROPIC_API_KEY`, and sends the redacted question and public passages to the provider, so it needs Parliament's data-residency decision first (Decisions sheet #11).

## Roles

| Action | Roles |
|---|---|
| Read everything under `/internal/ai` | RESEARCHER, REVIEWER, ADMIN |
| Register versions and datasets, retire versions, start evaluations, request deployments | RESEARCHER, ADMIN |
| Register the baseline | ADMIN |
| Approve or reject a deployment (via `/internal/approvals/:id/decision`) | REVIEWER, ADMIN, subject to the independence rules above |
| Roll back, pause or resume answering, withdraw answers, mitigate or resolve incidents | REVIEWER, ADMIN |
| Open an incident, acknowledge an alert, reconstruct an answer | RESEARCHER, REVIEWER, ADMIN |

Who owns an AI incident and who may disable public answering is an open Parliament decision (#13). The table above is a provisional default.

## Evaluation harness (T-072)

`POST /internal/ai/evaluations {datasetId, modelId, promptId, retrieverId, thresholds?}` queues a run. A background job runs each case through `AnswersService.evaluate`, which is the production code path without storing a citizen session or audit event. Runs resume after a crash and are frozen once finished.

Dataset case fields: `key`, `question`, `language`, `constituency`, `tags`, `expectedStatus` (`grounded`, `no_evidence`, `unsupported_language`, `safety_refusal`, `needs_clarification`, `conflicting_sources`, `service_unavailable`), `expectedDocumentIds`, `mustContain`, `mustNotContain`.

Metrics per group: answer quality, retrieval recall, citation completeness, refusal quality, harmful outputs, latency p50/p95, token counts. A group with fewer than 5 cases is flagged `underpowered`, never dropped.

**Release gate** (provisional defaults, Decisions sheet #12): answer quality at least 80%, retrieval recall at least 70%, citation completeness 100%, refusal quality at least 90%, zero harmful outputs, p95 latency at most 5 s, every slice with enough cases at least 60%, and every language marked `supported` needs at least 5 cases. A strong overall score therefore cannot hide a weak constituency or language. Thresholds can be overridden per run; the thresholds used are stored on the run and shown to the approver, so a lowered bar is visible. A requirement set to 0 is not enforced.

Limits: cost is token counts only (no price table); quality is judged by the case's `expectedStatus`, `mustContain`, `mustNotContain` and citations, not by a model grader or human rating; the safety reviewer's inspection of failure cases is a confirmation checkbox, not a recorded review of each case.

## Deployments and rollback (T-074, T-077)

- `POST /internal/ai/deployments` requires a completed run whose gate passed and whose model/prompt/retriever match the request.
- Approval makes it `ACTIVE`, supersedes the previous one, and stores `rollbackTargetId`. The database allows only one `ACTIVE` deployment.
- `POST /internal/ai/deployments/:id/rollback {reason}` returns to the target (or the baseline). It takes effect on the next question on every instance: live configuration is read from the database on each request and is not cached. No second approver is needed, because speed matters; it is audited.
- A rolled-back, rejected or superseded deployment needs a new request and approval to return.
- Every stored answer records `deploymentId`, so answers can be traced to the approved configuration that produced them.

**Rollback drill:** `npm run drill:rollback -- --base https://<host>/api/v1 --researcher <token> --reviewer <token> --admin <token>` runs the whole path against a live API and exits non-zero on any failure. It is exercised in CI against a local server (`test/integration/drill.int-spec.ts`). It has **not** been run in staging because no staging environment exists yet (see the tracker note on T-077).

## Monitoring (T-075)

`MonitoringService` computes, over the live deployment's real answers in a window (default 60 minutes, previous window for drift): citation failure rate (including model output that failed validation and fell back to quoting), empty-retrieval rate, failed-question rate, harmful or privacy reports, p95 latency, no-evidence drift, retrieval-score drop, per-language failure gap (a supported language doing clearly worse than the rest), and demand in unsupported languages. A window with too few questions reports `insufficient_data`, never "OK". It opens one alert per rule and scope, refreshes it while it persists, resolves it when it recovers or its deployment is no longer live, and publishes `ai_alerts_open`, `ai_answering_enabled`, `ops_dead_jobs`, `ops_failed_notifications` and `ops_overdue_cases` on `/metrics`. It runs every 5 minutes (`MONITOR_INTERVAL_MS`) unless `JOBS_ENABLED=false`, and on demand from the console.

Thresholds are provisional (`DEFAULT_RULE_THRESHOLDS`) and can be overridden per deployment at request time. Alerts do not page anyone: see `alerting-rules.yml` and `RUNBOOKS.md`. A harmful report does **not** pause answering automatically, because anyone can submit one anonymously; a person decides.

The language-gap check can only compare languages that are served. Today only English is `supported`, so it cannot detect bias between languages; the unsupported-language demand rule is the signal that people are asking in languages we do not yet serve.

## Incidents and the kill switch (T-076)

- `POST /internal/ai/answering/pause {reason}` stops all new answers immediately (HTTP 503, status `answering_paused`, nothing stored). Search and Hansard browsing continue. `GET /public/answering-status` lets the public app say so before a citizen types. Resuming is refused while a CRITICAL incident is still OPEN (mitigate or resolve it first).
- `POST /internal/ai/incidents` records an incident with a scope (deployment, model/prompt/retriever label, cited document, answer IDs, time window). `GET .../affected` lists the answers it covers with a breakdown by version. `POST .../withdraw-answers` stops those answers from showing at their shared links while keeping the stored record. Opening an incident can pause answering in the same step (REVIEWER/ADMIN).
- The incident timeline is read from the audit ledger.

## Audit reconstruction (T-082)

Every grounded answer stores the exact passages it relied on (text, SHA-256, document id, version and checksum at that time). `GET /internal/ai/answers/:id/reconstruction` rebuilds who asked what, what they saw, the passages and document versions, whether the documents changed since, the model, prompt and retriever, the deployment's approval and evaluation, the document publication trail, and feedback. `POST /internal/ai/reconstruction-test {sample, since?}` reconstructs a random sample and names exactly what cannot be rebuilt. Answers stored before Phase 5 have no source snapshot and fail it by design.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MONITOR_INTERVAL_MS` | 300000 | how often alerts are evaluated |
| `MONITOR_WINDOW_MINUTES` | 60 | monitoring window |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANSWER_TIMEOUT_MS` | unset | provider access, used only by an approved model deployment |
| `ANSWER_MIN_SCORE` | 0.15 | baseline retrieval cut-off (deployments carry their own) |

The database must be UTF-8. `/health/ready` fails otherwise, because Ghanaian-language text and names cannot be stored in a single-byte encoding.
