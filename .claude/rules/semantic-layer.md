---
name: semantic-layer
description: Gates required before changing AppBI's protected semantic layer or public-link security. Load when editing those files.
paths:
  - "backend/app/services/semantic_*.py"
  - "backend/app/services/dataset_model_service.py"
  - "backend/app/services/dataset_calendar_service.py"
  - "backend/app/services/filter_propagation.py"
  - "backend/app/services/type_override_service.py"
  - "backend/app/services/chart_contracts.py"
  - "backend/app/services/chart_semantic_service.py"
  - "backend/app/services/chart_service.py"
  - "backend/app/api/public.py"
  - "frontend/src/app/d/**"
  - "frontend/src/app/embed/**"
  - "frontend/src/lib/api/public.ts"
---

# Protected subsystems

Two subsystems are declared `protected` in
`scripts/guardrail/guardrail_rules.yaml`: **the semantic layer** (query
engine, model, join resolution, calendar, filters) and **public-link security**.

The detailed invariants are **not duplicated here on purpose** — they live in that file,
they are self-audited, and a second copy would drift. Consult the guardrail instead of
recalling them from memory.

## Do not rewrite

The semantic layer is golden-proven across multi-fact fan-out, snowflake joins, calendar
handling and measure isolation. Make the **smallest surgical change**. Never flip
symmetric-aggregate or filter-propagation defaults. Never re-introduce a correlated
subquery into the distinct cascade.

## Required sequence

Before implementing:

```bash
python scripts/ci/guardrail_check.py --plan "<what you intend to fix>" --files <paths...>
```

Right module? Right scope? Which protected subsystems? Which tests?

After implementing:

```bash
python scripts/ci/guardrail_check.py --diff     # validate_patch on the working diff
```

Then run every test the verdict names.

## Verdicts

- `block` — fix before proceeding. Not negotiable, not something to explain around.
- `warn` — proceed, but run the named tests and report their results.
- `ok` — no known issue; still run the recommended tests.
- `unknown` — **not safe.** No rule covers this. Say so explicitly in your report, and
  treat it as needing human judgement. If the guardrail *should* have known, add the rule
  to `guardrail_rules.yaml` as part of the change.

## Not every required gate can be run — ask, do not assume

Some entries in this subsystem's required-test list name harnesses that are not in the
repository. Which ones changes as gates are rebuilt, so **this file deliberately does not
list them**. A hard-coded inventory here would be a second copy of
`guardrail_rules.yaml` and would go stale the first time a gate is restored — it already
did once.

Get the current picture from the registry itself:

```bash
python scripts/ci/guardrail_check.py --health          # runnable vs known gaps, with status
python scripts/ci/guardrail_check.py --files <paths>   # what THIS change requires
```

`bash scripts/ci/verify.sh task` (or `python scripts/ci/verify.py task`) resolves the same
registry, runs every required gate that can run here, and prints the rest as `UNVERIFIED`
or `MANUAL` with the reason.

**Never present an unrunnable gate as coverage.** If the guardrail required a gate that is
`missing`, `untracked`, needs a warehouse, or is manual, name it in your report and say the
change is unverified against it. Treat this subsystem's real coverage as thinner than the
rule list implies, and lean harder on reproducing the behaviour yourself.

## Contract health

Any change to a semantic backbone file must be followed by:

```bash
python scripts/ci/guardrail_check.py --health   # check_rules_health + verify_semantic_contract
```

`DRIFT` means a registered file or symbol was renamed or removed, or a new semantic
service appeared unregistered — update the inventory in `guardrail_rules.yaml` in the same
change.

## Public link

Locked and hidden filters are enforced server-side. The public frontend uses
`publicClient` only. Verify logged out, in a real browser, not by reading source.
