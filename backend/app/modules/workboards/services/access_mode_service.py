"""Workboard access-mode audit.

This module classifies every DatasetTable referenced by a workboard's
screens into one of four access modes, so the App-users tab can show
precise warnings instead of a single generic "needs miniapp_user"
banner.

Convention (Phase-16):

- ``per_user``  — table carries the ``miniapp_user`` column. RLS auto
  filters ``miniapp_user = {{app_user.username}}``. This is the canonical
  shape for fact tables in a mini-app.

- ``joined_through`` — table has no ``miniapp_user`` column but the
  semantic model has at least one chain to a ``per_user`` table via
  saved relationships. Each row of the table is "owned" indirectly
  through that fact. We report this so the builder knows the table is
  reachable. *Engine support for auto-rewriting RLS into an EXISTS
  subquery is still pending — for now the builder must add an explicit
  rule or accept that this table is read-only.*

- ``shared`` — the builder ticked ``DatasetTable.miniapp_share = True``.
  Treat as public reference data; do not warn, do not filter.

- ``unknown`` — no ``miniapp_user``, no chain, not marked shared. This is
  the only state that should fire a red banner — it means the table will
  silently leak rows or silently return zero rows depending on whether a
  rule was hand-written.

The audit only reads the dataset model + dataset_tables; it does *not*
issue SQL against the data source.
"""
from __future__ import annotations

from collections import defaultdict, deque
from typing import Any, Dict, List, Literal, Optional, Set, Tuple

from sqlalchemy.orm import Session

from app.models.dataset import DatasetTable
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView


MINIAPP_USER_COLUMN = "miniapp_user"

AccessMode = Literal["per_user", "joined_through", "shared", "unknown"]


def _columns_for_table(table: DatasetTable) -> List[str]:
    cc = table.columns_cache
    if isinstance(cc, dict):
        cols = cc.get("columns", [])
    elif isinstance(cc, list):
        cols = cc
    else:
        cols = []
    return [
        str(col.get("name") or "")
        for col in cols
        if isinstance(col, dict) and col.get("name")
    ]


def table_has_miniapp_user(table: DatasetTable) -> bool:
    return MINIAPP_USER_COLUMN in _columns_for_table(table)


def _build_relationship_graph(
    explores: List[SemanticExplore],
    views_by_name: Dict[str, SemanticView],
    table_by_view_id: Dict[int, DatasetTable],
) -> Dict[int, List[Tuple[int, dict]]]:
    """Adjacency list keyed by DatasetTable.id.

    Each edge entry is ``(other_table_id, edge_meta)``. Edges are
    bidirectional because the relationship still tells us "rows of A
    pair with rows of B" regardless of which side defined the join. We
    only walk edges whose endpoints both map back to a dataset table —
    calendar role views are skipped.
    """
    graph: Dict[int, List[Tuple[int, dict]]] = defaultdict(list)
    seen_edges: Set[Tuple[int, int, str]] = set()

    for explore in explores:
        from_view = views_by_name.get(explore.base_view_name)
        if from_view is None:
            continue
        from_table = table_by_view_id.get(from_view.id)
        if from_table is None:
            continue
        for join in explore.joins or []:
            to_view_name = str(join.get("view") or "")
            if not to_view_name:
                continue
            to_view = views_by_name.get(to_view_name)
            if to_view is None:
                continue
            to_table = table_by_view_id.get(to_view.id)
            if to_table is None:
                continue
            from_columns = join.get("from_columns") or (
                [join["from_column"]] if join.get("from_column") else []
            )
            to_columns = join.get("to_columns") or (
                [join["to_column"]] if join.get("to_column") else []
            )
            if not from_columns or not to_columns:
                continue
            edge_id = (
                from_table.id,
                to_table.id,
                f"{','.join(from_columns)}={','.join(to_columns)}",
            )
            reverse_id = (
                to_table.id,
                from_table.id,
                f"{','.join(to_columns)}={','.join(from_columns)}",
            )
            if edge_id in seen_edges and reverse_id in seen_edges:
                continue
            edge_meta_forward = {
                "from_view": explore.base_view_name,
                "to_view": to_view_name,
                "from_columns": [str(c) for c in from_columns],
                "to_columns": [str(c) for c in to_columns],
                "relationship": join.get("relationship") or "many_to_one",
                "direction": "forward",
            }
            edge_meta_reverse = {
                **edge_meta_forward,
                "direction": "reverse",
            }
            if edge_id not in seen_edges:
                seen_edges.add(edge_id)
                graph[from_table.id].append((to_table.id, edge_meta_forward))
            if reverse_id not in seen_edges:
                seen_edges.add(reverse_id)
                graph[to_table.id].append((from_table.id, edge_meta_reverse))

    return graph


