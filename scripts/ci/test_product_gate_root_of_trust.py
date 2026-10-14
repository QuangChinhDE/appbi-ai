# -*- coding: utf-8 -*-
"""The gate that decides what may merge must not be graded by the branch it gates.

THE SEAM.

`Product gate` is a required status on `demo`. Its logic lives in
`.github/workflows/product-gate.yml`, and the tests that check that logic live in
this repository and run from the PR HEAD. So a single pull request could weaken
the workflow AND the tests that would have objected, and every remaining check
would still be green — because the thing that objects is the thing being edited.

`check_protection_integrity.py` closes exactly this class, by running from the
merge BASE and reading the head as DATA. It protected three workflows and not the
one branch protection had just been pointed at.

WHAT THESE TESTS DO.

They mutate the workflow the way a careless or motivated change would, and assert
the BASE checker objects. Each mutation is a real weakening someone could make
while believing they were tidying up:

    delete the workflow
    remove the final sentinel job
    drop the backend dependency
    drop the E2E dependency
    drop the classifier dependency
    remove `if: always()`
    accept `skipped` for a relevant suite
    let a failed classification mean nothing is relevant
    path-filter the always-present status

And the other half, which matters just as much: a checker that fails on a comment
or a renamed display string gets routed around within a week, so harmless edits
must pass.

BOOTSTRAP. PR #2's base predates this code and therefore cannot protect the
Product Gate it introduces. That is stated in the PR rather than hidden: this one
merge is covered by human review plus the gate having actually run, and every
merge after it is covered by the base copy of this contract.
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

import pytest
import yaml

REPO = pathlib.Path(__file__).resolve().parents[2]
CHECKER = REPO / "scripts" / "ci" / "check_protection_integrity.py"
GATE = ".github/workflows/product-gate.yml"


def _git(cwd: pathlib.Path, *args: str) -> str:
    out = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True,
                         text=True, encoding="utf-8", errors="replace")
    assert out.returncode == 0, f"git {' '.join(args)}: {out.stderr}"
    return out.stdout.strip()


@pytest.fixture()
def repo(tmp_path: pathlib.Path):
    """A throwaway repo whose base carries the real Product Gate."""
    root = tmp_path / "r"
    (root / ".github" / "workflows").mkdir(parents=True)
    (root / "scripts" / "ci").mkdir(parents=True)
    (root / "scripts" / "guardrail").mkdir(parents=True)

    _git(tmp_path, "init", "-q", "r")
    _git(root, "config", "user.email", "t@t")
    _git(root, "config", "user.name", "t")

    (root / "scripts" / "guardrail" / "guardrail_rules.yaml").write_text(
        "version: 2\nprotected: []\ninvariants: []\ntests: {}\n", encoding="utf-8")
    (root / GATE).write_text(
        (REPO / GATE).read_text(encoding="utf-8"), encoding="utf-8", newline="\n")
    (root / "scripts" / "ci" / "check_protection_integrity.py").write_text(
        CHECKER.read_text(encoding="utf-8"), encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "base")
    base = _git(root, "rev-parse", "HEAD")
    return root, base


def _head_with(repo, mutate) -> tuple[pathlib.Path, str, str]:
    root, base = repo
    path = root / GATE
    if mutate is None:
        path.unlink()
    else:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        mutate(data)
        path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
                        encoding="utf-8", newline="\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "mutate")
    return root, base, _git(root, "rev-parse", "HEAD")


def _run(root: pathlib.Path, base: str, head: str):
    out = subprocess.run(
        [sys.executable, str(root / "scripts" / "ci" / "check_protection_integrity.py"),
         "--base", base, "--head", head, "--json"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    import json
    return out.returncode, json.loads(out.stdout)


def _sentinel_name(data: dict) -> str:
    for name, job in data["jobs"].items():
        needs = job.get("needs") or []
        needs = [needs] if isinstance(needs, str) else list(needs)
        if len(needs) >= 3 and "steps" in job:
            return name
    raise AssertionError("no sentinel in the real workflow")


# ── the mutations that must be caught ──────────────────────────────────────

def test_deleting_the_workflow_is_caught(repo):
    root, base, head = _head_with(repo, None)
    code, payload = _run(root, base, head)
    assert code == 1
    assert any("product-gate.yml" in f and "DELETED" in f for f in payload["findings"])


def _drop_sentinel(data):
    del data["jobs"][_sentinel_name(data)]


def _drop_backend_dep(data):
    s = _sentinel_name(data)
    backend = next(n for n, j in data["jobs"].items()
                   if "backend-contract-tests" in str(j.get("uses") or ""))
    data["jobs"][s]["needs"] = [n for n in data["jobs"][s]["needs"] if n != backend]


def _drop_e2e_dep(data):
    s = _sentinel_name(data)
    e2e = next(n for n, j in data["jobs"].items()
               if str(j.get("uses") or "").endswith("e2e.yml"))
    data["jobs"][s]["needs"] = [n for n in data["jobs"][s]["needs"] if n != e2e]


def _drop_classifier_dep(data):
    s = _sentinel_name(data)
    classifier = next(n for n, j in data["jobs"].items()
                      if j.get("outputs") and n != s)
    data["jobs"][s]["needs"] = [n for n in data["jobs"][s]["needs"] if n != classifier]


def _drop_always(data):
    data["jobs"][_sentinel_name(data)].pop("if", None)


def _accept_skipped(data):
    s = _sentinel_name(data)
    for step in data["jobs"][s]["steps"]:
        if step.get("run"):
            step["run"] = step["run"].replace("skipped", "ignored")


def _swallow_classification_failure(data):
    s = _sentinel_name(data)
    for step in data["jobs"][s]["steps"]:
        if step.get("run"):
            step["run"] = step["run"].replace("RESULT_CLASSIFY", "UNUSED_CLASSIFY")
            step["run"] = step["run"].replace("classify", "unused")


def _stop_requiring_success(data):
    s = _sentinel_name(data)
    for step in data["jobs"][s]["steps"]:
        if step.get("run"):
            step["run"] = step["run"].replace("success", "ran")


def _path_filter_the_gate(data):
    triggers = data.get("on") or data.get(True)
    triggers["pull_request"] = {"paths": ["backend/**"]}


def _remove_pull_request(data):
    triggers = data.get("on") or data.get(True)
    triggers.pop("pull_request", None)
    triggers["workflow_dispatch"] = None


@pytest.mark.parametrize("label,mutate", [
    ("final sentinel job removed", _drop_sentinel),
    ("backend dependency dropped", _drop_backend_dep),
    ("E2E dependency dropped", _drop_e2e_dep),
    ("classifier dependency dropped", _drop_classifier_dep),
    ("always-run removed", _drop_always),
    ("skipped no longer distinguished", _accept_skipped),
    ("classification failure swallowed", _swallow_classification_failure),
    ("success no longer required", _stop_requiring_success),
    ("the gate itself path-filtered", _path_filter_the_gate),
    ("no longer runs on pull_request", _remove_pull_request),
])
def test_a_weakening_of_the_product_gate_is_caught(repo, label, mutate):
    root, base, head = _head_with(repo, mutate)
    code, payload = _run(root, base, head)
    assert code == 1, f"{label} was not caught: {payload}"
    assert payload["findings"], label


# ── and the half that keeps the checker usable ─────────────────────────────

def _harmless_comment(data):
    s = _sentinel_name(data)
    data["jobs"][s]["steps"][0]["run"] = (
        "# a note someone added while reading this\n"
        + data["jobs"][s]["steps"][0]["run"])


def _rename_display_name(data):
    for name, job in data["jobs"].items():
        job["name"] = "Renamed " + str(job.get("name") or name)


def _reorder_jobs(data):
    data["jobs"] = dict(reversed(list(data["jobs"].items())))


@pytest.mark.parametrize("label,mutate", [
    ("a harmless comment", _harmless_comment),
    ("a renamed display name", _rename_display_name),
    ("reordered jobs", _reorder_jobs),
])
def test_a_harmless_change_is_not_rejected(repo, label, mutate):
    """A checker that fails on cosmetics gets routed around within a week."""
    root, base, head = _head_with(repo, mutate)
    code, payload = _run(root, base, head)
    assert code == 0, f"{label} was rejected: {payload['findings']}"


def test_the_real_workflow_satisfies_its_own_contract():
    """The positive control: every mutation above is measured against a base that
    passes, so a checker that rejected everything would look identical."""
    sys.path.insert(0, str(REPO / "scripts" / "ci"))
    try:
        import importlib

        mod = importlib.import_module("check_protection_integrity")
        importlib.reload(mod)
        mod.findings.clear()
        mod.check_product_gate_contract("HEAD")
        assert not mod.findings, mod.findings
    finally:
        sys.path.pop(0)


def test_product_gate_is_in_the_protection_critical_contract():
    src = CHECKER.read_text(encoding="utf-8")
    i = src.index("PROTECTION_CRITICAL_WORKFLOWS")
    assert GATE in src[i:i + 500], (
        "the status branch protection requires is not protection-critical"
    )
