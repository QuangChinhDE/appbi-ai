# -*- coding: utf-8 -*-
"""A documented invariant is a test — checked, not asserted.

`docs/agent-flow-v3-target-architecture.md` §4 said "each line is a test" and
nothing checked it: a promise could be written, repeated in reviews, and held by
nothing. Now each row of that table names the test that holds it, and this file
makes the table executable:

  * every referenced `tests/<file>.py::<function>` exists, as a test function,
    in a file the backend CI workflow actually runs;
  * a row with no test is allowed only when it says, explicitly, that the
    invariant does not apply yet ("chưa áp dụng") and why;
  * the table is not empty and is numbered without gaps.

If a gate moves, rename the reference; if a gate is deleted, this fails — which
is the point: a promise nothing enforces must be removed from the document or
given a test, not left half-true.
"""
from __future__ import annotations

import ast
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
DOC = ROOT / "docs" / "agent-flow-v3-target-architecture.md"
WORKFLOW = ROOT / ".github" / "workflows" / "backend-contract-tests.yml"
REF = re.compile(r"`(tests/[\w/]+\.py)::(\w+)`")


def _rows() -> list[tuple[int, str, str]]:
    text = DOC.read_text(encoding="utf-8")
    section = text.split("## 4. Bất biến của V3", 1)[1].split("\n## ", 1)[0]
    rows = []
    for line in section.splitlines():
        m = re.match(r"\|\s*(\d+)\s*\|(.*)\|(.*)\|\s*$", line)
        if m:
            rows.append((int(m.group(1)), m.group(2).strip(), m.group(3).strip()))
    return rows


def _test_functions(path: pathlib.Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return {n.name for n in ast.walk(tree)
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test_")}


def test_the_table_exists_and_is_numbered_without_gaps():
    rows = _rows()
    assert len(rows) >= 11, "the invariant table is missing or was cut"
    assert [r[0] for r in rows] == list(range(1, len(rows) + 1))


def test_every_invariant_names_a_test_or_says_why_not():
    for number, claim, lock in _rows():
        refs = REF.findall(lock)
        assert refs or "chưa áp dụng" in lock, (
            f"invariant {number} ({claim[:60]}…) names no test and does not say it is not "
            "applicable yet — a documented promise nothing enforces")


def test_every_named_test_exists_and_ci_runs_it():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    backend = ROOT / "backend"
    for number, _claim, lock in _rows():
        for file, fn in REF.findall(lock):
            path = backend / file
            assert path.exists(), f"invariant {number}: {file} does not exist"
            assert fn in _test_functions(path), f"invariant {number}: {file}::{fn} is not a test"
            assert file in workflow, f"invariant {number}: {file} exists but CI never runs it"
