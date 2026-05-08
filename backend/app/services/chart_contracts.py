"""
Shared helpers for chart/query contracts.

These helpers keep live and synced paths aligned without forcing the product
to copy Cube's public API. The goal is stricter internal contracts and better
backward compatibility for saved chart configs.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any


_VALID_AGGS = {"sum", "avg", "count", "min", "max", "count_distinct"}
CHART_QUERY_MODE_GENERATED = "generated"
CHART_QUERY_MODE_CUSTOM = "custom"
_VALID_CHART_QUERY_MODES = {
    CHART_QUERY_MODE_GENERATED,
    CHART_QUERY_MODE_CUSTOM,
}
_OPERATOR_MAP = {
    "=": "eq",
    "==": "eq",
    "eq": "eq",
    "!=": "neq",
    "<>": "neq",
    "neq": "neq",
    "ne": "neq",        # canonical alias used by MeasureFilter / semantic schema
    ">": "gt",
    "gt": "gt",
    ">=": "gte",
    "gte": "gte",
    "<": "lt",
    "lt": "lt",
    "<=": "lte",
    "lte": "lte",
    "like": "like",
    "contains": "contains",
    "not_contains": "not_contains",
    "starts_with": "starts_with",
    "in": "in",
    "not_in": "not_in",
    "between": "between",
    "is_null": "is_null",
    "is_not_null": "is_not_null",
}
CHART_FILTER_CONTEXT_DEFAULT = "default"
CHART_FILTER_CONTEXT_DASHBOARD = "dashboard"
_VALID_CHART_FILTER_CONTEXTS = {
    CHART_FILTER_CONTEXT_DEFAULT,
    CHART_FILTER_CONTEXT_DASHBOARD,
}


def normalize_chart_query_mode(mode: Any) -> str:
    raw = str(mode or CHART_QUERY_MODE_GENERATED).strip().lower()
    return raw if raw in _VALID_CHART_QUERY_MODES else CHART_QUERY_MODE_GENERATED


def get_chart_query_mode(config: dict[str, Any] | None) -> str:
    if not isinstance(config, dict):
        return CHART_QUERY_MODE_GENERATED

    mode = normalize_chart_query_mode(config.get("queryMode"))
    custom_sql = str(config.get("customSql") or "").strip()
    if mode == CHART_QUERY_MODE_CUSTOM and custom_sql:
        return CHART_QUERY_MODE_CUSTOM
    return CHART_QUERY_MODE_GENERATED


def get_chart_custom_sql(config: dict[str, Any] | None) -> str | None:
    if get_chart_query_mode(config) != CHART_QUERY_MODE_CUSTOM:
        return None
    custom_sql = str((config or {}).get("customSql") or "").strip()
    return custom_sql or None


def get_chart_active_role_config(config: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(config, dict):
        return {}

    mode = get_chart_query_mode(config)
    if mode == CHART_QUERY_MODE_CUSTOM and isinstance(config.get("customRoleConfig"), dict):
        return config.get("customRoleConfig") or {}
    if mode == CHART_QUERY_MODE_GENERATED and isinstance(config.get("generatedRoleConfig"), dict):
        return config.get("generatedRoleConfig") or {}
    if isinstance(config.get("roleConfig"), dict):
        return config.get("roleConfig") or {}
    return {}


def normalize_filter_operator(operator: str | None) -> str:
    raw = str(operator or "eq").strip().lower()
    return _OPERATOR_MAP.get(raw, raw)


def normalize_filter_value(operator: str, value: Any) -> Any:
    if value is None:
        return value

    if operator in {"in", "not_in"}:
        if isinstance(value, list):
            return value
        if isinstance(value, tuple):
            return list(value)
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]

    if operator == "between":
        if isinstance(value, list):
            return value[:2]
        if isinstance(value, tuple):
            return list(value[:2])
        if isinstance(value, str):
            separator = ".." if ".." in value else ","
            parts = [part.strip() for part in value.split(separator) if part.strip()]
            if parts:
                return parts[:2]

    return value


def _filter_atom_is_present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple)):
        return any(_filter_atom_is_present(item) for item in value)
    return True


def is_filter_condition_active(filter_condition: dict[str, Any]) -> bool:
    operator = normalize_filter_operator(filter_condition.get("operator"))
    if operator in {"is_null", "is_not_null"}:
        return True

    value = normalize_filter_value(operator, filter_condition.get("value"))
    if operator in {"in", "not_in"}:
        return isinstance(value, list) and any(_filter_atom_is_present(item) for item in value)
    if operator == "between":
        if not isinstance(value, list):
            return False
        lo = value[0] if len(value) > 0 else None
        hi = value[1] if len(value) > 1 else None
        return _filter_atom_is_present(lo) or _filter_atom_is_present(hi)

    return _filter_atom_is_present(value)


def normalize_filter_conditions(filters: list[dict] | None) -> list[dict]:
    normalized: list[dict] = []
    for filt in filters or []:
        field = filt.get("field")
        if not field:
            continue
        operator = normalize_filter_operator(filt.get("operator"))
        value = normalize_filter_value(operator, filt.get("value"))
        candidate = {
            **filt,
            "field": field,
            "operator": operator,
            "value": value,
        }
        if not is_filter_condition_active(candidate):
            continue
        normalized.append(
            candidate
        )
    return normalized


def normalize_chart_filter_context(context: str | None) -> str:
    raw = str(context or CHART_FILTER_CONTEXT_DEFAULT).strip().lower()
    return raw if raw in _VALID_CHART_FILTER_CONTEXTS else CHART_FILTER_CONTEXT_DEFAULT


def get_chart_editor_filters(config: dict[str, Any] | None) -> list[dict]:
    if not isinstance(config, dict):
        return []
    return normalize_filter_conditions(config.get("filters"))


def get_chart_base_filters(config: dict[str, Any] | None) -> list[dict]:
    if not isinstance(config, dict):
        return []
    base_filters = config.get("baseFilters")
    if not isinstance(base_filters, list):
        return []
    return normalize_filter_conditions(base_filters)


def resolve_chart_query_filters(
    config: dict[str, Any] | None,
    context: str | None = None,
) -> list[dict]:
    base_filters = get_chart_base_filters(config)
    if base_filters:
        return base_filters
    return get_chart_editor_filters(config)


def merge_chart_query_filters(
    config: dict[str, Any] | None,
    extra_filters: list[dict] | None = None,
    context: str | None = None,
) -> list[dict]:
    base = list(resolve_chart_query_filters(config, context=context))
    extra = normalize_filter_conditions(extra_filters)
    if not extra:
        return base

    # Deduplicate: when extra_filters (runtime/dashboard) target the same field+operator
    # as a base filter, the runtime value takes precedence.
    extra_keys = {(f["field"], f["operator"]) for f in extra}
    merged = [f for f in base if (f["field"], f["operator"]) not in extra_keys]
    merged.extend(extra)
    return merged


def normalize_metric_config(metric: Any, default_agg: str = "sum") -> dict[str, Any] | None:
    if isinstance(metric, str):
        field = metric.strip()
        if not field:
            return None
        return {"field": field, "agg": default_agg}

    if not isinstance(metric, dict):
        return None

    field = str(metric.get("field") or "").strip()
    if not field:
        return None

    agg = str(metric.get("agg") or metric.get("function") or default_agg).strip().lower()
    if agg not in _VALID_AGGS:
        agg = default_agg

    normalized = dict(metric)
    normalized["field"] = field
    normalized["agg"] = agg
    return normalized


def normalize_chart_role_config(chart_type: str, role_config: dict | None) -> dict[str, Any]:
    normalized = deepcopy(role_config or {})
    normalized_metrics = [
        metric
        for metric in (
            normalize_metric_config(metric)
            for metric in normalized.get("metrics") or []
        )
        if metric
    ]
    normalized["metrics"] = normalized_metrics

    ctype = str(getattr(chart_type, "value", chart_type) or "").upper()
    line_metric = normalize_metric_config(normalized.get("lineMetric"))
    benchmark_metric = normalize_metric_config(normalized.get("benchmarkMetric"))
    table_pivot_metric = normalize_metric_config(normalized.get("tablePivotMetric"))

    normalized["tableMode"] = "pivot" if str(normalized.get("tableMode") or "").lower() == "pivot" else "standard"

    for field_name in ("tableRowDimension", "tableColumnDimension"):
        raw_value = normalized.get(field_name)
        if isinstance(raw_value, str):
            normalized[field_name] = raw_value.strip() or None
        elif raw_value is None:
            normalized[field_name] = None

    if ctype == "BAR_LINE" and not line_metric:
        legacy_breakdown = normalized.get("breakdown")
        if isinstance(legacy_breakdown, str) and legacy_breakdown.strip():
            line_metric = {
                "field": legacy_breakdown.strip(),
                "agg": "sum",
            }

    if line_metric:
        normalized["lineMetric"] = line_metric
    if benchmark_metric:
        normalized["benchmarkMetric"] = benchmark_metric
    else:
        normalized.pop("benchmarkMetric", None)
    if table_pivot_metric:
        normalized["tablePivotMetric"] = table_pivot_metric
    else:
        normalized.pop("tablePivotMetric", None)

    return normalized
