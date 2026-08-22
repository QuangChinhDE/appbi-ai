"""
Shared helpers for chart/query contracts.

These helpers keep live and synced paths aligned without forcing the product
to copy Cube's public API. The goal is stricter internal contracts and better
backward compatibility for saved chart configs.
"""
from __future__ import annotations

import logging
from copy import deepcopy
from datetime import date, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)


def _month_last_day(year: int, month: int) -> date:
    """Last calendar day of a 1-based month."""
    if month == 12:
        return date(year, 12, 31)
    return date(year, month + 1, 1) - timedelta(days=1)


def compute_date_preset_range(preset: str) -> tuple[str, str]:
    """Resolve a relative date preset to a concrete [start, end] YYYY-MM-DD pair
    using the SERVER'S CURRENT date. Python port of the frontend
    ``computeDatePresetRange`` (lib/filters.ts) — the two MUST stay in sync.

    This is what makes a relative filter like "last 30 days" truly relative on
    EVERY consumer (public link, embed, AI bot, PDF worker): the range is
    recomputed at request time instead of being frozen to the build-time window.
    Returns ('', '') for 'custom'/unknown. Weeks are Monday-start (matches FE).
    """
    p = str(preset or "").strip().lower()
    today = datetime.now().date()
    fmt = lambda d: d.isoformat()
    if p == "today":
        return fmt(today), fmt(today)
    if p == "yesterday":
        d = today - timedelta(days=1)
        return fmt(d), fmt(d)
    if p == "this_week":
        start = today - timedelta(days=today.weekday())
        return fmt(start), fmt(start + timedelta(days=6))
    if p == "last_week":
        start = today - timedelta(days=today.weekday() + 7)
        return fmt(start), fmt(start + timedelta(days=6))
    if p == "this_month":
        return fmt(date(today.year, today.month, 1)), fmt(_month_last_day(today.year, today.month))
    if p == "last_month":
        y = today.year if today.month > 1 else today.year - 1
        m = today.month - 1 if today.month > 1 else 12
        return fmt(date(y, m, 1)), fmt(_month_last_day(y, m))
    if p == "this_quarter":
        q = (today.month - 1) // 3
        return fmt(date(today.year, q * 3 + 1, 1)), fmt(_month_last_day(today.year, q * 3 + 3))
    if p == "last_quarter":
        q = (today.month - 1) // 3 - 1
        y = today.year - 1 if q < 0 else today.year
        qn = (q % 4 + 4) % 4
        return fmt(date(y, qn * 3 + 1, 1)), fmt(_month_last_day(y, qn * 3 + 3))
    if p == "this_year":
        return fmt(date(today.year, 1, 1)), fmt(date(today.year, 12, 31))
    if p == "last_year":
        return fmt(date(today.year - 1, 1, 1)), fmt(date(today.year - 1, 12, 31))
    if p == "last_7_days":
        return fmt(today - timedelta(days=6)), fmt(today)
    if p == "last_30_days":
        return fmt(today - timedelta(days=29)), fmt(today)
    if p == "last_90_days":
        return fmt(today - timedelta(days=89)), fmt(today)
    return "", ""


def _summarize_filter(filt: dict[str, Any] | None) -> dict[str, Any]:
    """Phase-15.78 — extract the dropped-filter diagnostic shape from a
    runtime filter dict. Keeps the diagnostic small (no full value blobs)
    so it's safe to forward through the API response."""
    if not isinstance(filt, dict):
        return {}
    return {
        "field": filt.get("field"),
        "semantic_field": filt.get("semanticField") or filt.get("fieldKey"),
        "operator": filt.get("operator"),
    }


def _record_dropped_filter(
    diagnostics: list[dict] | None,
    filt: dict[str, Any] | None,
    reason: str,
    detail: str | None = None,
) -> None:
    """Phase-15.78 — append a structured drop entry to caller-provided
    diagnostics list and emit a WARNING log. Caller passes None when it
    doesn't care (most internal sites); chart-data endpoints pass a list
    and forward it into ChartDebugInfo.dropped_filters."""
    summary = _summarize_filter(filt)
    logger.warning(
        "[filter-drop] reason=%s field=%s semantic=%s op=%s detail=%s",
        reason,
        summary.get("field"),
        summary.get("semantic_field"),
        summary.get("operator"),
        detail or "",
    )
    if diagnostics is None:
        return
    entry = {**summary, "reason": reason}
    if detail:
        entry["detail"] = detail
    diagnostics.append(entry)


