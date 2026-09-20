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
python scripts/ci/verify.py fast   # in the loop: typecheck + the QA contracts you touched
python scripts/ci/verify.py task   # before calling anything done (adds the checks below)
```

`verify.sh` still works as a thin wrapper. The logic moved to Python because the
task-complete gate must not depend on a shell: on Windows/VS Code without Git Bash there
is no `bash`, and the Stop hook's old response to that was to exit 0 — reporting a
verified completion having verified nothing.

| Tier | Runs |
|---|---|
| `fast` | frontend `tsc --noEmit`; the frontend QA contract for the area touched; alembic chain if a migration/model changed |
| `task` | everything in `fast`, plus backend import smoke, the "backend tests reach CI" check, `.claude/` config validation, guardrail patch validation, semantic-contract health when a backbone file changed, and **execution of the guardrail's required gates** |

## Required gates are executed, not just named

The task tier resolves the required-test set from `guardrail_rules.yaml` and runs every
entry it can run here. Entries marked `status: missing` / `untracked` / `manual`, or that
`requires:` a seeded database, are **not** run and are printed under `NOT VERIFIED` with
the reason. A gate that did not run is never counted as coverage. `APPBI_VERIFY_WITH_DB=1`
forces the database-backed ones.

There is no second registry: commands, statuses and requirements all come from
`guardrail_rules.yaml`.

# check_claude_config.py — schema of the agent workflow

Validates `.claude/settings.json` (hooks must use exec form, targets must exist), every
`.claude/rules/*.md` frontmatter (must use `paths:`, and each glob must match a real file),
and every skill's discoverability frontmatter. It exists because the rules used `globs:` —
a key Claude Code does not read — so all five loaded unconditionally in every session while
appearing to be path-scoped. The YAML parsed; nothing warned. Runs in preflight and CI.

Non-zero exit means the task is not done. The `Stop` hook in `.claude/settings.json` runs
`verify.py task --json` and decides from the structured result:

| Result | Stop | On retry (`stop_hook_active=true`) |
|---|---|---|
| nothing failed, nothing unverified | allowed | allowed |
| nothing failed, gates went unverified | blocked, listing each gate and reason | **allowed** |
| verification failing | blocked, with the failure output | **still blocked** |
| verifier missing / timeout / unreadable JSON | blocked | **still blocked** |

Only the unverified row is one-shot. A missing, manual or database-backed gate can stay
unverified forever, so insisting would trap the session with no way to converge. A failing
check has a way to converge — fix it — so releasing it on the retry would let a red turn
end, which is what an earlier version did. Loop protection is the platform's job: Claude
Code overrides a Stop hook after eight consecutive blocks without progress
(`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it).

The unverified row exists at all because exit 0 is not the same as covered, and a hook's
stdout on exit 0 reaches only the debug log — so the NOT VERIFIED list has to travel on
stderr with exit 2 or Claude never sees it.

`scripts/ci/test_stop_gate.py` (20 tests) proves each row, including failed-then-fixed
being allowed and infrastructure breakage not clearing itself by being retried.

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


---

# The provider-neutral layer

`AGENTS.md` at the repo root is the canonical **agent instruction entrypoint** — Codex
reads it directly, and `.claude/CLAUDE.md` imports it with `@../AGENTS.md` plus the parts
specific to how Claude Code works. One file, so the two adapters cannot drift.

It is an entrypoint, **not** the authority. Executable checks decide PASS/FAIL; agent
instructions are last in the source-of-truth order.

## check_agent_config.py

Sits on top of `check_claude_config.py` (which keeps doing the Claude schema). It proves
AGENTS.md exists and fits Codex's 32 KiB `project_doc_max_bytes`, that the Claude adapter
imports it rather than copying it, that every path both files promise exists, and that
both name the same Definition-of-Done command.

## check_protection_integrity.py — run from the MERGE BASE

The gates live in the repository, so an agent can edit them. This compares `base..head`
for a protected subsystem, invariant or registry entry that disappeared, a runnable gate
downgraded to missing/untracked/manual, a deleted protection-critical file, a removed CI
verification step, and a Stop gate made fail-open.

**CI runs the BASE copy of it and reads the head revision only as data (`git show`).** A
pull request that rewrites the checker never gets to run its own audit. Nothing from the
PR head is executed in that job — not code, not dependencies, not config.

Deliberate weakening stays possible but must be visible: a status downgrade needs a
`status_reason:` on the entry, and a removal needs `APPBI_ALLOW_PROTECTION_REMOVAL=1`,
a repository variable only the owner can set.

Mechanical checks only. A rewritten-but-equivalent gate is a judgement call for review.

## change-guardrail.yml — server-side diff review

`guardrail_check.py --diff` on a CI checkout reviews nothing: the working tree is clean.
That is why the CLI takes `--base/--head` (three-dot, so only what this branch introduced
is judged) and `--diff-file`.

Two jobs, in order: `trusted-protection` (base contract, head as data) then `diff-review`
(head rules against the real diff). The second runs head code by necessity; it is only
acceptable because the first already proved head did not weaken the rules.

Exit codes: `0` ok/warn · `1` block (red) · `2` UNKNOWN, surfaced as a neutral annotation
because no rule covers it — **UNKNOWN is not SAFE**, it is a reason to review.
