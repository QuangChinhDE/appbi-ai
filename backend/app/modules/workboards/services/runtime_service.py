"""
Workboard runtime service — read-side helpers used by the API layer.

* ``render_form``: returns the form specification with lookup options
  resolved (so the FE can render <select> widgets without round-tripping).
* ``list_rows``: paginated table view, reusing ``LiveQueryService.execute_preview_query``
  for caching + cost-guards on the source DB.
* ``get_row_by_pk``: fetch a single row by its composite primary key.
* ``render_doc``: resolves a doc-view's data blocks into materialised
  payloads (the export service then converts those into HTML / PDF / Excel).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.models import DataSource
from app.models.dataset import Dataset, DatasetTable
from app.models.user import User
from app.modules.workboards.models import Workboard
from app.modules.workboards.schemas import (
    DataTableBlock,
    DocView,
    FormField,
    FormView,
    LayoutJson,
)
from app.services.live_query_service import LiveQueryService

logger = get_logger(__name__)


_MAX_LOOKUP_ROWS = 500


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_layout(workboard: Workboard) -> LayoutJson:
    try:
        return LayoutJson.model_validate(workboard.layout_json or {})
    except Exception:
        logger.warning("Workboard %s has invalid layout; falling back to defaults", workboard.id)
        return LayoutJson()


def _load_table(db: Session, table_id: int) -> Optional[DatasetTable]:
    if not table_id:
        return None
    return db.query(DatasetTable).filter(DatasetTable.id == table_id).first()


def _load_datasource_for_table(db: Session, table: DatasetTable) -> Optional[DataSource]:
    if table is None:
        return None
    return db.query(DataSource).filter(DataSource.id == table.datasource_id).first()


_AGG_FNS = {"sum", "avg", "min", "max", "count"}


def _parse_total_spec(spec: str) -> tuple[str, str]:
    """Parse ``"column"`` or ``"column:agg"`` → (column, agg).

    Default agg is ``sum``. Unknown aggs fall back to ``sum``.
    """
    if not isinstance(spec, str):
        return "", "sum"
    text = spec.strip()
    if not text:
        return "", "sum"
    if ":" in text:
        col, agg = text.split(":", 1)
        agg = agg.strip().lower()
        if agg not in _AGG_FNS:
            agg = "sum"
        return col.strip(), agg
    return text, "sum"


def _coerce_number(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _compute_totals_row(
    totals: List[str],
    columns: List[str],
    rows: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Produce a footer aggregations payload for the doc-table block.

    Output shape (new):
        {
          "rows": [{"agg": "sum", "label": "Tổng", "values": {col: number}}, ...],
          "single": {col: number}     # only when each col has exactly one agg
        }

    The FE renders one ``<tr>`` per ``rows`` entry. When ``single`` is
    present (the common case where each column has at most one agg) the FE
    can fall back to a one-row footer for compactness.
    """
    if not totals:
        return None

    # Group specs by aggregation so multiple cols sharing the same agg
    # collapse to one footer row.
    by_agg: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []  # preserve appearance order of aggs
    for spec in totals:
        col, agg = _parse_total_spec(spec)
        if not col or col not in columns:
            continue
        values = [_coerce_number(r.get(col)) for r in rows]
        numeric = [v for v in values if v is not None]
        if agg == "count":
            value = sum(1 for r in rows if r.get(col) is not None)
        elif not numeric:
            value = sum(1 for r in rows if r.get(col) is not None)
        elif agg == "sum":
            value = sum(numeric)
        elif agg == "avg":
            value = sum(numeric) / len(numeric)
        elif agg == "min":
            value = min(numeric)
        elif agg == "max":
            value = max(numeric)
        else:
            continue
        bucket = by_agg.setdefault(agg, {})
        bucket[col] = value
        if agg not in order:
            order.append(agg)

    if not order:
        return None

    AGG_LABELS = {
        "sum": "Tổng",
        "avg": "TB",
        "count": "Đếm",
        "min": "Min",
        "max": "Max",
    }
    footer_rows = [
        {
            "agg": agg,
            "label": AGG_LABELS.get(agg, agg.upper()),
            "values": by_agg[agg],
        }
        for agg in order
    ]

    # Build the legacy "single" shape only when every column appears in at
    # most one agg row — that lets old FE/export code keep working.
    counts: Dict[str, int] = {}
    for fr in footer_rows:
        for c in fr["values"]:
            counts[c] = counts.get(c, 0) + 1
    single: Optional[Dict[str, Any]] = None
    if all(v == 1 for v in counts.values()):
        single = {}
        for fr in footer_rows:
            single.update(fr["values"])

    out: Dict[str, Any] = {"rows": footer_rows}
    if single is not None:
        out["single"] = single
    return out


