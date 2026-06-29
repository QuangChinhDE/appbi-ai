"""Phase-B (PBI-parity rework) — unit tests for filter_layered_merge.

Verify precedence ordering, link_hidden field kill list, and the
split_link_filters_locked_vs_hidden helper.

These tests run without DB or FastAPI app — pure data manipulation.
"""

import os
os.environ.setdefault("DATABASE_URL", "postgresql://stub@localhost/stub")

from app.services.filter_layered_merge import (
    FilterLayer,
    LAYER_CHART_BASE,
    LAYER_DASHBOARD_FILTER,
    LAYER_DASHBOARD_SLICER,
    LAYER_VIEWER_SLICER,
    LAYER_LINK_HIDDEN,
    LAYER_LINK_LOCKED,
    filters_to_merge_entries,
    link_entry_has_value,
    link_managed_field_keys,
    make_public_layers,
    merge_layered_filters,
    split_dashboard_filters_by_public_mode,
    split_filters_by_layer_source,
    split_link_filters_locked_vs_hidden,
)


def test_locked_dashboard_filter_beats_slicer_and_viewer():
    """Phase-H — a publicMode=locked dashboard filter is authoritative:
    a slicer / viewer choice on the SAME field must NOT relax it."""
    layers = make_public_layers(
        dashboard_slicers=[{"field": "region", "operator": "in", "value": ["North"]}],
        viewer_slicers=[{"field": "region", "operator": "in", "value": ["South"]}],
        dashboard_filters_locked=[{"field": "region", "operator": "in", "value": ["East"]}],
    )
    out = merge_layered_filters(layers)
    assert len(out) == 1
    assert out[0]["value"] == ["East"], f"locked filter must win, got {out!r}"
    assert out[0]["_layer_source"] == "dashboard_filter_locked"


def test_visible_dashboard_filter_is_overridable_by_viewer():
    """publicMode=visible filter is a default the viewer can override."""
    layers = make_public_layers(
        dashboard_filters=[{"field": "status", "operator": "eq", "value": "active"}],
        viewer_slicers=[{"field": "status", "operator": "eq", "value": "closed"}],
    )
    out = merge_layered_filters(layers)
    assert len(out) == 1
    assert out[0]["value"] == "closed"
    assert out[0]["_layer_source"] == "viewer_slicer"


def test_link_locked_beats_dashboard_locked():
    """Per-link lock is the most authoritative."""
    layers = make_public_layers(
        dashboard_filters_locked=[{"field": "region", "operator": "in", "value": ["East"]}],
        link_locked=[{"field": "region", "operator": "in", "value": ["West"]}],
    )
    out = merge_layered_filters(layers)
    assert len(out) == 1
    assert out[0]["value"] == ["West"]
    assert out[0]["_layer_source"] == "link_locked"


def test_split_dashboard_filters_by_public_mode():
    visible, auth = split_dashboard_filters_by_public_mode([
        {"field": "a", "publicMode": "visible"},
        {"field": "b", "publicMode": "locked"},
        {"field": "c", "publicMode": "hidden"},
        {"field": "d"},  # unset → visible
        {"field": "e", "public_mode": "locked"},  # legacy snake_case
    ])
    assert {f["field"] for f in visible} == {"a", "d"}
    assert {f["field"] for f in auth} == {"b", "c", "e"}


def test_precedence_link_locked_wins():
    """link_locked layer must override viewer_slicer + chart_base on same field."""
    layers = make_public_layers(
        chart_base=[{"field": "region", "operator": "in", "value": ["North"]}],
        viewer_slicers=[{"field": "region", "operator": "in", "value": ["South"]}],
        link_locked=[{"field": "region", "operator": "in", "value": ["East"]}],
    )
    out = merge_layered_filters(layers)
    assert len(out) == 1
    assert out[0]["field"] == "region"
    assert out[0]["value"] == ["East"]
    assert out[0]["_layer_source"] == "link_locked"


