# AppBI Engineering Guardrail MCP

A **read-only** MCP that keeps an AI (or a human) from breaking AppBI while
editing code. It sits next to Serena / CodeGraph in `Skill-AppBI/` and answers
**only** architecture / impact / invariant / regression-risk questions.

> It does **NOT** create reports, generate dashboards, design or replace the
> semantic layer, and it never writes, applies, or commits code. It only
> **analyses and advises.**

## Why

Recent bugs came from editing the wrong layer, breaking a documented invariant
(e.g. re-introducing a BigQuery-invalid correlated subquery in the distinct
cascade, or dropping the Builder's tile-fetch seed gate), or fixing a
backend/data symptom purely in the frontend. This guardrail encodes the *known*
rules (from the real module layout + `DA-Test/Regression-Catalog.md` + project
memory) and checks a change against them **before** it ships.

## Principles

- **Read-only.** No code edits, no AppBI API calls, no running fixes.
- **No invented rules.** Every answer comes from `guardrail_rules.yaml`.
- **UNKNOWN over guessing.** If a rule is absent, it says `UNKNOWN` (treat as
  "needs human judgement", not "safe").
- **Bias to block** wrong module, wrong dependency, wrong invariant.

## Tools

| Tool | Purpose |
|---|---|
| `get_module_boundaries()` | Which layer may depend on which; protected subsystems. |
| `check_architecture_violation(changed_files, imports?)` | Layering violations (e.g. models→services, public FE→authed client). `imports` optional — else read from repo. |
| `get_impact_scope(changed_files)` | Which features/subsystems a change touches; unmapped files → UNKNOWN. |
| `get_required_tests(changed_files, touched_features?)` | The exact tests that must pass (with `run` commands), derived from impact. |
| `check_logic_invariants(diff)` | Heuristic diff scan for patterns that break a documented invariant. |
| `validate_fix_plan(issue_description, proposed_files)` | Is the plan in the right module/scope? Flags scope gaps, out-of-scope files, layer mismatch, protected touches. |
| `validate_patch(diff)` | Pre-commit review → `block` / `warn` / `ok` / `unknown` + reasons + tests. |
| `explain_risk(diff)` | Human-readable regression-risk narrative + tests to run. |
| `verify_semantic_contract()` | Assert the Semantic-Layer **backbone** still matches the inventory — `DRIFT` if a registered file/symbol was removed/renamed, or a new semantic-looking service is unregistered. |
| `check_rules_health()` | **Self-audit**: every `removed_pattern` marker must exist in real code today (proves the rules are grounded, not written blind) + every referenced file exists. |
| `get_invariants(subsystem?)` | List documented invariants (optionally filtered). |

## Grounded, not blind (verified against the real code)

The rules were **verified against the actual Semantic-Layer source** with CodeGraph/Serena, not written from memory. Concretely:

- Invariants key off **real, verified markers** — e.g. the distinct-cascade guard watches `_appbi_semi_key` / `UNION DISTINCT` / the INNER JOIN emission (the actual de-correlation fix at `dataset_model_service.py` L3017/3115/3218), not a runtime-SQL string that never appears in source. Fan-out watches `_build_filter_exists_clause` (L3543); the feature-flag guard matches the real `: bool = True` form; the public-client guard uses the real `@/lib/api-client`.
- `semantic_contract` inventories the **backbone files + key symbols** (`SemanticQueryEngine.generate_sql`, `_build_isolated_measure_subquery`, `_build_dimensioned_multifact_sql`, `_validate_group_grain`, `resolve_path`/`resolve_paths`, `build_calendar_live_sql`, `build_safe_cast_sql`, …), all confirmed present.
- `verify_semantic_contract()` + `check_rules_health()` let the contract **audit itself**: if the backbone is renamed/removed, or a rule's marker goes stale, or a new semantic service appears unregistered, it reports `DRIFT`/`issues` instead of silently passing. **Run them in CI / after any semantic change** so the contract can't drift out of coverage.

**Verdicts:** `block` (fix before proceeding) · `warn` (proceed with the named
tests) · `ok` (no known issue — still run recommended tests) · `unknown` (rule
base does not cover it).

## Typical flow

```
validate_fix_plan(issue, proposed_files)   # right place / right scope?
   … edit code yourself …
validate_patch(unified_diff)               # block/warn/ok + tests
explain_risk(unified_diff)                  # why + what to run
```

## Run / register

```powershell
# one-time
.\setup-mcp.ps1
# or just launch (auto-creates venv):
.\run-mcp.ps1
```
```bash
./run-mcp.sh
```

Register with your MCP client (`.mcp.json`, Claude, etc.):

```json
{
  "mcpServers": {
    "appbi-guardrail": {
      "command": "pwsh",
      "args": ["-File", "D:\\Appv2\\appbi-ai\\Skill-AppBI\\appbi-guardrail-mcp\\run-mcp.ps1"]
    }
  }
}
```

`APPBI_REPO_ROOT` defaults to two dirs above this folder (the AppBI repo). Set it
if that is wrong. `APPBI_GUARDRAIL_RULES` overrides the rules file path.

## Extending the rules — the only way to add knowledge

All knowledge lives in **`guardrail_rules.yaml`** (never hardcode rules in Python):

- `layers` — a file's layer + which layers it may import.
- `protected` — subsystems the AI must not rewrite + their gates.
- `features` — feature → owner files + keywords + invariants + required tests.
- `tests` — the test registry (exact `run` command + what it `locks`).
- `invariants` — diff patterns (added/removed) that signal a broken rule.
- `policy` — commit-only-runtime, high-blast files, dialect-blindness note.

If the guardrail returns `UNKNOWN` for something it *should* know, add the rule
here — that is the intended way to teach it. Keep rules factual; omit rather
than invent.

## Limits

- Invariant checks are **heuristic** (regex on the diff): a hit means *run the
  test*; **no hit ≠ safe** — it only means no known pattern matched.
- It reasons about **layering, ownership, and documented invariants** — not full
  program semantics. It complements (does not replace) the golden/BQ test gates.
