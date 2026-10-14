# e2e

Two Playwright suites with different jobs. Neither is a duplicate of the other.

| | `tests/` | `acceptance/` |
|---|---|---|
| Config | `playwright.config.ts` | `acceptance.config.ts` |
| Role | deterministic **release gates** | explicit, manual **acceptance** |
| Runs in CI | yes — `.github/workflows/e2e.yml` on every push/PR touching the app | no — run on purpose |
| Model calls | none (`E2E_NO_MODEL=1`) | real planner / vision model (spends calls) |
| Writes | `test-results/`, `playwright-report/` (gitignored) | evidence under `docs/features/report-studio-v3/evidence` for a reviewer |
| A missing fixture / model | **fails** (a gate never passes by skipping) | records NOT VERIFIED |

```bash
# release gates (needs the backend seeded with backend/scripts/ci/seed_e2e_*.py)
E2E_BASE_URL=http://localhost:3000 E2E_API_URL=http://localhost:8000 npx playwright test
# acceptance
E2E_BASE_URL=… E2E_API_URL=… npx playwright test -c acceptance.config.ts
```

The frontend and backend must share one `SECRET_KEY`: the Next middleware verifies
the session JWT with it, and with a mismatch every navigation falls back to a token
refresh that rotates the stored refresh token, so later pages land on `/login`.

## Dashboard Public / Embed closure (`tests/public-closure-*.spec.ts`)

Builder ↔ `/d` ↔ stable `/embed` ↔ PAT-minted `emb_`, compared tile by tile. Shared
machinery in `tests/_public-closure.ts`. Each suite works on its own duplicate of the
seeded "E2E Presentation fixture" and tears down what it created: the duplicate
dashboard (its public links — user, preview, managed embed — and their embed grants
cascade), the chart copies the duplicate made, and every PAT it minted
(`mintTestPat` → `deleteTestPats`). The seeded fixture is never modified.
