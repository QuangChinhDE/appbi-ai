"""Helpers for retiring the legacy workboard primary-table anchor safely."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List

from app.models.dataset import DatasetTable
from app.modules.workboards.models import Workboard


_TABLE_REFERENCE_KEYS = {"table_id", "from_table_id", "catalog_table_id"}


def collect_table_references(
    value: Any,
    target_table_id: int,
    *,
    path: str,
) -> List[str]:
    """Return config paths that explicitly bind to a dataset table."""

    references: List[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            item_path = f"{path}.{key}"
            if (
                key in _TABLE_REFERENCE_KEYS
                and isinstance(item, int)
                and not isinstance(item, bool)
                and item == target_table_id
            ):
                references.append(item_path)
            references.extend(
                collect_table_references(item, target_table_id, path=item_path)
            )
    elif isinstance(value, list):
        for index, item in enumerate(value):
            references.extend(
                collect_table_references(
                    item,
                    target_table_id,
                    path=f"{path}[{index}]",
                )
            )
    return references


def workboard_table_references(
    workboard: Workboard,
    target_table_id: int,
) -> List[str]:
    """Collect real draft/live Screen, Lookup, and dependency references.

    ``primary_table_id`` itself is deliberately excluded because it is the
    legacy anchor this helper is designed to reassign.
    """

    sources = [
        ("layout", workboard.layout_json),
        ("lookup_tables", workboard.lookup_tables),
    ]
    if workboard.is_published:
        sources.append(("published_layout", workboard.published_layout_json))
    runtime = (
        workboard.published_runtime_config
        if isinstance(workboard.published_runtime_config, dict)
        else {}
    )
    binding = runtime.get("binding") if isinstance(runtime.get("binding"), dict) else {}
    if workboard.is_published:
        sources.append(("published_binding.lookup_tables", binding.get("lookup_tables")))

    references: List[str] = []
    for path, value in sources:
        if value is not None:
            references.extend(
                collect_table_references(value, target_table_id, path=path)
            )
    return list(dict.fromkeys(references))


def infer_primary_key_columns(table: DatasetTable) -> List[str]:
    cache = table.columns_cache
    if isinstance(cache, dict):
        cache = cache.get("columns")
    columns = [item for item in (cache or []) if isinstance(item, dict)]
    names = [
        str(item.get("name") or "").strip()
        for item in columns
        if str(item.get("name") or "").strip()
    ]
    flagged = [
        str(item.get("name"))
        for item in columns
        if item.get("name") and bool(item.get("is_primary_key"))
    ]
    if flagged:
        return flagged
    if "id" in names:
        return ["id"]
    id_columns = [name for name in names if name.endswith("_id")]
    if id_columns:
        return [id_columns[0]]
    return [names[0]] if names else []


def reassign_legacy_primary_table(
    workboard: Workboard,
    replacement: DatasetTable,
) -> None:
    """Move only the legacy anchor and its frozen published binding."""

    old_table_id = int(workboard.primary_table_id)
    replacement_pk = infer_primary_key_columns(replacement)
    workboard.primary_table_id = int(replacement.id)
    workboard.primary_key_columns = replacement_pk

    runtime = workboard.published_runtime_config
    if not isinstance(runtime, dict):
        return
    next_runtime: Dict[str, Any] = deepcopy(runtime)
    binding = next_runtime.get("binding")
    if not isinstance(binding, dict) or binding.get("primary_table_id") != old_table_id:
        return
    binding["primary_table_id"] = int(replacement.id)
    binding["primary_key_columns"] = replacement_pk
    workboard.published_runtime_config = next_runtime
