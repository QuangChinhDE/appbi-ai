"""Semantic Kernel Contract v2 — cross-view derived measures, executed.

A derived measure is arithmetic over semantic measures whose meanings stay
stable at their own valid grains. ``${orders.revenue} / ${employees.headcount}``
means: each dependency evaluated exactly as when it is asked on its own, then
the arithmetic. It never aggregates one dependency over another view's joined
rows (the JOIN-before-aggregate defect: customers.n counted the 5 joined sales
rows — rev_per_cust 39, and 49 next to its own dependencies — refused by the v1
freeze, 455034e3), and it never answers what its dependencies, asked together,
would refuse.

The value oracles are in tests/foundation_corpus.py (F7, computed by hand from
tests/pair2_topology.py). This module proves the contract BETWEEN a formula and
its dependencies on a real Postgres (DATABASE_URL) and DuckDB:

  * a formula's answer is the arithmetic over its dependencies' answer to the
    same request, NULLs and the zero-denominator rule included — and a refusal
    of the dependencies is the formula's refusal, same category;
  * the answer is the same from every chart base (the calendar included);
  * the historical JOIN-before-aggregate number is not it;
  * a formula is never re-aggregated, never pivoted / windowed, never cyclic;
  * a dependency used twice is computed once and a deep formula compiles in
    bounded time.
"""
from __future__ import annotations

import math
import re
import time

import pytest
from sqlalchemy.orm.attributes import flag_modified

from app.models.semantic import SemanticView
from app.services.query_cache import SEMANTIC_RESULT_CACHE_VERSION
from app.services.semantic_query_engine import SemanticQueryEngine
from tests import foundation_corpus as F
from tests import pair2_topology as T
from tests.test_pair2_golden_topology_pg import (  # noqa: F401 — fixtures
    _norm,
    canon,
    duck,
    expect,
    generate,
    pg,
    run,
    world,
    world_duck,
)

_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\}")


def _mdef(ref):
    view, name = ref.split(".", 1)
    return next((m for m in T.VIEWS[view][2] if m.get("name") == name), None)


def _is_formula(m):
    return bool(m and m.get("expression") and m.get("depends_on"))


def _qualify(raw, view):
    return raw if "." in raw else f"{view}.{raw}"


def _leaves(ref):
    m = _mdef(ref)
    if not _is_formula(m):
        return [ref]
    view = ref.split(".", 1)[0]
    out = []
    for raw in _REF.findall(m["expression"]):
        for leaf in _leaves(_qualify(raw, view)):
            if leaf not in out:
                out.append(leaf)
    return out


class _N:
    """A SQL number: NULL propagates, and a zero denominator is NULL (kernel v1 FZ-1)."""

    def __init__(self, v):
        self.v = None if v is None else float(v)

    def _op(self, other, fn):
        o = other if isinstance(other, _N) else _N(other)
        return _N(None) if self.v is None or o.v is None else _N(fn(self.v, o.v))

    def __add__(self, o): return self._op(o, lambda a, b: a + b)
    def __sub__(self, o): return self._op(o, lambda a, b: a - b)
    def __mul__(self, o): return self._op(o, lambda a, b: a * b)
    def __rmul__(self, o): return _N(o) * self

    def __truediv__(self, o):
        o = o if isinstance(o, _N) else _N(o)
        return _N(None) if self.v is None or o.v in (None, 0.0) else _N(self.v / o.v)


def _evaluate(ref, row):
    """The formula's value computed in Python from its dependencies' values."""
    m = _mdef(ref)
    if not _is_formula(m):
        return _N(row[ref])
    view = ref.split(".", 1)[0]
    expr = _REF.sub(lambda mt: f"_v({_qualify(mt.group(1), view)!r})", m["expression"])
    return eval(expr, {"__builtins__": {}}, {"_v": lambda r: _evaluate(r, row)})  # noqa: S307 — fixture text


def _formulas(req):
    return [m for m in req["measures"] if _is_formula(_mdef(m))]


_DIRECT = [c for c in F.XVIEW_CASES + F.XVIEW_SOFT_DROPS
           if _formulas(c[3]) and c[4] != "UNSUPPORTED_CONTEXT"
           and not any(k in c[3]["measures"] for k in (c[3].get("filters") or {}))]


