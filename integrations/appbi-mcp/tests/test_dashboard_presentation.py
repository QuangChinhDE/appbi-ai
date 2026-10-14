"""P6 / P7 (real Claude Desktop pilot, 2026-10-14).

P6: the dashboard's filters were staged but had no control on the grid, so viewers saw no
filter at all ("Slicer 5 unplaced"). P7: revenue (~1M) and orders (~5k) shared one axis, so
orders read as a flat zero line; category bars came out unsorted."""
from __future__ import annotations

import pytest

from appbi_mcp.appbi_client import BODY_GUARDS, GuardViolation, match_route
from appbi_mcp.tools.dashboard import SLICER_H, SLICER_W, _filter_entry, apply_style, slicer_layouts

REV = "dataset_table_704.revenue"
ORD = "dataset_table_704.orders_count"


def _ts(*fields):
    return {"roleConfig": {"timeField": "dataset_table_705.ts", "metrics": [{"field": f, "agg": "auto"} for f in fields]}}


def test_two_measures_of_very_different_size_get_a_right_axis():
    preview = [{f"auto__{REV}": 980_000.0, f"auto__{ORD}": 6_500}, {f"auto__{REV}": 1_010_000.0, f"auto__{ORD}": 7_000}]
    cfg, notes = apply_style("TIME_SERIES", _ts(REV, ORD), None, preview)
    assert cfg["styleConfig"]["dualYAxis"] is True and notes


def test_measures_of_similar_size_share_the_axis():
    preview = [{f"auto__{REV}": 100.0, f"auto__{ORD}": 60.0}]
    cfg, _ = apply_style("TIME_SERIES", _ts(REV, ORD), None, preview)
    assert "dualYAxis" not in (cfg.get("styleConfig") or {})


def test_an_explicit_choice_wins_over_the_default():
    preview = [{f"auto__{REV}": 1_000_000.0, f"auto__{ORD}": 5_000}]
    cfg, _ = apply_style("TIME_SERIES", _ts(REV, ORD), {"dual_axis": False}, preview)
    assert "dualYAxis" not in (cfg.get("styleConfig") or {})


def test_one_dimension_bars_are_ordered_by_value_with_the_renderers_series_key():
    bar = {"roleConfig": {"dimension": "dataset_table_708.category", "metrics": [{"field": REV, "agg": "auto"}]}}
    cfg, _ = apply_style("HORIZONTAL_BAR", bar, None)
    assert cfg["styleConfig"]["chartSortRules"] == [{"field": f"auto__{REV}", "direction": "desc"}]
    cfg, _ = apply_style("HORIZONTAL_BAR", bar, {"sort": "none"})
    assert "chartSortRules" not in (cfg.get("styleConfig") or {})
    cfg, _ = apply_style("BAR", bar, {"top_n": 10, "number_format": "currency", "currency_symbol": "R$"})
    assert cfg["styleConfig"]["dataLimit"] == 10 and cfg["styleConfig"]["numberFormat"] == "currency"


@pytest.mark.parametrize("kind,control", [("dropdown", "dropdown"), ("date", "date_range"), ("numeric", "slider")])
def test_every_filter_names_the_control_a_viewer_uses(kind, control):
    e = _filter_entry({"field": "dataset_table_705.order_status", "type": kind, "label": None}, 196)
    assert e["interactionType"] == control
    if kind == "date":
        assert e["datePreset"] == "custom"   # a new date control does not pre-filter to "this month"


def test_controls_form_a_band_above_the_charts():
    band = slicer_layouts(5, 0)
    assert band[0] == {"x": 0, "y": 0, "w": SLICER_W, "h": SLICER_H}
    assert band[4]["y"] == SLICER_H and band[3]["x"] == 3 * SLICER_W


GUARD = BODY_GUARDS[("POST", match_route("POST", "/dashboards/7/widgets"))]
OK = {"widget_type": "slicer", "layout": {"x": 0, "y": 0, "w": 8, "h": 3, "draftOnly": True},
      "widget_config": {"slicerId": "f-mcp-x", "treatment": "auto", "origin": "author"}}


@pytest.mark.parametrize("change", [
    {"widget_type": "text"},
    {"layout": {"x": 0, "y": 0, "w": 8, "h": 3}},
    {"widget_config": {"slicerId": "f", "html": "<b>x</b>"}},
    {"widget_config": {}},
])
def test_only_draft_slicer_controls_may_be_added_as_widgets(change):
    GUARD(OK)
    with pytest.raises(GuardViolation):
        GUARD({**OK, **change})
