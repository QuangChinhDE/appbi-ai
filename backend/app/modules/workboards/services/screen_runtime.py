"""Mini-app screen runtime — the single read/write entry point for workboards.

A workboard is a mini-app: an ordered list of screens, each bound to its
own dataset table. This module resolves the screen first, then applies
the right read / write / RLS logic for its kind (form / list / doc).

Public API:
* :func:`get_screen` — fetch a Screen by id, raising 404 if missing.
* :func:`render_form_screen` — return form spec (fields + lookup options).
* :func:`render_list_screen` — paginated rows after RLS.
* :func:`render_doc_screen` — block-based rendered doc payload.
* :func:`insert_screen_row` / :func:`update_screen_row` — write paths.

Each helper takes a ``CallerIdentity`` so RLS is consistently applied.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.models.dataset import DatasetTable
from app.models.models import DataSource
from app.modules.workboards.models import Workboard
from app.modules.workboards.roles import is_owner_role
from app.modules.workboards.schemas import (
    DataTableBlock,
    DataTablePivot,
    DataTableUnpivot,
    FormField,
    LayoutJson,
    Screen,
    ScreenRlsRule,
)
from app.modules.workboards.services.rls_service import (
    CallerIdentity,
    build_rls_filter,
    enforce_write_access,
)
from app.modules.workboards.services.write_service import WorkboardWriteService
from app.services.live_query_service import LiveQueryService

logger = get_logger(__name__)

_MAX_LOOKUP_ROWS = 500
_AGG_FNS = {"sum", "avg", "min", "max", "count"}


# ── Generic helpers (formerly in runtime_service) ─────────────────────────

def _filter_dicts(filters: Optional[List[Any]]) -> List[Dict[str, Any]]:
    cleaned: List[Dict[str, Any]] = []
    for item in filters or []:
        if isinstance(item, dict):
            cleaned.append(item)
        elif hasattr(item, "model_dump"):
            cleaned.append(item.model_dump())
        elif hasattr(item, "dict"):
            cleaned.append(item.dict())
    return cleaned


def _parse_total_spec(spec: str) -> tuple[str, str]:
    """Parse ``"column"`` or ``"column:agg"`` → (column, agg). Default ``sum``."""
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

    Output shape: ``{rows: [{agg, label, values}, ...], single?: {col: number}}``.
    The FE renders one ``<tr>`` per ``rows`` entry; when ``single`` is
    present (each column has at most one agg) the FE can compact to a
    one-row footer.
    """
    if not totals:
        return None

    by_agg: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for spec in totals:
        col, agg = _parse_total_spec(spec)
        if not col or col not in columns:
            continue
        values = [_coerce_number(r.get(col)) for r in rows]
        numeric = [v for v in values if v is not None]
        if agg == "count":
            value: Any = sum(1 for r in rows if r.get(col) is not None)
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
    counts: Dict[str, int] = {}
    for fr in footer_rows:
        for c in fr["values"]:
            counts[c] = counts.get(c, 0) + 1
    out: Dict[str, Any] = {"rows": footer_rows}
    if all(v == 1 for v in counts.values()):
        single: Dict[str, Any] = {}
        for fr in footer_rows:
            single.update(fr["values"])
        out["single"] = single
    return out


