"""
CRUD service for charts.
"""
import re
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func

from app.models import Chart, ChartType, ChartMetadata, ChartParameter
from app.schemas import ChartCreate, ChartUpdate
from app.schemas import ChartMetadataUpsert, ChartParameterCreate, ChartParameterUpdate
from app.core.logging import get_logger
from app.services.chart_contracts import (
    get_chart_active_role_config,
    get_chart_custom_sql,
    merge_chart_query_filters,
    normalize_chart_filter_context,
    normalize_filter_conditions,
    resolve_chart_query_filters,
)
from app.services.chart_semantic_service import (
    resolve_chart_semantic_binding,
    with_chart_semantic_binding,
)
from app.services.dataset_calendar_service import (
    build_calendar_live_sql,
    get_calendar_settings,
    is_generated_calendar_table,
)
import app.services.dataset_table_sql_service as dataset_table_sql_service
from app.services.dataset_table_sql_service import (
    DatasetTableSqlError,
    build_live_proxy_table_for_dataset_table,
    is_derived_table,
)

logger = get_logger(__name__)


_SIMPLE_SQL_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _normalize_chart_name(name: str | None) -> str:
    return str(name or "").strip().lower()


def _find_chart_name_conflict(
    db: Session,
    name: str | None,
    *,
    owner_id=None,
    exclude_chart_id: int | None = None,
) -> Chart | None:
    normalized = _normalize_chart_name(name)
    if not normalized:
        return None

    query = db.query(Chart).filter(
        func.lower(func.trim(Chart.name)) == normalized,
    )
    if owner_id is None:
        query = query.filter(Chart.owner_id.is_(None))
    else:
        query = query.filter(Chart.owner_id == owner_id)
    if exclude_chart_id is not None:
        query = query.filter(Chart.id != exclude_chart_id)
    return query.first()


def _semantic_field_is_supported_by_binding(
    binding: dict[str, Any],
    semantic_field: str,
) -> bool:
    semantic_ref = str(semantic_field or "").strip()
    if not semantic_ref or "." not in semantic_ref:
        return True

    # Reachable set is computed via multi-hop BFS over the semantic model's
    # join graph (see semantic_join_resolver). A field is supported if it
    # belongs to a view reachable from this chart's base view via joins, OR
    # it appears in the explicit chart bindings (dimensionFields, fieldMap,
    # calendar mappings).
    reachable_fields = {
        str(value).strip()
        for value in (binding.get("reachableFields") or [])
        if str(value or "").strip()
    }
    reachable_views = {
        str(value).strip()
        for value in (binding.get("reachableViews") or [])
        if str(value or "").strip()
    }
    if semantic_ref in reachable_fields:
        return True
    semantic_view, _ = semantic_ref.split(".", 1)
    if semantic_view in reachable_views:
        return True

    supported_fields = {
        str(value).strip()
        for value in [
            *(binding.get("dimensionFields") or []),
            *(binding.get("measureFields") or []),
            *((binding.get("fieldMap") or {}).values()),
            *[
                mapping.get("semanticField")
                for mapping in (binding.get("calendarFieldMappings") or [])
                if isinstance(mapping, dict)
            ],
        ]
        if str(value or "").strip()
    }
    if semantic_ref in supported_fields:
        return True

    base_view_name = str(binding.get("baseViewName") or "").strip()
    return bool(base_view_name and semantic_ref.startswith(f"{base_view_name}."))


def _resolve_legacy_calendar_filter_for_binding(
    binding: dict[str, Any],
    field_name: str,
) -> dict[str, str] | None:
    target = str(field_name or "").strip()
    if not target:
        return None

    source_fields = sorted(
        {
            str(mapping.get("sourceField") or "").strip()
            for mapping in (binding.get("calendarFieldMappings") or [])
            if isinstance(mapping, dict)
            and str(mapping.get("calendarField") or "").strip() == target
            and str(mapping.get("sourceField") or "").strip()
        }
    )
    if len(source_fields) != 1:
        return None

    source_field = source_fields[0]
    return {
        "field": source_field,
        "calendarField": target,
        "calendarSourceField": source_field,
    }


