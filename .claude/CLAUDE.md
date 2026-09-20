@../AGENTS.md

# Claude Code adapter

Everything above is the provider-neutral agent contract in `AGENTS.md`, imported rather
than copied — one file, so the two cannot drift. What follows is only the part that is
specific to how Claude Code works.

`AGENTS.md` is an entrypoint, not the authority. The source-of-truth hierarchy in it
holds here too: executable checks decide PASS/FAIL, and these instructions are last.

## Scoped rules load by path

`.claude/rules/*.md` carry `paths:` frontmatter, so Claude Code loads each one only when
you touch matching files. You do not need to open them manually — but if you are working
in an area and its rule is not in context, read it.

| Working in | Rule |
|---|---|
| `frontend/**` | `.claude/rules/frontend.md` |
| `backend/**` | `.claude/rules/backend.md` |
| `backend/alembic/**`, `backend/app/models/**` | `.claude/rules/database-migrations.md` |
| tests, `e2e/**`, `qa/**` | `.claude/rules/testing.md` |
| semantic services, `api/public.py`, `app/d`, `app/embed` | `.claude/rules/semantic-layer.md` |

`python scripts/ci/check_agent_config.py` validates that this frontmatter is well formed
and that every glob matches something real — a glob matching nothing is a rule that
silently never loads.

## Use the skills instead of improvising the sequence

`/implement-feature` · `/fix-bug` · `/review-change`

They encode the order that matters: inspect before designing, scope with the guardrail,
decide the tests before coding, and — for medium/large work — present the plan and stop
for approval before implementing.

## Hooks enforce the Definition of Done

Two project hooks in `.claude/settings.json` run whether or not you remember to:

- **PostToolUse** — after an edit, the cheap checks only (module-route contract on
  sidebar/route edits, alembic chain on migration/model edits). `tsc` is ~50s and is
  deliberately not here; a hook that slows every edit gets switched off.
- **Stop** — runs `verify.py task --json` and decides whether the turn may end:

| Result | Stop | On retry |
|---|---|---|
| nothing failed, nothing unverified | allowed | allowed |
| nothing failed, gates unverified | **blocked once**, naming each gate and reason | allowed |
| verification failing | **blocked** | **still blocked** |
| verifier missing / timeout / unreadable result | **blocked** | **still blocked** |

Only the unverified row is one-shot, because a missing or manual gate can stay unverified
forever and insisting would trap the session. A failing check has a way to converge — fix
it — so it keeps blocking. Claude Code's own cap on consecutive Stop blocks is the loop
protection, not this hook.

A Stop block listing unverified gates is **not** a failure: add them to your report as
unverified and finish again.

The emergency override is `APPBI_STOP_GATE_OVERRIDE=i-accept-unverified`, spelled so it
cannot be set by accident. Using it means the turn is unverified and you must say so.

## Learning rule

If the same class of mistake is corrected more than once, personal memory is not enough —
it is not loaded for anyone else and it is not enforced. Route it to the layer that can
prevent recurrence:

| The mistake is… | Put it in |
|---|---|
| mechanically checkable on a diff/file | a check in `scripts/ci/` or an invariant in `guardrail_rules.yaml` |
| behavioural | a test in `backend/tests/` (+ allow-list + workflow) or `e2e/tests/` |
| area-specific judgement | the matching `.claude/rules/*.md` |
| universal to every agent | `AGENTS.md` |
| Claude-mechanism-specific | this file |
| a bug worth remembering | a row in `DA-Test/Regression-Catalog.md` |

Prefer the highest-enforcement layer that fits. Propose the change; do not silently widen
rules on your own.
