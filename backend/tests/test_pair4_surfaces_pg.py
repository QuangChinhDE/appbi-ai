"""Pair #4 — ChartService ↔ Dashboard / Public / Embed / Export / AI, executed.

The Semantic Kernel (Pairs #1–#3, Kernel Contract v1) owns business truth; a
surface may format, paginate, render and withhold internal debug — never
recompute a different truth. This module asks the Kernel v1 golden requests
(tests/pair2_topology.py, tests/foundation_corpus.py — hand-computed oracles)
THROUGH every consuming surface on a real Postgres datasource and a real
dashboard + public link:

  authenticated chart data   GET  /charts/{id}/data            (the dashboard tile)
  public single chart        GET  /public/dashboards/{t}/charts/{id}/data
                                  (/d, /embed and the PDF worker's page)
  public batch               POST /public/dashboards/{t}/charts/data
  public slicer options      GET  /public/dashboards/{t}/filters/distinct-values
  AI chart read              agent_flows.tools.context._fetch_chart_data
                                  (every dashboard / public AI tool)
  AI chart preview           POST /charts/ai-preview

and proves: same rows or the same refusal category; a soft drop observable
without leaking topology; authoritative constraints fail closed everywhere;
per-tile batch isolation; cache identity per link scope; the AI never told a
dropped filter applied, never a number after a refusal.
"""
from __future__ import annotations

import datetime
import json
import uuid

import pytest

from tests import foundation_corpus as F
from tests import pair2_topology as T
from tests.pair3_world import chart_config, chart_world, own_with_datasource, runtime_filters, save_chart
from tests.test_pair2_golden_topology_pg import _norm
from tests.test_pair3_chartservice_pg import (  # noqa: F401 — fixtures
    _pg_config,
    http,
    no_result_cache,
    pg,
    real_cache,
)
from tests.test_pair3_chartservice_pg import _NoClose
from tests.test_pair3_chartservice_pg import expect as chart_expect

ALL = T.CASES + T.TOP_N + F.CASES + F.EXECUTED_REFUSALS + F.SOFT_DROP_CASES
BY_ID = {c[0]: c for c in ALL}


# ── a real dashboard + public links over one chart world ─────────────────────

_WORLD: dict = {}


@pytest.fixture(autouse=True)
def batch_on_the_world_session(monkeypatch):
    """The public batch fans tiles out to worker threads, each on its own
    SessionLocal(): here they read the world's (rolled-back) session, one at a
    time (a Session is not thread-safe)."""
    import app.core.database as _database
    from app.services import dataset_model_service, snapshot_service
    from app.services.chart_service import ChartService

    real = ChartService.get_charts_data_batch

    def serial(items, *a, **k):
        k["max_workers"] = 1
        original = _database.SessionLocal
        _database.SessionLocal = lambda: _NoClose(_WORLD["db"])
        try:
            return real(items, *a, **k)
        finally:
            _database.SessionLocal = original

    monkeypatch.setattr(ChartService, "get_charts_data_batch", staticmethod(serial))
    # background self-heal / warm-up threads open their own sessions: off here
    monkeypatch.setattr(dataset_model_service, "schedule_model_drift_check", lambda *_a, **_k: None)
    for name in ("schedule_source_change_check", "trigger_async_refresh"):
        if hasattr(snapshot_service, name):
            monkeypatch.setattr(snapshot_service, name, lambda *_a, **_k: None)
    yield
    _WORLD.clear()


def _dashboard(w, tiles, *, slicer_fields=(), filters_config=None, pages_config=None, links=(("plain", [], {}),)):
    """tiles: [(chart, page_id or None)]; links: [(suffix, filters_config, appearance)] → {suffix: token}."""
    from app.models.models import Dashboard, DashboardChart, DashboardPublicLink

    _WORLD["db"] = w.db
    tag = uuid.uuid4().hex[:8]
    d = Dashboard(name=f"p4 {tag}", filters_config=filters_config or [], pages_config=pages_config or [],
                  slicers_config=[{"field": f, "semanticField": f, "datasetId": w.dataset.id} for f in slicer_fields])
    w.db.add(d)
    w.db.flush()
    for i, (chart, page) in enumerate(tiles):
        layout = {"x": 0, "y": i * 4, "w": 6, "h": 4, **({"pageId": page} if page else {})}
        w.db.add(DashboardChart(dashboard_id=d.id, chart_id=chart.id, widget_type="chart", layout=layout))
    tokens = {}
    for suffix, cfg, appearance in links:
        tok = f"p4-{tag}-{suffix}"
        w.db.add(DashboardPublicLink(dashboard_id=d.id, name=suffix, token=tok, is_active=True,
                                     filters_config=cfg, appearance_config=appearance or {}))
        tokens[suffix] = tok
    w.db.flush()
    return d, tokens


def _viewer(req):
    """A Kernel request's filters as the viewer's runtime filter list."""
    return runtime_filters(req)


def _rows_outcome(resp, req):
    if resp.status_code != 200:
        return "error", resp.headers.get("X-AppBI-Refusal") or T.REFUSED, resp.text
    body = resp.json()
    return "rows", body["data"], body.get("debug") or {}


def ask_auth(client, w, chart, req):
    params = {"filters": json.dumps(_viewer(req))} if req.get("filters") else {}
    return _rows_outcome(client.get(f"/api/v1/charts/{chart.id}/data", params=params), req)


def ask_public(client, token, chart, req, *, page=None):
    params = {"filters": json.dumps(_viewer(req))} if req.get("filters") else {}
    if page:
        params["page_id"] = page
    return _rows_outcome(client.get(f"/api/v1/public/dashboards/{token}/charts/{chart.id}/data", params=params), req)


def ask_public_batch(client, token, items, *, page=None):
    """items: [(chart, req)] → {chart_id: outcome}."""
    body = {"items": [{"chart_id": c.id, "filters": _viewer(r) or None} for c, r in items]}
    if page:
        body["page_id"] = page
    resp = client.post(f"/api/v1/public/dashboards/{token}/charts/data", json=body)
    assert resp.status_code == 200, resp.text
    out = {}
    for item in resp.json()["results"]:
        if "data" in item:
            out[item["chart_id"]] = ("rows", item["data"]["data"], item["data"].get("debug") or {})
        else:
            out[item["chart_id"]] = ("error", item.get("category") or T.REFUSED, item)
    return out


def ai_context(w, dash, token_cfg, req, *, appearance=None):
    """The ToolContext a public AI endpoint builds for this link + viewer."""
    from app.api.public import (
        _build_public_chart_filters,
        _public_page_scope_by_chart,
        _resolve_public_snapshot_ttl,
        _viewer_allowed,
    )
    from app.services.dashboard_ai_bot.tool_context import ToolContext

    combined = _build_public_chart_filters(dash, token_cfg, _viewer(req), context_for_log="p4-ai")
    return ToolContext.from_dashboard(
        db=w.db, dashboard=dash, public_filters=combined,
        page_scope_by_chart=_public_page_scope_by_chart(dash, token_cfg),
        exposed_fields=_viewer_allowed(dash, token_cfg),
        snapshot_ttl_minutes=_resolve_public_snapshot_ttl(appearance),
    )


