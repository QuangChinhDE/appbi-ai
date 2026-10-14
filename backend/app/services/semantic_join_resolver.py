"""
Semantic join graph resolver.

Builds an in-memory join graph from a SemanticModel's explores and resolves
multi-hop join paths between views. Supports role-playing dimensions via the
optional `alias` field on a JoinDefinition.

Reference key concepts:
- "view name": the name of a SemanticView (logical table)
- "alias": an optional name on a join used to reference a joined view when the
  same view is joined multiple times (e.g. orders → users as creator vs updater).
  When alias is missing, falls back to the view name.
- "node id": the identifier used in the resolver graph. Equals alias when
  set, otherwise the view name. Semantic field references in chart bindings,
  filters, etc. use `node_id.field`.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Iterable

from sqlalchemy.orm import Session

from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.core.logging import get_logger

logger = get_logger(__name__)


# ── Perf (#6): join-graph cache ──────────────────────────────────────────────
# The resolver graph (_adj + _node_to_view) is built PURELY from
# ``model.explores[].joins`` (JSON) — it holds no ORM rows, only frozen
# ``JoinEdge`` dataclasses + strings, so it is safe to share read-only across
# requests. Rebuilding it per chart was part of the per-tile semantic cost
# (every dashboard tile constructs a resolver inside ``generate_sql``). Cache
# it keyed by (model_id, model.updated_at, bidirectional): the ``updated_at``
# component means ANY model edit (joins changed, view renamed, relationship
# flipped) produces a new key, so a stale graph can never be served. The graph
# is NEVER mutated after construction (only read by reachable_nodes /
# resolve_path), so sharing the dict objects is safe.
#
# Scope is deliberately narrow (user decision 2026-06-10): ONLY the pure graph
# is cached. ORM SemanticView loading + the isolation/EXISTS correctness
# machinery still run fresh per request, untouched.
_GRAPH_CACHE: dict[tuple, tuple[dict, dict]] = {}
_GRAPH_CACHE_LOCK = __import__("threading").Lock()
_GRAPH_CACHE_MAX = 256


def _graph_cache_key(model: "SemanticModel | None", bidirectional: bool):
    """Stable key, or None when the model can't be safely keyed (always rebuild).

    CORRECTNESS NOTE: ``SemanticModel.updated_at`` is NOT enough on its own.
    ``add_join`` / ``remove_join`` mutate ``SemanticExplore.joins`` and commit
    the EXPLORE row — they do NOT touch the parent model's timestamp. Keying on
    ``model.updated_at`` alone would therefore serve a STALE join graph after a
    relationship edit → silently wrong query results. So the key folds in a
    signature over every explore's (id, base_view_name, joins JSON), which is
    exactly the data ``_build_graph`` consumes. Any join add/remove/flip changes
    that signature and forces a rebuild. The signature is built from in-memory
    JSON the resolver already holds (no extra DB round-trip)."""
    if model is None:
        return None
    model_id = getattr(model, "id", None)
    if model_id is None:
        return None
    try:
        import json
        explores_sig = json.dumps(
            [
                [
                    getattr(ex, "id", None),
                    str(getattr(ex, "base_view_name", "") or ""),
                    getattr(ex, "joins", None) or [],
                ]
                for ex in (model.explores or [])
            ],
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
    except Exception:
        # If the explore graph can't be serialised (unexpected shape), don't
        # cache — rebuild every time rather than risk a stale/incorrect graph.
        return None
    sig = __import__("hashlib").sha256(explores_sig.encode("utf-8")).hexdigest()
    return (int(model_id), sig, bool(bidirectional))


@dataclass(frozen=True)
class JoinEdge:
    """A directed join edge from one node to another in the graph."""
    from_node: str       # source node id (alias or view)
    to_node: str         # target node id (alias or view)
    to_view: str         # actual view name to query
    type: str            # "left" | "inner" | "right" | "full"
    sql_on: str          # raw sql_on from join definition
    from_column: str | None
    to_column: str | None
    relationship: str | None
    # Phase-3b additions. Defaults preserve pre-Phase-3 behaviour (every join
    # is active + uni-directional) so legacy `joins` JSON without these keys
    # still build the same graph.
    is_active: bool = True
    cross_filter: str = "single"   # "single" | "both"
    # Phase-1 (PBI-parity migration) additions.  Canonical cardinality drives
    # the propagation engine (Phase 2) and symmetric-aggregate emitter
    # (Phase 4). `relationship` is preserved as a legacy alias and carries
    # the same value when reading legacy JSON via `_edge_from_join_dict`.
    cardinality: str = "many_to_one"   # "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many"
    # Synthesised reverse edges are marked so the propagation engine can
    # distinguish "user-declared forward edge" from "auto reverse"; matters
    # for direction-respecting filter propagation rules (Phase 2).
    is_reverse: bool = False
    # The FULL key ((from_col, to_col), ...) from the relationship contract —
    # from_column/to_column above are only its first pair.
    key_pairs: tuple = ()
    # The RELATIONSHIP's cross_filter as authored. A synthetic reverse edge
    # carries cross_filter="both" so the walk can use it, but whether a FILTER
    # may travel it is the relationship's own setting (see edge_propagates).
    # Empty → the edge's cross_filter.
    rel_cross_filter: str = ""
    # The relationship's condition is a plain AND of key equalities (no CAST /
    # expression): only then may a chain of them be read as the key equalities
    # it composes to (`route_key_mapping`). Carried on reverse edges.
    plain_keys: bool = True


def edge_propagates(edge: "JoinEdge") -> bool:
    """May a filter on ``edge.to_node`` restrict ``edge.from_node``'s rows?

    Walking toward the ONE side (many-to-one, one-to-one) — always: a filter on
    a dimension restricts the fact it describes. Walking toward a MANY side
    (the reverse of a many-to-one, a one-to-many, a many-to-many) — only when
    the relationship filters both ways (cross_filter "both"). A reverse edge
    the resolver adds in bidirectional mode is a WALK, never a filter path."""
    card = canonical_cardinality(getattr(edge, "cardinality", None))
    if card in ("many_to_one", "one_to_one"):
        return True
    if card == "many_to_many" and not getattr(edge, "is_reverse", False):
        # A many-to-many walked as DRAWN filters like a many-to-one: its far
        # side restricts its near side (single direction is the recommended
        # M:N setting). Walked in reverse it needs "both", like any 1:N walk.
        return True
    return (getattr(edge, "rel_cross_filter", "") or getattr(edge, "cross_filter", "")) == "both"


# Canonical cardinality vocabulary + alias map (kept in this module so both
# resolver and add_join validation share one source of truth).
ALLOWED_CARDINALITY = frozenset({"one_to_one", "one_to_many", "many_to_one", "many_to_many"})
_CARDINALITY_ALIASES = {
    "one_to_one": "one_to_one", "one-to-one": "one_to_one", "1:1": "one_to_one",
    "one_to_many": "one_to_many", "one-to-many": "one_to_many",
    "1:n": "one_to_many", "1:m": "one_to_many",
    "many_to_one": "many_to_one", "many-to-one": "many_to_one",
    "n:1": "many_to_one", "m:1": "many_to_one",
    "many_to_many": "many_to_many", "many-to-many": "many_to_many",
    "n:m": "many_to_many", "m:n": "many_to_many",
}
_INVERT_CARDINALITY = {
    "one_to_one": "one_to_one",
    "one_to_many": "many_to_one",
    "many_to_one": "one_to_many",
    "many_to_many": "many_to_many",
}


def canonical_cardinality(raw: str | None) -> str | None:
    """STRICT canonical form: the canonical value for a known spelling
    (``N:1``, ``many-to-one``…), ``None`` for empty OR unknown input.

    Anything that decides whether a join is safe (grain guard) or accepts a
    relationship from a caller (write paths) uses this; unknown text never
    becomes many_to_one."""
    if raw is None:
        return None
    key = str(raw).strip().lower().replace("-", "_")
    if not key:
        return None
    return _CARDINALITY_ALIASES.get(key)


def invert_cardinality(c: str | None) -> str | None:
    """Cardinality of the reverse edge — symmetric for 1:1 and N:M. STRICT:
    an unknown value has no inverse (None), never a guessed many_to_one. (The
    lenient ``normalize_cardinality`` that mapped garbage to many_to_one was
    removed: every reader goes through ``read_join_contract``.)"""
    canon = canonical_cardinality(c)
    return _INVERT_CARDINALITY.get(canon) if canon else None


class SemanticRefusal(ValueError):
    """A query the semantic planner refuses ON PURPOSE, with a machine-readable
    ``category`` (the message stays the user-facing, localized text — a
    ValueError, HTTP 400). Tests and callers identify the semantic failure by
    ``category``, never by matching the message or a warehouse error."""

    AMBIGUOUS_ROUTE = "AMBIGUOUS_ROUTE"          # two routes / date roles, different meanings
    UNRELATED_GRAIN = "UNRELATED_GRAIN"          # a dimension with no many-to-one path from a measure's fact
    FANOUT_RISK = "FANOUT_RISK"                  # the only way to answer would multiply rows
    UNSUPPORTED_CONTEXT = "UNSUPPORTED_CONTEXT"  # a context the engine cannot evaluate correctly
    UNREACHABLE_VIEW = "UNREACHABLE_VIEW"        # no relationship path to a view the request needs
    INVALID_RELATIONSHIP = "INVALID_RELATIONSHIP"
    UNVERIFIABLE_KEY = "UNVERIFIABLE_KEY"
    ROUTE_LIMIT = "ROUTE_LIMIT"                  # the planner could not see every route within its bounds

    category = "REFUSED"

    def __init__(self, message: str, category: str | None = None):
        super().__init__(message)
        if category:
            self.category = category


class AmbiguousJoinPathError(SemanticRefusal):
    """Two or more equally short join routes with DIFFERENT meaning reach the
    same target (e.g. sales→customers→regions vs sales→stores→regions). Picking
    one would make the number depend on which relationship was created first,
    so the query is refused until the model disambiguates (an inactive
    relationship or an aliased role-played join)."""

    category = SemanticRefusal.AMBIGUOUS_ROUTE

    def __init__(self, target: str, routes: list[str]):
        self.target = target
        self.routes = routes
        super().__init__(
            f"Có {len(routes)} đường join khác nghĩa nhau tới '{target}': "
            + " | ".join(routes)
            + ". Kết quả sẽ phụ thuộc đường nào được chọn, nên truy vấn bị từ chối. "
            "Trong Data Model, đánh dấu Inactive một quan hệ, hoặc dùng alias (role-playing) "
            "để chỉ rõ đường cần dùng."
        )


# The planner's route bounds. Within them every route is seen; past them the
# query is REFUSED (RouteEnumerationIncomplete) — a meaning picked from the
# routes that happened to be enumerated first could be the wrong one.
ROUTE_MAX_DEPTH = 8
ROUTE_CAP = 64


class RouteEnumerationIncomplete(SemanticRefusal):
    """The relationship routes to ``target`` could not ALL be enumerated within
    the planner's bounds (more than ``ROUTE_CAP`` routes, or a route longer
    than ``ROUTE_MAX_DEPTH`` hops). Choosing among, or AND-ing, a partial set
    would answer as if the unseen routes did not exist — refused instead."""

    category = SemanticRefusal.ROUTE_LIMIT

    def __init__(self, target: str):
        self.target = target
        super().__init__(
            f"Mô hình có quá nhiều (hơn {ROUTE_CAP}) hoặc quá dài (hơn {ROUTE_MAX_DEPTH} bước) đường quan hệ "
            f"tới '{target}' để xác định đầy đủ ý nghĩa của truy vấn, nên truy vấn bị từ chối thay vì chỉ "
            "dùng một phần các đường. Trong Data Model, đánh dấu Inactive bớt quan hệ, đặt cross filter "
            "về single, hoặc dùng alias để chỉ rõ đường cần dùng.",
            SemanticRefusal.ROUTE_LIMIT,
        )


def _stable(x):
    """A value with every (frozen)set turned into a sorted tuple — an order
    that does not depend on the process's hash seed."""
    if isinstance(x, (set, frozenset)):
        return tuple(sorted((_stable(e) for e in x), key=repr))
    if isinstance(x, tuple):
        return tuple(_stable(e) for e in x)
    return x


