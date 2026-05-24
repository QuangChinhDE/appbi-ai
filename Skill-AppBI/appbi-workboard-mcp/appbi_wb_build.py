"""Bundle-first Workboard design, validation and apply tools."""
from __future__ import annotations

from typing import Any

from appbi_wb_core import Context, _drop_none, _request, _requires_confirmation, tool
from appbi_wb_users import _upsert_app_users
from appbi_wb_workspace import _deliver_workspace


_SCREEN_SPEC_KEYS = {"form", "table", "doc", "dashboard"}
_SCREEN_KINDS = set(_SCREEN_SPEC_KEYS)


def _items(payload: Any, *keys: str) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in keys:
            rows = payload.get(key)
            if isinstance(rows, list):
                return [row for row in rows if isinstance(row, dict)]
    return []


def _columns(table: dict[str, Any]) -> set[str]:
    raw: Any = table.get("columns_cache") or table.get("columns") or []
    if isinstance(raw, dict):
        raw = raw.get("columns") or raw.get("items") or []
    out: set[str] = set()
    for col in raw if isinstance(raw, list) else []:
        if isinstance(col, str) and col:
            out.add(col)
        if isinstance(col, dict) and col.get("name"):
            out.add(str(col["name"]))
    return out


async def _dataset_table_index(dataset_id: int) -> tuple[dict[str, Any], dict[int, dict[str, Any]]]:
    dataset = await _request("GET", f"/datasets/{int(dataset_id)}")
    tables = _items(dataset.get("tables") if isinstance(dataset, dict) else None)
    if not tables:
        tables = _items(
            await _request("GET", f"/datasets/{int(dataset_id)}/tables"),
            "items",
            "tables",
        )
    return dataset if isinstance(dataset, dict) else {}, {
        int(row["id"]): row for row in tables if row.get("id") is not None
    }


def _add_column_issues(
    *,
    refs: list[Any],
    columns: set[str],
    allowed: set[str],
    location: str,
    errors: list[str],
    warnings: list[str],
) -> None:
    names = [str(ref) for ref in refs if isinstance(ref, str) and ref.strip()]
    if not names:
        return
    if not columns:
        warnings.append(f"{location}: dataset columns are not cached; backend audit must verify {names}.")
        return
    unknown = [name for name in names if name not in columns and name not in allowed]
    if unknown:
        errors.append(f"{location}: columns not found on bound table: {unknown}.")


def _placeholder_paths(value: Any, path: str = "bundle") -> list[str]:
    if isinstance(value, dict):
        out: list[str] = []
        for key, child in value.items():
            out.extend(_placeholder_paths(child, f"{path}.{key}"))
        return out
    if isinstance(value, list):
        out = []
        for index, child in enumerate(value):
            out.extend(_placeholder_paths(child, f"{path}[{index}]"))
        return out
    if isinstance(value, str) and ("<<" in value or ">>" in value):
        return [path]
    return []


def _role_refs(value: Any) -> set[str]:
    roles: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {"visible_for_roles", "roles"} and isinstance(child, list):
                roles.update(str(role).strip().lower() for role in child if str(role).strip())
            if key == "role" and isinstance(child, str) and child.strip():
                roles.add(child.strip().lower())
            roles.update(_role_refs(child))
    elif isinstance(value, list):
        for child in value:
            roles.update(_role_refs(child))
    return roles


def _validate_lookup(
    lookup: dict[str, Any],
    *,
    tables: dict[int, dict[str, Any]],
    location: str,
    errors: list[str],
) -> None:
    if lookup.get("kind") != "dataset_table":
        return
    table_id = lookup.get("table_id")
    if not isinstance(table_id, int) or table_id not in tables:
        errors.append(f"{location}: lookup.table_id must be an attached dataset table id.")
        return
    remote = _columns(tables[table_id])
    if remote:
        expected = [lookup.get("value_column"), lookup.get("label_column")]
        missing = [
            str(column) for column in expected
            if isinstance(column, str) and column and column not in remote
        ]
        if missing:
            errors.append(f"{location}: lookup columns not found on table {table_id}: {missing}.")


