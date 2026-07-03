"""Phase-1 unit tests — relationship metadata first-class.

Pure unit-level: tests the helpers/dataclasses without DB. The schema +
add_join integration is verified via the golden harness (regression_filter_matrix)
running against the seeded dataset 56.
"""
import os
os.environ.setdefault("DATABASE_URL", "postgresql://stub@localhost/stub")

import pytest

from app.services.semantic_join_resolver import (
    ALLOWED_CARDINALITY,
    JoinEdge,
    JoinPath,
    JoinStep,
    SemanticJoinResolver,
    invert_cardinality,
    normalize_cardinality,
)


# ──────────────────────────────────────────────────────────────────────────
# normalize_cardinality / invert_cardinality
# ──────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("raw,expected", [
    # Canonical forms pass through.
    ("one_to_one", "one_to_one"),
    ("one_to_many", "one_to_many"),
    ("many_to_one", "many_to_one"),
    ("many_to_many", "many_to_many"),
    # Hyphenated alias.
    ("one-to-many", "one_to_many"),
    ("many-to-one", "many_to_one"),
    # Mixed case + whitespace.
    ("  Many_To_One  ", "many_to_one"),
    ("MANY-TO-MANY", "many_to_many"),
    # Short notation.
    ("1:1", "one_to_one"),
    ("1:N", "one_to_many"),
    ("N:1", "many_to_one"),
    ("M:N", "many_to_many"),
    # Unknown / empty falls back to many_to_one (FK→PK star-schema default).
    ("", "many_to_one"),
    (None, "many_to_one"),
    ("garbage", "many_to_one"),
])
def test_normalize_cardinality(raw, expected):
    assert normalize_cardinality(raw) == expected


@pytest.mark.parametrize("forward,reverse", [
    ("one_to_one", "one_to_one"),
    ("one_to_many", "many_to_one"),
    ("many_to_one", "one_to_many"),
    ("many_to_many", "many_to_many"),
])
def test_invert_cardinality(forward, reverse):
    assert invert_cardinality(forward) == reverse


def test_allowed_cardinality_constant():
    assert ALLOWED_CARDINALITY == {
        "one_to_one", "one_to_many", "many_to_one", "many_to_many",
    }


# ──────────────────────────────────────────────────────────────────────────
# JoinEdge dataclass — new fields preserve back-compat defaults
# ──────────────────────────────────────────────────────────────────────────


def test_joinedge_defaults():
    e = JoinEdge(
        from_node="a", to_node="b", to_view="b", type="left", sql_on="",
        from_column="x", to_column="y", relationship=None,
    )
    assert e.is_active is True
    assert e.cross_filter == "single"
    assert e.cardinality == "many_to_one"   # NEW default
    assert e.is_reverse is False             # NEW default


def test_joinedge_explicit_cardinality():
    e = JoinEdge(
        from_node="a", to_node="b", to_view="b", type="left", sql_on="",
        from_column="x", to_column="y", relationship=None,
        cardinality="one_to_many",
    )
    assert e.cardinality == "one_to_many"


# ──────────────────────────────────────────────────────────────────────────
# _edge_from_join_dict reads new + legacy cardinality keys
# ──────────────────────────────────────────────────────────────────────────


def test_edge_from_dict_reads_cardinality_field():
    e = SemanticJoinResolver._edge_from_join_dict("orders", {
        "view": "customers", "alias": "customers",
        "from_column": "customer_id", "to_column": "id",
        "cardinality": "many_to_one",
        "cross_filter": "single",
    })
    assert e is not None
    assert e.cardinality == "many_to_one"
    assert e.cross_filter == "single"
    assert e.is_reverse is False


def test_edge_from_dict_falls_back_to_relationship_field():
    """Legacy data: no `cardinality` key, only `relationship`. Should map."""
    e = SemanticJoinResolver._edge_from_join_dict("orders", {
        "view": "customers",
        "from_column": "customer_id", "to_column": "id",
        "relationship": "1:N",   # legacy short form
    })
    assert e is not None
    assert e.cardinality == "one_to_many"


