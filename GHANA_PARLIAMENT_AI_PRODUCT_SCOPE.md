# Ghana Parliament AI Engagement — Product Scope, User Journeys and Architecture

**Status:** Discovery and alignment baseline  
**Source of truth:** `Ghana_Parliament_AI_Engagement_Proposal_v2.pdf`, plus the two application repositories in this workspace  
**Prepared:** 2026-10-08  

## 1. Executive conclusion

The two projects are not two unrelated products. They are the two experience surfaces of one proposed Ghana Parliament AI Engagement Platform:

```text
Citizens / public researchers / MPs
              │
              ▼
Public Parliament Connect experience
  search • ask Parliament • understand Hansard • find/contact MP
              │
              │ authenticated APIs and workflow events
              ▼
Shared platform services
  identity • parliamentary data • search/RAG • AI orchestration
  cases/workflows • notifications • audit • analytics • governance
              │
              ▼
Internal Parliament operations console
  corpus • sittings • bills • cases • committees • MPs
  users/roles • approvals • MLOps • safety/compliance settings
```

The public project is the trust and access layer. The admin project is the data, workflow, publishing, and governance layer. The proposal’s value is achieved only when a user action in the public experience can safely produce a traceable operational outcome in Parliament, and when an approved parliamentary record can flow back into the public experience as a reliable, cited answer.

At present, that relationship exists mainly in the product concept and visual prototypes, not in the implementation:

- The public app is a single React/Vite page with local state, a hard-coded sample answer, hard-coded sources, non-functional navigation links, and a language selector that changes local UI state only.
- The admin app is an Angular standalone application despite its repository name, with lazy-loaded pages and a polished operational-console shell.
- Most admin records are held in an in-memory `DataService`; refresh loses changes.
- The admin app includes an Alfresco service for document upload/list/delete, but this is not yet the platform’s full data backbone and currently contains browser-side `admin` / `admin` credentials.
- There is no shared backend API, identity provider, public-to-admin case workflow, AI inference service, vector store, notification service, or end-to-end audit trail connecting the two apps.

The immediate goal should therefore be to turn two demonstrations into one governed platform with a thin, explicit domain contract between them.

## 2. How to read this document

This document separates three kinds of statements:

| Label | Meaning |
|---|---|
| **Evidence** | Directly visible in the PDF headings, source files, routes, models, or services. |
| **Product interpretation** | A coherent interpretation of how the evidence fits together. It must be validated with Parliament stakeholders. |
| **Recommendation** | The architecture or delivery decision proposed here to make the product operable and safe. |

The proposal PDF is a designed, partially flattened document. Its recoverable structure confirms the key themes of the engagement: Ghana Parliament AI, a public/MP-facing experience, an MP dashboard, backend and AI layers, role-based access, use cases, and AI-bias/compliance concerns. Where exact PDF wording is not machine-readable, this document does not pretend to quote it; it uses the proposal’s visible intent together with repository evidence and marks decisions that need confirmation.

## 3. Product definition

### 3.1 Product name and promise

Working product name: **Ghana Parliament AI Engagement Platform**.

Public promise: **make parliamentary information understandable, searchable, multilingual, and actionable, while preserving the authority of the underlying record.**

Institutional promise: **help Parliament curate its records, respond to constituents, manage parliamentary workflows, and operate AI with role-based controls, evidence, safety checks, and accountability.**

### 3.2 Primary outcomes

1. Citizens can find and understand parliamentary information without needing to read an entire Hansard.
2. Citizens can locate the correct MP and submit a structured issue or message that Parliament can triage and answer.
3. MPs and authorised staff can see constituency cases, respond, and maintain a durable record of actions.
4. Parliamentary staff can ingest, classify, review, approve, index, and publish trusted records.
5. AI answers are grounded in approved sources, cite those sources, disclose uncertainty, and are logged for review.
6. Parliament can measure usage, service response, data quality, language quality, bias, and model performance.

### 3.3 Non-goals for the first production release

- The system is not a replacement for Parliament’s official publication, legislative procedure, or legal advice.
- The AI must not create an official parliamentary position, decision, vote, bill status, or constituency commitment without an authorised human source.
- The platform should not attempt unrestricted general-purpose chat about all government services in the first release.
- Fine-tuning large language models from the admin UI is not required for the first citizen value milestone; governed retrieval, prompt orchestration, evaluation, and human approval are higher priority.
- A citizen case is not automatically a legally binding petition or a guaranteed service-delivery request.