def ask_ai(w, dash, token_cfg, chart, req):
    from app.services.agent_flows.tools.context import _fetch_chart_data

    ctx = ai_context(w, dash, token_cfg, req)
    try:
        payload = _fetch_chart_data(ctx, chart.id)
    except Exception as exc:  # noqa: BLE001 — a refusal / failure is the outcome
        from app.services.chart_service import refusal_category

        cat = refusal_category(exc)
        if cat:
            return "error", str(cat), exc
        if isinstance(exc, ValueError):
            return "error", T.REFUSED, exc
        raise
    rows = [dict(zip(payload["columns"], r)) for r in payload["rows"]]
    return "rows", rows, payload


# ── S1 / S2 / S7 — one chart, one meaning, on every surface ──────────────────

SURFACE_CORPUS = [
    # numeric (Kernel v1 FZ-1 / FZ-2)
    "F4.int_div_int.by_grp", "F4.avg_int.by_grp", "F4.count_distinct.kpi", "F4.zero_denominator.kpi",
    # relationships / roles / grain
    "G2.kpi_region_filter", "G7.kpi_ship_year_filter", "G6.kpi_three_facts", "G8.kpi_region_filter",
    "G9.kpi_vip", "G2.measure_filter_related_kpi",
    # NULL contract
    "G1.kpi_customer_name_is_null", "G1.kpi_customer_name_is_not_null",
    # Top-N (order is contractual)
    "G1.top2_customers",
    # refusals
    "G3.by_region", "G14.lattice_select", "G6.by_stage_two_facts", "G2.modifier_all_refused",
    "F7.cross_view_formula.kpi",
]
SURFACES = ["auth", "public", "public_batch", "ai"]


def _ask(surface, client, w, dash, tokens, chart, req):
    if surface == "auth":
        return ask_auth(client, w, chart, req)
    if surface == "public":
        return ask_public(client, tokens["plain"], chart, req)
    if surface == "public_batch":
        return ask_public_batch(client, tokens["plain"], [(chart, req)])[chart.id]
    return ask_ai(w, dash, [], chart, req)


def _matrix(ids, surfaces):
    return [(c, s) for c in ids for s in surfaces]


@pytest.mark.parametrize("case_id,surface", _matrix(SURFACE_CORPUS, SURFACES),
                         ids=[f"{c}@{s}" for c, s in _matrix(SURFACE_CORPUS, SURFACES)])
def test_one_chart_has_one_meaning_on_every_surface(pg, http, case_id, surface):
    client, holder = http
    _id, model, base, req, expected = BY_ID[case_id]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, base, req)
        dash, tokens = _dashboard(w, [(chart, None)], slicer_fields=list((req.get("filters") or {}).keys()))
        chart_expect(_ask(surface, client, w, dash, tokens, chart, req), req, expected,
                     ordered=case_id.startswith(("G1.top", "G6.top", "G11.")))


# ── S3 — authoritative constraints fail closed on every public-like surface ──

def _lock(field, value, **kw):
    return {"field": field, "semanticField": field, "operator": "eq", "value": value, **kw}