def route_key_mapping(steps) -> frozenset | None:
    """What a chain of key-equality hops COMPARES, end to end: the set of
    (first view's column, last view's column) equalities it composes to, when
    every hop passes the previous hop's key straight through
    (``sales.product_id = dim_product.product_id`` then
    ``dim_product.product_id = products.product_id`` composes to
    ``sales.product_id = products.product_id`` — the direct relationship's
    meaning). ``None`` when a hop is not a pure key equality or reaches the
    next view by ANOTHER column (``customers.region_id``): then the chain means
    something of its own."""
    mapping = None
    for st in steps:
        pairs = tuple(getattr(st.edge, "key_pairs", ()) or ())
        if not pairs or not getattr(st.edge, "plain_keys", True):
            return None
        if mapping is None:
            mapping = {(f, t) for f, t in pairs}
            continue
        by_target: dict = {}
        for a, b in mapping:
            by_target.setdefault(b, set()).add(a)
        nxt = set()
        for f, t in pairs:
            if f not in by_target:
                return None
            nxt |= {(a, t) for a in by_target[f]}
        mapping = nxt
    return frozenset(mapping) if mapping else None


def route_meaning_segments(steps) -> tuple:
    """A route as what it MEANS: maximal runs of hops that pass a key straight
    through are one segment (start view, end view, the key equalities they
    compose to); any other hop is its own segment (its relationship). Two
    routes with the same segments compare the same rows the same way —
    ``products ← dim_product ← sales → txn_date`` (product_id throughout, then
    the sale's date) is ``products ← sales → txn_date``."""
    out: list = []
    run: list = []

    def _close():
        if run:
            keys = route_key_mapping(run)
            out.append((run[0].edge.from_node, run[-1].edge.to_node, keys))
            run.clear()

    for st in steps:
        if not tuple(getattr(st.edge, "key_pairs", ()) or ()) or not getattr(st.edge, "plain_keys", True):
            _close()
            out.append((st.edge.from_node, st.edge.to_node, ("rel", _edge_signature(st.edge))))
            continue
        if run and route_key_mapping(run + [st]) is None:
            _close()
        run.append(st)
    _close()
    return tuple(out)


def hop_is_to_one(edge: "JoinEdge") -> bool:
    """A hop toward a ONE side (many-to-one, one-to-one): maps each row to at
    most one row of the next view."""
    return canonical_cardinality(getattr(edge, "cardinality", None)) in ("many_to_one", "one_to_one")