@pytest.mark.parametrize("case", _DIRECT, ids=[c[0] for c in _DIRECT])
def test_a_formula_is_arithmetic_over_its_dependencies_asked_together(world, case):
    _id, model, base, req, _expected = case
    formulas = _formulas(req)
    deps = []
    for m in req["measures"]:
        for leaf in (_leaves(m) if m in formulas else [m]):
            if leaf not in deps:
                deps.append(leaf)
    got = run(world, model, base, req)
    asked = run(world, model, base, {**req, "measures": deps})
    if asked[0] == "error":
        assert got[:2] == asked[:2], f"the dependencies refuse {asked[1]}; the formula answered {got}"
        return
    assert got[0] == "rows", f"the dependencies answer {asked[1]}; the formula refused {got[1]}"
    dims = list(req.get("dims") or [])
    want = []
    for row in asked[1]:
        out = {d: row[d] for d in dims}
        for m in req["measures"]:
            out[m] = _norm(_evaluate(m, row).v) if m in formulas else row[m]
        want.append(out)
    assert canon(got[1]) == canon(want), f"{got[1]} != arithmetic over {asked[1]}"
    assert set(asked[2]) == set(got[2]), f"dropped {got[2]} != the dependencies' {asked[2]}"


@pytest.mark.parametrize("model,ref,bases,value", [
    ("G1_star", "p2_sales.rev_per_cust", ["p2_sales", "p2_customers", "p2_products"], 49.5),
    ("G6_three_facts", "p2_revenue.rev_over_deals", ["p2_revenue", "p2_deals", "p2_owners", "p2_cal"], 180 / 1420),
    ("G6_three_facts", "p2_revenue.rev_per_call", ["p2_revenue", "p2_deals", "p2_activity", "p2_cal"],
     (180 / 1420) / 7),
])
@pytest.mark.parametrize("fixture", ["world", "world_duck"])
def test_a_formula_has_the_same_value_from_every_chart_base(request, fixture, model, ref, bases, value):
    w = request.getfixturevalue(fixture)
    for base in bases:
        expect(run(w, model, base, {"dims": [], "measures": [ref]}), [{ref: value}])


def test_the_join_before_aggregate_number_is_not_the_formula(world):
    """Historical oracle (50d39a55 … 6afc9523): customers.n inlined in a formula on sales was
    aggregated over sales LEFT JOIN customers — COUNT(*) of 5 sale rows, 198 / 5. The meaning of
    customers.n is 4 customers, so the formula is 198 / 4."""
    _names, raw = world.execute(
        f"SELECT SUM(s.amount) * 1.0 / COUNT(*) FROM {T.S}.sales s LEFT JOIN {T.S}.customers c "
        "ON s.customer_id = c.id")
    joined = float(raw[0][0])
    assert math.isclose(joined, 39.6)
    _names, raw = world.execute(f"SELECT COUNT(*) FROM {T.S}.customers")
    assert raw[0][0] == 4
    kind, rows, _ = run(world, "G1_star", "p2_sales", {"dims": [], "measures": ["p2_sales.rev_per_cust"]})
    assert kind == "rows" and math.isclose(float(rows[0]["p2_sales.rev_per_cust"]), 198 / 4)
    assert not math.isclose(float(rows[0]["p2_sales.rev_per_cust"]), joined)


def test_a_same_view_formula_next_to_a_cross_view_one_keeps_its_value(world):
    expect(run(world, "G1_star", "p2_sales",
               {"dims": [], "measures": ["p2_customers.cust_ratio", "p2_sales.rev_per_cust", "p2_sales.revenue"]}),
           [{"p2_customers.cust_ratio": 2, "p2_sales.rev_per_cust": 49.5, "p2_sales.revenue": 198}])


def _engine_generate(w, model_key, base, **kw):
    eng = SemanticQueryEngine(w.db, database_type=w.dialect)
    args = {"explore_name": base, "dimensions": [], "measures": [], "filters": {},
            "model_id": w.fwd[model_key], **kw}
    return eng, eng.generate_sql(**args)


@pytest.mark.parametrize("agg", ["max", "count_distinct", "avg"])
def test_a_cross_view_formula_is_never_re_aggregated(world, agg):
    from app.services.semantic_join_resolver import SemanticRefusal

    with pytest.raises(SemanticRefusal) as exc:
        _engine_generate(world, "G6_three_facts", "p2_revenue", measures=["p2_revenue.rev_over_deals"],
                         measure_agg_overrides={"p2_revenue.rev_over_deals": agg})
    assert exc.value.category == SemanticRefusal.UNSUPPORTED_CONTEXT
    # its stored type ("sum") or auto is the formula itself
    for same in ("sum", "auto"):
        _engine_generate(world, "G6_three_facts", "p2_revenue", measures=["p2_revenue.rev_over_deals"],
                         measure_agg_overrides={"p2_revenue.rev_over_deals": same})


