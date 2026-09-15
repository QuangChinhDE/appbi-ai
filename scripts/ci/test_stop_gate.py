"""Deterministic tests for the Stop-hook decision.

WHY THIS FILE EXISTS
--------------------
The Stop hook is the only thing standing between "Claude thinks it is done" and
"the turn ends". Its logic is three-way and easy to get subtly wrong, and the
wrong version is indistinguishable from the right one until something ships
unverified.

The case that motivated it: `verify.py task` exits 0 when everything it could
execute passed, even when required gates did not run at all. Claude Code sends a
Stop hook's stdout to the debug log on exit 0 — only exit 2 puts stderr in front
of Claude — so an automatic pass would hide the NOT VERIFIED list from the one
reader who is instructed to report it.

Two layers are tested:

  * `decide()` directly — pure, no subprocess, asserts the exit code and that the
    gate NAMES reach the message.
  * the hook end to end — run as a real process against a stub verifier, so the
    wiring (argv, --json parsing, stdin payload, exit codes) is covered too, not
    just the logic it wraps.

    python -m pytest scripts/ci/test_stop_gate.py -q
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
HOOK = REPO_ROOT / ".claude" / "hooks" / "stop_gate.py"

ALLOW, BLOCK = 0, 2


def load_hook():
    spec = importlib.util.spec_from_file_location("stop_gate", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = load_hook()


# ── decide(): the three paths ─────────────────────────────────────────────
def test_all_green_allows_the_stop():
    payload = {"failed": [], "unverified": [], "passed": ["measure_render"]}
    code, message = gate.decide(0, payload, "", stop_hook_active=False)
    assert code == ALLOW
    assert message == ""


def test_a_failed_gate_blocks_the_stop():
    payload = {"failed": ["dialect_structural"], "unverified": [], "passed": []}
    code, message = gate.decide(1, payload, "dialect_structural FAILED", stop_hook_active=False)
    assert code == BLOCK
    assert "not done" in message
    # The failure output has to travel with the block, or Claude cannot act on it.
    assert "dialect_structural" in message


def test_green_with_unverified_blocks_once_and_names_every_gate():
    payload = {
        "failed": [],
        "passed": ["measure_render"],
        "unverified": [
            ["galaxy_golden", "declared missing in guardrail_rules.yaml"],
            ["filter_matrix", "needs postgres-fixture; CI runs it"],
        ],
    }
    code, message = gate.decide(0, payload, "", stop_hook_active=False)
    assert code == BLOCK
    # Names AND reasons — a summary like "2 gates unverified" is not actionable.
    assert "galaxy_golden" in message
    assert "declared missing" in message
    assert "filter_matrix" in message
    assert "needs postgres-fixture" in message
    # It must read as a visibility stop, not as a failure.
    assert "Nothing is failing" in message


def test_the_retry_after_an_unverified_block_is_allowed():
    """stop_hook_active=True means this hook already forced a continuation.

    Scoped to UNVERIFIED on purpose. A missing / manual / database-backed gate
    stays unverified no matter what Claude writes, so insisting would loop with
    no way to converge. A FAILED check has a way to converge — fix it — and is
    therefore NOT released here.
    """
    payload = {"failed": [], "unverified": [["galaxy_golden", "missing"]], "passed": []}
    code, message = gate.decide(0, payload, "", stop_hook_active=True)
    assert code == ALLOW
    assert message == ""


def test_a_failure_still_blocks_on_the_retry():
    """The correction this file exists to lock.

    An earlier version checked `stop_hook_active` FIRST, so: verification fails,
    the turn is blocked, Claude does not fix it, the second Stop carries
    stop_hook_active=true, and the turn ends red. Loop protection was excusing a
    real failure — and the test here asserted that as intended behaviour.

    A failing deterministic check must block every time. The loop risk is the
    platform's: Claude Code overrides a Stop hook after eight consecutive blocks
    without progress (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP raises it), so nothing is
    trapped by keeping this strict.
    """
    code, message = gate.decide(1, {"failed": ["x"], "unverified": []}, "boom",
                                stop_hook_active=True)
    assert code == BLOCK
    assert "keeps blocking" in message


def test_failed_payload_on_a_zero_exit_still_blocks_on_retry():
    code, _ = gate.decide(0, {"failed": ["locked_contract"], "unverified": []},
                          "locked_contract FAILED", stop_hook_active=True)
    assert code == BLOCK


def test_a_failure_that_becomes_green_is_allowed():
    """Blocking is tied to the CURRENT result, not to a latched state.

    The hook re-runs verification on every Stop, so the moment the failure is
    actually fixed the next attempt goes through — including on a retry.
    """
    code, message = gate.decide(0, {"failed": [], "unverified": [], "passed": ["x"]},
                                "", stop_hook_active=True)
    assert code == ALLOW
    assert message == ""


def test_unparseable_json_still_blocks_on_retry():
    # An unverifiable execution is infrastructure breakage, not a visibility
    # stop, so it must not clear itself by being retried.
    code, message = gate.decide(0, None, "garbage", stop_hook_active=True)
    assert code == BLOCK
    assert "infrastructure failure" in message


def test_unparseable_json_blocks_rather_than_assuming_success():
    # Exit 0 with no readable result means we cannot know whether gates ran.
    # "Probably fine" is the assumption this gate exists to remove.
    code, message = gate.decide(0, None, "garbage", stop_hook_active=False)
    assert code == BLOCK
    assert "could not be parsed" in message


def test_a_missing_unverified_key_is_treated_as_none():
    code, message = gate.decide(0, {"failed": []}, "", stop_hook_active=False)
    assert code == ALLOW


# ── End to end: the real hook process against a stub verifier ─────────────
def write_stub(tmp_path: Path, returncode: int, payload: dict | None,
               human: str = "human log") -> Path:
    """A stand-in for verify.py honouring the same contract: JSON on stdout,
    human log on stderr, chosen exit code."""
    body = (
        "import json, sys\n"
        f"sys.stderr.write({human!r})\n"
        + ("" if payload is None else f"sys.stdout.write(json.dumps({payload!r}))\n")
        + ("sys.stdout.write('not json')\n" if payload is None else "")
        + f"sys.exit({returncode})\n"
    )
    stub = tmp_path / "stub_verify.py"
    stub.write_text(body, encoding="utf-8")
    return stub


def run_hook(stub: Path, stop_hook_active: bool = False):
    env = {**os.environ, "APPBI_STOP_GATE_VERIFY": str(stub)}
    env.pop("APPBI_STOP_GATE_OVERRIDE", None)
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps({"stop_hook_active": stop_hook_active}),
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=env, cwd=str(REPO_ROOT), timeout=120,
    )


def test_e2e_all_green_allows_the_stop(tmp_path):
    result = run_hook(write_stub(tmp_path, 0, {"failed": [], "unverified": [], "passed": ["a"]}))
    assert result.returncode == ALLOW
    assert result.stderr.strip() == ""


def test_e2e_failed_gate_blocks_the_stop(tmp_path):
    result = run_hook(write_stub(tmp_path, 1, {"failed": ["locked_contract"], "unverified": []},
                                 human="locked_contract FAILED"))
    assert result.returncode == BLOCK
    assert "locked_contract" in result.stderr


def test_e2e_unverified_blocks_first_then_allows_retry(tmp_path):
    payload = {"failed": [], "passed": ["measure_render"],
               "unverified": [["golden_sql", "declared missing"]]}
    stub = write_stub(tmp_path, 0, payload)

    first = run_hook(stub, stop_hook_active=False)
    assert first.returncode == BLOCK
    assert "golden_sql" in first.stderr
    assert "declared missing" in first.stderr

    retry = run_hook(stub, stop_hook_active=True)
    assert retry.returncode == ALLOW
    assert retry.stderr.strip() == ""


def test_e2e_override_allows_the_stop_and_says_it_is_unverified(tmp_path):
    stub = write_stub(tmp_path, 1, {"failed": ["x"], "unverified": []})
    env = {**os.environ, "APPBI_STOP_GATE_VERIFY": str(stub),
           "APPBI_STOP_GATE_OVERRIDE": "i-accept-unverified"}
    result = subprocess.run([sys.executable, str(HOOK)],
                            input=json.dumps({"stop_hook_active": False}),
                            capture_output=True, text=True, env=env,
                            cwd=str(REPO_ROOT), timeout=120)
    assert result.returncode == ALLOW
    assert "UNVERIFIED" in result.stderr


def test_e2e_a_wrong_override_phrase_does_not_bypass(tmp_path):
    stub = write_stub(tmp_path, 1, {"failed": ["x"], "unverified": []})
    env = {**os.environ, "APPBI_STOP_GATE_VERIFY": str(stub),
           "APPBI_STOP_GATE_OVERRIDE": "yes"}
    result = subprocess.run([sys.executable, str(HOOK)],
                            input=json.dumps({"stop_hook_active": False}),
                            capture_output=True, text=True, env=env,
                            cwd=str(REPO_ROOT), timeout=120)
    assert result.returncode == BLOCK


def test_e2e_missing_verifier_blocks(tmp_path):
    result = run_hook(tmp_path / "does_not_exist.py")
    assert result.returncode == BLOCK
    assert "NOT a verified completion" in result.stderr


def test_e2e_failed_still_blocks_on_the_retry(tmp_path):
    """Case 4: a failure Claude did not fix must not slip through the retry."""
    stub = write_stub(tmp_path, 1, {"failed": ["locked_contract"], "unverified": []},
                      human="locked_contract FAILED")
    first = run_hook(stub, stop_hook_active=False)
    assert first.returncode == BLOCK
    retry = run_hook(stub, stop_hook_active=True)
    assert retry.returncode == BLOCK
    assert "keeps blocking" in retry.stderr


def test_e2e_failed_then_fixed_is_allowed(tmp_path):
    """Case 5: the gate re-runs verification, so a real fix releases it.

    Two different stubs stand in for "before the fix" and "after the fix" — the
    hook holds no latched state, it just re-reads the current result.
    """
    failing = write_stub(tmp_path, 1, {"failed": ["locked_contract"], "unverified": []})
    assert run_hook(failing, stop_hook_active=False).returncode == BLOCK

    fixed_dir = tmp_path / "fixed"
    fixed_dir.mkdir()
    fixed = write_stub(fixed_dir, 0, {"failed": [], "unverified": [], "passed": ["locked_contract"]})
    after = run_hook(fixed, stop_hook_active=True)
    assert after.returncode == ALLOW
    assert after.stderr.strip() == ""


def test_e2e_missing_verifier_blocks_on_the_retry_too(tmp_path):
    """Infrastructure breakage is not a visibility stop; retrying does not fix it."""
    absent = tmp_path / "does_not_exist.py"
    assert run_hook(absent, stop_hook_active=False).returncode == BLOCK
    retry = run_hook(absent, stop_hook_active=True)
    assert retry.returncode == BLOCK
    assert "NOT a verified completion" in retry.stderr


def test_e2e_malformed_output_blocks_on_the_retry_too(tmp_path):
    stub = write_stub(tmp_path, 0, None)
    assert run_hook(stub, stop_hook_active=False).returncode == BLOCK
    retry = run_hook(stub, stop_hook_active=True)
    assert retry.returncode == BLOCK
    assert "infrastructure failure" in retry.stderr
