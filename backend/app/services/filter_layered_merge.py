"""Layered filter merge with explicit precedence (Phase-B, PBI rework).

Single source of truth for combining the seven filter sources that a
chart-data query has to honor. Each source is tagged so downstream
diagnostics can trace where a filter came from.

See `docs/filter-semantics.md` §3 for the spec.

Order of precedence (later layers override earlier ones on the same
dedupe key — `link_locked` wins everything):

    chart_base
    dashboard_filter        (public_mode != 'hidden')
    dashboard_slicer
    viewer_slicer           (session, public mode)
    viewer_filter           (mini-pane overrides, public mode)
    link_locked             (DashboardPublicLink.filters_config, authoritative)
    link_hidden             (drops the field entirely — neither slicer nor banner)

`link_hidden` is special: it does not contribute a value; it removes
all entries with the same dedupe key from the merged output. The viewer
ends up with no UI for that field at all.

`visual_level` is reserved for future per-chart filter pane work — not
in the current layer set.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from app.services.chart_contracts import (
    FILTER_DROP_LINK_HIDDEN,
    _filter_dedupe_key,
    _record_dropped_filter,
    normalize_filter_conditions,
)


# Public source labels — keep stable, FE / analytics may key on these.
LAYER_CHART_BASE = "chart_base"
LAYER_DASHBOARD_FILTER = "dashboard_filter"              # publicMode=visible defaults
LAYER_DASHBOARD_SLICER = "dashboard_slicer"              # slicer defaults
LAYER_VIEWER_SLICER = "viewer_slicer"                    # viewer's interactive choice
LAYER_VIEWER_FILTER = "viewer_filter"                    # viewer mini-pane override
LAYER_DASHBOARD_FILTER_LOCKED = "dashboard_filter_locked"  # publicMode=locked/hidden — authoritative
LAYER_LINK_LOCKED = "link_locked"                        # per-link locked — most authoritative
LAYER_LINK_HIDDEN = "link_hidden"                        # drop field entirely

# Canonical priority order (Phase-H, PBI/RLS model). Walk this exact
# list; later layers override earlier ones on the same field key.
#
#   defaults (overridable by viewer):
#     chart_base < dashboard_filter(visible) < dashboard_slicer
#   viewer's interactive choice:
#     < viewer_slicer < viewer_filter
#   ── "locked" boundary — author-enforced, viewer CANNOT relax ──
#     < dashboard_filter_locked (publicMode locked/hidden) < link_locked
#   field removal:
#     + link_hidden (drops the field from the output)
#
# Key fix vs the original order: locked/hidden dashboard filters now sit
# ABOVE the viewer layers, so a slicer or viewer choice on the same
# field can no longer relax an author lock.
_LAYER_ORDER: tuple[str, ...] = (
    LAYER_CHART_BASE,
    LAYER_DASHBOARD_FILTER,
    LAYER_DASHBOARD_SLICER,
    LAYER_VIEWER_SLICER,
    LAYER_VIEWER_FILTER,
    LAYER_DASHBOARD_FILTER_LOCKED,
    LAYER_LINK_LOCKED,
    LAYER_LINK_HIDDEN,
)


@dataclass
class FilterLayer:
    """One named filter source contributing to a chart query.

    `source` must be one of the LAYER_* constants. `entries` are raw
    filter dicts (the `Dict[str, Any]` wire shape used everywhere else
    in the codebase). The merger normalizes them through
    `normalize_filter_conditions()` so callers don't have to.
    """

    source: str
    entries: List[Dict[str, Any]] = field(default_factory=list)


def merge_layered_filters(
    layers: Sequence[FilterLayer],
    *,
    diagnostics: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Merge filter layers according to the spec precedence.

    `diagnostics` (when provided) receives one entry per filter dropped
    by a `link_hidden` rule, using
    `FILTER_DROP_LINK_HIDDEN` as the reason. Other drops (no_field,
    empty_value) come from `normalize_filter_conditions` and reuse its
    diagnostic vocabulary.

    Returns a list of dicts ready to forward to the chart engine. Each
    surviving entry gets a `_layer_source` key so downstream code can
    log "this WHERE came from `link_locked`" without re-deriving.
    """

    by_source: Dict[str, List[Dict[str, Any]]] = {key: [] for key in _LAYER_ORDER}
    for layer in layers:
        if layer.source not in by_source:
            # Unknown source label — ignore rather than crash. New
            # sources should be added to _LAYER_ORDER explicitly.
            continue
        by_source[layer.source].extend(layer.entries or [])

    # Walk in canonical order. Maintain an ordered dict-like merged
    # state keyed by dedupe key; later layers overwrite earlier ones.
    merged: Dict[tuple, Dict[str, Any]] = {}
    for source in _LAYER_ORDER:
        if source == LAYER_LINK_HIDDEN:
            # Hidden entries don't add a filter — they remove existing
            # ones (see below) and are handled in the second pass.
            continue
        normalized = normalize_filter_conditions(
            by_source.get(source) or [],
            diagnostics=diagnostics,
        )
        for entry in normalized:
            tagged = {**entry, "_layer_source": source}
            merged[_filter_dedupe_key(entry)] = tagged

    # Apply link_hidden: drop any merged entry whose FIELD matches a
    # hidden marker. After Phase-B' the standard `_filter_dedupe_key`
    # is already operator-agnostic, so we use it directly here too —
    # one key shape across the entire pipeline.
    hidden_field_keys: set[tuple] = set()
    for hidden_entry in by_source.get(LAYER_LINK_HIDDEN) or []:
        if not isinstance(hidden_entry, dict) or not hidden_entry.get("field"):
            continue
        hidden_field_keys.add(_filter_dedupe_key(hidden_entry))

    if hidden_field_keys:
        survivors: Dict[tuple, Dict[str, Any]] = {}
        for key, entry in merged.items():
            if _filter_dedupe_key(entry) in hidden_field_keys:
                if diagnostics is not None:
                    _record_dropped_filter(
                        diagnostics,
                        entry,
                        FILTER_DROP_LINK_HIDDEN,
                        "public link hid this field",
                    )
                continue
            survivors[key] = entry
        merged = survivors

    return list(merged.values())