_re = __import__("re")
# One side of a key equality: `${TABLE}.col`, `${node}.col`, or LookML `${node.col}`.
_ON_OPERAND = r"\$\{(TABLE|[A-Za-z_][A-Za-z0-9_]*)\}\.([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\}"
_ON_EQUALITY_RE = _re.compile(rf"\s*(?:{_ON_OPERAND})\s*=\s*(?:{_ON_OPERAND})\s*")


def _edge_signature(edge: "JoinEdge") -> tuple:
    """Direction-independent identity of the relationship an edge walks: the
    two node ids and the key-column pairs. A forward edge and the synthetic
    reverse of the SAME relationship share a signature, so they are one route,
    not an ambiguity — whichever spelling the condition uses (`${TABLE}.a =
    ${v}.b`, the reverse order, or LookML `${v.a}`). A condition that is not an
    AND of key equalities keeps its SQL text as its identity."""

    def _node(ref: str) -> str:
        if ref == "TABLE":
            return edge.from_node
        if ref in (edge.to_node, edge.to_view):
            return edge.to_node
        return ref

    sql_on = str(edge.sql_on or "").strip()
    if not sql_on:
        pairs = set()
        if edge.from_column and edge.to_column:
            pairs.add(frozenset({(edge.from_node, edge.from_column), (edge.to_node, edge.to_column)}))
        return (frozenset({edge.from_node, edge.to_node}), frozenset(pairs))
    pairs = set()
    for part in _re.split(r"\s+AND\s+", sql_on, flags=_re.I):
        m = _ON_EQUALITY_RE.fullmatch(part)
        if not m:
            return (frozenset({edge.from_node, edge.to_node}), ("sql", " ".join(sql_on.split())))
        a1, c1, b1, d1, a2, c2, b2, d2 = m.groups()
        left = (_node(a1 or b1), c1 or d1)
        right = (_node(a2 or b2), c2 or d2)
        pairs.add(frozenset({left, right}))
    return (frozenset({edge.from_node, edge.to_node}), frozenset(pairs))


# ── The relationship contract ────────────────────────────────────────────────
# ONE reading of a persisted join (SemanticExplore.joins[i]) for every consumer:
# the resolver graph, the engine's grain graph, the semantic health checks and
# the field pickers. Writers produce the canonical form; legacy rows written
# before it are read through an EXPLICIT canonicalization (`legacy` notes) or
# are INVALID (`invalid` reasons) — nothing unknown is ever defaulted to a
# stronger assumption (many-to-one, active, single-direction).
#
#   cardinality   `cardinality`, else the legacy mirror `relationship`; both
#                 present must agree; unknown text or neither → INVALID
#   is_active     missing → active (documented default for pre-Phase-3 rows);
#                 a JSON boolean; the strings "true"/"false" and the integers
#                 1/0 (legacy spellings) → that boolean; anything else → INVALID
#   cross_filter  missing/empty → "single" (documented default); "single" /
#                 "both" in any case; anything else → INVALID
#   key pairs     from `sql_on` when it is an AND of key equalities (any
#                 spelling: ${TABLE}.a = ${v}.b, reversed, LookML ${v.a});
#                 otherwise (an expression such as a calendar CAST) from the
#                 column lists; the two must agree when both exist; no key at
#                 all → INVALID

_TRUE_STRINGS = {"true"}
_FALSE_STRINGS = {"false"}


@dataclass(frozen=True)
class JoinContract:
    view: str
    alias: str | None
    node: str                    # resolver node id: alias, else view
    from_view: str
    cardinality: str | None      # canonical; None only when invalid
    is_active: bool
    cross_filter: str
    key_pairs: tuple             # ((from_col, to_col), ...) — the FULL key
    key_source: str              # "sql_on" | "columns" | "expression"
    sql_on: str
    invalid: tuple = ()          # reasons this row cannot be used
    legacy: tuple = ()           # canonicalizations applied to a legacy row
    # False when `is_active` itself is unreadable: the row's activation is then
    # unknown, and an unknown activation is never treated as "off".
    activation_known: bool = True

    @property
    def valid(self) -> bool:
        return not self.invalid

    @property
    def dormant(self) -> bool:
        """Invalid, but DEFINITIVELY inactive (is_active false / "false" / 0):
        it is not part of any graph and cannot influence a query, so it does
        not refuse the model's queries — health reports it as repair-needed,
        and no writer can activate it while it is invalid."""
        return bool(self.invalid) and self.activation_known and not self.is_active

    @property
    def blocks_runtime(self) -> bool:
        """Invalid and possibly active: every query on the model is refused."""
        return bool(self.invalid) and not self.dormant

    @property
    def identity(self) -> tuple:
        """Stable identity, independent of array position and key order."""
        return (self.from_view, self.node, frozenset(self.key_pairs))


def _parse_key_equalities(sql_on: str, *, from_refs: set, to_refs: set):
    """[(from_col, to_col), ...] when `sql_on` is an AND of key equalities
    between the from side and the to side (either order, any spelling);
    "expression" when it is something else; raises ValueError when an operand
    names a table that is neither side."""
    pairs = []
    for part in _re.split(r"\s+AND\s+", sql_on.strip(), flags=_re.I):
        m = _ON_EQUALITY_RE.fullmatch(part)
        if not m:
            return "expression"
        a1, c1, b1, d1, a2, c2, b2, d2 = m.groups()
        sides = []
        for ref, col in ((a1 or b1, c1 or d1), (a2 or b2, c2 or d2)):
            if ref == "TABLE" or ref in from_refs:
                sides.append(("from", col))
            elif ref in to_refs:
                sides.append(("to", col))
            else:
                raise ValueError(f"sql_on tham chiếu '{ref}', không phải hai bảng của quan hệ")
        if {s for s, _ in sides} != {"from", "to"}:
            raise ValueError("sql_on so sánh hai cột cùng một bảng")
        f = next(c for s, c in sides if s == "from")
        t = next(c for s, c in sides if s == "to")
        pairs.append((f, t))
    return pairs


def _expression_column_refs(sql_on: str, *, from_refs: set, to_refs: set):
    """({from cols}, {to cols}) an expression condition reads, or None when it
    names a table that is neither side of the relationship."""
    used_from: set = set()
    used_to: set = set()
    refs = [(m.group(1), m.group(2)) for m in _re.finditer(r"\$\{(\w+)\}\.(\w+)", sql_on)]
    refs += [(m.group(1), m.group(2)) for m in _re.finditer(r"\$\{(\w+)\.(\w+)\}", sql_on)]
    for ref, col in refs:
        if ref == "TABLE" or ref in from_refs:
            used_from.add(col)
        elif ref in to_refs:
            used_to.add(col)
        else:
            return None
    return used_from, used_to


