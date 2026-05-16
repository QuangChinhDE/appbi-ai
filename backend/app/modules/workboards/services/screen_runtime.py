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

import itertools
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
from app.modules.workboards.services.formula_engine import (
    Formula,
    FormulaError,
    build_dag,
    compile_formula,
)
from app.modules.workboards.services.write_service import (
    WorkboardWriteService,
)
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
    # Hard ceiling for inline file uploads (base64 in JSONB). Anything larger
    # blows up the row payload + the audit log + Postgres TOAST. Builder can
    # set a stricter per-field cap via FormField.max_file_kb.
    _HARD_FILE_KB_CAP = 1024
    _FILE_WIDGETS = {"file", "image"}
    for field in screen.form.fields:
        col = field.column
        if getattr(field, "readonly", False):
            # Static readonly fields are display-only. Drop submitted values so
            # callers cannot override system columns such as generated PKs.
            cleaned.pop(col, None)
            continue
        if getattr(field, "widget", None) in _FILE_WIDGETS:
            raw_value = cleaned.get(col)
            if isinstance(raw_value, str) and raw_value:
                # Strip a leading data-URL header so length is the raw payload.
                payload_for_size = (
                    raw_value.split(",", 1)[1]
                    if raw_value.startswith("data:") and "," in raw_value
                    else raw_value
                )
                # Base64 expands by 4/3; size_kb ≈ len * 3 / 4 / 1024.
                size_kb = (len(payload_for_size) * 3) // 4 // 1024
                builder_cap = int(getattr(field, "max_file_kb", None) or 0)
                effective_cap = (
                    min(builder_cap, _HARD_FILE_KB_CAP) if builder_cap > 0
                    else _HARD_FILE_KB_CAP
                )
                if size_kb > effective_cap:
                    label = field.label or col
                    violations.append(
                        f"Tệp '{label}' lớn hơn giới hạn {effective_cap} KB "
                        f"(thực tế ≈ {size_kb} KB)."
                    )
                    cleaned.pop(col, None)
                    continue
        if getattr(field, "computed_from_dataset", None):
            # Field is auto-filled by a dataset-side transformation (calculated
            # column, lookup, etc.). The dataset is the source of truth, so any
            # value the FE submits here would clobber the computed result on
            # the next fetch. Drop it — same contract as `readonly` static
            # fields, but the cause is "computed upstream" not "system PK".
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
        # valid_if runs AFTER required — an empty optional field skips it.
        # Refresh ctx.row with the latest cleaned values so expressions that
        # reference sibling fields see the values being submitted, not the
        # untouched copy from the top of the loop.
        valid_if_expr = getattr(field, "valid_if", None)
        if valid_if_expr:
            value = cleaned.get(col)
            if value is None or (isinstance(value, str) and value.strip() == ""):
                continue
            ctx["row"] = dict(cleaned)
            if not evaluate_truthy(valid_if_expr, ctx, default=True):
                custom_msg = getattr(field, "valid_if_error", None)
                label = field.label or col
                violations.append(
                    custom_msg.strip() if custom_msg and custom_msg.strip()
                    else f"Trường '{label}' không thoả điều kiện kiểm tra."
                )
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

    layout = parse_layout(workboard)
    auto_number_columns = [
        cfg.column for cfg in (layout.auto_number_columns or []) if cfg.column
    ]

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
        # Columns the server will auto-fill on insert when blank. The FE
        # treats these as readonly + shows a hint so users don't think the
        # form is broken when typing into them is ignored.
        "auto_number_columns": auto_number_columns,
    }