def _compute_merges(
    rows: List[Dict[str, Any]],
    group_by: List[str],
    columns: List[str],
) -> List[Dict[str, Any]]:
    """Return rowspan recipes for each group_by column.

    The runtime sorts ``rows`` so identical values are consecutive. We then
    walk each ``group_by`` column and emit ``{column, row_start, row_span}``
    descriptors the FE / export layer can translate into ``rowspan`` (HTML),
    ``SPAN`` ranges (ReportLab), or ``merge_cells`` (openpyxl).

    Skipped (returns empty list) when there's nothing to merge so callers
    can use a simple ``"merges" in payload`` check.
    """
    if not rows or not group_by:
        return []
    valid = [c for c in group_by if c in columns]
    if not valid:
        return []
    out: List[Dict[str, Any]] = []
    for col in valid:
        run_start = 0
        run_value = rows[0].get(col)
        for i in range(1, len(rows)):
            current = rows[i].get(col)
            if current != run_value:
                if i - run_start > 1:
                    out.append({"column": col, "row_start": run_start, "row_span": i - run_start})
                run_start = i
                run_value = current
        # Trailing run.
        if len(rows) - run_start > 1:
            out.append({
                "column": col,
                "row_start": run_start,
                "row_span": len(rows) - run_start,
            })
    return out


def _normalize_column_groups(
    columns: List[str],
    column_groups: List[Any] | None,
) -> List[Dict[str, Any]]:
    """Keep only valid, contiguous column groups in display order.

    Grouped headers can only span contiguous columns in the rendered table.
    Invalid or overlapping definitions are skipped defensively so previews
    and exports still render instead of breaking on bad builder state.
    """
    if not columns or not column_groups:
        return []

    order = {col: idx for idx, col in enumerate(columns)}
    assigned: set[str] = set()
    normalized: List[Dict[str, Any]] = []

    for raw in column_groups or []:
        if hasattr(raw, "model_dump"):
            item = raw.model_dump()
        elif isinstance(raw, dict):
            item = raw
        else:
            continue
        label = str(item.get("label") or "").strip()
        raw_columns = item.get("columns") or []
        if not label or not isinstance(raw_columns, list):
            continue

        cols: List[str] = []
        seen_local: set[str] = set()
        for raw_col in raw_columns:
            col = str(raw_col or "").strip()
            if (
                col
                and col in order
                and col not in assigned
                and col not in seen_local
            ):
                cols.append(col)
                seen_local.add(col)
        if len(cols) < 2:
            continue

        cols = sorted(cols, key=order.get)
        indices = [order[col] for col in cols]
        expected = list(range(indices[0], indices[0] + len(indices)))
        if indices != expected:
            continue

        normalized.append({"label": label, "columns": cols})
        assigned.update(cols)

    return normalized