def _find_chain_to_per_user(
    graph: Dict[int, List[Tuple[int, dict]]],
    start_table_id: int,
    per_user_table_ids: Set[int],
    max_hops: int = 3,
) -> Optional[List[dict]]:
    """BFS from ``start_table_id`` looking for any per_user table.

    Returns the list of edge_meta forming the shortest chain (excluding
    the start node), or ``None`` when no chain ≤ ``max_hops`` reaches a
    per_user table.
    """
    if start_table_id in per_user_table_ids:
        return []
    queue: deque[Tuple[int, List[dict]]] = deque([(start_table_id, [])])
    visited: Set[int] = {start_table_id}
    while queue:
        current_id, path = queue.popleft()
        if len(path) >= max_hops:
            continue
        for next_id, edge_meta in graph.get(current_id, []):
            if next_id in visited:
                continue
            visited.add(next_id)
            new_path = [*path, edge_meta]
            if next_id in per_user_table_ids:
                return new_path
            queue.append((next_id, new_path))
    return None


def compute_table_access_mode(
    db: Session,
    *,
    dataset_id: int,
    table_id: int,
) -> dict:
    """Classify a single table. Useful for the FE to ask about one table.

    See :func:`audit_workboard_access` for the workboard-wide variant.
    """
    table = db.query(DatasetTable).filter(DatasetTable.id == table_id).first()
    if table is None or table.dataset_id != dataset_id:
        return {
            "table_id": table_id,
            "mode": "unknown",
            "reason": "Table not found in this dataset.",
        }
    return _classify_single_table(db, table)


def _classify_single_table(db: Session, table: DatasetTable) -> dict:
    if bool(getattr(table, "miniapp_share", False)):
        return {
            "table_id": table.id,
            "table_name": table.display_name or table.source_table_name,
            "mode": "shared",
            "reason": "Marked as shared/dim data on the dataset.",
        }
    if table_has_miniapp_user(table):
        return {
            "table_id": table.id,
            "table_name": table.display_name or table.source_table_name,
            "mode": "per_user",
            "reason": f"Has the {MINIAPP_USER_COLUMN} column.",
        }

    # OLTP branch: an OPERATIONAL dataset has no BI semantic model by design, so
    # don't advise "generate the dataset model" (that's the reporting path). Its
    # RLS is column-based (miniapp_user, handled above) + per-screen rules; a
    # table with neither is genuinely un-scoped → tell the operator the OLTP fix.
    from app.models.dataset import Dataset as _Dataset
    _ds = db.query(_Dataset).filter(_Dataset.id == table.dataset_id).first()
    if _ds is not None and str(getattr(_ds, "purpose", None) or "reporting").strip().lower() == "operational":
        return {
            "table_id": table.id,
            "table_name": table.display_name or table.source_table_name,
            "mode": "unknown",
            "reason": (
                f"Bảng chưa có cột {MINIAPP_USER_COLUMN} và chưa đánh dấu shared — "
                "thêm cột miniapp_user (lọc theo người dùng) hoặc bật 'shared' nếu là "
                "dữ liệu dùng chung."
            ),
        }

    # Look for a chain to a per_user table via the semantic model.
    model = (
        db.query(SemanticModel)
        .filter(SemanticModel.dataset_id == table.dataset_id)
        .first()
    )
    if model is None:
        return {
            "table_id": table.id,
            "table_name": table.display_name or table.source_table_name,
            "mode": "unknown",
            "reason": (
                "No semantic model — cannot infer how this table inherits access. "
                "Either add a miniapp_user column or generate the dataset model."
            ),
        }

    tables_in_dataset = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == table.dataset_id)
        .all()
    )
    per_user_ids = {
        t.id for t in tables_in_dataset if table_has_miniapp_user(t)
    }
    if not per_user_ids:
        return {
            "table_id": table.id,
            "table_name": table.display_name or table.source_table_name,
            "mode": "unknown",
            "reason": (
                "No table in this dataset carries miniapp_user — the workboard "
                "has nothing to filter against."
            ),
        }

    views = (
        db.query(SemanticView)
        .filter(SemanticView.dataset_table_id.in_([t.id for t in tables_in_dataset]))
        .all()
    )
    views_by_name = {v.name: v for v in views}
    table_by_view_id = {v.id: next((t for t in tables_in_dataset if t.id == v.dataset_table_id), None) for v in views}
    table_by_view_id = {k: v for k, v in table_by_view_id.items() if v is not None}
    explores = (
        db.query(SemanticExplore)
        .filter(SemanticExplore.model_id == model.id)
        .all()
    )
    graph = _build_relationship_graph(explores, views_by_name, table_by_view_id)
    chain = _find_chain_to_per_user(graph, table.id, per_user_ids)
    if chain is None:
        return {
            "table_id": table.id,
            "table_name": table.display_name or table.source_table_name,
            "mode": "unknown",
            "reason": (
                "No relationship in the model links this table to a per-user "
                "fact. Add a miniapp_user column, mark the table as shared, or "
                "wire a relationship in the Model tab."
            ),
        }
    return {
        "table_id": table.id,
        "table_name": table.display_name or table.source_table_name,
        "mode": "joined_through",
        "reason": (
            f"Reaches a per-user fact via {len(chain)} relationship "
            f"{'hop' if len(chain) == 1 else 'hops'}."
        ),
        "chain": chain,
    }


