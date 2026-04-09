"""
CRUD service for charts.
"""
import re
from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.models import Chart, ChartType, ChartMetadata, ChartParameter
from app.schemas import ChartCreate, ChartUpdate
from app.schemas import ChartMetadataUpsert, ChartParameterCreate, ChartParameterUpdate
from app.core.logging import get_logger
from app.services.chart_contracts import (
    get_chart_active_role_config,
    get_chart_custom_sql,
    merge_chart_query_filters,
    normalize_chart_filter_context,
    normalize_chart_role_config,
    normalize_filter_conditions,
    normalize_filter_operator,
    resolve_chart_query_filters,
)
from app.services.chart_semantic_service import with_chart_semantic_binding
from app.services.dataset_calendar_service import (
    build_calendar_duckdb_sql,
    build_calendar_filter_expression,
    get_calendar_settings,
    is_generated_calendar_table,
)
from app.services.dataset_table_sql_service import (
    DatasetTableSqlError,
    build_live_proxy_table_for_dataset_table,
    build_dataset_table_duckdb_query,
    is_derived_table,
)
from app.services.runtime_modes import resolve_dataset_query_mode

logger = get_logger(__name__)


# ── Aggregation push-down helpers ─────────────────────────────────────────────

def _sql_literal(value) -> str:
    """Safely escape a Python value as a SQL literal."""
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        return 'TRUE' if value else 'FALSE'
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def _build_where_clause(filters) -> str:
    """Build a SQL WHERE clause from a list of {field, operator, value} dicts."""
    if not filters:
        return ''
    parts = []
    for f in normalize_filter_conditions(filters):
        field = f.get('field', '')
        op = normalize_filter_operator(f.get('operator'))
        value = f.get('value')
        if not field:
            continue
        calendar_field = str(f.get("calendarField") or f.get("calendar_field") or "").strip()
        calendar_source_field = str(
            f.get("calendarSourceField")
            or f.get("calendar_source_field")
            or field
        ).strip()
        qf = (
            build_calendar_filter_expression(calendar_field, calendar_source_field, "duckdb")
            if calendar_field
            else None
        ) or f'"{field}"'
        if op == 'eq':
            parts.append(f'{qf} = {_sql_literal(value)}')
        elif op == 'neq':
            parts.append(f'{qf} != {_sql_literal(value)}')
        elif op == 'gt':
            parts.append(f'{qf} > {_sql_literal(value)}')
        elif op == 'gte':
            parts.append(f'{qf} >= {_sql_literal(value)}')
        elif op == 'lt':
            parts.append(f'{qf} < {_sql_literal(value)}')
        elif op == 'lte':
            parts.append(f'{qf} <= {_sql_literal(value)}')
        elif op == 'between' and isinstance(value, list) and len(value) >= 2:
            lo, hi = value[0], value[1]
            if lo and hi:
                parts.append(f'{qf} BETWEEN {_sql_literal(lo)} AND {_sql_literal(hi)}')
            elif lo:
                parts.append(f'{qf} >= {_sql_literal(lo)}')
            elif hi:
                parts.append(f'{qf} <= {_sql_literal(hi)}')
        elif op == 'in' and isinstance(value, list):
            vals = ', '.join(_sql_literal(v) for v in value)
            parts.append(f'{qf} IN ({vals})')
        elif op == 'in' and isinstance(value, str) and value:
            # Legacy comma-separated string format
            vals = ', '.join(_sql_literal(v.strip()) for v in value.split(',') if v.strip())
            if vals:
                parts.append(f'{qf} IN ({vals})')
        elif op == 'not_in' and isinstance(value, list):
            vals = ', '.join(_sql_literal(v) for v in value)
            parts.append(f'{qf} NOT IN ({vals})')
        elif op == 'not_in' and isinstance(value, str) and value:
            vals = ', '.join(_sql_literal(v.strip()) for v in value.split(',') if v.strip())
            if vals:
                parts.append(f'{qf} NOT IN ({vals})')
        elif op == 'like' and value is not None:
            esc = str(value).replace("'", "''")
            parts.append(f"{qf} LIKE '%{esc}%'")
        elif op == 'contains' and value is not None:
            esc = str(value).replace("'", "''")
            parts.append(f"{qf} LIKE '%{esc}%'")
        elif op == 'starts_with' and value is not None:
            esc = str(value).replace("'", "''")
            parts.append(f"{qf} LIKE '{esc}%'")
        elif op == 'not_contains' and value is not None:
            esc = str(value).replace("'", "''")
            parts.append(f"{qf} NOT LIKE '%{esc}%'")
        elif op == 'is_null':
            parts.append(f'{qf} IS NULL')
        elif op == 'is_not_null':
            parts.append(f'{qf} IS NOT NULL')
    return ' AND '.join(parts)


def _apply_transformations(view_name: str, transformations) -> str:
    """
    Wrap a DuckDB view name in a CTE that applies server-side transformations
    (add_column, select_columns, rename_columns).  js_formula columns are
    evaluated client-side and are skipped here.

    Returns either the original view_name (no-op) or a subquery string suitable
    for use as a FROM clause, e.g. '(WITH base AS (...) SELECT ...) AS _t'.
    """
    server_transforms = [
        t for t in (transformations or [])
        if t.get('enabled', True) and t.get('type') not in ('js_formula',)
    ]
    if not server_transforms:
        return view_name

    from app.services.transformation_compiler import TransformationCompiler
    compiled_sql, _ = TransformationCompiler.compile_transformations(
        f'SELECT * FROM {view_name}', server_transforms, dialect='duckdb'
    )
    return f'({compiled_sql}) AS _t'


_SIMPLE_SQL_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _quote_duckdb_identifier(value: str) -> str:
    text = str(value)
    return '"' + text.replace('"', '""') + '"'


