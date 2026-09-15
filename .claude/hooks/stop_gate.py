#!/usr/bin/env python3
"""Stop hook: the turn does not end on an unverified change without Claude seeing it.

WHY
---
"Run the checks before saying done" is an instruction, and instructions are
followed unevenly. This makes it mechanical: when Claude tries to finish, the
task tier runs against the working tree and the result decides whether the turn
may end.

THE SUBTLE PART: A PASSING RUN IS NOT NECESSARILY A COVERED ONE
--------------------------------------------------------------
`verify.py task` exits 0 when everything it could execute passed — even when
required gates did NOT run because their harness is missing, untracked, manual,
or needs a seeded database. That is correct for a CLI a human reads.

It is not sufficient here. Claude Code sends a Stop hook's stdout to the debug
log on exit 0; only exit 2 puts stderr in front of Claude
(https://code.claude.com/docs/en/hooks). So an automatic run that ended 0 would
leave the NOT VERIFIED list somewhere Claude never looks, while CLAUDE.md orders
it to report exactly that list. The instruction and the plumbing disagreed, and
the plumbing wins.

So: unverified gates block the stop ONCE, with their names and reasons on stderr.
Claude reads them, updates its final report, and the retry is allowed through —
`stop_hook_active` is true on that second call. This is a visibility mechanism,
not a hard failure: a missing or manual gate must never become a wall that makes
finishing impossible.

WHY IT DOES NOT SHELL OUT
-------------------------
This used to run `bash scripts/ci/verify.sh task` and, when `bash` was absent (a
normal Windows/VS Code machine), return 0 — reporting a verified completion
having verified nothing. It now calls `verify.py` with the interpreter running
this hook, so there is no shell dependency.

CONTRACT
--------
stdin  : the hook payload JSON from Claude Code.
exit 0 : let the turn end.
exit 2 : block; stderr becomes the message shown to Claude.

`stop_hook_active` is true when this hook already triggered a continuation, so it
allows the stop through and no loop is possible. (Claude Code also overrides a
Stop hook that blocks eight times in a row.)

EMERGENCY OVERRIDE
------------------
APPBI_STOP_GATE_OVERRIDE must equal `i-accept-unverified` exactly. Spelled that
way so it cannot be set by accident and so anyone reading the environment can see
what was accepted. Any other value is ignored and the gate still runs.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OVERRIDE_PHRASE = "i-accept-unverified"

# Test seam: the suite points this at a stub so the three decision paths can be
# exercised end to end. Unset in normal use.
VERIFY = Path(os.environ.get("APPBI_STOP_GATE_VERIFY")
              or REPO_ROOT / "scripts" / "ci" / "verify.py")

ALLOW, BLOCK = 0, 2


def format_unverified(unverified) -> str:
    """The message Claude must act on. Names and reasons, not a summary."""
    lines = [
        "Verification passed, but these REQUIRED gates did not run - so this "
        "change is not covered by them:",
        "",
    ]
    for item in unverified:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            lines.append(f"  - {item[0]}: {item[1]}")
        else:
            lines.append(f"  - {item}")
    lines += [
        "",
        "Name every gate above in your final report as UNVERIFIED, with its reason. "
        "Do not describe them as passing coverage, and do not fold them into "
        "\"tests pass\". Nothing is failing; this is a visibility stop. Once your "
        "report says so, finishing again is allowed.",
        "",
    ]
    return "\n".join(lines)


def decide(returncode: int, payload: dict | None, raw_output: str,
           stop_hook_active: bool) -> tuple[int, str]:
    """Pure decision: (exit_code, stderr_message). Unit-tested in scripts/ci.

    Kept free of I/O so the three paths — green, failed, green-with-unverified —
    can be asserted directly rather than inferred from a subprocess.
    """
    # Second call: this hook already blocked once. Let the turn end regardless,
    # so a gate can never trap the session.
    if stop_hook_active:
        return ALLOW, ""

    if returncode != 0:
        return BLOCK, (
            "Task-tier verification is failing, so this change is not done.\n"
            "Fix what is reported below, then finish. Do not report completion "
            "while this is red, and do not describe a gate that did not run as "
            "covered.\n\n" + raw_output
        )

    if payload is None:
        # Exit 0 but the structured result was unreadable: we cannot tell whether
        # gates went unverified, and "probably fine" is the assumption this whole
        # gate exists to remove.
        return BLOCK, (
            "Task-tier verification exited 0 but its --json result could not be "
            "parsed, so it is unknown whether any required gate went unverified.\n"
            "Run `python scripts/ci/verify.py task` yourself and report what it "
            "says. Raw output follows.\n\n" + raw_output
        )

    if payload.get("failed"):
        return BLOCK, (
            "Task-tier verification reported failures.\n\n" + raw_output
        )

    unverified = payload.get("unverified") or []
    if unverified:
        return BLOCK, format_unverified(unverified)

    return ALLOW, ""


def main() -> int:
    try:
        hook_input = json.load(sys.stdin)
    except Exception:
        hook_input = {}

    if os.environ.get("APPBI_STOP_GATE_OVERRIDE") == OVERRIDE_PHRASE:
        sys.stderr.write(
            "Stop gate overridden by APPBI_STOP_GATE_OVERRIDE. This turn is "
            "UNVERIFIED - say so explicitly rather than reporting completion.\n"
        )
        return ALLOW

    stop_hook_active = bool(hook_input.get("stop_hook_active"))

    if not VERIFY.exists():
        if stop_hook_active:
            return ALLOW
        sys.stderr.write(
            f"Task-tier verification could not run: {VERIFY} is missing, so "
            "nothing about this change has been checked.\n"
            "This is NOT a verified completion. Restore the script, or set "
            f"APPBI_STOP_GATE_OVERRIDE={OVERRIDE_PHRASE} to finish knowingly "
            "unverified.\n"
        )
        return BLOCK

    try:
        result = subprocess.run(
            [sys.executable, str(VERIFY), "task", "--json"],
            cwd=REPO_ROOT, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=870,
        )
    except subprocess.TimeoutExpired:
        if stop_hook_active:
            return ALLOW
        sys.stderr.write(
            "Task-tier verification timed out, so this change is UNVERIFIED.\n"
            "Run `python scripts/ci/verify.py task` yourself and report the "
            "result; do not claim completion on a gate that never finished.\n"
        )
        return BLOCK
    except OSError as exc:
        if stop_hook_active:
            return ALLOW
        sys.stderr.write(
            f"Task-tier verification could not be started ({exc}), so nothing "
            "has been checked. This is NOT a verified completion.\n"
        )
        return BLOCK

    # --json puts the payload alone on stdout and the human log on stderr.
    try:
        payload = json.loads(result.stdout) if result.stdout.strip() else None
    except json.JSONDecodeError:
        payload = None

    raw_output = (result.stderr or "") + (result.stdout or "")
    code, message = decide(result.returncode, payload, raw_output, stop_hook_active)
    if message:
        sys.stderr.write(message)
    return code


if __name__ == "__main__":
    sys.exit(main())
