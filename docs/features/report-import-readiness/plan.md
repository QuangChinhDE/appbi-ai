# Report import readiness — implementation plan

## Guardrail scoping

`python scripts/ci/guardrail_check.py --plan "report-code readiness check" --files backend/app/services/report_code/importer.py backend/app/services/report_code/lifecycle.py backend/app/api/report_artifacts.py frontend/src/components/report-code/PasteCodeWizard.tsx`

- Verdict: **unknown**. No rule covers `report_code` beyond `tsc`. The PR proposes a `report_code` feature entry in `guardrail_rules.yaml` that names its tests: report contract, report PG, `report-runtime-contract`, `report-vibe-dod`. It is declared in the PR as a protection-system change.
- Protected subsystems: none. The public-link security surface is untouched; readiness is author-side only.

## Files and layers, in order

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `services/report_code/readiness.py` (new) | service | One report built from the existing checks; Python port of the association/provenance audit |
| 2 | `services/report_code/lifecycle.py` | service | `publish` uses `readiness` blocking items; codes kept compatible |
| 3 | `services/report_code/importer.py` | service | `propose`: settled slots skip the model, unsettled get a shortlist; the import result carries `readiness` + `ai_slots`; `check_rows(fix=True)` on import |
| 4 | `api/report_artifacts.py` | router | `GET /{id}/readiness`; publish 409 `NOT_READY` carries the report |
| 5 | `frontend/.../PasteCodeWizard.tsx`, `ReportStudio.tsx`, `StudioPanels.tsx` | FE | Per-place checklist after import; Problems panel reads the server report |
| 6 | `runtime.js` | runtime | Audit rules read the shared fixture semantics (no behaviour fork) |

## Risks

- **Publish stops working for reports that publish today.** Only the blocking codes that block today (unbound after #94, samples) are kept blocking. The heuristic checks only warn.
- **AI mapping quality drops when it sees a shortlist.** The shortlist is ranked by the same `_score`, and the import mapping fixtures are run before and after.
- **Python and JS audit drift.** A shared fixture is run by both pytest and the runtime e2e.

## Tests — decided now

- Contract: the readiness report shape for each code; compatible import makes 0 model calls; `propose` sends only unsettled slots (a recorder on `LLMClient`).
- PG: publish returns 409 `NOT_READY` with the report; readiness on the published version flags the pre-#94 `missing` anchors.
- e2e headed: the Paste wizard checklist; the Studio Problems panel equals the server report.

## Size

Medium. Five backend and frontend files, a new service, no migration. It waits for approval before implementation.