def _normalize_runtime_filters_for_chart(
    chart_config: dict | None,
    filters: list | None,
    *,
    include_joined_semantic: bool = False,
) -> list[dict]:
    normalized_filters = normalize_filter_conditions(filters)
    if not normalized_filters:
        return []

    binding = (
        chart_config.get("semanticBinding")
        if isinstance(chart_config, dict) and isinstance(chart_config.get("semanticBinding"), dict)
        else {}
    )
    dataset_id = binding.get("datasetId")
    base_view_name = str(binding.get("baseViewName") or "").strip()

    result: list[dict] = []
    for filt in normalized_filters:
        filter_dataset_id = filt.get("datasetId")
        if dataset_id is not None and filter_dataset_id is not None and filter_dataset_id != dataset_id:
            continue

        semantic_field = str(
            filt.get("semanticField")
            or filt.get("fieldKey")
            or ""
        ).strip()
        if not semantic_field or "." not in semantic_field:
            result.append(filt)
            continue

        semantic_view, _semantic_name = semantic_field.split(".", 1)
        if semantic_view == base_view_name:
            result.append(filt)
            continue

        if include_joined_semantic:
            result.append(filt)

    return result


def _render_duckdb_semantic_field_sql(
    field_def: dict,
    field_name: str,
    table_alias: str,
) -> str | None:
    sql_template = str(field_def.get("sql") or field_name).strip()
    if not sql_template or sql_template == "*":
        return None
    if "${TABLE}" in sql_template:
        return sql_template.replace("${TABLE}", table_alias)
    if _SIMPLE_SQL_IDENTIFIER_RE.fullmatch(sql_template):
        return f"{table_alias}.{_quote_duckdb_identifier(sql_template)}"
    return None


def _semantic_view_has_field(semantic_view, field_name: str) -> bool:
    target = str(field_name or "").strip()
    if not target:
        return False
    return any(
        str(item.get("name") or "").strip() == target
        for item in [*(getattr(semantic_view, "dimensions", None) or []), *(getattr(semantic_view, "measures", None) or [])]
    )


def _build_duckdb_relation_for_semantic_view(
    db: Session,
    dataset_obj,
    semantic_view,
) -> str | None:
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource
    from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb

    dataset_table_id = getattr(semantic_view, "dataset_table_id", None)
    if dataset_table_id:
        joined_table = db.query(DatasetTable).filter(DatasetTable.id == dataset_table_id).first()
        if not joined_table:
            return None

        if is_generated_calendar_table(joined_table):
            return f"({build_calendar_duckdb_sql(get_calendar_settings(dataset_obj, enabled_default=False))}) AS _semantic_join"

        if is_derived_table(joined_table):
            try:
                return f"({build_dataset_table_duckdb_query(db, dataset_obj, joined_table)}) AS _semantic_join"
            except DatasetTableSqlError:
                return None

        datasource = db.query(DataSource).filter(DataSource.id == joined_table.datasource_id).first()
        if not datasource:
            return None

        if joined_table.source_kind == "sql_query":
            rewritten = rewrite_sql_for_duckdb(datasource.id, joined_table.source_query or "")
            return f"({rewritten}) AS _semantic_join" if rewritten else None

        if joined_table.source_kind == "physical_table":
            view_name = get_synced_view(datasource.id, joined_table.source_table_name or "")
            return view_name if view_name else None

    sql_table_name = str(getattr(semantic_view, "sql_table_name", "") or "").strip()
    if not sql_table_name:
        return None
    return f"({sql_table_name}) AS _semantic_join" if sql_table_name.startswith("(") else sql_table_name