## 4. Relationship between the two projects

### 4.1 Public experience: `ghana-parliament-generativeai-web-angular-main`

Despite its name, this is a React 19 + Vite + Tailwind project.

**Current evidence**

- One main `App.tsx` composes the page.
- The page exposes a Parliament-branded header with `Hansards`, `My MP`, `Issues`, and `About` navigation labels.
- It offers an “Ask Parliament” prompt, example questions, a language selector for English, Akan/Twi, Ewe, Ga, Dagbani, and Hausa, and three feature concepts: summarise a sitting, search by topic, and message an MP.
- Submitting the prompt only toggles a local answer card.
- The answer and three sources are hard-coded around a fuel-pricing example.
- The app has no router, backend client, authentication, persistence, or API error state.

**Product role**

This is the citizen-facing discovery and engagement surface. It should eventually consume public APIs for search, grounded answers, parliamentary profiles, issue submission, and status tracking.

### 4.2 Internal console: `ghana-parliament-generativeai-web-admin-angular-main`

This is an Angular standalone app using Vite, despite the package name and initial Angular placeholder files.

**Current evidence**

- Routes exist for overview, documents, users, MLOps, sittings, bills, cases, committees, MPs, audit, and settings.
- Sidebar groups are `Operations`, `Parliamentary`, and `AI / MLOps`.
- Models exist for documents, users, training jobs, sittings, bills, citizen cases, committees, MPs, approvals, audit entries, and training logs.
- `DataService` holds representative sample records and mutates signals locally.
- The documents page uses `AlfrescoService` for upload/list/delete capability.
- `AlfrescoService` points requests through `/alfresco` to `http://localhost:8080/alfresco` and uses a hard-coded shared-folder node ID.
- The service currently logs into Alfresco as `admin` / `admin` in browser code. This is a release blocker.
- The root application displays corpus size, running training jobs, and a compliance label, but these are not yet connected to authoritative backend state.

**Product role**

This is the operational system of record for content, workflows, human review, users, parliamentary structures, AI operations, approvals, and audit. It should not be exposed as a public client.

### 4.3 The missing contract

The projects need a shared backend contract, not shared UI code. The contract should define:

- identity and roles;
- public versus internal data visibility;
- document and source lifecycle;
- search and answer request/response formats;
- citation and provenance requirements;
- citizen case creation, assignment, status, response, and closure;
- MP/constituency matching;
- publication and approval events;
- notification events;
- audit events;
- model/version and safety metadata.

The public app should never query Alfresco, the admin database, vector storage, or model infrastructure directly. The admin app should never be the only place where a public workflow exists. Both should call domain APIs through a backend-for-frontend or API gateway.

## 5. Proper product structure

### 5.1 Public product information architecture

Recommended top-level navigation:

1. **Ask Parliament**
   - natural-language question;
   - suggested questions;
   - answer with citations;
   - source and confidence explanation;
   - follow-up questions within the same evidence set.
2. **Hansards and debates**
   - browse by sitting/date/topic;
   - search and filters;
   - document detail;
   - speaker/MP contributions;
   - original record and AI summary.
3. **Bills and parliamentary business**
   - bill profile;
   - current stage;
   - sponsor/committee;
   - related sittings and documents;
   - public consultation where approved.
4. **Find my MP**
   - constituency selection or assisted lookup;
   - MP profile;
   - contact channels and office details;
   - public activity/attendance only where officially approved.
5. **Issues and messages**
   - submit an issue;
   - choose topic and constituency;
   - attach evidence where permitted;
   - view case reference and status;
   - respond to follow-up requests.
6. **About, help, and accessibility**
   - what the AI can and cannot do;
   - privacy and consent;
   - language help;
   - official-source explanation;
   - support and feedback.

The public experience should avoid calling every feature “AI”. The durable product concepts are records, answers, sources, MPs, bills, issues, and actions. AI is an assistive layer inside those concepts.

### 5.2 Internal product information architecture

**Operations**

- Overview: operational health, unpublished items, case SLA, index freshness, model health, safety alerts.
- Hansard Corpus: ingest, metadata, OCR/transcription quality, review, chunking, indexing, publication.
- Users & Roles: identity, invitations, role assignment, access reviews, deactivation.

**Parliamentary operations**

