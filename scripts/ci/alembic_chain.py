#!/usr/bin/env python3
"""Validate the Alembic revision graph WITHOUT a database or SQLAlchemy.

Catches the deploy-breaker we hit repeatedly: a migration whose ``down_revision``
points at a revision file that was never committed (alembic raises
``KeyError`` at boot → backend restart-loop → 502), or two heads (alembic
refuses ``upgrade head``). Pure file parse, stdlib only, runs in milliseconds
anywhere — so it works in a pre-push hook even on a machine with no Python deps.

Exit 0 = healthy single-head chain. Exit 1 = problem (printed).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

VERSIONS = Path(__file__).resolve().parents[2] / "backend" / "alembic" / "versions"

# Match the actual ASSIGNMENT (requires `=`), so a docstring line like
# `revision: 20260528_0001` (no quotes, no `=`) can't shadow it. Handles typed
# forms (`revision: str = "x"`) and merge tuples (`down_revision = ("x", "y")`).
_REV = re.compile(r"^revision\s*(?::[^=\n]*)?=\s*['\"]([^'\"]+)['\"]", re.M)
_DOWN = re.compile(r"^down_revision\s*(?::[^=\n]*)?=\s*([^\n]*)", re.M)
_QUOTED = re.compile(r"['\"]([^'\"]+)['\"]")


def main() -> int:
    if not VERSIONS.is_dir():
        print(f"alembic: versions dir not found: {VERSIONS}")
        return 1

    revisions: dict[str, str] = {}      # revision id -> filename
    downs: dict[str, list[str]] = {}    # revision id -> [parent ids]
    problems: list[str] = []

    for path in sorted(VERSIONS.glob("*.py")):
        if path.name == "__init__.py":
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        m = _REV.search(text)
        if not m:
            continue  # not a migration module (no `revision = "..."` assignment)
        rev = m.group(1)
        if rev in revisions:
            problems.append(
                f"duplicate revision id {rev!r}: {revisions[rev]} & {path.name}"
            )
        revisions[rev] = path.name

        dm = _DOWN.search(text)
        parents = _QUOTED.findall(dm.group(1)) if dm else []
        downs[rev] = parents

    if not revisions:
        print("alembic: no migrations found")
        return 1

    # 1) every down_revision must reference a revision that actually exists
    for rev, parents in downs.items():
        for parent in parents:
            if parent not in revisions:
                problems.append(
                    f"{revisions[rev]}: down_revision {parent!r} is MISSING "
                    f"(parent file not committed?) — this is the KeyError-at-boot bug"
                )

    # 2) exactly one head (a revision no other revision points back to)
    referenced = {p for parents in downs.values() for p in parents}
    heads = sorted(r for r in revisions if r not in referenced)
    if len(heads) > 1:
        listed = ", ".join(f"{h} ({revisions[h]})" for h in heads)
        problems.append(
            f"multiple heads ({len(heads)}): {listed} — alembic will refuse "
            f"'upgrade head'. Merge them or fix a down_revision."
        )

    if problems:
        print("[FAIL] Alembic revision graph is broken:")
        for p in problems:
            print(f"   - {p}")
        return 1

    print(f"[OK] Alembic chain healthy - {len(revisions)} revisions, single head: {heads[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