def read_join_contract(from_view: str, join) -> JoinContract:
    """The contract of one persisted join row (see the block comment above)."""
    invalid: list[str] = []
    legacy: list[str] = []
    if not isinstance(join, dict):
        return JoinContract(view="", alias=None, node="", from_view=from_view, cardinality=None,
                            is_active=False, cross_filter="single", key_pairs=(), key_source="columns",
                            sql_on="", invalid=("quan hệ không phải một object",))
    view = str(join.get("view") or "").strip()
    if not view:
        invalid.append("thiếu bảng đích (view)")
    alias = str(join.get("alias") or "").strip() or None
    explicit_from = str(join.get("from_view") or "").strip()
    src = explicit_from or from_view
    if explicit_from and from_view and explicit_from != from_view:
        # A row stored on one explore but claiming another source table: the
        # model editor never shows it (it lists rows by explore) while the graph
        # would add it from `from_view` — two different relationships.
        invalid.append(f"from_view '{explicit_from}' khác bảng gốc của explore '{from_view}'")

    # cardinality
    raw_c, raw_r = join.get("cardinality"), join.get("relationship")
    c = canonical_cardinality(raw_c) if raw_c not in (None, "") else None
    r = canonical_cardinality(raw_r) if raw_r not in (None, "") else None
    if raw_c not in (None, "") and c is None:
        invalid.append(f"cardinality {raw_c!r} không hợp lệ")
    if raw_r not in (None, "") and r is None:
        invalid.append(f"relationship {raw_r!r} không hợp lệ")
    if c and r and c != r:
        invalid.append(f"cardinality={c} mâu thuẫn relationship={r}")
    cardinality = c or r
    if cardinality is None and not any("không hợp lệ" in x for x in invalid):
        invalid.append("thiếu cardinality (không mặc định many_to_one)")
    if c is None and r is not None and not invalid:
        legacy.append("cardinality đọc từ relationship")
    if raw_c not in (None, "") and str(raw_c).strip() != (c or ""):
        legacy.append(f"cardinality {raw_c!r} → {c}")
    if raw_c in (None, "") and raw_r not in (None, "") and str(raw_r).strip() != (r or ""):
        legacy.append(f"relationship {raw_r!r} → {r}")

    # is_active
    activation_known = True
    raw_a = join.get("is_active")
    if raw_a is None:
        is_active = True
        legacy.append("is_active vắng → active")
    elif isinstance(raw_a, bool):
        is_active = raw_a
    elif isinstance(raw_a, str) and raw_a.strip().lower() in _TRUE_STRINGS | _FALSE_STRINGS:
        is_active = raw_a.strip().lower() in _TRUE_STRINGS
        legacy.append(f"is_active {raw_a!r} → {is_active}")
    elif isinstance(raw_a, int) and raw_a in (0, 1):
        is_active = bool(raw_a)
        legacy.append(f"is_active {raw_a!r} → {is_active}")
    else:
        is_active = False
        activation_known = False
        invalid.append(f"is_active {raw_a!r} không phải true/false")

    # cross_filter
    raw_cf = join.get("cross_filter")
    if raw_cf in (None, ""):
        cross_filter = "single"
        legacy.append("cross_filter vắng → single")
    elif isinstance(raw_cf, str) and raw_cf.strip().lower() in ("single", "both"):
        cross_filter = raw_cf.strip().lower()
    else:
        cross_filter = "single"
        invalid.append(f"cross_filter {raw_cf!r} không phải single/both")

    # key pairs — the full key, from the condition the runtime renders
    fcols = [str(x).strip() for x in (join.get("from_columns") or []) if str(x or "").strip()]
    tcols = [str(x).strip() for x in (join.get("to_columns") or []) if str(x or "").strip()]
    if fcols or tcols:
        if len(fcols) != len(tcols):
            invalid.append("số cột khoá hai phía không khớp")
        col_pairs = list(zip(fcols, tcols))
        f1 = str(join.get("from_column") or "").strip()
        t1 = str(join.get("to_column") or "").strip()
        if (f1 or t1) and col_pairs and (f1, t1) != col_pairs[0]:
            invalid.append("from_column/to_column lệch from_columns/to_columns")
    elif join.get("from_column") and join.get("to_column"):
        col_pairs = [(str(join["from_column"]).strip(), str(join["to_column"]).strip())]
    else:
        col_pairs = []
    sql_on = str(join.get("sql_on") or "").strip()
    key_source = "columns"
    key_pairs = col_pairs
    if sql_on:
        to_refs = {x for x in (alias, view) if x}
        # A self-join through an alias (employees → manager AS employees):
        # `${employees}` names the JOINED side, as the renderer has always
        # substituted it; the from side is `${TABLE}`.
        from_refs = {src, from_view} - to_refs
        try:
            parsed = _parse_key_equalities(sql_on, from_refs=from_refs, to_refs=to_refs)
        except ValueError as exc:
            parsed = None
            invalid.append(str(exc))
        if parsed == "expression":
            key_source = "expression"
            if not col_pairs:
                invalid.append("điều kiện join là biểu thức nhưng không khai báo cột khoá")
            else:
                used = _expression_column_refs(sql_on, from_refs=from_refs, to_refs=to_refs)
                if used is None:
                    invalid.append("biểu thức join tham chiếu bảng không thuộc quan hệ")
                elif used != ({f for f, _ in col_pairs}, {t for _, t in col_pairs}):
                    invalid.append("biểu thức join dùng cột khác cột khoá khai báo")
        elif parsed is not None:
            key_source = "sql_on"
            if fcols or tcols:
                if col_pairs and set(parsed) != set(col_pairs):
                    invalid.append("sql_on và from/to_columns chỉ hai khoá khác nhau")
            elif col_pairs:
                # Legacy shorthand: only the scalar from_column/to_column, which
                # name the FIRST pair of a (possibly composite) sql_on key.
                if col_pairs[0] not in parsed:
                    invalid.append("from_column/to_column không thuộc khoá trong sql_on")
                elif len(parsed) > 1:
                    legacy.append("khoá ghép đọc từ sql_on (from_column chỉ là cặp đầu)")
            key_pairs = parsed
    if not key_pairs and not any("khoá" in x for x in invalid):
        invalid.append("không có điều kiện join (sql_on hoặc cột khoá)")

    return JoinContract(
        view=view, alias=alias, node=alias or view, from_view=src, cardinality=cardinality,
        is_active=is_active, cross_filter=cross_filter, key_pairs=tuple(key_pairs),
        key_source=key_source, sql_on=sql_on, invalid=tuple(invalid), legacy=tuple(legacy),
        activation_known=activation_known,
    )


def _reverse_sql_on(contract: JoinContract) -> str:
    """The condition of the same relationship walked from its to side.

    Placeholders are swapped (the to side becomes ${TABLE}), so every key
    column and any expression (a calendar CAST, the local-date macro) is kept —
    a reverse edge rebuilt from from_column/to_column alone joined a composite
    key on its first column and dropped the CAST."""
    if contract.sql_on and contract.key_source == "expression":
        out = contract.sql_on.replace("${TABLE}", "\x00FROM\x00")
        for ref in {contract.node, contract.view}:
            out = out.replace("${" + ref + "}", "${TABLE}")
        return out.replace("\x00FROM\x00", "${" + contract.from_view + "}")
    return " AND ".join(
        f"${{TABLE}}.{t} = ${{{contract.from_view}}}.{f}" for f, t in contract.key_pairs
    )



def join_is_usable(from_view: str, join) -> bool:
    """Valid AND active under the relationship contract — the one test every
    reader uses to decide whether a persisted join exists at runtime."""
    c = read_join_contract(from_view, join)
    return c.valid and c.is_active


def raise_for_invalid_relationships(resolver) -> None:
    """Refuse to build a query on a model that carries an invalid relationship.

    An invalid row is left out of the graph; answering without it would change
    which rows a filter keeps or which route a dimension takes — a different
    number with no sign of why. The message names every row and what is wrong."""
    bad = list(getattr(resolver, "invalid_joins", None) or [])
    if not bad:
        return
    items = "; ".join(f"{b['from_view']} → {b['join']}: {', '.join(b['reasons'])}" for b in bad[:6])
    more = f" (và {len(bad) - 6} quan hệ khác)" if len(bad) > 6 else ""
    raise SemanticRefusal(
        f"Model có quan hệ không hợp lệ nên truy vấn bị từ chối: {items}{more}. "
        "Sửa hoặc xoá các quan hệ này trong Data Model.",
        SemanticRefusal.INVALID_RELATIONSHIP,
    )

