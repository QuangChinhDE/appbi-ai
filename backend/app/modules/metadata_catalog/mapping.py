"""
Pure mapping functions: AppBI entities → OpenMetadata entity payloads.

Kept side-effect-free (no DB, no HTTP) so they are trivial to unit-test and to
eyeball against OM's schema. The publisher wires these to the OM client.

References:
  • Table schema    : openmetadata-spec .../entity/data/table.json
  • Column dataType : OM enum (we use dot-free, length-free types to avoid
                      validation friction: NUMBER / TEXT / DATE / DATETIME / BOOLEAN)
"""
from __future__ import annotations

from typing import Any

from . import fqn

# AppBI DataSourceType.value → OM databaseService serviceType
DATASOURCE_TYPE_TO_OM_SERVICE: dict[str, str] = {
    "postgresql": "Postgres",
    "mysql": "Mysql",
    "bigquery": "BigQuery",
    "google_sheets": "CustomDatabase",  # OM has no Sheets DB service
    "manual": "CustomDatabase",
}

# AppBI semantic column "type" → OM column dataType
_APPBI_TYPE_TO_OM_DATATYPE: dict[str, str] = {
    "number": "NUMBER",
    "integer": "NUMBER",
    "float": "NUMBER",
    "string": "TEXT",
    "text": "TEXT",
    "boolean": "BOOLEAN",
    "date": "DATE",
    "datetime": "DATETIME",
    "timestamp": "DATETIME",
}


def om_service_type(appbi_type: str) -> str:
    return DATASOURCE_TYPE_TO_OM_SERVICE.get(str(appbi_type or "").lower(), "CustomDatabase")


def om_data_type(appbi_col_type: str) -> str:
    return _APPBI_TYPE_TO_OM_DATATYPE.get(str(appbi_col_type or "").lower(), "TEXT")


def normalize_columns(columns_cache: Any) -> list[dict[str, Any]]:
    """
    AppBI columns_cache is a list of {"name","type",...}. Be defensive: also
    accept {"column_name"/"data_type"} and a dict-of-cols shape. Returns a clean
    list of {name, type} dicts; unnamed entries are dropped.
    """
    out: list[dict[str, Any]] = []
    items: list[Any]
    if isinstance(columns_cache, dict):
        # AppBI's real shape is {"columns": [ {name,type,...}, ... ]}.
        # Fall back to dict-values for any other dict-of-cols shape.
        if isinstance(columns_cache.get("columns"), list):
            items = columns_cache["columns"]
        else:
            items = list(columns_cache.values())
    elif isinstance(columns_cache, list):
        items = columns_cache
    else:
        items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name") or item.get("column_name") or item.get("column")
        if not name:
            continue
        ctype = item.get("type") or item.get("data_type") or item.get("dtype") or "string"
        out.append({"name": str(name), "type": str(ctype)})
    return out


# ── Entity payloads ───────────────────────────────────────────────────────

def service_payload(datasource) -> dict[str, Any]:
    """databaseService — one per AppBI datasource."""
    return {
        "name": fqn.service_name(datasource.id),
        "displayName": getattr(datasource, "name", None) or f"Datasource {datasource.id}",
        "serviceType": om_service_type(getattr(datasource, "type", None)),
        "description": getattr(datasource, "description", None) or None,
    }


def database_payload(datasource_id: int) -> dict[str, Any]:
    return {
        "name": fqn.database_name(),
        "service": fqn.service_fqn(datasource_id),
    }


def schema_payload(datasource_id: int) -> dict[str, Any]:
    return {
        "name": fqn.schema_name(),
        "database": fqn.database_fqn(datasource_id),
    }


def table_payload(
    datasource_id: int,
    dataset_table,
    columns: list[dict[str, Any]],
    constraints: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    table entity. `columns` is the normalized list from normalize_columns().
    `constraints` is an optional list of OM tableConstraints, e.g.
        {"constraintType": "PRIMARY_KEY", "columns": ["id"]}
        {"constraintType": "FOREIGN_KEY", "columns": ["customer_id"],
         "referredColumns": ["appbi_ds_1.default.public.t_2.id"]}
    """
    om_columns = [
        {
            "name": col["name"],
            "dataType": om_data_type(col["type"]),
            "dataTypeDisplay": col["type"],
        }
        for col in columns
    ]
    payload: dict[str, Any] = {
        "name": fqn.table_name(dataset_table.id),
        "displayName": getattr(dataset_table, "display_name", None) or fqn.table_name(dataset_table.id),
        "databaseSchema": fqn.schema_fqn(datasource_id),
        "columns": om_columns or [{"name": "_placeholder", "dataType": "TEXT"}],
    }
    desc = getattr(dataset_table, "auto_description", None)
    if desc:
        payload["description"] = str(desc)
    if constraints:
        payload["tableConstraints"] = constraints
    return payload
