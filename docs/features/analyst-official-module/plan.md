# AI Analyst as an official module — plan

PO authorization: the PO directive of 2026-10-26 ("Proceed to implementation and
verification"). PRs go through normal review to `demo`.

| Workstream | Change | Tests (fail first) |
|---|---|---|
| B+C backend | Models, migration `20261026_0001`, `services/analyst/sessions.py` (access, redaction, store), session routes, `ResourceSpec` and share registration, route contract | `test_analyst_sessions.py` (unit: access and redaction rules) and `test_analyst_sessions_http_pg.py`, which covers: owner, view, edit and team shares; team removal; dataset revoked; module revoked; `full` oversight still redacted; ID enumeration → 404; view cannot ask; follow-up taken from the server |
| D module | Levels none/view/edit/full, admin preset `full`, allowlist optional, pilot wording removed | Updates to `test_analyst_http_pg.py` (preset, allowlist) |
| A frontend | AI nav group, Analyst sessions UI on tokens, `ShareDialog` | `tsc`, Playwright `analyst-sessions.spec.ts` at 360/768/1440 |
| E acceptance | QA stack: OFF/ON builds, live sharing journeys with screenshots, BI regression | Existing acceptance specs plus the new one |

Every new test file is force-added, and wired into `backend-contract-tests.yml` and the
allow-list per `.claude/rules/testing.md`.

## Risks

- Changing the meaning of an empty `ANALYST_PILOT_ALLOWLIST`. `ANALYST_ENABLED` is off by
  default and presets grant the Analyst only to admin, so no existing non-admin user gains
  access.
- Stored rows can be stale. They are labelled with their time and never re-run silently.