def test_link_hidden_drops_field():
    """link_hidden entries drop matching fields regardless of operator."""
    diag = []
    layers = make_public_layers(
        dashboard_filters=[{"field": "year", "operator": "eq", "value": 2026}],
        viewer_slicers=[{"field": "region", "operator": "in", "value": ["North"]}],
        link_hidden=[{"field": "year"}],
    )
    out = merge_layered_filters(layers, diagnostics=diag)
    fields = {e["field"] for e in out}
    assert fields == {"region"}, f"year should be dropped, got {fields}"
    assert any(d.get("reason") == "link_hidden" for d in diag), \
        f"expected link_hidden diagnostic, got {diag}"


def test_viewer_slicer_overrides_dashboard_filter():
    """Viewer's slicer change wins over dashboard's saved filter value."""
    layers = make_public_layers(
        dashboard_filters=[{"field": "status", "operator": "eq", "value": "active"}],
        viewer_slicers=[{"field": "status", "operator": "eq", "value": "closed"}],
    )
    out = merge_layered_filters(layers)
    assert len(out) == 1
    assert out[0]["value"] == "closed"
    assert out[0]["_layer_source"] == "viewer_slicer"


def test_empty_value_filter_is_dropped_with_diagnostic():
    """`in` operator with [] value gets dropped via normalize_filter_conditions."""
    diag = []
    layers = make_public_layers(
        viewer_slicers=[
            {"field": "region", "operator": "in", "value": []},
            {"field": "year", "operator": "eq", "value": 2026},
        ],
    )
    out = merge_layered_filters(layers, diagnostics=diag)
    fields = {e["field"] for e in out}
    assert fields == {"year"}, f"empty in() should drop region, got {fields}"
    assert any(d.get("reason") == "empty_value" for d in diag), \
        f"expected empty_value diagnostic, got {diag}"


def test_split_link_filters_locked_vs_hidden():
    """Hidden entries (with hidden=True) split out from value-bearing locked."""
    raw = [
        {"field": "region", "value": "North"},
        {"field": "year", "hidden": True},
        {"field": "status", "value": "active"},
        {"field": "secret", "hidden": True},
    ]
    locked, hidden = split_link_filters_locked_vs_hidden(raw)
    assert {f["field"] for f in locked} == {"region", "status"}
    assert {f["field"] for f in hidden} == {"year", "secret"}


def test_filters_to_merge_entries_skip_public_modes():
    """Filter entries with publicMode in skip_public_modes are stripped."""
    items = [
        {"field": "a", "publicMode": "visible"},
        {"field": "b", "publicMode": "hidden"},
        {"field": "c", "publicMode": "locked"},
        {"field": "d"},  # default = visible
    ]
    visible_only = filters_to_merge_entries(items, skip_public_modes=("hidden",))
    assert [e["field"] for e in visible_only] == ["a", "c", "d"]

    # Default behavior: keep everything
    all_kept = filters_to_merge_entries(items)
    assert [e["field"] for e in all_kept] == ["a", "b", "c", "d"]


def test_split_filters_by_layer_source():
    """Diagnostic helper buckets merged filters by source."""
    merged = [
        {"field": "a", "_layer_source": "viewer_slicer"},
        {"field": "b", "_layer_source": "link_locked"},
        {"field": "c", "_layer_source": "viewer_slicer"},
    ]
    buckets = split_filters_by_layer_source(merged)
    assert set(buckets.keys()) == {"viewer_slicer", "link_locked"}
    assert len(buckets["viewer_slicer"]) == 2
    assert len(buckets["link_locked"]) == 1


def test_realistic_end_to_end_scenario():
    """Realistic scenario combining all layers."""
    diag = []
    layers = make_public_layers(
        dashboard_filters=[
            # Locked filter — viewer sees value via banner, BE applies
            {"field": "date", "operator": "between", "value": ["2026-01-01", "2026-12-31"],
             "publicMode": "locked"},
        ],
        dashboard_slicers=[
            # Default slicer value
            {"field": "region", "operator": "in", "value": ["North"]},
        ],
        viewer_slicers=[
            # Viewer changed slicer to East
            {"field": "region", "operator": "in", "value": ["East"]},
        ],
        link_locked=[
            # Per-link override — department is sales for this share link only
            {"field": "department", "operator": "eq", "value": "Sales"},
        ],
        link_hidden=[
            # Year is hidden on this link
            {"field": "year"},
        ],
    )
    out = merge_layered_filters(layers, diagnostics=diag)
    by_field = {e["field"]: e for e in out}

    assert set(by_field.keys()) == {"date", "region", "department"}, \
        f"expected date/region/department, got {set(by_field.keys())}"
    assert by_field["region"]["value"] == ["East"]
    assert by_field["region"]["_layer_source"] == "viewer_slicer"
    assert by_field["department"]["_layer_source"] == "link_locked"
    assert by_field["date"]["_layer_source"] == "dashboard_filter"


