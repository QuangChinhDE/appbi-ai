"""Centralized Draft/Published runtime-config resolver for Workboards.

The Draft/Published invariant: once a Workboard is Live, editing/autosaving the
DRAFT must have ZERO effect on Live behavior until an explicit Publish. To make
that enforceable in ONE place, all public-runtime / write / export / integration
code must resolve its configuration through this module instead of reading the
mutable ``workboard.layout_json`` (or mutable columns) directly.

Stage selection uses the transient ``_wb_use_published`` attribute that
``public.py._resolve_workboard_for_workspace`` stamps on the workboard for a
request (True for real end users, False for an admin Preview session). Callers
may also pass ``published=`` explicitly.

This is a dependency-free leaf module (imports only schemas) so screen_runtime,
write_service and the public API can all import it without cycles.

SLICE 1 (this file today) resolves the effective LAYOUT (published snapshot for
Live, draft for Preview) + layout-derived config (print template, and — via the
raw dict — OCR / managed-dashboard-token maps / auto-number / audit columns,
which all live inside the layout blob and are captured in published_layout_json
at Publish).

SLICE 2 (migration, next) will extend WorkboardRuntimeConfig with the non-layout
deployment boundary read from a typed ``published_runtime_config`` snapshot —
binding (dataset_id/primary_table_id/primary_key_columns/lookup_tables), write
(write_mode/optimistic_lock_column) and integrations (webhooks) — so those stop
being read from the mutable Workboard columns on Live paths. The accessors are
stubbed here to keep call sites stable across the two slices.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from app.modules.workboards.schemas import LayoutJson

# The transient per-request flag set by _resolve_workboard_for_workspace.
USE_PUBLISHED_ATTR = "_wb_use_published"


def use_published_for(workboard) -> bool:
    """Whether this request serves the immutable Published snapshot (Live) vs the
    mutable Draft (Builder/Preview)."""
    return bool(getattr(workboard, USE_PUBLISHED_ATTR, False))


def effective_layout_raw(workboard, *, published: Optional[bool] = None) -> Dict[str, Any]:
    """The raw layout dict for this stage — the SINGLE source of the published-vs-
    draft decision. Live reads ``published_layout_json``; Draft/Preview reads
    ``layout_json``. Never let runtime/write/export code pick this itself."""
    if published is None:
        published = use_published_for(workboard)
    raw = workboard.published_layout_json if published else workboard.layout_json
    return raw or {}


@dataclass
class WorkboardRuntimeConfig:
    """Resolved, stage-correct configuration for one workboard request."""

    workboard: Any
    published: bool
    layout_raw: Dict[str, Any]
    _layout: Optional[LayoutJson] = field(default=None, repr=False)

    @property
    def layout(self) -> LayoutJson:
        if self._layout is None:
            try:
                self._layout = LayoutJson.model_validate(self.layout_raw or {})
            except Exception:
                self._layout = LayoutJson()
        return self._layout

    def print_template(self) -> Optional[Dict[str, Any]]:
        """Doc/print letterhead, stored as an extra key on the layout blob."""
        pt = self.layout_raw.get("print_template") if isinstance(self.layout_raw, dict) else None
        if isinstance(pt, dict) and pt.get("enabled", True):
            return pt
        return None

    # ── SLICE 2 seam (non-layout deployment boundary) ────────────────────────
    # For Live these will read workboard.published_runtime_config; for Draft the
    # mutable columns. Until the migration lands they fall through to the live
    # columns so Slice-1 behavior is unchanged. Do NOT rely on these for Live
    # isolation yet — binding/write/webhooks isolation is Slice 2.
    @property
    def binding(self) -> Dict[str, Any]:
        wb = self.workboard
        return {
            "dataset_id": wb.dataset_id,
            "primary_table_id": wb.primary_table_id,
            "primary_key_columns": list(wb.primary_key_columns or []),
            "lookup_tables": list(wb.lookup_tables or []),
        }


def resolve_runtime_config(workboard, *, published: Optional[bool] = None) -> WorkboardRuntimeConfig:
    if published is None:
        published = use_published_for(workboard)
    return WorkboardRuntimeConfig(
        workboard=workboard,
        published=published,
        layout_raw=effective_layout_raw(workboard, published=published),
    )
