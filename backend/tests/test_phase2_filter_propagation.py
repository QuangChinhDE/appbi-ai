"""Phase-2 unit tests — filter_propagation.resolve_filter_propagation.

Pure unit (no DB): builds in-memory ``SemanticJoinResolver`` with stub model
factories and asserts the PropagationResult shape (mode + reason) against
PBI-parity expectations.
"""
import os
os.environ.setdefault("DATABASE_URL", "postgresql://stub@localhost/stub")

import pytest

from app.services.filter_propagation import (
    DropReason,
    PropagationMode,
    PropagationResult,
    resolve_filter_propagation,
    _parse_field_ref,
    _is_fanout_traversal,
)
from app.services.semantic_join_resolver import (
    JoinEdge,
    SemanticJoinResolver,
)


# ──────────────────────────────────────────────────────────────────────────
# Stub model factories (no DB needed)
# ──────────────────────────────────────────────────────────────────────────


class _Explore:
    def __init__(self, base, joins):
        self.base_view_name = base
        self.joins = joins


class _Model:
    def __init__(self, explores):
        self.explores = explores


def _resolver(model, base):
    """Build a Phase-1-strict resolver (no legacy bidirectional)."""
    return SemanticJoinResolver(db=None, model=model, base_node=base, bidirectional=False)


# ──────────────────────────────────────────────────────────────────────────
# _parse_field_ref
# ──────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("ref,expected", [
    ("owner.team", ("owner", "team", None)),
    ("orders.amount", ("orders", "amount", None)),
    ("date.year@created_date", ("date", "year", "created_date")),
    ("  date.year  @  closed_date  ", ("date", "year", "closed_date")),
    ("noview", ("", "", None)),
    ("", ("", "", None)),
    (None, ("", "", None)),
])
def test_parse_field_ref(ref, expected):
    assert _parse_field_ref(ref) == expected


# ──────────────────────────────────────────────────────────────────────────
# _is_fanout_traversal
# ──────────────────────────────────────────────────────────────────────────


def test_fanout_traversal_detection():
    def _e(card):
        return JoinEdge(
            from_node="a", to_node="b", to_view="b", type="left", sql_on="",
            from_column="x", to_column="y", relationship=None,
            cardinality=card,
        )
    assert _is_fanout_traversal(_e("one_to_many")) is True
    assert _is_fanout_traversal(_e("many_to_many")) is True
    assert _is_fanout_traversal(_e("many_to_one")) is False
    assert _is_fanout_traversal(_e("one_to_one")) is False


# ──────────────────────────────────────────────────────────────────────────
# PLAIN — filter on base view itself
# ──────────────────────────────────────────────────────────────────────────


def test_plain_filter_on_base_view():
    model = _Model([_Explore("orders", [])])
    r = _resolver(model, "orders")
    res = resolve_filter_propagation(r, "orders", "orders.status")
    assert res.mode == PropagationMode.PLAIN
    assert res.reason is None
    assert res.path is None


# ──────────────────────────────────────────────────────────────────────────
# JOIN_CHAIN — star schema dim filter, M:1 forward
# ──────────────────────────────────────────────────────────────────────────


def test_join_chain_star_schema():
    """Chart on orders, filter on customers.country.
    Path: orders → customers (M:1 forward). No fan-out → JOIN_CHAIN.
    """
    model = _Model([
        _Explore("orders", [{
            "view": "customers", "alias": "customers",
            "from_column": "customer_id", "to_column": "id",
            "cardinality": "many_to_one", "cross_filter": "single",
        }]),
    ])
    r = _resolver(model, "orders")
    res = resolve_filter_propagation(r, "orders", "customers.country")
    assert res.mode == PropagationMode.JOIN_CHAIN
    assert res.path is not None
    assert len(res.path.steps) == 1
    assert res.path.steps[0].edge.to_node == "customers"


# ──────────────────────────────────────────────────────────────────────────
# DROP/UNREACHABLE — no relationship at all
# ──────────────────────────────────────────────────────────────────────────


def test_drop_unreachable_view():
    model = _Model([_Explore("a", []), _Explore("b", [])])
    r = _resolver(model, "a")
    res = resolve_filter_propagation(r, "a", "b.col")
    assert res.mode == PropagationMode.DROP
    assert res.reason == DropReason.UNREACHABLE_VIEW


# ──────────────────────────────────────────────────────────────────────────
# DROP/UNREACHABLE — wrong direction with single cross_filter
# (Phase-1 resolver doesn't synthesise reverse for 'single' → no path exists)
# ──────────────────────────────────────────────────────────────────────────


