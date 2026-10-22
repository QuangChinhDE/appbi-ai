"""GQS `date_range` — the one governed time-range operator, on real Postgres.

Contract (services/governed_query/service.py): {"from": "YYYY-MM-DD", "to":
"YYYY-MM-DD"}, `from` INCLUDED and `to` EXCLUDED, only on a CERTIFIED date field
(a dimension declared `date` whose physical type is DATE). It compiles to the
engine's `date_between [from, to - 1 day]`, exact for a DATE value. A TIMESTAMP
(whose day depends on the calendar timezone), a date declared over text and an
unknown physical type are refused, never approximated. `between` stays refused
(test_r4 in test_intelligence_gqs_execution_pg).

World rows (tests/test_intelligence_gqs_execution_pg.world): 2026-01-05 Bắc 100,
2026-01-20 Bắc 50, 2026-02-03 Nam 30, 2026-02-17 Trung 20.
"""
from __future__ import annotations

import pytest
from sqlalchemy.orm.attributes import flag_modified

from tests.authz_http import db  # noqa: F401 - fixtures
from tests.test_intelligence_gqs_execution_pg import Sink, _gqs, _refused, _req, world  # noqa: F401

pytestmark = pytest.mark.pg


def _physical(world, source_type, declared="date"):  # noqa: F811
    view = world["view"]
    dims = []
    for d in view.dimensions:
        d = dict(d)
        if d["name"] == "order_date":
            d["type"] = declared
            if source_type is None:
                d.pop("source_type", None)
            else:
                d["source_type"] = source_type
        dims.append(d)
    view.dimensions = dims
    flag_modified(view, "dimensions")
    world["db"].commit()


def _total(world, rng, dims=()):  # noqa: F811
    gqs, p = _gqs(world, sink=Sink())
    res = gqs.execute(_req(world, p, dims=dims, measures=["revenue"],
                           filters={"order_date": {"operator": "date_range", "value": rng}}))
    col = next(c.name for c in res.columns if c.role == "measure")
    if not dims:
        return float(res.rows[0][col] or 0) if res.rows else 0.0
    dcol = next(c.name for c in res.columns if c.role == "dimension")
    return {r[dcol]: float(r[col]) for r in res.rows}


@pytest.fixture()
def certified(world):  # noqa: F811
    _physical(world, "date")
    return world


@pytest.mark.parametrize("rng, expected", [
    ({"from": "2026-01-01", "to": "2026-02-01"}, 150.0),     # a month
    ({"from": "2026-01-01", "to": "2027-01-01"}, 200.0),     # a year
    ({"from": "2026-01-01", "to": "2026-04-01"}, 200.0),     # a quarter
    ({"from": "2026-01-05", "to": "2026-01-20"}, 100.0),     # `to` is excluded: the 01-20 row is not in
    ({"from": "2026-01-20", "to": "2026-01-21"}, 50.0),      # a single day
    ({"from": "2025-12-31", "to": "2026-01-06"}, 100.0),     # crossing the year boundary
    ({"from": "2025-01-01", "to": "2026-01-01"}, 0.0),       # a year with no rows: nothing, not an error
])
def test_a_range_includes_from_and_excludes_to(certified, rng, expected):
    assert _total(certified, rng) == expected


def test_a_range_with_a_breakdown(certified):
    assert _total(certified, {"from": "2026-02-01", "to": "2026-03-01"}, dims=["region"]) == {"Nam": 30.0, "Trung": 20.0}


@pytest.mark.parametrize("bad", [
    {"from": "2026-02-01", "to": "2026-01-01"},              # reversed
    {"from": "2026-01-01", "to": "2026-01-01"},              # empty
    {"from": "2026-01-01"},                                  # open end
    {"from": "2026-01-01", "to": "2026-02-01", "tz": "x"},   # extra key
    {"from": "2026-01-01T00:00", "to": "2026-02-01"},        # a time is not a date
    {"from": "01/01/2026", "to": "2026-02-01"},              # not ISO
    {"from": "2026-02-30", "to": "2026-03-01"},              # not a date
    {"from": "2000-01-01", "to": "2026-01-01"},              # span past the bound
    ["2026-01-01", "2026-02-01"],                            # the between shape
])
def test_a_malformed_range_is_refused(certified, bad):
    gqs, p = _gqs(certified, sink=Sink())
    _refused(lambda: gqs.execute(_req(certified, p, measures=["revenue"],
                                      filters={"order_date": {"operator": "date_range", "value": bad}})),
             "invalid_filter")


@pytest.mark.parametrize("declared, physical", [
    ("date", None),            # physical type unknown: cannot be certified
    ("date", "timestamp"),     # an instant: its day depends on the calendar timezone
    ("datetime", "date"),      # declared as a datetime
    ("date", "text"),          # a date declared over text
    ("string", "text"),        # not a date at all
])
def test_an_uncertified_field_is_refused_not_approximated(world, declared, physical):  # noqa: F811
    _physical(world, physical, declared=declared)
    gqs, p = _gqs(world, sink=Sink())
    _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"], filters={
        "order_date": {"operator": "date_range", "value": {"from": "2026-01-01", "to": "2026-02-01"}}})),
             "time_range_unsupported")


def test_a_range_never_runs_for_someone_without_the_data(certified):
    gqs, p = _gqs(certified, who="viewer", sink=Sink())
    _refused(lambda: gqs.execute(_req(certified, p, measures=["revenue"], filters={
        "order_date": {"operator": "date_range", "value": {"from": "2026-01-01", "to": "2026-02-01"}}})),
             "not_authorized")


def test_between_is_still_not_a_governed_operator(certified):
    gqs, p = _gqs(certified, sink=Sink())
    _refused(lambda: gqs.execute(_req(certified, p, measures=["revenue"], filters={
        "order_date": {"operator": "between", "value": ["2026-01-01", "2026-01-31"]}})), "invalid_filter")