def audit_workboard_access(
    db: Session,
    *,
    workboard,
) -> Dict[str, Any]:
    """Walk every screen of a workboard and classify the underlying table.

    Returns a payload the FE consumes to show banners / dim warnings on
    the App-users tab and inside RlsEditor.
    """
    layout = workboard.layout_json or {}
    screens = layout.get("screens") if isinstance(layout, dict) else None
    screens = screens if isinstance(screens, list) else []

    used_table_ids: Set[int] = set()
    screens_by_table: Dict[int, List[dict]] = defaultdict(list)
    for screen in screens:
        if not isinstance(screen, dict):
            continue
        try:
            table_id = int(screen.get("table_id"))
        except (TypeError, ValueError):
            continue
        if table_id <= 0:
            continue
        used_table_ids.add(table_id)
        screens_by_table[table_id].append(
            {
                "screen_id": str(screen.get("id") or ""),
                "screen_title": str(screen.get("title") or screen.get("id") or "Screen"),
                "rls_rules": list(screen.get("rls") or []),
            }
        )

    if not used_table_ids:
        return {
            "workboard_id": workboard.id,
            "dataset_id": workboard.dataset_id,
            "tables": [],
            "summary": {
                "per_user": 0,
                "joined_through": 0,
                "shared": 0,
                "unknown": 0,
            },
        }

    tables = (
        db.query(DatasetTable)
        .filter(DatasetTable.id.in_(used_table_ids))
        .all()
    )

    entries: List[dict] = []
    summary = {"per_user": 0, "joined_through": 0, "shared": 0, "unknown": 0}
    for table in tables:
        classification = _classify_single_table(db, table)
        legacy_rules: List[dict] = []
        for screen_meta in screens_by_table.get(table.id, []):
            for rule in screen_meta["rls_rules"]:
                if not isinstance(rule, dict):
                    continue
                filter_col = str(rule.get("filter_column") or "").strip()
                if filter_col and filter_col != MINIAPP_USER_COLUMN:
                    legacy_rules.append(
                        {
                            "screen_id": screen_meta["screen_id"],
                            "screen_title": screen_meta["screen_title"],
                            "role": rule.get("role"),
                            "filter_column": filter_col,
                            "filter_value": rule.get("filter_value"),
                        }
                    )

        entry = {
            **classification,
            "screens": [
                {
                    "screen_id": s["screen_id"],
                    "screen_title": s["screen_title"],
                }
                for s in screens_by_table.get(table.id, [])
            ],
            "legacy_rules": legacy_rules,
        }
        entries.append(entry)
        summary[entry["mode"]] = summary.get(entry["mode"], 0) + 1

    return {
        "workboard_id": workboard.id,
        "dataset_id": workboard.dataset_id,
        "tables": entries,
        "summary": summary,
    }