def test_edge_from_dict_unknown_cardinality_defaults():
    e = SemanticJoinResolver._edge_from_join_dict("orders", {
        "view": "customers",
        "from_column": "x", "to_column": "y",
        "cardinality": "bogus",
    })
    assert e.cardinality == "many_to_one"  # safe default


# ──────────────────────────────────────────────────────────────────────────
# _build_graph reverse edge synthesis — preserves correct inverse cardinality
# ──────────────────────────────────────────────────────────────────────────


class _StubExplore:
    def __init__(self, base_view_name, joins):
        self.base_view_name = base_view_name
        self.joins = joins


class _StubModel:
    def __init__(self, explores):
        self.explores = explores


def test_build_graph_reverse_edge_inverts_cardinality_when_both():
    """When user declares many_to_one + cross_filter='both', resolver synthesises
    a reverse edge with cardinality='one_to_many' so the propagation engine
    sees correct fan-out direction."""
    model = _StubModel(explores=[
        _StubExplore("orders", [{
            "view": "customers", "alias": "customers",
            "from_column": "customer_id", "to_column": "id",
            "cardinality": "many_to_one",
            "cross_filter": "both",
        }]),
    ])
    r = SemanticJoinResolver(db=None, model=model, base_node="orders")
    # Forward edge: orders → customers (m:1, declared)
    fwd = [e for e in r._adj.get("orders", []) if e.to_node == "customers"]
    assert len(fwd) == 1
    assert fwd[0].cardinality == "many_to_one"
    assert fwd[0].is_reverse is False
    # Reverse edge: customers → orders (1:m, synthesised)
    rev = [e for e in r._adj.get("customers", []) if e.to_node == "orders"]
    assert len(rev) == 1
    assert rev[0].cardinality == "one_to_many"
    assert rev[0].is_reverse is True
    assert rev[0].cross_filter == "both"


def test_build_graph_no_reverse_when_single():
    """cross_filter='single' (default) — no reverse edge synthesised."""
    model = _StubModel(explores=[
        _StubExplore("orders", [{
            "view": "customers", "alias": "customers",
            "from_column": "customer_id", "to_column": "id",
            "cardinality": "many_to_one",
            "cross_filter": "single",
        }]),
    ])
    r = SemanticJoinResolver(db=None, model=model, base_node="orders")
    rev = [e for e in r._adj.get("customers", []) if e.to_node == "orders"]
    assert rev == []  # no reverse


def test_build_graph_legacy_bidirectional_still_works():
    """`bidirectional=True` (constructor flag) still creates reverse for back-compat.

    Used by `reachable_fields_for_model` to populate `reachableViews` for
    every chart — kept legacy until Phase 2 ships its replacement.
    """
    model = _StubModel(explores=[
        _StubExplore("orders", [{
            "view": "customers", "alias": "customers",
            "from_column": "customer_id", "to_column": "id",
            "cardinality": "many_to_one",
            "cross_filter": "single",   # NOT both — but bidirectional flag forces reverse
        }]),
    ])
    r = SemanticJoinResolver(db=None, model=model, base_node="orders", bidirectional=True)
    rev = [e for e in r._adj.get("customers", []) if e.to_node == "orders"]
    assert len(rev) == 1
    assert rev[0].is_reverse is True


# ──────────────────────────────────────────────────────────────────────────
# resolve_paths — returns ALL shortest paths (ambiguity detection)
# ──────────────────────────────────────────────────────────────────────────


def test_resolve_paths_single_when_one_route():
    model = _StubModel(explores=[
        _StubExplore("orders", [{
            "view": "customers", "alias": "customers",
            "from_column": "customer_id", "to_column": "id",
            "cardinality": "many_to_one", "cross_filter": "single",
        }]),
    ])
    r = SemanticJoinResolver(db=None, model=model, base_node="orders")
    paths = r.resolve_paths("customers")
    assert len(paths) == 1
    assert paths[0].steps[0].edge.to_node == "customers"
    assert paths[0].ambiguous is False


def test_resolve_paths_empty_when_unreachable():
    model = _StubModel(explores=[_StubExplore("a", []), _StubExplore("b", [])])
    r = SemanticJoinResolver(db=None, model=model, base_node="a")
    assert r.resolve_paths("b") == []