def _route_signature(path: "JoinPath") -> tuple:
    return tuple(_edge_signature(s.edge) for s in path.steps)


def _route_label(path: "JoinPath") -> str:
    if not path.steps:
        return "(base)"
    nodes = [path.steps[0].edge.from_node] + [s.edge.to_node for s in path.steps]
    return " → ".join(nodes)


@dataclass(frozen=True)
class JoinStep:
    """One step in a resolved join path."""
    edge: JoinEdge
    alias_sql: str       # the SQL alias used in the FROM clause for this step
                         # (e.g. _appbi_sem_join_2)


@dataclass
class JoinPath:
    """A resolved multi-hop join path from base node to a target node."""
    target_node: str
    steps: list[JoinStep] = field(default_factory=list)
    # Phase-3b: BFS hit the target via more than one same-depth route. The
    # first path is still returned (deterministic) but downstream consumers
    # can surface this so the user knows the answer might depend on which
    # path the engine picked.
    ambiguous: bool = False

    def is_empty(self) -> bool:
        return not self.steps


class SemanticJoinResolver:
    """Resolve multi-hop join paths within a SemanticModel.

    Build once per (model, base_view) — graph construction collects every
    explore in the model so multi-hop traversal can chain joins owned by
    different from-views.
    """

    def __init__(
        self,
        db: Session,
        model: SemanticModel | None,
        base_node: str,
        bidirectional: bool = False,
    ) -> None:
        """Build a join-graph resolver rooted at ``base_node``.

        Args:
            bidirectional: legacy compat flag. When True, every edge gets a
                synthetic reverse regardless of its ``cross_filter`` setting —
                this matches pre-Phase-1 behaviour and is still the default for
                ``reachable_fields_for_model`` (FE binding hydration).
                **DEPRECATED:** Phase 2 propagation engine (default OFF) builds
                its own ``bidirectional=False`` resolver. Plan per
                ``docs/phases/phase-4-symmetric-aggregates.md`` §4.10: after a
                month of flag-ON soak in production, flip the default to False
                and audit remaining callers. Do NOT change the default in this
                PR — would break binding hydration for legacy charts.
        """
        self._db = db
        self._model = model
        self._base_node = base_node
        self._bidirectional = bidirectional
        # adjacency: from_node -> list[JoinEdge]
        self._adj: dict[str, list[JoinEdge]] = {}
        # Persisted relationships whose contract is invalid (read_join_contract):
        # left out of the graph AND surfaced, so no consumer can mistake their
        # absence for "no relationship".
        self.invalid_joins: list[dict] = []
        # node_id -> view_name (so we can find dimensions/measures)
        self._node_to_view: dict[str, str] = {base_node: base_node}
        if model is not None:
            # Perf (#6): the graph (_adj + _node_to_view) is base-node-independent
            # — it's the whole model's join topology. Only the base_node SEED of
            # _node_to_view differs per resolver, so cache the built graph and
            # re-seed locally. Cache key folds in model.updated_at so an edited
            # model rebuilds.
            cache_key = _graph_cache_key(model, bidirectional)
            cached = None
            if cache_key is not None:
                with _GRAPH_CACHE_LOCK:
                    cached = _GRAPH_CACHE.get(cache_key)
            if cached is not None:
                cached_adj, cached_n2v, cached_invalid = cached
                # Copy the outer structures so per-resolver mutation (none today,
                # but defensive) can't corrupt the shared cache entry. JoinEdge
                # is frozen and node_to_view values are strings, so a shallow
                # copy is sufficient and cheap.
                self._adj = {k: list(v) for k, v in cached_adj.items()}
                self.invalid_joins = [dict(x) for x in cached_invalid]
                self._node_to_view = dict(cached_n2v)
                # Ensure THIS resolver's base node is seeded (it always is in a
                # full-model graph, but a base view with zero joins may be absent).
                self._node_to_view.setdefault(base_node, base_node)
                # [perf] graph reused (Fix #6) — skipped rebuilding the join
                # topology from the model's explores. DEBUG: a resolver is built
                # per chart, so HIT is the common case and would spam INFO.
                logger.debug(
                    "[perf] join-graph cache=HIT model_id=%s base=%s nodes=%d",
                    getattr(model, "id", None), base_node, len(self._node_to_view),
                )
            else:
                self._build_graph(model)
                if cache_key is not None:
                    with _GRAPH_CACHE_LOCK:
                        if len(_GRAPH_CACHE) >= _GRAPH_CACHE_MAX:
                            _GRAPH_CACHE.clear()
                        _GRAPH_CACHE[cache_key] = (
                            {k: list(v) for k, v in self._adj.items()},
                            dict(self._node_to_view),
                            [dict(x) for x in self.invalid_joins],
                        )
                # [perf] graph (re)built from the model's explores. INFO because
                # a burst of MISS on one dashboard load means the cache isn't
                # sticking — e.g. a model edited between tiles (key includes the
                # join signature), or uncacheable (cache_key is None). After a
                # join edit, exactly ONE MISS then HITs is the expected pattern.
                logger.info(
                    "[perf] join-graph cache=%s model_id=%s base=%s nodes=%d edges=%d",
                    "MISS(built)" if cache_key is not None else "BUILT(uncacheable)",
                    getattr(model, "id", None), base_node,
                    len(self._node_to_view), sum(len(v) for v in self._adj.values()),
                )

    # ── graph construction ─────────────────────────────────────────────

    def _build_graph(self, model: SemanticModel) -> None:
        explores = list(model.explores or [])
        for explore in explores:
            from_view = str(getattr(explore, "base_view_name", "") or "").strip()
            if not from_view:
                continue
            self._node_to_view.setdefault(from_view, from_view)
            for join in explore.joins or []:
                contract = read_join_contract(from_view, join)
                if contract.dormant:
                    # Invalid but definitively switched off: not part of the
                    # graph, cannot reach a query; health flags it.
                    continue
                if not contract.valid:
                    # Never used — and never silently: the engine refuses a
                    # model that carries an invalid, possibly active
                    # relationship (see `invalid_joins`); health reports it.
                    self.invalid_joins.append({
                        "from_view": contract.from_view,
                        "join": str((join or {}).get("name") or contract.node or "?")
                        if isinstance(join, dict) else "?",
                        "reasons": list(contract.invalid),
                    })
                    continue
                edge = self._edge_from_contract(contract)
                # Phase-3b: inactive joins stay in storage but are invisible to
                # the resolver so path resolution / filter checks behave as if
                # the relationship doesn't exist. Active=True is the default
                # so legacy joins are unaffected.
                if not edge.is_active:
                    continue
                self._adj.setdefault(edge.from_node, []).append(edge)
                self._node_to_view.setdefault(edge.to_node, edge.to_view)
                # Add a reverse edge when either:
                #   (a) the resolver was constructed in legacy bidirectional
                #       mode (used by a few callers that want full bidir model)
                #   (b) this specific edge requested cross_filter="both"
                # Only simple column-equality joins can be safely reversed
                # because we can't flip an arbitrary `sql_on` template.
                wants_reverse = (
                    self._bidirectional or edge.cross_filter == "both"
                )
                if wants_reverse and contract.key_pairs:
                    inv = invert_cardinality(edge.cardinality)
                    reverse = JoinEdge(
                        from_node=edge.to_node,
                        to_node=edge.from_node,
                        to_view=self._node_to_view.get(edge.from_node, edge.from_node),
                        type="left",
                        sql_on=_reverse_sql_on(contract),
                        from_column=contract.key_pairs[0][1],
                        to_column=contract.key_pairs[0][0],
                        key_pairs=tuple((t, f) for f, t in contract.key_pairs),
                        relationship=inv,
                        is_active=True,
                        cross_filter="both",
                        cardinality=inv,
                        is_reverse=True,
                        rel_cross_filter=edge.cross_filter,
                        plain_keys=edge.plain_keys,
                    )
                    self._adj.setdefault(reverse.from_node, []).append(reverse)
                    self._node_to_view.setdefault(reverse.to_node, reverse.to_view)

    @staticmethod
    def _edge_from_contract(contract: "JoinContract") -> JoinEdge:
        """The runtime edge of a VALID relationship contract. The SQL join type
        is derived (always FACT LEFT JOIN DIM); stored `type` is ignored."""
        first = contract.key_pairs[0] if contract.key_pairs else (None, None)
        # A row stored as column lists only (no sql_on) gets the condition of its
        # FULL key: every renderer (engine, live adapter, distinct cascade) used
        # to fall back to from_column/to_column — the first pair — and joined a
        # composite key on one column, silently.
        sql_on = contract.sql_on or " AND ".join(
            f"${{TABLE}}.{f} = ${{{contract.node}}}.{t}" for f, t in contract.key_pairs
        )
        edge = JoinEdge(
            from_node=contract.from_view,
            to_node=contract.node,
            to_view=contract.view,
            type="left",
            sql_on=sql_on,
            from_column=first[0],
            to_column=first[1],
            relationship=contract.cardinality,
            is_active=contract.is_active,
            cross_filter=contract.cross_filter,
            cardinality=contract.cardinality,
            is_reverse=False,
            key_pairs=tuple(contract.key_pairs),
        )
        return __import__("dataclasses").replace(edge, plain_keys=isinstance(_edge_signature(edge)[1], frozenset))

    @staticmethod
    def _edge_from_join_dict(from_view: str, join: dict) -> JoinEdge | None:
        """Edge for one persisted join, or None when its contract is invalid."""
        contract = read_join_contract(from_view, join)
        if not contract.valid:
            return None
        return SemanticJoinResolver._edge_from_contract(contract)

    # ── public API ─────────────────────────────────────────────────────

    @property
    def base_node(self) -> str:
        return self._base_node

    def view_for_node(self, node_id: str) -> str | None:
        return self._node_to_view.get(node_id)

    def reachable_nodes(self) -> set[str]:
        """All node ids reachable from base_node, including base_node itself."""
        visited: set[str] = {self._base_node}
        queue: deque[str] = deque([self._base_node])
        while queue:
            current = queue.popleft()
            for edge in self._adj.get(current, []):
                if edge.to_node in visited:
                    continue
                visited.add(edge.to_node)
                queue.append(edge.to_node)
        return visited

    def resolve_path(self, target_node: str) -> JoinPath | None:
        """BFS shortest path from base_node to target_node (single, back-compat).

        Discovery order = insertion order of the adjacency list (deque-driven
        BFS). This is the SAME algorithm used pre-Phase-1 so all callers that
        depended on a specific tie-breaking continue to get the same path.
        Use :meth:`resolve_paths` to enumerate all equal-length paths for
        explicit disambiguation in the Phase-2 propagation engine.
        """
        if target_node == self._base_node:
            return JoinPath(target_node=target_node, steps=[])

        # BFS tracking parent edge per discovered node
        parent: dict[str, JoinEdge] = {}
        visited: set[str] = {self._base_node}
        queue: deque[str] = deque([self._base_node])
        ambiguous_tie = False

        while queue:
            current = queue.popleft()
            for edge in self._adj.get(current, []):
                if edge.to_node in visited:
                    # tie at same depth → ambiguous (we keep the first path)
                    if edge.to_node == target_node:
                        ambiguous_tie = True
                    continue
                visited.add(edge.to_node)
                parent[edge.to_node] = edge
                if edge.to_node == target_node:
                    if ambiguous_tie:
                        logger.warning(
                            "Ambiguous join paths to %r in model; using first discovered path.",
                            target_node,
                        )
                    path = self._reconstruct_path(target_node, parent)
                    path.ambiguous = ambiguous_tie
                    return path
                queue.append(edge.to_node)

        return None

    def distinct_routes(self, target_node: str) -> list[JoinPath]:
        """Equal-length shortest paths to ``target_node`` that walk DIFFERENT
        relationships (one representative per route; forward/reverse edges of
        the same relationship collapse into one). The first entry is the path
        :meth:`resolve_path` returns."""
        # Enumerated with duplicates collapsed DURING the walk: parallel edges of
        # one relationship (a forward edge and its synthetic reverse, or the same
        # relationship declared from both sides) would otherwise fill
        # resolve_paths' 16-path cap and hide a second, genuinely different
        # route — a silent single pick.
        if target_node == self._base_node:
            return [JoinPath(target_node=target_node, steps=[])]
        primary = self.resolve_path(target_node)
        if primary is None:
            return []
        max_depth = len(primary.steps)
        depth: dict[str, int] = {self._base_node: 0}
        incoming: dict[str, list[JoinEdge]] = {}
        queue: deque[tuple[str, int]] = deque([(self._base_node, 0)])
        while queue:
            current, d = queue.popleft()
            if d >= max_depth:
                continue
            for edge in self._adj.get(current, []):
                to = edge.to_node
                if to in depth and depth[to] < d + 1:
                    continue
                if to not in depth:
                    depth[to] = d + 1
                    queue.append((to, d + 1))
                if depth[to] == d + 1:
                    bucket = incoming.setdefault(to, [])
                    key = (edge.from_node, _edge_signature(edge))
                    if all((e.from_node, _edge_signature(e)) != key for e in bucket):
                        bucket.append(edge)

        routes: list[list[JoinEdge]] = []
        seen: set = set()
        cap = 32

        def _walk(node: str, acc: list[JoinEdge]) -> None:
            if len(routes) >= cap:
                # never a silently truncated set: past the cap, refused
                raise RouteEnumerationIncomplete(target_node)
            if node == self._base_node:
                seq = list(reversed(acc))
                sig = tuple(_edge_signature(e) for e in seq)
                if sig not in seen:
                    seen.add(sig)
                    routes.append(seq)
                return
            for edge in incoming.get(node, []):
                acc.append(edge)
                _walk(edge.from_node, acc)
                acc.pop()

        _walk(target_node, [])
        if not routes:
            return [primary]
        # Keep resolve_path's route first (callers and messages expect it).
        primary_sig = _route_signature(primary)
        routes.sort(key=lambda seq: tuple(_edge_signature(e) for e in seq) != primary_sig)
        return [
            JoinPath(
                target_node=target_node,
                steps=[JoinStep(edge=e, alias_sql=f"_appbi_sem_join_{i}") for i, e in enumerate(seq)],
                ambiguous=len(routes) > 1,
            )
            for seq in routes
        ]

    # ── complete route enumeration ────────────────────────────────────────
    # Every route set that can decide a number comes from `_route_search`:
    # ALL simple routes the hop rule allows, of any length up to
    # ROUTE_MAX_DEPTH — or `None` when that set cannot be seen completely
    # (more than ROUTE_CAP routes, or a route the rule allows that is longer
    # than the bound). Callers refuse on `None` (RouteEnumerationIncomplete);
    # nothing ever treats a truncated set, or the shortest route, as complete.

    def _out_edges(self, node: str) -> list:
        """``node``'s outgoing edges, one per relationship and neighbour (a
        declared edge before a synthetic reverse of the same relationship),
        in a stable order."""
        cache = self.__dict__.setdefault("_out_edges_cache", {})
        if node not in cache:
            best: dict = {}
            for e in self._adj.get(node, []):
                key = (e.to_node, _edge_signature(e))
                cur = best.get(key)
                if cur is None or (cur.is_reverse and not e.is_reverse):
                    best[key] = e
            cache[node] = [best[k] for k in sorted(best, key=lambda k: (k[0], repr(_stable(k[1]))))]
        return cache[node]

    def _in_edges(self) -> dict:
        """to_node -> the de-duplicated edges entering it."""
        cache = self.__dict__.get("_in_edges_cache")
        if cache is None:
            cache = {}
            for u in sorted(set(self._adj)):
                for e in self._out_edges(u):
                    cache.setdefault(e.to_node, []).append(e)
            self.__dict__["_in_edges_cache"] = cache
        return cache

    def _route_search(self, starts, target_node: str, step, *, phases=(0,), start_phase=0,
                      blocked=frozenset(), max_depth: int | None = None, cap: int | None = None,
                      exact_length: bool = False):
        """Every simple route from a node of ``starts`` to ``target_node`` whose
        hops ``step(edge, phase) -> next phase | None`` allows, through no
        ``blocked`` interior node. ``None`` when not every such route could be
        enumerated within the bounds. ``exact_length``: only routes of length
        ``max_depth`` are asked for (the caller knows none is shorter), so
        reaching that length is not a cut."""
        max_depth = ROUTE_MAX_DEPTH if max_depth is None else max_depth
        cap = ROUTE_CAP if cap is None else cap
        # States (node, phase) from which the target is reachable at all (a
        # backward walk from it): the search only enters those, so a route cut
        # by the depth bound is one the rule allows to continue — the
        # enumeration is then incomplete.
        good = {(target_node, p) for p in phases}
        queue = deque(good)
        incoming = self._in_edges()
        while queue:
            v, q = queue.popleft()
            if v != target_node and v in blocked:
                continue
            for e in incoming.get(v, ()):
                for p in phases:
                    if (e.from_node, p) not in good and step(e, p) == q:
                        good.add((e.from_node, p))
                        queue.append((e.from_node, p))
        found: list[list[JoinEdge]] = []
        seen: set = set()
        state = {"complete": True}

        def _dfs(node: str, phase, acc: list, visited: set) -> None:
            if not state["complete"]:
                return
            if node == target_node and acc:
                sig = (acc[0].from_node,) + tuple(_edge_signature(e) for e in acc)
                if sig not in seen:
                    seen.add(sig)
                    found.append(list(acc))
                    if len(found) > cap:
                        state["complete"] = False
                return
            if len(acc) >= max_depth:
                if not exact_length:
                    state["complete"] = False
                return
            for edge in self._out_edges(node):
                nxt = edge.to_node
                if nxt in visited or (nxt != target_node and nxt in blocked):
                    continue
                q = step(edge, phase)
                if q is None or (nxt, q) not in good:
                    continue
                acc.append(edge)
                visited.add(nxt)
                _dfs(nxt, q, acc, visited)
                visited.discard(nxt)
                acc.pop()

        for s in sorted(set(starts)):
            if s == target_node or (s, start_phase) not in good:
                continue
            _dfs(s, start_phase, [], {s})
        if not state["complete"]:
            return None
        paths = [
            JoinPath(target_node=target_node,
                     steps=[JoinStep(edge=e, alias_sql=f"_appbi_sem_join_{i}") for i, e in enumerate(seq)],
                     ambiguous=len(found) > 1)
            for seq in found
        ]
        return sorted(paths, key=lambda pth: (len(pth.steps), _route_label(pth)))

    def forward_routes(self, target_node: str, *, max_depth: int | None = None,
                       cap: int | None = None) -> list[JoinPath] | None:
        """EVERY route from the base to ``target_node`` that walks only toward
        one sides (many-to-one / one-to-one hops: each maps a base row to at
        most one target row) — distinct relationship chains of ANY length, not
        just the shortest, sorted (order-free). Two of them are two meanings of
        the target ("the sale's region" vs "the customer's region"); whether the
        query's context selects one is the caller's rule. ``None`` when they
        cannot all be enumerated within the bounds (the caller refuses rather
        than truncating)."""
        if target_node == self._base_node:
            return [JoinPath(target_node=target_node, steps=[])]
        return self._route_search([self._base_node], target_node,
                                  lambda e, _p: 0 if hop_is_to_one(e) else None,
                                  max_depth=max_depth, cap=cap)

    def descend_ascend_routes(self, target_node: str) -> list[JoinPath] | None:
        """EVERY route from the base that first walks toward many sides (the
        base's facts, in reverse of their relationships) and then only toward
        one sides — a fact under a dimension base, and that fact's dimensions.
        These are the meanings of a SELECT-side view that is not a dimension of
        the base: "the region's sales" through ``sales → regions`` and through
        ``sales → customers → regions`` are two (the fact-base question "sales
        by region" has the same two). Any length; ``None`` when they cannot all
        be enumerated within the bounds."""
        if target_node == self._base_node:
            return [JoinPath(target_node=target_node, steps=[])]

        def _step(e, phase):
            if hop_is_to_one(e):
                return 1
            return 0 if phase == 0 else None

        return self._route_search([self._base_node], target_node, _step, phases=(0, 1))

    def shortest_propagation_routes(self, target_node: str, anchors) -> list[JoinPath] | None:
        """The routes a FILTER on ``target_node`` travels to restrict this
        resolver's root (the query's fact grain) — every one of the most DIRECT
        valid routes. A route correlates at a view of ``anchors`` (the views the
        query already has; the root among them), passes through no other one,
        and every hop of it propagates (:func:`edge_propagates`: toward a many
        side only through a relationship that filters both ways). Its length is
        the root's own distance to its anchor plus the route's; the shortest
        such routes are the filter's — all of them (AND-ed by the caller): a
        longer one relates the two tables through further relationships,
        typically another role of a dimension. A shorter route a filter may NOT
        travel never hides a valid one. ``None`` when more than ``ROUTE_CAP``
        of them exist (refused, never a partial set)."""
        anchors = set(anchors) | {self._base_node}
        blocked = frozenset(anchors)
        offsets: dict = {}
        for a in sorted(anchors):
            if a == self._base_node:
                offsets[a] = 0
                continue
            path = self.resolve_path(a)
            if path is not None:
                offsets[a] = len(path.steps)
        # breadth-first distance from each anchor over propagating hops
        best_total = None
        lengths: dict = {}
        for a, off in offsets.items():
            seen = {a}
            frontier = [a]
            d = 0
            found = None
            while frontier and found is None:
                d += 1
                nxt = []
                for node in frontier:
                    for e in self._out_edges(node):
                        if not edge_propagates(e) or e.to_node in seen:
                            continue
                        if e.to_node == target_node:
                            found = d
                            break
                        if e.to_node in blocked:
                            continue
                        seen.add(e.to_node)
                        nxt.append(e.to_node)
                    if found is not None:
                        break
                frontier = nxt
            if found is not None:
                lengths[a] = found
                total = off + found
                best_total = total if best_total is None else min(best_total, total)
        if best_total is None:
            return []
        out: list = []
        for a in sorted(lengths):
            if offsets[a] + lengths[a] != best_total:
                continue
            found = self._route_search([a], target_node, lambda e, _p: 0 if edge_propagates(e) else None,
                                       blocked=blocked, max_depth=lengths[a], exact_length=True)
            if found is None:
                return None
            out += [r for r in found if r.steps]
        if len(out) > ROUTE_CAP:
            return None
        return sorted(out, key=lambda pth: (len(pth.steps), _route_label(pth)))

    def any_routes(self, target_node: str) -> list[JoinPath] | None:
        """EVERY simple route from the base to ``target_node``, any hops, any
        length within the bounds (``None`` past them)."""
        if target_node == self._base_node:
            return [JoinPath(target_node=target_node, steps=[])]
        return self._route_search([self._base_node], target_node, lambda _e, _p: 0)

    def resolve_unique_path(self, target_node: str) -> JoinPath | None:
        """The single shortest path to ``target_node``, or ``None`` when it is
        unreachable. Raises :class:`AmbiguousJoinPathError` when two or more
        shortest routes with different relationships exist — every consumer that
        EMITS SQL must use this (or apply its own disambiguation first), so the
        answer never depends on relationship-creation order."""
        routes = self.distinct_routes(target_node)
        if not routes:
            return None
        if len(routes) > 1:
            raise AmbiguousJoinPathError(target_node, [_route_label(r) for r in routes])
        return routes[0]

    def resolve_paths(self, target_node: str) -> list[JoinPath]:
        """All equal-length shortest paths from base_node to target_node.

        Phase-1 addition for the Phase-2 propagation engine. Detects ambiguous
        routing through multiple conformed dims (e.g., ``activity → owner →
        deal`` vs ``activity → date → deal``). Returns empty list when
        unreachable. A length-0 path (target == base) returns a single empty
        path. Each returned path has ``ambiguous = len(paths) > 1``.

        Implementation note: the FIRST path in the returned list matches what
        :meth:`resolve_path` returns (deterministic, deque-BFS discovery order).
        Subsequent paths are alternates at the same depth, useful for
        propagation engine ambiguity detection and role-hint resolution.
        """
        # Fast path: ask resolve_path for the canonical first; then enumerate
        # all OTHER equal-length paths via a depth-tracked BFS reusing the
        # same adjacency-list ordering for determinism.
        if target_node == self._base_node:
            return [JoinPath(target_node=target_node, steps=[])]

        primary = self.resolve_path(target_node)
        if primary is None:
            return []
        primary_depth = len(primary.steps)

        # Depth-tracked BFS — same adj order as resolve_path. Collect every edge
        # that arrives at a node at its (first-discovered) depth, so the back-
        # walk only enumerates equal-shortest paths.
        depth: dict[str, int] = {self._base_node: 0}
        incoming: dict[str, list[JoinEdge]] = {}
        queue: deque[tuple[str, int]] = deque([(self._base_node, 0)])
        while queue:
            current, d = queue.popleft()
            if d >= primary_depth:
                continue
            for edge in self._adj.get(current, []):
                to = edge.to_node
                to_depth = d + 1
                if to in depth and depth[to] < to_depth:
                    continue
                if to not in depth:
                    depth[to] = to_depth
                    queue.append((to, to_depth))
                if depth[to] == to_depth:
                    incoming.setdefault(to, []).append(edge)

        # Walk back from target through incoming-edge DAG. Defensive cap @ 16
        # paths to avoid combinatorial blow-up on pathological models.
        all_edge_seqs: list[list[JoinEdge]] = []

        def _walk(node: str, acc: list[JoinEdge]) -> None:
            if len(all_edge_seqs) >= 16:
                return
            if node == self._base_node:
                all_edge_seqs.append(list(reversed(acc)))
                return
            for edge in incoming.get(node, []):
                acc.append(edge)
                _walk(edge.from_node, acc)
                acc.pop()

        _walk(target_node, [])

        if not all_edge_seqs:
            # Defensive fallback: the depth-BFS missed something; return primary.
            return [primary]

        ambiguous = len(all_edge_seqs) > 1
        return [
            JoinPath(
                target_node=target_node,
                steps=[JoinStep(edge=e, alias_sql=f"_appbi_sem_join_{idx}")
                       for idx, e in enumerate(seq)],
                ambiguous=ambiguous,
            )
            for seq in all_edge_seqs
        ]

    def _reconstruct_path(
        self,
        target_node: str,
        parent: dict[str, JoinEdge],
    ) -> JoinPath:
        edges_reversed: list[JoinEdge] = []
        node = target_node
        while node != self._base_node:
            edge = parent.get(node)
            if edge is None:
                break
            edges_reversed.append(edge)
            node = edge.from_node
        edges = list(reversed(edges_reversed))
        steps = [
            JoinStep(edge=edge, alias_sql=f"_appbi_sem_join_{idx}")
            for idx, edge in enumerate(edges)
        ]
        return JoinPath(target_node=target_node, steps=steps)