def test_cross_operator_override_no_double_apply():
    """Phase-B' regression — when dashboard has `eq A` and viewer sends
    `in [B]` on the same field, the operator difference must NOT cause
    BOTH to apply (which would generate `WHERE col=A AND col IN (B)` →
    empty). The dedupe key is operator-agnostic so the later layer
    fully overrides.
    """
    layers = make_public_layers(
        dashboard_filters=[
            {"field": "region", "operator": "eq", "value": "North"},
        ],
        viewer_slicers=[
            {"field": "region", "operator": "in", "value": ["South"]},
        ],
    )
    out = merge_layered_filters(layers)
    assert len(out) == 1, \
        f"Cross-operator override failed — got {len(out)} entries (would " \
        f"AND together and return 0 rows): {out!r}"
    # Viewer slicer (later layer) wins
    assert out[0]["value"] == ["South"]
    assert out[0]["operator"] == "in"
    assert out[0]["_layer_source"] == "viewer_slicer"


def test_dashboard_filter_overrides_chart_base_across_operators():
    """Same regression at chart_base ↔ dashboard_filter boundary."""
    layers = make_public_layers(
        chart_base=[
            {"field": "year", "operator": "eq", "value": 2025},
        ],
        dashboard_filters=[
            {"field": "year", "operator": "between", "value": [2026, 2027]},
        ],
    )
    out = merge_layered_filters(layers)
    assert len(out) == 1
    assert out[0]["value"] == [2026, 2027]
    assert out[0]["_layer_source"] == "dashboard_filter"


def test_link_locked_overrides_dashboard_filter_across_operators():
    """Link locked layer must win over dashboard filter even with op diff."""
    layers = make_public_layers(
        dashboard_filters=[
            {"field": "status", "operator": "in", "value": ["active", "pending"]},
        ],
        link_locked=[
            {"field": "status", "operator": "eq", "value": "active"},
        ],
    )
    out = merge_layered_filters(layers)
    assert len(out) == 1
    assert out[0]["operator"] == "eq"
    assert out[0]["value"] == "active"
    assert out[0]["_layer_source"] == "link_locked"


def test_unknown_layer_source_ignored():
    """Layers with unknown source labels are silently ignored, not errored."""
    layers = [
        FilterLayer("bogus_source", [{"field": "x", "value": 1}]),
        FilterLayer(LAYER_CHART_BASE, [{"field": "y", "value": 2}]),
    ]
    out = merge_layered_filters(layers)
    fields = {e["field"] for e in out}
    assert fields == {"y"}, f"bogus source should be ignored, got {fields}"


def test_image_entries_in_slicer_config_skipped():
    """Phase-G — image children of the slicer cluster must never reach
    the SQL pipeline. They live in slicers_config alongside real
    slicers but get filtered out at normalize_filter_conditions."""
    layers = make_public_layers(
        dashboard_slicers=[
            {"type": "image", "src": "data:image/png;base64,xxx", "id": "logo"},
            {"field": "region", "operator": "in", "value": ["North"]},
            {"type": "Image", "src": "https://example.com/logo.png"},  # case-insensitive
        ],
    )
    out = merge_layered_filters(layers)
    assert len(out) == 1, f"image entries should be skipped, got {out!r}"
    assert out[0]["field"] == "region"


# ---------------------------------------------------------------------------
# link_entry_has_value / link_managed_field_keys — the single source of truth
# shared by the chart-data merge AND the structure-response strip in
# api/public.py. These guard the dashboard-53 empty-lock leak class: an empty
# locked entry must NOT be "managed" (else its field's slicer + page filter get
# stripped while the merge enforces nothing → viewer sees MORE than page scope).
# Previously this decision had ZERO coverage.
# ---------------------------------------------------------------------------