def _validate_doc_blocks(
    screen: dict[str, Any],
    *,
    columns: set[str],
    tables: dict[int, dict[str, Any]],
    webhook_ids: set[str],
    errors: list[str],
    warnings: list[str],
) -> None:
    screen_id = str(screen.get("id") or "?")
    spec = screen.get("doc") if isinstance(screen.get("doc"), dict) else {}
    for block_index, block in enumerate(spec.get("blocks") or []):
        if not isinstance(block, dict) or block.get("type") != "data_table":
            continue
        location = f"screen '{screen_id}' doc.blocks[{block_index}]"
        block_columns = columns
        source = str(block.get("source") or "primary")
        if source.startswith("lookup:"):
            try:
                lookup_table_id = int(source.split(":", 1)[1])
            except ValueError:
                lookup_table_id = -1
            if lookup_table_id not in tables:
                errors.append(f"{location}: source '{source}' is not an attached dataset table.")
                block_columns = set()
            else:
                block_columns = _columns(tables[lookup_table_id])
        _add_column_issues(
            refs=list(block.get("columns") or []),
            columns=block_columns,
            allowed=set(),
            location=location,
            errors=errors,
            warnings=warnings,
        )
        for trigger in block.get("sync_triggers") or []:
            if not isinstance(trigger, dict):
                errors.append(f"{location}: sync_triggers must contain objects.")
                continue
            missing = [
                str(webhook_id) for webhook_id in trigger.get("webhook_ids") or []
                if str(webhook_id) not in webhook_ids
            ]
            if missing:
                errors.append(
                    f"{location} trigger '{trigger.get('id') or '?'}' references missing webhooks {missing}."
                )


def _validate_screen_columns(
    screen: dict[str, Any],
    *,
    tables: dict[int, dict[str, Any]],
    webhook_ids: set[str],
    errors: list[str],
    warnings: list[str],
) -> None:
    kind = str(screen.get("kind") or "")
    screen_id = str(screen.get("id") or "?")
    table_id = screen.get("table_id")
    if kind == "dashboard":
        return
    if not isinstance(table_id, int) or table_id not in tables:
        errors.append(f"screen '{screen_id}': table_id must point to the selected dataset.")
        return
    columns = _columns(tables[table_id])
    if kind == "form":
        spec = screen.get("form") if isinstance(screen.get("form"), dict) else {}
        for index, field in enumerate(spec.get("fields") or []):
            if not isinstance(field, dict):
                errors.append(f"screen '{screen_id}' form.fields[{index}] must be an object.")
                continue
            _add_column_issues(
                refs=[field.get("column")],
                columns=columns,
                allowed=set(),
                location=f"screen '{screen_id}' form.fields[{index}]",
                errors=errors,
                warnings=warnings,
            )
            if isinstance(field.get("lookup"), dict):
                _validate_lookup(
                    field["lookup"],
                    tables=tables,
                    location=f"screen '{screen_id}' form.fields[{index}]",
                    errors=errors,
                )
        return
    if kind == "doc":
        _validate_doc_blocks(
            screen,
            columns=columns,
            tables=tables,
            webhook_ids=webhook_ids,
            errors=errors,
            warnings=warnings,
        )
        return
    if kind != "table":
        return

    spec = screen.get("table") if isinstance(screen.get("table"), dict) else {}
    derived = {
        str(row.get("name"))
        for key in ("computed_columns", "lookup_columns")
        for row in spec.get(key) or []
        if isinstance(row, dict) and row.get("name")
    }
    refs: list[Any] = list(spec.get("columns") or [])
    refs.extend(spec.get("editable_columns") or [])
    refs.extend(spec.get("required_columns") or [])
    refs.extend(spec.get("group_by") or [])
    if spec.get("default_sort_column"):
        refs.append(spec.get("default_sort_column"))
    refs.extend(
        row.get("column") for row in spec.get("filters") or [] if isinstance(row, dict)
    )
    detail = spec.get("detail_panel")
    if isinstance(detail, dict):
        refs.extend(detail.get("columns") or [])
        refs.extend(detail.get("editable_columns") or [])
    _add_column_issues(
        refs=refs,
        columns=columns,
        allowed=derived,
        location=f"screen '{screen_id}' table",
        errors=errors,
        warnings=warnings,
    )
    for index, lookup in enumerate(spec.get("lookup_columns") or []):
        if not isinstance(lookup, dict):
            errors.append(f"screen '{screen_id}' table.lookup_columns[{index}] must be an object.")
            continue
        foreign_id = lookup.get("from_table_id")
        if not isinstance(foreign_id, int) or foreign_id not in tables:
            errors.append(
                f"screen '{screen_id}' table.lookup_columns[{index}].from_table_id is not attached."
            )
            continue
        remote = _columns(tables[foreign_id])
        _add_column_issues(
            refs=[lookup.get("match_column_local")],
            columns=columns,
            allowed=set(),
            location=f"screen '{screen_id}' lookup local",
            errors=errors,
            warnings=warnings,
        )
        _add_column_issues(
            refs=[lookup.get("match_column_remote"), lookup.get("return_column")],
            columns=remote,
            allowed=set(),
            location=f"screen '{screen_id}' lookup remote table {foreign_id}",
            errors=errors,
            warnings=warnings,
        )


