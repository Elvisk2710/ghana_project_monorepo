# Runbooks (T-081)

Written for whoever is on call. They have **not** been exercised by Parliament's operations team and no on-call rota exists yet (see `OPERATIONS_SIGNOFF.md`). Each step names the screen (AI governance, Approvals, Audit trail, Citizen cases, Overview) or the API call. "Console" means the admin console. Every action below is recorded in the audit ledger.

Severity guide: **Critical** = people are being misled or personal data is exposed; act now. **High** = a core service is down or degraded. **Medium** = degraded with a workaround. **Low** = noted.

---

## 1. An answer is wrong, harmful, or exposes something it should not (AI incident)

1. **Contain first.** Console → AI governance → Status → *Pause public answering*, with a reason. Citizens then see a notice; search and Hansard browsing keep working. (API: `POST /internal/ai/answering/pause`.) Pausing is for a reviewer or administrator.
2. **Open an incident** (AI governance → Incidents). Choose the narrowest true scope: the current deployment, a model or prompt label, or a document ID if one source is bad. Set severity. The incident has an owner (default: you).
3. **See what is affected.** Open the incident: the count of affected answers and a breakdown by version. Use *Reconstruct an answer* on an example to see the exact passages, document versions, model and approval behind it.
4. **Find the cause.**
   - Source text wrong or sensitive: unpublish the document (Hansard documents, which needs approval) or supersede it. Re-check with a new question.
   - New AI configuration at fault: *Roll back* (runbook 2).
   - Prompt injection reached a passage: the passage is quarantined from model input automatically; unpublish the document.
5. **Withdraw affected answers** (*Withdraw affected answers*, with a reason). Shared links stop showing them; the record is kept.
6. **Mark mitigated.** Then resume answering only when it is safe (*Resume public answering*, with a reason). Resume is refused while a CRITICAL incident is open.
7. **Resolve** with what was done. Tell the people who reported it. The platform does not notify anyone automatically yet.
8. After: add the failing question to an evaluation dataset so it is tested from now on.

Owner of AI incidents and who may pause answering: Parliament decision #13 is open; until it is made, REVIEWER and ADMIN roles may pause.

## 2. Roll back an AI configuration

1. Console → AI governance → Status (or Deployments) → *Roll back*, with a reason. It returns to the previous deployment, or to the built-in baseline if there was none. It takes effect on the next question.
2. Confirm: ask a test question on the public site and check the version shown under the answer (the retriever label changes), or Reconstruct the new answer.
3. The rolled-back deployment cannot return without a new request and approval.
4. If the rollback target is refused because it uses a retired version, register a new version or pause answering (runbook 1) while that is fixed.
5. Staging rehearsal: `npm run drill:rollback -- --base <staging api> --researcher <token> --reviewer <token> --admin <token>`.

## 3. A monitoring alert is open

AI governance → Monitoring shows each rule, its measured value, the threshold and the number of questions behind it. "Not enough data" is not "healthy": the window had too few questions.

| Alert | Likely meaning | First actions |
|---|---|---|
| Citation failure rate | the model returns answers that fail validation and fall back to quoting, or retrieval is returning odd passages | check the deployment's prompt and model; roll back if it began at a deployment; open an incident if citizens were shown wrong text |
| Empty retrieval rate / no-evidence drift | the corpus does not cover what people ask, or indexing broke | check Hansard documents (published count, jobs queue, dead jobs); look at recent questions |
| Retrieval score drop | the index or embedder changed, or the corpus shrank | check recent publications and re-indexing; roll back a retriever change |
| Failed question rate | retrieval or the model provider is failing | check API logs for "Retrieval failed"/"Generation failed", provider status; pause or roll back |
| Harmful or privacy reports | a citizen reported an answer | **read the reported answers now** (Reconstruct); open an incident if real. Reports are anonymous and can be abused, so this never pauses answering by itself |
| Language gap | a language is served worse than the rest | review evaluation slices for that language; do not promote until the slice is evaluated |
| Unsupported-language demand | many people ask in a language we do not support yet | no action on the system: input to Parliament's language decision (#7) |
| p95 latency | slow model or database | check provider latency, database load; consider rollback |

Acknowledge an alert to say someone has it. It resolves itself when the measure recovers or its deployment is no longer live.

## 4. Database loss or corruption

See `DISASTER_RECOVERY.md`. In short: pause answering; restore to a UTF-8 PostgreSQL; `npx prisma migrate deploy`; start the API; check `/health/ready`; **replay the erasure ledger** from your latest export with `POST /internal/erasures/reapply` (a restore brings erased case data back); run the reconstruction test; resume.

## 5. The API will not start or is not ready

- Missing configuration: the process exits with `Missing required environment variable ...`. Production requires `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, `CORS_ORIGINS` and `CASE_TOKEN_SECRET` (32+ characters).
- `/health/ready` returns `must use UTF8 encoding`: the database was created in a single-byte encoding. Recreate it as UTF-8 and restore; do not run in this state.
- `/health/ready` returns `down`: database unreachable. Check the connection string, network and the database.
- Migration errors on start-up: run `npx prisma migrate status`; never edit an applied migration.

## 6. Background jobs are failing (dead jobs)

Overview shows "dead jobs". Console → (Jobs API) `GET /internal/jobs?status=DEAD`. The `lastError` says why (extraction failure, indexing, notification delivery, evaluation). Fix the cause, then `POST /internal/jobs/:id/retry` (ADMIN). A dead evaluation job leaves its run `FAILED` with the error; start a new evaluation.

## 7. Citizen notifications are failing

Citizen cases shows failed notifications per case. Delivery goes through the provider named in `NOTIFICATION_PROVIDER` (`webhook`, `smtp`; `log` is development only). If it is unset every delivery fails visibly. Check provider credentials and reachability (Settings shows which provider is active) and the case's contact channel; retry from the case. A message the citizen can still read in the portal is not lost; staff must tell them by another route.

## 8. Cases are overdue or an emergency was submitted

Citizen cases → filter *Escalated* and *Overdue*. Escalated cases mention emergency numbers to the citizen automatically. Constituency staff (and the MP) are emailed when a case arrives or is escalated; if nobody is assigned to the constituency the administrators are emailed instead. Alerts are switched off with `STAFF_ALERTS=false`. A staff alert that cannot be sent shows as a dead background job (runbook 6), so still look at the list on a schedule. Reassign cases from a departed user; ADMIN can reroute a case between constituencies.

## 9. A staff member leaves or an account is compromised

Users & roles → set the user inactive. The change applies on their next request. Check the Audit trail filtered by that user. If a token may have been stolen, also revoke sessions in the identity provider.

## 10. Rotating `CASE_TOKEN_SECRET`

Rotating it invalidates every citizen tracking code, so citizens lose access to their cases (staff access is unaffected). Do it only after a suspected leak, and tell citizens how to re-contact their constituency office.