def test_drop_when_filtering_fact_from_dim_single_direction():
    """Chart on customers (dim), filter on orders.amount.
    orders --(m:1, single)--> customers
    With 'single', no reverse customers → orders. So unreachable from base=customers.
    Matches PBI default: filter on 'many' side doesn't propagate to 'one' side.
    """
    model = _Model([
        _Explore("orders", [{
            "view": "customers", "alias": "customers",
            "from_column": "customer_id", "to_column": "id",
            "cardinality": "many_to_one", "cross_filter": "single",
        }]),
    ])
    r = _resolver(model, "customers")
    res = resolve_filter_propagation(r, "customers", "orders.amount")
    assert res.mode == PropagationMode.DROP
    assert res.reason == DropReason.UNREACHABLE_VIEW


# ──────────────────────────────────────────────────────────────────────────
# EXISTS — fan-out hop, target is filter-only (default behavior)
# ──────────────────────────────────────────────────────────────────────────


def test_exists_when_path_crosses_fanout_target_filter_only():
    """Chart on customers (dim, base), filter on orders.region.
    customers ←(reverse from orders, 1:m)— orders. Reverse synthesised because
    cross_filter='both'. Path: customers → orders (1:m fan-out).
    Target orders is FILTER-ONLY (not in select_side_views) → EXISTS.
    """
    model = _Model([
        _Explore("orders", [{
            "view": "customers", "alias": "customers",
            "from_column": "customer_id", "to_column": "id",
            "cardinality": "many_to_one", "cross_filter": "both",
        }]),
    ])
    r = _resolver(model, "customers")
    res = resolve_filter_propagation(
        r, "customers", "orders.region",
        select_side_views=["customers"],   # only customers is projected (base)
    )
    assert res.mode == PropagationMode.EXISTS
    assert res.path is not None
    assert len(res.path.steps) == 1
    # The single step is the reverse synthesised edge.
    assert res.path.steps[0].edge.is_reverse is True
    assert res.path.steps[0].edge.cardinality == "one_to_many"


# ──────────────────────────────────────────────────────────────────────────
# SYMMETRIC — fan-out hop, target IS projected (joined dim for grouping)
# ──────────────────────────────────────────────────────────────────────────


def test_symmetric_when_target_is_select_side_with_fanout():
    """Chart on customers, GROUP BY orders.region (i.e., dim from joined fact).
    orders is in SELECT-side because the grouping dim is on it. The path
    customers → orders crosses 1:N → measure on customers needs symmetric
    aggregate (Phase 4) to avoid double-counting.
    """
    model = _Model([
        _Explore("orders", [{
            "view": "customers", "alias": "customers",
            "from_column": "customer_id", "to_column": "id",
            "cardinality": "many_to_one", "cross_filter": "both",
        }]),
    ])
    r = _resolver(model, "customers")
    res = resolve_filter_propagation(
        r, "customers", "orders.region",
        select_side_views=["customers", "orders"],
    )
    assert res.mode == PropagationMode.SYMMETRIC
    assert "customers" in res.symmetric_views


# ──────────────────────────────────────────────────────────────────────────
# JOIN_CHAIN — multi-hop snowflake, all M:1 single
# ──────────────────────────────────────────────────────────────────────────


def test_join_chain_3_hop_snowflake_all_forward():
    """orders → products → categories, all m:1 single direction.
    Filter on categories.name from base orders → 2-hop JOIN_CHAIN."""
    model = _Model([
        _Explore("orders", [{
            "view": "products", "alias": "products",
            "from_column": "product_id", "to_column": "id",
            "cardinality": "many_to_one", "cross_filter": "single",
        }]),
        _Explore("products", [{
            "view": "categories", "alias": "categories",
            "from_column": "category_id", "to_column": "id",
            "cardinality": "many_to_one", "cross_filter": "single",
        }]),
    ])
    r = _resolver(model, "orders")
    res = resolve_filter_propagation(r, "orders", "categories.name")
    assert res.mode == PropagationMode.JOIN_CHAIN
    assert len(res.path.steps) == 2
    assert res.path.steps[0].edge.to_node == "products"
    assert res.path.steps[1].edge.to_node == "categories"


# ──────────────────────────────────────────────────────────────────────────
# DROP/AMBIGUOUS — multiple equal-length paths via conformed dims
# ──────────────────────────────────────────────────────────────────────────


def test_drop_ambiguous_path_without_role_hint():
    """Classic ambiguity: activity → stage via owner OR via date.

    activity → owner   (m:1 both)
    activity → date    (m:1 both)
    deal     → owner   (m:1 both)
    deal     → date    (m:1 both)
    deal     → stage   (m:1 single)
    Two equal-length paths: activity → owner → deal → stage AND activity → date → deal → stage.
    """
    model = _Model([
        _Explore("activity", [
            {"view": "owner", "alias": "owner", "from_column": "owner_id",
             "to_column": "id", "cardinality": "many_to_one", "cross_filter": "both"},
            {"view": "date", "alias": "date", "from_column": "dt",
             "to_column": "date", "cardinality": "many_to_one", "cross_filter": "both"},
        ]),
        _Explore("deal", [
            {"view": "owner", "alias": "owner", "from_column": "owner_id",
             "to_column": "id", "cardinality": "many_to_one", "cross_filter": "both"},
            {"view": "date", "alias": "date", "from_column": "dt",
             "to_column": "date", "cardinality": "many_to_one", "cross_filter": "both"},
            {"view": "stage", "alias": "stage", "from_column": "stage_id",
             "to_column": "id", "cardinality": "many_to_one", "cross_filter": "single"},
        ]),
    ])
    r = _resolver(model, "activity")
    res = resolve_filter_propagation(r, "activity", "stage.process")
    assert res.mode == PropagationMode.DROP
    assert res.reason == DropReason.AMBIGUOUS_PATH
    # Description should mention both conformed dims so DA can pick.
    assert "owner" in res.detail or "date" in res.detail


