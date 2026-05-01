"""Mini-app screen runtime — read/write logic for the modern layout.

The legacy ``runtime_service`` resolves a single primary table per
workboard. Mini-app workboards bind each *screen* to its own table, so
reads/writes have to look at the screen first to decide which table /
filters / RLS rule applies. This module is the only place that knows
how to do that.

Public API:
* :func:`get_screen` — fetch a Screen by id, raising 404 if missing.
* :func:`render_form_screen` — return form spec (fields + lookup options).
* :func:`render_list_screen` — paginated rows after RLS.
* :func:`render_doc_screen` — block-based rendered doc payload.
* :func:`insert_screen_row` / :func:`update_screen_row` — write paths.

Each helper takes a ``CallerIdentity`` so RLS is consistently applied.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.models.dataset import DatasetTable
from app.models.models import DataSource
from app.modules.workboards.models import Workboard
from app.modules.workboards.roles import is_owner_role
from app.modules.workboards.schemas import (
    DataTableBlock,
    LayoutJson,
    RlsRoleRule,
    RowLevelSecurity,
    Screen,
    ScreenRlsRule,
)
from app.modules.workboards.services.rls_service import (
    CallerIdentity,
    build_rls_filter,
    enforce_write_access,
)
from app.modules.workboards.services.runtime_service import (
    WorkboardRuntimeService,
    _build_substitution_map,
    _compute_merges,
    _normalize_column_groups,
    _compute_totals_row,
    _filter_dicts,
    _resolve_relationship_labels,
    _substitute_strings_in_place,
    _MAX_LOOKUP_ROWS,
)
from app.modules.workboards.services.write_service import WorkboardWriteService
from app.services.live_query_service import LiveQueryService

logger = get_logger(__name__)


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


# ── RLS adapter ───────────────────────────────────────────────────────────

def _screen_rls(screen: Screen) -> RowLevelSecurity:
    """Translate per-screen rules into the common RowLevelSecurity shape so
    the existing RLS engine can be reused."""
    if not screen.rls and screen.rls_default is None:
        return RowLevelSecurity(enabled=False)

    rules = [
        RlsRoleRule(
            role=r.role,
            unrestricted=r.unrestricted,
            filter_column=r.filter_column,
            filter_value=r.filter_value,
            can_create=r.can_create,
            can_update=r.can_update,
            can_delete=r.can_delete,
            writable_columns=r.writable_columns,
            readonly_columns=r.readonly_columns,
        )
        for r in screen.rls
    ]
    default: Optional[RlsRoleRule] = None
    if screen.rls_default is not None:
        d = screen.rls_default
        default = RlsRoleRule(
            role=d.role,
            unrestricted=d.unrestricted,
            filter_column=d.filter_column,
            filter_value=d.filter_value,
            can_create=d.can_create,
            can_update=d.can_update,
            can_delete=d.can_delete,
            writable_columns=d.writable_columns,
            readonly_columns=d.readonly_columns,
        )
    return RowLevelSecurity(
        enabled=True,
        owner_column=None,
        app_user_rules=rules,
        app_user_default=default,
    )


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
        opts = WorkboardRuntimeService._resolve_lookup_options(db, field)
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
    rls = _screen_rls(screen)
    cleaned = enforce_write_access(rls, identity, op="insert", row_values=cleaned_pre)
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
    rls = _screen_rls(screen)
    cleaned = enforce_write_access(rls, identity, op="update", row_values=cleaned_pre)

    # Make sure the targeted row passes RLS before touching it.
    rls_filters, allowed = build_rls_filter(rls, identity)
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

    rls = _screen_rls(screen)
    rls_filters, allowed = build_rls_filter(rls, identity)
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
    }


# ── Doc screen ────────────────────────────────────────────────────────────

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

    substitution = _build_substitution_map(
        workboard, None, None, app_user=app_user_payload
    )
    rendered_blocks: List[Dict[str, Any]] = []
    rls = _screen_rls(screen)
    for block in screen.doc.blocks:
        payload = block.model_dump()
        if isinstance(block, DataTableBlock):
            payload["data"] = _resolve_doc_data_block(
                db, workboard, screen, block, identity=identity, rls=rls
            )
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
    rls: RowLevelSecurity,
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
        rls_filters, allowed = build_rls_filter(rls, identity)
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