def _plain_field_is_supported_by_binding(
    binding: dict[str, Any],
    field_name: str,
) -> bool:
    target = str(field_name or "").strip()
    if not target:
        return False

    base_view_name = str(binding.get("baseViewName") or "").strip()
    mapped_field_names = {
        str(key).strip()
        for key in (binding.get("fieldMap") or {}).keys()
        if str(key or "").strip()
    }
    calendar_source_fields = {
        str(mapping.get("sourceField") or "").strip()
        for mapping in (binding.get("calendarFieldMappings") or [])
        if isinstance(mapping, dict) and str(mapping.get("sourceField") or "").strip()
    }
    supported_semantic_fields = {
        str(value).strip()
        for value in [
            *(binding.get("dimensionFields") or []),
            *(binding.get("measureFields") or []),
            *((binding.get("fieldMap") or {}).values()),
            *[
                mapping.get("semanticField")
                for mapping in (binding.get("calendarFieldMappings") or [])
                if isinstance(mapping, dict)
            ],
        ]
        if str(value or "").strip()
    }

    if target in mapped_field_names or target in calendar_source_fields:
        return True
    if base_view_name and f"{base_view_name}.{target}" in supported_semantic_fields:
        return True

    has_binding_scope = bool(
        mapped_field_names
        or calendar_source_fields
        or supported_semantic_fields
    )
    return not has_binding_scope


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
        if semantic_field and "." in semantic_field and not _semantic_field_is_supported_by_binding(binding, semantic_field):
            continue

        if not semantic_field or "." not in semantic_field:
            legacy_calendar_filter = _resolve_legacy_calendar_filter_for_binding(binding, filt.get("field"))
            if legacy_calendar_filter is not None:
                result.append(
                    {
                        **filt,
                        **legacy_calendar_filter,
                    }
                )
                continue

            if not _plain_field_is_supported_by_binding(binding, filt.get("field")):
                continue
            result.append(filt)
            continue

        semantic_view, _semantic_name = semantic_field.split(".", 1)
        if semantic_view == base_view_name:
            result.append(filt)
            continue

        if include_joined_semantic:
            # Only forward joined-view filters when the target view is
            # actually reachable from this chart's base view via the
            # semantic model's join graph. The SQL adapter will resolve
            # the actual join chain.
            reachable_views = {
                str(v).strip()
                for v in (binding.get("reachableViews") or [])
                if str(v or "").strip()
            }
            if reachable_views and semantic_view not in reachable_views:
                continue
            result.append(filt)

    return result