- Sittings & Order Paper: schedule, agenda, attendance, linked documents, publication status.
- Bills Tracker: stages, sponsors, committees, deadlines, consultation, related evidence.
- Citizen Cases: intake, triage, assignment, response, escalation, closure, SLA.
- Committees: membership, chair, remit, meetings, documents, permissions.
- MP Directory: member profile, constituency, party, contact channels, availability, official status.
- Audit & Approvals: publication approvals, model approvals, access events, administrative ledger.

**AI and governance**

- Training/Evaluation: dataset versions, evaluation runs, language coverage, retrieval quality, safety tests, deployment candidates.
- Model and prompt registry: version, owner, purpose, status, rollback target, approval.
- Settings: retrieval thresholds, languages, safety rules, retention, consent, integrations.
- Bias and quality: language parity, constituency coverage, refusal quality, citation completeness, harmful-output monitoring.

### 5.3 Domain boundaries

| Domain | Owns | Public read | Internal write |
|---|---|---:|---:|
| Parliamentary records | sittings, Hansards, bills, committees, official metadata | approved only | staff/editor |
| Search and answers | queries, retrieval, citations, answer sessions, feedback | yes, through API | AI/service |
| People and representation | MPs, constituencies, roles, public contacts | approved only | authorised staff |
| Citizen engagement | issues, messages, attachments, status, responses | own cases | MP/staff |
| Identity and access | users, roles, sessions, permissions | no | administrators/IdP |
| AI governance | prompts, models, evaluations, incidents | selected transparency | AI governance roles |
| Audit and analytics | immutable events, metrics, reports | aggregate only | system/admin |

## 6. User journeys

### Journey A — Citizen asks a parliamentary question

**Goal:** understand what Parliament said or did about a topic.

1. Citizen opens Ask Parliament.
2. Citizen selects a preferred language or keeps English.
3. Citizen enters a question, such as “What did Parliament say about fuel prices in 2024?”
4. Frontend sends `question`, language, optional date/topic filters, and anonymous/session identifier to the Answer API.
5. Retrieval service searches only approved, published sources and returns ranked evidence.
6. Answer orchestrator produces a concise answer grounded in those passages.
7. Response includes citations, source titles, dates, record type, and a statement when evidence is incomplete or conflicting.
8. Citizen opens a citation to inspect the source or the relevant passage.
9. Citizen gives useful/not useful feedback and optionally reports a problem.
10. System logs the query, retrieval set, answer version, citations, latency, feedback, and safety decision without exposing unnecessary personal data.

**Done when**

- A real question returns a real answer from approved records.
- Every factual claim intended as parliamentary information has a citation or is explicitly labelled as inference/uncertainty.
- No answer is generated from drafts or unapproved records.
- Empty retrieval, conflicting records, unsupported language, and service failure have clear user-safe states.
- The user can reach the original source within two actions.

### Journey B — Citizen searches and reads a Hansard

1. Citizen opens Hansards and searches by phrase, topic, date, or sitting.
2. Search results show record type, date, sitting, topic, and publication status.
3. Citizen opens a record detail page.
4. Page presents official content first, with AI summary clearly separated.
5. Citizen expands speakers, related bills, committees, and related sittings.
6. Citizen shares or copies a stable link to the official record.

**Done when**

- Results are deterministic, filterable, paginated, and linked to stable record IDs.
- Official text is never replaced by the summary.
- A summary can be regenerated/versioned without changing the source record.
- Search respects publication and language permissions.

### Journey C — Citizen finds an MP and sends an issue

1. Citizen chooses constituency manually or uses an approved location/constituency lookup.
2. System shows the matched MP and explains how the match was made.
3. Citizen selects “Message my MP” or “Raise an issue”.
4. Citizen enters a short description, category, optional location, preferred response language, and consent/contact details.
5. AI suggests a category and summary but does not silently alter the citizen’s words.
6. Citizen reviews and confirms the submission.
7. System creates a case reference, sends acknowledgement, and routes the case to the MP/staff queue.
8. Staff triages, assigns, requests clarification, responds, escalates, or closes.
9. Citizen sees status history and receives permitted notifications.

**Done when**

- A case reaches the correct constituency queue with a durable ID.
- Citizen consent, contact preference, category, assignment, and timestamps are stored.
- AI classification is editable and its confidence is visible to staff.
- Staff can respond without exposing internal notes.
- Citizen can distinguish received, triaged, in progress, awaiting information, resolved, and closed.