def reachable_fields_for_model(
    db: Session,
    model: SemanticModel | None,
    base_view: SemanticView | None,
) -> tuple[list[str], list[str], list[str]]:
    """Compute the reachable views and fields from `base_view` within `model`.

    Returns (reachable_node_ids, reachable_dimension_fields, reachable_measure_fields)
    where each field is qualified `node_id.field_name`.

    "Reachable" means traversable via explore joins (multi-hop) starting from
    base_view's node. Includes base_view fields.
    """
    if base_view is None:
        return [], [], []
    base_node = base_view.name
    resolver = SemanticJoinResolver(db, model, base_node, bidirectional=True)

    nodes = resolver.reachable_nodes()

    # Map node_id -> SemanticView (lookup once)
    view_by_name: dict[str, SemanticView] = {}
    target_view_names = {resolver.view_for_node(n) for n in nodes if resolver.view_for_node(n)}
    if target_view_names:
        query = db.query(SemanticView).filter(SemanticView.name.in_(list(target_view_names)))
        dataset_id = getattr(model, "dataset_id", None)
        if dataset_id is not None:
            from sqlalchemy import or_
            from app.models.dataset import DatasetTable

            dataset_table_ids = [
                row.id
                for row in db.query(DatasetTable.id)
                .filter(DatasetTable.dataset_id == dataset_id)
                .all()
            ]
            query = query.filter(
                or_(
                    SemanticView.dataset_table_id.in_(dataset_table_ids),
                    SemanticView.dataset_table_id.is_(None),
                )
            )
        rows = query.all()
        view_by_name = {v.name: v for v in rows}

    dimension_fields: list[str] = []
    measure_fields: list[str] = []
    for node_id in sorted(nodes):
        view_name = resolver.view_for_node(node_id)
        if not view_name:
            continue
        view_obj = view_by_name.get(view_name)
        if view_obj is None:
            continue
        for dim in view_obj.dimensions or []:
            name = str((dim or {}).get("name") or "").strip()
            if name:
                dimension_fields.append(f"{node_id}.{name}")
        for meas in view_obj.measures or []:
            name = str((meas or {}).get("name") or "").strip()
            if name:
                measure_fields.append(f"{node_id}.{name}")

    return sorted(nodes), sorted(set(dimension_fields)), sorted(set(measure_fields))


__all__ = [
    "JoinContract",
    "join_is_usable",
    "raise_for_invalid_relationships",
    "read_join_contract",
    "JoinEdge",
    "JoinStep",
    "JoinPath",
    "SemanticJoinResolver",
    "canonical_cardinality",
    "reachable_fields_for_model",
]