# Must stay in sync with the engine's accepted aggregations
# (SemanticQueryEngine._render_measure ``_KNOWN_AGGS``). "percent_of_total" is
# a first-class aggregation there, so normalize must preserve it (not strip it
# to the default) — otherwise an explicit % -of-total override is silently
# lost. "auto" means "defer to the field's declared measure type".
_VALID_AGGS = {"sum", "avg", "count", "min", "max", "count_distinct", "percent_of_total", "auto"}
CHART_QUERY_MODE_GENERATED = "generated"
CHART_QUERY_MODE_CUSTOM = "custom"
_VALID_CHART_QUERY_MODES = {
    CHART_QUERY_MODE_GENERATED,
    CHART_QUERY_MODE_CUSTOM,
}

# Canonical operator vocabulary. Phase-B of the PBI-parity rework
# extends this with date-relative and top-N operators (see
# docs/filter-semantics.md §7). Aliases on the left, canonical key on
# the right. Order does not matter; the lookup is dict-based.
_OPERATOR_MAP = {
    # Scalar equality
    "=": "eq",
    "==": "eq",
    "eq": "eq",
    "!=": "neq",
    "<>": "neq",
    "neq": "neq",
    "ne": "neq",
    # Scalar comparison
    ">": "gt",
    "gt": "gt",
    ">=": "gte",
    "gte": "gte",
    "<": "lt",
    "lt": "lt",
    "<=": "lte",
    "lte": "lte",
    # Pattern
    "like": "like",
    "contains": "contains",
    "not_contains": "not_contains",
    "starts_with": "starts_with",
    "ends_with": "ends_with",
    "matches_regex": "matches_regex",
    # List
    "in": "in",
    "not in": "not_in",
    "not_in": "not_in",
    # Range
    "between": "between",
    "not_between": "not_between",
    # Null-state
    "is_null": "is_null",
    "is null": "is_null",
    "is_not_null": "is_not_null",
    "is not null": "is_not_null",
    # Date — absolute
    "date_eq": "date_eq",
    "date_between": "date_between",
    # Date — relative (FE may also send these; the SQL builder resolves
    # them to absolute date ranges at query time so server clock is the
    # source of truth — see filter-semantics.md §7).
    "date_in_last": "date_in_last",
    "date_this": "date_this",
    "date_to_date": "date_to_date",
    # Measure-only — compiled to ORDER BY + LIMIT, not WHERE/HAVING.
    "top_n": "top_n",
    "bottom_n": "bottom_n",
}

# Phase-B — structured drop reasons. All filter-drop sites should
# pass one of these constants to `_record_dropped_filter()` so the FE
# can render localized messages and the analytics layer can aggregate
# reliably. New reasons go here as additive enum members; never silently
# rename one in use.
FILTER_DROP_NO_FIELD = "no_field"
FILTER_DROP_EMPTY_VALUE = "empty_value"
FILTER_DROP_UNKNOWN_FIELD = "unknown_field"
FILTER_DROP_DATASET_MISMATCH = "dataset_mismatch"
FILTER_DROP_BINDING_UNSUPPORTED = "binding_unsupported"
FILTER_DROP_UNREACHABLE_VIEW = "unreachable_view"
FILTER_DROP_UNSUPPORTED_OPERATOR = "unsupported_operator"
FILTER_DROP_NOT_IN_PUBLIC_WHITELIST = "not_in_public_whitelist"
FILTER_DROP_LINK_HIDDEN = "link_hidden"

KNOWN_FILTER_DROP_REASONS = frozenset({
    FILTER_DROP_NO_FIELD,
    FILTER_DROP_EMPTY_VALUE,
    FILTER_DROP_UNKNOWN_FIELD,
    FILTER_DROP_DATASET_MISMATCH,
    FILTER_DROP_BINDING_UNSUPPORTED,
    FILTER_DROP_UNREACHABLE_VIEW,
    FILTER_DROP_UNSUPPORTED_OPERATOR,
    FILTER_DROP_NOT_IN_PUBLIC_WHITELIST,
    FILTER_DROP_LINK_HIDDEN,
})