### Journey D — MP or constituency staff manages cases

1. Authorised user signs in through the institutional identity provider.
2. Dashboard shows cases assigned to the user, unassigned cases, ageing, priority, and SLA risk.
3. User opens a case with original citizen text, AI classification, location, attachments, history, and audit events.
4. User corrects category/priority, assigns ownership, and adds an internal note.
5. User sends a response using an approved template or writes a custom response.
6. System records sender, time, channel, content version, and delivery result.
7. User resolves or escalates the case; citizen receives the appropriate status update.

**Done when**

- Access is restricted by role and, where applicable, constituency.
- All state transitions are validated and audited.
- Internal notes never appear in the public API.
- Response delivery and failure are visible.
- An exportable case history exists for accountability.

### Journey E — Staff ingests and publishes parliamentary material

1. Staff uploads a document or synchronises it from the approved repository.
2. System extracts text, records metadata, computes a checksum, and identifies duplicates.
3. Quality checks report OCR/transcription issues, page coverage, language, and unsupported formats.
4. Staff reviews title, date, type, sitting, speakers, committee, bill links, language, and sensitivity.
5. System chunks and indexes only after the document passes the publication gate.
6. Reviewer approves or rejects publication.
7. Public search and RAG indexes receive a versioned publication event.
8. The system records who approved it and the exact content/model/index versions used.

**Done when**

- A document has a stable ID, version, provenance, metadata, checksum, and lifecycle status.
- Draft or rejected documents cannot be retrieved by public search.
- Re-indexing is idempotent and observable.
- Publication can be rolled back without deleting the original record.

### Journey F — AI governance and model release

1. AI/research user creates an evaluation run against a versioned dataset.
2. Run reports answer quality, retrieval recall, citation completeness, refusal quality, latency, cost, and language/constituency slices.
3. Safety reviewer inspects known failure cases and bias reports.
4. Candidate model/prompt/retriever is submitted for approval.
5. Authorised approver accepts, rejects, or requests remediation.
6. Approved version is deployed with a rollback target and monitoring thresholds.
7. Production feedback and incidents link back to the deployed version.

**Done when**

- No model or prompt is promoted solely because a training job completed.
- Deployment has approval, evaluation evidence, owner, rollback, and monitoring.
- Low-resource languages are evaluated separately, not hidden by aggregate scores.
- A safety incident can identify affected answer versions and be remediated.

## 7. Recommended technical architecture

## 7.0 Backend integration scope

The backend is a required product layer, not an optional implementation detail. It turns the two frontend prototypes into one governed platform. Frontends call domain APIs; domain APIs call infrastructure adapters. The browser must not call Alfresco, a database, a vector store, or an LLM provider directly. This also removes the current browser-side `admin` / `admin` Alfresco credential blocker.

Required integrations are: OIDC identity and RBAC; an API gateway/BFF; canonical parliamentary records; a server-side Alfresco adapter; relational persistence; keyword/vector search; an AI model runtime; queues/events for ingestion and notifications; notification delivery; and structured observability plus immutable audit events.

The first backend delivery must prove two vertical slices:

1. **Trusted knowledge:** Alfresco document ? metadata validation ? approval ? extraction/chunking ? search/vector index ? cited public answer ? feedback/audit.
2. **Constituency engagement:** public issue submission ? constituency/MP routing ? staff case queue ? authorised response ? citizen status/notification ? audit.

Each slice must include database persistence, authentication/authorization, API contracts, failure states, observability, and automated tests. A UI that only displays seeded or in-memory state is not an integration.


### 7.1 Logical architecture

```text
Web clients
  Public React/Vite app        Internal Angular console
          │                              │
          └──────────────┬───────────────┘
                         ▼
                 API gateway / BFF
         authentication • rate limits • CORS
                         │
       ┌─────────────────┼──────────────────┐
       ▼                 ▼                  ▼
 Parliamentary      Engagement          AI platform
 domain API         workflow API        orchestration API
       │                 │                  │
       ├──────────┬──────┼──────┬───────────┤
       ▼          ▼      ▼      ▼           ▼
 PostgreSQL   Alfresco  Queue  Notifications  Model/eval registry
 records      content   events  email/SMS/etc  + observability
                  │
                  ▼
       Extract → normalize → chunk → embed → vector index
                                              │
                                              ▼
                                  grounded answer service
```

### 7.2 Recommended service responsibilities