def _adapt_duckdb_base_table_for_semantic_filters(
    db: Session,
    dataset_obj,
    chart_config: dict | None,
    base_table: str,
    filters: list | None,
) -> tuple[str, list[dict]]:
    normalized_filters = _normalize_runtime_filters_for_chart(
        chart_config,
        filters,
        include_joined_semantic=True,
    )
    if not normalized_filters:
        return base_table, []

    binding = (
        chart_config.get("semanticBinding")
        if isinstance(chart_config, dict) and isinstance(chart_config.get("semanticBinding"), dict)
        else {}
    )
    explore_id = binding.get("exploreId")
    explore_name = str(binding.get("exploreName") or "").strip()
    base_view_name = str(binding.get("baseViewName") or "").strip()
    if not explore_id and not explore_name:
        return base_table, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    from app.models.semantic import SemanticExplore, SemanticView

    explore_query = db.query(SemanticExplore)
    explore = (
        explore_query.filter(SemanticExplore.id == explore_id).first()
        if explore_id
        else explore_query.filter(SemanticExplore.name == explore_name).first()
    )
    if not explore:
        return base_table, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    join_alias_by_view: dict[str, str] = {}
    join_specs: list[dict[str, Any]] = []
    projected_fields: list[dict[str, str]] = []
    effective_filters: list[dict] = []

    join_index = 0
    projection_index = 0

    for filt in normalized_filters:
        semantic_field = str(
            filt.get("semanticField")
            or filt.get("fieldKey")
            or ""
        ).strip()
        if not semantic_field or "." not in semantic_field:
            effective_filters.append(filt)
            continue

        semantic_view_name, semantic_name = semantic_field.split(".", 1)
        if semantic_view_name == base_view_name:
            effective_filters.append(filt)
            continue

        join_def = next(
            (
                join
                for join in (explore.joins or [])
                if str(join.get("view") or "").strip() == semantic_view_name
                and str(join.get("from_view") or base_view_name).strip() == base_view_name
                and join.get("from_column")
                and join.get("to_column")
            ),
            None,
        )
        if not join_def:
            continue

        semantic_view = db.query(SemanticView).filter(SemanticView.name == semantic_view_name).first()
        if not semantic_view:
            continue

        field_def = next(
            (
                item
                for item in [*(semantic_view.dimensions or []), *(semantic_view.measures or [])]
                if str(item.get("name") or "").strip() == semantic_name
            ),
            None,
        )
        if not field_def:
            continue

        join_alias = join_alias_by_view.get(semantic_view_name)
        if join_alias is None:
            join_relation = _build_duckdb_relation_for_semantic_view(db, dataset_obj, semantic_view)
            if not join_relation:
                continue
            join_from_column = str(join_def.get("from_column"))
            join_to_column = str(join_def.get("to_column"))
            if (
                join_to_column
                and not _semantic_view_has_field(semantic_view, join_to_column)
                and _semantic_view_has_field(semantic_view, join_from_column)
            ):
                join_to_column = join_from_column
            join_alias = f"_appbi_sem_join_{join_index}"
            join_index += 1
            join_alias_by_view[semantic_view_name] = join_alias
            join_specs.append(
                {
                    "view": semantic_view_name,
                    "alias": join_alias,
                    "relation": join_relation,
                    "from_column": join_from_column,
                    "to_column": join_to_column,
                }
            )

        rendered_expr = _render_duckdb_semantic_field_sql(field_def, semantic_name, join_alias)
        if not rendered_expr:
            continue

        projection_alias = f"__sem_filter_{projection_index}"
        projection_index += 1
        projected_fields.append(
            {
                "expr": rendered_expr,
                "alias": projection_alias,
            }
        )
        effective_filters.append(
            {
                **filt,
                "field": projection_alias,
            }
        )

    if not join_specs or not projected_fields:
        return base_table, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    select_parts = ['_appbi_base.*']
    select_parts.extend(
        f'{field["expr"]} AS {_quote_duckdb_identifier(field["alias"])}'
        for field in projected_fields
    )
    join_clauses = [
        (
            f'LEFT JOIN (SELECT * FROM {join_spec["relation"]}) AS {join_spec["alias"]} '
            f'ON _appbi_base.{_quote_duckdb_identifier(join_spec["from_column"])} = '
            f'{join_spec["alias"]}.{_quote_duckdb_identifier(join_spec["to_column"])}'
        )
        for join_spec in join_specs
    ]
    enriched_base_table = (
        f'(SELECT {", ".join(select_parts)} '
        f'FROM (SELECT * FROM {base_table}) AS _appbi_base '
        f'{" ".join(join_clauses)}) AS _appbi_semantic'
    )
    return enriched_base_table, effective_filters


def _render_live_semantic_field_sql(
    field_def: dict,
    field_name: str,
    table_alias: str,
) -> str | None:
    sql_template = str(field_def.get("sql") or field_name).strip()
    if not sql_template or sql_template == "*":
        return None
    if "${TABLE}" in sql_template:
        return sql_template.replace("${TABLE}", table_alias)
    if _SIMPLE_SQL_IDENTIFIER_RE.fullmatch(sql_template):
        return f"{table_alias}.{sql_template}"
    return None


def _build_live_relation_for_semantic_view(
    db: Session,
    datasource,
    semantic_view,
) -> str | None:
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource
    from app.services.live_query_service import build_live_base_query_plan

    dataset_table_id = getattr(semantic_view, "dataset_table_id", None)
    if dataset_table_id:
        joined_table = db.query(DatasetTable).filter(DatasetTable.id == dataset_table_id).first()
        if joined_table and not is_derived_table(joined_table):
            joined_datasource = db.query(DataSource).filter(DataSource.id == joined_table.datasource_id).first()
            if joined_datasource and joined_datasource.id == datasource.id:
                try:
                    return build_live_base_query_plan(
                        joined_datasource,
                        joined_table,
                        apply_type_overrides=True,
                    ).sql
                except Exception:
                    logger.debug(
                        "Falling back to semantic sql_table_name for live join view %s",
                        getattr(semantic_view, "name", None),
                        exc_info=True,
                    )

    sql_table_name = str(getattr(semantic_view, "sql_table_name", "") or "").strip()
    return sql_table_name or None


def _wrap_live_sql_relation(relation: str) -> str:
    text = str(relation or "").strip().rstrip(";")
    if not text:
        return text
    lowered = text.lower()
    if text.startswith("("):
        return text
    if lowered.startswith("select ") or lowered.startswith("with "):
        return f"({text})"
    return text