def insert_screen_row(
    db: Session,
    workboard: Workboard,
    screen: Screen,
    values: Dict[str, Any],
    *,
    identity: CallerIdentity,
) -> Dict[str, Any]:
    # Both form and grid screens are writable. Form runs field-level
    # conditional rules (show_if / required_if) first; grid skips those —
    # the grid spec has no field-level conditionals.
    if screen.table_id is None or screen.kind not in ("form", "grid"):
        raise HTTPException(status_code=400, detail="Screen is not writable.")
    if screen.kind == "form" and screen.form is None:
        raise HTTPException(status_code=400, detail="Form screen has no spec.")
    if screen.kind == "grid":
        if screen.grid is None:
            raise HTTPException(status_code=400, detail="Grid screen has no spec.")
        if not screen.grid.allow_add_row:
            raise HTTPException(
                status_code=403, detail="Adding rows is disabled on this grid."
            )

    if screen.kind == "form":
        cleaned_pre = _apply_field_conditions(screen, values, identity)
    else:
        # Grid: merge builder default_values (with placeholders) under user
        # values so the user can still override a default. Computed/lookup
        # columns are never writeable from the client — strip them first
        # so a hand-crafted payload can't slip a fake `total` past us.
        derived = {c.name for c in (screen.grid.computed_columns or [])} | {
            l.name for l in (screen.grid.lookup_columns or [])
        }
        merged = _resolve_grid_defaults(screen, identity)
        merged.update({
            k: v for k, v in (values or {}).items() if k not in derived
        })
        missing = [
            col
            for col in (screen.grid.required_columns if screen.grid else [])
            if merged.get(col) in (None, "") and col not in derived
        ]
        if missing:
            raise HTTPException(
                status_code=422,
                detail={
                    "message": f"Required columns missing: {', '.join(missing)}",
                    "violations": [{"column": c, "rule": "required"} for c in missing],
                },
            )
        cleaned_pre = merged

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
    if screen.table_id is None or screen.kind not in ("form", "grid"):
        raise HTTPException(status_code=400, detail="Screen is not writable.")
    if screen.kind == "form" and screen.form is None:
        raise HTTPException(status_code=400, detail="Form screen has no spec.")
    if screen.kind == "grid" and screen.grid is None:
        raise HTTPException(status_code=400, detail="Grid screen has no spec.")

    if screen.kind == "form":
        cleaned_pre = _apply_field_conditions(screen, values, identity)
    else:
        # Grid: ensure the user only touches columns that are flagged
        # ``editable_columns`` on the spec, and never a derived
        # (computed/lookup) column even if it slipped into editable_columns
        # in a stale layout. The RLS layer further filters by role-level
        # ``writable_columns`` / ``readonly_columns``.
        editable = set((screen.grid.editable_columns if screen.grid else []) or [])
        derived = {c.name for c in (screen.grid.computed_columns or [])} | {
            l.name for l in (screen.grid.lookup_columns or [])
        }
        editable -= derived
        cleaned_pre = {
            k: v
            for k, v in (values or {}).items()
            if k not in derived and (not editable or k in editable)
        }
        if not cleaned_pre:
            raise HTTPException(
                status_code=400,
                detail="No editable columns in payload.",
            )
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


# ── Grid screen helpers ──────────────────────────────────────────────────

def _resolve_grid_defaults(
    screen: Screen, identity: CallerIdentity
) -> Dict[str, Any]:
    """Return grid ``default_values`` with placeholders substituted.

    Reuses :func:`_resolve_initial_values` so a grid behaves the same as a
    form for ``{{app_user.x}}`` / ``{{today}}`` / ``{{now}}`` defaults.
    """
    if screen.grid is None:
        return {}
    return _resolve_initial_values(
        dict(screen.grid.default_values or {}), identity=identity
    )