def _compute_merges(
    rows: List[Dict[str, Any]],
    group_by: List[str],
    columns: List[str],
) -> List[Dict[str, Any]]:
    """Return rowspan recipes (``{column, row_start, row_span}``) for
    consecutive identical values in each group_by column.
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
        if len(rows) - run_start > 1:
            out.append({
                "column": col,
                "row_start": run_start,
                "row_span": len(rows) - run_start,
            })
    return out


def _normalize_column_groups(
    columns: List[str],
    column_groups: Optional[List[Any]],
) -> List[Dict[str, Any]]:
    """Keep only valid, contiguous column groups in display order."""
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


def _build_substitution_map(
    workboard: Workboard,
    *,
    app_user: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    return {
        "app_user": dict(app_user or {}),
        "now": now.isoformat(),
        "today": now.date().isoformat(),
        "workboard": {"id": workboard.id, "name": workboard.name},
    }


def _substitute_string(text: str, mapping: Dict[str, Any]) -> str:
    if "{{" not in text:
        return text

    def _replace(match: "re.Match[str]") -> str:
        path = match.group(1).strip()
        cursor: Any = mapping
        for part in path.split("."):
            if isinstance(cursor, dict) and part in cursor:
                cursor = cursor[part]
            else:
                return match.group(0)
        return "" if cursor is None else str(cursor)

    return re.sub(r"\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}", _replace, text)


def _substitute_strings_in_place(obj: Any, mapping: Dict[str, Any]) -> None:
    """Recursively replace ``{{path.to.value}}`` placeholders inside strings."""
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


def _resolve_relationship_labels(
    db: Session,
    *,
    base_rows: List[Dict[str, Any]],
    base_label_column: Optional[str],
    base_join_column: str,
    hops: List[Any],
) -> Dict[Any, str]:
    """Walk a relationship chain and build {primary_value → final_label}.

    Each hop fetches its target table via LiveQueryService. The chain is
    bounded (4 hops) and silently degrades to an empty mapping on any
    failure — callers fall back to the single-hop label so the form never
    breaks.
    """
    if not base_rows or not hops:
        return {}
    MAX_HOPS = 4
    safe_hops = list(hops)[:MAX_HOPS]

    cursor: Dict[Any, Any] = {}
    for row in base_rows:
        primary_val = row.get(base_join_column)
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
        datasource = _load_datasource(db, table)
        if datasource is None:
            return {}
        try:
            result = LiveQueryService.execute_preview_query(
                datasource, table, limit=_MAX_LOOKUP_ROWS, offset=0, filters=[],
            )
        except Exception:
            logger.exception("Nested lookup hop failed (table_id=%s)", hop.table_id)
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
            forward_value = row.get(hop.label_column) if hop.label_column else None
            if forward_value is None:
                forward_value = current_key
            next_cursor[forward_value] = primary_val
        cursor = next_cursor
        last_label_col = hop.label_column

    if last_label_col is None:
        return {}
    return {primary_val: str(label_val) for label_val, primary_val in cursor.items()}


def _resolve_lookup_options(
    db: Session, field: FormField
) -> Optional[List[Dict[str, Any]]]:
    """Materialize ``[{label, value}]`` options for a form field's lookup.

    Returns ``None`` when the field has no lookup config (caller should
    skip), an empty list when the lookup is misconfigured / unresolvable,
    or the resolved options otherwise.
    """
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
        datasource = _load_datasource(db, table)
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
                    "label": resolved_labels.get(row.get(value_col))
                    or str(row.get(label_col, "") or ""),
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


# ── Layout + screen lookup ────────────────────────────────────────────────

def parse_layout(workboard: Workboard) -> LayoutJson:
    try:
        return LayoutJson.model_validate(workboard.layout_json or {})
    except Exception:
        logger.exception("workboard %s has invalid layout", workboard.id)
        return LayoutJson()


def get_screen(layout: LayoutJson, screen_id: str) -> Screen:
    for screen in layout.screens:
        if screen.id == screen_id:
            return screen
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Screen '{screen_id}' not found in this workboard.",
    )


def is_screen_visible_for(screen: Screen, identity: CallerIdentity) -> bool:
    if is_owner_role(identity.role):
        return True
    if not screen.visible_for_roles:
        return True
    role = (identity.role or "").strip().lower()
    return any(r.strip().lower() == role for r in screen.visible_for_roles)


# ── Table helpers ─────────────────────────────────────────────────────────

def _load_table(db: Session, table_id: int) -> Optional[DatasetTable]:
    if not table_id:
        return None
    return db.query(DatasetTable).filter(DatasetTable.id == table_id).first()


def _load_datasource(db: Session, table: DatasetTable) -> Optional[DataSource]:
    if table is None:
        return None
    return db.query(DataSource).filter(DataSource.id == table.datasource_id).first()


def _apply_field_conditions(
    screen: Screen,
    values: Dict[str, Any],
    identity: CallerIdentity,
) -> Dict[str, Any]:
    """Enforce field-level show_if / required_if / readonly_if at write time.

    Hidden fields (``show_if`` evaluates falsy) are stripped — the FE may
    have left a stale value in the payload after the user toggled some
    other field. Required-if-true fields with empty values raise 422.
    """
    from app.modules.workboards.services.expr_eval import evaluate, evaluate_truthy

    if screen.form is None:
        return dict(values or {})

    ctx = {
        "row": dict(values or {}),
        "app_user": dict(identity.app_user or {}),
        "shared": {},
    }
    cleaned = dict(values or {})
    violations: List[str] = []
    for field in screen.form.fields:
        col = field.column
        if getattr(field, "readonly", False):
            # Static readonly fields are display-only. Drop submitted values so
            # callers cannot override system columns such as generated PKs.
            cleaned.pop(col, None)
            continue
        show_if_expr = getattr(field, "show_if", None)
        if show_if_expr and not evaluate_truthy(show_if_expr, ctx, default=True):
            cleaned.pop(col, None)
            continue
        readonly_if_expr = getattr(field, "readonly_if", None)
        if readonly_if_expr and evaluate_truthy(readonly_if_expr, ctx, default=False):
            # Drop the column so the existing DB value (or default) wins.
            cleaned.pop(col, None)
            continue
        required_if_expr = getattr(field, "required_if", None)
        is_required_static = bool(getattr(field, "required", False))
        is_required = is_required_static
        if required_if_expr:
            is_required = bool(evaluate_truthy(required_if_expr, ctx, default=False))
        if is_required:
            v = cleaned.get(col)
            if v is None or (isinstance(v, str) and v.strip() == ""):
                violations.append(f"Trường '{field.label or col}' là bắt buộc.")
    if violations:
        raise HTTPException(
            status_code=422,
            detail={"message": "Validation failed", "violations": violations},
        )
    return cleaned


def _resolve_initial_values(
    initial: Dict[str, Any],
    *,
    identity: CallerIdentity,
    shared_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Substitute ``{{app_user.x}}`` / ``{{shared.col}}`` / ``{{today}}``
    in form initial values so the FE can prefill the form without having
    to know about placeholders itself."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    out: Dict[str, Any] = {}
    for col, raw in (initial or {}).items():
        if not isinstance(raw, str) or "{{" not in raw:
            out[col] = raw
            continue
        text = raw.strip()
        # Cheap exact-match resolution first.
        if text == "{{today}}":
            out[col] = now.date().isoformat()
            continue
        if text == "{{now}}":
            out[col] = now.isoformat()
            continue
        if text.startswith("{{app_user.") and text.endswith("}}"):
            key = text[len("{{app_user.") : -2].strip()
            if identity.app_user:
                if key == "username":
                    out[col] = identity.app_user.get("username")
                else:
                    out[col] = identity.app_user.get(key)
            continue
        if text.startswith("{{shared.") and text.endswith("}}"):
            key = text[len("{{shared.") : -2].strip()
            if shared_context:
                out[col] = shared_context.get(key)
            continue
        # Otherwise leave as-is for the runtime layer to handle.
        out[col] = raw
    return out


# ── Form screen ───────────────────────────────────────────────────────────

def render_form_screen(
    db: Session,
    workboard: Workboard,
    screen: Screen,
    *,
    identity: CallerIdentity,
    shared_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if screen.kind != "form" or screen.form is None:
        raise HTTPException(status_code=400, detail="Screen is not a form.")

    # Resolve lookup options the same way the legacy form view does, but
    # restricted to this screen's fields.
    lookups: Dict[str, List[Dict[str, Any]]] = {}
    for field in screen.form.fields:
        opts = _resolve_lookup_options(db, field)
        if opts is not None:
            lookups[field.column] = opts

    initial = _resolve_initial_values(
        screen.form.initial_values,
        identity=identity,
        shared_context=shared_context,
    )

    return {
        "screen_id": screen.id,
        "kind": "form",
        "title": screen.title,
        "icon": screen.icon,
        "description": screen.description,
        "table_id": screen.table_id,
        "primary_key_columns": list(screen.primary_key_columns or []),
        "submit_label": screen.form.submit_label,
        "fields": [field.model_dump() for field in screen.form.fields],
        "lookups": lookups,
        "initial_values": initial,
        "after_submit": (
            screen.form.after_submit.model_dump()
            if screen.form.after_submit is not None
            else None
        ),
        "pages": [p.model_dump() for p in (screen.form.pages or [])],
        "sections": list(screen.form.sections or []),
    }


def insert_screen_row(
    db: Session,
    workboard: Workboard,
    screen: Screen,
    values: Dict[str, Any],
    *,
    identity: CallerIdentity,
) -> Dict[str, Any]:
    if screen.kind != "form" or screen.form is None or screen.table_id is None:
        raise HTTPException(status_code=400, detail="Screen is not writable.")

    # Apply field-level conditional rules (show_if / required_if) before RLS.
    cleaned_pre = _apply_field_conditions(screen, values, identity)
    cleaned = enforce_write_access(
        screen.rls, screen.rls_default, identity, op="insert", row_values=cleaned_pre
    )
    # Hand off to the existing write service, but point it at the screen's
    # table by temporarily swapping ``primary_table_id`` on the workboard
    # instance — the service reads it lazily, so this is safe within the
    # request lifetime.
    original_table = workboard.primary_table_id
    original_pk = list(workboard.primary_key_columns or [])
    workboard.primary_table_id = screen.table_id
    if screen.primary_key_columns:
        workboard.primary_key_columns = list(screen.primary_key_columns)
    try:
        result = WorkboardWriteService.insert_row(db, workboard, cleaned, None)
    finally:
        workboard.primary_table_id = original_table
        workboard.primary_key_columns = original_pk
    return result


def update_screen_row(
    db: Session,
    workboard: Workboard,
    screen: Screen,
    pk: Dict[str, Any],
    values: Dict[str, Any],
    *,
    identity: CallerIdentity,
) -> Dict[str, Any]:
    if screen.kind != "form" or screen.form is None or screen.table_id is None:
        raise HTTPException(status_code=400, detail="Screen is not writable.")

    cleaned_pre = _apply_field_conditions(screen, values, identity)
    cleaned = enforce_write_access(
        screen.rls, screen.rls_default, identity, op="update", row_values=cleaned_pre
    )

    # Make sure the targeted row passes RLS before touching it.
    rls_filters, allowed = build_rls_filter(
        screen.rls, screen.rls_default, identity
    )
    if not allowed:
        raise HTTPException(status_code=403, detail="You don't have access to that row.")
    if rls_filters:
        # Existence check on the screen's bound table — bypass the
        # render_list_screen kind check because update screens are forms,
        # not lists, but they share the same RLS rule set.
        table = _load_table(db, screen.table_id)
        datasource = _load_datasource(db, table) if table else None
        if not table or not datasource:
            raise HTTPException(status_code=400, detail="Screen table missing.")
        check_filters = [
            {"field": k, "operator": "eq", "value": v} for k, v in (pk or {}).items()
        ] + rls_filters
        result = LiveQueryService.execute_preview_query(
            datasource, table, limit=1, offset=0, filters=check_filters
        )
        if not (result.get("rows") or []):
            raise HTTPException(
                status_code=403, detail="You don't have access to that row."
            )

    original_table = workboard.primary_table_id
    original_pk = list(workboard.primary_key_columns or [])
    workboard.primary_table_id = screen.table_id
    if screen.primary_key_columns:
        workboard.primary_key_columns = list(screen.primary_key_columns)
    try:
        result = WorkboardWriteService.update_row(db, workboard, pk, cleaned, None)
    finally:
        workboard.primary_table_id = original_table
        workboard.primary_key_columns = original_pk
    return result


# ── List screen ───────────────────────────────────────────────────────────

def render_list_screen(
    db: Session,
    workboard: Workboard,
    screen: Screen,
    *,
    identity: CallerIdentity,
    page: int = 1,
    page_size: int = 50,
    extra_filters: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    if screen.kind != "list" or screen.list is None or screen.table_id is None:
        raise HTTPException(status_code=400, detail="Screen is not a list.")

    table = _load_table(db, screen.table_id)
    datasource = _load_datasource(db, table) if table else None
    if not table or not datasource:
        return {"columns": [], "rows": [], "page": page, "page_size": page_size}

    rls_filters, allowed = build_rls_filter(
        screen.rls, screen.rls_default, identity
    )
    if not allowed:
        return {"columns": [], "rows": [], "page": page, "page_size": page_size}

    page = max(int(page or 1), 1)
    page_size = min(max(int(page_size or 50), 1), 500)
    offset = (page - 1) * page_size
    merged = _filter_dicts(extra_filters) + rls_filters

    result = LiveQueryService.execute_preview_query(
        datasource, table, limit=page_size, offset=offset, filters=merged
    )
    return {
        "columns": result.get("columns") or [],
        "rows": result.get("rows") or [],
        "page": page,
        "page_size": page_size,
        "list_view": screen.list.model_dump(),
        "column_labels": screen.column_labels or {},
    }


# ── Doc screen ────────────────────────────────────────────────────────────

def _apply_data_table_transform(
    columns: List[str],
    rows: List[Dict[str, Any]],
    transform: Optional[Any],
) -> tuple[List[str], List[Dict[str, Any]]]:
    """Apply pivot/unpivot in memory.

    Returns a fresh ``(columns, rows)`` pair; the input is not mutated.
    Raises ``HTTPException(422)`` when the transform refers to missing
    columns or when a pivot would explode beyond ``max_columns``. The
    transform runs on the *fetched* rows so it respects ``max_rows`` and
    the screen's RLS filters set on the underlying query.
    """
    if transform is None:
        return columns, rows

    if isinstance(transform, DataTableUnpivot):
        id_cols = [c for c in transform.id_columns if c in columns]
        value_cols = [c for c in transform.value_columns if c in columns]
        if not value_cols:
            raise HTTPException(
                status_code=422,
                detail="Unpivot: none of value_columns exist in the source.",
            )
        var_name = transform.var_name
        value_name = transform.value_name
        if var_name in id_cols or value_name in id_cols or var_name == value_name:
            raise HTTPException(
                status_code=422,
                detail="Unpivot var_name/value_name must not collide with id_columns or each other.",
            )
        new_cols = id_cols + [var_name, value_name]
        new_rows: List[Dict[str, Any]] = []
        for row in rows:
            id_part = {c: row.get(c) for c in id_cols}
            for vc in value_cols:
                cell = row.get(vc)
                if transform.drop_nulls and cell is None:
                    continue
                new_row = dict(id_part)
                new_row[var_name] = vc
                new_row[value_name] = cell
                new_rows.append(new_row)
        return new_cols, new_rows

    if isinstance(transform, DataTablePivot):
        idx_cols = [c for c in transform.index if c in columns]
        if len(idx_cols) != len(transform.index):
            missing = [c for c in transform.index if c not in columns]
            raise HTTPException(
                status_code=422,
                detail=f"Pivot index columns missing from source: {missing}",
            )
        if transform.columns not in columns:
            raise HTTPException(
                status_code=422,
                detail=f"Pivot columns key '{transform.columns}' not in source.",
            )
        if transform.values not in columns:
            raise HTTPException(
                status_code=422,
                detail=f"Pivot values column '{transform.values}' not in source.",
            )

        pivot_keys_order: List[str] = []
        seen_keys: set[str] = set()
        # ``buckets[index_tuple][pivot_key]`` accumulates raw cell values.
        buckets: Dict[tuple, Dict[str, List[Any]]] = {}
        index_order: List[tuple] = []
        first_seen: Dict[tuple, Dict[str, Any]] = {}

        for row in rows:
            key_raw = row.get(transform.columns)
            if key_raw is None:
                continue
            pivot_key = str(key_raw)
            if pivot_key not in seen_keys:
                if len(pivot_keys_order) >= transform.max_columns:
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            f"Pivot exceeded max_columns={transform.max_columns} "
                            f"distinct values of '{transform.columns}'. "
                            "Raise max_columns or pre-filter the source."
                        ),
                    )
                seen_keys.add(pivot_key)
                pivot_keys_order.append(pivot_key)
            idx_tuple = tuple(row.get(c) for c in idx_cols)
            if idx_tuple not in buckets:
                buckets[idx_tuple] = {}
                index_order.append(idx_tuple)
                first_seen[idx_tuple] = {c: row.get(c) for c in idx_cols}
            buckets[idx_tuple].setdefault(pivot_key, []).append(row.get(transform.values))

        agg = transform.agg

        def _aggregate(cells: List[Any]) -> Any:
            if not cells:
                return transform.fill_value
            if agg == "count":
                return sum(1 for v in cells if v is not None)
            if agg == "first":
                return cells[0]
            numeric = [_coerce_number(v) for v in cells]
            numeric = [v for v in numeric if v is not None]
            if not numeric:
                return transform.fill_value
            if agg == "sum":
                return sum(numeric)
            if agg == "avg":
                return sum(numeric) / len(numeric)
            if agg == "min":
                return min(numeric)
            if agg == "max":
                return max(numeric)
            return transform.fill_value

        new_cols = idx_cols + pivot_keys_order
        new_rows = []
        for idx_tuple in index_order:
            row_out = dict(first_seen[idx_tuple])
            cells_map = buckets[idx_tuple]
            for pk in pivot_keys_order:
                row_out[pk] = _aggregate(cells_map.get(pk, []))
            new_rows.append(row_out)
        return new_cols, new_rows

    return columns, rows


def render_doc_screen(
    db: Session,
    workboard: Workboard,
    screen: Screen,
    *,
    identity: CallerIdentity,
    app_user_payload: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if screen.kind != "doc" or screen.doc is None:
        raise HTTPException(status_code=400, detail="Screen is not a doc.")

    substitution = _build_substitution_map(workboard, app_user=app_user_payload)
    rendered_blocks: List[Dict[str, Any]] = []
    screen_column_labels = screen.column_labels or {}
    for block in screen.doc.blocks:
        payload = block.model_dump()
        if isinstance(block, DataTableBlock):
            payload["data"] = _resolve_doc_data_block(
                db, workboard, screen, block, identity=identity
            )
        # Inject screen-level column_labels so frontend can show friendly names
        if screen_column_labels and not payload.get("column_labels"):
            payload["column_labels"] = screen_column_labels
        _substitute_strings_in_place(payload, substitution)
        rendered_blocks.append(payload)

    return {
        "screen_id": screen.id,
        "kind": "doc",
        "title": screen.title,
        "page": screen.doc.page.model_dump(),
        "blocks": rendered_blocks,
        "context": substitution,
    }


def _resolve_doc_data_block(
    db: Session,
    workboard: Workboard,
    screen: Screen,
    block: DataTableBlock,
    *,
    identity: CallerIdentity,
) -> Dict[str, Any]:
    # Doc blocks default to ``primary`` (the screen's table) but also
    # support ``lookup:<table_id>`` so a single doc screen can join over
    # multiple tables (e.g. shifts + hourly_output for the overview).
    if block.source.startswith("lookup:"):
        try:
            table_id = int(block.source.split(":", 1)[1])
        except (ValueError, IndexError):
            return {"columns": [], "rows": []}
    else:
        table_id = screen.table_id or 0
    if not table_id:
        return {"columns": [], "rows": []}

    table = _load_table(db, table_id)
    datasource = _load_datasource(db, table) if table else None
    if not table or not datasource:
        return {"columns": [], "rows": []}

    filters: List[Dict[str, Any]] = []
    # Apply RLS only on the screen's bound table (block.source == "primary"
    # or pointing back to the same table). Cross-table doc tables (lookups)
    # still need to be visible to the role; we trust the screen's
    # ``visible_for_roles`` to gate that.
    is_primary = (
        block.source == "primary"
        or (block.source.startswith("lookup:") and table_id == screen.table_id)
    )
    if is_primary:
        rls_filters, allowed = build_rls_filter(
            screen.rls, screen.rls_default, identity
        )
        if not allowed:
            return {"columns": [], "rows": []}
        filters = filters + rls_filters

    result = LiveQueryService.execute_preview_query(
        datasource, table, limit=block.max_rows, offset=0, filters=filters
    )
    all_columns: List[str] = result.get("columns") or []
    rows: List[Dict[str, Any]] = result.get("rows") or []
    # Pivot/unpivot first so column projection, group_by merges and totals
    # operate on the *reported* shape — not the raw source shape.
    if block.transform is not None:
        all_columns, rows = _apply_data_table_transform(
            all_columns, rows, block.transform
        )
    selected = [c for c in (block.columns or []) if c in all_columns] or all_columns
    if selected != all_columns:
        rows = [{c: row.get(c) for c in selected} for row in rows]
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
    footer = _compute_totals_row(block.totals, selected, rows)
    if footer:
        payload["footer_row"] = footer
    return payload


# ── Doc data-table export ─────────────────────────────────────────────────

def export_doc_data_block_to_excel(
    db: Session,
    workboard: Workboard,
    screen: Screen,
    block_index: int,
    *,
    identity: CallerIdentity,
) -> tuple[bytes, str]:
    """Render the *displayed* table of a doc ``data_table`` block to XLSX.

    Returns ``(content, filename)``. Only blocks with
    ``allow_export_excel=True`` are exportable; the same RLS as on-screen
    rendering applies because we go through :func:`_resolve_doc_data_block`.
    """
    if screen.kind != "doc" or screen.doc is None:
        raise HTTPException(status_code=400, detail="Screen is not a doc.")
    blocks = screen.doc.blocks
    if block_index < 0 or block_index >= len(blocks):
        raise HTTPException(status_code=404, detail="Block not found.")
    block = blocks[block_index]
    if not isinstance(block, DataTableBlock):
        raise HTTPException(status_code=400, detail="Block is not a data_table.")
    if not block.allow_export_excel:
        raise HTTPException(status_code=403, detail="Excel export is disabled for this block.")

    data = _resolve_doc_data_block(db, workboard, screen, block, identity=identity)
    columns: List[str] = data.get("columns") or []
    rows: List[Dict[str, Any]] = data.get("rows") or []

    # Reuse the dataset exporter so cell coercion stays consistent.
    from app.services.dataset_excel_export_service import (
        export_dataset_table_to_excel,
        sanitize_excel_sheet_title,
    )

    def _fetch_page(_limit: int, offset: int) -> Dict[str, Any]:
        if offset == 0:
            return {"columns": columns, "rows": rows}
        return {"columns": columns, "rows": []}

    sheet_title = sanitize_excel_sheet_title(
        block.title or screen.title or f"block_{block_index + 1}"
    )
    result = export_dataset_table_to_excel(
        _fetch_page,
        sheet_title=sheet_title,
        page_size=max(len(rows), 1),
        max_rows=max(len(rows), 1),
    )
    # Compose a filename like "workboard-slug__screen-id__block-2.xlsx".
    safe_screen = re.sub(r"[^A-Za-z0-9_.-]+", "_", screen.id) or "screen"
    safe_wb = re.sub(r"[^A-Za-z0-9_.-]+", "_", workboard.slug or workboard.name or "workboard")
    filename = f"{safe_wb}__{safe_screen}__block-{block_index + 1}.xlsx"
    return result.content, filename


# ── Public app shell payload ──────────────────────────────────────────────

def render_app_shell(
    workboard: Workboard,
    identity: CallerIdentity,
) -> Dict[str, Any]:
    """Initial payload the public runtime fetches on entry to a workboard.

    Returns a slim dict with everything the FE needs to render the app
    shell (header + nav) without bouncing back to the API to discover
    screens. Per-screen content stays lazy-loaded.
    """
    layout = parse_layout(workboard)
    visible_screens = [s for s in layout.screens if is_screen_visible_for(s, identity)]
    nav_items = list(layout.mini_app_nav.items)
    if not nav_items:
        nav_items = [s.id for s in visible_screens if s.show_in_nav]
    # Filter nav items to those actually visible to this identity.
    visible_ids = {s.id for s in visible_screens}
    nav_items = [sid for sid in nav_items if sid in visible_ids]

    return {
        "workboard": {
            "id": workboard.id,
            "name": workboard.name,
            "slug": workboard.slug,
            "icon": workboard.icon,
            "description": workboard.description,
        },
        "branding": layout.branding.model_dump(),
        "nav": {
            **layout.mini_app_nav.model_dump(),
            "items": nav_items,
        },
        "screens": [
            {
                "id": s.id,
                "kind": s.kind,
                "title": s.title,
                "icon": s.icon,
                "description": s.description,
                "show_in_nav": s.show_in_nav,
            }
            for s in visible_screens
        ],
    }
