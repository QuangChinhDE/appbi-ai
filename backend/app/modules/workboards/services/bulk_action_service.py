"""Server-side executor for advanced bulk "gộp & điều phối" actions.

A ``BulkAction`` with ``steps`` is a declarative recipe: create a parent (with
aggregated totals + picked-resource fields + a generated code), create N detail
lines from the selection, and update the source rows — all orchestrated HERE on
the server (not the browser) so the flow is one call, validated once, with
**compensation rollback**: if any step fails, the rows created by earlier steps
are deleted and updated rows are restored, so a half-built "gộp" never lingers.

Design contract (stays inside the Workboards module):
- Reuses the existing per-row write paths (`insert_screen_row` / `update_screen_row`
  / `delete_screen_row`) so RLS, auto-number, audit, validation and datasource
  routing (PG/MySQL/Sheets) all apply exactly as a normal write.
- Reads the SELECTED rows authoritatively from the DB (never trusts client row
  values); picked RESOURCE rows are reference data supplied by the caller.
- Not a single DB transaction across a heterogeneous datasource (Sheets has no
  transactions); compensation gives all-or-nothing behaviour uniformly. True
  single-connection SQL transactions are a later hardening.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.modules.workboards.models import Workboard
from app.modules.workboards.schemas import BulkAction, Screen
from app.modules.workboards.services import screen_runtime
from app.modules.workboards.services.rls_service import CallerIdentity

logger = get_logger(__name__)


class BulkActionError(Exception):
    def __init__(self, message: str, *, per_step: Optional[List[Dict[str, Any]]] = None):
        super().__init__(message)
        self.message = message
        self.per_step = per_step or []


def _num(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None


def _agg(rows: List[Dict[str, Any]], column: str, agg: str) -> float:
    if agg == "count":
        return float(sum(1 for r in rows if r.get(column) not in (None, "")))
    nums = [n for n in (_num(r.get(column)) for r in rows) if n is not None]
    if not nums:
        return 0.0
    if agg == "sum":
        return sum(nums)
    if agg == "avg":
        return sum(nums) / len(nums)
    if agg == "min":
        return min(nums)
    if agg == "max":
        return max(nums)
    return 0.0


def _resolve_ph(value: Any, identity: CallerIdentity, today: str) -> Any:
    """Resolve {{today}} / {{app_user.username}} placeholders in a static value."""
    if not isinstance(value, str):
        return value
    if value == "{{today}}":
        return today
    if value == "{{app_user.username}}":
        return getattr(identity, "username", None) or "app-user"
    return value


def _find_action(screen: Screen, action_id: str) -> BulkAction:
    for a in (screen.table.bulk_actions if screen.table else []) or []:
        if a.id == action_id:
            return a
    raise HTTPException(status_code=404, detail=f"Bulk action '{action_id}' not found on this screen.")


def _make_code(prefix: str, seq: int, now: datetime) -> str:
    return f"{prefix or 'GOP'}-{now.strftime('%y%m%d-%H%M%S')}{seq:02d}"


def run_bulk_action(
    db: Session,
    workboard: Workboard,
    screen: Screen,
    *,
    action_id: str,
    selected_pks: List[Dict[str, Any]],
    resources: Dict[str, Dict[str, Any]],
    identity: CallerIdentity,
) -> Dict[str, Any]:
    if screen.kind != "table" or screen.table is None:
        raise HTTPException(status_code=400, detail="Bulk actions are only for table screens.")
    action = _find_action(screen, action_id)
    layout = screen_runtime.parse_layout(workboard)

    # 1. Re-fetch the selected rows authoritatively (RLS-scoped) — never trust
    #    client-supplied row values for the data we are about to mutate.
    selected: List[Dict[str, Any]] = []
    for pk in selected_pks or []:
        row = screen_runtime._fetch_current_row(db, workboard, screen, pk)
        if row is not None:
            selected.append(row)
    if len(selected) < max(int(action.min_selection or 1), 1):
        raise HTTPException(status_code=400, detail=f"Chọn tối thiểu {action.min_selection or 1} dòng hợp lệ.")

    # 2. require_same precondition (server-enforced).
    for col in action.require_same or []:
        vals = {str(r.get(col)) for r in selected}
        if len(vals) > 1:
            raise HTTPException(status_code=422, detail=f"Chỉ gộp được các dòng cùng giá trị cột '{col}'.")

    # 3. Numeric constraints (server-enforced), incl. capacity from a picked resource.
    res_by_id = {r.id: r for r in action.resource_inputs}
    for c in action.constraints or []:
        actual = _agg(selected, c.agg_column, c.agg)
        limit = c.limit
        if c.limit_from_resource:
            ri = res_by_id.get(c.limit_from_resource)
            picked = resources.get(c.limit_from_resource) if resources else None
            if not ri or not ri.capacity_column or not picked:
                raise HTTPException(status_code=422, detail=f"Chưa chọn '{ri.label if ri else c.limit_from_resource}' để kiểm tra ràng buộc.")
            limit = _num(picked.get(ri.capacity_column))
        if limit is None:
            raise HTTPException(status_code=422, detail=f"Ràng buộc trên '{c.agg_column}' thiếu giới hạn.")
        ok = {"<=": actual <= limit, "<": actual < limit, ">=": actual >= limit, ">": actual > limit}.get(c.op, True)
        if not ok:
            raise HTTPException(
                status_code=422,
                detail=c.error_message or f"Ràng buộc không thoả: {c.label or c.agg_column} = {actual:g} {c.op} {limit:g}.",
            )

    # 4. Recipe: explicit steps, or synthesise the simple 2-step default.
    steps = list(action.steps or [])
    if not steps:
        steps = _default_recipe(action)

    now = datetime.now(timezone.utc)
    today = now.date().isoformat()
    step_codes: Dict[str, str] = {}
    created: List[Tuple[Screen, Dict[str, Any]]] = []          # (screen, pk) to delete on rollback
    updated: List[Tuple[Screen, Dict[str, Any], Dict[str, Any]]] = []  # (screen, pk, old_values) to restore
    per_step: List[Dict[str, Any]] = []
    seq_counter = 0

    def _target_screen(sid: Optional[str]) -> Screen:
        if not sid:
            return screen
        tgt = screen_runtime.get_screen(layout, sid)
        return tgt

    try:
        for step in steps:
            if step.kind == "create_record":
                seq_counter += 1
                tgt = _target_screen(step.screen_id)
                values: Dict[str, Any] = {k: _resolve_ph(v, identity, today) for k, v in (step.defaults or {}).items()}
                # aggregate selection into the parent
                for col, spec in (step.aggregate_from_selected or {}).items():
                    values[col] = _agg(selected, spec.get("column", ""), spec.get("agg", "sum"))
                # picked-resource fields
                for col, ref in (step.from_resource or {}).items():
                    rid, _, rcol = ref.partition(".")
                    picked = (resources or {}).get(rid) or {}
                    values[col] = picked.get(rcol)
                # link a prior step's generated code
                for col, ref_step in (step.link_columns or {}).items():
                    values[col] = step_codes.get(ref_step)
                # generated code for this record
                code_value = None
                if step.code_column:
                    code_value = _make_code(step.code_prefix or action.code_prefix, seq_counter, now)
                    values[step.code_column] = code_value
                res = screen_runtime.insert_screen_row(db, workboard, tgt, values, identity=identity)
                pk = res.get("pk") if isinstance(res, dict) else None
                if isinstance(pk, dict):
                    created.append((tgt, pk))
                if code_value is not None:
                    step_codes[step.id] = code_value
                per_step.append({"step": step.id, "kind": step.kind, "ok": True, "code": code_value, "pk": pk})

            elif step.kind == "create_lines_from_selected":
                tgt = _target_screen(step.screen_id)
                ordered = list(selected)
                if step.assign_sequence and step.assign_sequence.get("order_by"):
                    ob = step.assign_sequence["order_by"]
                    ordered = sorted(selected, key=lambda r: (str(r.get(ob) or "")))
                n = 0
                for idx, srow in enumerate(ordered, start=1):
                    line: Dict[str, Any] = {k: _resolve_ph(v, identity, today) for k, v in (step.set or {}).items()}
                    for line_col, src_col in (step.copy or {}).items():
                        line[line_col] = srow.get(src_col)
                    for col, ref_step in (step.link_columns or {}).items():
                        line[col] = step_codes.get(ref_step)
                    if step.assign_sequence and step.assign_sequence.get("into_col"):
                        line[step.assign_sequence["into_col"]] = idx
                    res = screen_runtime.insert_screen_row(db, workboard, tgt, line, identity=identity)
                    pk = res.get("pk") if isinstance(res, dict) else None
                    if isinstance(pk, dict):
                        created.append((tgt, pk))
                    n += 1
                per_step.append({"step": step.id, "kind": step.kind, "ok": True, "count": n})

            elif step.kind == "update_selected":
                tgt = _target_screen(step.screen_id)
                patch: Dict[str, Any] = {k: _resolve_ph(v, identity, today) for k, v in (step.set or {}).items()}
                for col, ref_step in (step.link_columns or {}).items():
                    patch[col] = step_codes.get(ref_step)
                pk_cols = tgt.primary_key_columns or screen.primary_key_columns or []
                n = 0
                for srow in selected:
                    pk = {c: srow.get(c) for c in pk_cols}
                    old = {c: srow.get(c) for c in patch.keys()}
                    screen_runtime.update_screen_row(db, workboard, tgt, pk, dict(patch), identity=identity)
                    updated.append((tgt, pk, old))
                    n += 1
                per_step.append({"step": step.id, "kind": step.kind, "ok": True, "count": n})
            else:  # pragma: no cover - schema Literal guards this
                raise BulkActionError(f"Unknown bulk step kind '{step.kind}'.")
    except HTTPException as exc:
        _compensate(db, workboard, created, updated, identity)
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        per_step.append({"ok": False, "error": detail, "rolled_back": True})
        raise BulkActionError(detail, per_step=per_step) from exc
    except Exception as exc:  # noqa: BLE001 - convert to a controlled rollback
        _compensate(db, workboard, created, updated, identity)
        logger.exception("bulk action '%s' failed; compensated", action_id)
        per_step.append({"ok": False, "error": str(exc), "rolled_back": True})
        raise BulkActionError(f"Không hoàn tất thao tác gộp: {exc}", per_step=per_step) from exc

    primary_code = step_codes.get(steps[0].id) if steps else None
    return {
        "ok": True,
        "action_id": action_id,
        "selected": len(selected),
        "primary_code": primary_code,
        "codes": step_codes,
        "created": len(created),
        "updated": len(updated),
        "per_step": per_step,
        "success_message": (action.success_message or "Đã gộp {n} dòng").replace("{n}", str(len(selected))),
    }


def _default_recipe(action: BulkAction) -> List[Any]:
    """Synthesise the simple 2-step recipe from the flat fields so simple bulk
    actions run through the same server executor (create parent + link sources)."""
    from app.modules.workboards.schemas import BulkStep

    return [
        BulkStep(
            id="_parent",
            kind="create_record",
            screen_id=action.parent_screen_id,
            code_column=action.parent_code_column,
            code_prefix=action.code_prefix,
            defaults=dict(action.parent_defaults or {}),
        ),
        BulkStep(
            id="_link",
            kind="update_selected",
            set=dict(action.also_set or {}),
            link_columns={action.set_column: "_parent"},
        ),
    ]


def _compensate(
    db: Session,
    workboard: Workboard,
    created: List[Tuple[Screen, Dict[str, Any]]],
    updated: List[Tuple[Screen, Dict[str, Any], Dict[str, Any]]],
    identity: CallerIdentity,
) -> None:
    """Undo a partially-applied recipe: restore updated rows, delete created rows
    (reverse order). Best-effort — logs but never raises."""
    for tgt, pk, old in reversed(updated):
        try:
            screen_runtime.update_screen_row(db, workboard, tgt, pk, dict(old), identity=identity)
        except Exception:  # noqa: BLE001
            logger.exception("compensation: failed to restore %s pk=%s", tgt.id, pk)
    for tgt, pk in reversed(created):
        try:
            screen_runtime.delete_screen_row(db, workboard, tgt, pk, identity=identity)
        except Exception:  # noqa: BLE001
            logger.exception("compensation: failed to delete %s pk=%s", tgt.id, pk)