def _adapt_live_sql_for_semantic_filters(
    db: Session,
    datasource,
    db_table,
    chart_config: dict | None,
    filters: list | None,
) -> tuple[str | None, list[dict]]:
    normalized_filters = _normalize_runtime_filters_for_chart(
        chart_config,
        filters,
        include_joined_semantic=True,
    )
    if not normalized_filters:
        return None, []

    binding = (
        chart_config.get("semanticBinding")
        if isinstance(chart_config, dict) and isinstance(chart_config.get("semanticBinding"), dict)
        else {}
    )
    explore_id = binding.get("exploreId")
    explore_name = str(binding.get("exploreName") or "").strip()
    base_view_name = str(binding.get("baseViewName") or "").strip()
    if not explore_id and not explore_name:
        return None, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    from app.models.semantic import SemanticExplore, SemanticView
    from app.services.live_query_service import build_live_base_query_plan

    explore_query = db.query(SemanticExplore)
    explore = (
        explore_query.filter(SemanticExplore.id == explore_id).first()
        if explore_id
        else explore_query.filter(SemanticExplore.name == explore_name).first()
    )
    if not explore:
        return None, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    try:
        base_sql = build_live_base_query_plan(
            datasource,
            db_table,
            apply_type_overrides=True,
        ).sql
    except Exception:
        logger.debug("Failed to build base live SQL for semantic runtime filters", exc_info=True)
        return None, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    join_alias_by_view: dict[str, str] = {}
    join_specs: list[dict[str, Any]] = []
    projected_fields: list[dict[str, str]] = []
    effective_filters: list[dict] = []

    join_index = 0
    projection_index = 0

    for filt in normalized_filters:
        semantic_field = str(
            filt.get("semanticField")
            or filt.get("fieldKey")
            or ""
        ).strip()
        if not semantic_field or "." not in semantic_field:
            effective_filters.append(filt)
            continue

        semantic_view_name, semantic_name = semantic_field.split(".", 1)
        if semantic_view_name == base_view_name:
            effective_filters.append(filt)
            continue

        join_def = next(
            (
                join
                for join in (explore.joins or [])
                if str(join.get("view") or "").strip() == semantic_view_name
                and str(join.get("from_view") or base_view_name).strip() == base_view_name
                and join.get("from_column")
                and join.get("to_column")
            ),
            None,
        )
        if not join_def:
            continue

        semantic_view = db.query(SemanticView).filter(SemanticView.name == semantic_view_name).first()
        if not semantic_view:
            continue

        field_def = next(
            (
                item
                for item in [*(semantic_view.dimensions or []), *(semantic_view.measures or [])]
                if str(item.get("name") or "").strip() == semantic_name
            ),
            None,
        )
        if not field_def:
            continue

        join_alias = join_alias_by_view.get(semantic_view_name)
        if join_alias is None:
            join_relation = _build_live_relation_for_semantic_view(db, datasource, semantic_view)
            if not join_relation:
                continue
            join_from_column = str(join_def.get("from_column"))
            join_to_column = str(join_def.get("to_column"))
            if (
                join_to_column
                and not _semantic_view_has_field(semantic_view, join_to_column)
                and _semantic_view_has_field(semantic_view, join_from_column)
            ):
                join_to_column = join_from_column
            join_alias = f"_appbi_sem_join_{join_index}"
            join_index += 1
            join_alias_by_view[semantic_view_name] = join_alias
            join_specs.append(
                {
                    "view": semantic_view_name,
                    "alias": join_alias,
                    "relation": join_relation,
                    "from_column": join_from_column,
                    "to_column": join_to_column,
                }
            )

        rendered_expr = _render_live_semantic_field_sql(field_def, semantic_name, join_alias)
        if not rendered_expr:
            continue

        projection_alias = f"__sem_filter_{projection_index}"
        projection_index += 1
        projected_fields.append(
            {
                "expr": rendered_expr,
                "alias": projection_alias,
            }
        )
        effective_filters.append(
            {
                **filt,
                "field": projection_alias,
            }
        )

    if not join_specs or not projected_fields:
        return None, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    select_parts = ["_appbi_base.*"]
    select_parts.extend(
        f'{field["expr"]} AS {field["alias"]}'
        for field in projected_fields
    )
    join_clauses = [
        (
            f'LEFT JOIN {_wrap_live_sql_relation(join_spec["relation"])} AS {join_spec["alias"]} '
            f'ON _appbi_base.{join_spec["from_column"]} = {join_spec["alias"]}.{join_spec["to_column"]}'
        )
        for join_spec in join_specs
    ]
    enriched_sql = (
        f'SELECT {", ".join(select_parts)} '
        f'FROM ({base_sql}) AS _appbi_base '
        f'{" ".join(join_clauses)}'
    )
    return enriched_sql, effective_filters


def _wrap_base_table_with_row_order(base_table: str) -> str:
    """Attach a stable row ordinal so grouped charts can preserve source order."""
    return (
        f'(SELECT *, ROW_NUMBER() OVER () AS "__appbi_row_order" '
        f'FROM {base_table}) AS _appbi_ordered'
    )