def test_a_dependency_shown_with_another_aggregation_is_refused(world):
    from app.services.semantic_join_resolver import SemanticRefusal

    with pytest.raises(SemanticRefusal) as exc:
        _engine_generate(world, "G6_three_facts", "p2_revenue",
                         measures=["p2_revenue.amount", "p2_revenue.rev_over_deals"],
                         measure_agg_overrides={"p2_revenue.amount": "max"})
    assert exc.value.category == SemanticRefusal.UNSUPPORTED_CONTEXT


@pytest.mark.parametrize("extra", [
    {"pivots": ["p2_owners.name"], "dimensions": ["p2_cal.year", "p2_owners.name"]},
    {"window_functions": [{"name": "w", "type": "running_total", "base_measure": "p2_revenue.rev_over_deals",
                           "order_by": ["p2_cal.year"]}], "dimensions": ["p2_cal.year"]},
])
def test_a_cross_view_formula_with_a_pivot_or_window_is_refused(world, extra):
    from app.services.semantic_join_resolver import SemanticRefusal

    with pytest.raises(SemanticRefusal) as exc:
        _engine_generate(world, "G6_three_facts", "p2_revenue", measures=["p2_revenue.rev_over_deals"], **extra)
    assert exc.value.category == SemanticRefusal.UNSUPPORTED_CONTEXT


def _set_measures(w, view_name, extra):
    v = w.db.query(SemanticView).filter(SemanticView.name == view_name).first()
    v.measures = list(v.measures or []) + extra
    flag_modified(v, "measures")
    w.db.flush()


def test_a_cross_view_dependency_cycle_is_refused(world):
    _set_measures(world, "p2_revenue", [{"name": "cyc_a", "type": "sum", "expression": "${p2_deals.cyc_b} / 2",
                                          "depends_on": ["p2_deals.cyc_b"]}])
    _set_measures(world, "p2_deals", [{"name": "cyc_b", "type": "sum", "expression": "${p2_revenue.cyc_a} + 1",
                                        "depends_on": ["p2_revenue.cyc_a"]}])
    with pytest.raises(ValueError, match="Circular measure dependency"):
        _engine_generate(world, "G6_three_facts", "p2_revenue", measures=["p2_revenue.cyc_a"])


def test_a_dependency_used_twice_is_computed_once(world):
    eng, _ = _engine_generate(world, "G6_three_facts", "p2_revenue", measures=["p2_revenue.rev_sq_over_deals"])
    assert eng.query_plan["formula"] == "cross_view"
    assert eng.query_plan["formula_dependencies"] == ["p2_revenue.amount", "p2_deals.value"]


def test_a_deep_wide_formula_compiles_in_bounded_time_with_each_dependency_once(world):
    # 6 nested levels, each combining the previous level with all three facts' measures
    prev = "p2_revenue.amount"
    extra = []
    for i in range(6):
        name = f"deep_{i}"
        extra.append({"name": name, "type": "sum",
                      "expression": f"(${{{prev}}} + ${{p2_deals.value}} * 2 - ${{p2_activity.calls}}) / "
                                    f"(${{p2_deals.value}} + ${{{prev}}})",
                      "depends_on": [prev, "p2_deals.value", "p2_activity.calls"]})
        prev = f"p2_revenue.{name}"
    _set_measures(world, "p2_revenue", extra)
    t0 = time.perf_counter()
    eng, (sql, _cols, _pivots) = _engine_generate(world, "G6_three_facts", "p2_revenue", measures=[prev])
    assert time.perf_counter() - t0 < 5
    assert sorted(eng.query_plan["formula_dependencies"]) == sorted(
        ["p2_revenue.amount", "p2_deals.value", "p2_activity.calls"])
    _names, raw = world.execute(sql)
    assert len(raw) == 1


def test_a_meaning_change_has_a_new_result_cache_identity():
    # v1 (foundation-freeze-2026-10) cached a REFUSAL for a cross-view formula; v2 answers it
    assert SEMANTIC_RESULT_CACHE_VERSION != "foundation-freeze-2026-10"