**Identity and access service**

- OIDC/OAuth2 integration with Parliament’s identity provider.
- Public anonymous/session identity with consent where needed.
- Staff roles, MP roles, researcher roles, administrator roles, and resource-level permissions.
- No credentials embedded in frontend bundles.

**Parliamentary records service**

- Canonical records for sittings, documents, bills, committees, MPs, constituencies, and relationships.
- Alfresco may remain the content repository, but the domain service owns lifecycle and metadata contracts.
- Versioning and publication status are explicit.

**Ingestion/indexing service**

- Pull/upload from Alfresco.
- Extract/OCR/transcribe.
- Validate metadata.
- Chunk by semantic and parliamentary boundaries.
- Embed, index, and publish index version.
- Dead-letter queue and retry handling.

**Search and answer service**

- Hybrid keyword + vector retrieval.
- Metadata filters for date, sitting, bill, committee, language, and publication status.
- Reranking, context assembly, answer generation, citations, uncertainty, and refusal.
- Prompt/model version capture for every answer.

**Citizen engagement service**

- Case intake, categorisation, assignment, status machine, internal notes, public responses, attachments, consent, notifications, and retention.
- Human review for sensitive or high-risk categories.

**AI governance service**

- Dataset/model/prompt/retriever versions.
- Evaluation runs and slices.
- Approval queue.
- Bias and language-quality reports.
- Deployment and rollback metadata.

**Audit/observability service**

- Append-only event stream for administrative and AI decisions.
- Correlation IDs across public query, retrieval, answer, feedback, and case workflows.
- Metrics, logs, traces, incident records, and exportable reports.

### 7.3 Data model minimum

Core entities should include:

- `ParliamentaryDocument`: ID, source URI, type, title, date, sitting, version, language, checksum, lifecycle, publication, owner, reviewer.
- `DocumentChunk`: document version, sequence, text, page/paragraph anchor, embedding ID, index version, language.
- `Sitting`: date, type, agenda, linked documents, status, publication state.
- `Bill`: title, sponsor, stage, committee, dates, related records, public status.
- `MP`: official identity, constituency, party, role, public contact, active dates.
- `Constituency`: code, name, region, lookup geometry/rules, current representative.
- `QuestionSession`: question, language, filters, retrieval set, answer, citations, model/prompt versions, feedback.
- `CitizenCase`: public ID, citizen identity/contact reference, constituency, category, priority, status, assignment, consent, timestamps.
- `CaseMessage`: author type, visibility, content, delivery channel, delivery state, version.
- `Approval`: object type, object version, decision, approver, evidence, timestamp.
- `AuditEvent`: actor, action, object, before/after or event payload, request ID, timestamp.

### 7.4 Answer contract

The public answer endpoint should return a shape equivalent to:

```json
{
  "answerId": "ans_123",
  "answer": "...",
  "language": "en",
  "status": "grounded",
  "confidence": "medium",
  "disclosure": "AI-generated summary based on published parliamentary records.",
  "citations": [
    {
      "documentId": "HAN-1000",
      "title": "Petroleum Pricing (Deregulation) — Second Reading",
      "date": "2024-03-14",
      "anchor": "page 4, paragraph 2",
      "relevance": 0.92
    }
  ],
  "answerVersion": {
    "model": "model-id",
    "prompt": "prompt-id",
    "retriever": "index-version"
  }
}
```

The contract must also represent `no_evidence`, `needs_clarification`, `conflicting_sources`, `unsupported_language`, `safety_refusal`, and `service_unavailable`.

## 8. Security, privacy, safety, and trust requirements

The admin UI currently advertises RBAC and Ghana Data Protection Act compliance, and the proposal clearly places importance on bias/compliance. Those claims must become testable controls rather than labels.

Minimum controls:

- Replace browser-side Alfresco `admin` / `admin` login with server-side service credentials or OIDC.
- Enforce RBAC on the backend; frontend hiding is not authorization.
- Separate public, staff, MP, researcher, reviewer, and administrator permissions.
- Store only the minimum personal data required for case handling.
- Capture consent, purpose, retention, export, correction, and deletion processes.
- Encrypt data in transit and at rest.
- Redact or minimise personal data in model prompts and logs.
- Rate-limit public AI queries and protect against prompt injection through retrieved documents.
- Treat uploaded documents as untrusted input and scan attachments.
- Keep official records immutable or versioned; never silently overwrite them.
- Provide AI disclosure, citation, correction/reporting, and feedback controls.
- Review answer quality by language, region, constituency, topic, and document age.
- Define human escalation for legal, personal safety, reputational, and sensitive constituency matters.
- Maintain an incident process for wrong, harmful, biased, or privacy-violating outputs.

