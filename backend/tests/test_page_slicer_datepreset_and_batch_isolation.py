"""Page-scope date slicers resolve server-side + malformed filters don't crash.

Two production bugs on the public/embed report path (2026-08):

Bug 1 — a PAGE-scope date slicer (`pages_config[].slicers`) with a relative
preset ("last 30 days") stayed FROZEN at its publish-time value. The public
filter merge only ever read `slicers_config` (top-bar), so the server never knew
a page-slicer field was a relative slicer, and a stale/embed FE that sent only
the frozen `value` (no `datePreset` token) had nothing to trigger re-resolution.
Fix: the server re-attaches the authoritative stored token before normalize, so
the window is recomputed to the current date — while an explicit viewer choice
(its own token, incl. 'custom') is left untouched.

Bug 2 — a single malformed filter element (a non-dict: stray string / null /
list from a bad save) raised AttributeError in `normalize_filter_conditions`,
which in the per-page BATCH endpoint's shared loop failed EVERY tile on the page
(full-page 500), not just the offending one. Fix: normalize skips non-dict
entries; the batch endpoint isolates the per-chart filter build.

Unit-level: pure helpers + a SimpleNamespace dashboard, no DB / no BigQuery.
"""
import os
import sys
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_page_slicer_datepreset.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api.public import (
    _authoritative_date_presets,
    _reattach_authoritative_date_presets,
    _build_public_chart_filters,
)
from app.services.chart_contracts import normalize_filter_conditions, compute_date_preset_range


def _page_slicer(**over):
    base = {
        "type": "date", "scope": "page",
        "field": "orders.order_date", "semanticField": "orders.order_date",
        "operator": "between", "value": ["2026-07-13", "2026-08-11"],
        "datePreset": "last_30_days", "datasetId": 1,
    }
    base.update(over)
    return base


def _dash_with_page_slicer():
    return SimpleNamespace(
        filters_config=[], slicers_config=[],
        pages_config=[{"id": "p1", "slicers": [_page_slicer()], "filters": []}],
    )


# ── Bug 1 ───────────────────────────────────────────────────────────────────

def test_authoritative_presets_include_page_slicers():
    presets = _authoritative_date_presets(_dash_with_page_slicer())
    assert presets.get("orders.order_date") == "last_30_days"


def test_authoritative_presets_ignore_custom_and_tokenless():
    dash = SimpleNamespace(
        slicers_config=[{"field": "a", "datePreset": "custom"}, {"field": "b"}],
        filters_config=[], pages_config=[],
    )
    assert _authoritative_date_presets(dash) == {}


def test_stale_fe_frozen_page_slicer_resolves_to_current():
    # Stale/embed FE: sends the page slicer's frozen value but NO datePreset token.
    stale = {
        "type": "date", "field": "orders.order_date", "semanticField": "orders.order_date",
        "operator": "between", "value": ["2026-07-13", "2026-08-11"], "datasetId": 1,
    }
    out = _build_public_chart_filters(_dash_with_page_slicer(), None, [stale])
    applied = [f["value"] for f in out if f.get("field") == "orders.order_date"]
    assert applied == [list(compute_date_preset_range("last_30_days"))]


def test_explicit_viewer_preset_is_not_overridden():
    viewer = {
        "type": "date", "field": "orders.order_date", "semanticField": "orders.order_date",
        "operator": "between", "value": ["x", "y"], "datePreset": "last_7_days", "datasetId": 1,
    }
    out = _build_public_chart_filters(_dash_with_page_slicer(), None, [viewer])
    applied = [f["value"] for f in out if f.get("field") == "orders.order_date"]
    assert applied == [list(compute_date_preset_range("last_7_days"))]


def test_explicit_custom_range_is_kept():
    viewer = {
        "type": "date", "field": "orders.order_date", "semanticField": "orders.order_date",
        "operator": "between", "value": ["2020-01-01", "2020-02-01"], "datePreset": "custom", "datasetId": 1,
    }
    out = _build_public_chart_filters(_dash_with_page_slicer(), None, [viewer])
    applied = [f["value"] for f in out if f.get("field") == "orders.order_date"]
    assert applied == [["2020-01-01", "2020-02-01"]]


def test_reattach_leaves_non_date_filters_alone():
    presets = {"orders.order_date": "last_30_days"}
    dropdown = {"type": "dropdown", "field": "region", "operator": "in", "value": ["A"]}
    out = _reattach_authoritative_date_presets([dropdown], presets)
    assert "datePreset" not in out[0]


# ── Bug 2 ───────────────────────────────────────────────────────────────────

def test_normalize_skips_non_dict_without_crashing():
    out = normalize_filter_conditions(
        ["garbage", None, 123, ["nested"], {"field": "x", "operator": "eq", "value": "1"}]
    )
    # The one valid filter survives; the malformed entries are dropped, not raised.
    assert [o["field"] for o in out] == ["x"]


def test_normalize_records_drop_for_non_dict():
    diags: list[dict] = []
    normalize_filter_conditions(["garbage"], diagnostics=diags)
    assert diags and diags[0]["reason"] == "no_field"
