"""The floor beneath analysis: what a metric MEANS and how it is CALCULATED.

A report answer has to get those right before any analysis built on top of it is
worth having, and the semantic model records both. The agent was shown neither: a
field reached it only with a description attached, and what travelled was prose.
Measured across the model — 5721 fields, 135 hidden, 161 with a description, 304
with a real formula, 70 declaring a unit.

So `avg_tasks_per_user`, whose calculation is recorded exactly and whose format
says two decimals, was invisible because nobody had written a sentence about it.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_level0.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services import embedding_service as es
from app.services.dashboard_ai_bot.knowledge_context import _formula_of, _unit_of


# ── what counts as a formula ───────────────────────────────────────────────────

def test_a_column_mapping_is_not_a_formula():
    """`sql` is present on all 5721 fields, and for a plain column it IS the
    column. Reporting `bc_key -> bc_key` back to an agent as "the formula" is
    noise dressed as an answer."""
    assert _formula_of({"name": "bc_key", "sql": "bc_key"}) == ""


def test_case_and_spacing_do_not_make_a_mapping_into_a_formula():
    assert _formula_of({"name": "Revenue", "sql": " revenue "}) == ""


def test_a_sql_that_says_more_than_the_name_is_a_formula():
    assert _formula_of({"name": "net", "sql": "revenue - cost"}) == "revenue - cost"


def test_expression_wins_over_sql():
    """The computed-measure form. It carries `filters` and `depends_on` with it,
    and it is the one the modeller actually wrote."""
    field = {"name": "ratio", "sql": "ratio",
             "expression": "${a} / NULLIF(${b}, 0)"}
    assert _formula_of(field) == "${a} / NULLIF(${b}, 0)"


def test_a_formula_is_clipped_so_sixty_of_them_still_fit():
    assert len(_formula_of({"name": "x", "expression": "a+" * 400})) <= 180


# ── the unit, which decides what a number means ────────────────────────────────

def test_a_percent_format_reaches_the_agent_as_words():
    """91.2 and 91.2% are different answers and the difference was recorded in a
    dict the agent never saw."""
    assert "phần trăm" in _unit_of({"format": {"kind": "percent", "decimals": 1}})


def test_currency_and_decimals_are_reported():
    unit = _unit_of({"format": {"kind": "number", "currency": "VND", "decimals": 2}})
    assert "VND" in unit and "2" in unit


def test_no_format_is_no_unit_rather_than_an_invented_one():
    assert _unit_of({"name": "x"}) == ""


# ── which fields reach the agent at all ────────────────────────────────────────

class _Column:
    """Enough of a SQLAlchemy column for `.filter(X.in_(...))` to be built."""

    def in_(self, values):
        return None


class _View:
    dataset_table_id = _Column()

    def __init__(self, measures):
        self.measures = measures
        self.dimensions = []


def _fields(monkeypatch, measures):
    """Run `_semantic_fields` against an in-memory model."""
    from app.services.dashboard_ai_bot import knowledge_context as kc

    class _Query:
        def __init__(self, model):
            self._model = model

        def filter(self, *a, **k):
            return self

        def all(self):
            name = getattr(self._model, "__name__", "")
            if name == "DatasetTable" or self._model is not _View:
                return [_Table(1)]
            return [_View(measures)]

    class _Table:
        def __init__(self, tid):
            self.id = tid

    class _DB:
        def query(self, model):
            if model is _View:
                return _Query(_View)
            return _Query(model)

    import app.models.semantic as sem

    monkeypatch.setattr(sem, "SemanticView", _View, raising=False)
    return kc._semantic_fields(_DB(), {1})


def test_a_measure_with_a_formula_and_no_prose_is_no_longer_thrown_away(monkeypatch):
    """`avg_tasks_per_user` records its calculation exactly and declares two
    decimals. It was invisible because nobody had written a sentence about it,
    and an agent asked what it means had to guess from the name — the one thing
    the steering block tells it never to do."""
    fields = _fields(monkeypatch, [
        {"name": "avg_tasks_per_user", "label": "Avg tasks / user",
         "sql": "avg_tasks_per_user",
         "expression": "${task_count} * 1.0 / NULLIF(${users}, 0)",
         "format": {"kind": "number", "decimals": 2}, "hidden": False},
    ])
    assert len(fields) == 1
    assert fields[0]["formula"].startswith("${task_count}")
    assert fields[0]["description"] is None


def test_a_hidden_field_stays_hidden(monkeypatch):
    """A modeller who hid a field hid it from readers, and an agent quoting it is
    a reader. 135 fields are hidden and none of them were being filtered."""
    fields = _fields(monkeypatch, [
        {"name": "internal_key", "label": "internal_key", "sql": "x + 1",
         "hidden": True},
    ])
    assert fields == []


def test_a_field_carrying_nothing_at_all_is_still_dropped(monkeypatch):
    """The filter loosened; it did not disappear. A bare column with no
    description, no calculation and no unit says nothing worth a token."""
    fields = _fields(monkeypatch, [
        {"name": "crm_name", "label": "crm_name", "sql": "crm_name",
         "hidden": False},
    ])
    assert fields == []


def test_described_fields_outrank_bare_calculations_under_the_cap(monkeypatch):
    """Sixty is a ceiling, not a selection. Dropping the documented measures to
    keep sixty arbitrary ones would lose exactly what the agent needs most."""
    measures = [{"name": f"m{i}", "label": f"m{i}", "sql": f"m{i} + 1",
                 "hidden": False} for i in range(70)]
    measures.append({"name": "gmv", "label": "GMV", "sql": "gmv_raw",
                     "description": "Gồm phí ship", "hidden": False})
    fields = _fields(monkeypatch, measures)
    assert len(fields) == 60
    assert fields[0]["label"] == "GMV"


def test_the_aggregation_is_part_of_the_calculation():
    """`review_count` records `*` and a type of count. "*" alone is true and
    useless; "COUNT(*)" is the answer to the question that was asked."""
    assert _formula_of({"name": "review_count", "sql": "*",
                        "type": "count"}) == "COUNT(*)"
    assert _formula_of({"name": "avg_review_score", "sql": "${TABLE}.score",
                        "type": "avg"}) == "AVG(${TABLE}.score)"


def test_count_distinct_closes_its_brackets():
    assert _formula_of({"name": "buyers", "sql": "customer_id",
                        "type": "count_distinct"}) == "COUNT(DISTINCT customer_id)"


def test_a_formula_over_measures_is_not_wrapped_in_an_aggregation():
    """Formula mode bypasses the wrapping agg entirely — the engine returns the
    expression as it stands. Wrapping it here would describe a query nobody
    runs."""
    assert _formula_of({"name": "gmv", "type": "sum",
                        "expression": "${a} + ${b}"}) == "${a} + ${b}"
