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

    # The disclosure's chart count joins and groups; a query stub that only knows
    # `.filter().all()` would make that path unreachable from a test, which is the
    # path most worth pinning.
    def join(self, *_a, **_k):
        return self

    def group_by(self, *_a):
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


# ── what the model is actually told ─────────────────────────────────────────


def test_the_base_prompt_stops_claiming_there_is_a_dashboard():
    """THE 95%.

    Measured on a real chat step, the base prompt was 9,024 of the 9,459
    characters the model read. The report base opens "You are an AI Data Analyst
    embedded in a published BI dashboard", says the data is "already loaded for you
    below", and states that filters bind every query — three sentences that are
    false with no report, in the text that is almost everything the step is told.
    """
    from app.services.dashboard_ai_bot.thinking.prompts import build_agent_system_prompt

    chat = build_agent_system_prompt(
        dashboard_name="", dashboard_description=None, chart_count=184,
        filters_applied=[], max_tool_calls=8, include_tools=False, surface="chat",
    )

    assert "published BI dashboard" not in chat
    assert "already loaded for you" not in chat
    assert "Charts you may measure: 184" in chat
    # The two things that ARE true and that the step has to act on.
    assert "every figure you give must" in chat
    assert "WHICH of them a question is about" in chat


def test_the_report_prompt_is_untouched_by_default():
    """Every existing caller passes no `surface`, and must get exactly what it
    always got."""
    from app.services.dashboard_ai_bot.thinking.prompts import build_agent_system_prompt

    kw = dict(dashboard_name="Olist", dashboard_description="x", chart_count=70,
              filters_applied=[], max_tool_calls=8, include_tools=False)

    assert build_agent_system_prompt(**kw) == build_agent_system_prompt(**kw, surface="report")
    assert "published BI dashboard" in build_agent_system_prompt(**kw)


def test_a_chat_turn_is_given_a_base_prompt_at_all():
    """It was given NONE. `chat_api` calls `run_for_chat_thread` without one, so
    `base_system_prompt` defaulted to "" and the citation contract, the
    answer-in-the-viewer's-language rule and the analysis guardrails were all
    absent — on the surface with the least other structure holding an answer down.
    """
    from app.services.agent_flows.dispatch import chat_base_prompt

    ctx = ToolContext(db=None, dashboard=None, public_filters=[])
    ctx.allowed_chart_ids = {1, 2, 3}

    prompt = chat_base_prompt(ctx)

    assert "Charts you may measure: 3" in prompt
    assert "published BI dashboard" not in prompt
    assert len(prompt) > 1000


# ── what sharing this flow lends, said out loud ─────────────────────────────


class _Src:
    def __init__(self, source, ref):
        self.source, self.ref = source, ref


class _Flow:
    def __init__(self, sources):
        self._sources = sources

    def bound_sources(self):
        return self._sources


def test_the_disclosure_names_sources_instead_of_numbering_them():
    """A DISCLOSURE NOBODY CAN READ DISCLOSES NOTHING.

    It used to return `{"label": "Bộ dữ liệu", "ref": "111"}`. True, and useless on
    a share dialog: nobody approving a share knows what dataset 111 is, so the
    delegation was technically stated and practically hidden.
    """
    flow = _Flow([_Src("semantic", "111"), _Src("document", "7")])
    # Names first (documents, then datasets), then the chart count — the order
    # `share_disclosure` asks in.
    db = _DB([(7, "Quy ước GMV")], [(111, "Olist E-Commerce")], [(111, 184)])

    rows = permissions.share_disclosure(flow, db)

    by_ref = {r["ref"]: r for r in rows}
    assert by_ref["111"]["name"] == "Olist E-Commerce"
    assert by_ref["7"]["name"] == "Quy ước GMV"


def test_the_disclosure_states_how_far_a_dataset_reaches():
    """Attaching a dataset now grants the charts built on it — 184 across 8 reports
    for this one. The person clicking Share is who should see that number."""
    flow = _Flow([_Src("semantic", "111")])
    db = _DB([(111, "Olist E-Commerce")], [(111, 184)])

    row = permissions.share_disclosure(flow, db)[0]

    assert row["reach"] == "184 biểu đồ"


def test_a_disclosure_without_a_session_still_lists_every_source():
    """Names are an improvement, not a precondition. Dropping a source because its
    title could not be looked up would hide a delegation — the one outcome this
    function exists to prevent."""
    flow = _Flow([_Src("semantic", "111"), _Src("metric", "gmv")])

    rows = permissions.share_disclosure(flow)

    assert [r["ref"] for r in rows] == ["111", "gmv"]
    assert all(r["name"] for r in rows)


# ── the argument the model was being steered at ─────────────────────────────


def test_resolve_chart_candidates_offers_measure_before_metric():
    """THE DEFAULT CALL HAD TO BE THE ONE THAT CAN WORK.

    `metric` is refused outright unless that exact name is registered in the
    Metrics Dictionary — measured on this deployment, where nothing is registered,
    every `metric` call failed with "metric 'GMV' is not defined" while the same
    question answered correctly through `measure`. The chat seed grants this tool
    by default, so a new chat flow's first move was the one call that cannot
    succeed.

    Schema order is what a model reads as "the normal way to call this", so the
    order is the fix, not a comment.
    """
    from app.services.agent_flows.tools import registry as R

    spec = next(t for p in R.packs() for t in p.tools
                if t.name == "resolve_chart_candidates")
    props = list(spec.definition["input_schema"]["properties"])

    assert props.index("measure") < props.index("metric")
    assert "PREFERRED" in spec.definition["input_schema"]["properties"]["measure"]["description"]
    # And the prose must say which one to reach for, not just describe both.
    assert "PASS `measure`" in spec.definition["description"]
