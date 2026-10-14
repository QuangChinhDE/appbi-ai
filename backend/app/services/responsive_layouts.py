"""Authored Tablet / Phone dashboard layouts — the server side.

``dashboards.responsive_layouts`` holds the PUBLISHED device layouts:

    {"version": 1, "pages": {pageId: {"md"|"xs": profile}}}

A profile is a complete CUSTOM layout of one page at one breakpoint in the
36-column grid (``items: {tileId: {x, y, w, h}}``). A page/breakpoint absent
from the document is AUTO: the frontend resolver derives it from the desktop
layout at render time (frontend/src/lib/responsive-layout/resolve.ts). Desktop
geometry is never duplicated here.

Authors edit a per-author draft (``draft_snapshot.user_responsive_layouts``);
only Publish promotes it, with a per page/breakpoint revision check so one
author's layout never silently replaces another's. This module is the
validation authority — the frontend's checks are a convenience.
docs/responsive-dashboard-layouts.md.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Set, Tuple

from app.services.dashboard_service import (
    dashboard_page_ids,
    is_draft_only_item,
    tile_page_id,
)

DOC_VERSION = 1
BREAKPOINTS = ("md", "xs")
CUSTOM_COLS = 36
MAX_ITEMS = 2000
_SOURCES = {"auto-freeze", "regenerate"}
_PROFILE_KEYS = {"mode", "cols", "rev", "generatorVersion", "baseFingerprint", "source", "updatedAt", "updatedBy", "items"}

DRAFT_KEY = "user_responsive_layouts"
BASE_REV_KEY = "user_responsive_base_rev"


class ResponsiveLayoutError(ValueError):
    """A device layout the server refuses (400)."""


def _int(value: Any, what: str) -> int:
    # bool is an int in Python; a cell coordinate is not a boolean.
    if isinstance(value, bool) or not isinstance(value, int):
        raise ResponsiveLayoutError(f"{what} must be an integer")
    return value


def validate_profile(
    payload: Any,
    *,
    page_id: str,
    breakpoint: str,
    page_tile_ids: Set[str],
    dashboard_tile_ids: Set[str],
) -> Dict[str, Any]:
    """The canonical draft entry for one page/breakpoint, or ResponsiveLayoutError.

    ``{"mode": "auto"}`` is the reset marker. A CUSTOM profile must be complete
    and well formed: 36 columns, integer cells inside the grid, no two cells
    overlapping, every tile one of THIS dashboard's tiles on THIS page. Nothing
    is normalised: a payload the frontend and the server would draw differently
    is refused, never repaired.
    """
    if breakpoint not in BREAKPOINTS:
        raise ResponsiveLayoutError(f"unsupported breakpoint '{breakpoint}' (expected md or xs)")
    if not isinstance(payload, dict):
        raise ResponsiveLayoutError("profile must be an object")
    mode = payload.get("mode")
    if mode == "auto":
        if set(payload) - {"mode"}:
            raise ResponsiveLayoutError("the reset marker is exactly {\"mode\": \"auto\"}")
        return {"mode": "auto"}
    if mode != "custom":
        raise ResponsiveLayoutError("mode must be 'custom' or 'auto'")
    unknown = set(payload) - _PROFILE_KEYS
    if unknown:
        raise ResponsiveLayoutError(f"unknown profile keys: {sorted(unknown)}")
    if payload.get("cols") != CUSTOM_COLS or isinstance(payload.get("cols"), bool):
        raise ResponsiveLayoutError(f"cols must be {CUSTOM_COLS}")
    generator = _int(payload.get("generatorVersion"), "generatorVersion")
    if generator < 1:
        raise ResponsiveLayoutError("generatorVersion must be >= 1")
    fingerprint = payload.get("baseFingerprint")
    if not isinstance(fingerprint, str) or not fingerprint or len(fingerprint) > 200:
        raise ResponsiveLayoutError("baseFingerprint must be a non-empty string")
    source = payload.get("source")
    if source not in _SOURCES:
        raise ResponsiveLayoutError(f"source must be one of {sorted(_SOURCES)}")
    items = payload.get("items")
    if not isinstance(items, dict) or not items:
        raise ResponsiveLayoutError("items must be a non-empty object of tile cells")
    if len(items) > MAX_ITEMS:
        raise ResponsiveLayoutError(f"too many items (max {MAX_ITEMS})")
    cells: Dict[str, Dict[str, int]] = {}
    for tile_id, cell in items.items():
        key = str(tile_id)
        if not key.isdigit():
            raise ResponsiveLayoutError(f"item key '{key}' is not a tile id")
        if key not in dashboard_tile_ids:
            raise ResponsiveLayoutError(f"tile {key} is not a tile of this dashboard")
        if key not in page_tile_ids:
            raise ResponsiveLayoutError(f"tile {key} is not on page '{page_id}'")
        if not isinstance(cell, dict) or set(cell) != {"x", "y", "w", "h"}:
            raise ResponsiveLayoutError(f"tile {key}: a cell is exactly {{x, y, w, h}}")
        x, y = _int(cell["x"], f"tile {key} x"), _int(cell["y"], f"tile {key} y")
        w, h = _int(cell["w"], f"tile {key} w"), _int(cell["h"], f"tile {key} h")
        if x < 0 or y < 0:
            raise ResponsiveLayoutError(f"tile {key}: negative position")
        if w < 1 or h < 1:
            raise ResponsiveLayoutError(f"tile {key}: size must be at least 1x1")
        if x + w > CUSTOM_COLS:
            raise ResponsiveLayoutError(f"tile {key}: outside the {CUSTOM_COLS}-column grid")
        cells[key] = {"x": x, "y": y, "w": w, "h": h}
    overlap = first_overlap(cells)
    if overlap:
        raise ResponsiveLayoutError(f"tiles {overlap[0]} and {overlap[1]} overlap")
    return {
        "mode": "custom",
        "cols": CUSTOM_COLS,
        "generatorVersion": generator,
        "baseFingerprint": fingerprint,
        "source": source,
        "items": dict(sorted(cells.items(), key=lambda kv: int(kv[0]))),
    }


def first_overlap(cells: Mapping[str, Mapping[str, int]]) -> Optional[Tuple[str, str]]:
    """The first pair of overlapping cells (sweep by row; O(n log n + k))."""
    ordered = sorted(cells.items(), key=lambda kv: (kv[1]["y"], kv[1]["x"], int(kv[0])))
    for a in range(len(ordered)):
        ida, p = ordered[a]
        for b in range(a + 1, len(ordered)):
            idb, q = ordered[b]
            if q["y"] >= p["y"] + p["h"]:
                break
            if p["x"] < q["x"] + q["w"] and q["x"] < p["x"] + p["w"]:
                return ida, idb
    return None


# ── what the caller's draft sees ─────────────────────────────────────────────

def page_tiles_for_editor(rows: Iterable[Any], *, user_key: str, draft_layouts: Mapping[str, Any], pages_config: Any) -> Tuple[Set[str], Dict[str, Set[str]]]:
    """(every tile id of the dashboard, {pageId: tile ids}) as THIS author's draft
    sees them: live tiles plus their own draft-only tiles (never another
    author's), each on the page its draft layout (else its live layout) names."""
    all_ids: Set[str] = set()
    by_page: Dict[str, Set[str]] = {}
    for row in rows:
        layout = row.layout if isinstance(row.layout, dict) else {}
        if is_draft_only_item(row) and str(layout.get("draftOwner") or user_key) != user_key:
            continue
        rid = str(row.id)
        all_ids.add(rid)
        effective = {**layout, **(draft_layouts.get(rid) or {})}
        by_page.setdefault(tile_page_id(effective, pages_config), set()).add(rid)
    return all_ids, by_page


def caller_draft(snapshot: Any, user_key: str) -> Dict[str, Dict[str, Any]]:
    buckets = snapshot.get(DRAFT_KEY) if isinstance(snapshot, dict) else None
    mine = buckets.get(user_key) if isinstance(buckets, dict) else None
    return {str(p): dict(v) for p, v in mine.items() if isinstance(v, dict)} if isinstance(mine, dict) else {}


def caller_base_revs(snapshot: Any, user_key: str) -> Dict[str, int]:
    buckets = snapshot.get(BASE_REV_KEY) if isinstance(snapshot, dict) else None
    mine = buckets.get(user_key) if isinstance(buckets, dict) else None
    return {str(k): int(v) for k, v in mine.items() if isinstance(v, int) and not isinstance(v, bool)} if isinstance(mine, dict) else {}


def live_rev(doc: Any, page_id: str, breakpoint: str) -> int:
    """The published revision of a page/breakpoint (0 = AUTO, never customised)."""
    profile = ((doc or {}).get("pages") or {}).get(page_id, {}).get(breakpoint) if isinstance(doc, dict) else None
    return int(profile.get("rev") or 0) if isinstance(profile, dict) else 0


def stage_draft(snapshot: Dict[str, Any], user_key: str, page_id: str, breakpoint: str, entry: Dict[str, Any], base_rev: int) -> Dict[str, Any]:
    """The snapshot with this author's draft for one page/breakpoint. The base
    revision is recorded the FIRST time the author drafts that page/breakpoint
    (what they loaded); later saves keep it, so Publish compares against what
    the author actually started from."""
    out = dict(snapshot or {})
    drafts = deepcopy(out.get(DRAFT_KEY) or {})
    mine = dict(drafts.get(user_key) or {})
    page = dict(mine.get(page_id) or {})
    page[breakpoint] = entry
    mine[page_id] = page
    drafts[user_key] = mine
    out[DRAFT_KEY] = drafts
    bases = deepcopy(out.get(BASE_REV_KEY) or {})
    my_bases = dict(bases.get(user_key) or {})
    my_bases.setdefault(f"{page_id}:{breakpoint}", int(base_rev))
    bases[user_key] = my_bases
    out[BASE_REV_KEY] = bases
    return out


def conflicts(doc: Any, snapshot: Any, user_key: str) -> List[str]:
    """Page/breakpoints the caller drafted whose published layout changed since
    they started (another author published it)."""
    bases = caller_base_revs(snapshot, user_key)
    out: List[str] = []
    for page_id, per_bp in caller_draft(snapshot, user_key).items():
        for bp in BREAKPOINTS:
            if bp in per_bp and live_rev(doc, page_id, bp) != bases.get(f"{page_id}:{bp}", 0):
                out.append(f"{page_id}:{bp}")
    return sorted(out)


def promote(doc: Any, snapshot: Any, user_key: str, *, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """The published document with the caller's draft applied: a CUSTOM draft
    replaces its page/breakpoint (revision bumped); a reset marker removes it."""
    out = deepcopy(doc) if isinstance(doc, dict) else {}
    out["version"] = DOC_VERSION
    pages = dict(out.get("pages") or {})
    stamp = (now or datetime.now(timezone.utc)).isoformat()
    for page_id, per_bp in caller_draft(snapshot, user_key).items():
        page = dict(pages.get(page_id) or {})
        for bp in BREAKPOINTS:
            if bp not in per_bp:
                continue
            entry = per_bp[bp]
            if not isinstance(entry, dict) or entry.get("mode") != "custom":
                page.pop(bp, None)
                continue
            page[bp] = {**entry, "rev": live_rev(doc, page_id, bp) + 1, "updatedAt": stamp, "updatedBy": user_key}
        if page:
            pages[page_id] = page
        else:
            pages.pop(page_id, None)
    out["pages"] = pages
    return out if pages else None


def prune(doc: Any, *, pages_config: Any, published_rows: Iterable[Any]) -> Optional[Dict[str, Any]]:
    """Drop what no longer exists: profiles of deleted pages, items of tiles no
    longer published on that page. A profile left with no items is AUTO again."""
    if not isinstance(doc, dict):
        return None
    page_ids = set(dashboard_page_ids(pages_config))
    on_page: Dict[str, Set[str]] = {}
    for row in published_rows:
        if is_draft_only_item(row):
            continue
        on_page.setdefault(tile_page_id(row.layout if isinstance(row.layout, dict) else {}, pages_config), set()).add(str(row.id))
    pages: Dict[str, Any] = {}
    for page_id, per_bp in (doc.get("pages") or {}).items():
        if page_id not in page_ids or not isinstance(per_bp, dict):
            continue
        kept: Dict[str, Any] = {}
        for bp in BREAKPOINTS:
            profile = per_bp.get(bp)
            if not isinstance(profile, dict) or not isinstance(profile.get("items"), dict):
                continue
            items = {k: v for k, v in profile["items"].items() if k in on_page.get(page_id, set())}
            if items:
                kept[bp] = {**profile, "items": items}
        if kept:
            pages[page_id] = kept
    return {"version": DOC_VERSION, "pages": pages} if pages else None


def drop_caller(snapshot: Any, user_key: str) -> Dict[str, Any]:
    """The snapshot without this author's responsive draft (others' kept)."""
    out = dict(snapshot or {})
    for key in (DRAFT_KEY, BASE_REV_KEY):
        buckets = out.get(key)
        if isinstance(buckets, dict):
            others = {k: v for k, v in buckets.items() if k != user_key}
            if others:
                out[key] = others
            else:
                out.pop(key, None)
    return out


def remap(doc: Any, id_map: Mapping[str, str]) -> Optional[Dict[str, Any]]:
    """A copied dashboard's document: item keys rewritten to the copy's tile ids;
    items of tiles that were not copied are dropped."""
    if not isinstance(doc, dict):
        return None
    pages: Dict[str, Any] = {}
    for page_id, per_bp in (doc.get("pages") or {}).items():
        if not isinstance(per_bp, dict):
            continue
        kept: Dict[str, Any] = {}
        for bp in BREAKPOINTS:
            profile = per_bp.get(bp)
            if not isinstance(profile, dict) or not isinstance(profile.get("items"), dict):
                continue
            items = {id_map[str(k)]: v for k, v in profile["items"].items() if str(k) in id_map}
            if items:
                # A copy starts its own history: no source author, no source time.
                kept[bp] = {**{k: v for k, v in profile.items() if k not in ("updatedBy", "updatedAt")}, "items": items, "rev": 1}
        if kept:
            pages[page_id] = kept
    return {"version": DOC_VERSION, "pages": pages} if pages else None


def public_view(doc: Any, *, served_page_ids: Iterable[str], published_tile_ids: Set[str]) -> Optional[Dict[str, Any]]:
    """What a public/embed viewer gets: the published layouts of the served
    pages, items of published tiles only — no author identity, no revision, no
    provenance (nothing a viewer's renderer needs)."""
    if not isinstance(doc, dict):
        return None
    served = set(served_page_ids)
    pages: Dict[str, Any] = {}
    for page_id, per_bp in (doc.get("pages") or {}).items():
        if page_id not in served or not isinstance(per_bp, dict):
            continue
        kept: Dict[str, Any] = {}
        for bp in BREAKPOINTS:
            profile = per_bp.get(bp)
            if not isinstance(profile, dict) or profile.get("mode") != "custom" or not isinstance(profile.get("items"), dict):
                continue
            items = {k: v for k, v in profile["items"].items() if k in published_tile_ids}
            if items:
                kept[bp] = {"mode": "custom", "cols": CUSTOM_COLS, "generatorVersion": profile.get("generatorVersion"),
                            "items": items}
        if kept:
            pages[page_id] = kept
    return {"version": DOC_VERSION, "pages": pages} if pages else None
