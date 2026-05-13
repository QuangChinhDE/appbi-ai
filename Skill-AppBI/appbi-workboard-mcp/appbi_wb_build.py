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
        # branding: customise the mini-app chrome.
        # NOTE: workboard.branding ONLY supports app_name / logo_url /
        # primary_color / accent_color / theme. `welcome_text` lives on the
        # WORKSPACE branding (set it via create_workspace / PATCH /workspaces),
        # NOT on layout_json.branding — unknown fields here are silently dropped.
        # theme: "auto" | "light" | "dark" — controls the mini-app colour scheme.
        "branding": {
            "app_name": None,
            "logo_url": None,
            "primary_color": None,
            "accent_color": None,
            "theme": "auto",
        },
        # audit: columns the write service fills automatically on every INSERT/UPDATE.
        # Set the column name string if it exists in the primary table, else null.
        # updated_at_column is also used for optimistic locking when optimistic_lock_column is set.
        "audit": {
            "created_by_column": None,      # auto-set to app_user.username on INSERT
            "created_at_column": None,      # auto-set to now() on INSERT
            "updated_by_column": None,      # auto-set to app_user.username on UPDATE
            "updated_at_column": None,      # auto-set to now() on INSERT+UPDATE
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
                # column_labels: friendly header map for list/doc screens on the same table.
                # Also used by this form to display field labels on read-only summary views.
                "column_labels": {},  # e.g. {"db_col": "Nhãn hiển thị"}
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
                            # widget options: "text" | "textarea" | "number" | "select" |
                            #                 "date" | "datetime" | "checkbox" | "lookup"
                            # - "select": static dropdown; values come from the column's data.
                            #   Do NOT add lookup for select; lookup is for dataset_table FK dropdowns.
                            # - "lookup": dynamic dropdown from another table.
                            #   Set lookup.kind="dataset_table", lookup.table_id, lookup.value_column,
                            #   lookup.label_column. Or kind="static" with lookup.values=[{label, value}].
                            # - "date" / "datetime": date/datetime picker.
                            # - "checkbox": boolean toggle (stores true/false).
                            "widget": "text",
                            "label": "<<field_label>>",
                            "required": True,
                            "readonly": False,
                            "default": None,
                            "help_text": None,
                            "placeholder": None,
                            "lookup": None,
                            # section: group fields under a heading inside one page.
                            # Must match one of the strings in form.sections[].
                            "section": None,
                            # page: 1-based index into form.pages[]. Omit for single-page forms.
                            "page": None,
                            # Conditional expressions (JavaScript-like, references other field column names).
                            # e.g. show_if: "loai_giao_dich == 'XK'"
                            "show_if": None,
                            "required_if": None,
                            "readonly_if": None,
                            "computed_from_dataset": None,
                        }
                    ],
                    "submit_label": "Save",
                    # after_submit: ScreenAction object to auto-navigate after save.
                    # e.g. {"id":"goto-list","label":"View list","go_to_screen":"list-view","carry":["id"]}
                    "after_submit": None,
                    # initial_values: pre-fill fields with static values or placeholders.
                    # Supports {{app_user.username}}, {{app_user.role}}, {{today}}.
                    # e.g. {"nam": "2026", "nguoi_tao": "{{app_user.username}}"}
                    "initial_values": {},
                    # pages: list of page objects for multi-step (wizard) forms.
                    # Each page: {id: int (1-based), title: str, description?: str, show_if?: str}
                    # Fields reference their page via field.page = <page id>.
                    # Empty list = single-page form.
                    "pages": [],
                    # sections: ordered list of section heading strings used to group fields
                    # within a page. Fields reference their section via field.section = "<name>".
                    # e.g. ["Thời gian", "Hàng hóa", "Đối tác / Phương tiện"]
                    "sections": [],
                },
                "list": None,
                "doc": None,
                "dashboard": None,
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
                # column_labels: friendly column header map shown in the list table.
                # Keys are db column names; values are display labels.
                "column_labels": {},  # e.g. {"ngay": "Ngày", "so_luong": "SL (Tấn)"}
                "rls": [],
                "rls_default": None,
                "form": None,
                "list": {
                    "columns": ["<<col1>>", "<<col2>>"],
                    # filters: each filter shown above the list for quick user filtering.
                    # kind options: "text" (free text search) | "select" (dropdown of distinct values)
                    #               | "date_range" (from/to date pickers) | "number_range" (min/max)
                    "filters": [],
                    "page_size": 50,   # min 10, max 500
                    "default_sort_column": None,
                    "default_sort_direction": "desc",  # "asc" | "desc"
                    "row_actions": [
                        {
                            "id": "edit",
                            "label": "Edit",
                            "icon": "Pencil",
                            # style: "primary" | "secondary" | "ghost" | "danger"
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
                "dashboard": None,
            },
            # OPTIONAL: keep this screen only if the mini-app needs a
            # printable report (kind='doc') OR an embedded dashboard (kind='dashboard').
            # DELETE this block if neither is needed.
            # See get_doc_screen_examples() for richer doc patterns (pivot,
            # unpivot, 2-row header, totals, group_by, Excel export).
            {
                "id": "report-view",
                "kind": "doc",
                "title": "<<report_title>>",
                "icon": "BarChart2",
                "description": None,
                "table_id": "<<dataset_table_id>>",
                "primary_key_columns": ["id"],
                "visible_for_roles": [],
                "show_in_nav": True,
                # column_labels: friendly header map for this doc's data_table blocks.
                "column_labels": {},  # {"db_col": "Nhãn hiển thị"}
                "rls": [],
                "rls_default": None,
                "form": None,
                "list": None,
                "doc": {
                    # page: print settings. size: "A4"|"A3"|"Letter"; orientation: "portrait"|"landscape"
                    "page": {"size": "A4", "orientation": "landscape", "margin_mm": 10},
                    # blocks: ordered list of content blocks.
                    # Allowed block types:
                    #   "header"    — {type, logo_url?, title, subtitle?, align:"left"|"center"|"right"}
                    #   "kv_grid"   — {type, columns:1-4, items:[{label, value}]}
                    #   "data_table"— (see below)
                    #   "text"      — {type, content, markdown:bool, align:"left"|"center"|"right"}
                    #   "spacer"    — {type, height_mm:1-200}
                    #   "signature" — {type, slots:[{label, role?}]}
                    #   "footer"    — {type, left?, center?, right?}
                    "blocks": [
                        {
                            "type": "data_table",
                            "source": "primary",
                            "title": "<<table_title>>",
                            "columns": ["<<col1>>", "<<col2>>"],
                            "column_groups": [],          # 2-row header groups; see examples
                            # column_metadata: optional per-column presentation overrides keyed by
                            # db column name. Each value: {label?, width_px?:1-2000, format?:str,
                            # align?:"left"|"center"|"right", total?:"sum"|"avg"|"count"|"min"|"max",
                            # merge?:bool}. Use this for finer control than the screen-level
                            # column_labels map (e.g. align numbers right, hint width).
                            "column_metadata": {},
                            "filters_from_view": True,
                            "totals": [],                 # subset of columns to SUM at the bottom
                            "group_by": [],               # subset of columns to merge equal-value rows
                            "max_rows": 500,
                            "show_index": False,
                            "transform": None,            # null | unpivot | pivot — see examples
                            "allow_export_excel": False,  # set True to show "Xuất Excel" button
                        }
                    ],
                },
                "dashboard": None,
            },
            # OPTIONAL: dashboard screen — embeds an existing AppBI Dashboard.
            # DELETE this block if a dashboard is not needed.
            # Two modes:
            #   MANAGED (recommended): set dashboard_id. Workboard auto-provisions one public link
            #     per distinct app_user role. Add role_filter_mapping to filter each role's view.
            #   MANUAL: set share_token only. No per-role filtering, no auto-provisioning.
            {
                "id": "dashboard-view",
                "kind": "dashboard",
                "title": "<<dashboard_title>>",
                "icon": "LayoutDashboard",
                "description": None,
                "table_id": None,           # dashboard screens don't bind a table
                "primary_key_columns": [],
                "visible_for_roles": [],
                "show_in_nav": True,
                "column_labels": {},
                "rls": [],
                "rls_default": None,
                "form": None,
                "list": None,
                "doc": None,
                "dashboard": {
                    # MANAGED mode: set dashboard_id (int). Get the id from the Dashboard module.
                    "dashboard_id": None,
                    # role_filter_mapping: filter the dashboard by app_user role.
                    # Each entry: {datasetId:int, semanticField:"view.column", operator:"eq"}
                    # Get exact datasetId + semanticField from GET /dashboards/{id}/filter-fields.
                    # Leave empty [] if no per-role filtering is needed.
                    "role_filter_mapping": [],
                    # static_filters: constant filters applied to every managed link.
                    # Each entry: {datasetId:int, semanticField:"view.column", operator:"eq", value:<scalar>}
                    # e.g. pin year=2026 across all roles: {datasetId:5, semanticField:"sales.year", value:2026}
                    "static_filters": [],
                    # managed_links is SERVER-OWNED — never set manually. Backend writes role→token here.
                    "managed_links": {},
                    # MANUAL mode: paste an existing public share_token (overrides managed mode).
                    "share_token": None,
                    "password": None,   # shared password for all managed links (mini-app auto-authenticates)
                    "height_px": None,  # fixed iframe height 200-4000 px; null = auto-resize
                },
            },
        ],
        "mini_app_nav": {
            # mobile_kind: "bottom_nav" (up to 5 tabs at bottom) | "drawer" (hamburger sidebar)
            "mobile_kind": "bottom_nav",
            # desktop_kind: "sidebar" (left panel) | "top_tabs" (horizontal tabs at top)
            "desktop_kind": "sidebar",
            "items": ["entry-form", "list-view", "report-view"],
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


# ---------------------------------------------------------------------------
# Doc (báo cáo) screen validation
# ---------------------------------------------------------------------------

_DOC_BLOCK_TYPES = {
    "header",
    "kv_grid",
    "data_table",
    "text",
    "spacer",
    "signature",
    "footer",
}

_TRANSFORM_KINDS = {"unpivot", "pivot"}


def _validate_doc_screen(
    *,
    screen: Dict[str, Any],
    screen_path: str,
    screen_table_columns: List[str],
    errors: List[str],
    warnings: List[str],
) -> None:
    doc = screen.get("doc")
    if not isinstance(doc, dict):
        # already reported as "no doc spec" upstream
        return

    # page block (optional but if present must be dict)
    page = doc.get("page")
    if page is not None and not isinstance(page, dict):
        errors.append(f"{screen_path}.doc.page must be an object")

    blocks = doc.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        errors.append(f"{screen_path}.doc.blocks must be a non-empty list")
        return

    table_cols = set(screen_table_columns or [])
    has_data_table = False

    for b_idx, block in enumerate(blocks):
        bpath = f"{screen_path}.doc.blocks[{b_idx}]"
        if not isinstance(block, dict):
            errors.append(f"{bpath} must be an object")
            continue
        btype = str(block.get("type") or "").strip()
        if btype not in _DOC_BLOCK_TYPES:
            errors.append(
                f"{bpath}.type={btype!r} is not one of {sorted(_DOC_BLOCK_TYPES)}"
            )
            continue

        if btype == "data_table":
            has_data_table = True
            _validate_data_table_block(
                block=block,
                path=bpath,
                table_cols=table_cols,
                errors=errors,
                warnings=warnings,
            )
        elif btype == "kv_grid":
            items = block.get("items") or []
            if not isinstance(items, list):
                errors.append(f"{bpath}.items must be a list of {{label, value}}")
        elif btype == "signature":
            slots = block.get("slots") or []
            if not isinstance(slots, list):
                errors.append(f"{bpath}.slots must be a list of {{label, role?}}")
        # header / text / spacer / footer have only optional scalar fields — no extra checks.

    if not has_data_table:
        warnings.append(
            f"{screen_path}.doc has no data_table block — the report will be static text only."
        )


def _validate_data_table_block(
    *,
    block: Dict[str, Any],
    path: str,
    table_cols: set,
    errors: List[str],
    warnings: List[str],
) -> None:
    source = str(block.get("source") or "primary").strip()
    block["source"] = source or "primary"

    if not source.startswith("lookup:") and source != "primary":
        errors.append(
            f"{path}.source must be 'primary' or 'lookup:<table_id>' (got {source!r})"
        )

    # When source is primary AND we know the bound table's columns, validate
    # columns / column_groups / totals / group_by reference real columns.
    check_cols = (source == "primary") and bool(table_cols)

    cols_list = block.get("columns") or []
    if not isinstance(cols_list, list):
        errors.append(f"{path}.columns must be a list[string]")
        cols_list = []
    if check_cols:
        missing = [c for c in cols_list if c and c not in table_cols]
        if missing:
            errors.append(f"{path}.columns references unknown columns: {missing}")

    # column_groups (2-row header)
    for g_idx, grp in enumerate(block.get("column_groups") or []):
        gpath = f"{path}.column_groups[{g_idx}]"
        if not isinstance(grp, dict):
            errors.append(f"{gpath} must be an object {{label, columns}}")
            continue
        if not str(grp.get("label") or "").strip():
            errors.append(f"{gpath}.label is required")
        gcols = grp.get("columns") or []
        if not isinstance(gcols, list) or not gcols:
            errors.append(f"{gpath}.columns must be a non-empty list[string]")
            continue
        # Each grouped col must also appear in the block's columns list.
        if cols_list:
            outside = [c for c in gcols if c not in cols_list]
            if outside:
                errors.append(
                    f"{gpath}.columns has entries not in {path}.columns: {outside}"
                )
        if check_cols:
            missing = [c for c in gcols if c not in table_cols]
            if missing:
                errors.append(f"{gpath}.columns references unknown columns: {missing}")

    # totals / group_by must be subsets of the block's columns
    for key in ("totals", "group_by"):
        vals = block.get(key) or []
        if not isinstance(vals, list):
            errors.append(f"{path}.{key} must be a list[string]")
            continue
        if cols_list:
            outside = [v for v in vals if v not in cols_list]
            if outside:
                errors.append(
                    f"{path}.{key} has entries not in {path}.columns: {outside}"
                )

    # transform (pivot / unpivot)
    transform = block.get("transform")
    if transform is not None:
        if not isinstance(transform, dict):
            errors.append(f"{path}.transform must be an object or null")
            return
        kind = str(transform.get("kind") or "").strip()
        if kind not in _TRANSFORM_KINDS:
            errors.append(
                f"{path}.transform.kind must be one of {sorted(_TRANSFORM_KINDS)} (got {kind!r})"
            )
            return
        if kind == "unpivot":
            id_cols = transform.get("id_columns") or []
            val_cols = transform.get("value_columns") or []
            if not isinstance(id_cols, list):
                errors.append(f"{path}.transform.id_columns must be a list[string]")
            if not isinstance(val_cols, list) or not val_cols:
                errors.append(
                    f"{path}.transform.value_columns must be a non-empty list[string]"
                )
            if check_cols:
                missing = [c for c in [*id_cols, *val_cols] if c not in table_cols]
                if missing:
                    errors.append(
                        f"{path}.transform references unknown columns: {missing}"
                    )
            var_name = transform.get("var_name", "variable")
            value_name = transform.get("value_name", "value")
            if var_name == value_name:
                errors.append(
                    f"{path}.transform.var_name and value_name must differ"
                )
        elif kind == "pivot":
            index = transform.get("index") or []
            cols_field = transform.get("columns")
            vals_field = transform.get("values")
            if not isinstance(index, list) or not index:
                errors.append(
                    f"{path}.transform.index must be a non-empty list[string]"
                )
            # backend DataTablePivot.columns accepts Union[str, List[str]]
            # (multi-level pivot uses a list of keys).
            if isinstance(cols_field, str):
                if not cols_field:
                    errors.append(
                        f"{path}.transform.columns must be a non-empty string"
                    )
            elif isinstance(cols_field, list):
                if not cols_field or not all(isinstance(c, str) and c for c in cols_field):
                    errors.append(
                        f"{path}.transform.columns must be a non-empty list[string] when using a list"
                    )
            else:
                errors.append(
                    f"{path}.transform.columns must be a non-empty string OR list[string]"
                )
            if not isinstance(vals_field, str) or not vals_field:
                errors.append(
                    f"{path}.transform.values must be a non-empty string"
                )
            agg = transform.get("agg", "sum")
            if agg not in {"sum", "avg", "min", "max", "count", "first"}:
                errors.append(
                    f"{path}.transform.agg must be one of sum/avg/min/max/count/first"
                )
            max_cols = transform.get("max_columns", 50)
            if not isinstance(max_cols, int) or not (1 <= max_cols <= 200):
                errors.append(
                    f"{path}.transform.max_columns must be int in [1, 200]"
                )
            if check_cols:
                refs = [*index]
                if isinstance(cols_field, str):
                    refs.append(cols_field)
                elif isinstance(cols_field, list):
                    refs.extend(c for c in cols_field if isinstance(c, str))
                if isinstance(vals_field, str):
                    refs.append(vals_field)
                missing = [c for c in refs if c not in table_cols]
                if missing:
                    errors.append(
                        f"{path}.transform references unknown columns: {missing}"
                    )

    # column_metadata: optional per-column overrides keyed by db column name.
    # Schema: {col: {label?, width_px?:1-2000, format?:str, align?:left|center|right,
    #               total?:sum|avg|count|min|max, merge?:bool}}.
    meta = block.get("column_metadata")
    if meta is not None:
        if not isinstance(meta, dict):
            errors.append(f"{path}.column_metadata must be an object keyed by column name")
        else:
            allowed_meta_keys = {"label", "width_px", "format", "align", "total", "merge"}
            allowed_align = {"left", "center", "right"}
            allowed_total = {"sum", "avg", "count", "min", "max"}
            for col, entry in meta.items():
                mpath = f"{path}.column_metadata[{col!r}]"
                if check_cols and col not in table_cols:
                    errors.append(f"{mpath} references unknown column")
                    continue
                if cols_list and col not in cols_list:
                    warnings.append(
                        f"{mpath} is set but column is not in {path}.columns — it will be ignored at render time."
                    )
                if not isinstance(entry, dict):
                    errors.append(f"{mpath} must be an object")
                    continue
                extras = sorted(set(entry.keys()) - allowed_meta_keys)
                if extras:
                    errors.append(f"{mpath} has unsupported keys: {extras}")
                if "width_px" in entry:
                    width = entry["width_px"]
                    if not isinstance(width, int) or not (1 <= width <= 2000):
                        errors.append(f"{mpath}.width_px must be int in [1, 2000]")
                if "align" in entry and entry["align"] not in allowed_align:
                    errors.append(f"{mpath}.align must be one of {sorted(allowed_align)}")
                if "total" in entry and entry["total"] not in allowed_total:
                    errors.append(f"{mpath}.total must be one of {sorted(allowed_total)}")
                if "merge" in entry and not isinstance(entry["merge"], bool):
                    errors.append(f"{mpath}.merge must be a boolean")

    # allow_export_excel must be bool
    if "allow_export_excel" in block and not isinstance(block["allow_export_excel"], bool):
        errors.append(f"{path}.allow_export_excel must be a boolean")


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
        if kind == "doc" and not screen.get("doc"):
            errors.append(f"screens[{index}] kind=doc but no doc spec (page + blocks)")
        if kind == "dashboard":
            dash_spec = screen.get("dashboard")
            if not isinstance(dash_spec, dict):
                errors.append(
                    f"screens[{index}] kind=dashboard but no dashboard spec "
                    "(need dashboard_id for managed mode, or share_token for manual mode)"
                )
            else:
                dashboard_id = dash_spec.get("dashboard_id")
                share_token = str(dash_spec.get("share_token") or "").strip()
                if dashboard_id is None and not share_token:
                    errors.append(
                        f"screens[{index}].dashboard must have either `dashboard_id` "
                        "(managed mode — workboard auto-provisions public links per role) "
                        "or `share_token` (manual mode — paste an existing public link)"
                    )
                if dashboard_id is not None:
                    try:
                        int(dashboard_id)
                    except Exception:
                        errors.append(
                            f"screens[{index}].dashboard.dashboard_id must be an integer"
                        )
                # role_filter_mapping validation
                mapping = dash_spec.get("role_filter_mapping") or []
                if mapping and not isinstance(mapping, list):
                    errors.append(
                        f"screens[{index}].dashboard.role_filter_mapping must be a list of "
                        "{datasetId, semanticField, operator?}"
                    )
                else:
                    seen_keys: set[tuple[int, str]] = set()
                    for m_idx, entry in enumerate(mapping):
                        mpath = (
                            f"screens[{index}].dashboard.role_filter_mapping[{m_idx}]"
                        )
                        if not isinstance(entry, dict):
                            errors.append(f"{mpath} must be an object")
                            continue
                        dsid = entry.get("datasetId")
                        if not isinstance(dsid, int):
                            errors.append(
                                f"{mpath}.datasetId must be an integer "
                                "(get it from GET /dashboards/{id}/filter-fields)"
                            )
                            continue
                        semantic = entry.get("semanticField")
                        if not isinstance(semantic, str) or "." not in semantic:
                            errors.append(
                                f"{mpath}.semanticField must be dotted like 'view.column' "
                                "(must match a slot in /dashboards/{id}/filter-fields)"
                            )
                            continue
                        key = (dsid, semantic)
                        if key in seen_keys:
                            errors.append(
                                f"{mpath} duplicates the slot ({dsid}, {semantic!r}); "
                                "each slot can only be mapped once."
                            )
                        seen_keys.add(key)
                        operator = entry.get("operator")
                        if operator is not None and not isinstance(operator, str):
                            errors.append(f"{mpath}.operator must be a string if provided")
                if mapping and dashboard_id is None:
                    errors.append(
                        f"screens[{index}].dashboard.role_filter_mapping requires dashboard_id "
                        "(managed mode). Drop it or set dashboard_id."
                    )

                # static_filters validation: same slot shape as mapping but
                # also requires a `value` (constant — backend does NOT
                # substitute the role here).
                statics = dash_spec.get("static_filters") or []
                if statics and not isinstance(statics, list):
                    errors.append(
                        f"screens[{index}].dashboard.static_filters must be a list of "
                        "{datasetId, semanticField, operator?, value}"
                    )
                else:
                    static_keys: set[tuple[int, str]] = set()
                    for s_idx, entry in enumerate(statics):
                        spath = (
                            f"screens[{index}].dashboard.static_filters[{s_idx}]"
                        )
                        if not isinstance(entry, dict):
                            errors.append(f"{spath} must be an object")
                            continue
                        dsid = entry.get("datasetId")
                        if not isinstance(dsid, int):
                            errors.append(f"{spath}.datasetId must be an integer")
                            continue
                        semantic = entry.get("semanticField")
                        if not isinstance(semantic, str) or "." not in semantic:
                            errors.append(
                                f"{spath}.semanticField must be dotted like 'view.column'"
                            )
                            continue
                        if "value" not in entry:
                            errors.append(
                                f"{spath}.value is required for static_filters "
                                "(backend does not substitute role here)"
                            )
                        key = (dsid, semantic)
                        if key in static_keys:
                            errors.append(
                                f"{spath} duplicates the slot ({dsid}, {semantic!r})"
                            )
                        static_keys.add(key)
                        # Warn (not error) when the same slot is in both
                        # role_filter_mapping and static_filters — runtime
                        # would dedupe one of them silently.
                        if key in {(m["datasetId"], m["semanticField"]) for m in mapping if isinstance(m, dict) and isinstance(m.get("datasetId"), int) and isinstance(m.get("semanticField"), str)}:
                            warnings.append(
                                f"{spath}: slot ({dsid}, {semantic!r}) is also in "
                                "role_filter_mapping; the dashboard runtime keys filters "
                                "by (datasetId, semanticField) so one of the two will "
                                "be ignored. Drop the duplicate."
                            )
                if statics and dashboard_id is None:
                    errors.append(
                        f"screens[{index}].dashboard.static_filters requires dashboard_id "
                        "(managed mode). Drop it or set dashboard_id."
                    )
                # managed_links is backend-owned; warn if the caller is trying
                # to set it manually (we accept it but won't use it).
                if dash_spec.get("managed_links"):
                    warnings.append(
                        f"screens[{index}].dashboard.managed_links is server-generated; "
                        "any value sent here will be overwritten on workboard save."
                    )
                height_px = dash_spec.get("height_px")
                if height_px is not None:
                    try:
                        h = int(height_px)
                        if not (200 <= h <= 4000):
                            errors.append(
                                f"screens[{index}].dashboard.height_px must be between 200 and 4000"
                            )
                    except Exception:
                        errors.append(
                            f"screens[{index}].dashboard.height_px must be an integer or null"
                        )

        table_id = screen.get("table_id")
        if isinstance(table_id, str) and table_id.isdigit():
            table_id = int(table_id)
            screen["table_id"] = table_id
        if kind in ("form", "list", "doc") and isinstance(table_id, int) and table_by_id and table_id not in table_by_id:
            errors.append(f"screens[{index}].table_id={table_id} is not attached to dataset {dataset_id}")

        # Resolve the bound table's column list once for both list/doc column checks.
        screen_table_columns: List[str] = []
        if isinstance(table_id, int) and table_by_id.get(table_id):
            screen_table_columns = _table_columns(table_by_id[table_id])

        # Validate column_labels keys reference real columns.
        column_labels = screen.get("column_labels") or {}
        if isinstance(column_labels, dict) and screen_table_columns:
            unknown_labels = [c for c in column_labels.keys() if c not in screen_table_columns]
            if unknown_labels:
                errors.append(
                    f"screens[{index}].column_labels references unknown columns: {unknown_labels}"
                )

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

        # ------------------------------------------------------------------
        # Doc (báo cáo) screen validation
        # ------------------------------------------------------------------
        if kind == "doc":
            _validate_doc_screen(
                screen=screen,
                screen_path=f"screens[{index}]",
                screen_table_columns=screen_table_columns,
                errors=errors,
                warnings=warnings,
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
            template["layout_json"]["audit"]["updated_by_column"] = None  # set to e.g. "nguoi_cap_nhat" if column exists

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
        "schema_constraints": {
            "IMPORTANT — read before filling the template": [
                "sections: list[string] — ordered list of section heading names, e.g. ['Thời gian', 'Hàng hóa']. NOT list of objects. Fields reference a section via field.section='<name>'.",
                "pages: list of page OBJECTS (NOT strings). Each page object: {id: int (1-based), title: str, description?: str, show_if?: str}. Fields reference a page via field.page=<id>. Empty list = single-page form.",
                "after_submit: ScreenAction object | null — e.g. {id:'goto-list', label:'Xem danh sách', icon:'List', style:'secondary', go_to_screen:'list-view', carry:['id'], confirm_message:null, visible_for_roles:[]}. NOT a plain string.",
                "form.initial_values: pre-fill fields with static values or dynamic placeholders. Supports {{app_user.username}}, {{app_user.role}}, {{today}}. e.g. {'nam': '2026', 'nguoi_tao': '{{app_user.username}}'}.",
                "widget options: 'text' | 'textarea' | 'number' | 'select' | 'date' | 'datetime' | 'checkbox' | 'lookup'. Use 'select' for static dropdowns (values come from column data). Use 'lookup' for FK dropdowns (set lookup.kind + lookup.table_id/lookup.values).",
                "select widget: values come from the column data. Do NOT add lookup for a select widget — they're incompatible.",
                "lookup.kind: 'static' (hardcoded list: lookup.values=[{label, value}]) | 'dataset_table' (FK: lookup.table_id + lookup.value_column + optional lookup.label_column).",
                "lookup for text/select widgets: only use lookup when the field needs a dropdown. Omit lookup (set to null) for plain text inputs.",
                "list.filters[]: each filter: {column:str, kind:'text'|'select'|'date_range'|'number_range', label?:str}. kind='text' = free-text search; 'select' = distinct values dropdown; 'date_range' = from/to pickers; 'number_range' = min/max inputs.",
                "row_actions[].style: 'primary' | 'secondary' | 'ghost' | 'danger'.",
                "system columns (id, updated_at, created_at): do NOT include these in form fields. They are managed by the runtime.",
                "visible_for_roles: list[string] — role names that can see this screen. Empty list = all roles.",
                "rls[].filter_value: use '{{app_user.username}}' (double braces) to filter by logged-in user.",
                "row_actions[].go_to_screen: must match an existing screen id exactly.",
                "mini_app_nav.items: list of screen ids (strings), not screen objects.",
                "mini_app_nav.mobile_kind: 'bottom_nav' (up to 5 tabs at bottom) | 'drawer' (hamburger sidebar). Default 'bottom_nav'.",
                "mini_app_nav.desktop_kind: 'sidebar' (left panel) | 'top_tabs' (horizontal tabs at top). Default 'sidebar'.",
                "branding (workboard): {app_name?:str, logo_url?:str, primary_color?:str (hex), accent_color?:str (hex), theme:'auto'|'light'|'dark'}. NOTE: `welcome_text` is a WORKSPACE-level field (set via create_workspace.branding or PATCH /workspaces/{id}); putting it on layout_json.branding is silently ignored.",
                "audit: {created_by_column?, created_at_column?, updated_by_column?, updated_at_column?} — column names auto-filled by the write service. Set to null if the table doesn't have the column.",
                "column_labels at the SCREEN level maps {db_column: 'Nhãn'} for friendly headers in list tables AND doc blocks. Add to EVERY screen that displays columns (form, list, doc, dashboard).",
                "CALL validate_workboard_blueprint(blueprint_json=...) BEFORE commit_workboard_blueprint to catch errors early.",
            ],
            "doc / printable document screens": [
                "kind='doc' is for PRINTABLE A4-style documents (phiếu xuất kho, hợp đồng mini, báo cáo có chữ ký). NOT for charts — use kind='dashboard' for charts.",
                "kind='doc' requires `doc: {page, blocks[]}`. Set form=null, list=null, dashboard=null on that screen.",
                "doc.page: {size:'A4'|'A3'|'Letter', orientation:'portrait'|'landscape', margin_mm:0-50}.",
                "Allowed block.type values and their fields:",
                "  header   → {type, logo_url?, title, subtitle?, align:'left'|'center'|'right'}",
                "  kv_grid  → {type, columns:1-4, items:[{label:str, value:str}]}",
                "  data_table → see data_table rules below",
                "  text     → {type, content:str, markdown:bool, align:'left'|'center'|'right'}",
                "  spacer   → {type, height_mm:1-200}",
                "  signature→ {type, slots:[{label:str, role?:str}]}",
                "  footer   → {type, left?:str, center?:str, right?:str}",
                "data_table.source: 'primary' (the screen's table_id) or 'lookup:<table_id>'. Default 'primary'.",
                "data_table.columns / column_groups[*].columns / totals / group_by: must all be real columns of the bound table.",
                "column_groups create a 2-row header (e.g. NHẬP HÀNG / XUẤT BÁN / TỒN KHO grouping monthly metric columns).",
                "data_table.transform=null by default. Use {kind:'unpivot', id_columns, value_columns, var_name, value_name} to flatten a wide Google Sheet (e.g. t1..t12 → one row per month).",
                "data_table.transform={kind:'pivot', index:[...], columns:'col' OR ['col_a','col_b'], values:'col', agg:'sum'|'avg'|'min'|'max'|'count'|'first', max_columns:1..200} to build a matrix from long data. Pass `columns` as a list for multi-level pivots (e.g. ['year','quarter']).",
                "data_table.column_metadata: optional per-column overrides keyed by db column name. Each value: {label?:str, width_px?:1-2000, format?:str (e.g. '#,##0', '0.00%'), align?:'left'|'center'|'right', total?:'sum'|'avg'|'count'|'min'|'max', merge?:bool}. Use this for finer control than the screen-level column_labels map (right-align numbers, hint width, format percentages, etc.). Keys must be real columns of the bound table; entries that aren't also in data_table.columns are ignored at render time.",
                "data_table.allow_export_excel=true exposes a 'Xuất Excel' download button on the mini-app block. Off by default.",
                "totals SUMs the listed columns in a footer row; group_by merges equal-value rows into spanned cells (good for hierarchical reports).",
                "CALL get_doc_screen_examples() to see annotated, copy-pasteable snippets for common document patterns.",
            ],
            "dashboard screens (embed an AppBI Dashboard)": [
                "kind='dashboard' embeds an existing AppBI Dashboard (charts, KPIs, cross-filter). No dataset table binding required (table_id can be null).",
                "Two modes:",
                "  MANAGED (recommended) — set dashboard.dashboard_id + optional dashboard.role_filter_mapping. Workboard server provisions one DashboardPublicLink per distinct app_user role and writes the tokens into dashboard.managed_links. Filter value is substituted with the role string at provision time — no special hard-lock logic.",
                "  MANUAL — set dashboard.share_token only. Embeds someone else's public link verbatim.",
                "role_filter_mapping is a list of {datasetId, semanticField, operator?} — describes WHICH dashboard filter slot gets filled with the viewing app_user's role. Empty list = no per-role filtering.",
                "static_filters is a list of {datasetId, semanticField, operator?, value, type?} — filters with constant value applied to every managed link regardless of role. Use for org-wide pins (year=2026, status='active'…).",
                "Slot shape (STRICT — runtime silently drops malformed slots): {datasetId:int, semanticField:'view.column' (must contain dot), operator:'eq'?}. Get exact `datasetId` and `semanticField` from GET /dashboards/{id}/filter-fields. In role_filter_mapping do NOT include `value`; in static_filters `value` is required.",
                "A slot can appear in role_filter_mapping OR static_filters but not both — dashboard runtime keys by (datasetId, semanticField) so one would silently shadow the other.",
                "Fan-out: links = (managed dashboard screens) × (distinct app_user roles on the workboard). Sync runs on app_user create/update/delete and on workboard layout save.",
                "Optional: dashboard.password — applied to every managed link; mini-app auto-authenticates.",
                "Optional: dashboard.height_px (200-4000) — fixed iframe height. Omit to auto-resize.",
                "Set form=null, list=null, doc=null on a dashboard screen. Screen-level RLS rules do NOT apply (the dashboard's own filters control data scope).",
                "dashboard.managed_links is SERVER-OWNED. Never set it manually.",
                "CALL get_dashboard_screen_examples() for copy-pasteable snippets.",
            ],
        },
        "next_step": (
            "Fill in the blueprint_template with real titles, roles, columns, and any additional screens. "
            "If a report screen is needed, call get_doc_screen_examples() for ready-to-adapt patterns. "
            "Then call validate_workboard_blueprint to check for errors before committing."
        ),
    }


@mcp.tool()
async def get_doc_screen_examples() -> Any:
    """Return annotated examples of `kind='doc'` (báo cáo) screens.

    Use this when the user asks for a report, dashboard panel, pivot table,
    multi-row header, monthly cross-tab, or Excel-exportable summary. The
    examples cover: simple flat report, 2-row grouped header, unpivot of a
    wide Google Sheet, pivot of a long fact table, and Excel export toggle.
    Copy the relevant `screen` dict into `layout_json.screens[]`, adapt
    `id` / `title` / `table_id` / `columns`, then call
    `validate_workboard_blueprint` and `commit_workboard_blueprint`.
    """
    examples = [
        {
            "name": "1. Simple flat report (no grouping, no transform)",
            "when_to_use": "Read-only printable view of one table with chosen columns and a totals row.",
            "screen": {
                "id": "report-simple",
                "kind": "doc",
                "title": "Báo cáo doanh thu",
                "icon": "FileText",
                "table_id": 123,
                "primary_key_columns": ["id"],
                "visible_for_roles": ["quan_ly"],
                "show_in_nav": True,
                "column_labels": {"ngay": "Ngày", "doanh_thu": "Doanh thu (VND)"},
                "rls": [],
                "rls_default": None,
                "form": None,
                "list": None,
                "doc": {
                    "page": {"size": "A4", "orientation": "portrait", "margin_mm": 15},
                    "blocks": [
                        {"type": "header", "title": "Doanh thu tháng 5", "align": "center"},
                        {
                            "type": "data_table",
                            "source": "primary",
                            "title": "Chi tiết theo ngày",
                            "columns": ["ngay", "khu_vuc", "doanh_thu"],
                            "filters_from_view": True,
                            "totals": ["doanh_thu"],
                            "group_by": [],
                            "max_rows": 500,
                            "show_index": True,
                            "transform": None,
                            "allow_export_excel": True,
                        },
                        {"type": "footer", "left": "Hệ thống AppBI", "right": "Trang {page}/{total}"},
                    ],
                },
            },
        },
        {
            "name": "2. 2-row grouped header (CTSP-style monthly report)",
            "when_to_use": "Wide table where contiguous columns share a parent label (NHẬP / XUẤT / TỒN, T1..T12, etc.).",
            "screen": {
                "id": "report-nxt",
                "kind": "doc",
                "title": "Báo cáo NXT thành phẩm",
                "icon": "BarChart2",
                "table_id": 126,
                "primary_key_columns": ["id"],
                "visible_for_roles": ["quan_ly", "ke_toan"],
                "show_in_nav": True,
                "column_labels": {
                    "thang": "Tháng", "ngay": "Ngày", "noi_dung": "Nội dung",
                    "nh_sp1": "SP1", "nh_sp2": "SP2",
                    "xb_sp1": "SP1", "xb_sp2": "SP2",
                    "ton_sp1": "SP1", "ton_sp2": "SP2",
                },
                "rls": [], "rls_default": None,
                "form": None, "list": None,
                "doc": {
                    "page": {"size": "A4", "orientation": "landscape", "margin_mm": 10},
                    "blocks": [
                        {
                            "type": "data_table",
                            "source": "primary",
                            "title": "NXT Thành phẩm 2026",
                            # cols outside any group span 2 header rows automatically
                            "columns": [
                                "thang", "ngay", "noi_dung",
                                "nh_sp1", "nh_sp2",
                                "xb_sp1", "xb_sp2",
                                "ton_sp1", "ton_sp2",
                            ],
                            "column_groups": [
                                {"label": "NHẬP HÀNG", "columns": ["nh_sp1", "nh_sp2"]},
                                {"label": "XUẤT BÁN", "columns": ["xb_sp1", "xb_sp2"]},
                                {"label": "TỒN KHO",  "columns": ["ton_sp1", "ton_sp2"]},
                            ],
                            "filters_from_view": True,
                            "totals": ["nh_sp1", "nh_sp2", "xb_sp1", "xb_sp2"],
                            "group_by": ["thang"],
                            "max_rows": 1000,
                            "show_index": False,
                            "transform": None,
                            "allow_export_excel": True,
                        },
                    ],
                },
            },
        },
        {
            "name": "3. Unpivot wide → long (Google Sheet with t1..t12 columns)",
            "when_to_use": "Source has one column per month/category. The report wants a flat (ma, thang, so_luong) shape to feed totals/group_by.",
            "screen": {
                "id": "report-unpivot",
                "kind": "doc",
                "title": "Doanh số theo tháng (dạng dài)",
                "icon": "Repeat",
                "table_id": 130,
                "primary_key_columns": ["id"],
                "visible_for_roles": [],
                "show_in_nav": True,
                "column_labels": {},
                "rls": [], "rls_default": None,
                "form": None, "list": None,
                "doc": {
                    "page": {"size": "A4", "orientation": "portrait", "margin_mm": 15},
                    "blocks": [
                        {
                            "type": "data_table",
                            "source": "primary",
                            "title": "Doanh số 12 tháng",
                            # After unpivot: columns = id_columns + [var_name, value_name]
                            "columns": ["ma_sp", "thang", "so_luong"],
                            "column_groups": [],
                            "filters_from_view": True,
                            "totals": ["so_luong"],
                            "group_by": ["ma_sp"],
                            "max_rows": 5000,
                            "show_index": False,
                            "transform": {
                                "kind": "unpivot",
                                "id_columns": ["ma_sp"],
                                "value_columns": [
                                    "t1", "t2", "t3", "t4", "t5", "t6",
                                    "t7", "t8", "t9", "t10", "t11", "t12",
                                ],
                                "var_name": "thang",
                                "value_name": "so_luong",
                                "drop_nulls": True,
                            },
                            "allow_export_excel": False,
                        },
                    ],
                },
            },
        },
        {
            "name": "4. Pivot long → wide (cross-tab from a fact table)",
            "when_to_use": "Source is long (ma_sp, thang, so_luong). The report wants a matrix where each tháng is its own column.",
            "screen": {
                "id": "report-pivot",
                "kind": "doc",
                "title": "Cross-tab doanh số theo tháng",
                "icon": "Grid3x3",
                "table_id": 131,
                "primary_key_columns": ["id"],
                "visible_for_roles": [],
                "show_in_nav": True,
                "column_labels": {},
                "rls": [], "rls_default": None,
                "form": None, "list": None,
                "doc": {
                    "page": {"size": "A4", "orientation": "landscape", "margin_mm": 10},
                    "blocks": [
                        {
                            "type": "data_table",
                            "source": "primary",
                            "title": "Matrix doanh số",
                            # After pivot the column set = index + one column per distinct value of `columns`.
                            # Leave the block's `columns` empty so the runtime emits all generated cols.
                            "columns": [],
                            "column_groups": [],
                            "filters_from_view": True,
                            "totals": [],
                            "group_by": [],
                            "max_rows": 5000,
                            "show_index": False,
                            "transform": {
                                "kind": "pivot",
                                "index": ["ma_sp"],
                                "columns": "thang",
                                "values": "so_luong",
                                "agg": "sum",
                                "max_columns": 50,
                                "fill_value": 0,
                            },
                            "allow_export_excel": True,
                        },
                    ],
                },
            },
        },
        {
            "name": "5. Mixed report (header + KV grid + table + signature)",
            "when_to_use": "Printable single-page document (biên bản, phiếu xuất kho, hợp đồng mini).",
            "screen": {
                "id": "report-doc-print",
                "kind": "doc",
                "title": "Phiếu xuất kho",
                "icon": "FileText",
                "table_id": 140,
                "primary_key_columns": ["id"],
                "visible_for_roles": [],
                "show_in_nav": False,
                "column_labels": {},
                "rls": [], "rls_default": None,
                "form": None, "list": None,
                "doc": {
                    "page": {"size": "A4", "orientation": "portrait", "margin_mm": 20},
                    "blocks": [
                        {"type": "header", "title": "PHIẾU XUẤT KHO", "subtitle": "Số: PX-2026-001", "align": "center"},
                        {"type": "kv_grid", "columns": 2, "items": [
                            {"label": "Ngày", "value": "{{row.ngay}}"},
                            {"label": "Khách hàng", "value": "{{row.khach_hang}}"},
                            {"label": "Kho", "value": "{{row.ma_kho}}"},
                            {"label": "Lý do", "value": "{{row.ly_do}}"},
                        ]},
                        {"type": "spacer", "height_mm": 5},
                        {
                            "type": "data_table",
                            "source": "primary",
                            "title": "Chi tiết hàng",
                            "columns": ["ma_sp", "ten_sp", "so_luong", "don_gia", "thanh_tien"],
                            "filters_from_view": True,
                            "totals": ["thanh_tien"],
                            "group_by": [], "max_rows": 200, "show_index": True,
                            "transform": None, "allow_export_excel": False,
                        },
                        {"type": "spacer", "height_mm": 10},
                        {"type": "signature", "slots": [
                            {"label": "Người lập phiếu"},
                            {"label": "Thủ kho", "role": "thu_kho"},
                            {"label": "Người nhận hàng"},
                        ]},
                        {"type": "footer", "left": "AppBI", "right": "Trang {page}/{total}"},
                    ],
                },
            },
        },
    ]
    return {
        "doc_block_types": sorted(_DOC_BLOCK_TYPES),
        "transform_kinds": sorted(_TRANSFORM_KINDS),
        "aggregations": ["sum", "avg", "min", "max", "count", "first"],
        "examples": examples,
        "tips": [
            "Always set form=null and list=null on a doc screen — extra='forbid' will reject mistaken specs otherwise.",
            "column_labels lives on the SCREEN, not on the data_table block. The label map covers both list and doc renderings.",
            "Use group_by to merge equal-value cells vertically (typical for 'tháng' columns in monthly reports).",
            "Set allow_export_excel=true only when the screen role is allowed to download data. The runtime returns 403 if false.",
            "transform=unpivot is in-memory after the fetch — keep max_rows large enough so all source rows survive the unpivot.",
            "transform=pivot caps columns via max_columns (default 50). Increase up to 200 for wider monthly matrices.",
        ],
    }


@mcp.tool()
async def get_dashboard_screen_examples() -> Any:
    """Return annotated examples of `kind='dashboard'` screens.

    A dashboard screen embeds an existing AppBI Dashboard via its public share
    token. The mini-app iframe renders the standard /embed/{token} page, so all
    chart loading, viewer filters, cross-filter, password gate, and PDF export
    are reused from the Dashboard module — no chart logic lives in the workboard.

    Use this tool when the user wants charts, KPIs, or a published BI view
    inside a workboard. For printable A4-style documents (phiếu xuất kho, biên
    bản, báo cáo có chữ ký), use ``get_doc_screen_examples()`` instead.
    """
    examples = [
        {
            "name": "1. Managed: 1 dashboard, mọi role thấy cùng dữ liệu",
            "when_to_use": "Đơn giản nhất — dashboard nội bộ, không cần lọc theo role. Workboard sinh 1 public link cho mỗi role nhưng tất cả đều không filter.",
            "screen": {
                "id": "dashboard-kpi",
                "kind": "dashboard",
                "title": "KPI tổng hợp",
                "icon": "LayoutDashboard",
                "table_id": None,
                "primary_key_columns": [],
                "visible_for_roles": [],
                "show_in_nav": True,
                "rls": [],
                "rls_default": None,
                "form": None,
                "list": None,
                "doc": None,
                "dashboard": {
                    "dashboard_id": 42,  # id từ /dashboards/accessible-summary
                    "role_filter_mapping": [],
                },
            },
        },
        {
            "name": "2. Managed: mỗi role thấy data của phòng ban đó",
            "when_to_use": "Dashboard có Access filter 'phong_ban' đã được DA cấu hình. Workboard map cột này ← app_user.role. App_user role='ke_toan' sẽ thấy data phong_ban='ke_toan'.",
            "screen": {
                "id": "dashboard-by-department",
                "kind": "dashboard",
                "title": "Báo cáo theo phòng ban",
                "icon": "BarChart3",
                "table_id": None,
                "primary_key_columns": [],
                "visible_for_roles": [],
                "show_in_nav": True,
                "rls": [],
                "rls_default": None,
                "form": None,
                "list": None,
                "doc": None,
                "dashboard": {
                    "dashboard_id": 42,
                    # CHỈ khai báo slot — value = role được backend tự fill khi
                    # provision link cho từng role. Get exact (datasetId,
                    # semanticField) từ GET /dashboards/42/filter-fields.
                    "role_filter_mapping": [
                        {
                            "datasetId": 7,
                            "semanticField": "hr.phong_ban",
                            "operator": "eq",
                        },
                    ],
                },
            },
        },
        {
            "name": "3. Managed + role map + filter cố định",
            "when_to_use": "Dashboard có 2 trục filter: (a) khu vực theo role, (b) chỉ năm 2026. Filter cố định áp cho mọi role.",
            "screen": {
                "id": "dashboard-with-static",
                "kind": "dashboard",
                "title": "Doanh thu 2026",
                "icon": "BarChart3",
                "table_id": None,
                "primary_key_columns": [],
                "visible_for_roles": [],
                "show_in_nav": True,
                "rls": [],
                "rls_default": None,
                "form": None,
                "list": None,
                "doc": None,
                "dashboard": {
                    "dashboard_id": 42,
                    "role_filter_mapping": [
                        {"datasetId": 7, "semanticField": "sales.region", "operator": "eq"},
                    ],
                    "static_filters": [
                        # Áp cho mọi role: chỉ năm 2026 + trạng thái active.
                        {
                            "datasetId": 7,
                            "semanticField": "sales.year",
                            "operator": "eq",
                            "value": 2026,
                            "type": "number",
                        },
                        {
                            "datasetId": 7,
                            "semanticField": "sales.status",
                            "operator": "in",
                            "value": ["active", "confirmed"],
                            "type": "dropdown",
                        },
                    ],
                },
            },
        },
        {
            "name": "4. Managed + password (nhạy cảm)",
            "when_to_use": "Dashboard nhạy cảm, muốn có thêm lớp password phòng URL bị share ra ngoài. Mini-app tự auth, end-user không bị hỏi.",
            "screen": {
                "id": "dashboard-sensitive",
                "kind": "dashboard",
                "title": "Doanh thu nội bộ",
                "icon": "BarChart3",
                "table_id": None,
                "primary_key_columns": [],
                "visible_for_roles": ["quan_ly"],
                "show_in_nav": True,
                "rls": [],
                "rls_default": None,
                "form": None,
                "list": None,
                "doc": None,
                "dashboard": {
                    "dashboard_id": 17,
                    "role_filter_mapping": [
                        {"datasetId": 3, "semanticField": "sales.region", "operator": "eq"},
                    ],
                    "password": "s3cret-shared-across-all-roles",
                },
            },
        },
        {
            "name": "5. Manual mode (paste share_token có sẵn)",
            "when_to_use": "Dùng public link người khác đã tạo (không phải dashboard của bạn). Không có managed link, không lọc theo role.",
            "screen": {
                "id": "dashboard-external",
                "kind": "dashboard",
                "title": "Báo cáo thị trường",
                "icon": "LayoutDashboard",
                "table_id": None,
                "primary_key_columns": [],
                "visible_for_roles": [],
                "show_in_nav": True,
                "rls": [],
                "rls_default": None,
                "form": None,
                "list": None,
                "doc": None,
                "dashboard": {
                    "share_token": "<<paste share_token người khác đưa>>",
                },
            },
        },
        {
            "name": "6. Fixed-height KPI strip",
            "when_to_use": "Dashboard chỉ vài KPI tile, không muốn iframe co dãn. Cố định height để layout mini-app gọn.",
            "screen": {
                "id": "dashboard-kpi-strip",
                "kind": "dashboard",
                "title": "KPI hôm nay",
                "icon": "PieChart",
                "table_id": None,
                "primary_key_columns": [],
                "visible_for_roles": [],
                "show_in_nav": True,
                "rls": [],
                "rls_default": None,
                "form": None,
                "list": None,
                "doc": None,
                "dashboard": {
                    "dashboard_id": 89,
                    "role_filter_mapping": [],
                    "height_px": 360,
                },
            },
        },
    ]
    return {
        "kind": "dashboard",
        "purpose": "Embed an AppBI Dashboard inside a mini-app screen. Optionally fill one or more filter slots with the viewing app_user's role.",
        "two_modes": {
            "managed": (
                "Set dashboard.dashboard_id. Backend reconciles one "
                "DashboardPublicLink (source='workboard') per distinct app_user "
                "role on workboard save AND on every app_user create/update/delete. "
                "Each link's filters_config = role_filter_mapping (value=<role>) "
                "+ static_filters (value as-defined). Tokens go to "
                "dashboard.managed_links: {role: share_token}; mini-app runtime "
                "picks one by app_user.role at view time."
            ),
            "manual": (
                "Set dashboard.share_token only. Embeds an existing public link "
                "verbatim. No managed links, no role-aware filtering, no static "
                "filters."
            ),
        },
        "how_to_find_dashboard_id": (
            "Call the AppBI orchestrator's list-dashboards tool, or hit "
            "GET /dashboards/accessible-summary as the workboard owner."
        ),
        "how_to_find_filter_fields": (
            "Once you know the dashboard_id, GET /dashboards/{id}/filter-fields "
            "returns the exact slicer slots: [{datasetId, semanticField, label, "
            "type, ...}]. Copy `datasetId` and `semanticField` verbatim into "
            "role_filter_mapping — the runtime drops anything that doesn't match."
        ),
        "mapping_slot_shape": {
            "datasetId": "REQUIRED int — from /dashboards/{id}/filter-fields[].datasetId",
            "semanticField": "REQUIRED dotted ref like 'hr.phong_ban' — from filter-fields[].semanticField",
            "operator": "Optional, defaults to 'eq'. Common: eq, neq, contains. NOT in/not_in — value is a single role string.",
        },
        "constraints": [
            "Exactly one of dashboard_id or share_token must be set.",
            "role_filter_mapping and static_filters are only valid in managed mode (dashboard_id set).",
            "role_filter_mapping entries: do NOT include `value` — backend fills it from app_user.role.",
            "static_filters entries: `value` is REQUIRED and must be a scalar (eq/neq/gt/...) or list (in/not_in).",
            "Each (datasetId, semanticField) pair can appear at most once across role_filter_mapping + static_filters combined.",
            "managed_links is server-owned; never set it in a blueprint.",
            "table_id is not used and should be null on dashboard screens.",
            "Screen-level RLS rules are ignored — the dashboard's own filters control data scope.",
            "password (if set) applies to ALL managed links of this screen and is stored verbatim in layout_json.",
        ],
        "examples": examples,
        "tips": [
            "Keep role_filter_mapping empty if all app_users should see the same dashboard data — workboard still creates 1 managed link per role but all are identical.",
            "If a managed link has no effect: GET /dashboards/{id}/filter-fields and verify the (datasetId, semanticField) pair matches one of the slots EXACTLY. The dashboard runtime silently drops unmatched slots.",
            "Workboard re-syncs managed links automatically when you add/edit/delete an app_user. You normally don't need to re-save the workboard layout after changing the app_user list.",
            "Renaming a role on an existing app_user invalidates the old token and creates a new one — already-open iframes on the old token will start failing. Plan ahead before renaming roles in production.",
        ],
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
async def validate_workboard_blueprint(
    blueprint_json: Dict[str, Any],
) -> Any:
    """Dry-run validate a blueprint without creating or modifying anything.

    Call this BEFORE commit_workboard_blueprint to catch schema errors early.
    Returns errors, warnings, and the normalized blueprint so you can inspect
    and fix issues without spending a round-trip on a 422 response.

    Common errors caught here:
    - sections must be list[string], not list[{id, title}]
    - after_submit must be {id, label, go_to_screen} | null, not a plain string
    - select widget: values come from column data; do not use inline options
    - filters[].widget is not a supported key
    - lookup.kind must be 'static' or 'dataset_table'
    - <<...>> placeholders left unfilled
    - table_id not attached to the dataset
    - go_to_screen references a non-existent screen id
    """
    result = await _normalize_and_validate_blueprint(blueprint_json)
    ok = len(result["errors"]) == 0
    return {
        "ok": ok,
        "errors": result["errors"],
        "warnings": result["warnings"],
        "normalized_blueprint": result["normalized_blueprint"] if ok else None,
        "message": (
            "Blueprint is valid — call commit_workboard_blueprint to create."
            if ok
            else f"Found {len(result['errors'])} error(s). Fix them before committing."
        ),
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