def delete_screen_row(
    db: Session,
    workboard: Workboard,
    screen: Screen,
    pk: Dict[str, Any],
    *,
    identity: CallerIdentity,
) -> Dict[str, Any]:
    """Delete a single row through a grid screen, honouring RLS.

    Mirrors :func:`update_screen_row`: enforce ``can_delete`` per role, then
    confirm the row passes the read-filter rules before issuing the DELETE
    so a viewer can't delete rows outside their RLS scope.
    """
    if screen.table_id is None or screen.kind != "grid":
        raise HTTPException(
            status_code=400, detail="Only grid screens support row deletion."
        )
    if screen.grid is None or not screen.grid.allow_delete_row:
        raise HTTPException(
            status_code=403, detail="Deleting rows is disabled on this grid."
        )

    # Enforce ``can_delete`` via the shared RLS pipeline. ``row_values={}``
    # because delete has no payload; ``enforce_write_access`` will raise if
    # the matching rule blocks the op.
    enforce_write_access(
        screen.rls, screen.rls_default, identity, op="delete", row_values={}
    )

    rls_filters, allowed = build_rls_filter(
        screen.rls, screen.rls_default, identity
    )
    if not allowed:
        raise HTTPException(status_code=403, detail="You don't have access to that row.")
    if rls_filters:
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
        result = WorkboardWriteService.delete_row(db, workboard, pk or {}, None)
    finally:
        workboard.primary_table_id = original_table
        workboard.primary_key_columns = original_pk
    return result


def _resolve_grid_lookups(
    db: Session,
    grid_spec: Any,
    rows: List[Dict[str, Any]],
) -> Dict[str, Dict[Any, Any]]:
    """Batch-resolve every lookup column on the grid.

    Returns a mapping ``{lookup_name: {match_value: return_value}}`` so the
    caller can fan the values out across rows without re-querying. One
    ``SELECT match_col, return_col FROM linked WHERE match_col IN (...)``
    per lookup column, regardless of how many rows are on the page.
    """
    out: Dict[str, Dict[Any, Any]] = {}
    lookups = list(getattr(grid_spec, "lookup_columns", None) or [])
    if not lookups or not rows:
        return out

    for lookup in lookups:
        # Skip incomplete lookups (builder draft state). The schema allows
        # empty match/remote/return columns and from_table_id=0 so autosave
        # doesn't reject an in-progress edit; the runtime simply leaves the
        # cell empty until the builder finishes wiring it up.
        if (
            not lookup.from_table_id
            or not lookup.match_column_local
            or not lookup.match_column_remote
            or not lookup.return_column
        ):
            out[lookup.name] = {}
            continue
        local_col = lookup.match_column_local
        match_values = [
            row.get(local_col)
            for row in rows
            if row.get(local_col) not in (None, "")
        ]
        if not match_values:
            out[lookup.name] = {}
            continue
        # De-dup; the linked-table query only needs distinct match values.
        distinct_values = list({v for v in match_values})

        linked_table = _load_table(db, lookup.from_table_id)
        if not linked_table:
            out[lookup.name] = {}
            continue
        linked_ds = _load_datasource(db, linked_table)
        if not linked_ds:
            out[lookup.name] = {}
            continue

        try:
            result = LiveQueryService.execute_preview_query(
                linked_ds,
                linked_table,
                limit=max(len(distinct_values) * 2, 100),
                offset=0,
                filters=[
                    {
                        "field": lookup.match_column_remote,
                        "operator": "in",
                        "value": distinct_values,
                    }
                ],
            )
        except Exception:  # pragma: no cover - defensive, lookup must never crash render
            logger.exception(
                "Grid lookup '%s' failed for screen lookup_table=%s",
                lookup.name,
                lookup.from_table_id,
            )
            out[lookup.name] = {}
            continue

        mapping: Dict[Any, Any] = {}
        for row in result.get("rows") or []:
            key = row.get(lookup.match_column_remote)
            if key is None:
                continue
            mapping[key] = row.get(lookup.return_column)
        out[lookup.name] = mapping
    return out