def _resolve_relationship_labels(
    db: Session,
    *,
    base_rows: List[Dict[str, Any]],
    base_label_column: Optional[str],
    base_join_column: str,
    hops: List[Any],
) -> Dict[Any, str]:
    """Walk a relationship chain and build {primary_value → final_label}.

    Each hop fetches its target table via the same LiveQueryService used by
    single-hop lookups, so the join logic is read-only and reuses every cache
    + cost guard already in place. The chain is bounded (defensive cap of 4
    hops) and silently degrades to an empty mapping on any failure — callers
    fall back to the single-hop label so the form never breaks.
    """
    if not base_rows or not hops:
        return {}

    MAX_HOPS = 4
    safe_hops = list(hops)[:MAX_HOPS]

    # Cursor maps {value_in_current_table → original_primary_value}.
    cursor: Dict[Any, Any] = {}
    primary_value_column = base_join_column
    for row in base_rows:
        primary_val = row.get(primary_value_column)
        if primary_val is None:
            continue
        cursor[primary_val] = primary_val

    last_label_col: Optional[str] = base_label_column

    for hop in safe_hops:
        if not cursor:
            return {}
        table = _load_table(db, hop.table_id)
        if table is None:
            return {}
        datasource = _load_datasource_for_table(db, table)
        if datasource is None:
            return {}
        try:
            result = LiveQueryService.execute_preview_query(
                datasource,
                table,
                limit=_MAX_LOOKUP_ROWS,
                offset=0,
                filters=[],
            )
        except Exception:
            logger.exception(
                "Nested lookup hop failed (table_id=%s)", hop.table_id
            )
            return {}
        rows_by_key: Dict[Any, Dict[str, Any]] = {
            row.get(hop.value_column): row
            for row in (result.get("rows") or [])
            if row.get(hop.value_column) is not None
        }
        next_cursor: Dict[Any, Any] = {}
        for current_key, primary_val in cursor.items():
            row = rows_by_key.get(current_key)
            if row is None:
                continue
            # The hop's label_column doubles as the FK column for the next
            # hop when more hops follow.
            forward_value = row.get(hop.label_column) if hop.label_column else None
            if forward_value is None:
                forward_value = current_key
            next_cursor[forward_value] = primary_val
        cursor = next_cursor
        last_label_col = hop.label_column

    if last_label_col is None:
        return {}
    return {primary_val: str(label_val) for label_val, primary_val in cursor.items()}


