# backend/scripts/

Operational + diagnostic scripts. NOT runtime application code.

## Tracked content (CI / regression infra — re-included via `.gitignore` negations)

| Path | Purpose |
|---|---|
| `run_qa.sh` / `run_qa.ps1` | Existing QA runner (pre-Phase-0) |
| `regression_filter_matrix.py` | Golden-output regression harness for the filter system |
| `_normalize_sql.py` | SQL normalizer (sqlglot-based) — helper for the harness only |
| `golden/cases.yaml`, `golden/G*.json` | Regression case defs + captured baselines (committed) |
| `golden/KNOWN_ISSUES.md` | Drift log for the snowflake golden |
| **`seed_snowflake_ci_fixture.py`** | **CI integration seed** — builds the ds56 snowflake fixture (dataset + model + measures + golden charts) with FIXED ids so the committed golden replays verbatim. Run by `.github/workflows/backend-contract-tests.yml`. **Guarded** (`CI_FIXTURE_SEED=1` required — see below). |
| `seed_snowflake_manual_fixture.py` | Manual variant of the snowflake fixture (auto-ids) for local exploration |
| `test_snowflake_regression.py`, `test_snowflake_filter_matrix.py` | Print-style snowflake checks (kept for reviewers to replay) |
| `test_explore_dashboard_parity.py` | Explore-preview == Dashboard-tile parity smoke (both BE paths, same query). Gated in CI after seed. |

> These are exceptions to the `seed_*.py` / `test_*.py` ignore rules — they are
> explicitly re-included in `.gitignore` (the `!backend/scripts/…` negations) so
> CI and reviewers can run them. **They are tracked; do NOT delete on the
> assumption that "all seed/test scripts are local".**

## Untracked (developer-local — keep out of git)

Anything matching `seed_*workboard*`, `seed_dataset*_*`, `update_workboard*`,
`seed_phase*.sql`, `seed_snowflake_demo_dashboard.py`, `add_measures_and_test.py`,
`finalize_*.py`, `verify_demo_*.py`, `debug_*.py`, `dump_*.py`, `inspect_*.py`,
`repro_*.py`, `audit_*.py`, `dedupe_*.py` is local dev tooling — fixture/demo
creation or DB-credential-bearing scripts that should not run in shared
environments. Never `git add` these. (If a script becomes needed by CI, add a
`!`-negation in `.gitignore` AND list it in the Tracked table above.)

---

## Filter regression harness

### Purpose

Phase 0 of the PBI-parity filter migration
([docs/filter-migration-pbi-parity.md](../../docs/filter-migration-pbi-parity.md)).
Locks the BEHAVIOR (data + drop reasons + routing + SQL pattern) of representative
filter scenarios so any migration phase that diverges is caught immediately —
either accepted (with explicit golden recapture + rationale) or reverted as
regression.

The harness calls the canonical BE entry `ChartService.get_chart_data` — same
function the public HTTP endpoint `/api/v1/charts/{id}/data` uses. No private
engine internals are touched.

### Prerequisites

- Dataset 56 (manual snowflake fixture) seeded. See the seed script in
  developer-local scripts.
- Python deps: `sqlglot`, `pyyaml` (both in `requirements.txt`).
- DB reachable as `$DATABASE_URL`.

### Usage

> NOTE: the production image does **not** bundle `backend/scripts/` (the
> [Dockerfile](../Dockerfile) copies only `app/` + `alembic/`). So running "inside
> the container" first requires `docker cp`-ing the harness + `golden/` +
> `_normalize_sql.py` into `/app/scripts/`, or mounting the repo as a volume.
> **CI runs the harness on the runner (outside Docker)** so it is unaffected —
> see `.github/workflows/backend-contract-tests.yml`.