def split_filters_by_layer_source(
    merged: Sequence[Dict[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:
    """Bucket a merged filter list by `_layer_source` for diagnostics.

    Useful in tests and in the chart-data response shape so the FE can
    show "1 filter from link, 2 from viewer slicer" without inferring."""
    out: Dict[str, List[Dict[str, Any]]] = {}
    for entry in merged or []:
        source = str(entry.get("_layer_source") or "unknown")
        out.setdefault(source, []).append(entry)
    return out


# ---------------------------------------------------------------------------
# Convenience constructors
# ---------------------------------------------------------------------------

def make_dashboard_layers(
    *,
    chart_base: Optional[List[Dict[str, Any]]] = None,
    dashboard_filters: Optional[List[Dict[str, Any]]] = None,
    dashboard_filters_locked: Optional[List[Dict[str, Any]]] = None,
    dashboard_slicers: Optional[List[Dict[str, Any]]] = None,
    viewer_slicers: Optional[List[Dict[str, Any]]] = None,
) -> List[FilterLayer]:
    """Layers active in INTERNAL viewing (editor preview, no public link).

    Same precedence as public minus the link layers. `viewer_slicers`
    carries the author's currently-applied slicer/filter selections in
    the editor preview, so locked dashboard filters still win over them
    (parity with public).
    """
    return [
        FilterLayer(LAYER_CHART_BASE, chart_base or []),
        FilterLayer(LAYER_DASHBOARD_FILTER, dashboard_filters or []),
        FilterLayer(LAYER_DASHBOARD_SLICER, dashboard_slicers or []),
        FilterLayer(LAYER_VIEWER_SLICER, viewer_slicers or []),
        FilterLayer(LAYER_DASHBOARD_FILTER_LOCKED, dashboard_filters_locked or []),
    ]


def make_public_layers(
    *,
    chart_base: Optional[List[Dict[str, Any]]] = None,
    dashboard_filters: Optional[List[Dict[str, Any]]] = None,
    dashboard_filters_locked: Optional[List[Dict[str, Any]]] = None,
    dashboard_slicers: Optional[List[Dict[str, Any]]] = None,
    viewer_slicers: Optional[List[Dict[str, Any]]] = None,
    viewer_filters: Optional[List[Dict[str, Any]]] = None,
    link_locked: Optional[List[Dict[str, Any]]] = None,
    link_hidden: Optional[List[Dict[str, Any]]] = None,
) -> List[FilterLayer]:
    """Layers active for a PUBLIC viewer fetching chart data.

    `dashboard_filters` = publicMode=visible defaults (overridable).
    `dashboard_filters_locked` = publicMode locked/hidden (authoritative,
    above the viewer layers — viewer can't relax them).
    """
    return [
        FilterLayer(LAYER_CHART_BASE, chart_base or []),
        FilterLayer(LAYER_DASHBOARD_FILTER, dashboard_filters or []),
        FilterLayer(LAYER_DASHBOARD_SLICER, dashboard_slicers or []),
        FilterLayer(LAYER_VIEWER_SLICER, viewer_slicers or []),
        FilterLayer(LAYER_VIEWER_FILTER, viewer_filters or []),
        FilterLayer(LAYER_DASHBOARD_FILTER_LOCKED, dashboard_filters_locked or []),
        FilterLayer(LAYER_LINK_LOCKED, link_locked or []),
        FilterLayer(LAYER_LINK_HIDDEN, link_hidden or []),
    ]


def split_dashboard_filters_by_public_mode(
    items: Sequence[Dict[str, Any]],
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Split `Dashboard.filters_config` into (visible_defaults, authoritative).

    - visible_defaults: publicMode == 'visible' (or unset). Low-precedence
      defaults the viewer can override via a slicer/mini-pane.
    - authoritative: publicMode in {'locked', 'hidden'}. High-precedence;
      the viewer cannot relax them. (Hidden ones additionally aren't
      rendered — the FE already excludes them from the slicer seed.)

    Reads both camelCase `publicMode` and legacy `public_mode`.
    """
    visible: List[Dict[str, Any]] = []
    authoritative: List[Dict[str, Any]] = []
    for raw in items or []:
        if not isinstance(raw, dict):
            continue
        mode = str(raw.get("publicMode") or raw.get("public_mode") or "visible").lower()
        if mode in ("locked", "hidden"):
            authoritative.append(raw)
        else:
            visible.append(raw)
    return visible, authoritative


# ---------------------------------------------------------------------------
# Filter-pane to merge-ready transform
# ---------------------------------------------------------------------------

def filters_to_merge_entries(
    items: Sequence[Dict[str, Any]],
    *,
    skip_public_modes: Optional[Sequence[str]] = None,
) -> List[Dict[str, Any]]:
    """Convert raw filter-pane entries (with `public_mode` markers) into
    plain merge entries, optionally dropping by `public_mode`.

    Use cases:
      * Public viewer chart-data path passes `skip_public_modes=('hidden',)`
        to ensure hidden filter-pane entries never reach the chart but
        the layer order still applies them as the dashboard's default
        scope.  (For internal viewing, pass nothing — author always
        sees their own state.)
      * Link manager dialog uses no skip so the editor sees everything
        the dashboard owns.

    Entries with `publicMode == 'locked'` are returned as-is — the
    public endpoint pairs them with `link_locked` layer at the top of
    precedence. Their value behaves as the dashboard's default scope
    until and unless the link manager overrides per-link.

    Reads both `publicMode` (canonical camelCase) and the legacy
    `public_mode` snake_case key so older payloads still work.
    """
    skip = set(skip_public_modes or ())
    out: List[Dict[str, Any]] = []
    for raw in items or []:
        if not isinstance(raw, dict):
            continue
        mode = raw.get("publicMode") or raw.get("public_mode") or "visible"
        if str(mode) in skip:
            continue
        out.append(raw)
    return out


def split_link_filters_locked_vs_hidden(
    items: Sequence[Dict[str, Any]],
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Split `DashboardPublicLink.filters_config` into (locked, hidden).

    Hidden entries carry `hidden=True` and contribute to the kill list
    in the merger. Locked entries carry a value and override.
    Anything not matching either shape is treated as locked-by-default
    (legacy compatibility — pre-Phase-B link filter entries had no
    `hidden` field).
    """
    locked: List[Dict[str, Any]] = []
    hidden: List[Dict[str, Any]] = []
    for raw in items or []:
        if not isinstance(raw, dict):
            continue
        if bool(raw.get("hidden")):
            hidden.append(raw)
        else:
            locked.append(raw)
    return locked, hidden


# ---------------------------------------------------------------------------
# Single source of truth for "what does a public-link entry constrain".
#
# Both the chart-data merge (api/public.py:_build_public_chart_filters) and the
# structure-response strip (api/public.py:_get_share_dashboard) must agree on
# this, or they drift: the merge would drop an empty `in []` lock as a no-op
# while the strip would still remove the field's slicer + page-filter — leaking
# MORE data than the page scope (the dashboard-53 empty-lock leak, 2026-06).
# Keep this the ONLY implementation; callers must not re-derive it.
# ---------------------------------------------------------------------------

def link_entry_has_value(entry: Dict[str, Any]) -> bool:
    """True when a public-link filter entry carries an enforceable value.

    An ``in []`` / empty-list / empty-string / null value enforces nothing —
    ``normalize_filter_conditions`` drops it with the ``empty_value`` diagnostic
    inside ``merge_layered_filters``. Used to decide both (a) whether a hidden
    entry should be promoted to the authoritative locked layer, and (b) whether
    a locked field is "managed" (see ``link_managed_field_keys``).
    """
    if not isinstance(entry, dict):
        return False
    v = entry.get("value")
    if isinstance(v, (list, tuple, dict)):
        return len(v) > 0
    return v not in (None, "")


def link_managed_field_keys(
    link_filters_config: Optional[Sequence[Dict[str, Any]]],
) -> set[str]:
    """Field keys the public viewer must NOT be able to control on this link.

    A field is "managed" — its slicer and any same-field page/dashboard filter
    are stripped from the served structure and the viewer gets no editable
    control — exactly when the link ENFORCES or KILLS it:

      - any entry carrying a value (``link_entry_has_value``) → enforced
        (locked-with-value, or hidden-with-value which the merge promotes to
        the locked layer), OR
      - an explicit hidden kill entry (``hidden=True``) → field dropped
        entirely (filter-semantics.md §2.3).

    A LOCKED entry with an EMPTY value enforces nothing, so it is deliberately
    NOT managed: the field keeps its page-scope filter + interactive slicer
    (an empty lock behaves like no lock — the safe no-op).

    Keys are normalized to ``(semanticField or field).strip().lower()`` to
    match the strip sites in the public dashboard serializer.
    """
    keys: set[str] = set()
    for entry in link_filters_config or []:
        if not isinstance(entry, dict):
            continue
        raw_key = entry.get("semanticField") or entry.get("field") or ""
        key = str(raw_key).strip().lower()
        if not key:
            continue
        if link_entry_has_value(entry) or bool(entry.get("hidden")):
            keys.add(key)
    return keys