def _semantic_view_has_field(semantic_view, field_name: str) -> bool:
    target = str(field_name or "").strip()
    if not target:
        return False
    return any(
        str(item.get("name") or "").strip() == target
        for item in [*(getattr(semantic_view, "dimensions", None) or []), *(getattr(semantic_view, "measures", None) or [])]
    )


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
        if not joined_table:
            pass
        elif is_generated_calendar_table(joined_table) or is_derived_table(joined_table):
            from app.models.dataset import Dataset

            dataset_obj = db.query(Dataset).filter(Dataset.id == joined_table.dataset_id).first()
            if dataset_obj is None:
                return None
            try:
                _, live_proxy_table = build_live_proxy_table_for_dataset_table(
                    db,
                    dataset_obj,
                    joined_table,
                )
                return getattr(live_proxy_table, "source_query", None)
            except DatasetTableSqlError:
                pass
        else:
            joined_datasource = db.query(DataSource).filter(DataSource.id == joined_table.datasource_id).first()
            if joined_datasource and joined_datasource.id == datasource.id:
                try:
                    # Specialty: semantic view definition is shared across
                    # consumers, so it must NOT bake in this dataset's casts.
                    # Type overrides will be applied by the consumer's chart
                    # query when it wraps this view. Do NOT route through
                    # resolve_dataset_table_relation here.
                    return build_live_base_query_plan(
                        joined_datasource,
                        joined_table,
                        apply_type_overrides=False,
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


def _render_live_join_condition(
    join_def: dict[str, Any],
    join_alias: str,
    *,
    base_alias: str = "_appbi_base",
) -> str | None:
    sql_on = str(join_def.get("sql_on") or "").strip()
    join_view = str(join_def.get("view") or "").strip()
    if sql_on and join_view:
        return (
            sql_on
            .replace("${TABLE}", base_alias)
            .replace(f"${{{join_view}}}", join_alias)
        )

    join_from_column = str(join_def.get("from_column") or "").strip()
    join_to_column = str(join_def.get("to_column") or "").strip()
    if join_from_column and join_to_column:
        return f"{base_alias}.{join_from_column} = {join_alias}.{join_to_column}"
    return None


def _render_step_join_condition(
    edge,
    *,
    from_alias: str,
    to_alias: str,
) -> str | None:
    """Render a JOIN ON condition for a JoinEdge between two SQL aliases.

    Prefers the raw `sql_on` template when present (replacing ${TABLE} →
    from_alias and ${view} / ${alias} → to_alias). Falls back to
    from_column/to_column equality when the template is absent.
    """
    sql_on = str(edge.sql_on or "").strip()
    if sql_on:
        rendered = sql_on.replace("${TABLE}", from_alias)
        # Replace alias-keyed placeholder (preferred when role-played) and
        # the raw view-keyed placeholder (legacy joins).
        if edge.to_node and edge.to_node != edge.to_view:
            rendered = rendered.replace(f"${{{edge.to_node}}}", to_alias)
        rendered = rendered.replace(f"${{{edge.to_view}}}", to_alias)
        return rendered

    if edge.from_column and edge.to_column:
        return f"{from_alias}.{edge.from_column} = {to_alias}.{edge.to_column}"
    return None


def _adapt_live_sql_for_semantic_filters(
    db: Session,
    datasource,
    db_table,
    chart_config: dict | None,
    filters: list | None,
) -> tuple[str | None, list[dict]]:
    """Wrap base SQL with multi-hop joins so dashboard filters that target
    fields on joined views can be applied.

    Strategy:
    1. For each filter referencing a joined view (`alias.field`), use the
       SemanticJoinResolver to compute a join path from base_view to the
       target node.
    2. Materialize each unique step in the chain as a LEFT JOIN with a
       deterministic SQL alias.
    3. Project the target field as `__sem_filter_N` on the wrapping SELECT
       and rewrite the filter to reference that projection alias.
    """
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
    base_view_name = str(binding.get("baseViewName") or "").strip()
    model_id = binding.get("modelId")
    if not base_view_name:
        return None, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    from app.models.semantic import SemanticModel, SemanticView
    from app.services.dataset_relation_service import resolve_dataset_table_relation
    from app.services.semantic_join_resolver import SemanticJoinResolver

    model = (
        db.query(SemanticModel).filter(SemanticModel.id == model_id).first()
        if model_id
        else None
    )
    resolver = SemanticJoinResolver(db, model, base_view_name)

    try:
        base_sql = resolve_dataset_table_relation(datasource, db_table).sql
    except Exception:
        logger.debug("Failed to build base live SQL for semantic runtime filters", exc_info=True)
        return None, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    # Track materialized join steps. Key = (from_alias_sql, to_node) so that
    # a path of length N spawns N JOINs but two filters that share a prefix
    # reuse them (e.g. orders → customers → addresses, plus another filter
    # on customers.country reuses the customers join).
    materialized_steps: dict[tuple[str, str], str] = {}
    join_clauses: list[str] = []
    projected_fields: list[dict[str, str]] = []
    effective_filters: list[dict] = []
    next_join_index = 0
    next_projection_index = 0

    # cache SemanticView lookups
    view_cache: dict[str, SemanticView | None] = {}

    def _get_view(view_name: str) -> SemanticView | None:
        if view_name in view_cache:
            return view_cache[view_name]
        result = db.query(SemanticView).filter(SemanticView.name == view_name).first()
        view_cache[view_name] = result
        return result

    for filt in normalized_filters:
        semantic_field = str(
            filt.get("semanticField")
            or filt.get("fieldKey")
            or ""
        ).strip()
        if not semantic_field or "." not in semantic_field:
            effective_filters.append(filt)
            continue

        target_node, semantic_name = semantic_field.split(".", 1)
        if target_node == base_view_name:
            effective_filters.append(filt)
            continue

        path = resolver.resolve_path(target_node)
        if path is None:
            # not reachable — skip this filter for this chart
            continue

        # Materialize each step. Use stable alias based on path prefix so
        # shared prefixes reuse the same JOIN.
        prev_alias = "_appbi_base"
        last_alias = prev_alias
        path_failed = False
        for step in path.steps:
            cache_key = (prev_alias, step.edge.to_node)
            existing_alias = materialized_steps.get(cache_key)
            if existing_alias is not None:
                last_alias = existing_alias
                prev_alias = existing_alias
                continue

            joined_view = _get_view(step.edge.to_view)
            if joined_view is None:
                path_failed = True
                break
            relation = _build_live_relation_for_semantic_view(db, datasource, joined_view)
            if not relation:
                path_failed = True
                break

            new_alias = f"_appbi_sem_join_{next_join_index}"
            next_join_index += 1
            condition = _render_step_join_condition(
                step.edge,
                from_alias=prev_alias,
                to_alias=new_alias,
            )
            # Validate the to_column actually exists; rebuild if necessary.
            to_col = step.edge.to_column
            if condition and to_col and not _semantic_view_has_field(joined_view, to_col):
                # try fallback: maybe to_column is misnamed but from_column exists
                from_col = step.edge.from_column
                if from_col and _semantic_view_has_field(joined_view, from_col):
                    condition = f"{prev_alias}.{from_col} = {new_alias}.{from_col}"
                else:
                    condition = None
            if not condition:
                path_failed = True
                break

            join_kw = (step.edge.type or "left").upper()
            join_clauses.append(
                f"{join_kw} JOIN {_wrap_live_sql_relation(relation)} AS {new_alias} "
                f"ON {condition}"
            )
            materialized_steps[cache_key] = new_alias
            prev_alias = new_alias
            last_alias = new_alias

        if path_failed:
            continue

        # Resolve the field def on the target view
        target_view_name = resolver.view_for_node(target_node) or target_node
        target_view = _get_view(target_view_name)
        if target_view is None:
            continue
        field_def = next(
            (
                item
                for item in [
                    *(target_view.dimensions or []),
                    *(target_view.measures or []),
                ]
                if str(item.get("name") or "").strip() == semantic_name
            ),
            None,
        )
        if not field_def:
            continue

        rendered_expr = _render_live_semantic_field_sql(field_def, semantic_name, last_alias)
        if not rendered_expr:
            continue

        projection_alias = f"__sem_filter_{next_projection_index}"
        next_projection_index += 1
        projected_fields.append({"expr": rendered_expr, "alias": projection_alias})
        effective_filters.append({**filt, "field": projection_alias})

    if not join_clauses or not projected_fields:
        return None, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    select_parts = ["_appbi_base.*"]
    select_parts.extend(
        f'{field["expr"]} AS {field["alias"]}'
        for field in projected_fields
    )
    enriched_sql = (
        f'SELECT {", ".join(select_parts)} '
        f'FROM ({base_sql}) AS _appbi_base '
        f'{" ".join(join_clauses)}'
    )
    logger.debug("Semantic enriched SQL: %s", enriched_sql)
    return enriched_sql, effective_filters


def _find_dataset_datasource(db: Session, dataset_obj) -> Optional[Any]:
    """Find any available datasource from the dataset's tables (for calendar table execution)."""
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource

    tables = (
        db.query(DatasetTable)
        .filter(
            DatasetTable.dataset_id == dataset_obj.id,
            DatasetTable.datasource_id.isnot(None),
        )
        .limit(1)
        .all()
    )
    if not tables:
        return None
    return db.query(DataSource).filter(DataSource.id == tables[0].datasource_id).first()


def _semantic_binding_for_runtime_table(
    db: Session,
    table,
) -> dict[str, Any] | None:
    table_id = getattr(table, "id", None)
    if table_id is None:
        return None
    return resolve_chart_semantic_binding(
        db,
        int(table_id),
        {},
        auto_generate=True,
    )


def _build_row_filtered_live_relation_sql(
    db: Session,
    datasource,
    db_table,
    filters: list[dict] | None,
    *,
    semantic_binding: dict[str, Any] | None = None,
) -> str:
    from app.services.live_query_service import (
        _build_where_clause,
        _dialect_for_ds_type,
    )
    from app.services.dataset_relation_service import resolve_dataset_table_relation

    normalized_filters = normalize_filter_conditions(filters)
    base_plan = resolve_dataset_table_relation(datasource, db_table)
    base_sql = base_plan.sql
    available_fields = {
        str(name).strip()
        for name in (base_plan.output_columns or [])
        if str(name).strip()
    }
    applicable_filters: list[dict] = []
    for filt in normalized_filters:
        semantic_field = str(
            filt.get("semanticField")
            or filt.get("fieldKey")
            or ""
        ).strip()
        if semantic_field and "." in semantic_field:
            applicable_filters.append(filt)
            continue

        field_name = str(filt.get("field") or "").strip()
        if not available_fields or not field_name or field_name in available_fields:
            applicable_filters.append(filt)

    relation_sql = base_sql
    effective_filters = applicable_filters
    if semantic_binding:
        adapted_sql, adapted_filters = _adapt_live_sql_for_semantic_filters(
            db,
            datasource,
            db_table,
            {"semanticBinding": semantic_binding},
            applicable_filters,
        )
        if adapted_sql:
            relation_sql = adapted_sql
        effective_filters = adapted_filters

    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    dialect = _dialect_for_ds_type(ds_type)
    where_clause = _build_where_clause(effective_filters, dialect)
    if not where_clause:
        return relation_sql
    return f"SELECT * FROM ({relation_sql}) AS _appbi_runtime_filtered WHERE {where_clause}"


def _build_filtered_live_sql_for_dataset_table(
    db: Session,
    dataset_obj,
    table,
    filters: list[dict] | None,
    *,
    visited_table_ids: list[int] | None = None,
    required_datasource_id: int | None = None,
) -> tuple[Any, str]:
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource
    from app.services.live_query_service import (
        _dialect_for_ds_type,
        _quote_identifier,
    )

    normalized_filters = normalize_filter_conditions(filters)

    if is_generated_calendar_table(table):
        datasource, live_sql = dataset_table_sql_service.build_dataset_table_live_query(
            db,
            dataset_obj,
            table,
            required_datasource_id=required_datasource_id,
        )
        proxy_table = SimpleNamespace(
            id=getattr(table, "id", None),
            dataset_id=getattr(table, "dataset_id", getattr(dataset_obj, "id", None)),
            datasource_id=datasource.id,
            source_kind="sql_query",
            source_table_name=None,
            source_query=live_sql,
            display_name=getattr(table, "display_name", None),
            enabled=getattr(table, "enabled", True),
            transformations=[],
            type_overrides=getattr(table, "type_overrides", None),
            columns_cache=getattr(table, "columns_cache", None),
        )
        return datasource, _build_row_filtered_live_relation_sql(
            db,
            datasource,
            proxy_table,
            normalized_filters,
            semantic_binding=_semantic_binding_for_runtime_table(db, table),
        )

    if not is_derived_table(table):
        datasource_id = getattr(table, "datasource_id", None)
        datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first() if datasource_id else None
        if datasource is None:
            raise DatasetTableSqlError(
                f'Table "{getattr(table, "display_name", getattr(table, "source_table_name", "Unknown"))}" has no datasource.',
                code="DATASOURCE_NOT_FOUND",
            )
        if required_datasource_id is not None and int(datasource.id) != int(required_datasource_id):
            raise DatasetTableSqlError(
                "Live calculated tables can only reference tables from the same datasource.",
                code="NOT_SYNCED",
            )
        return datasource, _build_row_filtered_live_relation_sql(
            db,
            datasource,
            table,
            normalized_filters,
            semantic_binding=_semantic_binding_for_runtime_table(db, table),
        )

    current_table_id = getattr(table, "id", None)
    display_name = str(getattr(table, "display_name", "") or f"Table {current_table_id or ''}").strip()
    if current_table_id is not None and current_table_id in set(visited_table_ids or []):
        cycle_chain = " -> ".join(str(item) for item in [*(visited_table_ids or []), current_table_id])
        raise DatasetTableSqlError(
            f"Calculated table dependency cycle detected: {cycle_chain}",
            code="CIRCULAR_DEPENDENCY",
        )

    source_query = str(getattr(table, "source_query", "") or "").strip()
    cleaned_query = dataset_table_sql_service.validate_and_clean_derived_query(source_query)
    dependency_ids = dataset_table_sql_service.collect_derived_dependency_table_ids(
        db,
        dataset_obj.id,
        cleaned_query,
        exclude_table_id=current_table_id,
    )
    dependency_tables = {
        int(dep.id): dep
        for dep in (
            db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == dataset_obj.id)
            .filter(DatasetTable.id.in_(dependency_ids))
            .all()
        )
    }
    dataset_alias_map = dataset_table_sql_service.build_dataset_table_reference_alias_map(
        db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_obj.id).all()
    )

    resolved_datasource = None
    ctes: list[str] = []
    next_visited = [*(visited_table_ids or [])]
    if current_table_id is not None:
        next_visited.append(int(current_table_id))

    ordered_dependency_ids = [
        *[
            dependency_id
            for dependency_id in dependency_ids
            if not is_generated_calendar_table(dependency_tables.get(int(dependency_id)))
        ],
        *[
            dependency_id
            for dependency_id in dependency_ids
            if is_generated_calendar_table(dependency_tables.get(int(dependency_id)))
        ],
    ]

    for dependency_id in ordered_dependency_ids:
        dependency_table = dependency_tables.get(int(dependency_id))
        if dependency_table is None:
            raise DatasetTableSqlError(
                f'Calculated table "{display_name}" references a missing table alias: {dataset_alias_map.get(int(dependency_id), dataset_table_sql_service.build_dataset_table_sql_alias(int(dependency_id)))}',
                code="INVALID_DATASET_SQL",
            )

        dependency_datasource, dependency_sql = _build_filtered_live_sql_for_dataset_table(
            db,
            dataset_obj,
            dependency_table,
            normalized_filters,
            visited_table_ids=next_visited,
            required_datasource_id=(
                int(resolved_datasource.id)
                if resolved_datasource is not None
                else required_datasource_id
            ),
        )
        if resolved_datasource is None:
            resolved_datasource = dependency_datasource
        elif int(dependency_datasource.id) != int(resolved_datasource.id):
            raise DatasetTableSqlError(
                "Live calculated tables can only reference tables from the same datasource.",
                code="NOT_SYNCED",
            )

        ds_type = dependency_datasource.type if isinstance(dependency_datasource.type, str) else dependency_datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)
        alias = dataset_alias_map.get(
            int(dependency_id),
            dataset_table_sql_service.build_dataset_table_sql_alias(int(dependency_id)),
        ).replace('"', "")
        quoted_alias = _quote_identifier(alias, dialect)
        ctes.append(f"{quoted_alias} AS (\n{dataset_table_sql_service._indent_sql(dependency_sql)}\n)")

    if resolved_datasource is None:
        raise DatasetTableSqlError(
            f'Calculated table "{display_name}" could not resolve a live datasource.',
            code="NOT_SYNCED",
        )

    ds_type = resolved_datasource.type if isinstance(resolved_datasource.type, str) else resolved_datasource.type.value
    dialect = _dialect_for_ds_type(ds_type)
    derived_alias = _quote_identifier("_derived_table", dialect)
    base_query = f"SELECT * FROM (\n{dataset_table_sql_service._indent_sql(cleaned_query)}\n) AS {derived_alias}"
    if ctes:
        base_query = "WITH " + ",\n".join(ctes) + "\n" + base_query
    base_query = dataset_table_sql_service._apply_table_transformations(
        base_query,
        table,
        dialect=dialect,
    )
    proxy_table = SimpleNamespace(
        id=getattr(table, "id", None),
        dataset_id=getattr(table, "dataset_id", getattr(dataset_obj, "id", None)),
        datasource_id=resolved_datasource.id,
        source_kind="sql_query",
        source_table_name=None,
        source_query=base_query,
        display_name=getattr(table, "display_name", None),
        enabled=getattr(table, "enabled", True),
        transformations=[],
        type_overrides=getattr(table, "type_overrides", None),
        columns_cache=getattr(table, "columns_cache", None),
    )
    return resolved_datasource, _build_row_filtered_live_relation_sql(
        db,
        resolved_datasource,
        proxy_table,
        normalized_filters,
        semantic_binding=_semantic_binding_for_runtime_table(db, table),
    )


