"""A chat turn has charts, and everything that reads them survives having no report.

WHAT THIS FILE IS ABOUT
-----------------------
Direct Chat used to hardcode `allowed_chart_ids = set()`. Every chart-keyed tool —
20 of the 36 — refused every id with `chart_out_of_scope`, so the surface was
frozen at "documents only" and a rule in `direct_chat.ineligibility_reasons`
disqualified any flow that was even GRANTED one of those tools.

Charts now come from the datasets the flow's author attached. That is a real
widening and the tests below pin both halves of it: what it opens, and the floor
under it — a flow that attached nothing still measures nothing.

WHY THE SECOND HALF OF THE FILE EXISTS
--------------------------------------
Giving chat a chart scope immediately exposed two things that had never been
exercised, because until now nothing on this surface ever looked at a chart:

  1. `tool_list_charts` read `ctx.dashboard.name` unguarded. Chat builds its
     context with `dashboard=None` deliberately. AttributeError, swallowed by
     `search_business_assets` into a warning, and the assistant answered "I could
     not find that figure" about a figure it had been given access to.

  2. `chart_meta` is built by `ToolContext.for_dashboard` from tile layout. Chat
     constructs the class directly, so it was empty — every chart would have come
     back named "Chart 412" with no measures and no dimensions, and
     `_searchable_terms` reads the same dict, so `list_charts(query=...)` would
     score every chart zero.

Measured on this deployment, before and after, same question and same model:
8 tool calls / 16.7s / wrong ("no such figure") → 2 tool calls / 9.3s / correct
("health_beauty, 1,258,681.34").
"""
from __future__ import annotations

from app.services.agent_flows import permissions
from app.services.agent_flows.tools.context import ToolContext
from app.services.dashboard_ai_bot.thinking.tools import tool_list_charts


# ── the scope itself ────────────────────────────────────────────────────────


class _Rows:
    """Enough of a SQLAlchemy query to answer `.filter(...).all()`."""

    def __init__(self, rows, seen):
        self._rows, self._seen = rows, seen

    def filter(self, *criteria):
        self._seen.append(criteria)
        return self

    def all(self):
        return self._rows


class _DB:
    """Answers each `query(...)` with the next prepared row set."""

    def __init__(self, *answers):
        self._answers = list(answers)
        self.seen: list = []

    def query(self, *_cols):
        if not self._answers:
            raise AssertionError("queried more times than the test prepared for")
        return _Rows(self._answers.pop(0), self.seen)


class _Chart:
    def __init__(self, id, name, config=None, chart_type="bar", description=""):
        self.id = id
        self.name = name
        self.config = config or {}
        self.chart_type = chart_type
        self.description = description


def test_a_flow_that_attached_nothing_still_measures_nothing():
    """THE FLOOR UNDER THE WIDENING.

    Sharing an assistant lends its author's reading rights; it does not lend the
    warehouse. Attaching is the gate, and an empty grant keeps it shut — the same
    answer the hardcoded empty set gave, reached for a reason instead of by
    accident.
    """
    db = _DB()  # any query at all raises

    assert permissions.chart_scope(db, {"dataset_ids": []}) == set()
    assert permissions.chart_scope(db, None) == set()


def test_the_charts_are_the_ones_built_on_the_granted_datasets():
    db = _DB([(11,), (12,)], [(101,), (102,)])

    assert permissions.chart_scope(db, {"dataset_ids": [111]}) == {101, 102}


# ── what a context with charts but no report has to provide ─────────────────


def test_adopt_scope_names_the_charts_a_dashboard_would_have_named():
    """Without this the catalogue is a list of "Chart 412" with nothing to match.

    `chart_meta` is normally filled by `for_dashboard` walking tiles. Chat has no
    tiles, so the names come from the charts themselves.
    """
    ctx = ToolContext(db=_DB([_Chart(101, "Doanh thu theo danh mục")]),
                      dashboard=None, public_filters=[])

    ctx.adopt_scope({101}, [])

    assert ctx.allowed_chart_ids == {101}
    assert ctx.chart_meta[101]["name"] == "Doanh thu theo danh mục"
    # A custom title is a property of a TILE, and there is no tile here.
    assert ctx.chart_meta[101]["layout"] == {}


def test_adopt_scope_asks_nothing_when_there_are_no_charts():
    """A query that can only return something the caller discards is a query per
    turn for nothing."""
    ctx = ToolContext(db=_DB(), dashboard=None, public_filters=[])

    ctx.adopt_scope(set(), [])

    assert ctx.allowed_chart_ids == set()
    assert ctx.chart_meta == {}


def test_adopt_scope_keeps_meta_it_was_already_given():
    """A context that DID come from a dashboard keeps the tile's custom title,
    which is the name the viewer actually sees."""
    ctx = ToolContext(db=_DB([_Chart(101, "chart_raw_name")]),
                      dashboard=None, public_filters=[])
    ctx.chart_meta[101] = {"name": "Tên trên tile", "fields": {}}

    ctx.adopt_scope({101}, [])

    assert ctx.chart_meta[101]["name"] == "Tên trên tile"


def test_listing_charts_works_with_no_report_open():
    """THE CRASH THAT READ AS "I COULD NOT FIND THAT FIGURE".

    `ctx.dashboard.name` raised AttributeError inside `search_business_assets`,
    which caught it, logged a warning and returned documents only. Nothing in the
    answer said a tool had failed.
    """
    ctx = ToolContext(db=None, dashboard=None, public_filters=[])
    ctx.allowed_chart_ids = {101}
    ctx.chart_meta[101] = {
        "name": "Doanh thu theo danh mục",
        "chart_type": "bar",
        "description": "",
        "layout": {},
        "fields": {"measures": [], "dimensions": [], "label_by_field": {}},
    }

    out = tool_list_charts(ctx, {})

    assert out["ok"] is True
    assert out["data"]["dashboard_name"] == ""
    assert [c["chart_id"] for c in out["data"]["charts"]] == [101]


def test_a_question_can_find_a_chart_with_no_report_open():
    """`list_charts(query=...)` scores against `chart_meta`, so the names
    `adopt_scope` loads are what makes searching possible at all."""
    ctx = ToolContext(db=None, dashboard=None, public_filters=[])
    ctx.allowed_chart_ids = {101, 102}
    for cid, name in ((101, "Doanh thu theo danh mục"), (102, "Giao đúng hẹn")):
        ctx.chart_meta[cid] = {
            "name": name, "chart_type": "bar", "description": "", "layout": {},
            "fields": {"measures": [], "dimensions": [], "label_by_field": {}},
        }

    out = tool_list_charts(ctx, {"query": "danh muc"})

    assert out["ok"] is True
    assert out["data"]["charts"][0]["chart_id"] == 101
