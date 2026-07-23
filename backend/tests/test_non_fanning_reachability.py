"""Regression: non-fanning reachability is CARDINALITY-driven and, for 1:1,
DIRECTION-AGNOSTIC.

Locks the bug (BA report 2026-07-23) where ``_m1_reachable_views`` walked only
the join's AUTHORED explore forward, so a 1:1 A<->B was reachable one way and
treated as "unrelated" the other — making Measure engine / grain guard / filter
structural reach depend on which direction the modeller DREW the relationship.

Required invariant:
  * N:1 / 1:N  → structurally non-fanning-safe only MANY -> ONE
  * 1:1        → non-fanning-safe BOTH directions
  * N:N        → not non-fanning-safe either way (caller fails loud)
Structural relationship graph is SEPARATE from cross-filter propagation
direction: ``cross_filter`` (single/both) must never change structural safety.

Acceptance criterion: drawing the same 1:1 as A->B or B->A yields IDENTICAL
reachability (hence identical Measure result + group/filter capability).

Unit-level: hand-built fake model, no DB / no BigQuery — runnable anywhere.
"""
import os
import sys
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_nonfanning.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.semantic_query_engine import SemanticQueryEngine  # noqa: E402


def _engine(explores):
    """A SemanticQueryEngine wired with a fake model — only the non-fanning
    reachability path is exercised, which needs no DB."""
    eng = SemanticQueryEngine.__new__(SemanticQueryEngine)
    eng._model = SimpleNamespace(id=1, explores=explores)
    eng._nf_adj_cache = {}
    return eng


def _explore(base, joins):
    return SimpleNamespace(base_view_name=base, joins=joins)


def _join(view, cardinality, **extra):
    j = {"view": view, "cardinality": cardinality, "is_active": True}
    j.update(extra)
    return j


# ── 1 + 2 + 3: 1:1 is direction-agnostic + identical either way drawn ────────
def test_one_to_one_direction_agnostic():
    # A --1:1--> B stored on A's explore (authored A->B)
    ab = _engine([_explore("A", [_join("B", "one_to_one")]), _explore("B", [])])
    ra, rb = ab._m1_reachable_views("A"), ab._m1_reachable_views("B")
    assert "B" in ra and "A" in rb, "1:1 must be reachable BOTH ways"
    assert ra == rb == {"A", "B"}

    # SAME relationship drawn the OTHER way: B --1:1--> A stored on B's explore
    ba = _engine([_explore("B", [_join("A", "one_to_one")]), _explore("A", [])])
    assert ba._m1_reachable_views("A") == ra
    assert ba._m1_reachable_views("B") == rb  # acceptance: draw direction irrelevant


# ── 6: N:1 / 1:N unchanged (only MANY -> ONE is safe) ────────────────────────
def test_many_to_one_stays_one_directional():
    eng = _engine([_explore("fact", [_join("dim", "many_to_one")]), _explore("dim", [])])
    assert "dim" in eng._m1_reachable_views("fact")
    assert "fact" not in eng._m1_reachable_views("dim")  # dim->fact would fan out


def test_one_to_many_reaches_from_many_side_only():
    # X --1:N--> Y : X=one, Y=many -> only Y (many) reaches X (one)
    eng = _engine([_explore("X", [_join("Y", "one_to_many")]), _explore("Y", [])])
    assert "X" in eng._m1_reachable_views("Y")
    assert "Y" not in eng._m1_reachable_views("X")


# ── 7: N:N never non-fanning-safe ────────────────────────────────────────────
def test_many_to_many_not_reachable_either_way():
    eng = _engine([_explore("A", [_join("B", "many_to_many")]), _explore("B", [])])
    assert eng._m1_reachable_views("A") == {"A"}
    assert eng._m1_reachable_views("B") == {"B"}


def test_unknown_cardinality_not_reachable():
    # STRICT PowerBI parity — never GUESS M:1 for an undeclared cardinality.
    eng = _engine([_explore("A", [_join("B", "")]), _explore("B", [])])
    assert eng._m1_reachable_views("A") == {"A"}


# ── 5: cross_filter is a separate concern from structural safety ─────────────
def test_cross_filter_does_not_change_structural_safety():
    single = _engine([_explore("fact", [_join("dim", "many_to_one", cross_filter="single")]),
                      _explore("dim", [])])
    both = _engine([_explore("fact", [_join("dim", "many_to_one", cross_filter="both")]),
                    _explore("dim", [])])
    assert single._m1_reachable_views("fact") == both._m1_reachable_views("fact")
    # cross_filter=both must NOT make the dim reach its fact (that is propagation
    # direction, not non-fanning structure).
    assert "fact" not in both._m1_reachable_views("dim")


def test_inactive_join_skipped_both_directions():
    eng = _engine([_explore("A", [_join("B", "one_to_one", is_active=False)]), _explore("B", [])])
    assert eng._m1_reachable_views("A") == {"A"}
    assert eng._m1_reachable_views("B") == {"B"}


# ── snowflake multi-hop + a 1:1 bridge, from either end ──────────────────────
def test_snowflake_multi_hop_and_one_to_one_bridge():
    explores = [
        _explore("sales", [_join("product", "many_to_one"), _join("sales_ext", "one_to_one")]),
        _explore("product", [_join("category", "many_to_one")]),
        _explore("category", []),
        _explore("sales_ext", []),
    ]
    eng = _engine(explores)
    assert eng._m1_reachable_views("sales") == {"sales", "product", "category", "sales_ext"}
    # From the 1:1 partner, sales + its whole M:1 snowflake are reachable.
    assert eng._m1_reachable_views("sales_ext") == {"sales", "product", "category", "sales_ext"}
    # A leaf dim reaches nothing upward (no fan-out toward the fact).
    assert eng._m1_reachable_views("category") == {"category"}
