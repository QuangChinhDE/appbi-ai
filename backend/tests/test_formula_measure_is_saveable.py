"""A measure that computes correctly and cannot be edited.

Four measures in this deployment carry `type: "formula"` — `gmv`, `aov`,
`on_time_rate`, `pct_five_star`, which is to say the four a report is actually
built on. They compute correctly: when a measure has both `expression` and
`depends_on`, `semantic_query_engine` returns the formula as it stands and never
reads the type at all.

The schema did not accept the value. So every view containing one was unsaveable
from the builder: adding a description to ANY measure in those views came back
422, "Input should be 'count', 'sum', 'avg', …". That is how the level-0 work —
writing down what a measure MEANS — was blocked on the one dataset that most
needed it, and the error named a field the author had not touched.
"""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_formula_measure.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest
from pydantic import ValidationError

from app.schemas.semantic import MeasureDefinition


def test_a_formula_over_measures_validates():
    m = MeasureDefinition(
        name="gmv", type="formula",
        expression="${total_revenue} + ${total_freight}",
        depends_on=["total_revenue", "total_freight"],
    )
    assert m.type == "formula"


def test_the_ordinary_aggregations_still_validate():
    for kind in ("count", "sum", "avg", "min", "max", "count_distinct",
                 "percent_of_total"):
        assert MeasureDefinition(name="m", type=kind, sql="x").type == kind


def test_an_invented_type_is_still_refused():
    """Widened by one value, not opened up. A typo in the aggregation must still
    fail at save time rather than at SQL execution."""
    with pytest.raises(ValidationError):
        MeasureDefinition(name="m", type="average", sql="x")


def test_the_engine_never_reads_the_type_for_such_a_measure():
    """Which is why accepting the value is safe: it is inert for exactly the
    measures that carry it. `_render_measure_formula` is reached before any
    branch on `measure_type`."""
    import inspect

    from app.services.semantic_query_engine import SemanticQueryEngine

    source = inspect.getsource(SemanticQueryEngine)
    guard = "if expression_template and depends_on and"
    assert guard in source
    after = source[source.index(guard):]
    assert "_render_measure_formula" in after[:400]


def test_the_builder_does_not_offer_it_as_an_aggregation():
    """Formula-ness is INFERRED from `depends_on` in the builder — picking it by
    hand would be a second, contradictory way to say the same thing — so the
    dropdown must not list it."""
    from pathlib import Path

    panel = Path(__file__).resolve().parents[2] / "frontend" / "src" / \
        "components" / "datasets" / "ModelViewEditPanel.tsx"
    if not panel.exists():
        pytest.skip("frontend not present in this checkout")
    text = panel.read_text(encoding="utf-8")
    block = text[text.index("const MEASURE_TYPES"):]
    block = block[:block.index("]")]
    assert "'formula'" not in block