## 9. Delivery objectives

### Objective 1 — Establish one product contract

**Outcome:** both frontends are clients of the same governed domain APIs.

**Definition of done**

- API contract is versioned and reviewed.
- Public and internal API surfaces are explicitly separated.
- Authentication, roles, resource scope, errors, pagination, and audit IDs are defined.
- A staging environment demonstrates one public-to-admin-to-public flow.

### Objective 2 — Make parliamentary knowledge trustworthy and searchable

**Outcome:** approved parliamentary material can be ingested and used for cited answers.

**Definition of done**

- A document can move through draft, processing, review, approved, published, superseded, and rejected states.
- Source metadata and provenance are complete.
- Search excludes non-published data.
- Retrieval and answer responses include citations and version metadata.
- Evaluation set demonstrates agreed retrieval and citation thresholds.

### Objective 3 — Deliver the public Ask Parliament journey

**Outcome:** citizens receive useful, safe, understandable answers.

**Definition of done**

- Real API integration replaces hard-coded answer state.
- Loading, empty, error, no-evidence, conflict, and refusal states exist.
- Source inspection works on mobile and desktop.
- Language selection is functional or explicitly limited per language with honest status.
- Feedback and correction reporting are persisted.
- Accessibility and performance acceptance tests pass.

### Objective 4 — Deliver citizen-to-MP engagement

**Outcome:** a citizen issue becomes a traceable case for the correct MP/staff queue.

**Definition of done**

- Constituency matching is tested against an approved source.
- Submission requires and records appropriate consent.
- Case IDs, acknowledgements, routing, status, response, and closure work end to end.
- AI assistance is editable and never substitutes for citizen confirmation.
- Staff and citizen views enforce visibility boundaries.

### Objective 5 — Operationalise the MP/admin console

**Outcome:** internal users can operate records, cases, approvals, and access securely.

**Definition of done**

- In-memory sample state is replaced or synchronised with durable backend state.
- Every mutation has authorization and an audit event.
- Documents, cases, users, MPs, committees, sittings, and bills have API-backed list/detail/edit flows.
- Approval queues have enforceable decision gates.
- Admin dashboards show backend-derived metrics, not hard-coded labels.

### Objective 6 — Establish safe AI operations

**Outcome:** AI changes are evaluated, approved, monitored, and reversible.

**Definition of done**

- Model, prompt, retriever, and dataset versions are registered.
- Evaluation reports include language and constituency slices.
- Production deployment requires an approval record.
- Rollback is tested.
- Monitoring detects citation failure, empty retrieval, latency, error rate, harmful output, and drift.

## 10. Definition of done for the overall project

The project is done for the first production release only when all of the following are true:

1. **End-to-end value:** a citizen asks about an approved parliamentary topic, receives a cited answer, opens the source, and can report feedback.
2. **End-to-end engagement:** a citizen selects a constituency, submits a case, an authorised staff user receives it, responds, and the citizen sees the permitted status.
3. **End-to-end content:** authorised staff uploads or synchronises a document, reviews metadata, approves publication, and the public search/answer service uses the published version.
4. **End-to-end governance:** an AI version is evaluated, approved, deployed, observed, and rolled back in a staging test.
5. **Security:** no frontend contains privileged credentials; backend authorization tests cover every sensitive operation.
6. **Data integrity:** refresh, restart, retry, duplicate upload, failed job, and partial network failure do not silently lose or duplicate authoritative data.
7. **Auditability:** the team can reconstruct who changed what, which source was used, which model answered, and what the user saw.
8. **Accessibility:** key journeys work with keyboard navigation, screen readers, responsive layouts, readable contrast, and clear language.
9. **Language honesty:** each supported language has an explicit quality/support level and test evidence; unsupported requests degrade safely.
10. **Operational readiness:** monitoring, alerting, backups, retention, incident response, support ownership, and rollback runbooks exist.

## 11. Recommended delivery phases

### Phase 0 — Product and architecture alignment