def _filter_dicts(filters: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    cleaned: List[Dict[str, Any]] = []
    for item in filters or []:
        if isinstance(item, dict):
            cleaned.append(item)
        elif hasattr(item, "model_dump"):
            cleaned.append(item.model_dump())
        elif hasattr(item, "dict"):
            cleaned.append(item.dict())
    return cleaned


def _equality_filter(column: str, value: Any) -> Dict[str, Any]:
    return {
        "field": column,
        "operator": "eq",
        "value": value,
    }


# ---------------------------------------------------------------------------
# Public service
# ---------------------------------------------------------------------------

class WorkboardRuntimeService:
    """Read-side helpers consumed by the workboards API."""

    @staticmethod
    def render_form(
        db: Session, workboard: Workboard
    ) -> Dict[str, Any]:
        layout = _load_layout(workboard)
        form: FormView = layout.form
        lookups: Dict[str, List[Dict[str, Any]]] = {}
        for field in form.fields:
            options = WorkboardRuntimeService._resolve_lookup_options(db, field)
            if options is not None:
                lookups[field.column] = options
        return {
            "title": form.title,
            "submit_label": form.submit_label,
            "fields": [field.model_dump() for field in form.fields],
            "lookups": lookups,
            "primary_key_columns": list(workboard.primary_key_columns or []),
            "audit": layout.audit.model_dump(),
            "rls": layout.rls.model_dump(),
        }

    @staticmethod
    def _resolve_lookup_options(
        db: Session, field: FormField
    ) -> Optional[List[Dict[str, Any]]]:
        cfg = field.lookup
        if cfg is None:
            return None
        if cfg.kind == "static":
            return [
                {
                    "label": (item.get("label") if isinstance(item, dict) else None) or "",
                    "value": item.get("value") if isinstance(item, dict) else item,
                }
                for item in (cfg.values or [])
            ]
        if cfg.kind == "dataset_table" and cfg.table_id:
            table = _load_table(db, cfg.table_id)
            if table is None:
                return []
            datasource = _load_datasource_for_table(db, table)
            if datasource is None:
                return []
            try:
                result = LiveQueryService.execute_preview_query(
                    datasource, table, limit=_MAX_LOOKUP_ROWS, offset=0, filters=[]
                )
            except Exception:
                logger.exception(
                    "Lookup for field '%s' failed (table_id=%s)",
                    field.column,
                    cfg.table_id,
                )
                return []
            value_col = cfg.value_column
            label_col = cfg.label_column or value_col
            if not value_col:
                return []
            base_rows = result.get("rows") or []
            if cfg.relationship_path:
                resolved_labels = _resolve_relationship_labels(
                    db,
                    base_rows=base_rows,
                    base_label_column=label_col,
                    base_join_column=cfg.relationship_path[0].value_column,
                    hops=cfg.relationship_path,
                )
                return [
                    {
                        "label": resolved_labels.get(row.get(value_col)) or str(row.get(label_col, "") or ""),
                        "value": row.get(value_col),
                    }
                    for row in base_rows
                ]
            return [
                {
                    "label": str(row.get(label_col, "") or ""),
                    "value": row.get(value_col),
                }
                for row in base_rows
            ]
        return []

    @staticmethod
    def list_rows(
        db: Session,
        workboard: Workboard,
        *,
        page: int = 1,
        page_size: int = 50,
        filters: Optional[List[Dict[str, Any]]] = None,
        identity: Optional["CallerIdentity"] = None,
    ) -> Dict[str, Any]:
        from app.modules.workboards.services.rls_service import build_rls_filter

        layout = _load_layout(workboard)
        table = _load_table(db, workboard.primary_table_id)
        if table is None:
            return {"columns": [], "rows": [], "page": page, "page_size": page_size, "total": 0}
        datasource = _load_datasource_for_table(db, table)
        if datasource is None:
            return {"columns": [], "rows": [], "page": page, "page_size": page_size, "total": 0}

        page = max(int(page or 1), 1)
        page_size = min(max(int(page_size or 50), 1), 500)
        offset = (page - 1) * page_size

        merged_filters = _filter_dicts(filters)
        if identity is not None:
            rls_filters, allowed = build_rls_filter(layout.rls, identity)
            if not allowed:
                return {
                    "columns": [],
                    "rows": [],
                    "page": page,
                    "page_size": page_size,
                    "list_view": layout.list.model_dump(),
                }
            merged_filters = merged_filters + rls_filters

        result = LiveQueryService.execute_preview_query(
            datasource, table, limit=page_size, offset=offset, filters=merged_filters
        )
        return {
            "columns": result.get("columns") or [],
            "rows": result.get("rows") or [],
            "page": page,
            "page_size": page_size,
            "execution_time_ms": result.get("execution_time_ms"),
            "list_view": layout.list.model_dump(),
        }

    @staticmethod
    def get_row_by_pk(
        db: Session,
        workboard: Workboard,
        pk: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        if not pk:
            return None
        pk_cols = list(workboard.primary_key_columns or [])
        missing = [c for c in pk_cols if c not in pk]
        if missing:
            return None
        table = _load_table(db, workboard.primary_table_id)
        if table is None:
            return None
        datasource = _load_datasource_for_table(db, table)
        if datasource is None:
            return None
        filters = [_equality_filter(c, pk[c]) for c in pk_cols]
        result = LiveQueryService.execute_preview_query(
            datasource, table, limit=1, offset=0, filters=filters
        )
        rows = result.get("rows") or []
        return rows[0] if rows else None

    # ------------------------------------------------------------------
    # Doc rendering
    # ------------------------------------------------------------------

    @staticmethod
    def render_doc(
        db: Session,
        workboard: Workboard,
        *,
        view_id: str,
        user: Optional[User] = None,
        view_filters: Optional[List[Dict[str, Any]]] = None,
        identity: Optional["CallerIdentity"] = None,
        app_user_payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        layout = _load_layout(workboard)
        view: Optional[DocView] = next(
            (v for v in layout.doc_views if v.id == view_id), None
        )
        if view is None:
            return {
                "id": view_id,
                "title": None,
                "page": None,
                "blocks": [],
                "missing": True,
            }
        substitution = _build_substitution_map(
            workboard, user, view_filters, app_user=app_user_payload
        )
        rendered_blocks: List[Dict[str, Any]] = []
        for block in view.blocks:
            payload = block.model_dump()
            if isinstance(block, DataTableBlock):
                payload["data"] = WorkboardRuntimeService._resolve_data_table_block(
                    db,
                    workboard,
                    block,
                    view_filters=view_filters,
                    identity=identity,
                )
            # Substitute placeholders in every block (including data_table's
            # title etc.) so {{user.email}} / {{app_user.username}} resolve
            # consistently across header, kv_grid, text, footer.
            _substitute_strings_in_place(payload, substitution)
            rendered_blocks.append(payload)
        return {
            "id": view.id,
            "title": view.title,
            "page": view.page.model_dump(),
            "blocks": rendered_blocks,
            "context": substitution,
        }

    @staticmethod
    def _resolve_data_table_block(
        db: Session,
        workboard: Workboard,
        block: DataTableBlock,
        *,
        view_filters: Optional[List[Dict[str, Any]]] = None,
        identity: Optional["CallerIdentity"] = None,
    ) -> Dict[str, Any]:
        from app.modules.workboards.services.rls_service import build_rls_filter

        layout = _load_layout(workboard)
        is_primary = not block.source.startswith("lookup:")
        table_id = workboard.primary_table_id
        if block.source.startswith("lookup:"):
            try:
                table_id = int(block.source.split(":", 1)[1])
            except (ValueError, IndexError):
                return {"columns": [], "rows": []}
        table = _load_table(db, table_id)
        if table is None:
            return {"columns": [], "rows": []}
        datasource = _load_datasource_for_table(db, table)
        if datasource is None:
            return {"columns": [], "rows": []}
        filters = _filter_dicts(view_filters) if block.filters_from_view else []
        # Apply RLS only on the primary table — the workboard's RLS rules
        # describe its own data, not arbitrary lookup tables.
        if identity is not None and is_primary:
            rls_filters, allowed = build_rls_filter(layout.rls, identity)
            if not allowed:
                return {"columns": [], "rows": []}
            filters = filters + rls_filters
        result = LiveQueryService.execute_preview_query(
            datasource, table, limit=block.max_rows, offset=0, filters=filters
        )
        all_columns: List[str] = result.get("columns") or []
        rows: List[Dict[str, Any]] = result.get("rows") or []
        selected = [c for c in (block.columns or []) if c in all_columns] or all_columns
        if selected != all_columns:
            rows = [{c: row.get(c) for c in selected} for row in rows]
        # Sort + group: when group_by is configured, sort the dataset so
        # rows sharing the same group keys are consecutive, then compute
        # rowspan ranges per group column for merged-cell rendering.
        if block.group_by:
            group_cols = [c for c in block.group_by if c in selected]
            if group_cols:
                rows = sorted(
                    rows,
                    key=lambda r: tuple(
                        ("" if r.get(c) is None else str(r.get(c))) for c in group_cols
                    ),
                )
        payload: Dict[str, Any] = {"columns": selected, "rows": rows}
        column_groups = _normalize_column_groups(selected, block.column_groups)
        if column_groups:
            payload["column_groups"] = column_groups
        merges = _compute_merges(rows, block.group_by, selected)
        if merges:
            payload["merges"] = merges
        footer_row = _compute_totals_row(block.totals, selected, rows)
        if footer_row:
            payload["footer_row"] = footer_row
        return payload


# ---------------------------------------------------------------------------
# Placeholder substitution
# ---------------------------------------------------------------------------

def _build_substitution_map(
    workboard: Workboard,
    user: Optional[User],
    view_filters: Optional[List[Dict[str, Any]]],
    *,
    app_user: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    user_payload: Dict[str, Any] = {}
    if user is not None:
        user_payload = {
            "id": str(user.id),
            "email": getattr(user, "email", None),
            "full_name": getattr(user, "full_name", None),
        }
    filters_payload: Dict[str, Any] = {}
    for f in view_filters or []:
        if isinstance(f, dict):
            col = f.get("column")
            if col:
                filters_payload[col] = f.get("value")
    return {
        "user": user_payload,
        "app_user": dict(app_user or {}),
        "view_filters": filters_payload,
        "now": now.isoformat(),
        "today": now.date().isoformat(),
        "workboard": {"id": workboard.id, "name": workboard.name},
    }


def _substitute_strings_in_place(obj: Any, mapping: Dict[str, Any]) -> None:
    """Recursively replace ``{{path.to.value}}`` placeholders inside string fields."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            if isinstance(value, str):
                obj[key] = _substitute_string(value, mapping)
            else:
                _substitute_strings_in_place(value, mapping)
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            if isinstance(item, str):
                obj[i] = _substitute_string(item, mapping)
            else:
                _substitute_strings_in_place(item, mapping)


def _substitute_string(text: str, mapping: Dict[str, Any]) -> str:
    if "{{" not in text:
        return text
    import re as _re

    def _replace(match: "_re.Match[str]") -> str:
        path = match.group(1).strip()
        cursor: Any = mapping
        for part in path.split("."):
            if isinstance(cursor, dict) and part in cursor:
                cursor = cursor[part]
            else:
                return match.group(0)
        return "" if cursor is None else str(cursor)

    return _re.sub(r"\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}", _replace, text)


# ---------------------------------------------------------------------------
# v2 — multi-view runtime
# ---------------------------------------------------------------------------

def _v2_layout(workboard: Workboard) -> Dict[str, Any]:
    """Return a guaranteed-v2 layout dict (lazy import to avoid cycles)."""
    from app.modules.workboards.services.crud_service import load_layout_v2

    return load_layout_v2(workboard)


def _resolve_table_for_view(
    layout: Dict[str, Any], view: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    src = view.get("source") or {}
    src_kind = src.get("kind") or "table"
    src_id = src.get("id")
    if src_kind == "slice":
        slc = next((s for s in (layout.get("slices") or []) if s.get("id") == src_id), None)
        if not slc:
            return None
        src_id = slc.get("source_table")
    return next(
        (t for t in (layout.get("tables") or []) if t.get("id") == src_id),
        None,
    )


def _slice_filters(
    layout: Dict[str, Any], view: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """Translate slice metadata into LiveQuery-compatible filter dicts.

    Expressions (row_filter_expr) are deferred to Phase 2.4. For MVP we honor
    a small JSON shorthand: if `row_filter_expr` is a dict like
    `{column, operator, value}` (or list of those) we pass them through; if
    it's a string we ignore (TODO: expression engine).
    """
    src = view.get("source") or {}
    if src.get("kind") != "slice":
        return []
    slc = next(
        (s for s in (layout.get("slices") or []) if s.get("id") == src.get("id")),
        None,
    )
    if not slc:
        return []
    expr = slc.get("row_filter_expr")
    if isinstance(expr, dict):
        return [expr]
    if isinstance(expr, list):
        return [f for f in expr if isinstance(f, dict)]
    return []


def _add_v2_methods():
    """Attach v2 helpers to ``WorkboardRuntimeService`` (kept here so the
    earlier class body stays readable)."""

    @staticmethod
    def list_views(workboard: Workboard) -> Dict[str, Any]:  # type: ignore[misc]
        layout = _v2_layout(workboard)
        return {
            "version": layout.get("version", 2),
            "branding": layout.get("branding") or {},
            "tables": layout.get("tables") or [],
            "views": layout.get("views") or [],
            "slices": layout.get("slices") or [],
            "actions": layout.get("actions") or [],
            "refs": layout.get("refs") or [],
            "nav": layout.get("nav") or {},
        }

    @staticmethod
    def render_view(  # type: ignore[misc]
        db: Session,
        workboard: Workboard,
        view_id: str,
        *,
        page: int = 1,
        page_size: int = 50,
        filters: Optional[List[Dict[str, Any]]] = None,
        pk: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        layout = _v2_layout(workboard)
        view = next((v for v in (layout.get("views") or []) if v.get("id") == view_id), None)
        if view is None:
            return {"missing": True}
        app_table = _resolve_table_for_view(layout, view)
        if not app_table:
            return {"view": view, "rows": [], "columns": [], "missing_table": True}
        ds_table = _load_table(db, int(app_table.get("table_id") or 0))
        if ds_table is None:
            return {"view": view, "rows": [], "columns": [], "missing_table": True}
        datasource = _load_datasource_for_table(db, ds_table)
        if datasource is None:
            return {"view": view, "rows": [], "columns": []}

        kind = view.get("kind") or "table"
        page = max(int(page or 1), 1)
        page_size = min(max(int(page_size or 50), 1), 500)

        # Combine slice filters + caller filters
        all_filters = _slice_filters(layout, view) + _filter_dicts(filters)

        if kind == "detail" and pk:
            pk_filters = [
                _equality_filter(c, v)
                for c, v in pk.items()
                if c
            ]
            result = LiveQueryService.execute_preview_query(
                datasource, ds_table, limit=1, offset=0, filters=pk_filters
            )
            rows = result.get("rows") or []
            return {
                "view": view,
                "table": app_table,
                "row": rows[0] if rows else None,
                "columns": result.get("columns") or [],
            }

        offset = (page - 1) * page_size
        result = LiveQueryService.execute_preview_query(
            datasource,
            ds_table,
            limit=page_size,
            offset=offset,
            filters=all_filters,
        )
        all_columns: List[str] = result.get("columns") or []
        rows: List[Dict[str, Any]] = result.get("rows") or []
        visible = view.get("visible_columns") or app_table.get("visible_columns") or None
        if visible:
            visible = [c for c in visible if c in all_columns] or all_columns
        else:
            visible = all_columns
        if visible != all_columns:
            rows = [{c: r.get(c) for c in visible} for r in rows]

        return {
            "view": view,
            "table": app_table,
            "columns": visible,
            "rows": rows,
            "page": page,
            "page_size": page_size,
            "has_more": len(rows) == page_size,
            "execution_time_ms": result.get("execution_time_ms"),
        }

    @staticmethod
    def execute_action(  # type: ignore[misc]
        db: Session,
        workboard: Workboard,
        action_id: str,
        *,
        row_pk: Optional[Dict[str, Any]] = None,
        user: Optional[User] = None,
    ) -> Dict[str, Any]:
        layout = _v2_layout(workboard)
        action = next(
            (a for a in (layout.get("actions") or []) if a.get("id") == action_id),
            None,
        )
        if not action:
            return {"ok": False, "error": "action_not_found"}
        kind = action.get("kind")

        # Pure-client kinds — server just echoes payload
        if kind in {"navigate", "open_url", "compose_email", "go_back"}:
            return {"ok": True, "kind": kind, "action": action}

        # Server-side mutations — delegate to write service (lazy import to avoid cycle)
        if kind == "set_values" and row_pk:
            from app.modules.workboards.services.write_service import WorkboardWriteService

            values = {
                (item.get("column") or item.get("col")): item.get("value")
                for item in (action.get("set_columns") or [])
                if isinstance(item, dict) and (item.get("column") or item.get("col"))
            }
            try:
                result = WorkboardWriteService.update_row(
                    db, workboard, row_pk, values, user
                )
                return {"ok": True, "kind": kind, "result": result}
            except Exception as exc:  # pragma: no cover
                return {"ok": False, "kind": kind, "error": str(exc)}

        if kind == "add_row":
            from app.modules.workboards.services.write_service import WorkboardWriteService

            values = action.get("add_with_values") or {}
            try:
                result = WorkboardWriteService.insert_row(db, workboard, values, user)
                return {"ok": True, "kind": kind, "result": result}
            except Exception as exc:
                return {"ok": False, "kind": kind, "error": str(exc)}

        if kind == "delete_row" and row_pk:
            from app.modules.workboards.services.write_service import WorkboardWriteService

            try:
                result = WorkboardWriteService.delete_row(db, workboard, row_pk, user)
                return {"ok": True, "kind": kind, "result": result}
            except Exception as exc:
                return {"ok": False, "kind": kind, "error": str(exc)}

        if kind == "webhook":
            # MVP: log only; real outbound HTTP deferred to Phase 2.5.
            logger.info(
                "Workboard webhook action invoked id=%s wb=%s url=%s",
                action_id,
                workboard.id,
                (action.get("webhook") or {}).get("url"),
            )
            return {"ok": True, "kind": kind, "deferred": True}

        return {"ok": False, "error": f"unsupported_kind:{kind}"}

    WorkboardRuntimeService.list_views = list_views  # type: ignore[attr-defined]
    WorkboardRuntimeService.render_view = render_view  # type: ignore[attr-defined]
    WorkboardRuntimeService.execute_action = execute_action  # type: ignore[attr-defined]


_add_v2_methods()
