"""Grid is the only report layout.

Canvas was a second layout engine that stored pixel boxes (xPx/yPx/wPx/hPx)
next to the grid cells. No viewer surface ever read those pixels — the public
link, the embed and the PDF export all render the grid cells — so a Canvas
dashboard already looked, to every viewer, like its grid. What is left of it
is coerced here, at the model, because every writer (API, MCP, HTML import,
publish of a draft snapshot, the starter) goes through these columns:

  * a `layout_mode` other than "grid" is stored as "grid";
  * a tile that arrives with pixel coordinates but no grid cell gets a cell
    derived from its pixels — the exact inverse of the conversion the Canvas
    editor used — and keeps its pixels, so nothing is lost.

Pure arithmetic, no service imports (models must not import services).
"""
from __future__ import annotations

from typing import Any

# The finer grid (see frontend lib/dashboard-pages.ts): 36 columns, 16px rows,
# 16px gaps. `gv: 2` marks cells as already in this grid so the renderer does
# not scale them up again.
GRID_COLS = 36
GRID_MARGIN = 16
GRID_ROW_HEIGHT = 16
GRID_VERSION = 2
DEFAULT_CANVAS_WIDTH = 1440


def coerce_layout_mode(value: Any) -> str:
    return "grid"


def _num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def has_grid_cell(layout: Any) -> bool:
    return isinstance(layout, dict) and all(_num(layout.get(k)) is not None for k in ("x", "y", "w", "h"))


def has_pixel_box(layout: Any) -> bool:
    return isinstance(layout, dict) and all(_num(layout.get(k)) is not None for k in ("xPx", "yPx", "wPx", "hPx"))


def grid_cell_from_pixels(layout: dict, canvas_width: float | None = None) -> dict:
    """The grid cell a Canvas pixel box occupied (inverse of the old gridToCanvas)."""
    width = _num(canvas_width) or DEFAULT_CANVAS_WIDTH
    col_w = (width - GRID_MARGIN * (GRID_COLS + 1)) / GRID_COLS
    pitch_x = col_w + GRID_MARGIN
    pitch_y = GRID_ROW_HEIGHT + GRID_MARGIN
    x = round((float(layout["xPx"]) - GRID_MARGIN) / pitch_x)
    y = round((float(layout["yPx"]) - GRID_MARGIN) / pitch_y)
    w = round((float(layout["wPx"]) + GRID_MARGIN) / pitch_x)
    h = round((float(layout["hPx"]) + GRID_MARGIN) / pitch_y)
    x = max(0, min(GRID_COLS - 1, int(x)))
    w = max(1, min(GRID_COLS - x, int(w)))
    return {"x": x, "y": max(0, int(y)), "w": w, "h": max(1, int(h)), "gv": GRID_VERSION}


def ensure_grid_cell(layout: Any, canvas_width: float | None = None) -> Any:
    """A layout that can be drawn on the grid. Unchanged when it already has a
    cell; given one from its pixels when it only has pixels."""
    if not isinstance(layout, dict) or has_grid_cell(layout) or not has_pixel_box(layout):
        return layout
    return {**layout, **grid_cell_from_pixels(layout, canvas_width)}
