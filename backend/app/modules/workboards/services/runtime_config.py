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
    if published:
        # Live serves the immutable snapshot. Fall back to the live layout ONLY
        # when the snapshot is missing/empty — a legacy board published before
        # published_layout_json existed, or one left half-published by a buggy
        # path — so Live renders the app instead of an empty shell rather than a
        # hard-fail. A properly published board always has a snapshot, so this
        # fallback never triggers for it and never weakens Draft/Published
        # isolation in the normal case. Mirrors the same legacy fallback in
        # WorkboardRuntimeConfig.runtime_config.
        raw = workboard.published_layout_json or workboard.layout_json
    else:
        raw = workboard.layout_json
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

    # ── Non-layout deployment boundary (Slice 2) ─────────────────────────────
    @property
    def runtime_config(self) -> Dict[str, Any]:
        """The typed non-layout config for THIS stage. Live reads the frozen
        ``published_runtime_config`` snapshot (so a draft edit to binding / write
        mode / lock column / webhooks can't change Live until Publish); Draft /
        Preview — and any legacy published board that predates the snapshot —
        build live from the mutable columns."""
        if self.published:
            snap = getattr(self.workboard, "published_runtime_config", None)
            if isinstance(snap, dict) and snap:
                return snap
        return build_published_runtime_config(self.workboard)

    @property
    def binding(self) -> Dict[str, Any]:
        return dict((self.runtime_config or {}).get("binding") or {})

    @property
    def write(self) -> Dict[str, Any]:
        return dict((self.runtime_config or {}).get("write") or {})

    @property
    def integrations(self) -> Dict[str, Any]:
        return dict((self.runtime_config or {}).get("integrations") or {})


# Bump when the published_runtime_config shape changes so a reader can migrate
# an older snapshot on the fly if ever needed.
RUNTIME_CONFIG_SCHEMA_VERSION = 1


def build_published_runtime_config(workboard) -> Dict[str, Any]:
    """Snapshot the NON-layout Live configuration from the mutable workboard row
    into the typed, versioned shape frozen at Publish. Every author-editable value
    that changes Live runtime behavior (data binding, write behavior, integration
    firing) lives here; cosmetic/routing fields (name/icon/description/slug) and
    the latent ``settings.public_links`` are intentionally excluded (they do not
    change Live behavior, and public_links mixes in mutable access counters)."""
    settings = workboard.settings if isinstance(workboard.settings, dict) else {}
    webhooks = settings.get("webhooks")
    return {
        "schema_version": RUNTIME_CONFIG_SCHEMA_VERSION,
        "binding": {
            "dataset_id": workboard.dataset_id,
            "primary_table_id": workboard.primary_table_id,
            "primary_key_columns": list(workboard.primary_key_columns or []),
            "lookup_tables": list(workboard.lookup_tables or []),
        },
        "write": {
            "write_mode": workboard.write_mode,
            "optimistic_lock_column": workboard.optimistic_lock_column,
        },
        "integrations": {
            "webhooks": list(webhooks) if isinstance(webhooks, list) else [],
        },
    }


def resolve_runtime_config(workboard, *, published: Optional[bool] = None) -> WorkboardRuntimeConfig:
    if published is None:
        published = use_published_for(workboard)
    return WorkboardRuntimeConfig(
        workboard=workboard,
        published=published,
        layout_raw=effective_layout_raw(workboard, published=published),
    )