def _webhook_index(
    bundle: dict[str, Any],
    doc_screen_ids: set[str],
    errors: list[str],
) -> set[str]:
    ids: set[str] = set()
    for index, raw in enumerate(bundle.get("webhooks") or []):
        if not isinstance(raw, dict):
            errors.append(f"bundle.webhooks[{index}] must be an object.")
            continue
        webhook_id = str(raw.get("id") or "").strip()
        if not webhook_id:
            errors.append(f"bundle.webhooks[{index}] needs stable id.")
            continue
        if webhook_id in ids:
            errors.append(f"bundle.webhooks has duplicate id '{webhook_id}'.")
        ids.add(webhook_id)
        for field in ("name", "url", "screen_id"):
            if not str(raw.get(field) or "").strip():
                errors.append(f"bundle.webhooks[{index}] needs {field}.")
        if str(raw.get("screen_id") or "") not in doc_screen_ids:
            errors.append(f"webhook '{webhook_id}' must bind to a doc screen_id.")
    return ids


async def _validate_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(bundle, dict):
        return {"ok": False, "errors": ["bundle must be an object."], "warnings": []}

    workboard = bundle.get("workboard")
    if not isinstance(workboard, dict):
        return {"ok": False, "errors": ["bundle.workboard must be an object."], "warnings": []}
    if not str(workboard.get("name") or "").strip():
        errors.append("bundle.workboard.name is required.")
    dataset_id = workboard.get("dataset_id")
    if not isinstance(dataset_id, int) or dataset_id <= 0:
        return {
            "ok": False,
            "errors": errors + ["bundle.workboard.dataset_id must be a positive integer."],
            "warnings": warnings,
        }
    dataset, tables = await _dataset_table_index(dataset_id)
    if not tables:
        errors.append(f"dataset {dataset_id} has no attached tables.")
    primary_table_id = workboard.get("primary_table_id")
    if primary_table_id is not None and primary_table_id not in tables:
        errors.append("bundle.workboard.primary_table_id is not attached to dataset.")

    layout = bundle.get("layout_json")
    if not isinstance(layout, dict):
        return {
            "ok": False,
            "errors": errors + ["bundle.layout_json must be an object."],
            "warnings": warnings,
            "dataset": {"id": dataset.get("id"), "name": dataset.get("name")},
        }
    screens = layout.get("screens")
    if not isinstance(screens, list) or not screens:
        errors.append("bundle.layout_json.screens must contain at least one screen.")
        screens = []

    ids: set[str] = set()
    doc_ids: set[str] = set()
    for index, screen in enumerate(screens):
        if not isinstance(screen, dict):
            errors.append(f"layout_json.screens[{index}] must be an object.")
            continue
        screen_id = str(screen.get("id") or "").strip()
        kind = str(screen.get("kind") or "").strip()
        if not screen_id:
            errors.append(f"layout_json.screens[{index}] needs id.")
        elif screen_id in ids:
            errors.append(f"layout_json.screens has duplicate id '{screen_id}'.")
        ids.add(screen_id)
        if kind not in _SCREEN_KINDS:
            errors.append(
                f"screen '{screen_id or index}' kind '{kind}' is invalid; use form/table/doc/dashboard."
            )
            continue
        if kind == "doc":
            doc_ids.add(screen_id)
        if not isinstance(screen.get(kind), dict):
            errors.append(f"screen '{screen_id or index}' needs `{kind}` spec object.")
        legacy = sorted(key for key in screen.keys() if key in {"list", "grid"})
        if legacy:
            errors.append(f"screen '{screen_id or index}' uses removed specs {legacy}; use `table`.")
        wrong_specs = sorted(key for key in _SCREEN_SPEC_KEYS - {kind} if screen.get(key))
        if wrong_specs:
            warnings.append(f"screen '{screen_id or index}' carries unused specs {wrong_specs}.")

    webhook_ids = _webhook_index(bundle, doc_ids, errors)
    for screen in screens:
        if isinstance(screen, dict):
            _validate_screen_columns(
                screen,
                tables=tables,
                webhook_ids=webhook_ids,
                errors=errors,
                warnings=warnings,
            )

    nav = layout.get("mini_app_nav")
    nav_items = nav.get("items") if isinstance(nav, dict) else []
    if isinstance(nav_items, list):
        missing_nav = [str(item) for item in nav_items if str(item) not in ids]
        if missing_nav:
            errors.append(f"mini_app_nav.items reference missing screen ids {missing_nav}.")
    elif nav_items is not None:
        errors.append("mini_app_nav.items must be a list of screen ids.")

    placeholder_paths = _placeholder_paths(bundle)
    if placeholder_paths:
        errors.append(f"Replace template placeholders before apply: {placeholder_paths[:12]}.")

    user_roles = {
        str(user.get("role") or "").strip().lower()
        for user in bundle.get("app_users") or []
        if isinstance(user, dict) and str(user.get("role") or "").strip()
    }
    referenced_roles = _role_refs(layout) | _role_refs(bundle.get("workspace") or {})
    missing_roles = sorted(role for role in referenced_roles if role not in user_roles)
    if missing_roles:
        warnings.append(
            f"Roles referenced by screens/workspace without matching bundle.app_users: {missing_roles}."
        )
    for index, user in enumerate(bundle.get("app_users") or []):
        if not isinstance(user, dict) or not str(user.get("username") or "").strip():
            errors.append(f"bundle.app_users[{index}] needs username.")
        elif not str(user.get("pin") or "").strip():
            warnings.append(
                f"bundle.app_users[{index}] omits pin; this only works when username already exists."
            )

    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "dataset": {
            "id": dataset.get("id") or dataset_id,
            "name": dataset.get("name"),
            "table_ids": sorted(tables),
        },
        "summary": {
            "screen_count": len(screens),
            "screen_kinds": [screen.get("kind") for screen in screens if isinstance(screen, dict)],
            "app_user_count": len(bundle.get("app_users") or []),
            "webhook_count": len(bundle.get("webhooks") or []),
            "workspace_requested": isinstance(bundle.get("workspace"), dict),
        },
        "backend_gate": (
            "apply_workboard_bundle still passes layout through backend Pydantic schemas and audit."
        ),
    }


