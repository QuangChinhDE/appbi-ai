# Final release closure — spec

## Behaviour

### Datasource diagnostics

When a datasource connection test fails, the production service derives one actionable,
secret-safe diagnostic before it writes a log record or returns to the API. Configured
passwords, tokens, API keys, inline DSN credentials, service-account private-key material,
and Bearer values do not appear in either destination. A source-specific success response
that includes a warning, such as a BigQuery metadata-listing failure, applies the same
rule. Authorization for saved credential reuse remains resource-scoped.

### Dashboard leave protection

The editor treats local theme and layout changes as meaningful unsaved work. Every normal
navigation that leaves the current Dashboard consults the same current dirty state:
header Back, sidebar links, a link to another Dashboard, browser Back, and document
unload/reload. Cancel keeps the user in the current editor with the local change intact;
accept discards and leaves. After Save Draft or Publish completes, the dirty state is
clear and navigation proceeds without a prompt. Clean pages never prompt.

### APPBI-VERIFY-007 replay

The exact recovered dataset has expected totals All `685`, North `610`, South `95`, and
blank `-20`. The recovered Dashboard page applies the original North page filter to the
original KPI, bar, and table definitions. Browser-visible values, request filter payload,
and skipped-filter diagnostics decide the result:

- all three shapes have effective North scope and the KPI is `610`: `FALSE POSITIVE`;
- the KPI is `685` with the original skipped-filter behavior: `CONFIRMED`, followed by a
  narrow fix in the Dashboard/filter-composition owner;
- a material original input cannot be recovered: `UNPROVEN`, with the missing input named
  and no speculative runtime fix.

Regardless of classification, a durable browser test protects mixed-shape page-filter
parity when reconstruction succeeds.

### Relative-date batch execution

For an explicit `as_of`, an equivalent single-chart read and production batch read use
the same relative-date window and match a hand-computed expected value. Repeating the read
with the next logical anchor moves the window and returns the next expected value. A real
Dashboard/Public batch request exposes the anchor through `X-AppBI-As-Of`, and the visible
value matches that anchor.

### PDF composition

One export request captures one `as_of` and creates one multi-page job. The actual worker
opens pages A, B, and C in order; their chart/batch reads use that same anchor. The worker
produces real PDF bytes. Parsing and rendering the result proves page count, titles,
Unicode, page-specific filters, relative-date results, absence of blank visuals, and
absence of hidden-filter leakage. If the local worker cannot execute after a reasonable
attempt, the contract is reported `BLOCKED — ENVIRONMENT` and remains unproven.

### Timezone and final product journey

Tests keep any deterministic timezone override isolated. Product code retains
`APP_TIMEZONE`, default UTC, and invalid-value warning plus UTC fallback. The closure
report shows how one UTC instant near midnight maps to the next calendar day in Vietnam.

After the gap work, one headed journey uses a realistic multi-page report to edit layout
and style, save, reload, publish, open reader/public views, apply and reset filters, switch
pages, and inspect CSV, XLSX, and PDF exports. A new closure-caused issue is repaired; a
new unrelated release-blocking P0/P1 stops certification and is reported.

## Data

No schema change and no migration.

Deterministic CI seed data adds or reuses:

- the recovered APPBI-VERIFY-007 rows and exact Dashboard/chart/filter configuration;
- a three-page relative-date report with hand-computable per-page values and stable names;
- credentials and secret markers only in test doubles, never persisted as real secrets.

## API

No endpoint, request schema, response schema, or permission contract changes.

| Method | Path / boundary | Auth / permission | Contract checked |
|---|---|---|---|
| POST | existing datasource connection-test route | existing datasource permission plus resource authorization | actionable diagnostic, no configured secret in response or logs |
| POST | existing chart batch route / `ChartService.get_charts_data_batch` | existing report/dashboard access | one explicit anchor across every worker result |
| GET/POST | existing public report batch path | public token through `publicClient` | visible relative-date result and response anchor agree |
| POST/worker | existing PDF export job path | existing export permission/public-token rules | one export anchor across all pages and real PDF output |

Existing authorization failures and status codes remain unchanged. Redaction changes only
unsafe message content, not success/failure classification.

## UI

Only the Dashboard editor navigation behavior changes unconditionally. It uses the
existing localized confirmation copy and current dirty-state definitions. There is no new
screen, modal design, loading state, or public editor chrome.

APPBI-VERIFY-007 changes UI/runtime logic only if the exact replay confirms the defect.
The public and embed surfaces keep their existing API client boundary.

## Permissions

No permission model change. Datasource credential reuse remains limited to users allowed
to use the referenced resource. Dashboard edit/save/publish and export permissions retain
their existing gates. Public-token viewers receive only public-surface operations.

## Edge cases

- A driver exception contains multiple secret forms or the secret is embedded in a DSN.
- A connection test succeeds but metadata discovery returns a warning exception.
- A user dismisses the leave prompt and attempts another navigation later.
- Save or Publish fails; dirty state must remain and navigation must still warn.
- Browser history returns to the same URL or moves between two Dashboard IDs.
- The relative-date window crosses month, year, UTC-day, or Vietnam-local-day boundaries.
- A PDF page has no rows for its page filter; the result must be an honest empty state,
  not a leaked value from another page.
- Exported Unicode and formula-like spreadsheet text remain intact.

## Non-goals

- Global interception of every application route or replacement of Next.js routing.
- Changing the semantic meaning of filters, grain, joins, arithmetic, or publication.
- Selecting Asia/Ho_Chi_Minh, browser-local, dataset-local, or report-local time as the
  product default.
- Reopening already green findings 002–005 except where regression verification exercises
  their existing contracts.

