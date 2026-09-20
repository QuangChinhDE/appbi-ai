#!/usr/bin/env python3
"""PostToolUse hook: run only the checks that are cheap enough to run per edit.

WHY THIS IS SO NARROW
---------------------
The temptation is to typecheck after every edit. `tsc --noEmit` on this frontend
takes ~50s, so doing that would make the agent loop unusable and would be turned
off within a day. A gate that gets disabled protects nothing.

So this runs only sub-second-to-fast checks, and only for the file that was just
written:

  frontend Sidebar.tsx / moduleRoutes.ts / a new app route
      -> check-module-routes.mjs (~0.5s). `moduleForPath()` fails OPEN for an
         unmapped route, so forgetting one is silent — exactly the failure this
         script was written for after it happened to AI Chat.
  backend/alembic/** or backend/app/models/**
      -> alembic_chain.py (~10s, stdlib, no DB). A missing parent revision is a
         boot-time 502, and it is cheaper to learn now than at push time.

Everything heavier belongs to `scripts/ci/verify.py` (fast/task tiers) and the
Stop hook.

CONTRACT
--------
stdin  : the hook payload JSON (tool_input.file_path is what we key on).
exit 0 : nothing to say.
exit 2 : a check failed; stderr is fed back to Claude to act on.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _rel(file_path: str) -> str | None:
    if not file_path:
        return None
    try:
        return Path(file_path).resolve().relative_to(REPO_ROOT).as_posix()
    except (ValueError, OSError):
        return None


def _run(cmd: list[str], cwd: Path) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=55)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return 0, ""  # toolchain absent or slow here: never block on that
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    rel = _rel((payload.get("tool_input") or {}).get("file_path", ""))
    if not rel:
        return 0

    failures: list[str] = []

    if (
        rel.endswith("Sidebar.tsx")
        or "moduleRoutes" in rel
        or (rel.startswith("frontend/src/app/") and rel.endswith("page.tsx"))
    ):
        script = REPO_ROOT / "frontend" / "scripts" / "check-module-routes.mjs"
        if script.is_file():
            rc, out = _run(["node", "scripts/check-module-routes.mjs"], REPO_ROOT / "frontend")
            if rc != 0:
                failures.append(
                    "QA contract failed: every module page in the sidebar must be mapped in "
                    "lib/moduleRoutes.ts. moduleForPath() fails OPEN for an unmapped route, so "
                    "this would silently show a module shell to a user with no access.\n" + out
                )

    if rel.startswith("backend/alembic/") or rel.startswith("backend/app/models/"):
        chain = REPO_ROOT / "scripts" / "ci" / "alembic_chain.py"
        if chain.is_file():
            rc, out = _run([sys.executable, "scripts/ci/alembic_chain.py"], REPO_ROOT)
            if rc != 0:
                failures.append(
                    "Alembic chain is broken. A missing parent revision or a second head is a "
                    "boot-time failure in production, not a local warning.\n" + out
                )

    if failures:
        sys.stderr.write("\n\n".join(failures))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
