#!/usr/bin/env python3
"""Stop hook: refuse to end the turn while task-tier verification is failing.

WHY
---
"Run the checks before saying done" is an instruction, and instructions are
followed unevenly. This makes it mechanical: when Claude tries to finish, the
task tier runs against whatever is actually in the working tree, and a failure is
handed back as something to fix rather than something to mention.

WHY IT NO LONGER SHELLS OUT TO BASH
-----------------------------------
This used to run `bash scripts/ci/verify.sh task` and, if `bash` was not on PATH,
return 0 — silently turning the gate off on exactly the machines least likely to
notice (Windows/VS Code without Git Bash) while still letting the turn end as a
verified completion. A gate that disables itself is worse than no gate, because
it is indistinguishable from a passing one.

It now calls `scripts/ci/verify.py` with the SAME interpreter running this hook,
so there is no shell dependency at all. If verification genuinely cannot run, the
turn is BLOCKED with an explanation — an unverifiable state is reported as
unverified, never as success.

CONTRACT
--------
stdin  : the hook payload JSON from Claude Code.
exit 0 : let the turn end.
exit 2 : block; stderr is fed back to Claude as the reason.

`stop_hook_active` is honoured: if the previous stop was already blocked by this
hook, it steps aside so a genuinely stuck run cannot loop forever.

EMERGENCY OVERRIDE
------------------
Set APPBI_STOP_GATE_OVERRIDE to the exact string `i-accept-unverified`. It is
spelled that way on purpose: it cannot be set by accident, and anyone reading the
environment can see what was accepted. Any other value is ignored and the gate
still runs.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VERIFY = REPO_ROOT / "scripts" / "ci" / "verify.py"
OVERRIDE_PHRASE = "i-accept-unverified"


def block(message: str) -> int:
    sys.stderr.write(message)
    return 2


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    # Already blocked once this turn — do not trap the session in a loop.
    if payload.get("stop_hook_active"):
        return 0

    if os.environ.get("APPBI_STOP_GATE_OVERRIDE") == OVERRIDE_PHRASE:
        sys.stderr.write(
            "Stop gate overridden by APPBI_STOP_GATE_OVERRIDE. This turn is "
            "UNVERIFIED — say so explicitly rather than reporting completion.\n"
        )
        return 0

    if not VERIFY.exists():
        return block(
            "Task-tier verification could not run: scripts/ci/verify.py is missing, "
            "so nothing about this change has been checked.\n"
            "This is NOT a verified completion. Restore the script, or set "
            f"APPBI_STOP_GATE_OVERRIDE={OVERRIDE_PHRASE} to finish knowingly unverified.\n"
        )

    try:
        result = subprocess.run(
            [sys.executable, str(VERIFY), "task"],
            cwd=REPO_ROOT, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=870,
        )
    except subprocess.TimeoutExpired:
        return block(
            "Task-tier verification timed out, so this change is UNVERIFIED.\n"
            "Run `python scripts/ci/verify.py task` yourself and report the result; "
            "do not claim completion on a gate that never finished.\n"
        )
    except OSError as exc:
        return block(
            f"Task-tier verification could not be started ({exc}), so nothing has "
            "been checked. This is NOT a verified completion.\n"
        )

    output = (result.stdout or "") + (result.stderr or "")

    if result.returncode == 0:
        # Passing with unverified gates is a real state and must reach Claude:
        # verify.py prints them, but stdout on exit 0 goes to the debug log only,
        # so surface them by blocking would be wrong — instead let the turn end
        # and rely on verify.py's own output in the transcript when Claude ran it.
        return 0

    return block(
        "Task-tier verification is failing, so this change is not done.\n"
        "Fix what is reported below, then finish. Do not report completion while "
        "this is red, and do not describe a gate that did not run as covered.\n\n"
        + output
    )


if __name__ == "__main__":
    sys.exit(main())