- Confirm stakeholders, roles, official sources, data ownership, languages, privacy rules, and success metrics.
- Replace proposal ambiguity with an approved domain glossary and API contract.
- Decide identity provider, persistence, Alfresco role, notification channels, hosting, and model providers.
- Create a risk register and a representative evaluation dataset.

### Phase 1 — Foundation and trusted corpus

- Backend skeleton, identity, roles, audit, PostgreSQL/domain models.
- Alfresco adapter and document lifecycle.
- Extraction, metadata, chunking, indexing, search API.
- Admin documents page connected to real state.

### Phase 2 — Public knowledge access

- Public routing and information architecture.
- Search and document detail.
- Ask Parliament API with citations, refusal, uncertainty, feedback, and observability.
- First agreed languages, with quality gates.

### Phase 3 — Constituency engagement

- Constituency/MP directory APIs.
- Case intake, assignment, status, response, notifications, and retention.
- Admin/MP case workflow and citizen status view.

### Phase 4 — Parliamentary operations

- Sittings, order papers, bills, committees, MP directory, approvals, and operational dashboards backed by APIs.
- Public publishing controls and relationships between records.

### Phase 5 — AI governance and scale

- Evaluation harness, bias/language slices, model registry, prompt registry, deployment approval, rollback, monitoring, and incident workflow.
- Load, security, accessibility, disaster recovery, and operational acceptance.

## 12. Current implementation gap map

| Capability | Public app | Admin app | Platform status | Priority |
|---|---|---|---|---|
| Public shell/branding | Prototype | N/A | Exists visually | P0 |
| Ask Parliament UX | Local mock | Sample corpus supports concept | No API/RAG | P0 |
| Hansard browsing | Header only | Documents route and sample records | No public read API | P0 |
| MP lookup | Header only | MP route and sample records | No constituency service | P0 |
| Citizen issue submission | Feature card only | Cases UI and local state | No end-to-end workflow | P0 |
| Document management | N/A | UI plus partial Alfresco adapter | No governed publication/index pipeline | P0 |
| Sittings/bills/committees | N/A | UI plus local state | No authoritative backend | P1 |
| Users/RBAC | N/A | UI language and sample users | No backend enforcement/IdP | P0 |
| AI training/MLOps | N/A | Visual training jobs/logs | No actual pipeline contract | P1 |
| Audit/approvals | N/A | Local queue and log | No immutable backend ledger | P0 |
| Multilingual support | Selector only | Training data label only | No translation/evaluation path | P1 |
| Compliance/safety | Copy/labels | Settings and labels | Controls not evidenced | P0 |

## 13. Decisions that must be made with Parliament

The following should be resolved before implementation expands:

- Which records are authoritative: Parliament website, Hansard repository, Alfresco, another ECM, or a combination?
- Who may approve content for public AI retrieval?
- Is the public service anonymous, account-based, or hybrid?
- Which staff can see citizen identity and attachments?
- What exactly counts as a citizen case versus a message, petition, complaint, or service referral?
- Which constituency lookup method is approved and how are boundary changes handled?
- Which languages are production commitments in phase one?
- Are MP attendance, party, contact, and case data public, restricted, or time-bound?
- Which channels are required for notifications: email, SMS, WhatsApp, portal, or internal task only?
- What legal/privacy retention, deletion, correction, and export rules apply?
- What model hosting and data residency constraints apply?
- What answer quality, citation completeness, latency, and cost thresholds define release?
- Who owns an AI incident and who can disable public answering?

## 14. Immediate next steps

1. Freeze new UI-only feature work until the shared domain contract is approved.
2. Remove privileged credentials from `AlfrescoService` and route authentication through a backend/identity provider.
3. Create a small backend vertical slice: approved document → index → cited answer → feedback.
4. Create a second vertical slice: citizen case → constituency queue → staff response → citizen status.
5. Replace public placeholder links with real route boundaries and API loading/error states.
6. Replace admin `DataService` for one domain at a time, starting with documents and citizen cases.
7. Define an evaluation set with real, approved questions and expected source documents across the agreed languages.
8. Write security, privacy, accessibility, and audit acceptance tests before calling the prototypes production-ready.

## 15. Final product principle

The system should always make the chain visible:

**citizen question or issue → approved parliamentary source or human workflow → AI assistance where appropriate → accountable action → traceable outcome.**

If the two projects are developed independently, the result will be a public demo beside an admin demo. If they are developed as two clients of one governed platform, they can become the Ghana Parliament engagement product described by the proposal.
