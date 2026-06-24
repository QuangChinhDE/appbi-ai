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