# ── STRICT mode (PowerBI parity) — fail-loud filter policy ──────────────
# A drop reason is HARD when it means a COMPLETE, intentional filter could
# not be applied: returning a result computed without it is silently-wrong
# data (the recurring "filter set but chart not filtered / wrong total"
# class). Strict mode refuses to return such a result.
HARD_FILTER_DROP_REASONS = frozenset({
    FILTER_DROP_UNKNOWN_FIELD,
    FILTER_DROP_DATASET_MISMATCH,
    FILTER_DROP_BINDING_UNSUPPORTED,
    FILTER_DROP_UNSUPPORTED_OPERATOR,
})
# SOFT reasons are intentionally tolerated and NEVER raise:
#   • NO_FIELD / EMPTY_VALUE      — half-typed filter; the user isn't done.
#   • NOT_IN_PUBLIC_WHITELIST     — public-link security policy (by design).
#   • LINK_HIDDEN                 — public-link hidden-filter policy.
#   • UNREACHABLE_VIEW            — PowerBI parity (2026-06): a filter on a
#     table with no relationship path to the visual's base is IGNORED, not an
#     error. Crashing here made the same "filter unrelated table" gesture
#     behave inconsistently — loud 400 when the table was disconnected, but a
#     silent ignore when a bridge path existed (the engine's single-direction
#     gate handled that case). We unify on PowerBI's rule: never crash; ignore
#     the filter and surface it as a structured drop (visible skip-badge). The
#     filter is still reported in `_debug.dropped_filters` so it is NOT silent.
_HARD_DROP_HINTS = {
    FILTER_DROP_UNKNOWN_FIELD: "field không tồn tại trong dataset",
    FILTER_DROP_DATASET_MISMATCH: "field thuộc dataset khác",
    FILTER_DROP_BINDING_UNSUPPORTED:
        "không JOIN được tới field này (model/binding chưa sẵn sàng)",
    FILTER_DROP_UNREACHABLE_VIEW:
        "bảng của field không nối được tới bảng gốc của chart",
    FILTER_DROP_UNSUPPORTED_OPERATOR: "toán tử filter không được hỗ trợ",
}


def enforce_no_hard_dropped_filters(diagnostics: list[dict] | None) -> None:
    """STRICT (PowerBI parity) — raise when a complete filter could not be
    applied, instead of silently returning a result computed WITHOUT it.

    Only HARD reasons raise (see ``HARD_FILTER_DROP_REASONS``); soft drops
    (incomplete input, public-link policy) are tolerated. Raises
    ``ValueError`` — the chart-data endpoints map this to HTTP 400 — and
    lists each offending field with a localized reason so the DA can fix
    the chart's field reference / operator or the dataset model.

    Call this immediately after the filter-normalization step on EVERY
    query path (semantic + live) so a dropped filter can never reach the
    SQL builder unannounced.
    """
    if not diagnostics:
        return
    hard = [
        d for d in diagnostics
        if isinstance(d, dict) and d.get("reason") in HARD_FILTER_DROP_REASONS
    ]
    if not hard:
        return
    parts: list[str] = []
    seen: set[tuple] = set()
    for d in hard:
        field = d.get("field") or d.get("semantic_field") or "?"
        reason = d.get("reason")
        key = (field, reason)
        if key in seen:
            continue
        seen.add(key)
        parts.append(f"'{field}' — {_HARD_DROP_HINTS.get(reason, reason)}")
    raise ValueError(
        "Filter không áp được nên engine từ chối trả kết quả (tránh ra số "
        "sai do bỏ filter âm thầm): " + "; ".join(parts) + ". "
        "Hãy sửa field/toán tử của filter hoặc model cho đúng."
    )
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


