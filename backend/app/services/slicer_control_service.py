"""Slicer controls on the report grid — the only place a filter control lives.

A slicer (an entry in ``slicers_config`` / ``pages_config[].slicers``) is the
FILTER. Its CONTROL is a grid element (``widget_type='slicer'``,
``widget_config={slicerId, treatment}``) that sits among the charts like any
other element. There is no separate filter area on a report any more: the old
slicer cluster (a strip above, a rail beside, or a drawer) is gone.

This module is what guarantees that a filter a viewer is meant to control HAS a
control on the grid, for the paths that create filters without placing them:
the report starter, the HTML importer, fixtures. It never touches a filter's
meaning — it only adds grid elements and moves tiles down to make room — and it
never runs on its own at read or publish time, so an author who removed a
control on purpose is not second-guessed.

The alembic revision ``20260929_0001`` applies the same rule, frozen, to the
reports that existed before this change.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.models import Dashboard, DashboardChart

DEFAULT_PAGE_ID = "page-1"
# A control is a card: a label and a value. 8 of 36 columns, 3 rows (~80 px).
CONTROL_W = 8
CONTROL_H = 3
PER_ROW = 4
GRID_VERSION = 2


def _page_of(layout: Any) -> str:
    page = layout.get("pageId") if isinstance(layout, dict) else None
    return page.strip() if isinstance(page, str) and page.strip() else DEFAULT_PAGE_ID


def page_ids(dash: Dashboard) -> List[str]:
    pages = [p.get("id") for p in (dash.pages_config or []) if isinstance(p, dict) and p.get("id")]
    return pages or [DEFAULT_PAGE_ID]


def _visible_on(slicer: Dict[str, Any], page_id: str) -> bool:
    if str(slicer.get("scope") or "all") == "custom":
        return bool(((slicer.get("pageScope") or {}).get(page_id) or {}).get("visible"))
    return True


def _entries(value: Any) -> List[Dict[str, Any]]:
    return [e for e in (value or []) if isinstance(e, dict)]


def viewer_entries_for_page(dash: Dashboard, page_id: str) -> List[Dict[str, Any]]:
    """The filters a viewer could change on this page — the same list the old
    slicer cluster drew there (lib/public-page-filters controlSeed): report
    slicers shown on the page, filter-pane filters left visible to viewers,
    the legacy public list when there is nothing else, and the page's own
    slicers. De-duplicated by id; an entry without an id cannot be referenced."""
    slicers = [s for s in _entries(dash.slicers_config) if s.get("type") != "image" and _visible_on(s, page_id)]
    filters = [f for f in _entries(dash.filters_config) if str(f.get("publicMode") or "visible") == "visible"]
    legacy = _entries(dash.public_filters_config) if not slicers and not filters else []
    page = next((p for p in (dash.pages_config or []) if isinstance(p, dict) and p.get("id") == page_id), None)
    page_slicers = [s for s in _entries((page or {}).get("slicers")) if s.get("type") != "image"]
    out: List[Dict[str, Any]] = []
    seen = set()
    for entry in [*slicers, *filters, *legacy, *page_slicers]:
        sid = str(entry.get("id") or "").strip()
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.append(entry)
    return out


def image_entries(dash: Dashboard) -> List[Dict[str, Any]]:
    """Decorations the cluster drew beside the slicers (logos). Never predicates."""
    return [e for e in _entries(dash.slicers_config) if e.get("type") == "image" and e.get("src")]


def controls_hidden(dash: Dashboard) -> bool:
    """A report that hid its filter UI ('hidden' dock) keeps it hidden: its
    values still apply, and no control is added."""
    dock = (dash.slicer_cluster_layout or {}).get("position") if isinstance(dash.slicer_cluster_layout, dict) else None
    if dock is None and isinstance(dash.theme_config, dict):
        dock = dash.theme_config.get("filterDock")
    return str(dock or "") == "hidden"


def band_cells(count: int, *, x0: int = 0, y0: int = 0) -> List[Dict[str, int]]:
    """Cells for ``count`` controls in a band: four to a row, left to right."""
    return [
        {"x": x0 + (i % PER_ROW) * CONTROL_W, "y": y0 + (i // PER_ROW) * CONTROL_H, "w": CONTROL_W, "h": CONTROL_H}
        for i in range(count)
    ]


def band_height(count: int) -> int:
    return 0 if count <= 0 else ((count + PER_ROW - 1) // PER_ROW) * CONTROL_H


def _shift(layout: Dict[str, Any], rows: int) -> Dict[str, Any]:
    """Move a tile down by ``rows`` finer-grid rows, in its own grid units (a
    legacy 12-column tile is scaled ×3 when drawn)."""
    legacy = not (isinstance(layout.get("gv"), (int, float)) and layout.get("gv") >= GRID_VERSION)
    dy = rows // 3 if legacy else rows
    return {**layout, "y": int(layout.get("y") or 0) + dy}


def control_row(dashboard_id: int, slicer_id: str, page_id: str, cell: Dict[str, int], *, origin: str) -> DashboardChart:
    return DashboardChart(
        dashboard_id=dashboard_id, chart_id=None, widget_type="slicer",
        widget_config={"slicerId": slicer_id, "treatment": "auto", "origin": origin},
        layout={**cell, "gv": GRID_VERSION, "pageId": page_id},
    )


def ensure_slicer_controls(db: Session, dash: Dashboard, *, origin: str = "author") -> Dict[str, Any]:
    """Give every viewer filter a control on each page that shows it.

    Missing controls are placed as a band at the top of their page and the
    page's tiles move down by the band's height (whitespace between them is
    kept). Decorations become image elements in the same band. Idempotent: a
    filter that already has a control on a page is left alone. Returns what
    was created, per page.
    """
    summary: Dict[str, Any] = {"pages": {}, "hidden": controls_hidden(dash)}
    if summary["hidden"]:
        return summary
    tiles = list(dash.dashboard_charts or [])
    images = image_entries(dash)
    for page_id in page_ids(dash):
        on_page = [t for t in tiles if _page_of(t.layout) == page_id]
        placed = {str((t.widget_config or {}).get("slicerId") or "") for t in on_page if t.widget_type == "slicer"}
        missing = [e for e in viewer_entries_for_page(dash, page_id) if str(e["id"]) not in placed]
        have_images = {str((t.widget_config or {}).get("url") or "") for t in on_page if t.widget_type == "image"}
        new_images = [e for e in images if str(e.get("src")) not in have_images]
        count = len(missing) + len(new_images)
        if count == 0:
            continue
        rows = band_height(count)
        for tile in on_page:
            tile.layout = _shift(dict(tile.layout or {}), rows)
            flag_modified(tile, "layout")
        cells = band_cells(count)
        created: List[int] = []
        for entry, cell in zip(missing, cells):
            row = control_row(dash.id, str(entry["id"]), page_id, cell, origin=origin)
            db.add(row)
            db.flush()
            created.append(row.id)
        for entry, cell in zip(new_images, cells[len(missing):]):
            row = DashboardChart(
                dashboard_id=dash.id, chart_id=None, widget_type="image",
                widget_config={"url": str(entry.get("src")), "fit": entry.get("fit") or "contain",
                               **({"alt": entry["alt"]} if entry.get("alt") else {}),
                               **({"link": entry["link"]} if entry.get("link") else {}),
                               "transparentBackground": True, "origin": origin},
                layout={**cell, "gv": GRID_VERSION, "pageId": page_id},
            )
            db.add(row)
            db.flush()
            created.append(row.id)
        summary["pages"][page_id] = {"created": created, "shift": rows}
    return summary


def slicer_ids_without_control(dash: Dashboard, page_id: str, tiles: Optional[Iterable[DashboardChart]] = None) -> List[str]:
    """Viewer filters shown on a page that have no control there (for tests and
    diagnostics; the builder computes the same list client-side)."""
    tiles = list(tiles if tiles is not None else (dash.dashboard_charts or []))
    placed = {str((t.widget_config or {}).get("slicerId") or "") for t in tiles
              if t.widget_type == "slicer" and _page_of(t.layout) == page_id}
    return [str(e["id"]) for e in viewer_entries_for_page(dash, page_id) if str(e["id"]) not in placed]
