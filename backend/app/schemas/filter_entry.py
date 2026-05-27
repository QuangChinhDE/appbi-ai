"""Canonical Pydantic schemas for dashboard filter / slicer entries.

These models describe the **structured shape** of one entry inside
`Dashboard.filters_config`, `Dashboard.slicers_config`,
`pages_config[i].filters`, `pages_config[i].slicers`, and
`DashboardPublicLink.filters_config`.

Wire-level schemas in `schemas.py` keep `List[Dict[str, Any]]` for
backward compatibility — older clients send free-form dicts. BE code
that **applies** filters (chart engine, public-link merger, distinct-
values endpoint) should parse those dicts through `FilterEntry` /
`SlicerEntry` / `PublicLinkFilterEntry` so the field validation lives
in one place.

See `docs/filter-semantics.md` for the full design.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Public-mode enum
# ---------------------------------------------------------------------------
#
# Drives how each filter-pane entry behaves on a public link. Slicer
# entries do not carry this field — they are always `visible` (per the
# spec, hiding a slicer on a public link is expressed via
# DashboardPublicLink.filters_config overrides, not on the slicer
# itself).
#
PublicMode = Literal["visible", "locked", "hidden"]


# ---------------------------------------------------------------------------
# Filter type label
# ---------------------------------------------------------------------------
#
# The legacy schema uses small string labels for the UI editor: dropdown
# (multi/single select list), numeric (range/comparison), date
# (relative + absolute). We mirror the existing FE vocabulary so we
# don't break old clients.
#
FilterTypeLabel = Literal["dropdown", "numeric", "date"]


class FilterEntry(BaseModel):
    """One entry inside `Dashboard.filters_config` (filter-pane).

    Fields beyond the legacy shape are all optional with safe defaults so
    older payloads round-trip cleanly.
    """

    id: Optional[str] = None
    datasetId: Optional[int] = None
    field: str = Field(..., description="Bare field name, e.g. 'country' or 'orders.region'")
    semanticField: Optional[str] = Field(
        None,
        description=(
            "Fully-qualified semantic field reference (view.field), used "
            "by the chart engine when resolving the filter against a "
            "semantic binding. Falls back to `field` if missing."
        ),
    )
    label: Optional[str] = Field(None, description="Author-supplied display label")
    type: Optional[FilterTypeLabel] = "dropdown"
    operator: str = Field(default="in", description="Canonical operator key, see filter-semantics.md §7")
    value: Any = None
    mode: Optional[Literal["single", "multi"]] = "multi"

    # --- Public-link behavior (Phase-A new fields, default backward compatible) ---
    # Field names are camelCase to match the existing dashboard-filter
    # wire convention (`semanticField`, `datasetId`, `linkedFields`) so
    # FE and BE share the same JSON shape without renaming on the wire.
    publicMode: PublicMode = Field(
        default="visible",
        description=(
            "How this filter behaves on a public link by default: "
            "'visible' — viewer sees mini-pane override (subject to "
            "allowOverride); 'locked' — value enforced, viewer sees a "
            "read-only banner; 'hidden' — value enforced, viewer cannot "
            "see the field at all."
        ),
    )
    allowOverride: bool = Field(
        default=False,
        description=(
            "When `publicMode == 'visible'`, allow the public viewer to "
            "change the value via the mini-pane. When 'locked' or "
            "'hidden', this flag is ignored."
        ),
    )
    showBanner: bool = Field(
        default=True,
        description=(
            "When `publicMode == 'locked'`, whether to surface this "
            "filter in the public viewer's 'ⓘ Đang lọc theo …' banner. "
            "Ignored for 'visible' / 'hidden'."
        ),
    )

    model_config = ConfigDict(extra="allow")


class SlicerEntry(BaseModel):
    """One entry inside `Dashboard.slicers_config` (canvas slicer block).

    Slicers are always visible to viewers. Per-public-link visibility
    overrides live in DashboardPublicLink.filters_config, not here.
    """

    id: Optional[str] = None
    datasetId: Optional[int] = None
    field: str
    semanticField: Optional[str] = None
    label: Optional[str] = None
    type: Optional[FilterTypeLabel] = "dropdown"
    operator: str = "in"
    value: Any = None
    mode: Optional[Literal["single", "multi"]] = "multi"

    # --- Canvas placement (optional — layout_mode='canvas' supports free positioning) ---
    layout: Optional[Dict[str, Any]] = Field(
        None,
        description=(
            "Grid-layout placement (`{x, y, w, h, pageId?}`) or canvas "
            "geometry (`{xPx, yPx, wPx, hPx, z?, pageId?}`). When null, "
            "the FE auto-stacks the slicer in the SlicerBar at the top "
            "of the canvas."
        ),
    )

    model_config = ConfigDict(extra="allow")


class PublicLinkFilterEntry(BaseModel):
    """One entry inside `DashboardPublicLink.filters_config`.

    Acts as either a hard value override (locked) or a "drop this field
    entirely" marker (hidden). When `hidden=True`, `value` is ignored.
    """

    id: Optional[str] = None
    datasetId: Optional[int] = None
    field: str
    semanticField: Optional[str] = None
    operator: str = "in"
    value: Any = None
    hidden: bool = Field(
        default=False,
        description=(
            "When True, drop this field from the public viewer entirely "
            "(no banner, no slicer). Authoritative — viewer cannot "
            "override."
        ),
    )

    model_config = ConfigDict(extra="allow")


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------
#
# Callers in chart_service / public.py / dashboards.py should normalize
# free-form dicts through these helpers so optional defaults take effect
# consistently. Each returns None on unparseable entries (e.g. missing
# `field`) so the caller can drop with a structured diagnostic instead
# of raising.
#


def parse_filter_entry(raw: Dict[str, Any]) -> Optional[FilterEntry]:
    if not isinstance(raw, dict):
        return None
    try:
        return FilterEntry.model_validate(raw)
    except Exception:
        return None


def parse_slicer_entry(raw: Dict[str, Any]) -> Optional[SlicerEntry]:
    if not isinstance(raw, dict):
        return None
    try:
        return SlicerEntry.model_validate(raw)
    except Exception:
        return None


def parse_public_link_filter_entry(
    raw: Dict[str, Any],
) -> Optional[PublicLinkFilterEntry]:
    if not isinstance(raw, dict):
        return None
    try:
        return PublicLinkFilterEntry.model_validate(raw)
    except Exception:
        return None


def parse_filter_list(items: Optional[List[Dict[str, Any]]]) -> List[FilterEntry]:
    if not items:
        return []
    out: List[FilterEntry] = []
    for it in items:
        entry = parse_filter_entry(it)
        if entry is not None:
            out.append(entry)
    return out


def parse_slicer_list(items: Optional[List[Dict[str, Any]]]) -> List[SlicerEntry]:
    if not items:
        return []
    out: List[SlicerEntry] = []
    for it in items:
        entry = parse_slicer_entry(it)
        if entry is not None:
            out.append(entry)
    return out


def parse_public_link_filter_list(
    items: Optional[List[Dict[str, Any]]],
) -> List[PublicLinkFilterEntry]:
    if not items:
        return []
    out: List[PublicLinkFilterEntry] = []
    for it in items:
        entry = parse_public_link_filter_entry(it)
        if entry is not None:
            out.append(entry)
    return out
