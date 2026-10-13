# Constituency boundary-change procedure (T-049)

Constituency boundaries and the list of constituencies come from an **approved source** (for Ghana, the
Electoral Commission's gazetted list). The platform never edits boundaries by hand: it applies an approved list
and records where it came from. Which body approves the list, and how often, is a Phase 0 decision with Parliament.

## When it applies
A new gazette, a by-election that creates or removes a constituency, or a correction to a name, region or
recognised alternative name.

## Steps
1. **Obtain the approved list** and note its reference (e.g. `EC gazette 2026/12`). That reference becomes `sourceRef`.
2. **Prepare rows**: `code`, `name`, `region`, optional `aliases` (former names, main towns people search by).
   Include **every** constituency that should be active: anything missing from the list is deactivated.
3. **Dry run** as an ADMIN:
   `POST /api/v1/internal/constituencies/import` with `{ "sourceRef": "...", "dryRun": true, "rows": [...] }`.
   Read the report: `added`, `updated`, `reactivated`, `deactivated`, `openCasesNeedingReroute`.
   A second person should confirm the report matches the gazette before continuing.
4. **Apply** the same request with `dryRun` false (or omitted). It is one transaction: all or nothing, and audited
   (`constituency.import`).
5. **Update MPs** (`POST/PATCH /api/v1/internal/mps`): a new or changed constituency needs its current MP, and only
   MPs with `isPublished: true` appear publicly. Set `activeTo` on a departing MP rather than deleting.
6. **Reroute open cases.** Cases on a deactivated constituency stay where they are (nothing is deleted).
   For each, an ADMIN calls `POST /api/v1/internal/cases/:id/reroute` with the new `constituencyId`.
   Rerouting clears the assignee, records a `rerouted` event and is audited.
7. **Re-scope staff**: staff/MP access is per constituency (`UserConstituency`). Update assignments so the right
   people see the right queues.

## What happens to existing data
| Item | Behaviour |
|---|---|
| Deactivated constituency | Disappears from public lookup/list; new cases are refused (`400 Unknown constituency`). Row is kept. |
| Existing cases | Keep their original constituency until rerouted. History and audit are unchanged. |
| Renamed constituency | Same `code`, so cases and staff scope follow automatically. |
| Re-added constituency | Reactivated by the import (reported as `reactivated`). |

## Limits
- Matching is by name, code and recorded aliases. There is no geographic (GPS/boundary polygon) lookup: that needs
  an approved boundary dataset (`Constituency.lookupRef` is reserved for it).
- A person who knows only their town or electoral area may need the alias list to be extended. Review the
  `lookup` queries that return no matches to find gaps.
