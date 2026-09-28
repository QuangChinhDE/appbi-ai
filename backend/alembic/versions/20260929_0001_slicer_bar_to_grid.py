"""The slicer bar becomes controls on the grid.

A report no longer has a filter area of its own. Every filter a viewer could
change used to be drawn in one slicer cluster (a strip above the report, a rail
beside it, or a drawer); it is now a control ON the report grid, among the
charts, that the author can move like any element.

For each existing report, per page:

  * every filter the old cluster drew on that page — report slicers the page
    shows, filter-pane filters left visible to viewers, the legacy public list
    when there is nothing else, and the page's own slicers — gets a control
    (``widget_type='slicer'``, ``{slicerId, treatment}``) in a band at the top
    of the page, four to a row;
  * the cluster's image decorations become image elements in the same band;
  * the page's tiles move down by the band's height, in the live rows AND in
    every editor's pending draft layout, so nothing overlaps and every gap the
    author left is kept.

What a filter MEANS is not touched: no field, operator, value, scope or link
restriction changes, and a decoration never becomes a predicate. A report that
hid its filter UI (dock 'hidden') keeps it hidden and gets no control.

The report records ``slicer_cluster_layout.migratedToGrid`` with everything it
created and moved; the downgrade deletes exactly those elements and moves exactly
those tiles back. Idempotent: a report already carrying the marker is skipped.

Revision ID: 20260929_0001
Revises: 20260928_0001
"""
import json

import sqlalchemy as sa
from alembic import op

revision = "20260929_0001"
down_revision = "20260928_0001"
branch_labels = None
depends_on = None

# Frozen copy of app/services/slicer_control_service.py.
_DEFAULT_PAGE = "page-1"
_W, _H, _PER_ROW, _GV = 8, 3, 4, 2

_dashboards = sa.table(
    "dashboards",
    sa.column("id", sa.Integer),
    sa.column("slicers_config", sa.JSON),
    sa.column("filters_config", sa.JSON),
    sa.column("public_filters_config", sa.JSON),
    sa.column("pages_config", sa.JSON),
    sa.column("slicer_cluster_layout", sa.JSON),
    sa.column("theme_config", sa.JSON),
    sa.column("draft_snapshot", sa.JSON),
)
_tiles = sa.table(
    "dashboard_charts",
    sa.column("id", sa.Integer),
    sa.column("dashboard_id", sa.Integer),
    sa.column("chart_id", sa.Integer),
    sa.column("widget_type", sa.String),
    sa.column("widget_config", sa.JSON),
    sa.column("layout", sa.JSON),
)


def _json(value):
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return json.loads(value)
        except ValueError:
            return None
    return None


def _list(value):
    v = _json(value)
    return [e for e in v if isinstance(e, dict)] if isinstance(v, list) else []


def _page_of(layout):
    page = layout.get("pageId") if isinstance(layout, dict) else None
    return page.strip() if isinstance(page, str) and page.strip() else _DEFAULT_PAGE


def _visible_on(slicer, page_id):
    if str(slicer.get("scope") or "all") == "custom":
        return bool(((slicer.get("pageScope") or {}).get(page_id) or {}).get("visible"))
    return True


def _entries_for_page(row, page_id, pages):
    slicers = [s for s in _list(row.slicers_config) if s.get("type") != "image" and _visible_on(s, page_id)]
    filters = [f for f in _list(row.filters_config) if str(f.get("publicMode") or "visible") == "visible"]
    legacy = _list(row.public_filters_config) if not slicers and not filters else []
    page = next((p for p in pages if p.get("id") == page_id), None)
    page_slicers = [s for s in _list((page or {}).get("slicers")) if s.get("type") != "image"]
    out, seen = [], set()
    for entry in [*slicers, *filters, *legacy, *page_slicers]:
        sid = str(entry.get("id") or "").strip()
        if sid and sid not in seen:
            seen.add(sid)
            out.append(entry)
    return out


def _hidden(row):
    cluster = _json(row.slicer_cluster_layout) or {}
    dock = cluster.get("position") if isinstance(cluster, dict) else None
    if dock is None:
        theme = _json(row.theme_config) or {}
        dock = theme.get("filterDock") if isinstance(theme, dict) else None
    return str(dock or "") == "hidden"


