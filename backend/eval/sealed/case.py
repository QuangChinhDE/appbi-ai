"""Evaluation cases: schema, loading, validation."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

HERE = Path(__file__).resolve().parent
CASES_DIR = HERE / "cases"
FIXTURES_DIR = HERE / "fixtures"

Split = Literal["dev", "holdout"]

#: The benchmark dimensions the program mandate requires (one tag per dimension).
#: A case carries at least one, so coverage can be reported per dimension rather
#: than hidden in one aggregate.
BENCHMARK_TAGS = frozenset({
    "deterministic_sql",
    "business_metric_meaning",
    "multi_table",
    "time_comparison",
    "incorrect_join",
    "cross_domain_retrieval",
    "vi_en_terminology",
    "unauthorized_access",
    "knowledge_conflict",
    "evidence_backed",
    "no_dashboard",
    "multi_user_isolation",
    "large_catalog",
    "latency_cost",
    "repeated_run_stability",
})


class CaseError(ValueError):
    """A case file that does not satisfy the schema."""


@dataclass(frozen=True)
class EvalCase:
    id: str
    split: Split
    question: str
    locale: Literal["vi", "en"]
    fixture: str
    #: DuckDB SQL over the fixture's tables. The oracle, not the system under test.
    oracle_sql: str
    answer_kind: Literal["scalar", "table"]
    tags: tuple[str, ...]
    #: Relative tolerance for numeric comparison.
    tolerance: float = 1e-9
    #: For tables: whether row order is part of the answer (a "top N" is).
    ordered: bool = False
    #: Why the question is hard, for a reader of a failure. Never shown to the system.
    note: str = ""
    #: Hand-computed expected value, cross-checked against the oracle in tests.
    #: Optional; when present the oracle must reproduce it exactly.
    hand_expected: object = field(default=None, compare=False)


_REQUIRED = ("id", "split", "question", "locale", "fixture", "oracle_sql", "answer_kind", "tags")


def _parse(raw: dict, *, source: str) -> EvalCase:
    missing = [k for k in _REQUIRED if k not in raw]
    if missing:
        raise CaseError(f"{source}: case {raw.get('id', '?')} lacks {missing}")
    if raw["split"] not in ("dev", "holdout"):
        raise CaseError(f"{source}: {raw['id']}: split must be dev|holdout")
    if raw["locale"] not in ("vi", "en"):
        raise CaseError(f"{source}: {raw['id']}: locale must be vi|en")
    if raw["answer_kind"] not in ("scalar", "table"):
        raise CaseError(f"{source}: {raw['id']}: answer_kind must be scalar|table")
    tags = tuple(raw["tags"])
    if not tags or not set(tags) <= BENCHMARK_TAGS:
        raise CaseError(f"{source}: {raw['id']}: tags {sorted(set(tags) - BENCHMARK_TAGS)} unknown or empty")
    if not (FIXTURES_DIR / f"{raw['fixture']}.json").is_file():
        raise CaseError(f"{source}: {raw['id']}: fixture {raw['fixture']!r} does not exist")
    return EvalCase(
        id=str(raw["id"]), split=raw["split"], question=str(raw["question"]),
        locale=raw["locale"], fixture=str(raw["fixture"]), oracle_sql=str(raw["oracle_sql"]),
        answer_kind=raw["answer_kind"], tags=tags,
        tolerance=float(raw.get("tolerance", 1e-9)), ordered=bool(raw.get("ordered", False)),
        note=str(raw.get("note", "")), hand_expected=raw.get("hand_expected"),
    )


def load_cases(directory: Path = CASES_DIR) -> list[EvalCase]:
    """Every case under ``directory``. Ids are unique across all files, and a
    file's name must match the split of every case in it (``dev.json`` holds
    only dev cases), so a holdout case cannot hide in a dev file."""
    cases: list[EvalCase] = []
    seen: set[str] = set()
    for path in sorted(directory.glob("*.json")):
        expected_split = path.stem
        for raw in json.loads(path.read_text(encoding="utf-8")):
            case = _parse(raw, source=path.name)
            if case.split != expected_split:
                raise CaseError(f"{path.name}: {case.id} is split {case.split!r}")
            if case.id in seen:
                raise CaseError(f"duplicate case id {case.id}")
            seen.add(case.id)
            cases.append(case)
    return cases