def _build_agg_query(base_table: str, chart_type: str, role_config: dict, filters: list):
    """
    Build a DuckDB GROUP BY query from chart roleConfig.

    Returns (sql, pre_aggregated):
      pre_aggregated=True  → backend handled aggregation; frontend must skip applyGroupByAgg()
      pre_aggregated=False → fallback SELECT *, frontend does its own aggregation
    """
    if not role_config:
        return f'SELECT * FROM {base_table} LIMIT 1000', False

    ctype = str(getattr(chart_type, 'value', chart_type) or '').upper()
    role_config = normalize_chart_role_config(chart_type, role_config)
    dimension = role_config.get('dimension')
    time_field = role_config.get('timeField')
    metrics = role_config.get('metrics') or []
    breakdown = role_config.get('breakdown')
    line_metric = role_config.get('lineMetric')
    benchmark_metric = role_config.get('benchmarkMetric')
    table_mode = role_config.get('tableMode')
    table_row_dimension = role_config.get('tableRowDimension')
    table_column_dimension = role_config.get('tableColumnDimension')
    table_pivot_metric = role_config.get('tablePivotMetric')
    selected_cols = role_config.get('selectedColumns')

    where_clause = _build_where_clause(filters)
    where_sql = f' WHERE {where_clause}' if where_clause else ''

    # TABLE: optional column selection, capped at 500 rows for HTTP delivery.
    # UI shows at most 50-200 rows; 500 gives headroom without sending MBs of JSON.
    if ctype == 'TABLE':
        if (
            table_mode == 'pivot'
            and table_row_dimension
            and table_column_dimension
            and table_row_dimension != table_column_dimension
            and isinstance(table_pivot_metric, dict)
            and table_pivot_metric.get('field')
        ):
            metric_field = str(table_pivot_metric.get('field'))
            metric_agg = str(table_pivot_metric.get('agg') or 'sum').upper().replace(' ', '_')
            metric_alias = f'"{metric_agg.lower()}__{metric_field}"'
            if metric_agg == 'COUNT_DISTINCT':
                metric_sql = f'COUNT(DISTINCT "{metric_field}") AS {metric_alias}'
            elif metric_agg == 'COUNT':
                metric_sql = f'COUNT("{metric_field}") AS {metric_alias}'
            elif metric_agg == 'AVG':
                metric_sql = f'AVG("{metric_field}") AS {metric_alias}'
            elif metric_agg == 'MIN':
                metric_sql = f'MIN("{metric_field}") AS {metric_alias}'
            elif metric_agg == 'MAX':
                metric_sql = f'MAX("{metric_field}") AS {metric_alias}'
            else:
                metric_sql = f'SUM("{metric_field}") AS {metric_alias}'

            ordered_base_table = _wrap_base_table_with_row_order(base_table)
            inner_sql = (
                f'SELECT "{table_row_dimension}", "{table_column_dimension}", {metric_sql}, '
                f'MIN("__appbi_row_order") AS "__appbi_group_order" '
                f'FROM {ordered_base_table}{where_sql} '
                f'GROUP BY "{table_row_dimension}", "{table_column_dimension}"'
            )
            sql = (
                'SELECT * EXCLUDE ("__appbi_group_order") '
                f'FROM ({inner_sql}) AS _appbi_pivot '
                'ORDER BY "__appbi_group_order" ASC '
                'LIMIT 5000'
            )
            return sql, True

        cols = ', '.join(f'"{c}"' for c in selected_cols) if selected_cols else '*'
        return f'SELECT {cols} FROM {base_table}{where_sql} LIMIT 500', True

    # SCATTER: raw points up to 5 000
    if ctype == 'SCATTER':
        sx, sy = role_config.get('scatterX'), role_config.get('scatterY')
        if sx and sy:
            return f'SELECT "{sx}", "{sy}" FROM {base_table}{where_sql} LIMIT 5000', True
        return f'SELECT * FROM {base_table}{where_sql} LIMIT 5000', True

    # All other chart types: GROUP BY aggregation
    group_field = dimension or time_field
    if not metrics:
        return f'SELECT * FROM {base_table}{where_sql} LIMIT 1000', False
    metric_defs = list(metrics)
    if ctype == 'BAR_LINE' and line_metric:
        metric_defs.append(line_metric)
    if ctype == 'KPI' and benchmark_metric:
        metric_defs.append(benchmark_metric)

    select_parts = []
    group_by_parts = []

    if group_field:
        select_parts.append(f'"{group_field}"')
        group_by_parts.append(f'"{group_field}"')
    if breakdown and ctype != 'BAR_LINE':
        select_parts.append(f'"{breakdown}"')
        group_by_parts.append(f'"{breakdown}"')

    seen_metric_aliases: set[str] = set()
    for m in metric_defs:
        field = m.get('field', '')
        agg = (m.get('agg') or 'sum').upper().replace(' ', '_')
        if not field:
            continue
        alias_name = f'{agg.lower()}__{field}'
        if alias_name in seen_metric_aliases:
            continue
        seen_metric_aliases.add(alias_name)
        if agg == 'COUNT_DISTINCT':
            select_parts.append(f'COUNT(DISTINCT "{field}") AS "count_distinct__{field}"')
        elif agg == 'COUNT':
            select_parts.append(f'COUNT("{field}") AS "count__{field}"')
        elif agg == 'AVG':
            select_parts.append(f'AVG("{field}") AS "avg__{field}"')
        elif agg == 'MIN':
            select_parts.append(f'MIN("{field}") AS "min__{field}"')
        elif agg == 'MAX':
            select_parts.append(f'MAX("{field}") AS "max__{field}"')
        else:  # SUM (default)
            select_parts.append(f'SUM("{field}") AS "sum__{field}"')

    if not select_parts:
        return f'SELECT * FROM {base_table}{where_sql} LIMIT 1000', False

    source_table = _wrap_base_table_with_row_order(base_table) if group_by_parts else base_table
    sql = f"SELECT {', '.join(select_parts)}"
    if group_by_parts:
        sql += ', MIN("__appbi_row_order") AS "__appbi_group_order"'
    sql += f" FROM {source_table}{where_sql}"
    if group_by_parts:
        sql += f" GROUP BY {', '.join(group_by_parts)}"

    if group_by_parts:
        sql = (
            'SELECT * EXCLUDE ("__appbi_group_order") '
            f'FROM ({sql}) AS _appbi_grouped '
            'ORDER BY "__appbi_group_order" ASC'
        )
    sql += " LIMIT 10000"
    return sql, True