def normalize_filter_conditions(
    filters: list[dict] | None,
    *,
    diagnostics: list[dict] | None = None,
) -> list[dict]:
    """Drop incomplete filters before they reach the SQL builders.

    Phase-15.78 — when `diagnostics` is provided, every drop is recorded
    there with `reason in {'no_field', 'empty_value'}`. The function
    always emits a WARNING log for the drop regardless of caller. Callers
    that don't care about diagnostics (older sites) just pass nothing
    and keep the original silent-drop ergonomics.

    Phase-G — entries with `type='image'` are decorative children of
    the slicer cluster (logos, etc.). They live in `slicers_config`
    alongside real filter slicers but are NOT query predicates; skip
    them silently so the SQL pipeline never sees them. Doing the skip
    here means every downstream consumer (chart engine, layered merge,
    distinct-values endpoint) inherits the behavior for free.
    """
    normalized: list[dict] = []
    for filt in filters or []:
        if not isinstance(filt, dict):
            # A malformed entry (not an object — a stray string / null / list
            # from a bad save or a hand-crafted request). Skip defensively
            # instead of letting `filt.get(...)` raise AttributeError: this is
            # the shared chokepoint, and in the per-page batch endpoint an
            # exception here would fail EVERY chart on the page, not just the
            # one carrying the bad filter (the "1 bad filter → whole page 500"
            # outage). A soft drop keeps the rest of the page rendering.
            _record_dropped_filter(diagnostics, filt, "no_field", "filter entry is not an object")
            continue
        if str(filt.get("type") or "").lower() == "image":
            # Phase-G — slicer cluster image child, not a filter predicate.
            continue
        field = filt.get("field")
        if not field:
            _record_dropped_filter(diagnostics, filt, "no_field")
            continue
        # Relative date presets ("last_30_days", "this_month", …) are resolved to
        # a concrete [start,end] HERE, at request time, using the server's current
        # date — NOT frozen at build/save. This is the single chokepoint every
        # surface goes through (authed chart-data, public link, embed, AI bot,
        # PDF worker), so all of them see a truly-relative window. The stored
        # `datePreset` token is authoritative; its frozen `value` is ignored.
        raw_value = filt.get("value")
        preset_token = str(filt.get("datePreset") or filt.get("date_preset") or "").strip().lower()
        if preset_token and preset_token != "custom":
            start, end = compute_date_preset_range(preset_token)
            if start or end:
                raw_value = [start, end]
        operator = normalize_filter_operator(filt.get("operator"))
        value = normalize_filter_value(operator, raw_value)
        candidate = {
            **filt,
            "field": field,
            "operator": operator,
            "value": value,
        }
        if not is_filter_condition_active(candidate):
            _record_dropped_filter(
                diagnostics,
                candidate,
                "empty_value",
                "filter has no usable value for its operator",
            )
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


def _filter_dedupe_key(filt: dict[str, Any]) -> tuple[Any, ...]:
    """Phase-15.81 v16 — dedupe key includes the semantic scope (the
    qualified `view.col` ref and the dataset id) on top of `field`.
    Earlier code keyed only on `(field, operator)` which collapsed two
    distinct semantic filters whenever the bare column happened to
    repeat across views (e.g. every fact table in a CRM schema has
    `_extracted_at`). A dashboard-wide Date filter on
    `dataset_table_343._extracted_at` then silently dropped a chart's
    own base filter on `dataset_table_145._extracted_at` because the
    bare names collided, so the saved chart ran without its own
    predicate. Including semanticField/datasetId stops the collision
    while still letting runtime override the SAME semantic filter
    (e.g. viewer narrows the date range further on the same column).

    Phase-B' (PBI-parity rework) — operator REMOVED from the key.
    Reason: the spec (docs/filter-semantics.md §3) says viewer slicer
    OVERRIDES dashboard filter on the same field regardless of the
    operator each layer used. Keeping operator in the key produced a
    silent two-filters-on-same-field bug: dashboard's `eq A` and
    viewer's `in [B]` got DIFFERENT keys → both survived dedupe → SQL
    became `WHERE col = A AND col IN (B)` → empty result. With
    semanticField + datasetId in the key, the bare-name collision the
    v16 fix targeted is still avoided.
    """
    semantic = (
        filt.get("semanticField")
        or filt.get("fieldKey")
        or ""
    )
    return (
        str(semantic).strip().lower(),
        str(filt.get("field") or "").strip().lower(),
        filt.get("datasetId"),
    )


