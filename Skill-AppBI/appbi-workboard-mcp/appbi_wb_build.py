"""Stage 3 and 4 - Workboard blueprint design, create, and update."""
from __future__ import annotations

import copy
import json
from typing import Any, Dict, List, Optional

from appbi_wb_core import _request, _requires_confirmation, mcp


_BLUEPRINT_TEMPLATE = {
    "workboard": {
        "name": "<<workboard_name>>",
        "slug": "<<kebab-case-unique>>",
        "description": "<<short_description>>",
        "icon": "Factory",
        "dataset_id": "<<dataset_id>>",
        "primary_table_id": "<<primary_dataset_table_id>>",
        "primary_key_columns": ["id"],
        "optimistic_lock_column": None,
    },
    "layout_json": {
        "version": 1,
        "audit": {
            "updated_at_column": None,
        },
        "screens": [
            {
                "id": "entry-form",
                "kind": "form",
                "title": "<<form_title>>",
                "icon": "ClipboardList",
                "description": None,
                "table_id": "<<dataset_table_id>>",
                "primary_key_columns": ["id"],
                "visible_for_roles": ["<<role_name>>"],
                "show_in_nav": True,
                "rls": [
                    {
                        "role": "<<role_name>>",
                        "unrestricted": False,
                        "filter_column": "<<owner_column>>",
                        "filter_value": "{{app_user.username}}",
                        "can_create": True,
                        "can_update": True,
                        "can_delete": False,
                        "writable_columns": None,
                        "readonly_columns": None,
                    }
                ],
                "rls_default": None,
                "form": {
                    "fields": [
                        {
                            "column": "<<db_column_name>>",
                            "widget": "text",
                            "label": "<<field_label>>",
                            "required": True,
                            "readonly": False,
                            "default": None,
                            "help_text": None,
                            "placeholder": None,
                            "lookup": None,
                            "section": None,
                            "page": None,
                            "show_if": None,
                            "required_if": None,
                            "readonly_if": None,
                            "computed_from_dataset": None,
                        }
                    ],
                    "submit_label": "Save",
                    "after_submit": None,
                    "initial_values": {},
                    "pages": [],
                    "sections": [],
                },
                "list": None,
                "doc": None,
            },
            {
                "id": "list-view",
                "kind": "list",
                "title": "<<list_title>>",
                "icon": "Table",
                "description": None,
                "table_id": "<<dataset_table_id>>",
                "primary_key_columns": ["id"],
                "visible_for_roles": [],
                "show_in_nav": True,
                "rls": [],
                "rls_default": None,
                "form": None,
                "list": {
                    "columns": ["<<col1>>", "<<col2>>"],
                    "filters": [],
                    "page_size": 50,
                    "default_sort_column": None,
                    "default_sort_direction": "desc",
                    "row_actions": [
                        {
                            "id": "edit",
                            "label": "Edit",
                            "icon": "Pencil",
                            "style": "secondary",
                            "go_to_screen": "entry-form",
                            "carry": ["id"],
                            "confirm_message": None,
                            "visible_for_roles": [],
                        }
                    ],
                    "empty_state_message": None,
                },
                "doc": None,
            },
        ],
        "mini_app_nav": {
            "mobile_kind": "bottom_nav",
            "desktop_kind": "sidebar",
            "items": ["entry-form", "list-view"],
        },
    },
    "app_users_template": [
        {"username": "user01", "pin": "1234", "full_name": "<<full_name>>", "role": "<<role_name>>"}
    ],
    "open_questions_for_user": [
        "Which roles should exist in the mini-app?",
        "Which fields need dropdown/lookup behavior?",
        "Which columns should be visible in the main list screen?",
    ],
}


def _copy_template() -> Dict[str, Any]:
    return copy.deepcopy(_BLUEPRINT_TEMPLATE)


def _humanize_table_name(name: str) -> str:
    raw = str(name or "").strip().split(".")[-1]
    words = [part for part in raw.replace("-", " ").replace("_", " ").split() if part]
    if not words:
        return raw or "Primary Table"
    return " ".join(word[:1].upper() + word[1:] for word in words)


def _parse_table_profiles(table_profiles: Optional[str]) -> Any:
    if not table_profiles:
        return None
    try:
        return json.loads(table_profiles)
    except Exception:
        return table_profiles


