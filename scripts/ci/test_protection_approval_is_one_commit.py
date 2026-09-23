# -*- coding: utf-8 -*-
"""The owner-approval hatch, and the reason it had never once worked.

THE BUG THIS EXISTS FOR.

`check_protection_integrity.py` refuses a change that deletes a gate unless the
repository owner approves it, and the approval is pinned to ONE commit:

    approved_sha == head_sha    ->    the removal is allowed
    anything else               ->    blocked

The checker reads `APPBI_ALLOW_PROTECTION_REMOVAL_SHA`. `change-guardrail.yml`
exported `APPBI_ALLOW_PROTECTION_REMOVAL` — no suffix. The variable never reached
the process, so an owner who set it would have watched the gate block anyway with
no indication why, and the only escape route from a legitimate gate removal was
to not have the gate.

Nothing catches that class from either side alone: the checker is correct about
the name it reads, the workflow is valid YAML, and a unit test of the decision
function passes while the two halves disagree. So the first test here compares
the two FILES.

WHY THE REST RUN AGAINST A REAL REPOSITORY.

The approval only has an observable effect on a diff that actually removes a
protected file, which this repository's own history does not contain. Asserting
on a synthetic `allow_removal` boolean would test the fixture. Each case below
builds a throwaway git repo, deletes a protection-critical file in a second
commit, and runs the real script over the real range.

THE PROPERTY BEING PINNED is narrow on purpose: the approval is a SHA, not a
switch. `true`, `1`, a branch name and `*` must all fail, and amending the commit
must invalidate it — otherwise "approved once" becomes "approved from now on",
which is the thing a per-commit hatch exists to prevent.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
CHECKER = REPO / "scripts" / "ci" / "check_protection_integrity.py"
WORKFLOW = REPO / ".github" / "workflows" / "change-guardrail.yml"

#: The one name. Both files must agree on it, exactly.
ENV_NAME = "APPBI_ALLOW_PROTECTION_REMOVAL_SHA"


def test_the_workflow_exports_the_variable_the_checker_reads():
    """The contract mismatch itself. This is the test that was missing."""
    checker = CHECKER.read_text(encoding="utf-8")
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert f'os.environ.get("{ENV_NAME}")' in checker, (
        "the checker no longer reads the pinned-SHA variable"
    )
    exported = set(re.findall(r"(APPBI_ALLOW_PROTECTION_REMOVAL[A-Z_]*)\s*:", workflow))
    assert exported, "change-guardrail.yml exports no approval variable at all"
    assert exported == {ENV_NAME}, (
        f"change-guardrail.yml exports {sorted(exported)}, the checker reads "
        f"{ENV_NAME!r}. A name that does not match is a hatch that cannot open."
    )
    # And it must be fed from a repository variable, not from the PR.
    assert f"vars.{ENV_NAME}" in workflow, (
        "the approval must come from a repository variable a pull request "
        "cannot set for itself"
    )


# ── the semantics, against a real repository ────────────────────────────────

def _git(cwd: pathlib.Path, *args: str) -> str:
    out = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True,
                         text=True, encoding="utf-8", errors="replace")
    assert out.returncode == 0, f"git {' '.join(args)} failed: {out.stderr}"
    return out.stdout.strip()


@pytest.fixture()
def repo_with_a_removed_gate(tmp_path: pathlib.Path):
    """base -> head, where head deletes a protection-critical file."""
    root = tmp_path / "repo"
    (root / "scripts" / "guardrail").mkdir(parents=True)
    (root / "scripts" / "ci").mkdir(parents=True)
    (root / ".githooks").mkdir(parents=True)

    _git(tmp_path, "init", "-q", "repo")
    _git(root, "config", "user.email", "t@t")
    _git(root, "config", "user.name", "t")

    (root / "scripts" / "guardrail" / "guardrail_rules.yaml").write_text(
        "version: 2\nprotected: []\ninvariants: []\ntests: {}\n", encoding="utf-8")
    (root / ".githooks" / "pre-push").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (root / "scripts" / "ci" / "verify.py").write_text("# gate\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "base")
    base = _git(root, "rev-parse", "HEAD")

    # Delete a file the checker lists as protection-critical.
    _git(root, "rm", "-q", ".githooks/pre-push")
    _git(root, "commit", "-q", "-m", "remove a gate")
    head = _git(root, "rev-parse", "HEAD")
    return root, base, head


def _run(root: pathlib.Path, base: str, head: str, approval: str | None):
    env = dict(os.environ)
    env.pop(ENV_NAME, None)
    if approval is not None:
        env[ENV_NAME] = approval
    env["PYTHONIOENCODING"] = "utf-8"
    # The checker resolves its repo from its own location, so it is copied in.
    target = root / "scripts" / "ci" / "check_protection_integrity.py"
    target.write_text(CHECKER.read_text(encoding="utf-8"), encoding="utf-8")
    out = subprocess.run(
        [sys.executable, str(target), "--base", base, "--head", head, "--json"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
    try:
        payload = json.loads(out.stdout)
    except json.JSONDecodeError:  # pragma: no cover - only on a broken checker
        pytest.fail(f"checker did not emit JSON: {out.stdout[:400]} {out.stderr[:400]}")
    return out.returncode, payload


def test_unset_blocks_the_removal(repo_with_a_removed_gate):
    root, base, head = repo_with_a_removed_gate
    code, payload = _run(root, base, head, None)
    assert code == 1
    assert any("pre-push" in f and "DELETED" in f for f in payload["findings"])


@pytest.mark.parametrize("approval", ["true", "1", "yes", "*", "demo", "HEAD",
                                      "0000000000000000000000000000000000000000"])
def test_anything_that_is_not_the_exact_head_sha_blocks(repo_with_a_removed_gate, approval):
    """A switch, a wildcard and a branch name are all refused.

    `true` is the interesting one: it is what someone reaches for when the hatch
    does not appear to work, and it must not become a permanent opening.
    """
    root, base, head = repo_with_a_removed_gate
    code, payload = _run(root, base, head, approval)
    assert code == 1, f"{approval!r} was accepted as an approval"
    assert any("DELETED" in f for f in payload["findings"])


def test_the_exact_head_sha_permits_the_declared_removal(repo_with_a_removed_gate):
    root, base, head = repo_with_a_removed_gate
    code, payload = _run(root, base, head, head)
    assert code == 0, f"exact-SHA approval did not open the hatch: {payload}"
    assert not payload["findings"]
    assert any("allowed for this exact commit" in n for n in payload["notes"])


def test_the_approval_is_case_insensitive_but_still_exact(repo_with_a_removed_gate):
    root, base, head = repo_with_a_removed_gate
    code, _ = _run(root, base, head, head.upper())
    assert code == 0
    # One character off is not the commit.
    wrong = head[:-1] + ("a" if head[-1] != "a" else "b")
    code, _ = _run(root, base, head, wrong)
    assert code == 1


def test_a_new_commit_after_the_approval_is_blocked_again(repo_with_a_removed_gate):
    """The property that makes this a hatch and not a window."""
    root, base, head = repo_with_a_removed_gate
    assert _run(root, base, head, head)[0] == 0

    # The author pushes one more commit. The approval named the old SHA.
    (root / "scripts" / "ci" / "another.py").write_text("# later\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "one more push")
    new_head = _git(root, "rev-parse", "HEAD")
    assert new_head != head

    code, payload = _run(root, base, new_head, head)
    assert code == 1, "an approval survived a later push"
    assert any("does NOT apply to this commit" in n for n in payload["notes"]), (
        "the reviewer must be told WHY the approval did not count"
    )


def test_the_hatch_does_not_excuse_anything_other_than_a_removal(repo_with_a_removed_gate):
    """Approval covers deletions. It must not silence a required_tests loss.

    That finding has no `allow_removal` branch in the checker, deliberately: a
    subsystem quietly losing a gate while keeping its entry is not the same act
    as deleting one, and the owner approving the latter did not approve it.
    """
    root, base, _ = repo_with_a_removed_gate
    rules = root / "scripts" / "guardrail" / "guardrail_rules.yaml"
    rules.write_text(
        "version: 2\n"
        "protected:\n"
        "  - id: s\n"
        "    required_tests: [a, b]\n"
        "invariants: []\ntests: {}\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "a subsystem with two gates")
    with_two = _git(root, "rev-parse", "HEAD")

    rules.write_text(
        "version: 2\n"
        "protected:\n"
        "  - id: s\n"
        "    required_tests: [a]\n"
        "invariants: []\ntests: {}\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "and now one")
    with_one = _git(root, "rev-parse", "HEAD")

    code, payload = _run(root, with_two, with_one, with_one)
    assert code == 1, "an exact-SHA approval silenced a lost required gate"
    assert any("lost required gate" in f for f in payload["findings"])
