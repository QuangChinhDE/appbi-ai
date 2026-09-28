"""Unified Grid & Slicer Freedom — the backend half of the contract.

  * A slicer CONTROL (widget_type='slicer') is presentation: it is stored as
    {slicerId, treatment, origin?} and nothing else, so it can never carry a
    predicate (field / operator / value / scope).
  * The grid is the only layout: every write of layout_mode stores "grid", and
    a tile that arrives with only a Canvas pixel box gets a grid cell.
  * The migration moves existing Canvas rows to the grid, derives cells for
    pixel-only tiles, keeps the pixels, and its downgrade restores exactly the
    rows it changed.
"""
import importlib.util
import pathlib

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from app.models import grid_geometry
from app.models.models import Dashboard, DashboardChart
from app.services.dashboard_service import is_draft_only_item, normalize_dashboard_widget_config

MIGRATION = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "20260928_0001_canvas_to_grid.py"


def _migration():
    spec = importlib.util.spec_from_file_location("canvas_to_grid", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── slicer control ────────────────────────────────────────────────────────────

def test_a_slicer_control_never_stores_a_predicate():
    stored = normalize_dashboard_widget_config("slicer", {
        "slicerId": "gf-1", "treatment": "list", "origin": "ai",
        # everything below is what a control must never be able to carry
        "field": "orders.state", "fieldKey": "x.y", "operator": "in", "value": ["SP"],
        "scope": "all", "pageScope": {"p1": {"filter": False}}, "datasetId": 3,
    })
    assert stored == {"slicerId": "gf-1", "treatment": "list", "origin": "ai"}


def test_an_unknown_treatment_falls_back_to_auto_and_an_id_is_trimmed():
    assert normalize_dashboard_widget_config("slicer", {"treatment": "neon", "slicerId": "  gf-9 "}) == {
        "slicerId": "gf-9", "treatment": "auto",
    }
    assert normalize_dashboard_widget_config("slicer", None) == {"slicerId": "", "treatment": "auto"}


def test_a_new_control_is_draft_only_until_publish():
    tile = DashboardChart(widget_type="slicer", widget_config={"slicerId": "gf-1"},
                          layout={"x": 0, "y": 0, "w": 8, "h": 3, "draftOnly": True})
    assert is_draft_only_item(tile)


# ── one layout ────────────────────────────────────────────────────────────────

def test_every_write_of_layout_mode_stores_grid():
    assert Dashboard(name="a", layout_mode="canvas").layout_mode == "grid"
    dash = Dashboard(name="b")
    dash.layout_mode = "canvas"
    assert dash.layout_mode == "grid"


def test_a_pixel_only_tile_gets_the_cell_its_box_occupied_and_keeps_its_pixels():
    tile = DashboardChart(layout={"xPx": 16, "yPx": 16, "wPx": 600, "hPx": 240})
    assert tile.layout["xPx"] == 16 and tile.layout["wPx"] == 600
    assert {k: tile.layout[k] for k in ("x", "y", "w", "h", "gv")} == {"x": 0, "y": 0, "w": 16, "h": 8, "gv": 2}


def test_a_tile_with_a_grid_cell_is_never_rewritten():
    layout = {"x": 3, "y": 1, "w": 6, "h": 4, "xPx": 999, "yPx": 999, "wPx": 5, "hPx": 5}
    assert DashboardChart(layout=dict(layout)).layout == layout


def test_the_migration_uses_the_same_arithmetic_as_the_model():
    mig = _migration()
    for width in (1200, 1440, 1920):
        for box in ({"xPx": 16, "yPx": 16, "wPx": 300, "hPx": 200},
                    {"xPx": 700, "yPx": 900, "wPx": 740, "hPx": 64},
                    {"xPx": 1400, "yPx": 0, "wPx": 900, "hPx": 10}):
            assert mig._cell_from_pixels(box, float(width)) == grid_geometry.grid_cell_from_pixels(box, width)


# ── migration on a real (SQLite) database ─────────────────────────────────────

def _db():
    engine = sa.create_engine("sqlite://")
    meta = sa.MetaData()
    sa.Table("dashboards", meta,
             sa.Column("id", sa.Integer, primary_key=True), sa.Column("layout_mode", sa.String(16)),
             sa.Column("canvas_config", sa.JSON), sa.Column("draft_snapshot", sa.JSON))
    sa.Table("dashboard_charts", meta,
             sa.Column("id", sa.Integer, primary_key=True), sa.Column("dashboard_id", sa.Integer),
             sa.Column("layout", sa.JSON))
    meta.create_all(engine)
    return engine, meta


def _run(engine, fn):
    with engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            fn()


def test_canvas_rows_move_to_the_grid_and_the_downgrade_restores_them_exactly():
    engine, meta = _db()
    dashboards, tiles = meta.tables["dashboards"], meta.tables["dashboard_charts"]
    px_only = {"xPx": 16, "yPx": 80, "wPx": 560, "hPx": 240}
    both = {"x": 3, "y": 0, "w": 6, "h": 4, "xPx": 1, "yPx": 1, "wPx": 2, "hPx": 2}
    with engine.begin() as conn:
        conn.execute(dashboards.insert(), [
            {"id": 1, "layout_mode": "canvas", "canvas_config": {"width": 1200},
             "draft_snapshot": {"layout_mode": "canvas", "name": "d"}},
            {"id": 2, "layout_mode": "grid", "canvas_config": {}, "draft_snapshot": None},
        ])
        conn.execute(tiles.insert(), [
            {"id": 10, "dashboard_id": 1, "layout": px_only},
            {"id": 11, "dashboard_id": 1, "layout": both},
            {"id": 20, "dashboard_id": 2, "layout": dict(px_only)},  # a grid dashboard is not touched
        ])
    mig = _migration()
    _run(engine, mig.upgrade)
    with engine.connect() as conn:
        d1 = conn.execute(sa.select(dashboards).where(dashboards.c.id == 1)).mappings().one()
        layouts = dict(conn.execute(sa.select(tiles.c.id, tiles.c.layout)).fetchall())
    assert d1["layout_mode"] == "grid"
    assert d1["draft_snapshot"]["layout_mode"] == "grid"
    assert d1["canvas_config"]["migratedFromCanvas"] == {"derivedTiles": [10], "tiles": 2}
    assert layouts[10] == {**px_only, **grid_geometry.grid_cell_from_pixels(px_only, 1200)}
    assert layouts[11] == both
    assert layouts[20] == px_only

    # Idempotent.
    _run(engine, mig.upgrade)
    with engine.connect() as conn:
        again = conn.execute(sa.select(dashboards.c.canvas_config).where(dashboards.c.id == 1)).scalar()
    assert again["migratedFromCanvas"] == {"derivedTiles": [10], "tiles": 2}

    _run(engine, mig.downgrade)
    with engine.connect() as conn:
        d1 = conn.execute(sa.select(dashboards).where(dashboards.c.id == 1)).mappings().one()
        layouts = dict(conn.execute(sa.select(tiles.c.id, tiles.c.layout)).fetchall())
    assert d1["layout_mode"] == "canvas" and d1["canvas_config"] == {"width": 1200}
    assert layouts == {10: px_only, 11: both, 20: px_only}


# ── AI Design sees the slicers it may place ───────────────────────────────────

def test_the_planner_is_told_which_slicers_it_may_place_and_never_their_fields():
    import json

    from app.services import dashboard_presentation_planner as planner

    snapshot = {
        "dashboard": {"name": "r", "currentPageId": "p1", "pageCount": 1},
        "currentPage": {"id": "p1", "name": "Main"},
        "visuals": [],
        "slicers": [
            {"id": "gf-1", "displayLabel": "Order date", "presentationType": "date",
             "currentPosition": "top", "placedTileId": None, "visibleHere": True,
             "field": "orders.order_date", "value": ["2018-01-01"]},
            {"id": "gf-2", "displayLabel": "State", "presentationType": "dropdown",
             "currentPosition": "grid", "placedTileId": 41, "visibleHere": True},
        ],
        "capabilities": {},
    }
    prompt = planner.build_planner_prompt(snapshot=snapshot, user_prompt="redesign", granted_layer="redesign")
    assert "slicerControls" in prompt
    # The system prompt says how: a filter band, or a control beside its chart.
    assert "filter_bar" in planner.SYSTEM_PROMPT and "never changes what the slicer filters" in planner.SYSTEM_PROMPT
    # There is no bar or dock to move: filters are placed on the grid.
    assert "There is no filter bar or dock" in planner.SYSTEM_PROMPT
    assert "dock" not in json.dumps(planner.PLAN_SCHEMA_HINT["slicerPresentation"])
    start = prompt.index('"slicers": [')
    digest = json.loads(prompt[start + len('"slicers": '): prompt.index("]", start) + 1])
    assert digest == [
        {"id": "gf-1", "label": "Order date", "position": "top", "placed": False, "visibleHere": True},
        {"id": "gf-2", "label": "State", "position": "grid", "placed": True, "visibleHere": True},
    ]
    assert "orders.order_date" not in prompt and "2018-01-01" not in prompt


# ── the slicer bar becomes controls on the grid (20260929_0001) ───────────────

BAR_MIGRATION = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "20260929_0001_slicer_bar_to_grid.py"


def _bar_migration():
    spec = importlib.util.spec_from_file_location("slicer_bar_to_grid", BAR_MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _bar_db():
    engine = sa.create_engine("sqlite://")
    meta = sa.MetaData()
    sa.Table("dashboards", meta,
             sa.Column("id", sa.Integer, primary_key=True), sa.Column("slicers_config", sa.JSON),
             sa.Column("filters_config", sa.JSON), sa.Column("public_filters_config", sa.JSON),
             sa.Column("pages_config", sa.JSON), sa.Column("slicer_cluster_layout", sa.JSON),
             sa.Column("theme_config", sa.JSON), sa.Column("draft_snapshot", sa.JSON))
    sa.Table("dashboard_charts", meta,
             sa.Column("id", sa.Integer, primary_key=True, autoincrement=True), sa.Column("dashboard_id", sa.Integer),
             sa.Column("chart_id", sa.Integer), sa.Column("widget_type", sa.String), sa.Column("widget_config", sa.JSON),
             sa.Column("layout", sa.JSON))
    meta.create_all(engine)
    return engine, meta


def _rows(engine, meta, dash_id):
    tiles = meta.tables["dashboard_charts"]
    with engine.connect() as conn:
        return {r.id: dict(r._mapping) for r in conn.execute(sa.select(tiles).where(tiles.c.dashboard_id == dash_id))}


def test_every_viewer_filter_gets_a_control_on_the_pages_that_show_it_and_the_downgrade_restores_all():
    engine, meta = _bar_db()
    dashboards, tiles = meta.tables["dashboards"], meta.tables["dashboard_charts"]
    slicers = [
        {"id": "s-all", "field": "region", "type": "dropdown", "operator": "in", "value": ["N"], "scope": "all"},
        {"id": "s-p2", "field": "cat", "type": "dropdown", "operator": "in", "value": [], "scope": "custom",
         "pageScope": {"p1": {"filter": True, "visible": False}, "p2": {"filter": True, "visible": True}}},
        {"id": "logo", "type": "image", "src": "https://example.com/logo.png", "link": "https://example.com"},
    ]
    pane = [{"id": "f-vis", "field": "channel", "publicMode": "visible"}, {"id": "f-lock", "field": "x", "publicMode": "locked"}]
    pages = [{"id": "p1", "name": "One"}, {"id": "p2", "name": "Two", "slicers": [{"id": "s-page", "field": "seg"}]}]
    draft = {"user_layouts": {"u1": {"10": {"x": 0, "y": 0, "w": 12, "h": 6, "gv": 2, "pageId": "p1"}}}}
    with engine.begin() as conn:
        conn.execute(dashboards.insert(), [
            {"id": 1, "slicers_config": slicers, "filters_config": pane, "public_filters_config": [], "pages_config": pages,
             "slicer_cluster_layout": {"position": "left"}, "theme_config": {}, "draft_snapshot": draft},
            {"id": 2, "slicers_config": [{"id": "s-h", "field": "a"}], "filters_config": [], "public_filters_config": [],
             "pages_config": [], "slicer_cluster_layout": {"position": "hidden"}, "theme_config": {}, "draft_snapshot": None},
        ])
        conn.execute(tiles.insert(), [
            {"id": 10, "dashboard_id": 1, "widget_type": "chart", "layout": {"x": 0, "y": 0, "w": 12, "h": 6, "gv": 2, "pageId": "p1"}},
            {"id": 11, "dashboard_id": 1, "widget_type": "chart", "layout": {"x": 0, "y": 0, "w": 4, "h": 2, "pageId": "p2"}},  # legacy 12-col
            {"id": 20, "dashboard_id": 2, "widget_type": "chart", "layout": {"x": 0, "y": 0, "w": 36, "h": 6, "gv": 2}},
        ])
    before1, before2 = _rows(engine, meta, 1), _rows(engine, meta, 2)
    mig = _bar_migration()
    _run(engine, mig.upgrade)
    rows = _rows(engine, meta, 1)
    controls = {(r["widget_config"]["slicerId"], r["layout"]["pageId"]): r for r in rows.values() if r["widget_type"] == "slicer"}
    # p1: the all-pages slicer + the visible pane filter (the custom one is hidden there, the locked one never shows).
    # p2: the all-pages slicer, the custom one (visible there), the pane filter, the page's own slicer.
    assert set(controls) == {("s-all", "p1"), ("f-vis", "p1"), ("s-all", "p2"), ("s-p2", "p2"), ("f-vis", "p2"), ("s-page", "p2")}
    assert all(set(r["widget_config"]) == {"slicerId", "treatment", "origin"} for r in controls.values())
    images = [r for r in rows.values() if r["widget_type"] == "image"]
    assert len(images) == 2 and all(i["widget_config"]["url"] == "https://example.com/logo.png" and i["widget_config"]["link"] for i in images)
    # p1 had 2 controls + 1 image → one band of 3 rows; p2 had 4 + 1 → two bands of 3 rows.
    assert rows[10]["layout"]["y"] == 3
    assert rows[11]["layout"]["y"] == 2  # 6 finer rows == 2 legacy rows
    with engine.connect() as conn:
        d1 = conn.execute(sa.select(dashboards).where(dashboards.c.id == 1)).mappings().one()
        d2 = conn.execute(sa.select(dashboards).where(dashboards.c.id == 2)).mappings().one()
    assert d1["draft_snapshot"]["user_layouts"]["u1"]["10"]["y"] == 3  # the pending draft moved too
    assert d1["slicers_config"] == slicers and d1["filters_config"] == pane  # meaning untouched
    assert _rows(engine, meta, 2) == before2 and d2["slicer_cluster_layout"]["migratedToGrid"]["hidden"] is True
    # Idempotent.
    _run(engine, mig.upgrade)
    assert _rows(engine, meta, 1) == rows
    # The downgrade removes exactly what it made and moves back exactly what it moved.
    _run(engine, mig.downgrade)
    assert _rows(engine, meta, 1) == before1
    with engine.connect() as conn:
        d1 = conn.execute(sa.select(dashboards).where(dashboards.c.id == 1)).mappings().one()
    assert d1["draft_snapshot"] == draft and d1["slicer_cluster_layout"] == {"position": "left"}


def test_the_service_places_missing_controls_once_and_never_touches_what_a_filter_means():
    from unittest.mock import MagicMock

    from app.services import slicer_control_service as svc

    dash = Dashboard(id=7, name="d", pages_config=[{"id": "page-1"}],
                     slicers_config=[{"id": "gf-1", "field": "state", "type": "dropdown", "operator": "in", "value": ["SP"]}],
                     filters_config=[], public_filters_config=[], slicer_cluster_layout=None, theme_config={})
    kpi = DashboardChart(id=1, dashboard_id=7, widget_type="chart", layout={"x": 0, "y": 0, "w": 12, "h": 6, "gv": 2, "pageId": "page-1"})
    dash.dashboard_charts = [kpi]
    db = MagicMock()
    added = []
    db.add.side_effect = lambda row: (added.append(row), dash.dashboard_charts.append(row))
    out = svc.ensure_slicer_controls(db, dash)
    control = next(r for r in added if r.widget_type == "slicer")
    assert control.widget_config == {"slicerId": "gf-1", "treatment": "auto", "origin": "author"}
    assert control.layout["y"] == 0 and kpi.layout["y"] == 3
    assert dash.slicers_config == [{"id": "gf-1", "field": "state", "type": "dropdown", "operator": "in", "value": ["SP"]}]
    assert out["pages"]["page-1"]["shift"] == 3
    # A second run finds the control and adds nothing.
    added.clear()
    svc.ensure_slicer_controls(db, dash)
    assert added == [] and kpi.layout["y"] == 3
    assert svc.slicer_ids_without_control(dash, "page-1") == []