def test_a_related_link_lock_is_applied_on_every_surface(pg, http):
    """🔒 region = North on the snowflake (sales → customers → regions): 130."""
    client, holder = http
    req = {"dims": [], "measures": ["p2_sales.revenue"]}
    lock = [_lock("p2_regions.name", "North")]
    with chart_world(pg, "G2_snowflake", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_sales", req)
        dash, tokens = _dashboard(w, [(chart, None)], links=(("locked", lock, {}),))
        for outcome in (ask_public(client, tokens["locked"], chart, req),
                        ask_public_batch(client, tokens["locked"], [(chart, req)])[chart.id],
                        ask_ai(w, dash, lock, chart, req)):
            chart_expect(outcome, req, [{"p2_sales.revenue": 130}])


def _other_dataset(w):
    """A second dataset on the same report: one table, one view of its own."""
    from app.models.dataset import Dataset, DatasetTable
    from app.models.semantic import SemanticView

    tag = uuid.uuid4().hex[:8]
    other = Dataset(name=f"p4_other_{tag}")
    w.db.add(other)
    w.db.flush()
    src = w.tables["p2_sales"]
    dt = DatasetTable(dataset_id=other.id, datasource_id=w.ds.id, source_kind="physical_table",
                      source_table_name=src.source_table_name, display_name=f"p4_other_{tag}",
                      columns_cache=src.columns_cache, enabled=True)
    w.db.add(dt)
    w.db.flush()
    view = SemanticView(name=f"p4_other_{tag}", dataset_table_id=dt.id, sql_table_name=src.source_table_name,
                        dimensions=[{"name": "region", "type": "string", "sql": "region"}], measures=[])
    w.db.add(view)
    w.db.flush()
    from app.models.models import Chart, ChartType

    tile = Chart(name=f"p4 other tile {tag}", dataset_table_id=dt.id, chart_type=ChartType("TABLE"),
                 config={"roleConfig": {"selectedColumns": [f"{view.name}.region"]}})
    w.db.add(tile)
    w.db.flush()
    return other, view.name, tile


@pytest.mark.parametrize("mode", ["visible", "locked"])
def test_a_filter_of_another_dataset_does_not_apply_to_this_chart(pg, http, mode):
    """P7 — a report over two datasets (a tile of A, a tile of B): a dashboard
    filter (ordinary or 🔒) of dataset B is B's tile's filter; A's tile answers
    its own 198 on the tile, the batch and the AI (told the filter did NOT
    apply) — it was REFUSED (dataset_mismatch / AUTHORITATIVE_NOT_APPLIED),
    every tile of A. A's own 🔒 still applies (130). It fails closed — never 198
    — for a lock on A's field carrying B's id, and for a lock of B on a report
    with NO tile of B (left behind when the charts moved to A)."""
    client, holder = http
    req = {"dims": [], "measures": ["p2_sales.revenue"]}
    with chart_world(pg, "G2_snowflake", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_sales", req)
        other, other_view, other_tile = _other_dataset(w)
        foreign = _lock(f"{other_view}.region", "X", datasetId=other.id, publicMode=mode)
        own = _lock("p2_regions.name", "North", datasetId=w.dataset.id, publicMode="locked")
        tiles = [(chart, None), (other_tile, None)]

        def every_surface(dash, tokens):
            return [ask_public(client, tokens["plain"], chart, req),
                    ask_public_batch(client, tokens["plain"], [(chart, req)])[chart.id],
                    ask_ai(w, dash, [], chart, req)]

        def refused_everywhere(dash, tokens):
            for kind, cat, _ in every_surface(dash, tokens):
                assert kind == "error", (mode, cat)
                if mode == "locked":
                    assert cat == "AUTHORITATIVE_NOT_APPLIED", (cat, _)

        dash, tokens = _dashboard(w, tiles, filters_config=[foreign])
        outcomes = every_surface(dash, tokens)
        for outcome in outcomes:
            chart_expect(outcome, req, [{"p2_sales.revenue": 198}])
        ai_payload = outcomes[2][2]
        assert not ai_payload["filters_applied"], ai_payload
        assert [f.get("semanticField") for f in ai_payload.get("filters_not_applied", [])] == [foreign["semanticField"]]
        dash, tokens = _dashboard(w, tiles, filters_config=[foreign, own])
        for outcome in every_surface(dash, tokens):
            chart_expect(outcome, req, [{"p2_sales.revenue": 130}])
        # A's own field named with B's id: not provably B's — the engine refuses it
        stale = _lock("p2_regions.name", "North", datasetId=other.id, publicMode=mode)
        refused_everywhere(*_dashboard(w, tiles, filters_config=[stale]))
        # B's filter on a report with no tile of B: it bounds nothing here — refused, never lifted
        refused_everywhere(*_dashboard(w, [(chart, None)], filters_config=[foreign]))


@pytest.mark.parametrize("mode", ["visible", "locked", "hidden"])
def test_a_page_bound_is_applied_scoped_out_or_refused_never_skipped(pg, http, mode):
    """P4-C1 — a page filter (server-owned, every publicMode) is exactly one of:
    APPLIED (its own dataset: North 130), SCOPED OUT (provably another tile's
    dataset: 198), REFUSED. A page bound on the chart's OWN field whose stored
    datasetId is stale (another dataset, a deleted one) was skipped — the
    viewer got 198, every region, and the slicer offered South. Now it refuses
    on the tile, the batch and the AI, and the slicer offers nothing (restricted)."""
    client, holder = http
    req = {"dims": [], "measures": ["p2_sales.revenue"]}
    url = "/api/v1/public/dashboards/{}/filters/distinct-values"
    with chart_world(pg, "G2_snowflake", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_sales", req)
        other, other_view, other_tile = _other_dataset(w)
        slicer = {"dataset_id": w.dataset.id, "field": "p2_regions.name", "limit": 50, "page_id": "p1"}

        def on_page(filters, tiles=((chart, "p1"),)):
            dash, tokens = _dashboard(w, list(tiles), slicer_fields=["p2_regions.name"],
                                      pages_config=[{"id": "p1", "filters": filters}])
            outcomes = [ask_public(client, tokens["plain"], chart, req, page="p1"),
                        ask_public_batch(client, tokens["plain"], [(chart, req)], page="p1")[chart.id],
                        ask_ai(w, dash, [], chart, req)]
            options = client.get(url.format(tokens["plain"]), params=slicer).json()
            return outcomes, options

        own = _lock("p2_regions.name", "North", publicMode=mode)
        outcomes, options = on_page([{**own, "datasetId": w.dataset.id}])
        for outcome in outcomes:
            chart_expect(outcome, req, [{"p2_sales.revenue": 130}])
        assert options["values"] == ["North"], options
        for stale_id in (other.id, other.id + 10_000_000):     # another dataset / a deleted one
            for tiles in (((chart, "p1"),), ((chart, "p1"), (other_tile, "p1"))):
                outcomes, options = on_page([{**own, "datasetId": stale_id}], tiles)
                for kind, cat, _ in outcomes:
                    assert kind == "error" and cat == "AUTHORITATIVE_NOT_APPLIED", (stale_id, len(tiles), cat)
                assert options["values"] == [] and options.get("restricted") is True, options
        # B's page filter on B's view, with a tile of B on the report: B's bound, not A's
        foreign = _lock(f"{other_view}.region", "X", datasetId=other.id, publicMode=mode)
        outcomes, options = on_page([foreign], ((chart, "p1"), (other_tile, "p1")))
        for outcome in outcomes:
            chart_expect(outcome, req, [{"p2_sales.revenue": 198}])
        assert sorted(options["values"]) == ["North", "South"], options
        # ... and with no tile of B on the report it bounds nothing here: refused, never lifted
        outcomes, _options = on_page([foreign])
        for kind, cat, _ in outcomes:
            assert kind == "error" and cat == "AUTHORITATIVE_NOT_APPLIED", cat


def test_the_studio_link_test_reads_what_that_links_viewers_read(pg, http, monkeypatch):
    """P4-C2 — Agent Flow Studio "Test" on a link runs the flow ON that link.
    North-only link: 130, South-only link: 61 — the numbers the live link's
    tile (and its chatbot) give; the unrestricted author view is 198. It ran
    with no link filter, so every link's test answered 198. The flow itself is
    stubbed at `run_preview` (no model call): what is asserted is the data
    contract the run is handed."""
    import asyncio

    from app.models.agent_brain import AgentBrainVersion
    from app.modules.agent_flows import api as af_api
    from app.services.agent_flows import dispatch
    from app.services.agent_flows.tools.context import _fetch_chart_data

    client, holder = http
    req = {"dims": [], "measures": ["p2_sales.revenue"]}
    with chart_world(pg, "G2_snowflake", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_sales", req)
        dash, tokens = _dashboard(w, [(chart, None)], links=(
            ("north", [_lock("p2_regions.name", "North")], {"cache_ttl_minutes": 0}),
            ("south", [_lock("p2_regions.name", "South")], {}),
        ))
        key = f"p4-flow-{uuid.uuid4().hex[:6]}"
        w.db.add(AgentBrainVersion(brain_key=key, version=1, name="p4 flow", status="draft", body={}))
        w.db.flush()
        from app.models.models import DashboardPublicLink

        links = {s: w.db.query(DashboardPublicLink).filter_by(token=t).one() for s, t in tokens.items()}
        seen: dict = {}

        async def fake_run_preview(db, *, ctx, **_kw):
            seen["ctx"] = ctx
            yield types_ns(type="result", extra={"envelope": {"answer": "stub"}, "run_row_id": None})

        def types_ns(**kw):
            import types
            return types.SimpleNamespace(**kw)

        monkeypatch.setattr(dispatch, "run_preview", fake_run_preview)
        monkeypatch.setattr(af_api, "_may_edit_flow", lambda *_a, **_k: None)
        monkeypatch.setattr(af_api, "_require_keys", lambda *_a, **_k: None)
        monkeypatch.setattr(af_api.binding_service, "get_for_link", lambda *_a, **_k: object())
        monkeypatch.setattr(af_api.reg, "get_brain", lambda *_a, **_k: {"version": 1})
        monkeypatch.setattr(af_api.reg, "parse_flow", lambda _row: object())
        author = types_ns(id=uuid.UUID(int=7), email="author@p4", full_name="author")
        expected = {"north": 130, "south": 61}
        for suffix, link in links.items():
            monkeypatch.setattr(af_api, "_link_and_dashboard", lambda *_a, _l=link, **_k: (_l, dash))
            body = af_api.TestBody(question="tổng doanh thu?", link_id=link.id)
            out = asyncio.run(af_api.test_flow(key, body, db=w.db, user=author))
            assert out["envelope"] == {"answer": "stub"}, out
            read = _fetch_chart_data(seen["ctx"], chart.id)
            assert [dict(zip(read["columns"], r)) for r in read["rows"]] == [{"p2_sales.revenue": expected[suffix]}]
            # = the live link's own tile
            chart_expect(ask_public(client, tokens[suffix], chart, req), req, [{"p2_sales.revenue": expected[suffix]}])
            from app.api.public import _resolve_public_snapshot_ttl

            assert seen["ctx"].snapshot_ttl_minutes == _resolve_public_snapshot_ttl(link.appearance_config)
        # the author's own, unrestricted read is a different contract (test-on-report): 198
        chart_expect(ask_auth(client, w, chart, req), req, [{"p2_sales.revenue": 198}])


@pytest.mark.parametrize("mode", ["locked", "hidden"])
def test_an_unappliable_link_lock_refuses_never_widens(pg, http, mode):
    """deals.stage is unreachable from revenue (single-direction): an ordinary
    pick is soft-dropped, a 🔒 / 🚫 lock REFUSES — on the tile, the batch, the
    AI and the slicer (offers nothing) — never the unfiltered 180."""
    client, holder = http
    req = {"dims": [], "measures": ["p2_revenue.amount"]}
    lock = [_lock("p2_deals.stage", "Won", **({"hidden": True} if mode == "hidden" else {}))]
    with chart_world(pg, "G5_galaxy_single", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_revenue", req)
        dash, tokens = _dashboard(w, [(chart, None)], slicer_fields=["p2_revenue.owner_id"],
                                  links=((mode, lock, {}),))
        single = client.get(f"/api/v1/public/dashboards/{tokens[mode]}/charts/{chart.id}/data")
        assert single.status_code == 400, single.text
        assert single.headers.get("X-AppBI-Refusal") == "AUTHORITATIVE_NOT_APPLIED", single.headers
        if mode == "hidden":
            assert "Won" not in single.text and "stage" not in single.text.lower(), single.text
        kind, cat, _ = ask_public_batch(client, tokens[mode], [(chart, req)])[chart.id]
        assert (kind, cat) == ("error", "AUTHORITATIVE_NOT_APPLIED")
        kind, cat, _ = ask_ai(w, dash, lock, chart, req)
        assert kind == "error", cat


# ── S4 — a public soft drop is observable, never silent, never a leak ─────────


def test_a_public_soft_drop_is_shown_to_the_viewer_without_internals(pg, http):
    client, holder = http
    _id, model, base, req, expected = BY_ID["G5.kpi_won_deals_single"]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, base, req)
        dash, tokens = _dashboard(w, [(chart, None)], slicer_fields=list(req["filters"]))
        for kind, rows, debug in (ask_public(client, tokens["plain"], chart, req),
                                  ask_public_batch(client, tokens["plain"], [(chart, req)])[chart.id]):
            chart_expect((kind, rows, debug), req, expected)   # rows AND the dropped field
            assert not debug.get("sql_emitted") and not debug.get("warnings"), debug
            for d in debug["dropped_filters"]:
                assert d["reason"] == "not_applicable" and "value" not in d, d
        # the AI is told the filter did NOT apply — never listed as applied
        kind, rows, payload = ask_ai(w, dash, [], chart, req)
        applied = {f.get("semanticField") or f.get("field") for f in payload["filters_applied"]}
        not_applied = {f.get("semanticField") or f.get("field") for f in payload.get("filters_not_applied", [])}
        assert set(expected["dropped"]) <= not_applied and not (set(expected["dropped"]) & applied), payload


# ── S5 — one tile's refusal / failure never corrupts another ──────────────────


def test_a_batch_keeps_every_tiles_own_outcome(pg, http):
    """One dashboard (role diamond): a correct tile, an AMBIGUOUS tile, a tile
    under an unappliable page bound (AUTHORITATIVE), a broken custom-SQL tile
    (a warehouse failure) — each its own outcome; the correct one unchanged."""
    client, holder = http
    ok_req = {"dims": ["p2_customers.name"], "measures": ["p2_sales.revenue"]}
    ok = BY_ID["G3.by_customer_region"]
    amb = BY_ID["G3.by_region"]
    with chart_world(pg, "G3_diamond", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        c_ok = save_chart(w, ok[2], ok[3])
        c_amb = save_chart(w, amb[2], amb[3])
        c_auth = save_chart(w, "p2_sales", ok_req)
        bad_cfg = {**chart_config(ok_req), "queryMode": "custom", "customSql": "SELECT * FROM p2g.no_such_table"}
        c_bad = save_chart(w, "p2_sales", ok_req, config=bad_cfg)
        pages = [{"id": "p1"}, {"id": "p2", "filters": [_lock("p2_owners.name", "Ann")]}]
        dash, tokens = _dashboard(w, [(c_ok, "p1"), (c_amb, "p1"), (c_bad, "p1"), (c_auth, "p2")],
                                  pages_config=pages)
        p1 = ask_public_batch(client, tokens["plain"], [(c_ok, ok[3]), (c_amb, amb[3]), (c_bad, ok_req)], page="p1")
        p2 = ask_public_batch(client, tokens["plain"], [(c_auth, ok_req)], page="p2")
        chart_expect(p1[c_ok.id], ok[3], ok[4])
        assert p1[c_amb.id][:2] == ("error", "AMBIGUOUS_ROUTE"), p1[c_amb.id]
        assert p1[c_bad.id][0] == "error" and p1[c_bad.id][1] not in ("AMBIGUOUS_ROUTE",), p1[c_bad.id]
        assert p2[c_auth.id][0] == "error", p2[c_auth.id]
        # the same correct tile alone: identical rows
        chart_expect(ask_public_batch(client, tokens["plain"], [(c_ok, ok[3])], page="p1")[c_ok.id], ok[3], ok[4])


# ── S6 — a slicer's options mean what the chart applies ───────────────────────

SLICER_CASES = [
    # (model, base, measure, slicer field, {option: expected KPI or refusal category})
    ("G2_snowflake", "p2_sales", "p2_sales.revenue", "p2_regions.name", {"North": 130, "South": 61}),
    ("G7_roles_main", "p2_sales", "p2_sales.revenue", "p2_sales__ship_date__date_dim.year", {2024: 150, 2025: 37}),
    ("G8_composite", "p2_c_sales", "p2_c_sales.amt", "p2_c_regions.label", {"North": 15}),
    ("G3_diamond", "p2_sales", "p2_sales.revenue", "p2_regions.name",
     {"North": "AMBIGUOUS_ROUTE", "South": "AMBIGUOUS_ROUTE"}),
]


@pytest.mark.parametrize("case", SLICER_CASES, ids=[f"{c[0]}:{c[3]}" for c in SLICER_CASES])
def test_a_slicer_option_means_what_the_chart_applies(pg, http, case):
    """Options are offered by the slicer endpoint; each one applied gives the
    hand-computed value (or the same refusal the chart gives with any value) —
    and a NULL member is never an option (the NULL contract)."""
    client, holder = http
    model, base, measure, field, expected = case
    req = {"dims": [], "measures": [measure]}
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, base, req)
        dash, tokens = _dashboard(w, [(chart, None)], slicer_fields=[field])
        r = client.get(f"/api/v1/public/dashboards/{tokens['plain']}/filters/distinct-values",
                       params={"dataset_id": w.dataset.id, "field": field, "limit": 50})
        assert r.status_code == 200, r.text
        options = r.json()["values"]
        assert None not in options and "None" not in options, options
        for opt, want in expected.items():
            assert str(opt) in {str(o) for o in options}, (opt, options)
            applied = {**req, "filters": {field: [{"operator": "eq", "value": opt}]}}
            outcome = ask_public(client, tokens["plain"], chart, applied)
            if isinstance(want, str):
                assert outcome[:2] == ("error", want), outcome
            else:
                chart_expect(outcome, applied, [{measure: want}])


def test_a_single_direction_slicer_value_is_offered_and_its_skip_is_visible(pg, http):
    """deals.stage options exist (Won / Lost); applied to a revenue chart the
    filter cannot travel (single direction): the unfiltered 180 with the skip
    shown — the documented soft drop, never silent."""
    client, holder = http
    req = {"dims": [], "measures": ["p2_revenue.amount"]}
    with chart_world(pg, "G5_galaxy_single", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_revenue", req)
        dash, tokens = _dashboard(w, [(chart, None)], slicer_fields=["p2_deals.stage"])
        r = client.get(f"/api/v1/public/dashboards/{tokens['plain']}/filters/distinct-values",
                       params={"dataset_id": w.dataset.id, "field": "p2_deals.stage", "limit": 50})
        assert sorted(r.json()["values"]) == ["Lost", "Won"], r.json()
        applied = {**req, "filters": {"p2_deals.stage": [{"operator": "eq", "value": "Won"}]}}
        chart_expect(ask_public(client, tokens["plain"], chart, applied), applied,
                     {"rows": [{"p2_revenue.amount": 180}], "dropped": ["p2_deals.stage"]})


def test_a_locked_slicer_offers_only_members_every_route_admits(pg, http):
    """🔒 deals.stage = Lost on a revenue owner slicer: revenue reaches deals by
    TWO routes (the shared calendar, the shared owner). Only owner 1 has a Lost
    deal; owner 2 has revenue on a Lost deal's DATE. A pick takes the union of
    the routes (a member with data via ANY fact — the global-slicer rule), but a
    lock is a scope: offered only when EVERY route admits it — owner 1, never the
    union [1, 2], which one route alone admits."""
    client, holder = http
    req = {"dims": [], "measures": ["p2_revenue.amount"]}
    with chart_world(pg, "G5_galaxy_single", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_revenue", req)
        lock = [_lock("p2_deals.stage", "Lost")]
        dash, tokens = _dashboard(w, [(chart, None)], slicer_fields=["p2_revenue.owner_id", "p2_deals.stage"],
                                  links=(("locked", lock, {}), ("plain", [], {})))
        url = "/api/v1/public/dashboards/{}/filters/distinct-values"
        params = {"dataset_id": w.dataset.id, "field": "p2_revenue.owner_id", "limit": 50}
        body = client.get(url.format(tokens["locked"]), params=params).json()
        assert body["values"] == ["1"] and not body.get("restricted"), body
        # the same predicate as a viewer's pick keeps the any-route union
        pick = [{"field": "p2_deals.stage", "semanticField": "p2_deals.stage", "operator": "eq", "value": "Lost",
                 "datasetId": w.dataset.id}]
        body = client.get(url.format(tokens["plain"]), params={**params, "filters": json.dumps(pick)}).json()
        assert sorted(body["values"]) == ["1", "2"], body


def test_an_empty_slicer_says_why_restricted_or_unavailable(pg, http):
    """An empty option list is never ambiguous: a 🔒 the cascade cannot apply
    offers nothing and says ``restricted`` (never values outside the shared
    scope); a warehouse failure says ``unavailable`` (never "no values match")."""
    client, holder = http
    req = {"dims": [], "measures": ["p2_revenue.amount"]}
    with chart_world(pg, "G5_galaxy_single", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_revenue", req)
        lock = [_lock("p2_deals.no_such_column", "Lost")]
        dash, tokens = _dashboard(w, [(chart, None)], slicer_fields=["p2_revenue.owner_id"],
                                  links=(("locked", lock, {}), ("plain", [], {})))
        url = "/api/v1/public/dashboards/{}/filters/distinct-values"
        params = {"dataset_id": w.dataset.id, "field": "p2_revenue.owner_id", "limit": 50}
        body = client.get(url.format(tokens["locked"]), params=params).json()
        assert body["values"] == [] and body.get("restricted") is True, body
        assert "no_such_column" not in json.dumps(body), body
        body = client.get(url.format(tokens["plain"]), params=params).json()
        assert body["values"] and not body.get("restricted") and not body.get("unavailable"), body
        # the table behind the slicer is gone from the warehouse
        w.tables["p2_revenue"].source_table_name = f"{T.S}.p4_no_such_table"
        w.views["p2_revenue"].sql_table_name = f"{T.S}.p4_no_such_table"
        w.db.flush()
        body = client.get(url.format(tokens["plain"]), params=params).json()
        assert body["values"] == [] and body.get("unavailable") is True, body
        assert "p4_no_such_table" not in json.dumps(body), body


# ── S8 — the AI never turns a refusal into a number ──────────────────────────


def test_the_ai_tool_reports_a_refusal_as_unavailable_with_its_category(pg):
    from app.services.dashboard_ai_bot.thinking.tools import tool_get_chart_data

    _id, model, base, req, _expected = BY_ID["G3.by_region"]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        chart = save_chart(w, base, req)
        dash, _tokens = _dashboard(w, [(chart, None)])
        out = tool_get_chart_data(ai_context(w, dash, [], req), {"chart_id": chart.id})
        assert out.get("ok") is False and out.get("error_code") == "semantic_refusal:AMBIGUOUS_ROUTE", out
        assert "rows" not in out, out


def test_the_ai_never_averages_a_non_additive_measure_across_rows(pg):
    """avg_a is an AVERAGE (by grp: X 3, Y 3.5): its unweighted mean (3.25)
    happens to equal the overall here — but in general the mean of group
    averages is not the measure; it is refused, sum and avg alike."""
    from app.services.dashboard_ai_bot.thinking.advanced_tools import tool_aggregate_chart_data

    req = {"dims": [f"{F.B}.grp"], "measures": [f"{F.B}.avg_a"]}
    with chart_world(pg, F.M, ds_config=_pg_config()) as w:
        chart = save_chart(w, F.B, req)
        dash, _tokens = _dashboard(w, [(chart, None)])
        ctx = ai_context(w, dash, [], req)
        for op in ("sum", "avg"):
            out = tool_aggregate_chart_data(ctx, {"chart_id": chart.id, "group_by": [f"{F.B}.grp"],
                                                  "aggregations": [{"op": op, "column": f"{F.B}.avg_a"}]})
            assert out.get("ok") is False and "cannot" in out.get("error", ""), (op, out)


def test_the_ai_says_a_top_n_chart_holds_only_its_top_rows(pg):
    """G1 top-2 customers: the AI reads 2 rows and is told they are the top 2 —
    a total over them is the total of the top 2, never "all customers"."""
    from app.services.dashboard_ai_bot.thinking.advanced_tools import tool_aggregate_chart_data

    _id, model, base, req, expected = BY_ID["G1.top2_customers"]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        chart = save_chart(w, base, req)
        dash, _tokens = _dashboard(w, [(chart, None)])
        kind, rows, payload = ask_ai(w, dash, [], chart, req)
        assert kind == "rows" and payload.get("source_top_n") == 2, payload
        dim, measure = req["dims"][0], req["measures"][0]
        out = tool_aggregate_chart_data(ai_context(w, dash, [], req), {
            "chart_id": chart.id, "group_by": [dim], "aggregations": [{"op": "sum", "column": measure}]})
        assert out.get("ok") and out["data"]["coverage"].get("source_top_n") == 2, out


def test_an_ai_cached_chart_read_never_outlives_a_generation_or_a_freshness(pg):
    """The AI tool cache (process-wide, 5 min) and the summary epoch: a new
    snapshot generation of the dataset, or another link freshness, is another
    entry — never the answer read under the old generation / the other TTL."""
    from app.models.dataset import DatasetTableSnapshot
    from app.services.agent_flows.tools import registry
    from app.services.dashboard_ai_bot.summary_cache import semantic_epoch

    req = {"dims": [], "measures": ["p2_sales.revenue"]}
    args = {"chart_id": None}
    with chart_world(pg, "G2_snowflake", ds_config=_pg_config()) as w:
        chart = save_chart(w, "p2_sales", req)
        args["chart_id"] = chart.id
        dash, _tokens = _dashboard(w, [(chart, None)])
        key = lambda appearance=None: registry._cache_key(  # noqa: E731
            ai_context(w, dash, [], req, appearance=appearance), "get_chart_data", args)
        before, epoch = key(), semantic_epoch(w.db)
        assert key() == before and semantic_epoch(w.db) == epoch, "stable while nothing changes"
        assert key({"cache_ttl_minutes": 0}) != key({"cache_ttl_minutes": 45}) != before
        w.db.add(DatasetTableSnapshot(dataset_id=w.dataset.id, dataset_table_id=w.tables["p2_sales"].id,
                                      version=1, physical_ref="p4.snap_v1", fingerprint="f" * 64,
                                      status="ready", is_current=True, generation=1))
        w.db.flush()
        assert key() != before and semantic_epoch(w.db) != epoch


@pytest.mark.parametrize("ttl", [0, 45, -1])
def test_the_ai_reads_a_chart_with_its_links_freshness(pg, monkeypatch, ttl):
    """The AI on a public link reads at the link's snapshot TTL (Realtime / N
    minutes / Manual) — as the link's tile does; it read the default, so the AI
    could describe a snapshot the viewer's tile no longer shows (or the reverse)."""
    from app.api.public import _resolve_public_snapshot_ttl
    from app.services.agent_flows.tools.context import _fetch_chart_data
    from app.services.chart_service import ChartService

    seen = []
    real = ChartService.get_chart_data

    def spy(*a, **kw):
        seen.append(kw.get("snapshot_ttl_minutes", "absent"))
        return real(*a, **kw)

    monkeypatch.setattr(ChartService, "get_chart_data", staticmethod(spy))
    req = {"dims": [], "measures": ["p2_sales.revenue"]}
    with chart_world(pg, "G2_snowflake", ds_config=_pg_config()) as w:
        chart = save_chart(w, "p2_sales", req)
        dash, _tokens = _dashboard(w, [(chart, None)])
        appearance = {"cache_ttl_minutes": ttl}
        ctx = ai_context(w, dash, [], req, appearance=appearance)
        _fetch_chart_data(ctx, chart.id)
        assert seen == [_resolve_public_snapshot_ttl(appearance)], seen


# ── S9 — export renders the same public page and endpoints ────────────────────


def test_the_pdf_export_prints_the_public_page_with_the_same_filters():
    """The worker prints `/d/<token>?print=1&filters=<b64>` — the SAME page and
    therefore the same public endpoints proven above (no second data path)."""
    import base64
    from types import SimpleNamespace

    from app.scripts.pdf_worker import _render_url

    filters = [{"field": "p2_regions.name", "operator": "eq", "value": "North"}]
    url = _render_url(SimpleNamespace(params={"filters": filters, "layout": "snapshot"}, link_token="tok"), "p1")
    assert "/d/tok?" in url and "print=1" in url and "page=p1" in url, url
    enc = url.split("filters=")[1].split("&")[0]
    assert json.loads(base64.urlsafe_b64decode(enc + "=" * (-len(enc) % 4))) == filters


# ── S10 — a published dataset never mixes generations / live in one surface ──


def test_a_published_dataset_without_a_generation_blocks_every_tile_alike(pg, http):
    """A dataset under the publish lifecycle with nothing published: every
    public tile is BLOCKED (never one tile live and another blocked)."""
    client, holder = http
    reqs = [{"dims": [], "measures": ["p2_sales.revenue"]}, {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]}]
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        w.dataset.publish_state = "draft"
        w.db.flush()
        charts = [save_chart(w, "p2_sales", r) for r in reqs]
        dash, tokens = _dashboard(w, [(c, None) for c in charts])
        out = ask_public_batch(client, tokens["plain"], list(zip(charts, reqs)))
        assert all(o[0] == "error" for o in out.values()), out


def _two_generations(w, monkeypatch):
    """The dataset published at generation 1, generation 2 fully built (a
    publish about to flip the pointer). Snapshot execution is redirected to the
    live source — what is under test is WHICH generation each tile is planned on."""
    import dataclasses
    import types

    from app.models.dataset import DatasetTableSnapshot
    from app.services import chart_service as cs
    from app.services import snapshot_service

    w.dataset.publish_state = "published"
    w.dataset.published_generation = 1
    rows = {}
    for gen in (1, 2):
        for name, t in w.tables.items():
            rows[(gen, name)] = DatasetTableSnapshot(
                dataset_id=w.dataset.id, dataset_table_id=t.id, version=gen, generation=gen,
                physical_ref=f"p4.snap_{t.id}_g{gen}", fingerprint="f" * 64, status="ready",
                is_current=(gen == 1), built_at=datetime.datetime(2026, 1, gen))
            w.db.add(rows[(gen, name)])
    w.db.flush()
    monkeypatch.setattr(snapshot_service, "host_for_generation", lambda *_a, **_k: types.SimpleNamespace(id=4242, config={}))
    from app.services.datasource_service import DataSourceConnectionService

    monkeypatch.setattr(DataSourceConnectionService, "snapshot_query_config", staticmethod(lambda cfg: {"host": True}))
    planned: list = []
    real = cs.plan_chart_execution

    def plan_then_run_live(*a, **kw):
        plan = real(*a, **kw)
        planned.append((plan.generation, plan.blocked))
        if plan.blocked:
            return plan
        return dataclasses.replace(plan, mode="live", dialect="", ds_type="", exec_config=None, overrides={},
                                   published=False, cred="source_datasource")

    monkeypatch.setattr(cs, "plan_chart_execution", plan_then_run_live)
    return planned, rows


def test_one_read_of_a_dashboard_sees_one_generation(pg, http, monkeypatch):
    """P4-C3 — the generation contract: ONE logical read (a public page batch,
    an AI turn) is served ONE published generation per dataset. A publish that
    flips the pointer 1 → 2 between two tiles of the same batch used to draw the
    second tile from 2 under the page's single "data as of" label. Now both
    come from 1; separate reads each take the current one and SAY which
    (snapshot_generation on every public tile). A pinned generation that is no
    longer servable refuses the tile — never silently swaps to the other."""
    client, holder = http
    reqs = [{"dims": [], "measures": ["p2_sales.revenue"]},
            {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]}]
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        charts = [save_chart(w, "p2_sales", r) for r in reqs]
        dash, tokens = _dashboard(w, [(c, None) for c in charts])
        planned, rows = _two_generations(w, monkeypatch)
        from app.services import snapshot_service

        real_refs = snapshot_service.resolve_specific_generation_refs
        flip = {"after": 1, "retire_old": False}

        def refs_then_publish(db, ids, gen):
            out = real_refs(db, ids, gen)
            flip["after"] -= 1
            if flip["after"] == 0:          # a publish lands right after the first tile planned
                w.dataset.published_generation = 2
                for (g, _n), r in rows.items():
                    r.status = "superseded" if g == 1 else "ready"
                    if g == 1 and flip["retire_old"]:
                        r.retired_at = datetime.datetime(2026, 1, 3)
                w.db.flush()
            return out

        monkeypatch.setattr(snapshot_service, "resolve_specific_generation_refs", refs_then_publish)
        out = ask_public_batch(client, tokens["plain"], list(zip(charts, reqs)))
        assert [g for g, _b in planned] == [1, 1], planned
        assert {o[2].get("snapshot_generation") for o in out.values()} == {1}, out
        assert all(o[0] == "rows" for o in out.values()), out
        # separate reads: each takes the current generation, and says which
        planned.clear()
        _k, _r, debug = ask_public(client, tokens["plain"], charts[0], reqs[0])
        assert debug.get("snapshot_generation") == 2 and debug.get("snapshot_dataset_id") == w.dataset.id, debug
        # an AI turn is one read too
        planned.clear()
        w.dataset.published_generation = 1
        for (g, _n), r in rows.items():
            r.status = "ready"
        w.db.flush()
        flip["after"] = 1
        ctx = ai_context(w, dash, [], reqs[0])
        from app.services.agent_flows.tools.context import _fetch_chart_data

        _fetch_chart_data(ctx, charts[0].id)
        _fetch_chart_data(ctx, charts[1].id)
        assert [g for g, _b in planned] == [1, 1], planned
        # the pinned generation is gone mid-read (retired): the tile refuses, it is never served gen 2
        planned.clear()
        w.dataset.published_generation = 1
        for (g, _n), r in rows.items():
            r.status, r.retired_at = "ready", None
        w.db.flush()
        flip.update(after=1, retire_old=True)
        out = ask_public_batch(client, tokens["plain"], list(zip(charts, reqs)))
        assert planned[0][0] == 1 and planned[1][1], planned
        assert out[charts[1].id][0] == "error", out


# ── S11 — no result is reused across link scopes ─────────────────────────────


def test_two_links_never_share_a_result(pg, http, real_cache):
    """Link A 🔒 North, link B 🔒 South, A again: 130, 61, 130 (the real cache)."""
    client, holder = http
    req = {"dims": [], "measures": ["p2_sales.revenue"]}
    with chart_world(pg, "G2_snowflake", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_sales", req)
        dash, tokens = _dashboard(w, [(chart, None)], links=(
            ("north", [_lock("p2_regions.name", "North")], {}), ("south", [_lock("p2_regions.name", "South")], {})))
        for link, want in (("north", 130), ("south", 61), ("north", 130)):
            chart_expect(ask_public(client, tokens[link], chart, req), req, [{"p2_sales.revenue": want}])


def test_an_ordinary_result_never_answers_the_same_authoritative_predicate(pg, http, real_cache):
    """An ordinary deals.stage pick (soft-dropped, cached as 180) never answers
    a link whose 🔒 is the same predicate — that refuses."""
    client, holder = http
    req = {"dims": [], "measures": ["p2_revenue.amount"],
           "filters": {"p2_deals.stage": [{"operator": "eq", "value": "Won"}]}}
    with chart_world(pg, "G5_galaxy_single", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_revenue", {"dims": [], "measures": ["p2_revenue.amount"]})
        dash, tokens = _dashboard(w, [(chart, None)], slicer_fields=["p2_deals.stage"],
                                  links=(("plain", [], {}), ("locked", [_lock("p2_deals.stage", "Won")], {})))
        assert ask_public(client, tokens["plain"], chart, req)[0] == "rows"
        no_filter = {"dims": [], "measures": ["p2_revenue.amount"]}
        assert ask_public(client, tokens["locked"], chart, no_filter)[:2] == ("error", "AUTHORITATIVE_NOT_APPLIED")


def test_the_result_cache_key_separates_an_authoritative_predicate():
    """The canonical key itself: the same predicate as an ordinary pick and as a
    🔒 bound are two slots (a surface refusal usually precedes the lookup — this
    locks the key for any path where it does not)."""
    from app.services import query_cache

    pick = {"field": "p2_deals.stage", "operator": "eq", "value": "Won"}
    key = lambda f: query_cache._make_key("semantic_chart::m::e", "TABLE", {"_x": 1}, [f])  # noqa: E731
    assert key(pick) != key({**pick, "_authoritative": True})
    assert key(pick) == key(dict(pick))


def test_an_engine_soft_drop_cached_never_answers_a_lock(pg, http, real_cache):
    """F11: owner_id = 1 reaches revenue but not the isolated deals / activity
    measures — the ENGINE soft-drops it for them (after the cache lookup, unlike
    a normalizer drop). Cached for the ordinary pick, that result must not
    answer a link whose 🔒 is the same predicate: the lock refuses, cold or warm."""
    client, holder = http
    _id, model, base, req, _expected = BY_ID["F11.isolated_measure_unreachable_filter"]
    bare = {**req, "filters": {}}
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, base, bare)
        dash, tokens = _dashboard(w, [(chart, None)], slicer_fields=list(req["filters"]),
                                  links=(("plain", [], {}), ("locked", [_lock("p2_revenue.owner_id", 1)], {})))
        assert ask_public(client, tokens["locked"], chart, bare)[:2] == ("error", "AUTHORITATIVE_NOT_APPLIED")
        assert ask_public(client, tokens["plain"], chart, req)[0] == "rows"
        assert ask_public(client, tokens["locked"], chart, bare)[:2] == ("error", "AUTHORITATIVE_NOT_APPLIED")


def test_a_link_edit_is_served_on_the_next_view(pg, http, monkeypatch):
    """Editing a link (e.g. a 🔒 turned 🚫 hidden) drops the cached public
    structure, so its value is never served for the cache TTL."""
    from app.services import query_cache

    client, holder = http
    calls = []
    monkeypatch.setattr(query_cache, "invalidate_all_public_meta", lambda: calls.append(1) or 0)
    req = {"dims": [], "measures": ["p2_sales.revenue"]}
    with chart_world(pg, "G2_snowflake", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_sales", req)
        dash, tokens = _dashboard(w, [(chart, None)], links=(("north", [_lock("p2_regions.name", "North")], {}),))
        from app.models.models import DashboardPublicLink

        link = w.db.query(DashboardPublicLink).filter_by(token=tokens["north"]).one()
        r = client.patch(f"/api/v1/dashboards/{dash.id}/public-links/{link.id}",
                         json={"filters_config": [_lock("p2_regions.name", "North", hidden=True)]})
        assert r.status_code == 200, r.text
        assert calls, "the public structure cache was not invalidated"


# ── S12 — a relative date means the request's date on every surface ──────────


def test_a_relative_date_preset_is_resolved_at_request_time_everywhere(pg, http):
    """order_date in `last_year` (resolved now, never the frozen saved value):
    2025 → sale 4 (7), 2024 → 191 — the same on auth, public and the AI."""
    client, holder = http
    last = datetime.date.today().year - 1
    want = {2025: 7, 2024: 191}.get(last)
    frozen = {"field": "p2_sales.order_date", "semanticField": "p2_sales.order_date", "operator": "between",
              "value": ["1999-01-01", "1999-12-31"], "datePreset": "last_year"}
    req = {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_sales.order_date": [
        {"operator": "between", "value": ["1999-01-01", "1999-12-31"], "datePreset": "last_year"}]}}
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_sales", {"dims": [], "measures": ["p2_sales.revenue"]})
        dash, tokens = _dashboard(w, [(chart, None)], slicer_fields=["p2_sales.order_date"],
                                  filters_config=[{**frozen, "datasetId": w.dataset.id, "publicMode": "locked"}])
        expected = [{"p2_sales.revenue": want}]
        params = {"filters": json.dumps([frozen])}
        auth = _rows_outcome(client.get(f"/api/v1/charts/{chart.id}/data", params=params), req)
        chart_expect(auth, req, expected)
        no_viewer = {"dims": [], "measures": ["p2_sales.revenue"]}
        chart_expect(ask_public(client, tokens["plain"], chart, no_viewer), no_viewer, expected)
        chart_expect(ask_ai(w, dash, [], chart, no_viewer), no_viewer, expected)


# ── S14 / S15 — legacy assets and custom / generated on the public surface ────


def test_a_legacy_chart_on_a_public_dashboard_reads_the_current_model(pg, http):
    client, holder = http
    _id, model, base, req, expected = BY_ID["G1.by_product"]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        from app.models.models import Chart, ChartType

        cfg = {**chart_config(req), "source": {"kind": "dataset_table", "datasetId": w.dataset.id,
                                               "tableId": w.tables[base].id}}
        legacy = Chart(name=f"p4 legacy {uuid.uuid4().hex[:6]}", dataset_table_id=None,
                       chart_type=ChartType("TABLE"), config=cfg)
        w.db.add(legacy)
        w.db.flush()
        dash, tokens = _dashboard(w, [(legacy, None)])
        chart_expect(ask_public(client, tokens["plain"], legacy, req), req, expected)


def test_custom_and_generated_charts_keep_their_mode_on_the_public_surface(pg, http):
    client, holder = http
    req = {"dims": [], "measures": ["p2_sales.revenue"]}
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        generated = save_chart(w, "p2_sales", req, config={**chart_config(req), "queryMode": "generated",
                                                          "customSql": "SELECT 1 AS x"})
        # the custom contract (Pair #3): the author's SQL, its own role config — Pen 141 / Ink 57
        custom_sql = (f"SELECT p.name AS product, s.amount AS amount FROM {T.S}.sales s "
                      f"LEFT JOIN {T.S}.products p ON p.id = s.product_id")
        custom = save_chart(w, "p2_sales", {}, chart_type="BAR", config={
            "queryMode": "custom", "customSql": custom_sql,
            "customRoleConfig": {"dimension": "product", "metrics": [{"field": "amount", "agg": "sum"}]},
            "roleConfig": {"dimension": "p2_regions.name", "metrics": [{"field": "p2_sales.revenue", "agg": "auto"}]}})
        own_with_datasource(w, custom)  # custom SQL runs under its owner's datasource right
        dash, tokens = _dashboard(w, [(generated, None), (custom, None)])
        chart_expect(ask_public(client, tokens["plain"], generated, req), req, [{"p2_sales.revenue": 198}])
        kind, rows, _ = ask_public(client, tokens["plain"], custom, {})
        assert kind == "rows" and {r.get("product"): _norm(r.get("sum__amount")) for r in rows} == {
            "Pen": 141, "Ink": 57}, rows


# ── /charts/ai-preview — the AI chart tool runs the chart's own execution ─────


def test_the_ai_chart_preview_is_the_semantic_answer_and_saves_what_it_previewed(pg, http):
    """By product: Pen 141 / Ink 57 (the engine's answer, not a physical
    aggregate); the saved chart renders the same rows; an ambiguous request is
    refused with its category."""
    client, holder = http
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        from app.models.user import User

        if w.db.get(User, uuid.UUID(int=7)) is None:   # the fixture's admin owns the saved chart
            w.db.add(User(id=uuid.UUID(int=7), email=f"p4-{uuid.uuid4().hex[:6]}@x", full_name="p4"))
            w.db.flush()
        body = {"dataset_table_id": w.tables["p2_sales"].id, "chart_type": "TABLE", "save": True,
                "name": f"p4 ai chart {uuid.uuid4().hex[:6]}",
                "config": {"dimensions": ["p2_products.name"],
                           "metrics": [{"column": "p2_sales.revenue", "aggregation": "sum"}]}}
        r = client.post("/api/v1/charts/ai-preview", json=body)
        assert r.status_code == 200, r.text
        got = {x["p2_products.name"]: _norm(x["p2_sales.revenue"]) for x in r.json()["data"]}
        assert got == {"Pen": 141, "Ink": 57}, r.json()
        saved = client.get(f"/api/v1/charts/{r.json()['chart_id']}/data")
        assert saved.status_code == 200, saved.text
        assert {x["p2_products.name"]: _norm(x["p2_sales.revenue"]) for x in saved.json()["data"]} == got
        # the rest of the saved config (a Top-1 data limit) is previewed too — never saved unseen
        top1 = {**body, "name": f"p4 ai top1 {uuid.uuid4().hex[:6]}",
                "config": {**body["config"], "styleConfig": {"dataLimit": 1, "dataLimitDirection": "top"}}}
        r = client.post("/api/v1/charts/ai-preview", json=top1)
        assert r.status_code == 200, r.text
        got = {x["p2_products.name"]: _norm(x["p2_sales.revenue"]) for x in r.json()["data"]}
        assert got == {"Pen": 141}, r.json()
        saved = client.get(f"/api/v1/charts/{r.json()['chart_id']}/data")
        assert {x["p2_products.name"]: _norm(x["p2_sales.revenue"]) for x in saved.json()["data"]} == got
    with chart_world(pg, "G3_diamond", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        body = {"dataset_table_id": w.tables["p2_sales"].id, "chart_type": "TABLE",
                "config": {"dimensions": ["p2_regions.name"],
                           "metrics": [{"column": "p2_sales.revenue", "aggregation": "sum"}]}}
        r = client.post("/api/v1/charts/ai-preview", json=body)
        assert r.status_code == 400 and r.headers.get("X-AppBI-Refusal") == "AMBIGUOUS_ROUTE", (r.status_code, r.text)