def _coerce_total(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _compute_grid_totals(
    grid_spec: Any,
    rows: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Apply :class:`GridScreenSpec.totals` to the rows on the page.

    Returns ``{column_name: aggregated_value}`` so the runtime can render
    a footer row keyed by column. ``count`` runs over non-empty cells;
    everything else coerces to ``float``.
    """
    totals_spec: Dict[str, str] = dict(getattr(grid_spec, "totals", None) or {})
    if not totals_spec or not rows:
        return {}
    out: Dict[str, Any] = {}
    for column, kind in totals_spec.items():
        kind = (kind or "").lower()
        if kind == "count":
            out[column] = sum(
                1 for row in rows if row.get(column) not in (None, "")
            )
            continue
        nums: List[float] = []
        for row in rows:
            n = _coerce_total(row.get(column))
            if n is not None:
                nums.append(n)
        if not nums:
            out[column] = None
            continue
        if kind == "sum":
            out[column] = sum(nums)
        elif kind in ("avg", "average"):
            out[column] = sum(nums) / len(nums)
        elif kind == "min":
            out[column] = min(nums)
        elif kind == "max":
            out[column] = max(nums)
        else:
            out[column] = None
    return out


def render_grid_screen(
    db: Session,
    workboard: Workboard,
    screen: Screen,
    *,
    identity: CallerIdentity,
    page: int = 1,
    page_size: Optional[int] = None,
    extra_filters: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Render a grid screen — paginated rows + computed/lookup cells + totals.

    Evaluation order per row:

    1. Pull regular columns from the source table (RLS-filtered).
    2. Resolve every lookup column with a batched query per linked table.
    3. Evaluate computed columns in topological order so a formula can
       reference another computed column.
    4. Aggregate the totals map over the resulting (filtered) page.
    """
    if screen.kind != "grid" or screen.grid is None or screen.table_id is None:
        raise HTTPException(status_code=400, detail="Screen is not a grid.")

    grid_spec = screen.grid

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
    configured_page_size = getattr(grid_spec, "page_size", None) or 100
    page_size = min(max(int(page_size or configured_page_size or 100), 1), 500)
    offset = (page - 1) * page_size
    merged = _filter_dicts(extra_filters) + rls_filters
    sort_column = getattr(grid_spec, "default_sort_column", None)
    sort_direction = getattr(grid_spec, "default_sort_direction", None) or "desc"

    # Don't pass computed/lookup column names through to the SQL query —
    # they aren't real columns and would 500 the underlying query builder.
    computed_names = {c.name for c in (grid_spec.computed_columns or [])}
    lookup_names = {l.name for l in (grid_spec.lookup_columns or [])}
    if sort_column and sort_column in (computed_names | lookup_names):
        # Sorting by a derived column would require sorting after the
        # in-memory eval pass, which silently breaks pagination ordering.
        # Drop it back to default ordering instead of failing the screen.
        sort_column = None

    result = LiveQueryService.execute_preview_query(
        datasource,
        table,
        limit=page_size,
        offset=offset,
        filters=merged,
        sort_column=sort_column,
        sort_direction=sort_direction,
    )
    all_db_columns: List[str] = result.get("columns") or []
    pk_cols = list(screen.primary_key_columns or [])

    # Display order = the builder's column list, restricted to DB columns
    # that actually came back plus derived columns the builder declared.
    declared_columns = list(grid_spec.columns or all_db_columns)
    selected_columns = [
        c
        for c in declared_columns
        if c in all_db_columns or c in computed_names or c in lookup_names
    ] or all_db_columns

    # Keep PK columns in the row payload even if the builder hid them, so
    # the runtime can issue PATCH/DELETE keyed by PK.
    row_keys = list({*pk_cols, *(c for c in selected_columns if c in all_db_columns)})
    # Pull lookups' local match columns too — needed for the lookup step
    # even if the builder kept them hidden from the display list.
    for lookup in grid_spec.lookup_columns or []:
        if lookup.match_column_local in all_db_columns:
            row_keys.append(lookup.match_column_local)
    row_keys = list(dict.fromkeys(row_keys))

    base_rows: List[Dict[str, Any]] = [
        {column: row.get(column) for column in row_keys}
        for row in (result.get("rows") or [])
    ]

    # ── Lookup resolution ────────────────────────────────────────────
    lookup_maps = _resolve_grid_lookups(db, grid_spec, base_rows)
    for row in base_rows:
        for lookup in grid_spec.lookup_columns or []:
            match_value = row.get(lookup.match_column_local)
            row[lookup.name] = lookup_maps.get(lookup.name, {}).get(match_value)

    # ── Computed columns ─────────────────────────────────────────────
    if grid_spec.computed_columns:
        # Allowed names = regular columns + lookup columns (already on row).
        external = set(all_db_columns) | lookup_names
        compiled: Dict[str, Formula] = {}
        compile_errors: Dict[str, str] = {}
        # Columns whose formula is still blank (builder draft state) — render
        # as ``None`` instead of a compile-error string so the user sees the
        # column shell while they type.
        draft_names: set[str] = set()
        for col in grid_spec.computed_columns:
            if not (col.formula or "").strip():
                draft_names.add(col.name)
                continue
            try:
                compiled[col.name] = compile_formula(
                    col.formula, allowed_columns=external | computed_names
                )
            except FormulaError as exc:
                compile_errors[col.name] = str(exc)
        try:
            order = build_dag(compiled, external_columns=external)
        except FormulaError as exc:
            # Fall back to declared order; cycles/missing refs are flagged
            # as cell-level errors below so the rest of the grid still renders.
            order = list(compiled.keys())
            logger.warning("Grid DAG fallback (screen=%s): %s", screen.id, exc)

        # Cross-row aggregators (COL_SUM / COUNTIF / SUMIF / THIS_ROW_INDEX)
        # need to see the page's full row set. We inject it under reserved
        # ``__rows__`` / ``__row_index__`` keys — these names start with
        # ``__`` so they cannot collide with a real column reference (the
        # formula parser rejects identifiers starting with ``_``).
        for index, row in enumerate(base_rows):
            row["__rows__"] = base_rows
            row["__row_index__"] = index
            for name in order:
                formula = compiled.get(name)
                if formula is None:
                    row[name] = f"#ERR: {compile_errors.get(name, 'unknown')}"
                    continue
                try:
                    row[name] = formula.evaluate(row)
                except FormulaError as exc:
                    row[name] = f"#ERR: {exc}"
            for failed_name, msg in compile_errors.items():
                if failed_name not in row:
                    row[failed_name] = f"#ERR: {msg}"
            for draft_name in draft_names:
                if draft_name not in row:
                    row[draft_name] = None
        # Strip the internal scope keys so they don't leak in the API response.
        for row in base_rows:
            row.pop("__rows__", None)
            row.pop("__row_index__", None)

    # ── Footer totals ────────────────────────────────────────────────
    totals_row = _compute_grid_totals(grid_spec, base_rows) or None

    return {
        "columns": selected_columns,
        "primary_key_columns": pk_cols,
        "rows": base_rows,
        "page": page,
        "page_size": page_size,
        "grid_view": grid_spec.model_dump(),
        "totals_row": totals_row,
        "column_labels": screen.column_labels or {},
    }


# ── List screen ───────────────────────────────────────────────────────────

def render_list_screen(
    db: Session,
    workboard: Workboard,
    screen: Screen,
    *,
    identity: CallerIdentity,
    page: int = 1,
    page_size: Optional[int] = None,
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
    configured_page_size = getattr(screen.list, "page_size", None) or 50
    page_size = min(max(int(page_size or configured_page_size or 50), 1), 500)
    offset = (page - 1) * page_size
    merged = _filter_dicts(extra_filters) + rls_filters
    sort_column = getattr(screen.list, "default_sort_column", None)
    sort_direction = getattr(screen.list, "default_sort_direction", None) or "desc"

    result = LiveQueryService.execute_preview_query(
        datasource,
        table,
        limit=page_size,
        offset=offset,
        filters=merged,
        sort_column=sort_column,
        sort_direction=sort_direction,
    )
    all_columns: List[str] = result.get("columns") or []
    selected_columns = [c for c in (screen.list.columns or []) if c in all_columns] or all_columns
    rows = [
        {column: row.get(column) for column in selected_columns}
        for row in (result.get("rows") or [])
    ]
    return {
        "columns": selected_columns,
        "rows": rows,
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
) -> tuple[List[str], List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Apply pivot/unpivot in memory.

    Returns ``(columns, rows, extra)`` where ``extra`` may contain
    ``column_groups`` and ``column_labels`` when a multi-level pivot is
    performed. The input is not mutated.
    Raises ``HTTPException(422)`` when the transform refers to missing
    columns or when a pivot would explode beyond ``max_columns``.
    """
    if transform is None:
        return columns, rows, None

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
        return new_cols, new_rows, None

    if isinstance(transform, DataTablePivot):
        idx_cols = [c for c in transform.index if c in columns]
        if len(idx_cols) != len(transform.index):
            missing = [c for c in transform.index if c not in columns]
            raise HTTPException(
                status_code=422,
                detail=f"Pivot index columns missing from source: {missing}",
            )
        col_dims: List[str] = (
            [transform.columns]
            if isinstance(transform.columns, str)
            else list(transform.columns)
        )
        for _dim in col_dims:
            if _dim not in columns:
                raise HTTPException(
                    status_code=422,
                    detail=f"Pivot columns key '{_dim}' not in source.",
                )
        if transform.values not in columns:
            raise HTTPException(
                status_code=422,
                detail=f"Pivot values column '{transform.values}' not in source.",
            )

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

        if len(col_dims) == 1:
            # ── Single-dimension pivot (original behaviour) ─────────────
            pivot_keys_order: List[str] = []
            seen_keys: set[str] = set()
            # ``buckets[index_tuple][pivot_key]`` accumulates raw cell values.
            buckets: Dict[tuple, Dict[str, List[Any]]] = {}
            index_order: List[tuple] = []
            first_seen: Dict[tuple, Dict[str, Any]] = {}

            for row in rows:
                key_raw = row.get(col_dims[0])
                if key_raw is None:
                    continue
                pivot_key = str(key_raw)
                if pivot_key not in seen_keys:
                    if len(pivot_keys_order) >= transform.max_columns:
                        raise HTTPException(
                            status_code=422,
                            detail=(
                                f"Pivot exceeded max_columns={transform.max_columns} "
                                f"distinct values of '{col_dims[0]}'. "
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

            new_cols = idx_cols + pivot_keys_order
            new_rows: List[Dict[str, Any]] = []
            for idx_tuple in index_order:
                row_out = dict(first_seen[idx_tuple])
                cells_map = buckets[idx_tuple]
                for pk in pivot_keys_order:
                    row_out[pk] = _aggregate(cells_map.get(pk, []))
                new_rows.append(row_out)
            return new_cols, new_rows, None

        # ── Multi-dimension pivot (generates 2-level column headers) ────
        # Composite key separator — unlikely to appear in real data values.
        _SEP = "__|__"

        # Gather ordered distinct values for each column dimension.
        dim_vals: List[List[str]] = [[] for _ in col_dims]
        dim_seen_sets: List[set] = [set() for _ in col_dims]
        for row in rows:
            for i, _dim in enumerate(col_dims):
                v = row.get(_dim)
                if v is None:
                    continue
                k = str(v)
                if k not in dim_seen_sets[i]:
                    dim_seen_sets[i].add(k)
                    dim_vals[i].append(k)

        # Build ordered composite keys (Cartesian product in dim order).
        composite_keys: List[str] = []
        composite_key_combos: List[tuple] = []
        composite_set: set = set()
        for combo in itertools.product(*dim_vals):
            ck = _SEP.join(combo)
            if ck not in composite_set:
                if len(composite_keys) >= transform.max_columns:
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            f"Pivot exceeded max_columns={transform.max_columns}. "
                            "Raise max_columns or pre-filter the source."
                        ),
                    )
                composite_set.add(ck)
                composite_keys.append(ck)
                composite_key_combos.append(combo)

        # Collect buckets: index_tuple → composite_key → [values].
        buckets_ml: Dict[tuple, Dict[str, List[Any]]] = {}
        index_order_ml: List[tuple] = []
        first_seen_ml: Dict[tuple, Dict[str, Any]] = {}
        for row in rows:
            parts: List[str] = []
            skip = False
            for _dim in col_dims:
                v = row.get(_dim)
                if v is None:
                    skip = True
                    break
                parts.append(str(v))
            if skip:
                continue
            ck = _SEP.join(parts)
            idx_tuple = tuple(row.get(c) for c in idx_cols)
            if idx_tuple not in buckets_ml:
                buckets_ml[idx_tuple] = {}
                index_order_ml.append(idx_tuple)
                first_seen_ml[idx_tuple] = {c: row.get(c) for c in idx_cols}
            buckets_ml[idx_tuple].setdefault(ck, []).append(row.get(transform.values))

        new_cols_ml = idx_cols + composite_keys
        new_rows_ml: List[Dict[str, Any]] = []
        for idx_tuple in index_order_ml:
            row_out = dict(first_seen_ml[idx_tuple])
            cells_map_ml = buckets_ml[idx_tuple]
            for ck in composite_keys:
                row_out[ck] = _aggregate(cells_map_ml.get(ck, []))
            new_rows_ml.append(row_out)

        # Build column_groups: one group per first-dimension value.
        extra_groups: List[Dict[str, Any]] = []
        for first_val in dim_vals[0]:
            group_cols = [
                ck
                for ck, combo in zip(composite_keys, composite_key_combos)
                if combo[0] == first_val
            ]
            if group_cols:
                extra_groups.append({"label": first_val, "columns": group_cols})

        # column_labels: composite key → last dimension value (display label).
        col_labels: Dict[str, str] = {
            ck: combo[-1]
            for ck, combo in zip(composite_keys, composite_key_combos)
        }

        return new_cols_ml, new_rows_ml, {
            "column_groups": extra_groups,
            "column_labels": col_labels,
        }

    return columns, rows, None


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
    _pivot_extra: Optional[Dict[str, Any]] = None
    if block.transform is not None:
        all_columns, rows, _pivot_extra = _apply_data_table_transform(
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
    _cg_source = (_pivot_extra or {}).get("column_groups") or block.column_groups
    column_groups = _normalize_column_groups(selected, _cg_source)
    if column_groups:
        payload["column_groups"] = column_groups
    _auto_labels = (_pivot_extra or {}).get("column_labels")
    if _auto_labels:
        payload["column_labels"] = _auto_labels
    # Surface the builder-side `column_metadata` (label override, width, format,
    # align, per-column total override, merge flag) so the doc runtime can
    # honour the formatting the builder configured. Was previously only
    # additive — clients now opt in by reading payload.column_metadata.
    column_metadata_raw = block.column_metadata or {}
    if column_metadata_raw:
        forwarded_meta: Dict[str, Any] = {}
        for col_name, meta in column_metadata_raw.items():
            if col_name not in selected:
                continue
            if hasattr(meta, "model_dump"):
                meta_dict = meta.model_dump(exclude_none=True)
            elif isinstance(meta, dict):
                meta_dict = {k: v for k, v in meta.items() if v is not None}
            else:
                continue
            if meta_dict:
                forwarded_meta[col_name] = meta_dict
        if forwarded_meta:
            payload["column_metadata"] = forwarded_meta
            # Pre-fold metadata.label into the column_labels map so existing
            # FE table renderers (which already read column_labels) display
            # the override without needing to know about column_metadata.
            existing_labels = dict(payload.get("column_labels") or {})
            for col_name, meta_dict in forwarded_meta.items():
                label_override = meta_dict.get("label")
                if isinstance(label_override, str) and label_override and col_name not in existing_labels:
                    existing_labels[col_name] = label_override
            if existing_labels:
                payload["column_labels"] = existing_labels
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
        # Surface the caller's role so the FE can hide per-action
        # buttons whose `visible_for_roles` excludes the current user.
        # Internal/admin previews come in as identity.role=None — the FE
        # treats None as "see everything".
        "viewer": {
            "role": identity.role,
            "username": (identity.app_user or {}).get("username") if identity.app_user else None,
        },
    }