def _execute_chart_runtime_for_table(
    db: Session,
    datasource,
    db_table,
    chart_type,
    chart_config: dict | None = None,
    *,
    extra_filters: list | None = None,
    filter_context: str | None = None,
    limit_override: int | None = None,
) -> Dict[str, Any]:
    """Execute chart runtime against a dataset table.

    All queries are routed through LiveQueryService to execute directly
    on the source database (BigQuery / PostgreSQL / MySQL).
    """
    from app.services.live_query_service import LiveQueryService, _dialect_for_ds_type
    from app.models.dataset import Dataset

    filter_context = normalize_chart_filter_context(filter_context)
    chart_config = chart_config or {}
    role_config = get_chart_active_role_config(chart_config)
    filters = resolve_chart_query_filters(chart_config, filter_context)
    custom_sql = get_chart_custom_sql(chart_config)
    raw_extra_filters = list(extra_filters or [])
    normalized_extra_filters = _normalize_runtime_filters_for_chart(chart_config, extra_filters)

    # ── Calendar table: generate SQL in source dialect, execute on dataset's datasource ──
    if is_generated_calendar_table(db_table):
        dataset_obj = db.query(Dataset).filter(Dataset.id == db_table.dataset_id).first()
        if dataset_obj is None:
            raise ValueError("Dataset not found")
        cal_datasource = datasource or _find_dataset_datasource(db, dataset_obj)
        if cal_datasource is None:
            raise ValueError("No datasource available for calendar table execution")
        ds_type = cal_datasource.type if isinstance(cal_datasource.type, str) else cal_datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)
        cal_sql = build_calendar_live_sql(
            get_calendar_settings(dataset_obj, enabled_default=False),
            dialect,
        )
        all_filters = merge_chart_query_filters(
            chart_config,
            extra_filters=normalized_extra_filters,
            context=filter_context,
        )
        return LiveQueryService.execute_chart_query_from_sql(
            cal_datasource,
            chart_type,
            role_config,
            all_filters,
            cal_sql,
            extra_filters=[],
            limit_override=limit_override,
        )

    # ── Derived / calculated table: build live SQL from definition ──
    if is_derived_table(db_table):
        dataset_obj = db.query(Dataset).filter(Dataset.id == db_table.dataset_id).first()
        if dataset_obj is None:
            raise ValueError("Dataset not found")
        try:
            combined_runtime_filters = merge_chart_query_filters(
                chart_config,
                extra_filters=raw_extra_filters,
                context=filter_context,
            )
            if combined_runtime_filters:
                live_datasource, filtered_live_sql = _build_filtered_live_sql_for_dataset_table(
                    db,
                    dataset_obj,
                    db_table,
                    combined_runtime_filters,
                )
                return LiveQueryService.execute_chart_query_from_sql(
                    live_datasource,
                    chart_type,
                    role_config,
                    [],
                    filtered_live_sql,
                    extra_filters=[],
                    limit_override=limit_override,
                )

            live_datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                db, dataset_obj, db_table,
            )
            live_sql, live_filters = _adapt_live_sql_for_semantic_filters(
                db, live_datasource, live_proxy_table, chart_config, raw_extra_filters,
            )
            if live_sql:
                return LiveQueryService.execute_chart_query_from_sql(
                    live_datasource, chart_type, role_config, filters, live_sql,
                    extra_filters=live_filters,
                    limit_override=limit_override,
                )
            return LiveQueryService.execute_chart_query(
                live_datasource, live_proxy_table, chart_type, role_config, filters,
                extra_filters=normalized_extra_filters,
                limit_override=limit_override,
            )
        except DatasetTableSqlError as exc:
            raise ValueError(str(exc)) from exc

    # ── Custom SQL: send directly to source ──
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
            limit_override=limit_override,
        )

    if datasource is None:
        raise ValueError("Chart requires a datasource-backed table")

    # ── Physical table / SQL query: live query with semantic filter adaptation ──
    live_sql, live_filters = _adapt_live_sql_for_semantic_filters(
        db, datasource, db_table, chart_config, raw_extra_filters,
    )
    if live_sql:
        return LiveQueryService.execute_chart_query_from_sql(
            datasource, chart_type, role_config, filters, live_sql,
            extra_filters=live_filters,
            limit_override=limit_override,
        )
    return LiveQueryService.execute_chart_query(
        datasource, db_table, chart_type, role_config, filters,
        extra_filters=normalized_extra_filters,
        limit_override=limit_override,
    )


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
        from sqlalchemy.orm import joinedload, selectinload
        from app.models.dataset import DatasetTable

        charts = (
            db.query(Chart)
            .options(
                joinedload(Chart.chart_meta),
                selectinload(Chart.parameters),
                joinedload(Chart.dataset_table).joinedload(DatasetTable.dataset),
            )
            .offset(skip)
            .limit(limit)
            .all()
        )
        for chart in charts:
            ChartService.hydrate_runtime_config(db, chart)
        return charts
    
    @staticmethod
    def get_by_id(db: Session, chart_id: int) -> Optional[Chart]:
        """Get a chart by ID."""
        from sqlalchemy.orm import joinedload, selectinload
        from app.models.dataset import DatasetTable

        chart = (
            db.query(Chart)
            .options(
                joinedload(Chart.chart_meta),
                selectinload(Chart.parameters),
                joinedload(Chart.dataset_table).joinedload(DatasetTable.dataset),
            )
            .filter(Chart.id == chart_id)
            .first()
        )
        return ChartService.hydrate_runtime_config(db, chart)
    
    @staticmethod
    def get_by_name(db: Session, name: str) -> Optional[Chart]:
        """Get a chart by name."""
        return db.query(Chart).filter(Chart.name == name).first()
    
    @staticmethod
    def create(db: Session, chart: ChartCreate, owner_id=None) -> Chart:
        """Create a new chart."""
        chart_name = chart.name.strip()
        if not chart_name:
            raise ValueError("Chart name cannot be empty")

        if chart.dataset_table_id is not None:
            # Verify dataset table exists
            from app.services.dataset_crud import DatasetCRUDService
            table = DatasetCRUDService.get_table_by_id(db, chart.dataset_table_id)
            if not table:
                raise ValueError(f"Dataset table with ID {chart.dataset_table_id} not found")

        if _find_chart_name_conflict(db, chart_name, owner_id=owner_id):
            raise ValueError(f"You already have a chart named '{chart_name}'")

        try:
            db_chart = Chart(
                name=chart_name,
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
            logger.info(f"Created chart: {chart_name}")
            return db_chart
        except IntegrityError:
            db.rollback()
            raise ValueError(f"You already have a chart named '{chart_name}'")
    
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

        if chart_update.name is not None:
            next_name = chart_update.name.strip()
            if not next_name:
                raise ValueError("Chart name cannot be empty")
            if _find_chart_name_conflict(
                db,
                next_name,
                owner_id=db_chart.owner_id,
                exclude_chart_id=chart_id,
            ):
                raise ValueError(f"You already have a chart named '{next_name}'")
        
        try:
            update_data = chart_update.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                if field == "chart_type" and value:
                    setattr(db_chart, field, ChartType(value.value))
                elif field == "name":
                    if value is None:
                        continue
                    setattr(db_chart, field, value.strip())
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
            conflict_name = (chart_update.name or db_chart.name or "").strip()
            raise ValueError(f"You already have a chart named '{conflict_name}'")
    
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
        limit_override = None
        raw_limit_override = config.get("limit")
        if raw_limit_override is not None:
            try:
                limit_override = max(1, min(int(raw_limit_override), 5000))
            except (TypeError, ValueError):
                limit_override = None
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
            source_sample_limit = max(1, min(int(source_sample_limit), 5000))
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
            metric_optional_chart_types = {"TABLE", "MATRIX", "SCATTER", "MAP_POINT", "TIMELINE"}
            if normalized_chart_type not in metric_optional_chart_types and not (normalized_role_config.get("metrics") or []):
                return preview

        result = _execute_chart_runtime_for_table(
            db,
            datasource,
            db_table,
            chart_type,
            config,
            extra_filters=extra_filters,
            filter_context=filter_context,
            limit_override=limit_override,
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
