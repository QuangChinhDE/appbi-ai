# -*- coding: utf-8 -*-
"""A test path present in the workflow FILE is not a test pytest is given.

WHAT HAPPENED. Five new suites were added to `backend-contract-tests.yml`. An
edit collapsed four `\\` line continuations into literal backslash-n characters,
so one line of the `run:` block read:

    tests/a.py \\n            tests/b.py \\n            tests/c.py \\

`verify.py`'s wiring check asked `f"tests/{name}" not in workflow` — a substring
test over the whole file — and every name was there, so it went green. The shell
saw a bare `n` as an argument, pytest answered

    ERROR: file or directory not found: n
    no tests ran in 0.00s

and the entire unit tier exited 4 having run NOTHING. Three suites believed to be
gates ran nothing, and the check that exists to catch exactly this said they were
wired.

THE RULE. A pytest argument is a line. So the check is per line, and a literal
backslash-n anywhere in the workflow is named as the collapsed-continuation
signature it is — because this trap has now cost a red CI, and the next person
should be told what they are looking at rather than deducing it.

These cases run the real `backend_tests_reach_ci` against a temporary repository,
so they exercise the checker rather than a description of it.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

import pytest

_VERIFY = pathlib.Path(__file__).resolve().parent / "verify.py"


@pytest.fixture(scope="module")
def V():
    spec = importlib.util.spec_from_file_location("appbi_verify", _VERIFY)
    module = importlib.util.module_from_spec(spec)
    sys.modules["appbi_verify"] = module
    spec.loader.exec_module(module)
    return module


class _Report:
    """Just enough of `Report` to record the verdict."""

    def __init__(self):
        self.failures: list[str] = []
        self.passes: list[str] = []

    def section(self, _name):
        return None

    def bad(self, why):
        self.failures.append(why)

    def ok(self, why):
        self.passes.append(why)


WORKFLOW_HEAD = """name: t
on: [push]
jobs:
  unit:
    steps:
      - run: |
          pytest \\
"""


def _repo(tmp_path: pathlib.Path, names: list[str], run_lines: str) -> pathlib.Path:
    (tmp_path / "backend" / "tests").mkdir(parents=True)
    for name in names:
        (tmp_path / "backend" / "tests" / name).write_text("", encoding="utf-8")
    (tmp_path / ".gitignore").write_text(
        "\n".join(f"!backend/tests/{n}" for n in names) + "\n", encoding="utf-8")
    wf = tmp_path / ".github" / "workflows"
    wf.mkdir(parents=True)
    (wf / "backend-contract-tests.yml").write_text(
        WORKFLOW_HEAD + run_lines, encoding="utf-8")
    return tmp_path


def _run(V, monkeypatch, root: pathlib.Path) -> _Report:
    monkeypatch.setattr(V, "REPO_ROOT", root)
    rep = _Report()
    V.backend_tests_reach_ci(rep, [])
    return rep


def test_properly_wired_suites_pass(V, monkeypatch, tmp_path):
    root = _repo(tmp_path, ["test_a.py", "test_b.py"],
                 "            tests/test_a.py \\\n            tests/test_b.py\n")
    rep = _run(V, monkeypatch, root)
    assert rep.failures == [], rep.failures


def test_a_collapsed_continuation_is_caught(V, monkeypatch, tmp_path):
    """THE MEASURED FAILURE. Both names are in the file; only the first is an
    argument."""
    mangled = "            tests/test_a.py \\" + "\\n" + "            tests/test_b.py\n"
    root = _repo(tmp_path, ["test_a.py", "test_b.py"], mangled)
    rep = _run(V, monkeypatch, root)

    assert rep.failures, (
        "a workflow whose pytest list is one mangled argument was reported as "
        "correctly wired — this is the check that went green while the unit tier "
        "ran zero tests"
    )
    joined = " ".join(rep.failures) + " " + " ".join(
        str(x) for x in getattr(rep, "lines", []))
    del joined


def test_the_mangled_line_is_named_with_its_number(V, monkeypatch, tmp_path, capsys):
    mangled = "            tests/test_a.py \\" + "\\n" + "            tests/test_b.py\n"
    root = _repo(tmp_path, ["test_a.py", "test_b.py"], mangled)
    _run(V, monkeypatch, root)
    printed = capsys.readouterr().out
    assert "literal \\n" in printed, printed
    assert "backend-contract-tests.yml:" in printed, printed


def test_a_suite_only_present_mid_line_says_so(V, monkeypatch, tmp_path, capsys):
    """'Present but not an argument' is a different diagnosis from 'absent', and
    the message has to distinguish them or the reader looks in the wrong place."""
    mangled = "            tests/test_a.py \\" + "\\n" + "            tests/test_b.py\n"
    root = _repo(tmp_path, ["test_a.py", "test_b.py"], mangled)
    _run(V, monkeypatch, root)
    printed = capsys.readouterr().out
    assert "test_b.py" in printed
    assert "not an argument" in printed, printed


def test_a_genuinely_absent_suite_is_still_caught(V, monkeypatch, tmp_path, capsys):
    """The original contract, unchanged: allow-listed therefore committed
    therefore believed to be a gate, and no CI job runs it."""
    root = _repo(tmp_path, ["test_a.py", "test_b.py"],
                 "            tests/test_a.py\n")
    rep = _run(V, monkeypatch, root)
    printed = capsys.readouterr().out
    assert rep.failures
    assert "test_b.py" in printed
    assert "not an argument" not in printed, (
        "a suite that is nowhere in the file was diagnosed as mid-line"
    )


def test_an_allow_listed_file_that_does_not_exist_is_caught(V, monkeypatch, tmp_path,
                                                            capsys):
    root = _repo(tmp_path, ["test_a.py"], "            tests/test_a.py\n")
    (tmp_path / ".gitignore").write_text(
        "!backend/tests/test_a.py\n!backend/tests/test_ghost.py\n", encoding="utf-8")
    rep = _run(V, monkeypatch, root)
    printed = capsys.readouterr().out
    assert rep.failures
    assert "test_ghost.py" in printed and "does not exist" in printed


def test_the_real_repository_workflow_is_intact(V):
    """And the one that matters: this repository's own workflow, right now."""
    root = pathlib.Path(__file__).resolve().parents[2]
    workflow = (root / ".github" / "workflows" / "backend-contract-tests.yml")
    text = workflow.read_text(encoding="utf-8")
    bad = [i for i, ln in enumerate(text.splitlines(), start=1) if "\\n" in ln]
    assert not bad, (
        f"{workflow.name} has a collapsed line continuation on line(s) {bad}; "
        "every test path after it is lost"
    )
