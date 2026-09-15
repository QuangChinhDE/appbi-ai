#!/usr/bin/env python3
"""Stop hook: refuse to end the turn while the task-tier checks are failing.

WHY
---
"Run the checks before saying done" is an instruction, and instructions are
followed unevenly. This makes it mechanical: when Claude tries to finish, the
task-tier verification runs against whatever is actually in the working tree, and
a failure is handed back as something to fix rather than something to mention.

It runs `scripts/ci/verify.sh task`, which is itself path-aware — a clean tree or
a change touching nothing checkable exits immediately, so this costs nothing on
conversational turns.

CONTRACT
--------
stdin  : the hook payload JSON from Claude Code.
exit 0 : let the turn end.
exit 2 : block; stderr is fed back to Claude as the reason.

`stop_hook_active` is honoured: if the previous stop was already blocked by this
hook, it steps aside so a genuinely stuck run cannot loop forever.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    # Already blocked once this turn — do not trap the session in a loop.
    if payload.get("stop_hook_active"):
        return 0

    # Opt-out for a deliberate session (exploration, docs, a spike).
    if os.environ.get("APPBI_SKIP_STOP_GATE"):
        return 0

    bash = shutil.which("bash")
    if not bash:
        # No POSIX shell (plain PowerShell environment): stay out of the way
        # rather than blocking every turn with an error that is not about code.
        return 0

    result = subprocess.run(
        [bash, "scripts/ci/verify.sh", "task"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    if result.returncode == 0:
        return 0

    sys.stderr.write(
        "Task-tier verification is failing, so this change is not done.\n"
        "Fix what is reported below, then finish. Do not report completion "
        "while this is red.\n\n"
        + (result.stdout or "")
        + (result.stderr or "")
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