def _execute_chart_runtime_for_table(
    db: Session,
    datasource,
    db_table,
    chart_type,
    chart_config: dict | None = None,
    *,
    extra_filters: list | None = None,
    filter_context: str | None = None,
) -> Dict[str, Any]:
    """Execute chart runtime against a dataset table using the shared chart contract."""
    from app.services.live_query_service import LiveQueryService
    from app.models.dataset import Dataset

    filter_context = normalize_chart_filter_context(filter_context)
    chart_config = chart_config or {}
    role_config = get_chart_active_role_config(chart_config)
    filters = resolve_chart_query_filters(chart_config, filter_context)
    custom_sql = get_chart_custom_sql(chart_config)
    raw_extra_filters = list(extra_filters or [])
    normalized_extra_filters = _normalize_runtime_filters_for_chart(chart_config, extra_filters)
    dataset_obj = None

    if is_generated_calendar_table(db_table) or is_derived_table(db_table):
        dataset_obj = db.query(Dataset).filter(Dataset.id == db_table.dataset_id).first()
        if dataset_obj is None:
            raise ValueError("Dataset not found")
    elif raw_extra_filters:
        dataset_obj = db.query(Dataset).filter(Dataset.id == db_table.dataset_id).first()

    if is_generated_calendar_table(db_table):
        from app.services.duckdb_engine import DuckDBEngine

        base_table = f"({build_calendar_duckdb_sql(get_calendar_settings(dataset_obj, enabled_default=False))}) AS _calendar"
        all_filters = merge_chart_query_filters(
            chart_config,
            extra_filters=normalized_extra_filters,
            context=filter_context,
        )
        agg_sql, pre_agg = _build_agg_query(base_table, chart_type, role_config, all_filters)
        rows = DuckDBEngine.query(agg_sql)
        return {"data": rows, "pre_aggregated": pre_agg}

    if custom_sql:
        if datasource is None:
            raise ValueError("Custom SQL charts require a datasource-backed table")
        return LiveQueryService.execute_chart_query_from_sql(
            datasource,
            chart_type,
            role_config,
            filters,
            custom_sql,
            extra_filters=normalized_extra_filters,
        )

    query_mode = resolve_dataset_query_mode(db_table)
    if query_mode == 'live':
        live_sql, live_filters = _adapt_live_sql_for_semantic_filters(
            db,
            datasource,
            db_table,
            chart_config,
            raw_extra_filters,
        )
        if live_sql:
            return LiveQueryService.execute_chart_query_from_sql(
                datasource,
                chart_type,
                role_config,
                filters,
                live_sql,
                extra_filters=live_filters,
            )
        return LiveQueryService.execute_chart_query(
            datasource,
            db_table,
            chart_type,
            role_config,
            filters,
            extra_filters=normalized_extra_filters,
        )

    from app.services.duckdb_engine import DuckDBEngine
    from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb

    all_filters = merge_chart_query_filters(
        chart_config,
        extra_filters=raw_extra_filters,
        context=filter_context,
    )

    if is_derived_table(db_table):
        try:
            base_table = f"({build_dataset_table_duckdb_query(db, dataset_obj, db_table)}) AS _q"
            base_table, all_filters = _adapt_duckdb_base_table_for_semantic_filters(
                db,
                dataset_obj,
                chart_config,
                base_table,
                all_filters,
            )
            agg_sql, pre_agg = _build_agg_query(base_table, chart_type, role_config, all_filters)
            rows = DuckDBEngine.query(agg_sql)
            return {"data": rows, "pre_aggregated": pre_agg}
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") == "NOT_SYNCED":
                try:
                    live_datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                        db,
                        dataset_obj,
                        db_table,
                    )
                    live_sql, live_filters = _adapt_live_sql_for_semantic_filters(
                        db,
                        live_datasource,
                        live_proxy_table,
                        chart_config,
                        raw_extra_filters,
                    )
                    if live_sql:
                        return LiveQueryService.execute_chart_query_from_sql(
                            live_datasource,
                            chart_type,
                            role_config,
                            filters,
                            live_sql,
                            extra_filters=live_filters,
                        )
                    return LiveQueryService.execute_chart_query(
                        live_datasource,
                        live_proxy_table,
                        chart_type,
                        role_config,
                        filters,
                        extra_filters=normalized_extra_filters,
                    )
                except DatasetTableSqlError as live_exc:
                    raise ValueError(str(live_exc)) from live_exc
            raise ValueError(str(exc)) from exc

    if db_table.source_kind == "sql_query":
        if not db_table.source_query:
            raise ValueError("Table has no SQL query")
        rewritten = rewrite_sql_for_duckdb(datasource.id, db_table.source_query)
        if rewritten:
            try:
                base_table = f"({rewritten}) AS _q"
                base_table, all_filters = _adapt_duckdb_base_table_for_semantic_filters(
                    db,
                    dataset_obj,
                    chart_config,
                    base_table,
                    all_filters,
                )
                agg_sql, pre_agg = _build_agg_query(base_table, chart_type, role_config, all_filters)
                rows = DuckDBEngine.query(agg_sql)
                return {"data": rows, "pre_aggregated": pre_agg}
            except Exception:
                logger.debug("DuckDB agg query failed, falling back to live query", exc_info=True)
        live_sql, live_filters = _adapt_live_sql_for_semantic_filters(
            db,
            datasource,
            db_table,
            chart_config,
            raw_extra_filters,
        )
        if live_sql:
            return LiveQueryService.execute_chart_query_from_sql(
                datasource,
                chart_type,
                role_config,
                filters,
                live_sql,
                extra_filters=live_filters,
            )
        return LiveQueryService.execute_chart_query(
            datasource,
            db_table,
            chart_type,
            role_config,
            filters,
            extra_filters=normalized_extra_filters,
        )

    if db_table.source_kind == "physical_table":
        if not db_table.source_table_name:
            raise ValueError("Table has no physical table name")
        view_name = get_synced_view(datasource.id, db_table.source_table_name)
        if view_name:
            base_table = _apply_transformations(view_name, db_table.transformations)
            base_table, all_filters = _adapt_duckdb_base_table_for_semantic_filters(
                db,
                dataset_obj,
                chart_config,
                base_table,
                all_filters,
            )
            agg_sql, pre_agg = _build_agg_query(base_table, chart_type, role_config, all_filters)
            rows = DuckDBEngine.query(agg_sql)
            return {"data": rows, "pre_aggregated": pre_agg}
        live_sql, live_filters = _adapt_live_sql_for_semantic_filters(
            db,
            datasource,
            db_table,
            chart_config,
            raw_extra_filters,
        )
        if live_sql:
            return LiveQueryService.execute_chart_query_from_sql(
                datasource,
                chart_type,
                role_config,
                filters,
                live_sql,
                extra_filters=live_filters,
            )
        return LiveQueryService.execute_chart_query(
            datasource,
            db_table,
            chart_type,
            role_config,
            filters,
            extra_filters=normalized_extra_filters,
        )

    raise ValueError(f"Unsupported source_kind: {db_table.source_kind}")


