"""Bundle-first Workboard design, validation and apply tools."""
from __future__ import annotations

import re
from typing import Any

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-_]*$")

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
        expected = [
            lookup.get("value_column"),
            lookup.get("label_column"),
            # map widget geometry projection columns (only present for widget=map)
            lookup.get("geometry_column"),
            lookup.get("lat_column"),
            lookup.get("lng_column"),
        ]
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
        # context_filters bind a block column to a runtime shared-context value
        # (per-record printable phiếu). The `column` must exist on the block source.
        for cf in block.get("context_filters") or []:
            if not isinstance(cf, dict):
                errors.append(f"{location}: context_filters must contain objects.")
                continue
            _add_column_issues(
                refs=[cf.get("column")], columns=block_columns, allowed=set(),
                location=f"{location}.context_filters", errors=errors, warnings=warnings,
            )
            if not str(cf.get("from_shared") or "").strip():
                errors.append(f"{location}: context_filters.from_shared is required.")
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
    screen_ids: set[str],
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

    # Per-screen RLS rules: a non-placeholder filter_column must exist on the
    # screen's bound table (placeholders like {{app_user.x}} are values, not columns).
    rls_rules = list(screen.get("rls") or [])
    if isinstance(screen.get("rls_default"), dict):
        rls_rules.append(screen["rls_default"])
    for rule in rls_rules:
        if not isinstance(rule, dict) or rule.get("unrestricted"):
            continue
        filter_column = rule.get("filter_column")
        if isinstance(filter_column, str) and filter_column.strip():
            _add_column_issues(
                refs=[filter_column],
                columns=columns,
                allowed=set(),
                location=f"screen '{screen_id}' rls[role={rule.get('role')}].filter_column",
                errors=errors,
                warnings=warnings,
            )

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
        # rollup_columns are derived read-only columns too — allow their names in
        # `columns` (mirrors the backend audit's valid_table_cols).
        for key in ("computed_columns", "lookup_columns", "rollup_columns")
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
    # KPI tiles + conditional-format columns + calendar reference real columns.
    refs.extend(
        row.get("column") for row in spec.get("stat_tiles") or [] if isinstance(row, dict)
    )
    for rule in spec.get("format_rules") or []:
        if isinstance(rule, dict):
            refs.extend(rule.get("columns") or [])
    cal = spec.get("calendar_config")
    if isinstance(cal, dict):
        refs.extend(
            cal.get(k) for k in ("date_column", "title_column", "color_column") if cal.get(k)
        )
    _add_column_issues(
        refs=refs,
        columns=columns,
        allowed=derived,
        location=f"screen '{screen_id}' table",
        errors=errors,
        warnings=warnings,
    )

    # Gallery display mode: the BE requires a gallery_config whose named
    # columns are all listed in `columns` (else the runtime can't return the
    # image/label values). Mirror that here so validate catches it pre-apply.
    if spec.get("display_mode") == "gallery":
        gallery = spec.get("gallery_config")
        if not isinstance(gallery, dict):
            errors.append(
                f"screen '{screen_id}' table: display_mode='gallery' requires gallery_config."
            )
        else:
            image_column = gallery.get("image_column")
            if not (isinstance(image_column, str) and image_column.strip()):
                errors.append(
                    f"screen '{screen_id}' table.gallery_config.image_column is required."
                )
            declared = set(str(c) for c in (spec.get("columns") or []))
            for key in ("image_column", "title_column", "subtitle_column", "group_by_column"):
                col = gallery.get(key)
                if isinstance(col, str) and col and col not in declared:
                    errors.append(
                        f"screen '{screen_id}' table.gallery_config.{key} '{col}' "
                        f"must be listed in table.columns."
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

    # rollup_columns — reverse aggregate over a child table (mirror lookup checks).
    for index, roll in enumerate(spec.get("rollup_columns") or []):
        if not isinstance(roll, dict):
            errors.append(f"screen '{screen_id}' table.rollup_columns[{index}] must be an object.")
            continue
        foreign_id = roll.get("from_table_id")
        if not isinstance(foreign_id, int) or foreign_id not in tables:
            errors.append(
                f"screen '{screen_id}' table.rollup_columns[{index}].from_table_id is not attached."
            )
            continue
        remote = _columns(tables[foreign_id])
        _add_column_issues(
            refs=[roll.get("match_column_local")], columns=columns, allowed=set(),
            location=f"screen '{screen_id}' rollup local", errors=errors, warnings=warnings,
        )
        remote_refs = [roll.get("match_column_remote")]
        if str(roll.get("agg") or "").lower() != "count" and roll.get("value_column"):
            remote_refs.append(roll.get("value_column"))
        _add_column_issues(
            refs=remote_refs, columns=remote, allowed=set(),
            location=f"screen '{screen_id}' rollup remote table {foreign_id}",
            errors=errors, warnings=warnings,
        )

    # bulk_actions — select-many → create one parent + link selected rows
    # (SIMPLE), or a server-executed recipe (ADVANCED: steps/resources/constraints).
    for index, action in enumerate(spec.get("bulk_actions") or []):
        if not isinstance(action, dict):
            errors.append(f"screen '{screen_id}' table.bulk_actions[{index}] must be an object.")
            continue
        loc = f"screen '{screen_id}' bulk_actions[{index}]"
        steps = action.get("steps") or []
        if not steps:
            # SIMPLE mode: the flat fields are required + reference real columns.
            _add_column_issues(
                refs=[action.get("set_column")] + list((action.get("also_set") or {}).keys()),
                columns=columns, allowed=set(), location=f"{loc} set_column/also_set",
                errors=errors, warnings=warnings,
            )
            parent_screen = str(action.get("parent_screen_id") or "").strip()
            if not parent_screen:
                errors.append(f"{loc}: simple mode needs parent_screen_id (or use steps).")
            elif parent_screen not in screen_ids:
                errors.append(f"{loc}.parent_screen_id '{parent_screen}' is not a screen in this layout.")
            if not str(action.get("parent_code_column") or "").strip():
                errors.append(f"{loc}: simple mode needs parent_code_column (or use steps).")
        else:
            # ADVANCED: every step that writes must target a screen in the layout.
            for si, step in enumerate(steps):
                if not isinstance(step, dict):
                    errors.append(f"{loc}.steps[{si}] must be an object.")
                    continue
                sid = str(step.get("screen_id") or "").strip()
                if step.get("kind") in ("create_record", "create_lines_from_selected") and not sid:
                    errors.append(f"{loc}.steps[{si}] ({step.get('kind')}) needs screen_id.")
                if sid and sid not in screen_ids:
                    errors.append(f"{loc}.steps[{si}].screen_id '{sid}' is not a screen in this layout.")
        # require_same + preview_aggregates + constraint agg columns reference THIS screen.
        _add_column_issues(
            refs=list(action.get("require_same") or [])
            + [a.get("column") for a in action.get("preview_aggregates") or [] if isinstance(a, dict)]
            + [c.get("agg_column") for c in action.get("constraints") or [] if isinstance(c, dict)],
            columns=columns, allowed=derived, location=f"{loc} require_same/preview/constraints",
            errors=errors, warnings=warnings,
        )
        # resource_inputs read from a screen; constraints may reference them.
        res_ids = set()
        for ri in action.get("resource_inputs") or []:
            if not isinstance(ri, dict):
                continue
            res_ids.add(str(ri.get("id") or ""))
            rsid = str(ri.get("source_screen_id") or "").strip()
            if not rsid or rsid not in screen_ids:
                errors.append(f"{loc}.resource_inputs '{ri.get('id')}' source_screen_id '{rsid}' is not a screen in this layout.")
        for c in action.get("constraints") or []:
            if not isinstance(c, dict):
                continue
            lfr = c.get("limit_from_resource")
            if lfr and lfr not in res_ids:
                errors.append(f"{loc}.constraints limit_from_resource '{lfr}' has no matching resource_inputs id.")
            if c.get("limit") is None and not lfr:
                errors.append(f"{loc}.constraints on '{c.get('agg_column')}' needs limit or limit_from_resource.")

    # pos_cart — supermarket scan-cart (line columns + catalog + header screen).
    pos = spec.get("pos_cart")
    if isinstance(pos, dict):
        loc = f"screen '{screen_id}' pos_cart"
        _add_column_issues(
            refs=[pos.get("barcode_column"), pos.get("quantity_column"),
                  pos.get("amount_column"), pos.get("order_id_column"), pos.get("date_column")],
            columns=columns, allowed=set(), location=f"{loc} line columns",
            errors=errors, warnings=warnings,
        )
        catalog_id = pos.get("catalog_table_id")
        if not isinstance(catalog_id, int) or catalog_id not in tables:
            errors.append(f"{loc}.catalog_table_id is not an attached dataset table.")
        for key in ("header_screen_id", "after_submit_screen"):
            sid = str(pos.get(key) or "").strip()
            if sid and sid not in screen_ids:
                errors.append(f"{loc}.{key} '{sid}' is not a screen in this layout.")
        if not spec.get("allow_add_row") or not (spec.get("editable_columns") or []):
            errors.append(
                f"{loc}: a pos_cart line screen needs allow_add_row=true AND >=1 editable_column "
                "or the bulk-insert is refused at runtime ('Adding rows is disabled')."
            )

    # calendar display mode requires a date_column that is in `columns`.
    if spec.get("display_mode") == "calendar":
        cal = spec.get("calendar_config")
        if not isinstance(cal, dict) or not str(cal.get("date_column") or "").strip():
            errors.append(
                f"screen '{screen_id}' table: display_mode='calendar' requires calendar_config.date_column."
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
                screen_ids=ids,
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

    for index, group in enumerate(layout.get("screen_groups") or []):
        if not isinstance(group, dict):
            errors.append(f"layout_json.screen_groups[{index}] must be an object.")
            continue
        if not str(group.get("id") or "").strip() or not str(group.get("label") or "").strip():
            errors.append(f"layout_json.screen_groups[{index}] needs id and label.")
        missing_group = [str(sid) for sid in group.get("screen_ids") or [] if str(sid) not in ids]
        if missing_group:
            errors.append(
                f"screen_groups[{index}] '{group.get('id')}' references missing screen ids {missing_group}."
            )

    for index, auto in enumerate(layout.get("auto_number_columns") or []):
        if not isinstance(auto, dict):
            errors.append(f"layout_json.auto_number_columns[{index}] must be an object.")
            continue
        if not str(auto.get("column") or "").strip() or not str(auto.get("pattern") or "").strip():
            errors.append(
                f"auto_number_columns[{index}] needs both column and pattern (e.g. 'PO-{{YYYY}}{{MM}}-{{N:4}}')."
            )

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

    slug = str(workboard.get("slug") or "").strip()
    if slug and not _SLUG_RE.match(slug):
        errors.append(
            "bundle.workboard.slug must match ^[a-z0-9][a-z0-9-_]*$ (lowercase letters, digits, - and _)."
        )

    publish_requested = bool(workboard.get("publish")) or isinstance(bundle.get("workspace"), dict)
    owner_users = [
        u for u in bundle.get("app_users") or []
        if isinstance(u, dict) and str(u.get("role") or "").lower() == "owner"
    ]
    default_pin_owners = [u.get("username") for u in owner_users if str(u.get("pin") or "") == "123456"]
    if publish_requested:
        if not str(workboard.get("owner_pin") or "").strip():
            warnings.append(
                "publish/workspace requested but bundle.workboard.owner_pin is unset — the auto-created "
                "owner account keeps the default PIN and publish will be skipped. Set a non-default owner_pin."
            )
        if default_pin_owners:
            warnings.append(
                f"owner-role app_users still on the default PIN '123456': {default_pin_owners}. "
                "Give them a non-default pin or publish/share will be blocked."
            )
    if isinstance(bundle.get("workspace"), dict) and not slug:
        warnings.append(
            "Workspace delivery needs bundle.workboard.slug — the workspace menu keys by slug, "
            "and apply will fail to link the workboard without it."
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


async def _ensure_owner_pin_rotated(
    workboard_id: int, owner_pin: str | None
) -> dict[str, Any]:
    """Rotate any owner-role app user still on the factory-default PIN.

    The backend blocks publish / share while an owner uses the default PIN.
    When owner_pin is given, patch each default-PIN owner to it; report any
    that remain (e.g. owner_pin omitted) so apply can skip publish cleanly.
    """
    users = await _request("GET", f"/workboards/{int(workboard_id)}/app-users")
    rows = [u for u in users if isinstance(u, dict)] if isinstance(users, list) else []
    default_owners = [
        u for u in rows
        if str(u.get("role") or "").lower() == "owner" and u.get("using_default_pin")
    ]
    rotated: list[str] = []
    if owner_pin and default_owners:
        for user in default_owners:
            await _request(
                "PATCH",
                f"/workboards/{int(workboard_id)}/app-users/{int(user['id'])}",
                json_body={"pin": str(owner_pin)},
            )
            rotated.append(str(user.get("username")))
        users = await _request("GET", f"/workboards/{int(workboard_id)}/app-users")
        rows = [u for u in users if isinstance(u, dict)] if isinstance(users, list) else []
        default_owners = [
            u for u in rows
            if str(u.get("role") or "").lower() == "owner" and u.get("using_default_pin")
        ]
    return {
        "rotated": rotated,
        "still_default": [str(u.get("username")) for u in default_owners],
    }


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
            "owner_pin_set": bool(str(wb.get("owner_pin") or "").strip()),
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


_SCREEN_SCHEMA_REFERENCE = {
    "screen_common": {
        "id": "stable unique string (<=64 chars)",
        "kind": "form | table | doc | dashboard",
        "title": "required, <=120 chars",
        "icon": "optional",
        "table_id": "required for form/table/doc (attached dataset table id); omit for dashboard",
        "primary_key_columns": "e.g. ['id'] — needed for update/delete",
        "visible_for_roles": "[] = all; else subset of app-user roles",
        "show_in_nav": "default true",
        "column_labels": "{db_column: friendly_label} for table/doc headers",
        "rls": "[ScreenRlsRule] per-role row security (see rls_rule)",
        "rls_default": "optional fallback ScreenRlsRule for roles not listed",
        "<kind>": "the matching spec object (form/table/doc/dashboard)",
    },
    "form_spec": {
        "fields": "[FormField]",
        "submit_label": "optional button text",
        "after_submit": "ScreenAction — auto-advance + carry columns after save",
        "initial_values": "{column: default}; supports {{app_user.x}} / {{today}}",
        "pages": "[{id>=1, title, description?, show_if?}] for multi-step forms; FormField.page places a field",
        "sections": "[str] section headings within a page",
        "ocr": "{enabled, provider, model, hint} photo-to-fields (BYOK api_key)",
    },
    "form_spec_geo": {
        "geo_stamp_column": "form_spec: capture device GPS at submit and write 'lat,lng' into this column (readonly anti-fraud geo-audit)",
    },
    "form_field": {
        "column": "required db column",
        "widget": (
            "text|textarea|number|select|date|datetime|checkbox|lookup|file|image|map|"
            "geopoint|images|signature|barcode|audio|computed|status|"
            "email|phone|url|rich_text|enum_list|rating|slider|currency|percent|time|duration|color|video|qr"
        ),
        "required/readonly/default/help_text/placeholder/label/section/page": "presentation + placement",
        "lookup": "LookupConfig when widget=lookup/select/map/enum_list",
        "map_widget": "widget=map: tap a polygon/point on a satellite basemap to pick a value. Options + geometry come from a dataset_table lookup (set lookup.geometry_column). Selected value is a plain string (the value_column) — behaves like select for required/valid_if/carry.",
        "show_if/required_if/readonly_if": "expressions over [other_column]",
        "valid_if": "must be truthy at submit, e.g. '[end_date] >= [start_date]'; valid_if_error = message",
        "max_file_kb": "widget=file/image/images/signature/audio: max KB per item; hard BE ceiling 1024 KB (base64 into JSONB)",
        "capture_only/max_items": "widget=image/images: force live camera (anti-fraud) / max photo count (images)",
        "unit/formula": "widget=number/computed: unit suffix / computed = JS arithmetic over [col] evaluated live + stored on submit",
        "status_config": "widget=status ONLY — see status_config sub-schema (lifecycle states + approval gating + transitions)",
        "rich_inputs": "widget rating(max_stars,allow_half) | slider(min_value,max_value,step) | currency(currency_code) | enum_list(max_select, lookup source) | percent",
        "qr_display": "widget=qr (DISPLAY only, never writes): qr_source_column | qr_value_template ('[col]'/deep-link, wins over source) | qr_size (48-1024) | qr_caption — for printing a label",
        "scan_to_form": "widget=barcode: scan_go_to_screen (navigate to this screen on a hit) + scan_carry_as (column the scanned value is carried under; default = this field's column)",
    },
    "status_config": {
        "states": "[{value, label?, color? slate|green|amber|red|blue|violet}] the lifecycle badges",
        "editable_by_roles": "[] = anyone who can write the row; else only these roles may change status (approval gate on top of RLS writable_columns)",
        "allowed_transitions": "{from_value: [allowed_to_values]} — SERVER blocks illegal (prev->new); [] = terminal; absent value = unconstrained. Per-screen, so a driver screen can omit '-> Huỷ' while a manager screen allows it",
    },
    "lookup_config": {
        "kind": "static | dataset_table",
        "values": "static: [{label, value}]",
        "table_id/value_column/label_column": "dataset_table: read options from a related table",
        "relationship_path": "[{table_id?, value_column, label_column?}] nested hops (order.cust_id -> customer.city_id -> city.name)",
        "geometry_column": "widget=map only: column holding a GeoJSON Polygon/MultiPolygon string per row (drawn on the map)",
        "lat_column/lng_column": "widget=map only: optional centroid columns; used as a marker fallback when a row has no geometry",
        "basemap": "widget=map only: satellite (default) | streets | light",
    },
    "table_spec": {
        "columns": "display order; may include computed/lookup column names",
        "editable_columns": "SINGLE source of inline editability; subset of columns; never a computed/lookup name; [] = read-only grid",
        "allow_add_row": "needs >=1 editable column",
        "allow_delete_row": "independent toggle",
        "filters": "[{column, kind: text|select|date_range|number_range, label?}]",
        "page_size/default_sort_column/default_sort_direction": "paging + sort",
        "computed_columns": "[{name, label?, formula (JS body), format?}] — JS sandbox; test with test_screen_js",
        "lookup_columns": "[{name, from_table_id, match_column_local, match_column_remote, return_column, format?}] relational VLOOKUP (1 value from a related table)",
        "rollup_columns": "[RollupColumn] reverse-reference AGGREGATE of child rows (order total = SUM of its lines). Name goes in `columns`, never in editable_columns",
        "totals": "{column: sum|avg|min|max|count} footer aggregates",
        "stat_tiles": "[{label, column, agg sum|avg|min|max|count, format?, unit?}] KPI cards above the grid (aggregate the loaded rows) — the lightweight per-role dashboard",
        "format_rules": "[{when (expr over [col]), color slate|green|amber|red|blue|violet, columns? ([] = whole row), icon?, label?}] conditional formatting (đỏ quá hạn, amber một phần…)",
        "group_by": "[col] merge repeated cells (must NOT be in editable_columns)",
        "column_groups": "multi-level header spanning contiguous columns",
        "row_actions": "[ScreenAction] per-row navigate+carry (e.g. In phiếu → doc screen)",
        "bulk_actions": "[BulkAction] tick-select many rows → combine into ONE new parent (gom đơn→hóa đơn, gom hóa đơn→chuyến). Renders a checkbox column + action bar. See bulk_action sub-schema",
        "detail_panel": "{enabled, columns[], editable_columns[], sections{label:[col]}} side panel on row click (labels come from column_metadata/column_labels)",
        "display_mode": "table (default) | gallery (image cards) | calendar (month grid) — same query/RLS/filters/detail_panel",
        "gallery_config": "required when display_mode=gallery: {image_column (data:image column, REQUIRED + must be in columns), title_column?, subtitle_column?, group_by_column? (section per value, e.g. a date), columns_per_row? 1-6}. All named columns must be listed in `columns`.",
        "calendar_config": "required when display_mode=calendar: {date_column (REQUIRED + in columns), title_column?, color_column?}",
        "column_metadata": "{col: {label?, width_px?, format? text|number|integer|currency|percent|date|datetime|qr, align?, merge?, input_type? text|number|currency|percent|date|datetime|time|checkbox|select|enum_list|rating|color|slider, options?[{label,value}], currency_code?, max_stars?, min_value?, max_value?, step?}} — per-column label/format + inline editor for editable cells",
        "pos_cart": "PosCartConfig — turns the screen into a supermarket scan-cart (scan/pick → line list → ONE submit bulk-inserts all lines). See pos_cart sub-schema. NOTE: the line screen still needs allow_add_row=true + >=1 editable_column or the bulk-insert is refused",
        "required_columns/default_values/empty_state_message": "extras (default_values supports {{today}}/{{app_user.x}})",
    },
    "rollup_column": {
        "name/label/format?": "output column (name must appear in table.columns, never editable)",
        "from_table_id": "child dataset table id (attached)",
        "match_column_local/match_column_remote": "parent key = child key",
        "agg": "sum|count|avg|min|max",
        "value_column": "child column to aggregate (ignored for count)",
    },
    "pos_cart": {
        "barcode_column/quantity_column": "line columns for the scanned code + quantity",
        "catalog_table_id/catalog_match_column": "product master table id + column matched against the scanned code",
        "catalog_label_column/catalog_price_column": "product name / unit-price columns",
        "catalog_copy": "{line_column: catalog_column} copied onto every appended line",
        "amount_column": "optional line column = qty x price (OMIT if the line total is a DB generated column)",
        "header_inputs": "[{column, label, kind text|select|date, options?, default?, required?, write_to_line? (false = header/receipt only, not written on each line)}]",
        "order_id_column/order_id_prefix": "line+header column for the generated phiếu id + its prefix",
        "date_column": "optional line column auto-set to today (omit if the line table has no date column)",
        "header_screen_id": "screen (bound to the phiếu HEADER table, usually hidden) that receives ONE header row per submit",
        "submit_label/after_submit_screen/after_submit_carry": "button text + doc screen opened after save (receipt) + columns carried to it",
        "allow_manual_search/catalog_group_column/empty_hint": "searchable picker beside the scanner + group the picker + empty hint",
    },
    "bulk_action": {
        "id/label/icon?/style?": "button on the selection action bar",
        "SIMPLE mode (no steps)": "set_column + parent_screen_id + parent_code_column (+ also_set/code_prefix/parent_defaults) — create ONE parent + set the code on every selected row",
        "set_column": "SIMPLE: child column set to the new parent's code on every selected row (the FK link)",
        "also_set": "SIMPLE: {child_column: value} extra columns set on every selected row",
        "parent_screen_id/parent_code_column/code_prefix/parent_defaults": "SIMPLE: the parent screen + code column + prefix + other parent values",
        "confirm_message/success_message": "'{n}' is replaced with the selection count",
        "min_selection/visible_for_roles": "gate the action",
        "require_same": "[col] precondition — every selected row must share the same value (e.g. ['ma_kh'] cùng khách / ['nha_cung_cap'] cùng NCC). Server-enforced when a recipe runs; FE blocks the button otherwise",
        "preview_aggregates": "[{column, agg sum|avg|min|max|count, label, format?}] running totals of the SELECTED rows shown before commit (tự tính tổng)",
        "── ADVANCED (server-executed recipe) ──": "when steps/resource_inputs/constraints present the runtime opens a modal and the SERVER runs the recipe with compensation-rollback",
        "resource_inputs": "[{id, label, source_screen_id (a table screen the picker reads — usually hidden from nav), value_column, label_column?, capacity_column?, required?}] — records the operator picks (e.g. Xe/Kho); feed the parent + supply constraint limits",
        "constraints": "[{agg_column, agg, op <=|<|>=|>, limit? | limit_from_resource (a resource_inputs id whose capacity_column is the limit), label?, error_message?}] — numeric guard over the selection (e.g. tổng khối lượng ≤ tải trọng xe) shown as a live badge + block",
        "steps": "[BulkStep] ordered recipe — see bulk_step. Empty = SIMPLE mode.",
    },
    "bulk_step": {
        "id/kind": "kind = create_record | create_lines_from_selected | update_selected",
        "screen_id": "screen the step writes to (omit for update_selected → the action's own screen)",
        "create_record": "code_column+code_prefix (generate a code), defaults, aggregate_from_selected {col:{column,agg}} (sum the selection into the parent), from_resource {col:'<resource_id>.<col>'}, link_columns {col:'<prior_step_id>'}",
        "create_lines_from_selected": "one row per selected row: copy {line_col: selected_col}, set {...}, link_columns {col:'<step_id>'}, assign_sequence {order_by, into_col} (sort + number thứ tự)",
        "update_selected": "update every selected row: set {...}, link_columns {col:'<step_id>'}",
    },
    "doc_spec": {
        "page": "{size: A4|A3|Letter, orientation, margin_mm}",
        "blocks": "ordered: header | kv_grid | data_table | text | spacer | signature | footer | qr_code",
        "placeholders": "ALL block strings substitute {{today}}, {{app_user.username}}, {{shared.<col>}} (values carried in via row_action.carry / pos after_submit_carry). Unresolved {{shared.x}} shows literal — only reference keys you actually carry",
        "data_table_block": {
            "type": "data_table",
            "source": "'primary' (screen table) or 'lookup:<table_id>'",
            "columns": "[col]",
            "context_filters": "[{column, from_shared (shared-context key), required? (true = no rows when the value is absent → per-record printable phiếu)}] — filters the block to ONE record",
            "column_metadata": "{col: {label?, format?, align?, total? sum|avg|count|min|max}} (doc totals agg is here OR totals:['col:sum']) ",
            "allow_export_excel": "Excel export button (letterhead auto-prepended from layout.print_template)",
            "totals": "['col'] or ['col:sum'] footer aggregates (default agg sum)",
            "pivot/unpivot/column_groups": "report-table shaping",
            "sync_triggers": "[{id, label, webhook_ids:[bundle webhook id], run_mode, visible_for_roles}]",
        },
        "qr_code_block": "{type:'qr_code', value (static or {{shared.x}}), size 48-1024, caption?, align?} — QR on a printable label/phiếu",
    },
    "dashboard_spec": {
        "managed": "dashboard_id (+ role_filter_mapping[{datasetId, semanticField, operator}] + static_filters) -> per-role public links auto-provisioned",
        "manual": "share_token of an existing dashboard public/embed link",
        "options": "height_px, password",
    },
    "rls_rule": {
        "role": "owner|admin|user (owner bypasses RLS)",
        "unrestricted": "true = role sees all rows",
        "filter_column / filter_value": "row filter; value supports {{app_user.username}} / {{app_user.<col>}}",
        "can_create/can_update/can_delete": "per-role write gates",
        "writable_columns/readonly_columns": "restrict editable fields per role",
    },
    "layout_top_level": {
        "screens": "[Screen]",
        "mini_app_nav": "{desktop_kind: sidebar|top_tabs, mobile_kind: bottom_nav|drawer, items: [screen_id]}",
        "branding": "{app_name, theme, ...}",
        "audit": "AuditConfig (created/updated tracking columns)",
        "auto_number_columns": "[{column, pattern 'PO-{YYYY}{MM}{DD}-{N:4}', reset, padding, start_at}] (column-name is workboard-wide; avoid a name shared by another table)",
        "screen_groups": "[{id, label, icon?, screen_ids:[id], visible_for_roles}] nav grouping (UI: Workspace) — one group per bộ phận keeps the nav tidy for admins",
        "print_template": "{enabled, company_name, address, tax_code, hotline, email, website, logo_data (data: URI), footer_note, accent_color} reusable letterhead auto-rendered atop EVERY doc screen (print + Excel export)",
    },
    "screen_action": {
        "id/label": "required",
        "style": "primary|secondary|ghost|danger",
        "go_to_screen": "destination screen id",
        "carry": "[col] copied into next screen's shared_context (prefills matching fields)",
        "confirm_message/visible_for_roles": "optional",
    },
}


@tool("build")
async def get_workboard_design_guide(ctx: Context | None = None) -> dict[str, Any]:
    """Return the full Workboard bundle contract + current screen schema reference."""
    return {
        "workflow": [
            "Stage 0-2 first if no dataset: create/inspect source -> create dataset + tables -> get_table_profile -> generate_dataset_model + relationships",
            "inspect_dataset_for_workboard(dataset_id): use the table ids + columns it returns (never source-table ids)",
            "author ONE bundle: workboard + layout_json (screens) + app_users + webhooks + optional workspace",
            "test_screen_js for any computed column formula",
            "validate_workboard_bundle(bundle) and fix every error",
            "apply_workboard_bundle(bundle, user_confirmed=true)",
            "audit_workboard, then create_workboard_public_link and/or workspace, then run_workboard_runtime_smoke_test",
        ],
        "bundle_contract": {
            "workboard": {
                "name": "Required",
                "slug": "lowercase [a-z0-9-_]; REQUIRED when delivering via a workspace (menus key by slug)",
                "dataset_id": "Required existing AppBI dataset id",
                "primary_table_id": "Anchor table id; auto-picked from first physical table if omitted",
                "primary_key_columns": "e.g. ['id']",
                "optimistic_lock_column": "Optional concurrent-edit lock column",
                "publish": "true so the runtime is visible",
                "owner_pin": "REQUIRED when publish=true — a non-default PIN; apply rotates the auto-created owner_<id> account off the factory default so publish/share is allowed",
                "settings": "Optional non-webhook settings merge",
            },
            "layout_json": "Backend LayoutJson — see screen_schema_reference for every field.",
            "app_users": "Upsert list. New users need username+pin. roles: owner/admin/user. active=false for a disabled demo user.",
            "webhooks": "[{id, name, url, screen_id (a doc screen), is_active}] — doc sync_triggers reference these ids.",
            "workspace": "Optional: {id|workspace_id} to update, or {name, slug, access_mode, menu_item:{label}} to create.",
        },
        "screen_rules": [
            "A Workboard's dataset must be backed by PostgreSQL, MySQL, or Google Sheets (mini-apps write back). Manual/file sources work for datasets/dashboards but are rejected as a workboard source.",
            "publish=true (or a workspace) needs workboard.owner_pin set to a non-default PIN, and no owner-role app_user may keep PIN '123456'.",
            "Kinds: form, table, doc, dashboard. A table screen's spec key is `table` (legacy list/grid auto-heal but never author them).",
            "Bind table_id to an ATTACHED dataset table id; dashboard screens have no table_id.",
            "Schemas are strict (extra keys 422). Use only the fields in screen_schema_reference.",
            "editable_columns is the only inline-edit switch; never list a computed/lookup column there.",
            "Map picker: widget='map' on a form field + lookup.kind=dataset_table with geometry_column (GeoJSON per row). The picked value is the value_column string; add it to after_submit.carry to feed the next screen. Geometry table needs a GeoJSON column (Polygon/MultiPolygon).",
            "Gallery: a table screen with display_mode='gallery' + gallery_config. image_column (a data:image column) and every other gallery column MUST also be in table.columns. group_by_column buckets cards into sections (e.g. a capture-date column). Great as the 'view saved photos' screen after an image-upload form.",
            "Doc data_table sync_triggers[].webhook_ids must match bundle.webhooks ids; webhooks bind to a doc screen_id.",
            "RLS/visible_for_roles roles must match app_user roles; owner bypasses RLS but keep user/admin explicit.",
            "Validate computed-column JS with test_screen_js before apply.",
            "Gom (select-many → 1 parent): table.bulk_actions renders a checkbox column + action bar. Each action creates ONE parent row via parent_screen_id (that screen must allow_create for the role) then sets set_column = a generated code on every selected row. set_column + also_set keys must be in THIS screen's RLS writable_columns; the parent screen's default_values fill date/creator. Use for 'gom nhiều đơn → 1 hóa đơn', 'gom nhiều hóa đơn → 1 chuyến'.",
            "POS scan-cart (lập phiếu/đơn kiểu siêu thị): table.pos_cart. The LINE screen MUST also set allow_add_row=true + >=1 editable_column or the bulk-insert is refused ('Adding rows is disabled'). header_screen_id writes ONE phiếu-header row per submit; after_submit_screen opens the printable receipt (carry the id). OMIT amount_column when the line total is a DB generated column.",
            "Dashboards: prefer table stat_tiles (KPI cards) + format_rules (đỏ/amber/green row-cell tint) as the mini-app-native per-role dashboard. Use a dashboard screen (embed an AppBI dashboard) only when you need real charts.",
            "rollup_columns aggregate child rows (đơn total = SUM of its lines); like lookup_columns the name goes in `columns`, never editable_columns.",
            "Printable per-record phiếu: a doc screen bound to the record's table + a data_table with context_filters [{column, from_shared}] (required=true → shows only that record). Open it from a row_action whose carry includes from_shared (or pos_cart after_submit_carry). layout.print_template is the shared letterhead auto-applied to every doc + Excel; doc block strings resolve {{shared.x}}/{{today}}/{{app_user.x}} — only reference shared keys you actually carry.",
            "widget=status: status_config.allowed_transitions is server-enforced (illegal prev→new blocked); narrow the map on a role's own screen for per-role transitions.",
            "Nav: group screens with layout.screen_groups (one group per bộ phận) so admins don't get a flat wall of tabs; each role only sees groups with a visible member.",
        ],
        "screen_schema_reference": _SCREEN_SCHEMA_REFERENCE,
        "starter_bundle": {
            "workboard": {
                "name": "Inventory Demo",
                "slug": "inventory-demo",
                "dataset_id": 47,
                "primary_table_id": 101,
                "primary_key_columns": ["id"],
                "publish": True,
                "owner_pin": "246810",
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
                {"username": "demo_owner", "pin": "246810", "role": "owner", "active": True},
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


@tool("build")
async def validate_workboard_bundle(
    bundle: dict[str, Any],
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Validate Workboard references before a one-confirm bundle apply."""
    return await _validate_bundle(bundle)


@tool({"build", "deliver"})
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

    wb_id = int(workboard["id"])
    with_settings = await _merge_settings(workboard, bundle)
    if with_settings is not None:
        workboard = with_settings

    # Upsert app users BEFORE publish — a publishable/shareable workboard may
    # not leave any owner-role account on the factory-default PIN.
    user_result = None
    if bundle.get("app_users"):
        user_result = await _upsert_app_users(wb_id, bundle["app_users"])

    # The backend auto-creates an `owner_<id>` account with the default PIN.
    # Rotate every still-default owner to workboard.owner_pin so publish /
    # workspace / public-link gates pass.
    owner_pin = bundle["workboard"].get("owner_pin")
    owner_pin_state = await _ensure_owner_pin_rotated(wb_id, owner_pin)

    publish_requested = bool(bundle["workboard"].get("publish"))
    publish_blocked = None
    if publish_requested:
        if owner_pin_state["still_default"]:
            publish_blocked = (
                "Publish skipped: owner account(s) "
                f"{owner_pin_state['still_default']} still use the default PIN. "
                "Set bundle.workboard.owner_pin (a non-default PIN) and re-apply, "
                "or rotate the owner PIN, then publish."
            )
        else:
            workboard = await _request("POST", f"/workboards/{wb_id}/publish")

    workspace_result = None
    if isinstance(bundle.get("workspace"), dict) and not publish_blocked:
        workspace_result = await _deliver_workspace(workboard, bundle["workspace"])

    audit = await _request("GET", f"/workboards/{wb_id}/audit")
    return {
        "status": operation,
        "workboard": workboard,
        "app_users": user_result,
        "owner_pin": owner_pin_state,
        "publish_blocked": publish_blocked,
        "workspace": workspace_result,
        "audit": audit,
        "validation_warnings": validation["warnings"],
    }


__all__: list[str] = []