def test_resolve_paths_self_returns_empty_steps():
    model = _StubModel(explores=[_StubExplore("a", [])])
    r = SemanticJoinResolver(db=None, model=model, base_node="a")
    paths = r.resolve_paths("a")
    assert len(paths) == 1
    assert paths[0].steps == []


def test_resolve_paths_finds_multiple_shortest_paths():
    """Two equal-length paths from activity to stage via different conformed dims.

    activity → owner → deal → stage   AND   activity → date → deal → stage
    Both length 3, both should appear with ambiguous=True.
    """
    model = _StubModel(explores=[
        _StubExplore("activity", [
            {"view": "owner", "alias": "owner", "from_column": "owner_id", "to_column": "id",
             "cardinality": "many_to_one", "cross_filter": "both", "is_active": True},
            {"view": "date", "alias": "date", "from_column": "dt", "to_column": "date",
             "cardinality": "many_to_one", "cross_filter": "both", "is_active": True},
        ]),
        _StubExplore("deal", [
            {"view": "owner", "alias": "owner", "from_column": "owner_id", "to_column": "id",
             "cardinality": "many_to_one", "cross_filter": "both", "is_active": True},
            {"view": "date", "alias": "date", "from_column": "dt", "to_column": "date",
             "cardinality": "many_to_one", "cross_filter": "both", "is_active": True},
            {"view": "stage", "alias": "stage", "from_column": "stage_id", "to_column": "id",
             "cardinality": "many_to_one", "cross_filter": "single", "is_active": True},
        ]),
    ])
    r = SemanticJoinResolver(db=None, model=model, base_node="activity")
    paths = r.resolve_paths("stage")
    assert len(paths) == 2, f"expected 2 paths, got {len(paths)}"
    assert all(p.ambiguous for p in paths)
    # Both paths must have length 3 (activity → conformed → deal → stage)
    assert all(len(p.steps) == 3 for p in paths)
    # The middle hop (conformed dim) should differ: one via owner, one via date
    middle_nodes = {p.steps[0].edge.to_node for p in paths}
    assert middle_nodes == {"owner", "date"}


def test_resolve_path_back_compat_deterministic():
    """Singular ``resolve_path`` keeps the pre-Phase-1 deterministic BFS so all
    callers (chart engine EXISTS builder, distinct cascade) get the SAME path
    they did before — critical: changing the picked path would change emitted
    SQL → change result data → break golden harness without intent.

    Use :meth:`resolve_paths` for true ambiguity detection in the Phase-2
    propagation engine (where multi-path matters).
    """
    model = _StubModel(explores=[
        _StubExplore("activity", [
            {"view": "owner", "alias": "owner", "from_column": "x", "to_column": "id",
             "cardinality": "many_to_one", "cross_filter": "both"},
            {"view": "date", "alias": "date", "from_column": "y", "to_column": "id",
             "cardinality": "many_to_one", "cross_filter": "both"},
        ]),
        _StubExplore("stage", [
            {"view": "owner", "alias": "owner", "from_column": "x", "to_column": "id",
             "cardinality": "many_to_one", "cross_filter": "both"},
            {"view": "date", "alias": "date", "from_column": "y", "to_column": "id",
             "cardinality": "many_to_one", "cross_filter": "both"},
        ]),
    ])
    r = SemanticJoinResolver(db=None, model=model, base_node="activity")
    p1 = r.resolve_path("stage")
    p2 = r.resolve_path("stage")
    assert p1 is not None and p2 is not None
    # Same picked path across calls (determinism)
    assert [s.edge.to_node for s in p1.steps] == [s.edge.to_node for s in p2.steps]
    # Path length must be 2 (activity → conformed → stage)
    assert len(p1.steps) == 2
    # Phase-2 ambiguity detection lives in resolve_paths (plural)
    all_paths = r.resolve_paths("stage")
    assert len(all_paths) >= 2, "multi-path scenario should surface ≥2 routes"
    assert all(p.ambiguous for p in all_paths)
