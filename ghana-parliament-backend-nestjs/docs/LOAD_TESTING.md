# Load testing (T-078)

**No release targets have been agreed** (Decisions sheet #12: latency, citation and cost thresholds). The pass/fail numbers in the scripts (ask p95 under 1.5 s, search under 0.8 s, list under 0.5 s, under 1% errors) are developer-chosen placeholders. The measurements below are from one developer laptop, one Node process, one local PostgreSQL, a synthetic corpus and no network latency. They show behaviour and limits, not production capacity.

## Run it

```
npm run build
node scripts/loadtest/run.mjs 200                         # k6, 20 virtual users for 30 s (needs k6)
LOAD_DRIVER=node LOAD_CLIENTS=60 LOAD_SECONDS=20 node scripts/loadtest/run.mjs 200   # dependency-free driver
```

The harness boots a throw-away UTF-8 PostgreSQL, seeds N synthetic published Hansards (here 200 documents, 1,200 chunks), starts the compiled production build and drives the public API: ask (with a cited answer), search and Hansard list.

## Measured on 12 Oct 2026 (after Phase 5 changes)

Node driver, closed loop (each client repeats ask, search, list with no pause), 20 s each:

| Concurrent clients | Throughput | Ask p95 / p99 | Search p95 | List p95 | Errors |
|---|---|---|---|---|---|
| 20 | 51 asks/s | 258 / 1036 ms | 130 ms | 129 ms | 0 |
| 60 | 52 asks/s | 1131 / 1250 ms | 365 ms | 371 ms | 0 |
| 150 | 54 asks/s | 2242 / 2325 ms | 814 ms | 855 ms | 0 |

k6 (20 virtual users with 0.5 s think time): ask p95 830 ms, search p95 135 ms, list p95 122 ms, 0 failures, all placeholder thresholds met. k6 reported a much lower request rate than the Node driver on this machine (about 4 requests/s); the latency figures are consistent between the two but the k6 throughput figure should not be quoted.

## What it shows

- **One process saturates at roughly 50 asks per second** on this machine: adding clients only adds queueing delay. Ask is CPU-bound in the application because retrieval scores every chunk in JavaScript.
- Scaling is horizontal (more API instances) until retrieval moves to pgvector or a search engine. The corpus here is small; real Hansard volume will be slower per query.
- The slowest 1% of requests (p99 about 1 s at 20 clients) are far above the median. The likely cause is the in-memory chunk cache being filled while the first requests arrive (the server also warms it at start-up), but this was not isolated.
- Phase 5 added two small queries per question (the kill-switch flag and the live deployment) so a rollback or pause takes effect on the next question on every instance. Their cost was not measured separately from the rest of the request.
- No errors at 150 concurrent clients. The per-IP rate limits (10 asks per minute per IP by default) are lifted in the harness with `PUBLIC_RATE_LIMIT_OVERRIDE`; in production they will dominate before CPU does for a single user.

## Not measured

Real model-backed answers (provider latency and rate limits), the admin console and case workflow under load, database sizing at real volume, sustained multi-hour load, spike behaviour, behind a real load balancer and TLS, and anything on Parliament's infrastructure. The "targets met" outcome therefore cannot be claimed for T-078 until targets exist and the test runs in staging.