def test_link_entry_has_value_matrix():
    assert link_entry_has_value({"field": "p", "value": "Laptop"}) is True
    assert link_entry_has_value({"field": "p", "value": ["Laptop"]}) is True
    assert link_entry_has_value({"field": "p", "value": 0}) is True  # 0 is a real value
    assert link_entry_has_value({"field": "p", "value": []}) is False
    assert link_entry_has_value({"field": "p", "value": ""}) is False
    # BE does NOT trim (preserves the pre-existing `v not in (None, "")`
    # semantics): a whitespace-only value counts as present. The FE save-guard
    # trims and blocks that degenerate case upstream.
    assert link_entry_has_value({"field": "p", "value": "   "}) is True
    assert link_entry_has_value({"field": "p", "value": None}) is False
    assert link_entry_has_value({"field": "p"}) is False  # missing value
    assert link_entry_has_value({"field": "p", "value": {}}) is False
    assert link_entry_has_value("not a dict") is False


def test_managed_keys_locked_with_value_is_managed():
    keys = link_managed_field_keys([{"field": "product_name", "operator": "in", "value": ["Laptop"]}])
    assert keys == {"product_name"}


def test_managed_keys_locked_empty_is_NOT_managed():
    """THE regression: empty locked entry enforces nothing → must not strip."""
    keys = link_managed_field_keys([{"field": "product_name", "operator": "in", "value": []}])
    assert keys == set(), f"empty lock must be a no-op, got {keys}"


def test_managed_keys_hidden_with_value_is_managed():
    keys = link_managed_field_keys([{"field": "region", "operator": "in", "value": ["North"], "hidden": True}])
    assert keys == {"region"}


def test_managed_keys_hidden_empty_is_managed_kill_list():
    """hidden=True with no value = §2.3 kill-list → field dropped → managed."""
    keys = link_managed_field_keys([{"field": "secret", "value": [], "hidden": True}])
    assert keys == {"secret"}


def test_managed_keys_prefers_semanticfield_lowercased():
    keys = link_managed_field_keys([
        {"semanticField": "Orders.Country", "field": "country", "value": ["US"]},
    ])
    assert keys == {"orders.country"}


def test_managed_keys_operator_agnostic():
    """Value-emptiness drives the decision, not the operator."""
    assert link_managed_field_keys([{"field": "x", "operator": "eq", "value": "A"}]) == {"x"}
    assert link_managed_field_keys([{"field": "x", "operator": "between", "value": []}]) == set()


def test_managed_keys_skips_non_dict_and_keyless():
    keys = link_managed_field_keys([
        "garbage",
        {"value": ["v"]},  # no field key
        {"field": "", "value": ["v"]},  # blank key
        {"field": "ok", "value": ["v"]},
    ])
    assert keys == {"ok"}


def test_managed_keys_mixed_multi_entry():
    keys = link_managed_field_keys([
        {"field": "a", "value": ["x"]},              # locked w/ value → managed
        {"field": "b", "value": []},                 # locked empty → NOT managed
        {"field": "c", "value": ["y"], "hidden": True},  # hidden w/ value → managed
        {"field": "d", "value": [], "hidden": True},     # hidden empty → managed (kill)
    ])
    assert keys == {"a", "c", "d"}


def test_managed_set_matches_merge_enforcement():
    """Contract: a field is 'managed' (strip control) IFF the merge enforces or
    kills it. Ties the structure-strip notion to the data-merge notion so they
    cannot drift (the root cause of the empty-lock leak)."""
    # empty lock → NOT managed AND merge produces nothing for it
    empty = [{"field": "product_name", "operator": "in", "value": []}]
    assert link_managed_field_keys(empty) == set()
    merged_empty = merge_layered_filters(make_public_layers(link_locked=empty))
    assert all(e.get("field") != "product_name" for e in merged_empty), \
        f"empty lock must not enforce a filter, got {merged_empty!r}"

    # valued lock → managed AND merge enforces it
    valued = [{"field": "product_name", "operator": "in", "value": ["Laptop"]}]
    assert link_managed_field_keys(valued) == {"product_name"}
    merged_valued = merge_layered_filters(make_public_layers(link_locked=valued))
    enforced = [e for e in merged_valued if e.get("field") == "product_name"]
    assert len(enforced) == 1 and enforced[0]["value"] == ["Laptop"], \
        f"valued lock must enforce, got {merged_valued!r}"