def _dy(layout, rows):
    gv = layout.get("gv")
    legacy = not (isinstance(gv, (int, float)) and not isinstance(gv, bool) and gv >= _GV)
    return rows // 3 if legacy else rows


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.select(_dashboards)).fetchall()
    for row in rows:
        cluster = _json(row.slicer_cluster_layout)
        cluster = dict(cluster) if isinstance(cluster, dict) else {}
        if isinstance(cluster.get("migratedToGrid"), dict):
            continue
        marker = {"version": 1, "created": [], "shift": {}, "draftShift": {}}
        if _hidden(row):
            marker["hidden"] = True
        else:
            pages = [p for p in _list(row.pages_config) if p.get("id")]
            page_ids = [p["id"] for p in pages] or [_DEFAULT_PAGE]
            tiles = bind.execute(sa.select(_tiles).where(_tiles.c.dashboard_id == row.id)).fetchall()
            images = [e for e in _list(row.slicers_config) if e.get("type") == "image" and e.get("src")]
            snapshot = _json(row.draft_snapshot)
            snapshot = dict(snapshot) if isinstance(snapshot, dict) else None
            for page_id in page_ids:
                on_page = [t for t in tiles if _page_of(_json(t.layout) or {}) == page_id]
                placed = {str((_json(t.widget_config) or {}).get("slicerId") or "") for t in on_page if t.widget_type == "slicer"}
                missing = [e for e in _entries_for_page(row, page_id, pages) if str(e["id"]) not in placed]
                count = len(missing) + len(images)
                if count == 0:
                    continue
                band = ((count + _PER_ROW - 1) // _PER_ROW) * _H
                for tile in on_page:
                    layout = dict(_json(tile.layout) or {})
                    dy = _dy(layout, band)
                    layout["y"] = int(layout.get("y") or 0) + dy
                    bind.execute(_tiles.update().where(_tiles.c.id == tile.id).values(layout=layout))
                    marker["shift"][str(tile.id)] = dy
                # Pending drafts hold whole layouts per editor: move them too, or
                # publishing an old draft would put a tile back under the band.
                if snapshot is not None:
                    maps = []
                    if isinstance(snapshot.get("user_layouts"), dict):
                        maps = [(user, m) for user, m in snapshot["user_layouts"].items() if isinstance(m, dict)]
                    elif isinstance(snapshot.get("layouts"), dict):
                        maps = [("__legacy__", snapshot["layouts"])]
                    for user, m in maps:
                        for tile in on_page:
                            entry = m.get(str(tile.id))
                            if isinstance(entry, dict) and isinstance(entry.get("y"), (int, float)):
                                dy = _dy(entry, band)
                                m[str(tile.id)] = {**entry, "y": int(entry["y"]) + dy}
                                marker["draftShift"].setdefault(user, {})[str(tile.id)] = dy
                cells = [{"x": (i % _PER_ROW) * _W, "y": (i // _PER_ROW) * _H, "w": _W, "h": _H} for i in range(count)]
                for entry, cell in zip(missing, cells):
                    res = bind.execute(_tiles.insert().values(
                        dashboard_id=row.id, chart_id=None, widget_type="slicer",
                        widget_config={"slicerId": str(entry["id"]), "treatment": "auto", "origin": "migration"},
                        layout={**cell, "gv": _GV, "pageId": page_id},
                    ).returning(_tiles.c.id))
                    marker["created"].append(int(res.scalar_one()))
                for entry, cell in zip(images, cells[len(missing):]):
                    res = bind.execute(_tiles.insert().values(
                        dashboard_id=row.id, chart_id=None, widget_type="image",
                        widget_config={"url": str(entry["src"]), "fit": entry.get("fit") or "contain",
                                       **({"alt": entry["alt"]} if entry.get("alt") else {}),
                                       **({"link": entry["link"]} if entry.get("link") else {}),
                                       "transparentBackground": True, "origin": "migration"},
                        layout={**cell, "gv": _GV, "pageId": page_id},
                    ).returning(_tiles.c.id))
                    marker["created"].append(int(res.scalar_one()))
            if snapshot is not None and marker["draftShift"]:
                bind.execute(_dashboards.update().where(_dashboards.c.id == row.id).values(draft_snapshot=snapshot))
        if not marker["created"] and not marker.get("hidden"):
            continue
        cluster["migratedToGrid"] = marker
        bind.execute(_dashboards.update().where(_dashboards.c.id == row.id).values(slicer_cluster_layout=cluster))


def downgrade() -> None:
    bind = op.get_bind()
    for row in bind.execute(sa.select(_dashboards)).fetchall():
        cluster = _json(row.slicer_cluster_layout)
        marker = cluster.get("migratedToGrid") if isinstance(cluster, dict) else None
        if not isinstance(marker, dict):
            continue
        for tile_id in marker.get("created") or []:
            bind.execute(_tiles.delete().where(_tiles.c.id == int(tile_id)))
        for tile_id, dy in (marker.get("shift") or {}).items():
            layout = _json(bind.execute(sa.select(_tiles.c.layout).where(_tiles.c.id == int(tile_id))).scalar())
            if isinstance(layout, dict):
                bind.execute(_tiles.update().where(_tiles.c.id == int(tile_id))
                             .values(layout={**layout, "y": int(layout.get("y") or 0) - int(dy)}))
        if marker.get("draftShift"):
            snapshot = _json(row.draft_snapshot)
            if isinstance(snapshot, dict):
                for user, moves in marker["draftShift"].items():
                    m = snapshot.get("layouts") if user == "__legacy__" else (snapshot.get("user_layouts") or {}).get(user)
                    if not isinstance(m, dict):
                        continue
                    for tile_id, dy in moves.items():
                        entry = m.get(tile_id)
                        if isinstance(entry, dict) and isinstance(entry.get("y"), (int, float)):
                            m[tile_id] = {**entry, "y": int(entry["y"]) - int(dy)}
                bind.execute(_dashboards.update().where(_dashboards.c.id == row.id).values(draft_snapshot=snapshot))
        rest = {k: v for k, v in cluster.items() if k != "migratedToGrid"}
        bind.execute(_dashboards.update().where(_dashboards.c.id == row.id).values(slicer_cluster_layout=rest or None))