def test_role_hint_disambiguates_ambiguous_path():
    """Same multi-path scenario; role hint picks one explicitly."""
    model = _Model([
        _Explore("activity", [
            {"view": "owner", "alias": "owner", "from_column": "owner_id",
             "to_column": "id", "cardinality": "many_to_one", "cross_filter": "both"},
            {"view": "date", "alias": "date", "from_column": "dt",
             "to_column": "date", "cardinality": "many_to_one", "cross_filter": "both"},
        ]),
        _Explore("deal", [
            {"view": "owner", "alias": "owner", "from_column": "owner_id",
             "to_column": "id", "cardinality": "many_to_one", "cross_filter": "both"},
            {"view": "date", "alias": "date", "from_column": "dt",
             "to_column": "date", "cardinality": "many_to_one", "cross_filter": "both"},
            {"view": "stage", "alias": "stage", "from_column": "stage_id",
             "to_column": "id", "cardinality": "many_to_one", "cross_filter": "single"},
        ]),
    ])
    r = _resolver(model, "activity")
    # Pick the owner-path explicitly via @ syntax
    res = resolve_filter_propagation(r, "activity", "stage.process@owner")
    # Result mode depends on whether resolved path has fanout
    # (activity → owner reverse=1:m → fanout → EXISTS).
    assert res.mode in (PropagationMode.EXISTS, PropagationMode.JOIN_CHAIN)
    # Path must traverse owner, not date.
    middle_nodes = [s.edge.to_node for s in res.path.steps]
    assert "owner" in middle_nodes
    assert "date" not in middle_nodes


# ──────────────────────────────────────────────────────────────────────────
# Cross-fact via shared dim — direction matters
# ──────────────────────────────────────────────────────────────────────────


def test_cross_fact_single_blocks_propagation():
    """Filter from fact A on fact B's dim using a SHARED dim that's only
    single-direction. PBI default: this should NOT propagate.

    revenue → owner (m:1 single)
    deal    → owner (m:1 single)
    Chart base = revenue, filter on deal.org_id.
    No reverse owner→deal exists (cross_filter=single). Unreachable.
    """
    model = _Model([
        _Explore("revenue", [{
            "view": "owner", "alias": "owner", "from_column": "owner_id",
            "to_column": "id", "cardinality": "many_to_one", "cross_filter": "single",
        }]),
        _Explore("deal", [{
            "view": "owner", "alias": "owner", "from_column": "owner_id",
            "to_column": "id", "cardinality": "many_to_one", "cross_filter": "single",
        }]),
    ])
    r = _resolver(model, "revenue")
    res = resolve_filter_propagation(r, "revenue", "deal.org_id")
    assert res.mode == PropagationMode.DROP
    assert res.reason == DropReason.UNREACHABLE_VIEW


def test_cross_fact_both_enables_propagation_via_exists():
    """Same scenario but cross_filter='both' on at least one side enables
    the reverse traversal. Path: revenue → owner (m:1 fwd) → deal (1:m rev).
    Last hop is fan-out → EXISTS.
    """
    model = _Model([
        _Explore("revenue", [{
            "view": "owner", "alias": "owner", "from_column": "owner_id",
            "to_column": "id", "cardinality": "many_to_one", "cross_filter": "both",
        }]),
        _Explore("deal", [{
            "view": "owner", "alias": "owner", "from_column": "owner_id",
            "to_column": "id", "cardinality": "many_to_one", "cross_filter": "both",
        }]),
    ])
    r = _resolver(model, "revenue")
    res = resolve_filter_propagation(r, "revenue", "deal.org_id",
                                      select_side_views=["revenue"])
    assert res.mode == PropagationMode.EXISTS
    assert res.path is not None
    assert len(res.path.steps) == 2  # revenue → owner → deal


# ──────────────────────────────────────────────────────────────────────────
# Invalid field ref
# ──────────────────────────────────────────────────────────────────────────


def test_invalid_field_ref_drops():
    model = _Model([_Explore("orders", [])])
    r = _resolver(model, "orders")
    res = resolve_filter_propagation(r, "orders", "")
    assert res.mode == PropagationMode.DROP
    assert res.reason == DropReason.UNREACHABLE_VIEW

    res2 = resolve_filter_propagation(r, "orders", "noview")
    assert res2.mode == PropagationMode.DROP