```bash
# Local: cp the harness into the running container, then verify
docker cp backend/scripts/regression_filter_matrix.py appbi-ai-backend-1:/app/scripts/
docker cp backend/scripts/_normalize_sql.py appbi-ai-backend-1:/app/scripts/
docker cp backend/scripts/golden appbi-ai-backend-1:/app/scripts/
docker exec appbi-ai-backend-1 sh -c '
  export DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
  PYTHONPATH=/app python /app/scripts/regression_filter_matrix.py --verify
'

# Verify everything against committed golden
python scripts/regression_filter_matrix.py --verify

# Verify single case (debug)
python scripts/regression_filter_matrix.py --verify --case G09_ds56_rev_fanout_deal_org_O1

# Verify by tag
python scripts/regression_filter_matrix.py --verify --tag snowflake
python scripts/regression_filter_matrix.py --verify --tag fan_out

# Capture / recapture golden — only when accepting intentional change
python scripts/regression_filter_matrix.py --capture --case G11_ds56_act_stage_closed_ambiguous
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | All selected cases pass (verify) or captured (capture) |
| 1 | At least one case diverged (verify mode) |
| 2 | Harness error (missing fixture, bad cases.yaml, etc.) |

### How `--verify` decides pass/fail

For each case, harness re-runs the chart query and compares against the committed
golden JSON. The comparison keys default to:

- `data` — stringified row dicts (order matters)
- `row_count` — derived from data, sanity check
- `dropped_filter_reasons` — sorted unique list of `reason` strings from `debug.dropped_filters`
- `routing` — e.g. `semantic_engine` / `live_query` / `per_measure_isolation`

SQL comparison is per-case via `sql_comparison`:
- `pattern` (default) — golden lists required substrings; all must appear in the
  re-emitted normalized SQL. Less brittle than exact compare; survives whitespace +
  alias-rename refactors.
- `exact` — re-emitted SQL must match golden byte-for-byte (after sqlglot normalize).
  Use for cases where exact SQL shape is the contract.
- `none` — skip SQL compare; data-only enforcement.

### How `--capture` works

Re-runs the case(s) and overwrites the golden JSON. Stamps the current commit SHA
(`$GIT_COMMIT`) into the golden file for audit.

**RULE:** Never blanket-recapture. Always pass `--case <id>` and commit the
golden change with a message explaining WHY behavior changed
(e.g. "golden: G11 — Phase 2 propagation drops ambiguous-path filter").

### Adding a new case

1. Add a YAML entry to `golden/cases.yaml` (see existing entries for shape).
2. Run `python scripts/regression_filter_matrix.py --capture --case <new_id>`.
3. Inspect `golden/<new_id>.json` to confirm the captured behavior is the intended one.
4. Commit both the YAML entry and the JSON together.

### Phase-by-phase expectations

| Phase | Verify result (without recapture) | Required golden updates |
|---|---|---|
| 0 (current) | 16/16 PASS — locks the post-`5f8b7fd`+`b84d052` state | — |
| 1 (relationship metadata) | Mostly PASS; some snowflake fixture cases may shift if `cross_filter` defaults change | Selectively recapture; cite migration rationale |
| 2 (propagation engine) | **G11 expected to FAIL** — flips from current wrong `135` to `dropped:ambiguous_path` | Recapture G11 with new behavior; document data shift |
| 3 (per-measure isolation) | Multi-measure cases (when added) emit list-of-SQL | Update existing single-SQL pattern cases as needed |
| 4 (symmetric aggregates) | Fan-out cases (G09, G13) may switch from EXISTS to symmetric SUM when PK declared | Recapture with `sql_patterns: ["SUM(DISTINCT", "MD5"]` if symmetric used |

### Case naming convention

`G<NN>_ds<DATASET>_<chart>_<filter_aspect>` — `NN` is a monotonically increasing
2-digit number per dataset (G01-G99 for dataset 56, G20-G29 reserved for ds 55,
G50+ for prod ds 60, etc.). Keep names short but unambiguous.

### Local development tip

The harness lives in the repo at `backend/scripts/` but the container's running
image may not bundle it (depends on Dockerfile). Either:

- Mount the repo as a volume: `docker compose run --rm -v $(pwd):/app backend bash`
- Or `docker cp` the harness + golden dir to `/tmp/scripts/` ad-hoc (the harness
  self-locates `golden/` relative to its own file path).

See `Phase 0` of the migration doc for CI wiring (`.github/workflows/`).