def _workboard_create_body(bundle: dict[str, Any]) -> dict[str, Any]:
    wb = bundle["workboard"]
    return _drop_none(
        {
            "name": wb.get("name"),
            "slug": wb.get("slug"),
            "description": wb.get("description"),
            "icon": wb.get("icon"),
            "dataset_id": wb.get("dataset_id"),
            "primary_table_id": wb.get("primary_table_id"),
            "primary_key_columns": wb.get("primary_key_columns"),
            "optimistic_lock_column": wb.get("optimistic_lock_column"),
            "layout_json": bundle.get("layout_json"),
        }
    )


def _workboard_update_body(bundle: dict[str, Any]) -> dict[str, Any]:
    wb = bundle["workboard"]
    return _drop_none(
        {
            "name": wb.get("name"),
            "slug": wb.get("slug"),
            "description": wb.get("description"),
            "icon": wb.get("icon"),
            "dataset_id": wb.get("dataset_id"),
            "primary_table_id": wb.get("primary_table_id"),
            "optimistic_lock_column": wb.get("optimistic_lock_column"),
            "layout_json": bundle.get("layout_json"),
        }
    )


async def _merge_settings(
    workboard: dict[str, Any],
    bundle: dict[str, Any],
) -> dict[str, Any] | None:
    has_settings = isinstance(bundle["workboard"].get("settings"), dict)
    has_webhooks = "webhooks" in bundle
    if not has_settings and not has_webhooks:
        return None
    settings = dict(workboard.get("settings") or {})
    if has_settings:
        settings.update(bundle["workboard"]["settings"])
    if has_webhooks:
        settings["webhooks"] = bundle.get("webhooks") or []
    updated = await _request(
        "PATCH",
        f"/workboards/{int(workboard['id'])}",
        json_body={"settings": settings},
    )
    return updated if isinstance(updated, dict) else workboard