class ChartService:
    """Service for chart operations."""

    @staticmethod
    def hydrate_runtime_config(
        db: Session,
        chart: Chart | None,
        auto_generate: bool = True,
    ) -> Chart | None:
        """Attach derived semantic binding for response-time consumers."""
        if not chart:
            return chart
        next_config = with_chart_semantic_binding(
            db,
            chart.dataset_table_id,
            chart.config,
            auto_generate=auto_generate,
        )
        if next_config != (chart.config or {}):
            chart.config = next_config
        return chart
    
    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[Chart]:
        """Get all charts with pagination."""
        charts = db.query(Chart).offset(skip).limit(limit).all()
        for chart in charts:
            ChartService.hydrate_runtime_config(db, chart)
        return charts
    
    @staticmethod
    def get_by_id(db: Session, chart_id: int) -> Optional[Chart]:
        """Get a chart by ID."""
        chart = db.query(Chart).filter(Chart.id == chart_id).first()
        return ChartService.hydrate_runtime_config(db, chart)
    
    @staticmethod
    def get_by_name(db: Session, name: str) -> Optional[Chart]:
        """Get a chart by name."""
        return db.query(Chart).filter(Chart.name == name).first()
    
    @staticmethod
    def create(db: Session, chart: ChartCreate, owner_id=None) -> Chart:
        """Create a new chart."""
        if chart.dataset_table_id is not None:
            # Verify dataset table exists
            from app.services.dataset_crud import DatasetCRUDService
            table = DatasetCRUDService.get_table_by_id(db, chart.dataset_table_id)
            if not table:
                raise ValueError(f"Dataset table with ID {chart.dataset_table_id} not found")

        try:
            db_chart = Chart(
                name=chart.name,
                description=chart.description,
                dataset_table_id=chart.dataset_table_id,
                chart_type=ChartType(chart.chart_type.value),
                config=with_chart_semantic_binding(
                    db,
                    chart.dataset_table_id,
                    chart.config,
                    auto_generate=True,
                ),
                owner_id=owner_id,
            )
            db.add(db_chart)
            db.commit()
            db.refresh(db_chart)
            logger.info(f"Created chart: {chart.name}")
            return db_chart
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Chart with name '{chart.name}' already exists")
    
    @staticmethod
    def update(
        db: Session,
        chart_id: int,
        chart_update: ChartUpdate
    ) -> Optional[Chart]:
        """Update a chart."""
        db_chart = ChartService.get_by_id(db, chart_id)
        if not db_chart:
            return None
        
        try:
            update_data = chart_update.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                if field == "chart_type" and value:
                    setattr(db_chart, field, ChartType(value.value))
                else:
                    setattr(db_chart, field, value)

            if "config" in update_data or "dataset_table_id" in update_data:
                db_chart.config = with_chart_semantic_binding(
                    db,
                    db_chart.dataset_table_id,
                    db_chart.config,
                    auto_generate=True,
                )
            
            db.commit()
            db.refresh(db_chart)
            logger.info(f"Updated chart: {db_chart.name}")
            return ChartService.hydrate_runtime_config(db, db_chart)
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Chart with name '{chart_update.name}' already exists")
    
    @staticmethod
    def delete(db: Session, chart_id: int) -> bool:
        """Delete a chart."""
        db_chart = ChartService.get_by_id(db, chart_id)
        if not db_chart:
            return False
        
        db.delete(db_chart)
        db.commit()
        logger.info(f"Deleted chart: {db_chart.name}")
        return True
    
    @staticmethod
    def get_chart_data(
        db: Session,
        chart_id: int,
        extra_filters: list | None = None,
        filter_context: str | None = None,
    ):
        """Get chart configuration with data."""
        db_chart = ChartService.get_by_id(db, chart_id)
        if not db_chart:
            raise ValueError(f"Chart with ID {chart_id} not found")

        # Prefer direct dataset_table_id FK over config-embedded source
        if db_chart.dataset_table_id is not None:
            from app.services.dataset_crud import DatasetCRUDService
            from app.models.models import DataSource

            db_table = DatasetCRUDService.get_table_by_id(db, db_chart.dataset_table_id)
            if not db_table:
                raise ValueError("Dataset table not found")

            datasource = None
            if not is_generated_calendar_table(db_table) and not is_derived_table(db_table):
                datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
                if not datasource:
                    raise ValueError("Data source not found")

            result = _execute_chart_runtime_for_table(
                db,
                datasource,
                db_table,
                db_chart.chart_type,
                db_chart.config or {},
                extra_filters=extra_filters,
                filter_context=filter_context,
            )

            return {
                "chart": db_chart,
                "data": result["data"],
                "pre_aggregated": result["pre_aggregated"],
            }

        # Fallback: check config for legacy dataset_table source
        config = db_chart.config or {}
        if isinstance(config, dict) and config.get('source', {}).get('kind') == 'dataset_table':
            from app.services.dataset_crud import DatasetCRUDService
            from app.models.models import DataSource

            dataset_id = config['source'].get('datasetId')
            table_id = config['source'].get('tableId')

            if not dataset_id or not table_id:
                raise ValueError("Invalid dataset table source in chart config")

            db_table = DatasetCRUDService.get_table_by_id(db, table_id)
            if not db_table or db_table.dataset_id != dataset_id:
                raise ValueError("Table not found in dataset")

            datasource = None
            if not is_generated_calendar_table(db_table) and not is_derived_table(db_table):
                datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
                if not datasource:
                    raise ValueError("Data source not found")

            result = _execute_chart_runtime_for_table(
                db,
                datasource,
                db_table,
                db_chart.chart_type,
                db_chart.config or {},
                extra_filters=extra_filters,
                filter_context=filter_context,
            )

            return {
                "chart": db_chart,
                "data": result["data"],
                "pre_aggregated": result["pre_aggregated"],
            }

        raise ValueError("Chart has no data source configured")

    @staticmethod
    def preview_chart_data(
        db: Session,
        dataset_table_id: int,
        chart_type,
        chart_config: dict | None = None,
        *,
        extra_filters: list | None = None,
        filter_context: str | None = None,
        include_source_sample: bool = False,
        source_sample_limit: int = 100,
    ) -> Dict[str, Any]:
        """Preview chart runtime for Explore using the same execution path as saved charts."""
        from app.models.models import DataSource
        from app.services.dataset_crud import DatasetCRUDService

        db_table = DatasetCRUDService.get_table_by_id(db, dataset_table_id)
        if not db_table:
            raise ValueError(f"Dataset table with ID {dataset_table_id} not found")

        datasource = None
        if not is_generated_calendar_table(db_table) and not is_derived_table(db_table):
            datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
            if not datasource:
                raise ValueError("Data source not found")

        config = chart_config or {}
        custom_sql = get_chart_custom_sql(config)
        normalized_role_config = normalize_chart_role_config(
            chart_type,
            get_chart_active_role_config(config),
        )
        normalized_chart_type = str(getattr(chart_type, "value", chart_type) or "").upper()
        preview: Dict[str, Any] = {
            "data": [],
            "pre_aggregated": False,
        }

        if include_source_sample and custom_sql:
            from app.services.datasource_service import DataSourceConnectionService

            ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
            timeout = 60 if ds_type == "bigquery" else 30
            source_columns, source_rows, source_execution_time_ms = DataSourceConnectionService.execute_query(
                ds_type,
                datasource.config,
                custom_sql,
                limit=source_sample_limit,
                timeout_seconds=timeout,
                skip_bigquery_cost_check=True,
            )
            preview["source_columns"] = source_columns
            preview["source_rows"] = source_rows
            if source_execution_time_ms is not None:
                preview["execution_time_ms"] = source_execution_time_ms

            # In Custom SQL mode, the first Run should always be able to return
            # the SQL output sample even before the user picks a chart value column.
            if normalized_chart_type not in {"TABLE", "SCATTER"} and not (normalized_role_config.get("metrics") or []):
                return preview

        result = _execute_chart_runtime_for_table(
            db,
            datasource,
            db_table,
            chart_type,
            config,
            extra_filters=extra_filters,
            filter_context=filter_context,
        )

        preview["data"] = result["data"]
        preview["pre_aggregated"] = result["pre_aggregated"]
        if result.get("execution_time_ms") is not None:
            preview["execution_time_ms"] = result["execution_time_ms"]

        return preview

    # -----------------------------------------------------------------------
    # Metadata CRUD
    # -----------------------------------------------------------------------

    @staticmethod
    def upsert_metadata(db: Session, chart_id: int, data: ChartMetadataUpsert) -> ChartMetadata:
        """Create or replace semantic metadata for a chart."""
        existing = db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()
        if existing:
            for field, value in data.model_dump(exclude_unset=False).items():
                setattr(existing, field, value)
            db.commit()
            db.refresh(existing)
            return existing
        new_meta = ChartMetadata(
            chart_id=chart_id,
            domain=data.domain,
            intent=data.intent,
            metrics=data.metrics or [],
            dimensions=data.dimensions or [],
            tags=data.tags or [],
        )
        db.add(new_meta)
        db.commit()
        db.refresh(new_meta)
        return new_meta

    @staticmethod
    def get_metadata(db: Session, chart_id: int) -> Optional[ChartMetadata]:
        """Get metadata for a chart."""
        return db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()

    @staticmethod
    def delete_metadata(db: Session, chart_id: int) -> bool:
        """Delete metadata for a chart."""
        existing = db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()
        if not existing:
            return False
        db.delete(existing)
        db.commit()
        return True

    # -----------------------------------------------------------------------
    # Parameter CRUD
    # -----------------------------------------------------------------------

    @staticmethod
    def get_parameters(db: Session, chart_id: int) -> List[ChartParameter]:
        """Get all parameter definitions for a chart."""
        return db.query(ChartParameter).filter(ChartParameter.chart_id == chart_id).all()

    @staticmethod
    def replace_parameters(db: Session, chart_id: int, params: List[ChartParameterCreate]) -> List[ChartParameter]:
        """Replace all parameter definitions for a chart (bulk upsert)."""
        db.query(ChartParameter).filter(ChartParameter.chart_id == chart_id).delete()
        new_params = [
            ChartParameter(
                chart_id=chart_id,
                parameter_name=p.parameter_name,
                parameter_type=p.parameter_type,
                column_mapping=p.column_mapping,
                default_value=p.default_value,
                description=p.description,
            )
            for p in params
        ]
        db.add_all(new_params)
        db.commit()
        for p in new_params:
            db.refresh(p)
        return new_params

    @staticmethod
    def add_parameter(db: Session, chart_id: int, data: ChartParameterCreate) -> ChartParameter:
        """Add a single parameter definition to a chart."""
        param = ChartParameter(
            chart_id=chart_id,
            parameter_name=data.parameter_name,
            parameter_type=data.parameter_type,
            column_mapping=data.column_mapping,
            default_value=data.default_value,
            description=data.description,
        )
        db.add(param)
        db.commit()
        db.refresh(param)
        return param

    @staticmethod
    def update_parameter(
        db: Session, chart_id: int, param_id: int, data: ChartParameterUpdate
    ) -> Optional[ChartParameter]:
        """Update a parameter definition."""
        param = db.query(ChartParameter).filter(
            ChartParameter.id == param_id,
            ChartParameter.chart_id == chart_id,
        ).first()
        if not param:
            return None
        for field, value in data.model_dump(exclude_unset=True).items():
            setattr(param, field, value)
        db.commit()
        db.refresh(param)
        return param

    @staticmethod
    def delete_parameter(db: Session, chart_id: int, param_id: int) -> bool:
        """Delete a parameter definition."""
        param = db.query(ChartParameter).filter(
            ChartParameter.id == param_id,
            ChartParameter.chart_id == chart_id,
        ).first()
        if not param:
            return False
        db.delete(param)
        db.commit()
        return True
