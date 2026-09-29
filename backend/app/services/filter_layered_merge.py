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
LAYER_PAGE_SCOPE = "page_scope"                          # pages_config[p].filters — hard bound, applied after the merge
LAYER_LINK_SCOPE = "link_scope"                          # per-link 'limit' allow-list — hard bound

# Layers a viewer can never relax. A hard bound on the same field ANDs with
# these instead of intersecting-with-fallback (a fallback could widen a lock).
_AUTHORITATIVE_SOURCES = frozenset({LAYER_DASHBOARD_FILTER_LOCKED, LAYER_LINK_LOCKED, LAYER_LINK_SCOPE})

#: Marker on a merged entry whose field/value must never be shown to a public
#: viewer or handed to a model that answers one (a 🚫 hidden constraint). The
#: entry is still ENFORCED; only its disclosure is withheld.
DISCLOSE_KEY = "_disclose"

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

LINK_ENTRY_ENFORCED = "enforced"
LINK_ENTRY_EMPTY = "empty"
LINK_ENTRY_MALFORMED = "malformed"


def _carries_a_constraint(entry: Dict[str, Any]) -> bool:
    """The author put SOMETHING in this entry: a value, or a relative-date preset.

    Item-wise: a cleared range ``["", ""]``, ``[""]`` or ``[None]`` holds nothing
    — the "nothing picked" no-op, not a malformed lock. A whitespace-only string
    was typed, so it counts (the engine rejects it: malformed, fail closed).
    """
    v = entry.get("value")
    if isinstance(v, (list, tuple)):
        has_value = any(x is not None and x != "" for x in v)
    elif isinstance(v, dict):
        has_value = len(v) > 0
    else:
        has_value = v not in (None, "")
    preset = str(entry.get("datePreset") or entry.get("date_preset") or "").strip().lower()
    return has_value or bool(preset and preset != "custom")


def canonical_link_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    """A link entry in the shape the chart engine reads.

    The engine keys a condition on ``field`` (and infers ``semanticField`` from a
    qualified ``field``, chart_service); the reverse was missing. A workboard-
    managed link stores ``{datasetId, semanticField, operator, value}`` with no
    ``field`` — so its role row-filter was dropped as ``no_field`` and every role
    saw every row. Fill ``field`` from a qualified ``semanticField``.
    """
    if not isinstance(entry, dict) or entry.get("field"):
        return entry
    sem = entry.get("semanticField")
    if isinstance(sem, str) and "." in sem.strip():
        return {**entry, "field": sem.strip()}
    return entry


def link_entry_state(entry: Dict[str, Any]) -> str:
    """What a public-link entry does, decided by the chart engine's own chokepoint.

      - ``enforced``: ``normalize_filter_conditions`` keeps it — it constrains the
        data exactly as the engine applies it (an ``is_null`` lock with no value,
        a relative-date preset with no frozen value, a scalar ``in "SP"``).
      - ``empty``: the author put nothing in it (no value, no preset). The
        documented no-op: an empty lock behaves like no lock, and an empty
        hidden entry is the field kill-marker (dashboard-53, 2026-06).
      - ``malformed``: it carries a value or preset the engine cannot apply
        (``between 5``, ``in 5``, an unknown preset). The author meant to
        constrain and nothing would be applied, so the link must fail CLOSED
        (see ``malformed_link_entries``) — never serve the unconstrained data.

    A 'limit' scope entry is judged as the allow-list it is (``in`` over its
    values, scalars accepted) — the operator the scope bound applies.
    """
    if not isinstance(entry, dict):
        return LINK_ENTRY_EMPTY
    entry = canonical_link_entry(entry)
    if link_entry_is_scope(entry):
        return LINK_ENTRY_ENFORCED if _to_allow_list(entry.get("value")) else LINK_ENTRY_EMPTY
    op = str(entry.get("operator") or "").strip().lower()
    if not _carries_a_constraint(entry) and op not in ("is_null", "is_not_null"):
        # Nothing picked (``[]``, ``""``, ``{}``, no value): the no-op, however
        # the engine would read the empty container.
        return LINK_ENTRY_EMPTY
    if normalize_filter_conditions([entry]):
        return LINK_ENTRY_ENFORCED
    return LINK_ENTRY_MALFORMED if _carries_a_constraint(entry) else LINK_ENTRY_EMPTY