def _bundle_preview(bundle: dict[str, Any], workboard_id: int | None) -> dict[str, Any]:
    wb = bundle["workboard"]
    screens = bundle.get("layout_json", {}).get("screens") or []
    return {
        "operation": "update" if workboard_id is not None else "create",
        "workboard_id": workboard_id,
        "workboard": {
            "name": wb.get("name"),
            "slug": wb.get("slug"),
            "dataset_id": wb.get("dataset_id"),
            "primary_table_id": wb.get("primary_table_id"),
            "publish": bool(wb.get("publish")),
        },
        "screens": [
            {"id": row.get("id"), "kind": row.get("kind"), "title": row.get("title")}
            for row in screens if isinstance(row, dict)
        ],
        "app_users_to_upsert": [
            {"username": row.get("username"), "role": row.get("role"), "active": row.get("active", True)}
            for row in bundle.get("app_users") or [] if isinstance(row, dict)
        ],
        "webhook_ids_to_store": [
            row.get("id") for row in bundle.get("webhooks") or [] if isinstance(row, dict)
        ],
        "workspace": bundle.get("workspace"),
    }


@tool("design")
async def get_workboard_design_guide(ctx: Context | None = None) -> dict[str, Any]:
    """Return the compact bundle contract and demo-oriented screen patterns."""
    return {
        "workflow": [
            "inspect_dataset_for_workboard(dataset_id) and use dataset table ids/columns",
            "author one bundle with layout_json, app_users, webhooks and optional workspace",
            "validate_workboard_bundle(bundle)",
            "apply_workboard_bundle(bundle) once after user confirmation",
            "audit_workboard and run_workboard_runtime_smoke_test",
        ],
        "bundle_contract": {
            "workboard": {
                "name": "Required",
                "slug": "Recommended for workspace delivery",
                "dataset_id": "Required existing AppBI dataset id",
                "primary_table_id": "Recommended anchor table id from dataset",
                "primary_key_columns": "Create-time hint such as ['id']",
                "optimistic_lock_column": "Optional update lock column",
                "publish": "true when demo/runtime should be visible",
                "settings": "Optional non-webhook Workboard settings merge",
            },
            "layout_json": "Backend LayoutJson: screens, mini_app_nav, branding, audit, auto_number_columns",
            "app_users": "Optional upsert list. New users need username+pin. Include role/context/active.",
            "webhooks": "Optional full webhook set with stable ids for doc sync triggers.",
            "workspace": "Optional create or update config with id/workspace_id or name+slug and menu_item.",
        },
        "screen_rules": [
            "Use current kinds only: form, table, doc, dashboard.",
            "A non-dashboard screen binds table_id to an attached dataset table.",
            "Table screens combine readonly and editable behavior via editable_columns.",
            "Doc data_table sync_triggers reference top-level webhook ids and webhooks bind screen_id to that doc.",
            "For a demo excluding Dashboard, cover form entry, transaction table, doc/report sync, and master tables.",
            "Use owner/admin/user roles plus an inactive user when app-user behavior must be demoed.",
        ],
        "starter_bundle": {
            "workboard": {
                "name": "Inventory Demo",
                "slug": "inventory-demo",
                "dataset_id": 47,
                "primary_table_id": 101,
                "primary_key_columns": ["id"],
                "publish": True,
            },
            "layout_json": {
                "branding": {"app_name": "Inventory Demo", "theme": "light"},
                "mini_app_nav": {
                    "desktop_kind": "sidebar",
                    "mobile_kind": "bottom_nav",
                    "items": ["entry", "rows", "report"],
                },
                "screens": [
                    {
                        "id": "entry",
                        "kind": "form",
                        "title": "New transaction",
                        "table_id": 101,
                        "primary_key_columns": ["id"],
                        "visible_for_roles": ["owner", "admin", "user"],
                        "form": {
                            "fields": [
                                {"column": "date", "widget": "date", "required": True},
                                {"column": "product_id", "widget": "lookup", "lookup": {
                                    "kind": "dataset_table", "table_id": 102,
                                    "value_column": "id", "label_column": "name",
                                }},
                                {"column": "qty", "widget": "number", "required": True},
                            ],
                            "after_submit": {
                                "id": "open-rows", "label": "Open rows",
                                "go_to_screen": "rows", "carry": ["id"],
                            },
                        },
                    },
                    {
                        "id": "rows",
                        "kind": "table",
                        "title": "Transactions",
                        "table_id": 101,
                        "primary_key_columns": ["id"],
                        "visible_for_roles": ["owner", "admin", "user"],
                        "table": {
                            "columns": ["date", "product_id", "qty", "amount"],
                            "editable_columns": ["qty"],
                            "filters": [{"column": "date", "kind": "date_range"}],
                            "computed_columns": [{
                                "name": "amount", "label": "Amount",
                                "formula": "return Number(row.qty || 0) * Number(row.unit_price || 0);",
                            }],
                        },
                    },
                    {
                        "id": "report",
                        "kind": "doc",
                        "title": "Sync report",
                        "table_id": 101,
                        "visible_for_roles": ["owner", "admin"],
                        "doc": {"blocks": [{
                            "type": "data_table",
                            "columns": ["date", "product_id", "qty"],
                            "allow_export_excel": True,
                            "sync_triggers": [{
                                "id": "send-report", "label": "Send",
                                "webhook_ids": ["demo-hook"],
                                "visible_for_roles": ["owner", "admin"],
                            }],
                        }]},
                    },
                ],
            },
            "app_users": [
                {"username": "demo_owner", "pin": "123456", "role": "owner", "active": True},
                {"username": "demo_admin", "pin": "123456", "role": "admin", "active": True},
                {"username": "demo_user", "pin": "123456", "role": "user", "active": True},
                {"username": "demo_disabled", "pin": "123456", "role": "user", "active": False},
            ],
            "webhooks": [{
                "id": "demo-hook", "name": "Demo receiver",
                "url": "https://httpbin.org/post",
                "screen_id": "report", "is_active": True,
            }],
            "workspace": {
                "name": "Inventory demo workspace",
                "slug": "inventory-demo-workspace",
                "access_mode": "public_app_users",
                "menu_item": {"label": "Inventory Demo"},
            },
        },
    }


