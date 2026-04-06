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
_OPERATOR_MAP = {
    "=": "eq",
    "==": "eq",
    "eq": "eq",
    "!=": "neq",
    "<>": "neq",
    "neq": "neq",
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


def normalize_filter_conditions(filters: list[dict] | None) -> list[dict]:
    normalized: list[dict] = []
    for filt in filters or []:
        field = filt.get("field")
        if not field:
            continue
        operator = normalize_filter_operator(filt.get("operator"))
        normalized.append(
            {
                **filt,
                "field": field,
                "operator": operator,
                "value": normalize_filter_value(operator, filt.get("value")),
            }
        )
    return normalized


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

    if ctype == "BAR_LINE" and not line_metric:
        legacy_breakdown = normalized.get("breakdown")
        if isinstance(legacy_breakdown, str) and legacy_breakdown.strip():
            line_metric = {
                "field": legacy_breakdown.strip(),
                "agg": "sum",
            }

    if line_metric:
        normalized["lineMetric"] = line_metric

    return normalized