def merge_chart_query_filters(
    config: dict[str, Any] | None,
    extra_filters: list[dict] | None = None,
    context: str | None = None,
) -> list[dict]:
    """Fold the chart's own base filters with incoming runtime filters.

    Single chart_base fold for EVERY chart-data path (calendar, derived,
    physical, custom SQL, semantic, public). Base filters are the chart's
    saved scope; ``extra_filters`` are the runtime overlay (dashboard /
    slicer / public-link filters — for the public path already pre-merged by
    `filter_layered_merge.merge_layered_filters`). On the same semantic scope
    the runtime value WINS over the base (PBI-parity "viewer narrows the
    chart's default"); see `_filter_dedupe_key`.

    NOTE: base-internal duplicates are intentionally PRESERVED (only
    base-vs-extra collisions are deduped). A chart whose base scope is a
    range expressed as two rows on one field (``>= X`` AND ``<= Y``) must
    keep both — the operator-agnostic dedupe key would otherwise collapse
    them. The layered merge dedupes base-internally and so must NOT be used
    for this fold.
    """
    base = list(resolve_chart_query_filters(config, context=context))
    extra = normalize_filter_conditions(extra_filters)
    if not extra:
        return base

    # PBI parity (product decision 2026-05-31): the chart's BASE filters are
    # the author's HARD constraint and AND with the runtime overlay
    # (dashboard / slicer / viewer) — they are NOT overridden by it. A
    # visual-level filter always narrows the visual regardless of the
    # page/dashboard filters layered on top (e.g. base `product_id <= 15` +
    # dashboard `product_id >= 10` → `10 <= product_id <= 15`, not just >= 10).
    # Keep base + extra (AND); drop only byte-identical predicates so the
    # WHERE doesn't carry a redundant duplicate term. (Override semantics for
    # runtime-vs-runtime — viewer narrows dashboard default — are resolved
    # upstream in `filter_layered_merge.merge_layered_filters`, not here.)
    merged = list(base)
    for f in extra:
        if f not in merged:
            merged.append(f)
    return merged


def normalize_metric_config(metric: Any, default_agg: str = "auto") -> dict[str, Any] | None:
    # default_agg is "auto" (NOT "sum"): a metric with no explicit aggregation
    # must DEFER to the field's declared type — the semantic engine renders a
    # declared measure by its stored type (percent_of_total, count_distinct,
    # avg, filtered, formula, …) and only falls back to SUM for a bare numeric
    # COLUMN. Defaulting to "sum" here silently overrode every declared
    # measure's type (a % of total / distinct-count measure rendered as raw
    # SUM) — the metric-identity leak the locked contract forbids.
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


def get_table_hyperlink_url_columns(
    config: dict[str, Any] | None,
    selected_columns: list[str] | None = None,
) -> list[str]:
    """Return URL source columns used by table hyperlink rules.

    Rules are stored as optional presentation config. Invalid entries are
    ignored so older or partially edited chart configs keep working.
    """
    if not isinstance(config, dict):
        return []

    style_config = config.get("styleConfig")
    if not isinstance(style_config, dict):
        return []

    rules = style_config.get("tableHyperlinkRules")
    if not isinstance(rules, list):
        return []

    target_columns = set(selected_columns or [])
    seen: set[str] = set()
    columns: list[str] = []
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        target_column = str(rule.get("targetColumn") or "").strip()
        url_column = str(rule.get("urlColumn") or "").strip()
        if not target_column or not url_column or url_column in seen:
            continue
        if target_columns and target_column not in target_columns:
            continue
        seen.add(url_column)
        columns.append(url_column)
    return columns


def with_table_hyperlink_query_columns(
    chart_type: str,
    role_config: dict | None,
    chart_config: dict[str, Any] | None,
) -> dict[str, Any]:
    """Add hidden URL columns to TABLE runtime role config.

    This only affects query execution. The saved role_config remains unchanged
    so URL source columns do not become visible table columns.
    """
    original = role_config if isinstance(role_config, dict) else {}
    normalized = normalize_chart_role_config(chart_type, role_config)
    ctype = str(getattr(chart_type, "value", chart_type) or "").upper()
    if ctype != "TABLE" or normalized.get("tableMode") == "pivot":
        return original

    selected_columns = normalized.get("selectedColumns")
    if not isinstance(selected_columns, list) or not selected_columns:
        return original

    next_columns = [
        str(column).strip()
        for column in selected_columns
        if str(column or "").strip()
    ]
    seen = set(next_columns)
    appended = False
    for url_column in get_table_hyperlink_url_columns(chart_config, next_columns):
        if url_column not in seen:
            seen.add(url_column)
            next_columns.append(url_column)
            appended = True

    if not appended:
        return original

    next_config = dict(normalized)
    next_config["selectedColumns"] = next_columns
    return next_config