@tool("design")
async def validate_workboard_bundle(
    bundle: dict[str, Any],
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Validate Workboard references before a one-confirm bundle apply."""
    return await _validate_bundle(bundle)


@tool({"design", "delivery"})
async def apply_workboard_bundle(
    bundle: dict[str, Any],
    workboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create/update a Workboard plus users, webhooks and optional workspace.

    This is the main mutation path. It validates first, shows one preview
    until confirmed, then lets backend schemas and `audit` perform the final
    gate after persistence.
    """
    validation = await _validate_bundle(bundle)
    if not validation["ok"]:
        return {"status": "invalid_bundle", "validation": validation}
    if not user_confirmed:
        return _requires_confirmation(
            "apply_workboard_bundle",
            {"validated": validation["summary"], "apply": _bundle_preview(bundle, workboard_id)},
        )

    if workboard_id is None:
        workboard = await _request("POST", "/workboards/", json_body=_workboard_create_body(bundle))
        operation = "created"
    else:
        workboard = await _request(
            "PATCH",
            f"/workboards/{int(workboard_id)}",
            json_body=_workboard_update_body(bundle),
        )
        operation = "updated"
    if not isinstance(workboard, dict):
        raise RuntimeError("Workboard API returned a non-object response.")

    with_settings = await _merge_settings(workboard, bundle)
    if with_settings is not None:
        workboard = with_settings
    if bool(bundle["workboard"].get("publish")):
        workboard = await _request("POST", f"/workboards/{int(workboard['id'])}/publish")

    user_result = None
    if bundle.get("app_users"):
        user_result = await _upsert_app_users(int(workboard["id"]), bundle["app_users"])

    workspace_result = None
    if isinstance(bundle.get("workspace"), dict):
        workspace_result = await _deliver_workspace(workboard, bundle["workspace"])

    audit = await _request("GET", f"/workboards/{int(workboard['id'])}/audit")
    return {
        "status": operation,
        "workboard": workboard,
        "app_users": user_result,
        "workspace": workspace_result,
        "audit": audit,
        "validation_warnings": validation["warnings"],
    }


__all__: list[str] = []