def link_entry_has_value(entry: Dict[str, Any]) -> bool:
    """True when a public-link entry ENFORCES a constraint (``link_entry_state``).

    The single rule shared by the structure strip (``link_managed_field_keys``),
    the hidden→locked promotion and the scope bound — so what the page hides,
    what the engine applies and what the reader is told can never disagree.
    Before, this looked at the raw value only: a ``between 5`` lock stripped the
    field's slicer and page filter while the engine dropped the lock itself
    (wider data than the page scope), and an ``is_null`` lock kept an
    interactive slicer that silently did nothing.
    """
    return link_entry_state(entry) == LINK_ENTRY_ENFORCED


def malformed_link_entries(
    link_filters_config: Optional[Sequence[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Entries of a link that mean to constrain but cannot be applied.

    A public request under such a link is refused (fail closed) and a link
    carrying one cannot be saved — the alternative is serving data the author
    meant to restrict.
    """
    return [
        e for e in (link_filters_config or [])
        if isinstance(e, dict) and link_entry_state(e) == LINK_ENTRY_MALFORMED
    ]


def _to_allow_list(value: Any) -> List[str]:
    if isinstance(value, (list, tuple)):
        return [str(x) for x in value if x not in (None, "")]
    return [str(value)] if value not in (None, "") else []


def link_entry_is_scope(entry: Dict[str, Any]) -> bool:
    """True when a link entry is a 'limit' (allow-list scope), not a lock/hide.

    A scope entry keeps the field's slicer INTERACTIVE on the public link but
    bounds the viewer's selectable values + the chart data to an allow-list
    (intersect) — the per-link equivalent of a page-scope hard bound. The
    author picks e.g. RC01/RC02/RC03 of the 5 RCs; the viewer can still toggle
    among those three but never reaches RC04/RC05.

    Distinguished on the wire by ``limit=True`` and NOT ``hidden`` (a hidden
    entry always kills/enforces and takes precedence). A scope entry is only
    meaningful when it carries values — an empty allow-list bounds nothing.
    """
    if not isinstance(entry, dict):
        return False
    return bool(entry.get("limit")) and not bool(entry.get("hidden"))


def apply_link_scope_bounds(
    merged: List[Dict[str, Any]],
    scope_entries: Optional[Sequence[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Bound merged viewer filters by per-link 'limit' allow-lists.

    Runs AFTER ``merge_layered_filters``. For each scope (limit) entry the
    field stays an interactive slicer, but the viewer's effective selection is
    intersected with the allow-list:

      - viewer picked value(s) inside the list → kept (narrowed),
      - viewer picked outside the list, or picked nothing → falls back to the
        full allow-list.

    Mirrors the FE ``applyScopeBound`` and the page-scope hard bound, but is
    enforced SERVER-SIDE so a crafted request can never escape the allow-list.
    """
    scopes = [
        e for e in (scope_entries or [])
        if link_entry_is_scope(e) and link_entry_has_value(e)
    ]
    if not scopes:
        return list(merged)

    _to_list = _to_allow_list

    out: List[Dict[str, Any]] = list(merged)
    out_by_key: Dict[tuple, Dict[str, Any]] = {}
    for entry in out:
        out_by_key.setdefault(_filter_dedupe_key(entry), entry)

    for scope in scopes:
        allow = _to_list(scope.get("value"))
        if not allow:
            continue
        key = _filter_dedupe_key(scope)
        existing = out_by_key.get(key)
        if existing is None:
            # Viewer + dashboard picked nothing on this field → apply the
            # allow-list itself as the bound.
            bounded = {
                **scope,
                "operator": "in",
                "value": allow,
                "_layer_source": LAYER_LINK_SCOPE,
            }
            out.append(bounded)
            out_by_key[key] = bounded
            continue
        op = str(existing.get("operator") or "").lower()
        if op == "in":
            selected = _to_list(existing.get("value"))
            intersection = [x for x in selected if x in allow]
            existing["value"] = intersection if intersection else allow
        else:
            # A non-list selection on a limited field can't be intersected
            # meaningfully — replace it with the allow-list bound.
            existing["operator"] = "in"
            existing["value"] = allow
        existing["_layer_source"] = LAYER_LINK_SCOPE
    return out


# ---------------------------------------------------------------------------
# Page scope — enforced by the SERVER, not by what the client chose to send.
# ---------------------------------------------------------------------------

DEFAULT_PAGE_ID = "page-1"


def _public_mode(entry: Dict[str, Any]) -> str:
    return str(entry.get("publicMode") or entry.get("public_mode") or "visible").lower()


def page_scope_bounds(
    pages_config: Optional[Sequence[Dict[str, Any]]],
    page_ids: Sequence[str],
    *,
    exclude_field_keys: Optional[set[str]] = None,
    dataset_id: Any = None,
) -> List[Dict[str, Any]]:
    """The hard bounds a page puts on the data of the charts drawn on it.

    ``pages_config[p].filters`` ("filters on this page") are the author's
    scope for that page. On a public link they used to reach the query only
    because the viewer's page SENT them — a crafted request that left them out
    got data beyond the page, and a page filter marked 🔒/🚫 was dropped by the
    client and applied by nobody. They are now resolved here, from the stored
    dashboard, for the page(s) the chart is on.

    Every publicMode applies (visible/locked/hidden only decide disclosure; a
    🚫 entry is tagged ``_disclose: False``). Entries the engine drops (empty,
    invalid) are dropped here too — the builder drops them the same way.
    Fields in ``exclude_field_keys`` (``link_replaced_field_keys``: the link's
    condition replaces the page filter, as the served structure already shows)
    are skipped. A filter on ANOTHER dataset than the chart's (``dataset_id``)
    does not bound it — the engine could not apply it (the builder skips it the
    same way). With several page ids the bounds of every page apply (AND).
    """
    wanted = {str(p).strip() for p in page_ids}
    exclude = exclude_field_keys or set()
    raw: List[Dict[str, Any]] = []
    for page in pages_config or []:
        if not isinstance(page, dict) or str(page.get("id") or "").strip() not in wanted:
            continue
        for f in page.get("filters") or []:
            if not isinstance(f, dict):
                continue
            key = str(f.get("semanticField") or f.get("field") or "").strip().lower()
            if key and key in exclude:
                continue
            if dataset_id is not None and f.get("datasetId") not in (None, "") and str(f.get("datasetId")) != str(dataset_id):
                continue
            raw.append({**f, "_layer_source": LAYER_PAGE_SCOPE, DISCLOSE_KEY: _public_mode(f) != "hidden"})
    return normalize_filter_conditions(raw)


def apply_page_scope_bounds(
    merged: List[Dict[str, Any]],
    bounds: Optional[Sequence[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Bound merged filters by page scope — the server twin of the client's
    ``applyScopeBound``.

    Same field, both ``in`` lists, the existing one a viewer/default choice:
    one filter = choice ∩ scope, an empty intersection falling back to the
    scope (an out-of-scope pick is ignored, never escapes, never shows "all").
    Anything else is ANDed (the engine keeps every runtime filter): never
    wider than the scope. An authoritative lock on the same field is never
    intersected-with-fallback (that could widen the lock) — it is ANDed.
    """
    out: List[Dict[str, Any]] = [dict(e) for e in merged]
    for bound in bounds or []:
        key = _filter_dedupe_key(bound)
        idx = next(
            (i for i, e in enumerate(out)
             if _filter_dedupe_key(e) == key
             and e.get("_layer_source") not in _AUTHORITATIVE_SOURCES
             and e.get("_layer_source") != LAYER_PAGE_SCOPE),
            None,
        )
        if (idx is not None and str(bound.get("operator")) == "in"
                and str(out[idx].get("operator") or "").lower() == "in"):
            allow = _to_allow_list(bound.get("value"))
            picked = [v for v in (out[idx].get("value") or []) if str(v) in set(allow)]
            out[idx] = {
                **out[idx],
                "value": picked if picked else list(bound.get("value") or []),
                "_layer_source": LAYER_PAGE_SCOPE,
                DISCLOSE_KEY: out[idx].get(DISCLOSE_KEY, True) is not False and bound.get(DISCLOSE_KEY) is not False,
            }
            continue
        out.append(dict(bound))
    return out


def same_field_allow_list(
    filters: Optional[Sequence[Dict[str, Any]]],
    dataset_id: Any,
    field_ref: str,
) -> Optional[set[str]]:
    """Values a hard ``in`` bound on ``field_ref`` allows (None: unbounded).

    A slicer's dropdown self-strips its own field (so the cascade cannot pin
    it), which also drops any HARD bound on that field — page scope, a 🔒/🚫
    dashboard filter. The distinct endpoint re-applies them to the returned
    values with this, the way it already does for a link 'limit' scope.
    """
    ref = str(field_ref or "").strip().lower()
    allowed: Optional[set[str]] = None
    for f in filters or []:
        if not isinstance(f, dict) or str(f.get("operator") or "").lower() != "in":
            continue
        if f.get("_layer_source") not in (_AUTHORITATIVE_SOURCES | {LAYER_PAGE_SCOPE}):
            continue
        if dataset_id is not None and f.get("datasetId") not in (None, "") and str(f.get("datasetId")) != str(dataset_id):
            continue
        keys = {str(f.get(k) or "").strip().lower() for k in ("semanticField", "fieldKey", "field")}
        if ref not in keys:
            continue
        vals = set(_to_allow_list(f.get("value")))
        allowed = vals if allowed is None else (allowed & vals)
    return allowed


# ---------------------------------------------------------------------------
# Disclosure — what a public viewer (or a model answering one) may be told.
# ---------------------------------------------------------------------------

def filter_is_disclosable(entry: Dict[str, Any]) -> bool:
    return isinstance(entry, dict) and entry.get(DISCLOSE_KEY) is not False


def disclosable_filters(
    filters: Optional[Sequence[Dict[str, Any]]],
) -> tuple[List[Dict[str, Any]], int]:
    """(entries that may be named, count of withheld ones).

    Enforcement uses the full list; anything that SAYS which filters ran — a
    tool result, a scope note, a banner — uses this projection, so a 🚫 hidden
    constraint is applied and never named. The withheld count lets an answer
    say "restricted by the report author" without saying how.
    """
    shown: List[Dict[str, Any]] = []
    withheld = 0
    for f in filters or []:
        if not isinstance(f, dict):
            continue
        if filter_is_disclosable(f):
            shown.append(f)
        else:
            withheld += 1
    return shown, withheld


def disclosed_applied_filters(filters: Any) -> tuple[List[Dict[str, Any]], int]:
    """``disclosable_filters`` for a tool result: the nameable entries without
    internal markers, and the withheld count. Takes the ENFORCED list of any
    context (``getattr(ctx, "public_filters", None)``) — tools run on duck-typed
    contexts too, so this is a function, not a method."""
    shown, withheld = disclosable_filters(filters if isinstance(filters, list) else [])
    return [{k: v for k, v in f.items() if not str(k).startswith("_")} for f in shown], withheld


def public_viewer_visible_entries(
    items: Optional[Sequence[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Filter-pane entries a public viewer may be SERVED: every mode but 🚫.

    A 🔒 entry is served (read-only, it is announced); a 🚫 entry is enforced
    from the stored dashboard and never leaves the server.
    """
    return [e for e in (items or []) if isinstance(e, dict) and _public_mode(e) != "hidden"]


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

    A 'limit' (allow-list scope) entry is ALSO deliberately NOT managed: the
    whole point is that the slicer stays interactive (bounded, not removed).
    ``apply_link_scope_bounds`` enforces the allow-list on the data instead.

    Keys are normalized to ``(semanticField or field).strip().lower()`` to
    match the strip sites in the public dashboard serializer.
    """
    keys: set[str] = set()
    for entry in link_filters_config or []:
        if not isinstance(entry, dict):
            continue
        if link_entry_is_scope(entry):
            continue
        raw_key = entry.get("semanticField") or entry.get("field") or ""
        key = str(raw_key).strip().lower()
        if not key:
            continue
        if link_entry_has_value(entry) or bool(entry.get("hidden")):
            keys.add(key)
    return keys


def link_replaced_field_keys(
    link_filters_config: Optional[Sequence[Dict[str, Any]]],
) -> set[str]:
    """Fields where the link's condition REPLACES the page's own filter.

    A lock carrying a value ("Region = South") is the author's per-link answer
    for that field: it replaces the page filter on it, as it always has (the page
    filter is not served either). A kill-marker removes the field outright.
    Any other enforced lock — ``is_null``, a relative-date preset without a
    value — only adds a condition: the page filter stays and they AND. (Treating
    those as replacing would widen the data past the page scope.)
    """
    keys: set[str] = set()
    for entry in link_filters_config or []:
        if not isinstance(entry, dict) or link_entry_is_scope(entry):
            continue
        entry = canonical_link_entry(entry)
        key = str(entry.get("semanticField") or entry.get("field") or "").strip().lower()
        if not key:
            continue
        state = link_entry_state(entry)
        v = entry.get("value")
        carries_value = any(x is not None and x != "" for x in v) if isinstance(v, (list, tuple)) else v not in (None, "")
        if (bool(entry.get("hidden")) and state == LINK_ENTRY_EMPTY) or (state == LINK_ENTRY_ENFORCED and carries_value):
            keys.add(key)
    return keys


def link_filters_a_viewer_may_see(
    link_filters_config: Optional[Sequence[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """The link's filters a public viewer is SHOWN (read-only): locked (🔒)
    entries that enforce a value — field, label, value, semanticField, nothing
    else — so the reader knows the report is filtered and by what.

    Never included: a hidden (🚫) entry, with or without a value (the reader
    must not learn the field or the value); a 'limit' scope entry (it bounds
    the viewer's choices, it is not a filter to announce); an empty lock (it
    enforces nothing); an entry its author set `showBanner: false` on.

    What is served is decided by the engine's own chokepoint,
    `normalize_filter_conditions`: an entry is served only if the engine keeps
    it, with the operator and value the engine enforces. So an M2M claim stored
    as `in "SP"` reads `in ["SP"]`; `ne` / `<>` read `neq` ("not RJ" is never
    shown as "RJ"); an `is_null` lock is stated although it has no value; a
    relative-date lock is stated by its preset (resolved per request); and a
    lock the engine drops (`between 5`, `in 5`) is never announced. The data
    merge is unaffected — the server applies the link's filters itself from
    DashboardPublicLink.filters_config.
    """
    entries = [e for e in (link_filters_config or []) if isinstance(e, dict) and not link_entry_is_scope(e)]
    locked, _hidden = split_link_filters_locked_vs_hidden(entries)
    out: List[Dict[str, Any]] = []
    for entry in locked:
        if entry.get("showBanner") is False:
            continue
        enforced = normalize_filter_conditions([entry])
        if not enforced:
            continue
        kept = enforced[0]
        item = {"field": kept.get("field"), "label": entry.get("label"),
                "value": kept.get("value"), "operator": kept.get("operator")}
        if entry.get("semanticField"):
            item["semanticField"] = entry["semanticField"]
        if entry.get("datePreset"):
            item["datePreset"] = entry["datePreset"]
        out.append(item)
    return out
