"""The sealed evaluation harness keeps its three promises (ADR-008, spec §6).

1. Its answers are independent: the oracle runs on DuckDB over the fixture, and
   every case's oracle result equals a value computed BY HAND from the fixture
   rows (`hand_expected`). An oracle that drifted would fail here, not in a
   score.
2. The runtime cannot read it: no module under `backend/app` imports the
   harness or names its directory.
3. A holdout answer is never also trusted knowledge: leaking cases are
   excluded, and the eval refuses to run without an isolated snapshot and with
   memory capture on.
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from eval.sealed.case import BENCHMARK_TAGS, CaseError, load_cases  # noqa: E402
from eval.sealed.leakage import find_leaks, normalize  # noqa: E402
from eval.sealed.oracle import compute_expected  # noqa: E402
from eval.sealed.runner import IsolationError, evaluate, grade  # noqa: E402

CASES = load_cases()
BY_ID = {c.id: c for c in CASES}


def test_cases_load_and_both_splits_exist():
    splits = {c.split for c in CASES}
    assert splits == {"dev", "holdout"}
    assert all(set(c.tags) <= BENCHMARK_TAGS for c in CASES)


@pytest.mark.parametrize("case", CASES, ids=[c.id for c in CASES])
def test_the_oracle_reproduces_the_hand_computed_answer(case):
    assert case.hand_expected is not None, "every case carries an independent golden value"
    expected = compute_expected(case)
    if case.answer_kind == "scalar":
        assert grade(case, expected, case.hand_expected)[0], (expected.scalar, case.hand_expected)
    else:
        rows = [tuple(r) for r in case.hand_expected]
        assert grade(case, expected, rows)[0], (expected.rows, rows)


@pytest.mark.parametrize("case", CASES, ids=[c.id for c in CASES])
def test_the_oracle_is_deterministic(case):
    assert compute_expected(case).fingerprint == compute_expected(case).fingerprint


def test_the_fanout_trap_is_a_real_trap():
    """The naive join answer differs from the oracle, so a system that fans the
    order-level fee out over order lines is graded wrong."""
    case = BY_ID["dev-004-shipping-fanout"]
    expected = compute_expected(case)
    assert expected.scalar == 50
    ok, why = grade(case, expected, 80)
    assert not ok and "expected 50" in why


def test_grading_is_on_value_and_tolerance():
    case = BY_ID["dev-002-mom-growth"]
    expected = compute_expected(case)
    assert grade(case, expected, 100.0000001)[0]
    assert not grade(case, expected, 101.0)[0]
    assert not grade(case, expected, [(100.0,)])[0], "rows for a scalar case are wrong shape"


def test_a_holdout_case_cannot_hide_in_the_dev_file(tmp_path):
    (tmp_path / "dev.json").write_text(
        '[{"id":"x","split":"holdout","question":"q","locale":"vi","fixture":"retail_vn",'
        '"oracle_sql":"SELECT 1","answer_kind":"scalar","tags":["deterministic_sql"]}]',
        encoding="utf-8",
    )
    with pytest.raises(CaseError):
        load_cases(tmp_path)


def test_an_unknown_tag_is_refused(tmp_path):
    (tmp_path / "dev.json").write_text(
        '[{"id":"x","split":"dev","question":"q","locale":"vi","fixture":"retail_vn",'
        '"oracle_sql":"SELECT 1","answer_kind":"scalar","tags":["vibes"]}]',
        encoding="utf-8",
    )
    with pytest.raises(CaseError):
        load_cases(tmp_path)


# ── leakage ─────────────────────────────────────────────────────────────────


def test_normalisation_ignores_case_and_diacritics():
    assert normalize("Đơn hàng bị HUỶ") == normalize("don hang bi huy")


def test_a_trusted_asset_that_answers_a_holdout_question_is_a_leak():
    holdout = BY_ID["hold-001-cancelled-q3"]
    leaks = find_leaks(CASES, ["có bao nhiêu đơn hàng bị huỷ trong quý 3 năm 2026"])
    assert [l.case_id for l in leaks] == [holdout.id]


def test_unrelated_trusted_knowledge_is_not_a_leak():
    assert find_leaks(CASES, ["Doanh thu thuần không gồm đơn huỷ", "GMV theo kênh bán"]) == []


def test_dev_cases_are_never_reported_as_leaks():
    dev = BY_ID["dev-001-net-revenue-month"]
    assert find_leaks([dev], [dev.question]) == []


# ── isolation ───────────────────────────────────────────────────────────────


def _oracle_answer(case):
    exp = compute_expected(case)
    return exp.scalar if case.answer_kind == "scalar" else list(exp.rows)


def test_the_eval_refuses_without_an_isolated_snapshot():
    with pytest.raises(IsolationError):
        evaluate(CASES, _oracle_answer, knowledge_snapshot_id=None, memory_capture=False)


def test_the_eval_refuses_with_memory_capture_on():
    with pytest.raises(IsolationError):
        evaluate(CASES, _oracle_answer, knowledge_snapshot_id="snap-1", memory_capture=True)


def test_a_leaking_holdout_case_is_excluded_not_scored():
    report = evaluate(
        CASES, _oracle_answer, knowledge_snapshot_id="snap-1", memory_capture=False,
        trusted_texts=["What was the average net revenue per delivered order in August 2026?"],
    )
    assert report["excluded_for_leakage"] == ["hold-002-aov-august"]
    assert report["by_split"]["holdout"] == {"scored": 1, "correct": 1}
    assert report["by_split"]["dev"]["scored"] == report["by_split"]["dev"]["correct"] == 5


def test_the_runtime_cannot_import_or_name_the_harness():
    """No module under backend/app imports `eval.sealed` or names its directory.
    The AI cannot retrieve what it cannot load."""
    offenders: list[str] = []
    for path in (BACKEND / "app").rglob("*.py"):
        src = path.read_text(encoding="utf-8-sig", errors="replace")  # some files carry a BOM
        if "eval/sealed" in src or "eval\\\\sealed" in src or "eval.sealed" in src:
            offenders.append(str(path.relative_to(BACKEND)))
            continue
        for node in ast.walk(ast.parse(src)):
            mod = getattr(node, "module", None) if isinstance(node, ast.ImportFrom) else None
            names = [a.name for a in node.names] if isinstance(node, (ast.Import, ast.ImportFrom)) else []
            if mod == "eval" or (mod or "").startswith("eval.") or any(
                n == "eval" or n.startswith("eval.") for n in names if isinstance(node, ast.Import)
            ):
                offenders.append(str(path.relative_to(BACKEND)))
    assert offenders == []
