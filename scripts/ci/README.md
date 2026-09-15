# Preflight — commit-integrity gate

Stops the repeat prod-502 class where code is committed but the thing it depends
on is left uncommitted (so it builds on your machine but not from the commit):

| Check | Catches | Tool |
|-------|---------|------|
| `alembic_chain.py` | migration `down_revision` → parent file not committed (alembic `KeyError` at boot), or multiple heads | stdlib python, no DB |
| `tsc --noEmit` (frontend) | importing an export/module left uncommitted (`next build` type error) | node |
| `import app.main` (backend) | importing a deleted/renamed module | python + deps |

## The key idea

All checks run against the **committed tree**, not your working tree. The local
hook does this by stashing your local source changes (tracked + untracked) so
the tree momentarily matches `HEAD`, running the gate against the real installed
deps, then restoring your changes. A plain `npm run build` on your machine
passes because the forgotten file is still on disk; the gate removes that blind
spot. (`node_modules` is git-ignored, so the stash never touches it; a brief
stash/pop means a running `next dev` may recompile once.)

## Two layers

1. **Local pre-push hook** (`.githooks/pre-push`) — fast feedback before the
   push leaves your machine. Enable once per clone:
   ```bash
   bash scripts/setup-hooks.sh
   ```
   Emergency bypass: `git push --no-verify`.

2. **GitHub Actions** (`.github/workflows/preflight.yml`) — runs on every
   push/PR, can't be bypassed. Make it a **required status check** in branch
   protection so a red run blocks merge/deploy.

## Run manually any time
```bash
bash scripts/ci/preflight.sh        # whole gate
python scripts/ci/alembic_chain.py
cd frontend && npm run typecheck
```

---

# verify.sh — the agent/dev loop gate (separate from preflight)

`preflight.sh` answers *"does the committed tree build and boot"* and guards the push.
`verify.sh` answers *"is the change I am making right now sound"* and guards the coding
loop. It looks at the **working tree**, works out which areas you touched, and runs only
what applies.

```bash
bash scripts/ci/verify.sh fast   # in the loop: typecheck + the QA contracts you touched
bash scripts/ci/verify.sh task   # before calling anything done (adds the checks below)
```

| Tier | Runs |
|---|---|
| `fast` | frontend `tsc --noEmit`; the frontend QA contract for the area touched; alembic chain if a migration/model changed |
| `task` | everything in `fast`, plus backend import smoke, the "backend tests reach CI" check, guardrail patch validation, and semantic-contract health when a backbone file changed |

Non-zero exit means the task is not done. The `Stop` hook in `.claude/settings.json` runs
the `task` tier and hands a failure back to Claude rather than letting a turn end red.

# guardrail_check.py — the guardrail, runnable

`scripts/guardrail` encodes this repo's architecture rules, protected
subsystems, impact map and test registry — but it only spoke MCP, so it could only help
when an assistant happened to call it. `guardrail_core.py` is plain Python + PyYAML, so
the same rule base runs in a script, a hook, or CI:

```bash
python scripts/ci/guardrail_check.py --plan "fix X" --files a.py   # right place? which tests?
python scripts/ci/guardrail_check.py --diff                        # block / warn / ok / unknown
python scripts/ci/guardrail_check.py --files a.py b.tsx            # impact + required tests
python scripts/ci/guardrail_check.py --health                      # rules health + contract drift
```

Exit codes: `0` ok/warn · `1` block or drift · `2` **unknown — which is not the same as
safe**: it means no rule covers the change.

`--health` runs in CI (`preflight.yml`). Three checks:

1. **rules health** — every invariant marker still exists in real source, so no rule is
   watching for a pattern that is gone.
2. **semantic contract** — `DRIFT` if a backbone file or symbol was renamed, removed, or
   added without being registered.
3. **test registry** — whether each test the rules *demand* can actually be run. This one
   was added after an audit found the registry naming four files that are not in the
   repository, three of them required gates for the protected semantic layer, while health
   still reported `healthy`. A gate nobody can run is not a gate; the difference is now
   visible on every CI run. Reported but non-fatal by default — add `--strict` to fail.