def _table_columns(table: Dict[str, Any]) -> List[str]:
    cache = table.get("columns_cache")
    raw_columns: Any = cache
    if isinstance(cache, dict):
        raw_columns = cache.get("columns") or cache.get("items") or []
    cols: List[str] = []
    if isinstance(raw_columns, list):
        for entry in raw_columns:
            if isinstance(entry, dict) and entry.get("name"):
                cols.append(str(entry["name"]))
            elif isinstance(entry, str):
                cols.append(entry)
    return cols


def _table_map(dataset_tables: List[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
    out: Dict[int, Dict[str, Any]] = {}
    for table in dataset_tables:
        try:
            out[int(table["id"])] = table
        except Exception:
            continue
    return out


def _find_first_table_id(screens: List[Dict[str, Any]]) -> Optional[int]:
    for screen in screens:
        table_id = screen.get("table_id")
        if isinstance(table_id, int):
            return table_id
        if isinstance(table_id, str) and table_id.isdigit():
            return int(table_id)
    return None


def _collect_screen_roles(layout: Dict[str, Any]) -> List[str]:
    roles: set[str] = set()
    for screen in layout.get("screens") or []:
        for role in screen.get("visible_for_roles") or []:
            if role:
                roles.add(str(role))
        for rule in screen.get("rls") or []:
            if isinstance(rule, dict) and rule.get("role"):
                roles.add(str(rule["role"]))
    return sorted(roles)


def _normalize_lookup_config(lookup: Any, path: str, warnings: List[str], errors: List[str]) -> Any:
    if lookup is None:
        return None
    if not isinstance(lookup, dict):
        errors.append(f"{path}.lookup must be an object")
        return lookup

    normalized = copy.deepcopy(lookup)
    if "mode" in normalized and "kind" not in normalized:
        normalized["kind"] = normalized.pop("mode")
        warnings.append(f"{path}.lookup.mode was normalized to lookup.kind.")
    if "options" in normalized and "values" not in normalized:
        normalized["values"] = normalized.pop("options")
        warnings.append(f"{path}.lookup.options was normalized to lookup.values.")

    allowed_keys = {
        "kind",
        "values",
        "table_id",
        "value_column",
        "label_column",
        "relationship_path",
    }
    extra_keys = sorted(set(normalized.keys()) - allowed_keys)
    if extra_keys:
        errors.append(f"{path}.lookup has unsupported keys: {extra_keys}")

    kind = str(normalized.get("kind") or "static").strip()
    if kind not in ("static", "dataset_table"):
        errors.append(f"{path}.lookup.kind must be 'static' or 'dataset_table'")
    else:
        normalized["kind"] = kind

    if kind == "static":
        values = normalized.get("values")
        if values is not None and not isinstance(values, list):
            errors.append(f"{path}.lookup.values must be a list when lookup.kind='static'")
    if kind == "dataset_table":
        for key in ("table_id", "value_column"):
            if not normalized.get(key):
                errors.append(f"{path}.lookup.{key} is required when lookup.kind='dataset_table'")

    return normalized


def _remove_system_columns_from_form(
    form_spec: Dict[str, Any],
    *,
    system_columns: set[str],
    warnings: List[str],
    path: str,
) -> None:
    fields = form_spec.get("fields")
    if not isinstance(fields, list) or not system_columns:
        return
    kept: List[Any] = []
    removed: List[str] = []
    for field in fields:
        col = str(field.get("column") or "").strip() if isinstance(field, dict) else ""
        if col and col in system_columns:
            removed.append(col)
            continue
        kept.append(field)
    if removed:
        form_spec["fields"] = kept
        warnings.append(
            f"{path}.fields removed system column(s) from user-editable form: {sorted(set(removed))}."
        )


def _remove_system_columns_from_rls(
    screen: Dict[str, Any],
    *,
    system_columns: set[str],
    warnings: List[str],
    path: str,
) -> None:
    if not system_columns:
        return
    for rule_index, rule in enumerate(screen.get("rls") or []):
        if not isinstance(rule, dict):
            continue
        writable = rule.get("writable_columns")
        if not isinstance(writable, list):
            continue
        filtered = [col for col in writable if str(col) not in system_columns]
        if len(filtered) != len(writable):
            rule["writable_columns"] = filtered
            warnings.append(
                f"{path}.rls[{rule_index}].writable_columns removed system column(s): {sorted(system_columns)}."
            )


async def _load_datasource_details(dataset_tables: List[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
    datasource_ids = sorted(
        {
            int(table["datasource_id"])
            for table in dataset_tables
            if isinstance(table, dict) and table.get("datasource_id") is not None
        }
    )
    datasource_map: Dict[int, Dict[str, Any]] = {}
    for datasource_id in datasource_ids:
        datasource_map[datasource_id] = await _request("GET", f"/datasources/{datasource_id}")
    return datasource_map


def _datasource_type_for_table(
    table: Optional[Dict[str, Any]],
    datasource_map: Dict[int, Dict[str, Any]],
) -> str:
    if not table or table.get("datasource_id") is None:
        return ""
    datasource = datasource_map.get(int(table["datasource_id"])) or {}
    return str(datasource.get("type") or "").strip().lower()


def _blueprint_from_existing_workboard(
    current_workboard: Dict[str, Any],
    blueprint_json: Dict[str, Any],
) -> Dict[str, Any]:
    merged = {
        "workboard": {
            "name": current_workboard.get("name"),
            "slug": current_workboard.get("slug"),
            "description": current_workboard.get("description"),
            "icon": current_workboard.get("icon"),
            "dataset_id": current_workboard.get("dataset_id"),
            "primary_table_id": current_workboard.get("primary_table_id"),
            "primary_key_columns": current_workboard.get("primary_key_columns") or [],
            "optimistic_lock_column": current_workboard.get("optimistic_lock_column"),
        },
        "layout_json": copy.deepcopy(current_workboard.get("layout_json") or {}),
    }
    wb_patch = blueprint_json.get("workboard") or {}
    if isinstance(wb_patch, dict):
        merged["workboard"].update(wb_patch)
    if "layout_json" in blueprint_json:
        merged["layout_json"] = copy.deepcopy(blueprint_json.get("layout_json") or {})
    for key in ("app_users_template", "open_questions_for_user"):
        if key in blueprint_json:
            merged[key] = copy.deepcopy(blueprint_json[key])
    return merged


async def _normalize_and_validate_blueprint(blueprint_json: Dict[str, Any]) -> Dict[str, Any]:
    errors: List[str] = []
    warnings: List[str] = []

    blueprint = copy.deepcopy(blueprint_json or {})
    wb_spec = blueprint.setdefault("workboard", {})
    layout = blueprint.setdefault("layout_json", {})
    screens = layout.get("screens") or []

    required_wb = ["name", "slug", "dataset_id"]
    for field in required_wb:
        if not wb_spec.get(field):
            errors.append(f"workboard.{field} is required")

    dataset_id_raw = wb_spec.get("dataset_id")
    dataset_id: Optional[int] = None
    if dataset_id_raw is not None:
        try:
            dataset_id = int(dataset_id_raw)
            wb_spec["dataset_id"] = dataset_id
        except Exception:
            errors.append("workboard.dataset_id must be an integer")

    dataset_tables: List[Dict[str, Any]] = []
    datasource_map: Dict[int, Dict[str, Any]] = {}
    table_by_id: Dict[int, Dict[str, Any]] = {}
    if dataset_id is not None:
        dataset_tables = await _request("GET", f"/datasets/{dataset_id}/tables")
        table_by_id = _table_map(dataset_tables)
        datasource_map = await _load_datasource_details(dataset_tables)

    if not screens:
        errors.append("layout_json.screens must have at least one screen")

    default_table_id = _find_first_table_id(screens)
    if not wb_spec.get("primary_table_id"):
        if default_table_id is not None:
            wb_spec["primary_table_id"] = default_table_id
            warnings.append(f"workboard.primary_table_id defaulted to {default_table_id} from the first screen.")
        elif dataset_tables:
            wb_spec["primary_table_id"] = int(dataset_tables[0]["id"])
            warnings.append(
                f"workboard.primary_table_id defaulted to dataset table {dataset_tables[0]['id']}."
            )
    if wb_spec.get("primary_table_id") is not None:
        try:
            wb_spec["primary_table_id"] = int(wb_spec["primary_table_id"])
        except Exception:
            errors.append("workboard.primary_table_id must be an integer")

    default_pk = [str(item).strip() for item in (wb_spec.get("primary_key_columns") or []) if str(item).strip()]
    if not default_pk:
        primary_table = table_by_id.get(int(wb_spec["primary_table_id"])) if wb_spec.get("primary_table_id") else None
        primary_columns = _table_columns(primary_table or {})
        if "id" in primary_columns:
            default_pk = ["id"]
            wb_spec["primary_key_columns"] = default_pk
            warnings.append("workboard.primary_key_columns defaulted to ['id'].")

    screen_ids: set[str] = set()
    for index, screen in enumerate(screens):
        screen_id = str(screen.get("id") or "").strip()
        if not screen_id:
            errors.append(f"screens[{index}] missing id")
        elif screen_id in screen_ids:
            errors.append(f"Duplicate screen id: {screen_id}")
        else:
            screen_ids.add(screen_id)

        kind = str(screen.get("kind") or "").strip()
        if kind not in ("form", "list", "doc", "dashboard"):
            errors.append(f"screens[{index}] invalid kind: {kind!r}")

        if kind in ("form", "list") and screen.get("table_id") is None:
            errors.append(f"screens[{index}] kind={kind} but table_id is missing")
        if kind == "form" and not screen.get("form"):
            errors.append(f"screens[{index}] kind=form but no form spec")
        if kind == "list" and not screen.get("list"):
            errors.append(f"screens[{index}] kind=list but no list spec")

        table_id = screen.get("table_id")
        if isinstance(table_id, str) and table_id.isdigit():
            table_id = int(table_id)
            screen["table_id"] = table_id
        if kind in ("form", "list") and isinstance(table_id, int) and table_by_id and table_id not in table_by_id:
            errors.append(f"screens[{index}].table_id={table_id} is not attached to dataset {dataset_id}")

        pk_columns = [str(item).strip() for item in (screen.get("primary_key_columns") or []) if str(item).strip()]
        if not pk_columns and default_pk:
            screen["primary_key_columns"] = list(default_pk)
            warnings.append(f"screens[{index}].primary_key_columns defaulted to {default_pk}.")

        list_spec = screen.get("list") or {}
        for action_index, action in enumerate(list_spec.get("row_actions") or []):
            if isinstance(action, str):
                errors.append(
                    f"screens[{index}].list.row_actions[{action_index}] is a string - use ScreenAction objects."
                )
                continue
            target = action.get("go_to_screen") if isinstance(action, dict) else None
            if target and target not in screen_ids and target not in [s.get("id") for s in screens]:
                errors.append(
                    f"screens[{index}].list.row_actions[{action_index}].go_to_screen='{target}' does not match any screen id"
                )

        form_spec = screen.get("form") or {}
        for field_index, field in enumerate(form_spec.get("fields") or []):
            if isinstance(field, dict) and field.get("lookup") is not None:
                field["lookup"] = _normalize_lookup_config(
                    field.get("lookup"),
                    f"screens[{index}].form.fields[{field_index}]",
                    warnings,
                    errors,
                )

        after_submit = form_spec.get("after_submit")
        if isinstance(after_submit, dict):
            if after_submit.get("go_to_screen") and not after_submit.get("id"):
                after_submit["id"] = "after-submit"
                warnings.append(
                    f"screens[{index}].form.after_submit.id defaulted to 'after-submit'."
                )
            if after_submit.get("go_to_screen") and not after_submit.get("label"):
                after_submit["label"] = "Continue"
                warnings.append(
                    f"screens[{index}].form.after_submit.label defaulted to 'Continue'."
                )
            target = after_submit.get("go_to_screen")
            if target and target not in [s.get("id") for s in screens]:
                errors.append(
                    f"screens[{index}].form.after_submit.go_to_screen='{target}' does not match any screen id"
                )

    nav = layout.setdefault("mini_app_nav", {})
    if "default" in nav:
        errors.append("mini_app_nav must not include a 'default' key")
    nav_items = nav.get("items") or []
    if not nav_items:
        nav["items"] = [
            str(screen.get("id"))
            for screen in screens
            if screen.get("show_in_nav", True) and screen.get("id")
        ]
        warnings.append("mini_app_nav.items was empty and was defaulted from show_in_nav screens.")
        nav_items = nav["items"]
    for item in nav_items:
        if item not in {str(screen.get("id")) for screen in screens if screen.get("id")}:
            errors.append(f"mini_app_nav.items contains '{item}' which is not a screen id")

    blueprint_str = json.dumps(blueprint, ensure_ascii=True)
    if "<<" in blueprint_str or ">>" in blueprint_str:
        errors.append("blueprint_json still contains <<...>> placeholders")

    primary_table = table_by_id.get(int(wb_spec["primary_table_id"])) if wb_spec.get("primary_table_id") else None
    primary_table_columns = _table_columns(primary_table or {})
    primary_source_type = _datasource_type_for_table(primary_table, datasource_map)
    if primary_source_type == "google_sheets":
        lock_column = str(wb_spec.get("optimistic_lock_column") or "").strip()
        if not lock_column:
            if "updated_at" in primary_table_columns:
                lock_column = "updated_at"
                wb_spec["optimistic_lock_column"] = lock_column
                warnings.append(
                    "workboard.optimistic_lock_column defaulted to 'updated_at' for Google Sheets."
                )
            else:
                errors.append(
                    "Google Sheets-backed workboards require workboard.optimistic_lock_column, and the primary table needs that column."
                )
        if lock_column and primary_table_columns and lock_column not in primary_table_columns:
            errors.append(
                f"Google Sheets primary table does not contain optimistic_lock_column '{lock_column}'."
            )

        audit_cfg = layout.setdefault("audit", {})
        audit_updated_at = str(audit_cfg.get("updated_at_column") or "").strip()
        if lock_column and audit_updated_at != lock_column:
            audit_cfg["updated_at_column"] = lock_column
            warnings.append(
                f"layout_json.audit.updated_at_column was normalized to '{lock_column}' to match optimistic locking."
            )
        if "id" in primary_table_columns and "id" not in (wb_spec.get("primary_key_columns") or []):
            wb_spec["primary_key_columns"] = ["id"]
            warnings.append("workboard.primary_key_columns normalized to ['id'] for Google Sheets.")

        system_columns = {
            col
            for col in [*(wb_spec.get("primary_key_columns") or []), lock_column]
            if str(col).strip()
        }
        for index, screen in enumerate(screens):
            if screen.get("table_id") != wb_spec.get("primary_table_id"):
                continue
            if isinstance(screen.get("form"), dict):
                _remove_system_columns_from_form(
                    screen["form"],
                    system_columns=system_columns,
                    warnings=warnings,
                    path=f"screens[{index}].form",
                )
            _remove_system_columns_from_rls(
                screen,
                system_columns=system_columns,
                warnings=warnings,
                path=f"screens[{index}]",
            )

    template_roles = {
        str(user.get("role")).strip()
        for user in (blueprint.get("app_users_template") or [])
        if isinstance(user, dict) and user.get("role")
    }
    screen_roles = set(_collect_screen_roles(layout))
    if template_roles and screen_roles and not screen_roles.issubset(template_roles):
        warnings.append(
            "Some screen/RLS roles are not present in app_users_template. Ensure app users are created with matching role strings."
        )

    return {
        "errors": errors,
        "warnings": warnings,
        "normalized_blueprint": blueprint,
        "dataset_tables": dataset_tables,
        "datasource_map": datasource_map,
        "primary_source_type": primary_source_type,
    }


def _build_create_body(normalized_blueprint: Dict[str, Any]) -> Dict[str, Any]:
    wb_spec = normalized_blueprint["workboard"]
    create_body: Dict[str, Any] = {
        "name": wb_spec["name"],
        "slug": wb_spec["slug"],
        "description": wb_spec.get("description"),
        "icon": wb_spec.get("icon", "LayoutDashboard"),
        "dataset_id": int(wb_spec["dataset_id"]),
        "layout_json": normalized_blueprint["layout_json"],
    }
    if wb_spec.get("primary_table_id") is not None:
        create_body["primary_table_id"] = int(wb_spec["primary_table_id"])
    if wb_spec.get("primary_key_columns"):
        create_body["primary_key_columns"] = wb_spec["primary_key_columns"]
    if wb_spec.get("optimistic_lock_column"):
        create_body["optimistic_lock_column"] = wb_spec["optimistic_lock_column"]
    return create_body


def _build_update_body(normalized_blueprint: Dict[str, Any]) -> Dict[str, Any]:
    wb_spec = normalized_blueprint["workboard"]
    update_body: Dict[str, Any] = {
        "name": wb_spec["name"],
        "slug": wb_spec["slug"],
        "description": wb_spec.get("description"),
        "icon": wb_spec.get("icon", "LayoutDashboard"),
        "dataset_id": int(wb_spec["dataset_id"]),
        "layout_json": normalized_blueprint["layout_json"],
    }
    if wb_spec.get("primary_table_id") is not None:
        update_body["primary_table_id"] = int(wb_spec["primary_table_id"])
    if wb_spec.get("optimistic_lock_column") is not None:
        update_body["optimistic_lock_column"] = wb_spec.get("optimistic_lock_column")
    return update_body


@mcp.tool()
async def propose_workboard_blueprint(
    dataset_id: int,
    business_intent: str,
    table_profiles: Optional[str] = None,
    extra_context: Optional[str] = None,
) -> Any:
    """Return a blueprint template plus dataset metadata for Claude to fill."""
    dataset = await _request("GET", f"/datasets/{dataset_id}")
    tables = await _request("GET", f"/datasets/{dataset_id}/tables")
    datasource_map = await _load_datasource_details(tables)
    parsed_profiles = _parse_table_profiles(table_profiles)

    template = _copy_template()
    template["workboard"]["dataset_id"] = dataset_id
    if tables:
        primary_table = tables[0]
        primary_table_id = int(primary_table["id"])
        template["workboard"]["primary_table_id"] = primary_table_id
        for screen in template["layout_json"]["screens"]:
            screen["table_id"] = primary_table_id

        primary_columns = _table_columns(primary_table)
        if "id" in primary_columns:
            template["workboard"]["primary_key_columns"] = ["id"]
        if _datasource_type_for_table(primary_table, datasource_map) == "google_sheets":
            template["workboard"]["optimistic_lock_column"] = "updated_at"
            template["layout_json"]["audit"]["updated_at_column"] = "updated_at"

    table_summaries = []
    for table in tables:
        datasource_type = _datasource_type_for_table(table, datasource_map)
        table_summaries.append(
            {
                "id": table.get("id"),
                "display_name": table.get("display_name") or _humanize_table_name(table.get("source_table_name") or ""),
                "source_table_name": table.get("source_table_name"),
                "datasource_id": table.get("datasource_id"),
                "datasource_type": datasource_type,
                "column_names": _table_columns(table),
            }
        )

    return {
        "dataset": dataset,
        "dataset_tables": tables,
        "table_summaries": table_summaries,
        "datasources": datasource_map,
        "business_intent": business_intent,
        "extra_context": extra_context,
        "table_profiles": parsed_profiles,
        "blueprint_template": template,
        "next_step": (
            "Fill in the blueprint_template with real titles, roles, columns, and any additional screens. "
            "Then call commit_workboard_blueprint with user_confirmed=False to preview."
        ),
    }


@mcp.tool()
async def commit_workboard_blueprint(
    blueprint_json: Dict[str, Any],
    user_confirmed: bool = False,
) -> Any:
    """Validate, create, and publish a workboard from blueprint_json."""
    result = await _normalize_and_validate_blueprint(blueprint_json)
    if result["errors"]:
        return {
            "ok": False,
            "validation_errors": result["errors"],
            "warnings": result["warnings"],
            "message": "Fix the validation errors before committing the workboard blueprint.",
        }

    normalized = result["normalized_blueprint"]
    wb_spec = normalized["workboard"]
    layout = normalized["layout_json"]
    screens = layout.get("screens") or []

    plan = {
        "action": "create_workboard",
        "workboard_name": wb_spec.get("name"),
        "workboard_slug": wb_spec.get("slug"),
        "dataset_id": wb_spec.get("dataset_id"),
        "primary_table_id": wb_spec.get("primary_table_id"),
        "primary_key_columns": wb_spec.get("primary_key_columns"),
        "optimistic_lock_column": wb_spec.get("optimistic_lock_column"),
        "screen_count": len(screens),
        "screens_summary": [
            {
                "id": screen.get("id"),
                "kind": screen.get("kind"),
                "title": screen.get("title"),
                "table_id": screen.get("table_id"),
                "visible_for_roles": screen.get("visible_for_roles"),
            }
            for screen in screens
        ],
        "nav_items": (layout.get("mini_app_nav") or {}).get("items"),
        "warnings": result["warnings"],
        "post_steps": [
            "Create app users with matching role strings.",
            "Link the workboard into a workspace if the mini-app needs a public shell.",
        ],
    }
    if not user_confirmed:
        return _requires_confirmation(plan)

    create_body = _build_create_body(normalized)
    workboard = await _request("POST", "/workboards/", json_body=create_body)
    workboard_id = workboard.get("id")
    published = await _request("POST", f"/workboards/{workboard_id}/publish")

    return {
        "ok": True,
        "warnings": result["warnings"],
        "workboard": published,
        "workboard_id": workboard_id,
        "workboard_slug": wb_spec.get("slug"),
        "next_steps": [
            f"Call create_app_users_batch(workboard_id={workboard_id}, ...) to add app users.",
            "Call link_workboard_to_workspace if you want a public workspace URL.",
        ],
    }


@mcp.tool()
async def update_workboard_blueprint(
    workboard_id: int,
    blueprint_json: Dict[str, Any],
    republish: bool = True,
    user_confirmed: bool = False,
) -> Any:
    """Update an existing workboard using the same blueprint shape as create.

    This is safer than sending a raw PATCH when layout_json changes because it
    re-runs the same validation and GSheets safeguards as create.
    """
    current = await _request("GET", f"/workboards/{workboard_id}")
    merged_blueprint = _blueprint_from_existing_workboard(current, blueprint_json)
    result = await _normalize_and_validate_blueprint(merged_blueprint)
    if result["errors"]:
        return {
            "ok": False,
            "validation_errors": result["errors"],
            "warnings": result["warnings"],
            "message": "Fix the validation errors before updating the workboard blueprint.",
        }

    normalized = result["normalized_blueprint"]
    wb_spec = normalized["workboard"]
    layout = normalized["layout_json"]

    plan = {
        "action": "update_workboard_blueprint",
        "workboard_id": workboard_id,
        "fields_to_update": [
            "name",
            "slug",
            "description",
            "icon",
            "dataset_id",
            "primary_table_id",
            "optimistic_lock_column",
            "layout_json",
        ],
        "screen_count": len(layout.get("screens") or []),
        "warnings": result["warnings"],
        "republish_after_update": republish,
        "workboard_name": wb_spec.get("name"),
        "workboard_slug": wb_spec.get("slug"),
    }
    if not user_confirmed:
        return _requires_confirmation(plan)

    update_body = _build_update_body(normalized)
    updated = await _request("PATCH", f"/workboards/{workboard_id}", json_body=update_body)
    if republish or updated.get("is_published"):
        updated = await _request("POST", f"/workboards/{workboard_id}/publish")

    return {
        "ok": True,
        "warnings": result["warnings"],
        "workboard": updated,
        "workboard_id": workboard_id,
        "workboard_slug": updated.get("slug") or wb_spec.get("slug"),
    }


@mcp.tool()
async def update_workboard(
    workboard_id: int,
    updates: Dict[str, Any],
    user_confirmed: bool = False,
) -> Any:
    """Low-level partial PATCH for expert use.

    Prefer update_workboard_blueprint when layout_json changes.
    """
    plan = {
        "action": "update_workboard",
        "workboard_id": workboard_id,
        "fields_to_update": list(updates.keys()),
        "warning": "This is a low-level PATCH. Prefer update_workboard_blueprint for layout changes.",
    }
    if not user_confirmed:
        return _requires_confirmation(plan)

    return await _request("PATCH", f"/workboards/{workboard_id}", json_body=updates)


@mcp.tool()
async def publish_workboard(workboard_id: int) -> Any:
    """Publish a workboard."""
    return await _request("POST", f"/workboards/{workboard_id}/publish")


@mcp.tool()
async def delete_workboard(
    workboard_id: int,
    user_confirmed: bool = False,
) -> Any:
    """Permanently delete a workboard."""
    plan = {
        "action": "delete_workboard",
        "workboard_id": workboard_id,
        "warning": "This is irreversible. App users and public links will be removed with the workboard.",
    }
    if not user_confirmed:
        return _requires_confirmation(plan)

    return await _request("DELETE", f"/workboards/{workboard_id}")
