"""Canvas dashboards become Grid dashboards.

The grid is the only report layout. No viewer surface ever read Canvas pixels:
the public link, the embed and the PDF export render the grid cells. So a
Canvas dashboard already looked, to every viewer, like its grid, and this
migration changes nothing any viewer sees. What it does:

  * ``layout_mode='canvas'`` → ``'grid'`` (also inside a pending draft snapshot);
  * a tile of such a dashboard with a pixel box but no grid cell gets the cell
    its box occupied (the inverse of the Canvas editor's own conversion). Its
    pixels are kept;
  * the dashboard records ``canvas_config.migratedFromCanvas`` with the tiles
    whose cells were derived, so the downgrade restores exactly what was there.

Data only, no schema change. Idempotent: a second run finds no Canvas rows.

Revision ID: 20260928_0001
Revises: 20260926_0001
"""
import json

import sqlalchemy as sa
from alembic import op

revision = "20260928_0001"
down_revision = "20260926_0001"
branch_labels = None
depends_on = None

# Frozen copy of the arithmetic (app/models/grid_geometry.py) — a migration must
# not change meaning when application code later changes.
_COLS = 36
_MARGIN = 16
_ROW = 16
_DEFAULT_WIDTH = 1440

_dashboards = sa.table(
    "dashboards",
    sa.column("id", sa.Integer),
    sa.column("layout_mode", sa.String),
    sa.column("canvas_config", sa.JSON),
    sa.column("draft_snapshot", sa.JSON),
)
_tiles = sa.table(
    "dashboard_charts",
    sa.column("id", sa.Integer),
    sa.column("dashboard_id", sa.Integer),
    sa.column("layout", sa.JSON),
)


def _as_dict(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else None
        except ValueError:
            return None
    return None


def _num(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _cell_from_pixels(layout, width):
    col_w = (width - _MARGIN * (_COLS + 1)) / _COLS
    pitch_x = col_w + _MARGIN
    pitch_y = _ROW + _MARGIN
    x = max(0, min(_COLS - 1, int(round((float(layout["xPx"]) - _MARGIN) / pitch_x))))
    w = max(1, min(_COLS - x, int(round((float(layout["wPx"]) + _MARGIN) / pitch_x))))
    y = max(0, int(round((float(layout["yPx"]) - _MARGIN) / pitch_y)))
    h = max(1, int(round((float(layout["hPx"]) + _MARGIN) / pitch_y)))
    return {"x": x, "y": y, "w": w, "h": h, "gv": 2}


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.select(_dashboards.c.id, _dashboards.c.canvas_config, _dashboards.c.draft_snapshot)
        .where(_dashboards.c.layout_mode == "canvas")
    ).fetchall()
    for dash_id, canvas_config, draft_snapshot in rows:
        config = dict(_as_dict(canvas_config) or {})
        width = config.get("width") if _num(config.get("width")) and config.get("width") > 0 else _DEFAULT_WIDTH
        derived = []
        tiles = bind.execute(
            sa.select(_tiles.c.id, _tiles.c.layout).where(_tiles.c.dashboard_id == dash_id)
        ).fetchall()
        for tile_id, layout in tiles:
            lay = _as_dict(layout)
            if lay is None:
                continue
            has_cell = all(_num(lay.get(k)) for k in ("x", "y", "w", "h"))
            has_px = all(_num(lay.get(k)) for k in ("xPx", "yPx", "wPx", "hPx"))
            if has_cell or not has_px:
                continue
            bind.execute(
                _tiles.update().where(_tiles.c.id == tile_id)
                .values(layout={**lay, **_cell_from_pixels(lay, float(width))})
            )
            derived.append(tile_id)
        config["migratedFromCanvas"] = {"derivedTiles": derived, "tiles": len(tiles)}
        values = {"layout_mode": "grid", "canvas_config": config}
        snapshot = _as_dict(draft_snapshot)
        if snapshot is not None and snapshot.get("layout_mode") == "canvas":
            values["draft_snapshot"] = {**snapshot, "layout_mode": "grid"}
        bind.execute(_dashboards.update().where(_dashboards.c.id == dash_id).values(**values))


def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.select(_dashboards.c.id, _dashboards.c.canvas_config)).fetchall()
    for dash_id, canvas_config in rows:
        config = _as_dict(canvas_config)
        marker = (config or {}).get("migratedFromCanvas")
        if not isinstance(marker, dict):
            continue
        for tile_id in marker.get("derivedTiles") or []:
            layout = _as_dict(bind.execute(
                sa.select(_tiles.c.layout).where(_tiles.c.id == tile_id)
            ).scalar())
            if layout is None:
                continue
            restored = {k: v for k, v in layout.items() if k not in ("x", "y", "w", "h", "gv")}
            bind.execute(_tiles.update().where(_tiles.c.id == tile_id).values(layout=restored))
        rest = {k: v for k, v in config.items() if k != "migratedFromCanvas"}
        bind.execute(
            _dashboards.update().where(_dashboards.c.id == dash_id)
            .values(layout_mode="canvas", canvas_config=rest)
        )
