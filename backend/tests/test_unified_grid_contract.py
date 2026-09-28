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
    # The dock moves the grouped bar; placing filters ON the page is slicerControls.
    assert "only moves the grouped filter BAR" in planner.SYSTEM_PROMPT
    start = prompt.index('"slicers": [')
    digest = json.loads(prompt[start + len('"slicers": '): prompt.index("]", start) + 1])
    assert digest == [
        {"id": "gf-1", "label": "Order date", "position": "top", "placed": False, "visibleHere": True},
        {"id": "gf-2", "label": "State", "position": "grid", "placed": True, "visibleHere": True},
    ]
    assert "orders.order_date" not in prompt and "2018-01-01" not in prompt
