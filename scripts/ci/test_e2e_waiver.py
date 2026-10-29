"""The locally-verified E2E waiver (scripts/ci/e2e_waiver.py) waives only what was tested.

Each case builds a throwaway git repository: a tested commit, then a head that adds
the evidence file - and, in the refusing cases, one more change, a failed suite, no
evidence or no label. Only the exact "tested commit + its evidence, labelled" shape
skips the PR's E2E.
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess

import pytest

_spec = importlib.util.spec_from_file_location("e2e_waiver_under_test", pathlib.Path(__file__).with_name("e2e_waiver.py"))
w = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(w)

SUITES = [{"name": "public bot", "passed": 16, "failed": 0}]


def _git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()


@pytest.fixture()
def repo(tmp_path, monkeypatch):
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.email", "t@t")
    _git(tmp_path, "config", "user.name", "t")
    (tmp_path / "app.py").write_text("print(1)\n")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "tested")
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _head_with(repo, evidence=None, extra=False):
    tested = _git(repo, "rev-parse", "HEAD")
    if evidence is not False:
        (repo / ".verified").mkdir(exist_ok=True)
        body = {"tested_sha": tested, "runtime_sha": tested, "suites": SUITES, **(evidence or {})}
        (repo / ".verified" / "local-e2e.json").write_text(json.dumps(body))
    if extra:
        (repo / "app.py").write_text("print(2)\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "evidence", "--allow-empty")
    return _git(repo, "rev-parse", "HEAD")


def test_the_tested_commit_plus_its_evidence_labelled_skips_e2e(repo):
    head = _head_with(repo)
    e2e, waived, why = w.decide(True, ["verified-locally"], head)
    assert (e2e, waived) == (False, True) and "16 passed" in why


def test_no_label_runs_e2e(repo):
    assert w.decide(True, [], _head_with(repo))[:2] == (True, False)


def test_code_changed_after_the_tested_commit_is_refused(repo):
    e2e, waived, why = w.decide(True, ["verified-locally"], _head_with(repo, extra=True))
    assert (e2e, waived) == (True, False) and "app.py" in why


def test_a_failed_or_empty_suite_is_refused(repo):
    head = _head_with(repo, {"suites": [{"name": "bot", "passed": 15, "failed": 1}]})
    assert w.decide(True, ["verified-locally"], head)[:2] == (True, False)
    head = _head_with(repo, {"suites": []})
    assert w.decide(True, ["verified-locally"], head)[:2] == (True, False)


def test_missing_evidence_or_a_foreign_tested_sha_is_refused(repo):
    assert w.decide(True, ["verified-locally"], _head_with(repo, evidence=False))[:2] == (True, False)
    head = _head_with(repo, {"tested_sha": "0" * 40})
    assert w.decide(True, ["verified-locally"], head)[:2] == (True, False)


def test_an_irrelevant_e2e_stays_irrelevant(repo):
    assert w.decide(False, ["verified-locally"], _head_with(repo))[:2] == (False, False)
