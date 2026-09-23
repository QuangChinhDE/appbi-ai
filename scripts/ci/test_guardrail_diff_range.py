# -*- coding: utf-8 -*-
"""The guardrail must not answer "nothing to review" when it could not look.

THE DEFECT. `guardrail_check.py --diff --base X --head Y` shelled out through a
helper that returned `out.stdout` and dropped the exit code. An unresolvable ref
therefore produced an empty string, which is exactly what a genuinely empty diff
produces, and the command printed "guardrail: no changes to validate." and
returned 0. A gate that cannot resolve its own range reported a clean review.

It was found the hard way: on a `fetch-depth: 1` CI checkout `git merge-base HEAD
HEAD~1` cannot resolve, so `test_agent_sdlc.py` handed the guardrail a literal
`HEAD~1`, got that plain-text sentence back where JSON was promised, and failed on
`json.loads`. The parse error was the symptom. The fail-open was the bug, and it
would have stayed invisible on any invocation that did not happen to want JSON.

THREE STATES, and the point of this file is that they stay three:

    a resolvable range with no changes   -> ok,      exit 0
    an unresolvable base or head         -> unknown, non-zero
    git itself failing                   -> unknown, non-zero

`unknown` rather than `block` because the guardrail has not judged anything — it
could not. The repository's own doctrine is that `unknown` is not `safe`, and a
non-zero exit is what makes that true for a caller that only reads exit codes.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "ci" / "guardrail_check.py"


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=REPO_ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )


# ── 1. a real zero diff is allowed ──────────────────────────────────────────

def test_a_resolvable_range_with_no_changes_is_allowed():
    """`HEAD...HEAD` is the honest empty review, and it must stay cheap: making
    this fail would push people to stop running the gate on no-op commits."""
    r = run("--diff", "--base", "HEAD", "--head", "HEAD")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "no changes" in r.stdout.lower()


def test_a_resolvable_empty_range_still_emits_json_under_json():
    """`--json` promises JSON in EVERY state. It used to print a sentence here,
    which is how the parse error that exposed all of this happened."""
    r = run("--diff", "--base", "HEAD", "--head", "HEAD", "--json")
    assert r.returncode == 0, r.stdout + r.stderr
    payload = json.loads(r.stdout)
    assert payload["verdict"] == "ok"
    assert payload["changed_files"] == []


# ── 2. an unresolvable range fails closed ───────────────────────────────────

def test_an_invalid_base_does_not_return_success():
    r = run("--diff", "--base", "no_such_ref_xyz", "--head", "HEAD")
    assert r.returncode != 0, (
        "an unresolvable base returned success — the guardrail reported a clean "
        "review of a range it never resolved"
    )
    out = (r.stdout + r.stderr).lower()
    assert "no_such_ref_xyz" in out, "the message must name the ref that failed"


def test_an_invalid_head_does_not_return_success():
    r = run("--diff", "--base", "HEAD", "--head", "no_such_head_xyz")
    assert r.returncode != 0
    assert "no_such_head_xyz" in (r.stdout + r.stderr)


def test_an_invalid_range_is_reported_as_unknown_not_as_ok():
    r = run("--diff", "--base", "no_such_ref_xyz", "--head", "HEAD", "--json")
    assert r.returncode != 0
    payload = json.loads(r.stdout)
    assert payload["verdict"] == "unknown", payload
    assert payload.get("error"), "the JSON must carry the reason, not only a verdict"
    # `unknown` is not `safe`, and a caller reading `changed_files` must not be
    # handed an empty list that looks like "nothing changed".
    assert payload.get("changed_files") is None


# ── 3. shallow history is the real-world shape of the same failure ──────────

def test_a_shallow_checkout_fails_closed_with_an_actionable_message(tmp_path):
    """The CI case, reproduced rather than described: a depth-1 clone cannot
    resolve `HEAD~1`, and the answer has to say what to do about it."""
    shallow = tmp_path / "shallow"
    clone = subprocess.run(
        ["git", "clone", "--depth", "1", "--no-local",
         REPO_ROOT.as_uri(), str(shallow)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if clone.returncode != 0:
        import pytest
        pytest.skip(f"cannot make a shallow clone here: {clone.stderr[:200]}")

    # THE WORKING-TREE SCRIPT, not the clone's committed copy. `git clone` hands
    # back HEAD, so without this the case would exercise whatever was committed
    # last and pass or fail for a reason that has nothing to do with the change
    # under test.
    import shutil
    shutil.copyfile(SCRIPT, shallow / "scripts" / "ci" / "guardrail_check.py")

    r = subprocess.run(
        [sys.executable, str(shallow / "scripts" / "ci" / "guardrail_check.py"),
         "--diff", "--base", "HEAD~1", "--head", "HEAD", "--json"],
        cwd=shallow, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    assert r.returncode != 0, "a depth-1 checkout reported a clean review"
    payload = json.loads(r.stdout)
    assert payload["verdict"] == "unknown"
    remedy = json.dumps(payload).lower()
    assert "fetch" in remedy or "depth" in remedy or "history" in remedy, (
        "the message must tell the operator how to fix it — this fails on a CI "
        "checkout, where 'invalid ref' alone sends someone hunting a bad command"
    )


# ── 4. a valid range still produces a normal verdict ────────────────────────

def test_a_valid_range_with_changes_produces_a_normal_verdict():
    """The gate still works. Without this the three tests above could all be
    satisfied by a command that refuses everything."""
    r = run("--diff", "--base", "HEAD~1", "--head", "HEAD", "--json")
    assert r.returncode in (0, 1, 2), r.stdout + r.stderr
    payload = json.loads(r.stdout)
    assert payload["verdict"] in ("ok", "warn", "block", "unknown")
    assert isinstance(payload.get("changed_files"), list)
    assert payload["changed_files"], "HEAD~1...HEAD changed at least one file"
