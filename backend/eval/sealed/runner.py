"""Running the sealed eval: grading and the isolation preconditions."""
from __future__ import annotations

import math
import unicodedata
from dataclasses import dataclass
from typing import Callable, Iterable

from .case import EvalCase
from .leakage import find_leaks
from .oracle import Expected, compute_expected


class IsolationError(RuntimeError):
    """The eval was asked to run without an isolated knowledge snapshot."""


@dataclass(frozen=True)
class Verdict:
    case_id: str
    split: str
    correct: bool
    reason: str
    expected_fingerprint: str


def _same(a, b, tol: float) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        if a == b:
            return True
        if any(isinstance(x, float) and math.isnan(x) for x in (a, b)):
            return False
        return abs(a - b) <= tol * max(abs(a), abs(b), 1.0)
    if isinstance(a, str) and isinstance(b, str):
        return unicodedata.normalize("NFC", a) == unicodedata.normalize("NFC", b)
    return a == b


def grade(case: EvalCase, expected: Expected, actual) -> tuple[bool, str]:
    """Compare a system result to the oracle.

    ``actual`` is a scalar for a scalar case, or a list of row tuples for a table
    case. Grading is on the VALUE and never on prose. The Analyst's answer text
    is graded separately (Phase 3), against the evidence it cites."""
    if case.answer_kind == "scalar":
        if isinstance(actual, (list, tuple)):
            return False, "expected a scalar, got rows"
        ok = _same(expected.scalar, actual, case.tolerance)
        return ok, "" if ok else f"expected {expected.scalar!r}, got {actual!r}"
    rows = [tuple(r) for r in (actual or [])]
    if len(rows) != len(expected.rows):
        return False, f"expected {len(expected.rows)} rows, got {len(rows)}"
    exp = list(expected.rows)
    if not case.ordered:
        key = lambda r: tuple(str(v) for v in r)  # noqa: E731
        rows, exp = sorted(rows, key=key), sorted(exp, key=key)
    for i, (got, want) in enumerate(zip(rows, exp)):
        if len(got) != len(want) or not all(_same(w, g, case.tolerance) for w, g in zip(want, got)):
            return False, f"row {i}: expected {want!r}, got {got!r}"
    return True, ""


def evaluate(
    cases: Iterable[EvalCase],
    answer: Callable[[EvalCase], object],
    *,
    knowledge_snapshot_id: str | None,
    memory_capture: bool,
    trusted_texts: Iterable[str] = (),
) -> dict:
    """Score ``answer`` on ``cases``.

    Refuses unless the caller names an isolated knowledge snapshot and has memory
    capture OFF (ADR-008). Holdout cases that leak into ``trusted_texts`` (the
    snapshot's trusted assets) are excluded and listed, not scored."""
    if not knowledge_snapshot_id:
        raise IsolationError("an eval needs an isolated knowledge snapshot id")
    if memory_capture:
        raise IsolationError("memory capture must be OFF during an eval")
    cases = list(cases)
    leaks = find_leaks(cases, trusted_texts)
    leaked = {l.case_id for l in leaks}
    verdicts: list[Verdict] = []
    for case in cases:
        if case.id in leaked:
            continue
        expected = compute_expected(case)
        ok, why = grade(case, expected, answer(case))
        verdicts.append(Verdict(case.id, case.split, ok, why, expected.fingerprint))
    by_split = {
        split: {
            "scored": sum(1 for v in verdicts if v.split == split),
            "correct": sum(1 for v in verdicts if v.split == split and v.correct),
        }
        for split in ("dev", "holdout")
    }
    return {
        "snapshot": knowledge_snapshot_id,
        "verdicts": verdicts,
        "by_split": by_split,
        "excluded_for_leakage": sorted(leaked),
        "leaks": leaks,
    }
