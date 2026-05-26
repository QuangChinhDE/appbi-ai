"""API endpoints for Datasets (Table-based Datasets)"""
from typing import Any, Dict, List, Optional
from decimal import Decimal
import json
import re
from types import SimpleNamespace
from datetime import datetime, date
from urllib.parse import quote
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response
from sqlalchemy import or_
from sqlalchemy.orm import Session, selectinload

from app.core.database import get_db
from app.core.dependencies import (
    get_current_user,
    require_permission,
    require_view_access,
    require_edit_access,
    require_full_access,
    get_effective_permission,
)
from app.core.permissions import _owned_or_shared, stamp_owner_emails
from app.models import DataSource, Chart, Dashboard, DashboardChart, Dataset, DatasetTable
from app.models.models import DashboardPublicLink
from app.models.resource_share import ResourceType
from app.models.user import User
from app.schemas import (
    DatasetCreate,
    DatasetDictionaryResponse,
    DatasetUpdate,
    DatasetResponse,
    DatasetWithTables,
    TableCreate,
    TableUpdate,
    TableResponse,
    TablePreviewRequest,
    TablePreviewResponse,
    ExecuteQueryRequest,
    ExecuteQueryResponse,
    DatasourceTable,
    DatasetColumnMetadata,
)
from app.schemas.dataset import AggregationSpec, FilterCondition, OrderBySpec
from app.services import (
    DatasetCRUDService,
    DataSourceConnectionService,
    EmbeddingService,
    DatasetQualityService,
)
from app.services.dataset_quality_service import QualityRuleConflictError
from app.services import query_cache
from app.services.chart_contracts import normalize_filter_conditions
from app.services.dataset_calendar_service import (
    build_calendar_columns_cache,
    get_calendar_settings,
    is_generated_calendar_table,
)
from app.services.dataset_table_sql_service import (
    build_live_proxy_table_for_dataset_table,
    DatasetTableSqlError,
    collect_derived_dependency_table_ids,
    is_derived_table,
    validate_and_clean_derived_query,
)
from app.services.dataset_model_service import (
    generate_dataset_model,
    measure_dependencies_referencing_view,
    sync_dataset_model_structure,
)
from app.services.dataset_dictionary_service import (
    build_dictionary_context,
    build_dictionary_stats,
    normalize_dictionary_payload,
)
from app.services.description_pipeline_service import (
    DescriptionPipelineService,
    resolve_session_factory,
)
from app.services.dataset_excel_export_service import (
    EXCEL_MAX_DATA_ROWS,
    export_dataset_table_to_excel,
)
from app.core.logging import get_logger
from app.services.runtime_modes import datasource_sync_enabled
from app.services.schema_inference import infer_schema_from_sql
from app.services.live_query_service import (
    LiveQueryService,
    build_dataset_table_cache_identifier,
    build_live_base_query_plan,
)
from app.services.type_override_service import (
    audit_type_overrides,
    normalize_type_overrides,
)

router = APIRouter()
logger = get_logger(__name__)


def _validate_measure_dependencies(
    db: Session,
    dataset_id: int,
    current_view_name: str,
    measures: list[Any],
) -> None:
    """Reject unknown or cyclic semantic measure dependencies.

    Same-view dependencies can still be written as bare names for backward
    compatibility. Cross-view dependencies must be qualified as view.measure.
    """
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

    def measure_name(measure: Any) -> str:
        return str(
            measure.name if hasattr(measure, "name") else measure.get("name", "")
        ).strip()

    def measure_deps(measure: Any) -> list[str]:
        raw_deps = measure.depends_on if hasattr(measure, "depends_on") else measure.get("depends_on", [])
        return [str(item or "").strip() for item in (raw_deps or []) if str(item or "").strip()]

    table_ids = [
        row.id
        for row in db.query(DatasetTable.id)
        .filter(DatasetTable.dataset_id == dataset_id)
        .all()
    ]
    views = (
        db.query(SemanticView)
        .filter(SemanticView.dataset_table_id.in_(table_ids))
        .all()
        if table_ids
        else []
    )

    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    if model:
        referenced_view_names: set[str] = set()
        explores = db.query(SemanticExplore).filter(SemanticExplore.model_id == model.id).all()
        for explore in explores:
            if explore.base_view_name:
                referenced_view_names.add(str(explore.base_view_name))
            for join in explore.joins or []:
                for key in ("view", "alias", "presentation_view"):
                    value = str(join.get(key) or "").strip()
                    if value:
                        referenced_view_names.add(value)
        if referenced_view_names:
            existing_ids = {view.id for view in views}
            extra_query = db.query(SemanticView).filter(
                SemanticView.name.in_(list(referenced_view_names))
            )
            if table_ids:
                extra_query = extra_query.filter(
                    or_(
                        SemanticView.dataset_table_id.in_(table_ids),
                        SemanticView.dataset_table_id.is_(None),
                    )
                )
            else:
                extra_query = extra_query.filter(SemanticView.dataset_table_id.is_(None))
            extra_views = extra_query.all()
            views.extend(view for view in extra_views if view.id not in existing_ids)

    measure_names_by_view: dict[str, set[str]] = {
        view.name: {
            str((measure or {}).get("name") or "").strip()
            for measure in (view.measures or [])
            if isinstance(measure, dict) and str((measure or {}).get("name") or "").strip()
        }
        for view in views
    }
    current_names = {measure_name(measure) for measure in measures if measure_name(measure)}
    measure_names_by_view[current_view_name] = current_names

    measures_by_view: dict[str, list[Any]] = {
        view.name: list(view.measures or [])
        for view in views
    }
    measures_by_view[current_view_name] = measures

    def qualify_dep(owner_view: str, dep: str) -> str:
        if "." in dep:
            dep_view, dep_name = dep.split(".", 1)
        else:
            dep_view, dep_name = owner_view, dep
        dep_view = dep_view.strip()
        dep_name = dep_name.strip()
        if not dep_view or not dep_name:
            return ""
        if dep_name not in measure_names_by_view.get(dep_view, set()):
            raise HTTPException(
                status_code=400,
                detail=f"Measure dependency '{dep}' does not match any measure in this model.",
            )
        return f"{dep_view}.{dep_name}"

    graph: dict[str, list[str]] = {}
    for view_name, view_measures in measures_by_view.items():
        for measure in view_measures:
            name = measure_name(measure)
            if not name:
                continue
            node = f"{view_name}.{name}"
            deps = [
                qualified
                for dep in measure_deps(measure)
                if (qualified := qualify_dep(view_name, dep))
            ]
            graph[node] = deps

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str, path: list[str]) -> None:
        if node in visited:
            return
        if node in visiting:
            cycle_start = path.index(node) if node in path else 0
            cycle = " -> ".join([*path[cycle_start:], node])
            raise HTTPException(
                status_code=400,
                detail=f"Circular measure dependency detected: {cycle}.",
            )
        visiting.add(node)
        for dep in graph.get(node, []):
            visit(dep, [*path, node])
        visiting.remove(node)
        visited.add(node)

    for node in graph:
        visit(node, [])

    # Phase-12: validate source_columns for dataset-scope measures. Every
    # (view, field) declared must reference an existing view in this dataset's
    # model AND a real column/dimension on that view. We don't yet validate
    # join reachability — that becomes a runtime warning so users can save
    # the measure before they finish wiring the relationships.
    known_views_by_name = {view.name: view for view in views}
    dim_names_by_view: dict[str, set[str]] = {
        view.name: {
            str((dim or {}).get("name") or "").strip()
            for dim in (view.dimensions or [])
            if isinstance(dim, dict) and str((dim or {}).get("name") or "").strip()
        }
        for view in views
    }
    columns_cache_by_view: dict[str, set[str]] = {}
    for view in views:
        if view.dataset_table_id:
            table = (
                db.query(DatasetTable)
                .filter(DatasetTable.id == view.dataset_table_id)
                .first()
            )
            columns_cache_by_view[view.name] = _columns_for_table(table)
        else:
            columns_cache_by_view[view.name] = set()

    for measure in measures:
        scope = str(
            (measure.scope if hasattr(measure, "scope") else measure.get("scope", "view"))
            or "view"
        )
        if scope != "dataset":
            continue
        raw_sources = (
            measure.source_columns
            if hasattr(measure, "source_columns")
            else measure.get("source_columns", [])
        ) or []
        m_name = measure_name(measure) or "<unnamed>"
        for src in raw_sources:
            src_view = str(
                (src.view if hasattr(src, "view") else src.get("view", "")) or ""
            ).strip()
            src_field = str(
                (src.field if hasattr(src, "field") else src.get("field", "")) or ""
            ).strip()
            if not src_view or not src_field:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Measure '{m_name}' (scope=dataset) có source_columns entry "
                        "thiếu view hoặc field."
                    ),
                )
            if src_view not in known_views_by_name and src_view != current_view_name:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Measure '{m_name}' tham chiếu view '{src_view}' không tồn tại "
                        "trong dataset model."
                    ),
                )
            view_dims = dim_names_by_view.get(src_view, set())
            view_cols = columns_cache_by_view.get(src_view, set())
            if view_dims and src_field not in view_dims and (not view_cols or src_field not in view_cols):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Measure '{m_name}': cột '{src_field}' không tồn tại trên "
                        f"view '{src_view}'. Kiểm tra lại tên cột hoặc dimension."
                    ),
                )

    # Phase-14: validate context_modifiers cross-references. The model_
    # validator on MeasureDefinition already enforces shape (e.g.
    # keep_fields required for all_except). Here we check identifiers
    # against the actual dataset state:
    #   * `all_except.keep_fields` — each entry must name a dimension
    #     declared on the SAME view as the measure (the measure's anchor
    #     view; cross-view kept-fields are out of scope to keep window
    #     semantics tractable).
    #   * `use_relationship.join_alias` — must match a JoinDefinition.alias
    #     in some SemanticExplore on this dataset.
    #
    # Collecting alias set once is O(joins). Helps catch typos so DA
    # doesn't only learn at chart query time.
    explores_in_dataset = []
    if model:
        explores_in_dataset = list(
            db.query(SemanticExplore).filter(SemanticExplore.model_id == model.id).all()
        )
    known_join_aliases: set[str] = set()
    for explore in explores_in_dataset:
        for join in explore.joins or []:
            alias = str((join or {}).get("alias") or "").strip()
            if alias:
                known_join_aliases.add(alias)

    current_view_dims = dim_names_by_view.get(current_view_name, set())
    for measure in measures:
        modifiers = (
            measure.context_modifiers
            if hasattr(measure, "context_modifiers")
            else measure.get("context_modifiers", [])
        ) or []
        m_name = measure_name(measure) or "<unnamed>"
        for idx, mod in enumerate(modifiers):
            mod_type = str(
                (mod.type if hasattr(mod, "type") else mod.get("type", "")) or ""
            ).strip()
            if mod_type == "all_except":
                keep = (
                    mod.keep_fields if hasattr(mod, "keep_fields")
                    else mod.get("keep_fields", [])
                ) or []
                for kf in keep:
                    kf_str = str(kf or "").strip()
                    if not kf_str:
                        continue
                    # Accept bare ('region') or qualified ('view.region')
                    bare = kf_str.split(".", 1)[-1]
                    if current_view_dims and bare not in current_view_dims:
                        raise HTTPException(
                            status_code=400,
                            detail=(
                                f"Measure '{m_name}': context_modifiers[{idx}].keep_fields "
                                f"chứa '{kf_str}' không phải dimension trên view "
                                f"'{current_view_name}'. Có sẵn: {sorted(current_view_dims)}."
                            ),
                        )
            elif mod_type == "use_relationship":
                alias = str(
                    (mod.join_alias if hasattr(mod, "join_alias")
                     else mod.get("join_alias", "")) or ""
                ).strip()
                if alias and known_join_aliases and alias not in known_join_aliases:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Measure '{m_name}': context_modifiers[{idx}].join_alias "
                            f"'{alias}' không khớp với bất kỳ JoinDefinition.alias nào "
                            f"trong dataset. Có sẵn: {sorted(known_join_aliases)}."
                        ),
                    )


def _columns_for_table(table: Optional[DatasetTable]) -> set[str]:
    """Return the set of column names available on a DatasetTable.

    Reads from ``columns_cache`` which reflects any Transformation
    (Calculated Column) already applied. Returns an empty set when the
    cache hasn't been populated yet (fresh import / sync pending) so the
    caller knows to skip existence checks rather than reject valid data.
    """
    if table is None:
        return set()
    raw = getattr(table, "columns_cache", None)
    if not raw:
        return set()
    if isinstance(raw, dict):
        raw = raw.get("columns") or []
    names: set[str] = set()
    for item in raw or []:
        if isinstance(item, dict):
            name = item.get("name")
        else:
            name = item
        if name:
            names.add(str(name).strip())
    return names


def _last_segment(value: Optional[str]) -> str:
    """Extract the final identifier from a placeholder/qualified expression.

    Accepts ``"col"``, ``"table.col"``, ``"${TABLE}.col"``, ``"${view.col}"``
    and returns just ``"col"``. Anything that doesn't look like an identifier
    after stripping returns an empty string.
    """
    if not value:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    if text.startswith("${") and "}" in text:
        text = text.split("}", 1)[1].lstrip(".")
        # ${view.field} case: text may now be empty if the placeholder
        # already contained the field; recover by re-splitting the original.
        if not text:
            inner = value.strip()[2:].split("}", 1)[0]
            if "." in inner:
                text = inner.rsplit(".", 1)[-1]
    last = text.rsplit(".", 1)[-1].strip()
    import re as _re
    if not _re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", last):
        return ""
    return last


def _validate_field_references(
    table: Optional[DatasetTable],
    dimensions: list[Any],
    measures: list[Any],
) -> None:
    """Reject semantic definitions that reference columns the table doesn't have.

    Phase-2 of "Rút về 2": catches the silent-failure class where a dimension
    or measure points at a column that was renamed/deleted at the data layer.
    Without this check, the save succeeds and the failure only surfaces at
    chart query time as a cryptic SQL error.

    Skips silently when ``columns_cache`` is empty (e.g. table hasn't synced
    yet) — better to allow the save than to block users on missing metadata.
    """
    columns = _columns_for_table(table)
    if not columns:
        return  # columns_cache not populated; skip rather than reject

    errors: list[str] = []

    # Phase-13: collect dim names first so we can validate `parent` refs.
    dim_names = {
        str((d or {}).get("name") or "").strip()
        for d in (dimensions or [])
        if isinstance(d, dict) and str((d or {}).get("name") or "").strip()
    }

    for index, dim in enumerate(dimensions or []):
        if not isinstance(dim, dict):
            continue
        name = str(dim.get("name") or "").strip()
        if not name:
            continue
        # After Phase-1 enforcement, dim.sql == name (or null). The column we
        # need to verify is `name` itself; we still defensively check the
        # last segment of `sql` in case a legacy record slips through.
        target = _last_segment(dim.get("sql")) or name
        if target not in columns:
            errors.append(
                f"Dimension #{index + 1} \"{name}\": cột \"{target}\" không tồn tại trên bảng. "
                "Kiểm tra lại tên cột hoặc tạo Calculated Column tương ứng trước."
            )

        # Phase-13: parent must reference another dim on the SAME view, must
        # not be self-reference. Cycle detection runs after the loop so we
        # have the full chain to walk.
        parent = str(dim.get("parent") or "").strip()
        if parent:
            if parent == name:
                errors.append(
                    f"Dimension \"{name}\": parent không thể trỏ vào chính nó."
                )
            elif parent not in dim_names:
                errors.append(
                    f"Dimension \"{name}\": parent \"{parent}\" không tồn tại "
                    f"trên view này. Có sẵn: {sorted(dim_names)}."
                )

    # Phase-13: hierarchy cycle detection. Walk parent chain from each dim;
    # if we revisit a node we've seen, reject. O(n) per dim, n×n worst case
    # but hierarchies are tiny in practice (depth 3-5 max).
    parent_by_name = {
        str(d.get("name") or "").strip(): str(d.get("parent") or "").strip()
        for d in (dimensions or [])
        if isinstance(d, dict) and str(d.get("name") or "").strip()
    }
    for start_name in parent_by_name:
        seen: set[str] = set()
        current = start_name
        while current:
            if current in seen:
                cycle = " → ".join([*seen, current])
                errors.append(
                    f"Dimension \"{start_name}\": hierarchy có vòng lặp ({cycle}). "
                    "Bỏ parent để phá vòng."
                )
                break
            seen.add(current)
            current = parent_by_name.get(current, "")

    for index, measure in enumerate(measures or []):
        if not isinstance(measure, dict):
            continue
        m_name = str(measure.get("name") or "").strip() or f"#{index + 1}"
        m_type = str(measure.get("type") or "").strip()
        sql = measure.get("sql")
        expression = measure.get("expression")
        # COUNT(*) and expression-based measures don't aggregate a single
        # named column, so skip the column check for those.
        if m_type == "count" and (sql in (None, "", "*")):
            pass
        elif expression:
            pass  # free-form SQL; out of scope for this validator
        else:
            target = _last_segment(sql)
            if target and target not in columns:
                errors.append(
                    f"Measure \"{m_name}\": cột \"{target}\" không tồn tại trên bảng. "
                    "Tạo Calculated Column trên bảng nguồn rồi chọn lại cột này."
                )

        for f_index, flt in enumerate(measure.get("filters") or []):
            if not isinstance(flt, dict):
                continue
            field = flt.get("field")
            target = _last_segment(field)
            if target and target not in columns:
                errors.append(
                    f"Measure \"{m_name}\": filter #{f_index + 1} trỏ vào cột "
                    f"\"{target}\" không tồn tại trên bảng."
                )

    if errors:
        raise HTTPException(status_code=400, detail=errors[0])


def _rewrite_measure_references(
    db: Session,
    *,
    dataset_id: int,
    view_name: str,
    rename_map: dict[str, str],
) -> dict[str, int]:
    """Phase-6: propagate measure renames across every persisted consumer.

    Rewrites:
      * Chart.config — qualified ``"<view>.<old>"`` AND bare ``"<old>"``
        references inside metric.field, measure_configs[].field, x_axis,
        y_axis, etc. Substring replacement uses JSON-quoted boundaries so
        we don't accidentally clobber substrings of unrelated identifiers
        (e.g. renaming ``"rev"`` won't touch ``"revenue"``).
      * SemanticView.measures[].depends_on — same-view bare entries and
        cross-view ``"<view>.<old>"`` entries on any view in the dataset.
      * SemanticView.measures[].expression / where_sql — placeholder
        ``${<old>}`` and ``${<view>.<old>}`` tokens.

    Returns a summary like ``{"charts": 3, "depends_on": 2, "expressions": 1}``
    so the API can surface what was changed.
    """
    if not rename_map:
        return {}

    import json as _json
    import re as _re
    from app.models.semantic import SemanticView
    from app.models.models import Chart

    summary = {"charts": 0, "depends_on": 0, "expressions": 0}

    # Resolve the host table of the renamed view. We need this to decide
    # whether bare references inside a Chart.config can be safely rewritten:
    # a chart anchored on the SAME dataset_table as the renamed view treats
    # bare refs as same-view by convention (legacy chart format), so the
    # rewrite is safe. Charts anchored on a different table use qualified
    # refs only — bare strings there are unrelated values and must not be
    # touched.
    view_obj = (
        db.query(SemanticView)
        .filter(SemanticView.name == view_name)
        .filter(
            SemanticView.dataset_table_id.in_(
                [t.id for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all()]
            )
        )
        .first()
    )
    view_table_id = view_obj.dataset_table_id if view_obj else None

    # ── 1. Chart.config ────────────────────────────────────────────────
    charts = (
        db.query(Chart)
        .join(DatasetTable, Chart.dataset_table_id == DatasetTable.id, isouter=True)
        .filter(DatasetTable.dataset_id == dataset_id)
        .all()
    )
    for chart in charts:
        try:
            config_text = _json.dumps(chart.config or {}, ensure_ascii=False)
        except (TypeError, ValueError):
            continue
        new_text = config_text
        chart_same_view = (
            view_table_id is not None
            and chart.dataset_table_id is not None
            and chart.dataset_table_id == view_table_id
        )
        for old, new in rename_map.items():
            # Qualified form: "view.old" → "view.new". JSON-quoted so we
            # only match field-reference strings, not free text. Applied
            # to every chart in the dataset because qualified refs are
            # globally unambiguous.
            new_text = new_text.replace(f'"{view_name}.{old}"', f'"{view_name}.{new}"')
            # Bare form: only safe on charts anchored to the SAME table
            # as the renamed view. JSON-quoted boundary prevents matching
            # substrings (e.g. renaming "rev" must not touch "revenue").
            if chart_same_view:
                new_text = new_text.replace(f'"{old}"', f'"{new}"')
        if new_text != config_text:
            try:
                chart.config = _json.loads(new_text)
                from sqlalchemy.orm.attributes import flag_modified
                flag_modified(chart, "config")
                summary["charts"] += 1
            except _json.JSONDecodeError:
                continue

    # ── 2. depends_on + expression / where_sql in all views of the model ─
    table_ids = [
        t.id for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all()
    ]
    views = (
        db.query(SemanticView)
        .filter(SemanticView.dataset_table_id.in_(table_ids))
        .all()
        if table_ids
        else []
    )

    for v in views:
        measures = list(v.measures or [])
        changed = False
        for m in measures:
            if not isinstance(m, dict):
                continue

            # depends_on rewrite. Same-view bare names (when v.name ==
            # view_name) and cross-view qualified refs both get remapped.
            deps = m.get("depends_on") or []
            new_deps: list[str] = []
            dep_changed = False
            for dep in deps:
                raw = str(dep or "").strip()
                if not raw:
                    new_deps.append(dep)
                    continue
                if "." in raw:
                    dep_view, dep_name = raw.split(".", 1)
                    if dep_view == view_name and dep_name in rename_map:
                        new_deps.append(f"{dep_view}.{rename_map[dep_name]}")
                        dep_changed = True
                        continue
                else:
                    # Bare → assume same-view, rewrite only when v.name == view_name
                    if v.name == view_name and raw in rename_map:
                        new_deps.append(rename_map[raw])
                        dep_changed = True
                        continue
                new_deps.append(dep)
            if dep_changed:
                m["depends_on"] = new_deps
                summary["depends_on"] += 1
                changed = True

            # expression / where_sql token rewrite. ``${old}`` (bare) is only
            # valid inside the SAME view as the renamed measure — engines
            # resolve placeholders against the measure's host view's alias.
            # ``${view.old}`` is the cross-view form and applies to every
            # measure on every view in the dataset.
            is_same_view = v.name == view_name
            for sql_key in ("expression", "where_sql"):
                sql_val = m.get(sql_key)
                if not isinstance(sql_val, str) or not sql_val:
                    continue
                new_sql = sql_val
                for old, new in rename_map.items():
                    if is_same_view:
                        new_sql = _re.sub(
                            r"\$\{\s*" + _re.escape(old) + r"\s*\}",
                            "${" + new + "}",
                            new_sql,
                        )
                    new_sql = _re.sub(
                        r"\$\{\s*" + _re.escape(view_name) + r"\." + _re.escape(old) + r"\s*\}",
                        "${" + view_name + "." + new + "}",
                        new_sql,
                    )
                if new_sql != sql_val:
                    m[sql_key] = new_sql
                    summary["expressions"] += 1
                    changed = True

        if changed:
            v.measures = measures
            from sqlalchemy.orm.attributes import flag_modified
            flag_modified(v, "measures")

    db.commit()
    return summary


def _find_chart_refs_to_measures(
    db: Session,
    view_name: str,
    measure_names: set[str],
    dataset_id: int,
) -> list[str]:
    """Return chart names that reference any of the given measures.

    Charts store measure references inside their JSON ``config`` either as
    ``"view.measure"`` qualified strings (semantic charts) or bare names in
    role-config fields (legacy charts on the same table). We scan with a
    simple substring match — false positives are rare and only mean we'll
    show a slightly conservative warning, not block legitimate renames.
    """
    if not measure_names:
        return []

    import json as _json
    from app.models.models import Chart

    charts = (
        db.query(Chart)
        .join(DatasetTable, Chart.dataset_table_id == DatasetTable.id, isouter=True)
        .filter(DatasetTable.dataset_id == dataset_id)
        .all()
    )
    hits: list[str] = []
    for chart in charts:
        try:
            config_text = _json.dumps(chart.config or {}, ensure_ascii=False)
        except (TypeError, ValueError):
            config_text = str(chart.config or "")
        for m_name in measure_names:
            qualified = f"{view_name}.{m_name}"
            if qualified in config_text or f'"{m_name}"' in config_text:
                hits.append(f"Chart \"{chart.name}\" (id={chart.id}) đang dùng measure \"{m_name}\"")
                break
    return hits


def _find_semantic_refs_to_columns(
    db: Session,
    table_id: int,
    columns: set[str],
) -> list[str]:
    """Return human-readable descriptions of dimensions/measures referencing
    any column in ``columns`` on the given DatasetTable.

    Used to block destructive schema changes (e.g. deleting a column via a
    ``select_columns`` transformation) when the data layer would orphan
    semantic objects. Each entry is a sentence the API surfaces back to the
    user so they know exactly what would break.
    """
    if not columns:
        return []

    from app.models.semantic import SemanticView

    views = (
        db.query(SemanticView)
        .filter(SemanticView.dataset_table_id == table_id)
        .all()
    )
    refs: list[str] = []
    for view in views:
        for dim in view.dimensions or []:
            if not isinstance(dim, dict):
                continue
            name = str(dim.get("name") or "").strip()
            target = _last_segment(dim.get("sql")) or name
            if target in columns:
                refs.append(
                    f"Dimension \"{name}\" (view {view.name}) đang dùng cột \"{target}\""
                )
        for measure in view.measures or []:
            if not isinstance(measure, dict):
                continue
            m_name = str(measure.get("name") or "").strip()
            # `sql` column refs
            target = _last_segment(measure.get("sql"))
            if target in columns:
                refs.append(
                    f"Measure \"{m_name}\" (view {view.name}) đang aggregate cột \"{target}\""
                )
            # filter refs
            for flt in measure.get("filters") or []:
                if not isinstance(flt, dict):
                    continue
                target = _last_segment(flt.get("field"))
                if target in columns:
                    refs.append(
                        f"Measure \"{m_name}\" (view {view.name}) có filter trên cột \"{target}\""
                    )
    return refs


def _contains_semantic_field_refs(execute_request: ExecuteQueryRequest) -> bool:
    """FE→BE routing oracle: presence of ANY dotted ref ('view.field') in
    dimensions / measures / filters / order_by tells the dataset query
    endpoint (`execute_dataset_query`) to route the request to
    ``_execute_semantic_dataset_query`` — the path that wires
    ``SemanticQueryEngine`` + the multi-hop ``SemanticJoinResolver`` so
    cross-table fields get JOINed correctly.

    Bare refs route to the legacy ``live_query`` path, which only knows
    one table (no JOIN logic). This is the contract FE has to honour:
    whenever a field has a qualified equivalent on the semantic model,
    send the QUALIFIED form. Otherwise, JOINs silently disappear.

    Phase-12.5 reinforces the contract at the FE layer:
      * ``ExploreEditor.upgradeRoleConfigToQualified`` (frontend) rewrites
        bare→qualified before any request hits this endpoint whenever a
        unique mapping exists in the join graph.
      * ``ExploreColumnPanel`` ⚠ "cần join" badge stops the user from
        picking a field on a view that has no reachable JOIN to the base.
      * ``semanticReady`` gate delays role-config seeding until the
        dataset model is loaded, eliminating the race where preview
        columns arrive first and a bare pick gets locked in.

    This trio is what gives ``has_ref`` consistent input.
    """
    def has_ref(value: Any) -> bool:
        return isinstance(value, str) and "." in value and value.split(".", 1)[0].strip()

    if any(has_ref(item) for item in (execute_request.dimensions or [])):
        return True
    if any(has_ref(getattr(item, "field", None)) for item in (execute_request.measures or [])):
        return True
    if any(has_ref(getattr(item, "field", None)) for item in (execute_request.filters or [])):
        return True
    if any(has_ref(getattr(item, "field", None)) for item in (execute_request.order_by or [])):
        return True
    if any(has_ref(item) for item in (execute_request.time_grains or {}).keys()):
        return True
    return False


def _strip_base_view_qualifiers(
    db: Session,
    db_table: DatasetTable,
    execute_request: ExecuteQueryRequest,
) -> ExecuteQueryRequest:
    """Strip view qualifiers that match the table's own semantic base view.

    MCP-created charts (and old charts created before the unqualify fix) may
    persist field names as ``"view.field"`` in their ``generatedRoleConfig``
    even when the field lives on the table's own (base) view.

    The live-query execution path (``execute_dataset_query``) accepts bare
    column names and works correctly for these cases.  The semantic-query
    path (``_execute_semantic_dataset_query``) routes all dot-qualified refs
    through ``SemanticQueryEngine`` which requires every referenced field
    to be an *explicitly declared* semantic measure or dimension — a
    requirement that plain raw columns don't meet, causing HTTP 500.

    By stripping same-view qualifiers only for fields that are not declared
    semantic dimensions/measures, we keep real semantic measures on the
    semantic engine while still rescuing old raw ``baseView.column`` refs.
    Genuine cross-view refs (e.g. ``calendar.date`` when base view is
    ``orders``) remain intact.
    """
    from app.models.semantic import SemanticView

    view = db.query(SemanticView).filter(
        SemanticView.dataset_table_id == db_table.id,
    ).first()
    if not view:
        return execute_request  # no semantic view – nothing to strip

    base_prefix = f"{view.name}."
    semantic_dimensions = {
        str((item or {}).get("name") or "").strip()
        for item in (view.dimensions or [])
        if isinstance(item, dict) and str((item or {}).get("name") or "").strip()
    }
    semantic_measures = {
        str((item or {}).get("name") or "").strip()
        for item in (view.measures or [])
        if isinstance(item, dict) and str((item or {}).get("name") or "").strip()
    }

    def _strip(field: str | None, declared_names: set[str]) -> str | None:
        if not field:
            return field
        if not field.startswith(base_prefix):
            return field
        bare = field[len(base_prefix):]
        return field if bare in declared_names else bare

    next_dimensions = [
        _strip(d, semantic_dimensions)
        for d in (execute_request.dimensions or [])
    ]
    next_measures = [
        AggregationSpec(field=_strip(m.field, semantic_measures) or m.field, function=m.function)
        for m in (execute_request.measures or [])
    ]
    next_filters = [
        FilterCondition(
            field=_strip(f.field, semantic_dimensions) or f.field,
            operator=f.operator,
            value=f.value,
        )
        for f in (execute_request.filters or [])
    ]
    next_order_by = [
        OrderBySpec(field=_strip(ob.field, semantic_dimensions) or ob.field, direction=ob.direction)
        for ob in (execute_request.order_by or [])
    ]
    next_time_grains = {
        (_strip(field, semantic_dimensions) or field): grain
        for field, grain in (execute_request.time_grains or {}).items()
        if field
    }

    needs_change = (
        next_dimensions != (execute_request.dimensions or [])
        or [item.model_dump() for item in next_measures] != [item.model_dump() for item in (execute_request.measures or [])]
        or [item.model_dump() for item in next_filters] != [item.model_dump() for item in (execute_request.filters or [])]
        or [item.model_dump() for item in next_order_by] != [item.model_dump() for item in (execute_request.order_by or [])]
        or next_time_grains != (execute_request.time_grains or {})
    )
    if not needs_change:
        return execute_request

    return ExecuteQueryRequest(
        dimensions=next_dimensions,
        measures=next_measures,
        filters=next_filters,
        order_by=next_order_by,
        time_grains=next_time_grains or None,
        limit=execute_request.limit,
    )


def _execute_semantic_dataset_query(
    db: Session,
    dataset_obj: Dataset,
    db_table: DatasetTable,
    execute_request: ExecuteQueryRequest,
) -> ExecuteQueryResponse:
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
    from app.services.semantic_query_engine import SemanticQueryEngine

    view = db.query(SemanticView).filter(
        SemanticView.dataset_table_id == db_table.id,
    ).first()
    if not view:
        raise HTTPException(status_code=400, detail="No semantic view found for this table.")

    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_obj.id).first()
    if not model:
        raise HTTPException(status_code=400, detail="No semantic model found for this dataset.")

    explore = db.query(SemanticExplore).filter(
        SemanticExplore.model_id == model.id,
        SemanticExplore.base_view_id == view.id,
    ).first()
    if not explore:
        raise HTTPException(status_code=400, detail="No semantic explore found for this table.")

    def qualify(field: str | None) -> str:
        raw = str(field or "").strip()
        if not raw:
            return raw
        return raw if "." in raw else f"{view.name}.{raw}"

    dimensions = [qualify(item) for item in (execute_request.dimensions or []) if qualify(item)]
    measures = [
        qualify(item.field)
        for item in (execute_request.measures or [])
        if item.field
    ]
    measure_agg_overrides = {
        qualify(item.field): str(item.function or "").strip().lower()
        for item in (execute_request.measures or [])
        if item.field and item.function
    }

    # Operator normalisation: external callers (chart contracts, AI tools) may
    # use legacy names — canonicalise to the semantic schema's Literal values.
    _OP_ALIAS: dict[str, str] = {
        "neq": "ne",
        "startswith": "starts_with",
    }
    filters = {
        qualify(item.field): {
            "operator": _OP_ALIAS.get(item.operator, item.operator),
            "value": item.value,
        }
        for item in (execute_request.filters or [])
        if item.field
    }
    sorts = [
        {
            "field": qualify(item.field),
            "direction": str(item.direction or "ASC").lower(),
        }
        for item in (execute_request.order_by or [])
        if item.field
    ]
    active_dimension_set = set(dimensions)
    time_grains = {
        qualified: grain
        for field, grain in (execute_request.time_grains or {}).items()
        for qualified in [qualify(field)]
        if qualified in active_dimension_set
    }

    # Phase-12.6: resolve datasource FIRST so the semantic engine is
    # initialised with the correct SQL dialect. Previously this code path
    # hardcoded ``database_type="postgresql"`` regardless of the real
    # datasource (DA flagged 2026-05-16). With a BigQuery / MySQL / DuckDB
    # datasource that produced syntactically wrong SQL (e.g. PostgreSQL
    # date_trunc() instead of BigQuery DATE_TRUNC()) and a generic 500 at
    # query time.
    # Resolve datasource. For calendar / derived tables we call the live-
    # proxy builder which materialises an ad-hoc SQL source; the semantic
    # engine doesn't need the proxy table itself (it builds its own SQL
    # from the explore), only the underlying datasource for dialect + exec.
    datasource: Optional[DataSource] = None
    if is_generated_calendar_table(db_table) or is_derived_table(db_table):
        try:
            datasource, _ = build_live_proxy_table_for_dataset_table(db, dataset_obj, db_table)
        except DatasetTableSqlError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    elif db_table.datasource_id is not None:
        datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()

    if datasource is None:
        # Fall back to any datasource in this dataset. Semantic SQL may include
        # joined views, so direct table ownership is not always enough.
        table_with_ds = (
            db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == dataset_obj.id, DatasetTable.datasource_id.isnot(None))
            .first()
        )
        if table_with_ds is not None:
            datasource = db.query(DataSource).filter(DataSource.id == table_with_ds.datasource_id).first()

    if datasource is None:
        raise HTTPException(status_code=404, detail="Datasource not found for semantic query.")

    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    # Map datasource type → SQL dialect via the shared helper that
    # live_query_service + chart_service already use. Single source of
    # truth for dialect mapping — when we add a new datasource type, only
    # `_dialect_for_ds_type` needs updating.
    from app.services.live_query_service import _dialect_for_ds_type
    dialect = _dialect_for_ds_type(ds_type)

    # Phase-12.6: wrap SQL generation + execution in explicit try/except so
    # engine crashes (unreachable join path, missing measure, dialect-
    # incompatible expression) surface as actionable 4xx responses with
    # Vietnamese-friendly messages instead of a generic 500. The semantic
    # engine itself raises ValueError with VN messages in Phase 11.
    engine = SemanticQueryEngine(db, database_type=dialect)
    try:
        sql, _columns, _pivot_metadata = engine.generate_sql(
            explore_name=explore.name,
            dimensions=dimensions,
            measures=measures,
            filters=filters,
            sorts=sorts,
            limit=execute_request.limit or 500,
            time_grains=time_grains or None,
            measure_agg_overrides=measure_agg_overrides or None,
            model_id=model.id,
            explore_id=explore.id,
        )
    except ValueError as exc:
        # ValueError = expected semantic engine domain errors (unreachable
        # view, missing field, circular dependency, ambiguous path). Phase
        # 11 ensures these carry Vietnamese-friendly messages.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception(
            "Semantic SQL generation failed for dataset=%s table=%s explore=%s",
            dataset_obj.id, db_table.id, explore.name,
        )
        raise HTTPException(
            status_code=500,
            detail=(
                f"Lỗi sinh SQL semantic ({dialect}): {exc}. "
                "Báo dev kiểm tra explore/measure config — đính kèm log nếu có."
            ),
        ) from exc

    try:
        _cols, rows, _elapsed = DataSourceConnectionService.execute_query(
            ds_type,
            datasource.config,
            sql,
            limit=None,
        )
    except Exception as exc:
        logger.exception(
            "Semantic query execution failed: ds_type=%s dialect=%s sql=%s",
            ds_type, dialect, sql[:500],
        )
        raise HTTPException(
            status_code=400,
            detail=(
                f"Lỗi chạy SQL trên datasource {ds_type} (dialect {dialect}): {exc}. "
                "Kiểm tra: relationship có đúng cardinality? Cột tham chiếu có tồn tại trên datasource? "
                "Mở DevTools network panel để xem request body và SQL emit."
            ),
        ) from exc

    # Engine emits SQL aliases of the form `view_field` (dots → underscores)
    # for stable identifier safety. Callers (chart builder, AI tools) request
    # in canonical `view.field` form and rely on the response keys matching.
    # Remap row keys back to canonical refs so the request/response contract
    # is symmetric — without this, frontend `row[roleConfig.dimension]`
    # lookups silently return undefined for cross-view dimensions.
    from app.services.chart_service import (
        _build_semantic_alias_map,
        remap_semantic_engine_rows,
    )
    alias_map = _build_semantic_alias_map(list(dimensions) + list(measures))
    rows = remap_semantic_engine_rows(rows, alias_map)

    rows = _serialize_cached_rows(rows, limit=len(rows))
    columns = list(rows[0].keys()) if rows else [alias_map.get(c, c) for c in (_columns or [])]
    column_metadata = [
        DatasetColumnMetadata(
            name=col,
            type=_infer_column_type(col, idx, rows),
            nullable=True,
        )
        for idx, col in enumerate(columns)
    ]
    return ExecuteQueryResponse(columns=column_metadata, rows=rows)


def _stamp_dataset_catalog_fields(items: list[Dataset]) -> None:
    for item in items:
        datasource_ids: list[int] = []
        for table in getattr(item, "tables", []) or []:
            datasource_id = getattr(table, "datasource_id", None)
            if isinstance(datasource_id, int) and datasource_id not in datasource_ids:
                datasource_ids.append(datasource_id)
        item.datasource_ids = datasource_ids


LOOKUP_TABLE_IDENTIFIER_PREFIX = "dataset-table://"



# ISO date/datetime patterns for string-based detection
_ISO_DATETIME_RE = re.compile(
    r'^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?'
)
_ISO_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def _build_lookup_table_identifier(table_id: int) -> str:
    return f"{LOOKUP_TABLE_IDENTIFIER_PREFIX}{table_id}"


def _build_excel_export_filenames(dataset_name: Any, table_name: Any) -> tuple[str, str]:
    base_name = f"{str(dataset_name or 'dataset').strip()}-{str(table_name or 'table').strip()}"
    base_name = re.sub(r"\s+", " ", base_name).strip(" -") or "dataset-table"
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", base_name).strip("._-") or "dataset-table"
    return f"{ascii_name}.xlsx", f"{base_name}.xlsx"


def _dataset_table_lookup_tokens(table: DatasetTable) -> List[str]:
    tokens: List[str] = []
    for candidate in (
        _build_lookup_table_identifier(table.id),
        table.display_name,
        table.source_table_name,
    ):
        text = str(candidate or "").strip()
        if text and text not in tokens:
            tokens.append(text)
    return tokens


def _formula_references_dataset_table(formula: Any, table: DatasetTable) -> bool:
    text = str(formula or "")
    if not text:
        return False
    lowered = text.lower()
    return any(f'"{token}"'.lower() in lowered for token in _dataset_table_lookup_tokens(table))


def _semantic_prefixes_for_table(
    db: Session,
    *,
    dataset_id: int,
    table: DatasetTable,
) -> set[str]:
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

    prefixes: set[str] = set()
    base_view = db.query(SemanticView).filter(SemanticView.dataset_table_id == table.id).first()
    if base_view is not None:
        prefixes.add(f"{base_view.name}.")

    if not is_generated_calendar_table(table):
        return prefixes

    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    if model is None:
        return prefixes

    explores = db.query(SemanticExplore).filter(SemanticExplore.model_id == model.id).all()
    for explore in explores:
        for join in explore.joins or []:
            if join.get("origin") != "auto_calendar":
                continue
            for key in ("view", "calendar_role", "presentation_view"):
                name = str(join.get(key) or "").strip()
                if name:
                    prefixes.add(f"{name}.")
    return prefixes


def _config_references_semantic_prefix(value: Any, prefixes: set[str]) -> bool:
    if isinstance(value, dict):
        for key, nested in value.items():
            if key == "semanticBinding":
                continue
            if _config_references_semantic_prefix(nested, prefixes):
                return True
        return False

    if isinstance(value, list):
        return any(_config_references_semantic_prefix(item, prefixes) for item in value)

    if isinstance(value, str):
        stripped = value.strip()
        return any(stripped.startswith(prefix) for prefix in prefixes)

    return False


def _filter_references_semantic_prefix(
    filter_obj: Any,
    dataset_id: int,
    prefixes: set[str],
    *,
    allow_unscoped: bool = True,
) -> bool:
    if not isinstance(filter_obj, dict):
        return False

    filter_dataset_id = filter_obj.get("datasetId")
    if filter_dataset_id is not None:
        try:
            if int(filter_dataset_id) != dataset_id:
                return False
        except (TypeError, ValueError):
            pass
    elif not allow_unscoped:
        return False

    for key in ("semanticField", "fieldKey", "field"):
        value = filter_obj.get(key)
        if isinstance(value, str) and any(value.strip().startswith(prefix) for prefix in prefixes):
            return True

    linked_fields = filter_obj.get("linkedFields")
    if isinstance(linked_fields, list):
        for value in linked_fields:
            if isinstance(value, str) and any(value.strip().startswith(prefix) for prefix in prefixes):
                return True

    return False


def _build_delete_constraint(
    constraint_type: str,
    *,
    object_label: str,
    detail: str,
    **extra: Any,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "type": constraint_type,
        "object_label": object_label,
        "detail": detail,
    }
    for key, value in extra.items():
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        payload[key] = value
    return payload


def _dedupe_delete_constraints(constraints: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen: set[tuple[Any, ...]] = set()
    unique: List[Dict[str, Any]] = []
    for constraint in constraints:
        key = (
            constraint.get("type"),
            constraint.get("id"),
            constraint.get("table_id"),
            constraint.get("link_id"),
            constraint.get("column"),
            constraint.get("field"),
            constraint.get("name"),
            constraint.get("table_name"),
            constraint.get("object_label"),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(constraint)
    return unique


def _infer_column_type(col: str, col_index: int, rows: list) -> str:
    """
    Infer the column type from sample row values.
    Samples up to 20 non-null rows for better accuracy.
    Returns: 'boolean' | 'integer' | 'float' | 'date' | 'datetime' | 'string'
    """
    values = []
    for row in rows[:20]:
        if isinstance(row, dict):
            val = row.get(col)
        elif isinstance(row, (list, tuple)):
            val = row[col_index] if col_index < len(row) else None
        else:
            val = None
        if val is not None and val != '':
            values.append(val)

    if not values:
        return "string"

    # Check Python native types first (SQL/Postgres datasources)
    for val in values:
        if isinstance(val, bool):
            return "boolean"
        if isinstance(val, datetime):
            return "datetime"
        if isinstance(val, date):
            return "date"

    # Check if all numeric Python types
    numeric_vals = [v for v in values if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool)]
    if len(numeric_vals) == len(values):
        if all(isinstance(v, int) or (isinstance(v, float) and v == int(v)) for v in numeric_vals):
            return "integer"
        return "float"

    # String-based detection (GG Sheets, Manual Table — all values come as strings)
    str_vals = [str(v).strip() for v in values]

    # Boolean strings
    bool_set = {'true', 'false', '1', '0', 'yes', 'no'}
    if all(v.lower() in bool_set for v in str_vals):
        return "boolean"

    # Integer strings
    if all(re.fullmatch(r'-?\d+', v) for v in str_vals):
        return "integer"

    # Float strings
    if all(re.fullmatch(r'-?\d+[.,]\d+', v) for v in str_vals):
        return "float"

    # Datetime strings (has time component)
    if all(_ISO_DATETIME_RE.match(v) for v in str_vals):
        return "datetime"

    # Date strings
    if all(_ISO_DATE_RE.fullmatch(v) for v in str_vals):
        return "date"

    return "string"


def _build_columns_cache_payload(
    db_table,
    column_metadata: List[DatasetColumnMetadata],
    source_columns: List[str] | None = None,
) -> Dict[str, Any]:
    existing = db_table.columns_cache if isinstance(db_table.columns_cache, dict) else {}
    payload: Dict[str, Any] = {
        **existing,
        "columns": [col.model_dump() for col in column_metadata],
    }
    source_cols = [str(column) for column in (source_columns or []) if str(column).strip()]
    if source_cols:
        payload["source_columns"] = source_cols
        payload["source_signature"] = {
            "source_kind": getattr(db_table, "source_kind", None),
            "source_table_name": getattr(db_table, "source_table_name", None),
            "source_query": getattr(db_table, "source_query", None),
        }
    return payload


def _serialize_cached_rows(rows: list[dict[str, Any]] | None, *, limit: int = 500) -> list[dict[str, Any]]:
    def _serialize_value(value: Any) -> Any:
        if isinstance(value, (datetime, date)):
            return value.isoformat()
        if isinstance(value, Decimal):
            return float(value)
        return value

    serialized: list[dict[str, Any]] = []
    for row in list(rows or [])[: max(1, int(limit))]:
        if not isinstance(row, dict):
            continue
        serialized.append({key: _serialize_value(value) for key, value in row.items()})
    return serialized


def _format_type_audit_error(audits: List[Dict[str, Any]]) -> str:
    parts: List[str] = []
    for audit in audits:
        column = audit.get("column") or "unknown"
        invalid_count = int(audit.get("invalid_count") or 0)
        examples = [str(value) for value in (audit.get("invalid_examples") or [])]
        if examples:
            parts.append(
                f'{column}: {invalid_count} giá trị không hợp lệ. Ví dụ: {", ".join(examples)}'
            )
        else:
            parts.append(f"{column}: {invalid_count} giá trị không hợp lệ.")
    return "Không thể đổi kiểu cột vì dữ liệu không cast an toàn. " + " | ".join(parts)


def _normalize_preview_error_message(exc: Exception) -> str:
    return " ".join(str(exc).split()).strip()


def _normalize_source_table_name(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    parts = [
        part.strip().strip('"').strip("'").strip("`")
        for part in text.split(".")
    ]
    return ".".join(part for part in parts if part)


def _source_table_name_matches(expected: Any, actual: Any) -> bool:
    expected_norm = _normalize_source_table_name(expected)
    actual_norm = _normalize_source_table_name(actual)
    if not expected_norm or not actual_norm:
        return False
    return expected_norm == actual_norm or expected_norm.lower() == actual_norm.lower()


def _source_object_label(datasource: Optional[DataSource]) -> str:
    ds_type = getattr(datasource, "type", None)
    ds_type_value = ds_type.value if hasattr(ds_type, "value") else str(ds_type or "")
    if ds_type_value == "google_sheets":
        return "sheet"
    return "table"


def _build_datasource_missing_detail(db_table: DatasetTable) -> Dict[str, Any]:
    return {
        "code": "DATASOURCE_MISSING",
        "message": "The datasource connected to this dataset table no longer exists or is not accessible.",
        "table_id": getattr(db_table, "id", None),
        "table_name": getattr(db_table, "display_name", None) or getattr(db_table, "source_table_name", None),
        "source_table_name": getattr(db_table, "source_table_name", None),
        "datasource_id": getattr(db_table, "datasource_id", None),
    }


def _build_source_table_missing_detail(
    db_table: DatasetTable,
    datasource: Optional[DataSource],
    raw_error: str | None = None,
) -> Dict[str, Any]:
    label = _source_object_label(datasource)
    source_name = getattr(db_table, "source_table_name", None)
    message = (
        f"The source {label} '{source_name}' is no longer available in the connected datasource. "
        f"It may have been deleted or renamed."
    )
    return {
        "code": "SOURCE_TABLE_MISSING",
        "message": message,
        "table_id": getattr(db_table, "id", None),
        "table_name": getattr(db_table, "display_name", None) or source_name,
        "source_table_name": source_name,
        "source_object": label,
        "datasource_id": getattr(db_table, "datasource_id", None),
        "raw_error": raw_error,
    }


def _looks_like_missing_source_table_error(message: str) -> bool:
    lower_msg = (message or "").lower()
    return (
        "not found in spreadsheet" in lower_msg
        or "no such table" in lower_msg
        or "not found: table" in lower_msg
        or "table not found" in lower_msg
        or "sheet not found" in lower_msg
        or ("table with name" in lower_msg and "does not exist" in lower_msg)
        or ("relation" in lower_msg and "does not exist" in lower_msg)
        or ("sheet" in lower_msg and "not found" in lower_msg)
    )


def _build_preview_source_error_detail(
    db_table: DatasetTable,
    datasource: Optional[DataSource],
    exc: Exception,
) -> Optional[Dict[str, Any]]:
    if (
        getattr(db_table, "source_kind", None) != "physical_table"
        or not getattr(db_table, "source_table_name", None)
    ):
        return None

    error_msg = _normalize_preview_error_message(exc)
    if _looks_like_missing_source_table_error(error_msg):
        return _build_source_table_missing_detail(db_table, datasource, error_msg)
    return None


def _is_fixable_preview_error(exc: Exception) -> bool:
    if isinstance(exc, ValueError):
        return True

    lower_msg = _normalize_preview_error_message(exc).lower()
    return any(
        token in lower_msg
        for token in (
            "syntax error",
            "invalidquery",
            "invalid query",
            "parse error",
            "credential",
            "oauth",
            "permission denied",
            "access denied",
            "unauthorized",
            "forbidden",
            "not found",
            "does not exist",
            "no such",
            "scan",
        )
    )


def _preview_live_table_draft(
    datasource: DataSource,
    table_draft: Any,
    *,
    limit: int = 200,
) -> tuple[List[DatasetColumnMetadata], List[Dict[str, Any]]]:
    result = LiveQueryService.execute_preview_query(
        datasource=datasource,
        db_table=table_draft,
        limit=limit,
        offset=0,
    )
    preview_columns = list(result.get("columns") or [])
    preview_rows = list(result.get("rows") or [])
    preview_metadata = [
        DatasetColumnMetadata(
            name=column_name,
            type=_infer_column_type(column_name, index, preview_rows),
            nullable=True,
        )
        for index, column_name in enumerate(preview_columns)
    ]
    return preview_metadata, preview_rows


def _build_table_draft(db_table, table_update) -> Any:
    update_data = table_update.model_dump(exclude_unset=True)
    return SimpleNamespace(
        id=getattr(db_table, "id", None),
        source_kind=getattr(db_table, "source_kind", None),
        source_table_name=getattr(db_table, "source_table_name", None),
        source_query=update_data.get("source_query", getattr(db_table, "source_query", None)),
        display_name=update_data.get("display_name", getattr(db_table, "display_name", None)),
        transformations=update_data.get("transformations", getattr(db_table, "transformations", None)),
        type_overrides=update_data.get("type_overrides", getattr(db_table, "type_overrides", None)),
        columns_cache=getattr(db_table, "columns_cache", None),
    )


def _serialize_table_description(table) -> dict:
    return {
        "auto_description": getattr(table, "auto_description", None),
        "column_descriptions": getattr(table, "column_descriptions", None),
        "common_questions": getattr(table, "common_questions", None),
        "query_aliases": getattr(table, "query_aliases", None),
        "description_source": getattr(table, "description_source", None),
        "description_updated_at": table.description_updated_at.isoformat() if getattr(table, "description_updated_at", None) else None,
        "schema_change_pending": getattr(table, "schema_change_pending", False),
        "generation_status": getattr(table, "generation_status", "idle") or "idle",
        "generation_error": getattr(table, "generation_error", None),
        "generation_requested_at": table.generation_requested_at.isoformat() if getattr(table, "generation_requested_at", None) else None,
        "generation_finished_at": table.generation_finished_at.isoformat() if getattr(table, "generation_finished_at", None) else None,
        "stale_reason": getattr(table, "stale_reason", None),
    }


def _serialize_dataset_dictionary(dataset_obj: Dataset) -> dict:
    dictionary = normalize_dictionary_payload(getattr(dataset_obj, "dictionary", None))
    stats = build_dictionary_stats(dictionary, getattr(dataset_obj, "tables", None) or [])
    return {
        "dictionary": dictionary,
        "dictionary_updated_at": (
            dataset_obj.dictionary_updated_at.isoformat()
            if getattr(dataset_obj, "dictionary_updated_at", None)
            else None
        ),
        "stats": stats,
        "compiled_context": build_dictionary_context(
            dataset_obj,
            getattr(dataset_obj, "tables", None) or [],
        ),
    }


def _sync_dataset_model_safely(db: Session, dataset_id: int) -> None:
    try:
        sync_dataset_model_structure(db, dataset_id, create_model=False)
    except Exception as exc:
        db.rollback()
        logger.warning("Dataset model sync skipped for dataset %s: %s", dataset_id, exc)


def _cleanup_semantic_view_for_table(db: Session, table_id: int) -> None:
    """Delete the SemanticView linked to a DatasetTable and remove every
    explore join that references it.  Must be called BEFORE the DatasetTable
    row is deleted so the FK-backed dataset_table_id is still resolvable."""
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

    view = db.query(SemanticView).filter(SemanticView.dataset_table_id == table_id).first()
    if view is None:
        return

    table = db.query(DatasetTable).filter(DatasetTable.id == table_id).first()
    model = (
        db.query(SemanticModel).filter(SemanticModel.dataset_id == table.dataset_id).first()
        if table is not None
        else None
    )

    view_name = view.name
    if view_name and model is not None:
        model_explores = db.query(SemanticExplore).filter(SemanticExplore.model_id == model.id).all()
        for explore in model_explores:
            old_joins = explore.joins or []
            new_joins = [j for j in old_joins if j.get("view") != view_name]
            if len(new_joins) != len(old_joins):
                explore.joins = new_joins
        for explore in db.query(SemanticExplore).filter(SemanticExplore.base_view_id == view.id).all():
            db.delete(explore)

    db.delete(view)
    db.flush()


def _run_auto_type_detection(table_id: int) -> None:
    """Background job: full-scan inference + apply for newly synced tables."""
    from app.core.database import SessionLocal
    from app.services.column_type_inference_service import (
        apply_suggestions_to_table,
        infer_full_column_types,
    )

    job_db = SessionLocal()
    try:
        table = job_db.query(DatasetTable).filter(DatasetTable.id == table_id).first()
        if not table:
            return
        datasource = job_db.query(DataSource).filter(
            DataSource.id == table.datasource_id
        ).first()
        if not datasource:
            return
        suggestions = infer_full_column_types(datasource, table)
        applied = apply_suggestions_to_table(
            job_db, table, suggestions, overwrite_user_overrides=False
        )
        if applied:
            logger.info(
                "Auto type detection applied %d overrides on table id=%s",
                len(applied),
                table_id,
            )
    except Exception as exc:
        logger.warning(
            "Auto type detection failed for table id=%s: %s", table_id, exc
        )
    finally:
        job_db.close()


def _enqueue_auto_type_detection_if_needed(
    background_tasks: BackgroundTasks,
    db_table: DatasetTable,
) -> None:
    """Run auto-detect for sources whose initial type inference is
    unreliable.

    Reliable (skipped — native schema used at import time):
      • physical_table on Postgres/MySQL/BigQuery — types come from
        information_schema / native client
      • sql_query on Postgres/MySQL/BigQuery — types from LIMIT 0
        dry-run or BigQuery dry-run schema

    Unreliable (enqueued — full-scan post-import):
      • Google Sheets / manual upload — only sample-based detection
        is available at import
      • derived_table (wrapped SQL view) — inferred from 200-row
        preview + 20-row regex; an INT column with a stray decimal
        further in the data gets typed wrong
    """
    datasource_id = getattr(db_table, "datasource_id", None)
    if datasource_id is None:
        return
    table_id = getattr(db_table, "id", None)
    if table_id is None:
        return
    ds_type = None
    datasource = getattr(db_table, "datasource", None)
    if datasource is not None:
        ds_type = datasource.type if isinstance(datasource.type, str) else getattr(datasource.type, "value", None)

    source_kind = str(getattr(db_table, "source_kind", "") or "").strip().lower()

    # Phase-15.69 — derived_table on any DB source needs the full-scan
    # check because we wrap user SQL and the resulting schema may have
    # mixed-type columns the LIMIT-0 detector can't catch.
    should_enqueue = (
        ds_type in ("google_sheets", "manual")
        or source_kind == "derived_table"
    )
    if not should_enqueue:
        return
    background_tasks.add_task(_run_auto_type_detection, int(table_id))


def _extract_cached_source_columns(db_table: DatasetTable | Any) -> List[str]:
    cache = getattr(db_table, "columns_cache", None)
    if isinstance(cache, dict):
        source_columns = cache.get("source_columns")
        if isinstance(source_columns, list):
            normalized = [str(column) for column in source_columns if str(column).strip()]
            if normalized:
                return normalized
        raw_columns = cache.get("columns")
        if isinstance(raw_columns, list):
            normalized = [
                str(column.get("name") or "").strip()
                for column in raw_columns
                if isinstance(column, dict) and str(column.get("name") or "").strip()
            ]
            if normalized:
                return normalized
    elif isinstance(cache, list):
        normalized = [
            str(column.get("name") or "").strip()
            for column in cache
            if isinstance(column, dict) and str(column.get("name") or "").strip()
        ]
        if normalized:
            return normalized
    return []


def _has_server_side_projection_changes(db_table: DatasetTable | Any) -> bool:
    if normalize_type_overrides(getattr(db_table, "type_overrides", None)):
        return True
    from app.services.transformation_compiler import TransformationCompiler

    return any(
        isinstance(step, dict)
        for step in TransformationCompiler.normalize_server_transformations(
            getattr(db_table, "transformations", None) or []
        )
    )


def _infer_dataset_table_source_columns(
    db: Session,
    dataset_obj: Dataset,
    datasource: Optional[DataSource],
    db_table: DatasetTable | Any,
    *,
    fallback_columns: List[DatasetColumnMetadata] | None = None,
) -> List[str]:
    if is_generated_calendar_table(db_table):
        return [column.name for column in (fallback_columns or []) if str(column.name or "").strip()]

    if is_derived_table(db_table):
        cached = _extract_cached_source_columns(db_table)
        if cached:
            return cached
        return [column.name for column in (fallback_columns or []) if str(column.name or "").strip()]

    if datasource is None:
        cached = _extract_cached_source_columns(db_table)
        if cached:
            return cached
        return [column.name for column in (fallback_columns or []) if str(column.name or "").strip()]

    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    inferred_columns: List[Dict[str, Any]] = []
    if db_table.source_kind == "physical_table" and db_table.source_table_name:
        inferred_columns = DataSourceConnectionService.list_columns(
            ds_id=datasource.id,
            ds_type=ds_type,
            config=datasource.config,
            table_name=db_table.source_table_name,
        )
    elif db_table.source_kind == "sql_query" and db_table.source_query:
        inferred_columns = infer_schema_from_sql(
            db=db,
            datasource=datasource,
            sql_query=db_table.source_query,
        )

    normalized = [
        str(column.get("name") or "").strip()
        for column in inferred_columns or []
        if str(column.get("name") or "").strip()
    ]
    if normalized:
        return normalized

    cached = _extract_cached_source_columns(db_table)
    if cached:
        return cached
    return [column.name for column in (fallback_columns or []) if str(column.name or "").strip()]


def _infer_dataset_table_columns(
    db: Session,
    dataset_obj: Dataset,
    datasource: Optional[DataSource],
    db_table: DatasetTable | Any,
) -> List[DatasetColumnMetadata]:
    if is_generated_calendar_table(db_table):
        return [
            DatasetColumnMetadata(
                name=str(column.get("name") or ""),
                type=str(column.get("type") or "string"),
                nullable=bool(column.get("nullable", False)),
            )
            for column in build_calendar_columns_cache()["columns"]
            if str(column.get("name") or "").strip()
        ]

    if _has_server_side_projection_changes(db_table):
        if is_derived_table(db_table):
            datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                db,
                dataset_obj,
                db_table,
            )
            result = LiveQueryService.execute_preview_query(
                datasource=datasource,
                db_table=live_proxy_table,
                limit=200,
                offset=0,
            )
        else:
            if datasource is None:
                raise DatasetTableSqlError("Datasource not found", code="DATASOURCE_NOT_FOUND")
            result = LiveQueryService.execute_preview_query(
                datasource=datasource,
                db_table=db_table,
                limit=200,
                offset=0,
            )

        column_names = list(result.get("columns") or [])
        rows = list(result.get("rows") or [])
        return [
            DatasetColumnMetadata(
                name=column_name,
                type=_infer_column_type(column_name, index, rows),
                nullable=True,
            )
            for index, column_name in enumerate(column_names)
        ]

    if is_derived_table(db_table):
        datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
            db,
            dataset_obj,
            db_table,
        )
        result = LiveQueryService.execute_preview_query(
            datasource=datasource,
            db_table=live_proxy_table,
            limit=200,
            offset=0,
        )
        column_names = list(result.get("columns") or [])
        rows = list(result.get("rows") or [])
        return [
            DatasetColumnMetadata(
                name=column_name,
                type=_infer_column_type(column_name, index, rows),
                nullable=True,
            )
            for index, column_name in enumerate(column_names)
        ]

    if datasource is None:
        raise DatasetTableSqlError("Datasource not found", code="DATASOURCE_NOT_FOUND")

    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    inferred_columns: List[Dict[str, Any]] = []
    if db_table.source_kind == "physical_table" and db_table.source_table_name:
        inferred_columns = DataSourceConnectionService.list_columns(
            ds_id=datasource.id,
            ds_type=ds_type,
            config=datasource.config,
            table_name=db_table.source_table_name,
        )
    elif db_table.source_kind == "sql_query" and db_table.source_query:
        inferred_columns = infer_schema_from_sql(
            db=db,
            datasource=datasource,
            sql_query=db_table.source_query,
        )

    normalized: List[DatasetColumnMetadata] = []
    for column in inferred_columns or []:
        name = str(column.get("name") or "").strip()
        if not name:
            continue
        col_type = str(column.get("type") or "string").strip().lower()
        normalized.append(
            DatasetColumnMetadata(
                name=name,
                type=col_type or "string",
                nullable=True,
            )
        )
    return normalized


# ===== Table Vector Search (must be before /{dataset_id} routes) =====

@router.get("/tables/search", response_model=List[dict])
def search_tables_vector(
    q: str,
    limit: int = Query(10, ge=1, le=20),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Vector similarity search across dataset tables accessible to the user."""
    from app.services.embedding_service import EmbeddingService
    from app.models.dataset import DatasetTable

    # Build set of dataset IDs the user is allowed to see
    accessible_ds_ids = {
        ds.id
        for ds in _owned_or_shared(db, Dataset, ResourceType.DATASET, current_user).all()
    }

    hits = EmbeddingService.search_similar(
        db, q, resource_type="dataset_table", limit=limit
    )
    if not hits:
        return []
    table_ids = [h["resource_id"] for h in hits]
    tables = db.query(DatasetTable).filter(
        DatasetTable.id.in_(table_ids)
    ).all()
    table_map = {t.id: t for t in tables}
    results = []
    for h in hits:
        t = table_map.get(h["resource_id"])
        if t and t.dataset_id in accessible_ds_ids:
            cols = []
            if t.column_stats:
                cols = list(t.column_stats.keys())
            elif t.columns_cache:
                cc = t.columns_cache
                if isinstance(cc, dict):
                    cc = cc.get("columns", [])
                cols = [c.get("name", c) if isinstance(c, dict) else c for c in cc]
            results.append({
                "id": t.id,
                "dataset_id": t.dataset_id,
                "display_name": t.display_name,
                "auto_description": t.auto_description,
                "columns": cols,
                "similarity": round(h["similarity"], 4),
            })
    return results


# ===== Dataset Endpoints =====

@router.get("/", response_model=List[DatasetResponse])
def list_datasets(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List datasets visible to the current user."""
    items = (
        _owned_or_shared(db, Dataset, ResourceType.DATASET, current_user)
        .options(
            selectinload(Dataset.tables),
        )
        .filter(Dataset.is_draft.is_(False))
        .offset(skip)
        .limit(limit)
        .all()
    )
    for item in items:
        item.user_permission = get_effective_permission(db, current_user, item, "datasets")
    _stamp_dataset_catalog_fields(items)
    stamp_owner_emails(db, items)
    return items


@router.post("/", response_model=DatasetResponse, status_code=201)
def create_dataset(
    dataset_in: DatasetCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("datasets", "edit")),
):
    """Create a new dataset"""
    try:
        db_dataset = DatasetCRUDService.create_dataset(db, dataset_in, owner_id=current_user.id)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _sync_dataset_model_safely(db, db_dataset.id)
    db.refresh(db_dataset)
    return db_dataset


@router.get("/{dataset_id}", response_model=DatasetWithTables)
def get_dataset(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a dataset by ID with its tables"""
    dataset_obj = DatasetCRUDService.get_dataset_by_id(
        db, dataset_id, include_tables=True
    )
    
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    dataset_obj.user_permission = require_view_access(db, current_user, dataset_obj, "datasets")
    return dataset_obj


@router.put("/{dataset_id}", response_model=DatasetResponse)
def update_dataset(
    dataset_id: int,
    dataset_in: DatasetUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a dataset"""
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, ds, "datasets")
    try:
        db_dataset = DatasetCRUDService.update_dataset(
            db, dataset_id, dataset_in
        )
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if db_dataset:
        _sync_dataset_model_safely(db, dataset_id)
        db.refresh(db_dataset)
    return db_dataset


@router.delete("/{dataset_id}", status_code=204)
def delete_dataset(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a dataset, blocked if any of its tables are used by charts."""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_full_access(db, current_user, dataset_obj, "datasets")

    table_ids = [t.id for t in db.query(DatasetTable).filter(
        DatasetTable.dataset_id == dataset_id
    ).all()]

    if table_ids:
        blocking_charts = db.query(Chart).filter(Chart.dataset_table_id.in_(table_ids)).all()
        if blocking_charts:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": f"Dataset \"{dataset_obj.name}\" có bảng đang được sử dụng trong {len(blocking_charts)} biểu đồ và không thể xóa.",
                    "constraints": [
                        {"type": "chart", "id": c.id, "name": c.name}
                        for c in blocking_charts
                    ],
                },
            )

    # Block Workboard reference too — without this the CASCADE on
    # Workboard.dataset_id would silently drop every mini-app + its
    # submissions / sync_runs the moment the dataset is deleted, which
    # users almost never intend. Matches the Chart pre-check above.
    from app.modules.workboards.models import Workboard
    blocking_workboards = (
        db.query(Workboard)
        .filter(Workboard.dataset_id == dataset_id)
        .all()
    )
    if blocking_workboards:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    f"Dataset \"{dataset_obj.name}\" đang được dùng bởi "
                    f"{len(blocking_workboards)} workboard và không thể xóa."
                ),
                "constraints": [
                    {"type": "workboard", "id": wb.id, "name": wb.name}
                    for wb in blocking_workboards
                ],
            },
        )

    success = DatasetCRUDService.delete_dataset(db, dataset_id)
    if not success:
        raise HTTPException(status_code=404, detail="Dataset not found")


@router.get("/{dataset_id}/dictionary", response_model=DatasetDictionaryResponse)
def get_dataset_dictionary(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset_obj = DatasetCRUDService.get_dataset_by_id(db, dataset_id, include_tables=True)
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")
    return _serialize_dataset_dictionary(dataset_obj)


@router.put("/{dataset_id}/dictionary", response_model=DatasetDictionaryResponse)
def update_dataset_dictionary(
    dataset_id: int,
    body: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset_obj = DatasetCRUDService.get_dataset_by_id(db, dataset_id, include_tables=True)
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    normalized_dictionary = normalize_dictionary_payload(body)
    dataset_obj.dictionary = normalized_dictionary or None
    dataset_obj.dictionary_updated_at = datetime.utcnow()
    db.commit()
    db.refresh(dataset_obj)
    dataset_obj = DatasetCRUDService.get_dataset_by_id(db, dataset_id, include_tables=True)
    return _serialize_dataset_dictionary(dataset_obj)


@router.get("/{dataset_id}/dictionary/context", response_model=DatasetDictionaryResponse)
def get_dataset_dictionary_context(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset_obj = DatasetCRUDService.get_dataset_by_id(db, dataset_id, include_tables=True)
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")
    return _serialize_dataset_dictionary(dataset_obj)


# ===== Table Endpoints =====

@router.get("/{dataset_id}/tables", response_model=List[TableResponse])
def list_dataset_tables(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all tables in a dataset"""
    dataset_obj = DatasetCRUDService.get_dataset_by_id(db, dataset_id)
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    tables = DatasetCRUDService.get_dataset_tables(db, dataset_id)
    return tables


@router.get("/{dataset_id}/tables/source-status")
def get_dataset_table_source_status(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Check whether physical dataset tables still exist in their live datasource."""
    dataset_obj = DatasetCRUDService.get_dataset_by_id(db, dataset_id)
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    tables = DatasetCRUDService.get_dataset_tables(db, dataset_id)
    datasource_ids = sorted(
        {
            int(table.datasource_id)
            for table in tables
            if getattr(table, "datasource_id", None) is not None
        }
    )
    datasources = {
        datasource.id: datasource
        for datasource in (
            db.query(DataSource)
            .filter(DataSource.id.in_(datasource_ids))
            .all()
            if datasource_ids
            else []
        )
    }
    live_table_cache: Dict[int, List[Dict[str, Any]]] = {}
    live_table_errors: Dict[int, str] = {}

    def get_live_tables(datasource: DataSource) -> List[Dict[str, Any]]:
        if datasource.id not in live_table_cache and datasource.id not in live_table_errors:
            ds_type = datasource.type.value if hasattr(datasource.type, "value") else str(datasource.type)
            try:
                live_table_cache[datasource.id] = DataSourceConnectionService.list_tables(
                    ds_type,
                    datasource.config,
                )
            except Exception as exc:
                live_table_errors[datasource.id] = _normalize_preview_error_message(exc)
        return live_table_cache.get(datasource.id, [])

    statuses: List[Dict[str, Any]] = []
    for table in tables:
        base = {
            "table_id": table.id,
            "table_name": table.display_name or table.source_table_name,
            "source_kind": table.source_kind,
            "source_table_name": table.source_table_name,
            "datasource_id": table.datasource_id,
        }
        if table.source_kind != "physical_table" or not table.datasource_id or not table.source_table_name:
            statuses.append({**base, "status": "ok", "code": None, "message": None})
            continue

        datasource = datasources.get(table.datasource_id)
        if not datasource:
            statuses.append({
                **base,
                "status": "error",
                "code": "DATASOURCE_MISSING",
                "message": "The datasource connected to this table no longer exists or is not accessible.",
            })
            continue

        live_tables = get_live_tables(datasource)
        if datasource.id in live_table_errors:
            statuses.append({
                **base,
                "status": "ok",
                "code": "SOURCE_STATUS_UNVERIFIED",
                "message": "Could not verify this table against the connected datasource.",
                "verified": False,
                "raw_error": live_table_errors[datasource.id],
            })
            continue

        exists = any(
            _source_table_name_matches(table.source_table_name, live_table.get("name"))
            for live_table in live_tables
        )
        if exists:
            statuses.append({**base, "status": "ok", "code": None, "message": None})
        else:
            statuses.append({
                **base,
                "status": "missing",
                **_build_source_table_missing_detail(table, datasource),
            })

    return {
        "tables": statuses,
        "checked_at": datetime.utcnow().isoformat() + "Z",
    }


@router.post("/{dataset_id}/tables", status_code=201)
def add_table_to_dataset(
    dataset_id: int,
    table: TableCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a table to a dataset"""
    try:
        ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not ds:
            raise HTTPException(status_code=404, detail="Dataset not found")
        require_edit_access(db, current_user, ds, "datasets")

        datasource: Optional[DataSource] = None
        inferred_metadata: List[DatasetColumnMetadata] = []
        inferred_rows: List[Dict[str, Any]] = []

        if table.source_kind == "derived_table":
            try:
                table.source_query = validate_and_clean_derived_query(table.source_query or "")
                draft_display_name = str(
                    table.display_name
                    or "Calculated Table"
                ).strip()
                derived_draft = SimpleNamespace(
                    id=None,
                    dataset_id=dataset_id,
                    datasource_id=None,
                    source_kind="derived_table",
                    source_table_name=None,
                    source_query=table.source_query,
                    display_name=draft_display_name,
                    enabled=table.enabled,
                    transformations=table.transformations or [],
                    type_overrides=None,
                    columns_cache=None,
                )
                datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                    db,
                    ds,
                    derived_draft,
                )
                inferred_metadata, inferred_rows = _preview_live_table_draft(
                    datasource,
                    live_proxy_table,
                )
            except DatasetTableSqlError as exc:
                status_code = 422 if getattr(exc, "code", "") == "NOT_SYNCED" else 400
                detail: Any = str(exc)
                if getattr(exc, "code", "") == "NOT_SYNCED":
                    detail = {"code": exc.code, "message": str(exc)}
                raise HTTPException(status_code=status_code, detail=detail)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
            except HTTPException:
                raise
            except Exception as exc:
                # Surface the actual engine/datasource error (e.g. DuckDB
                # "Table dataset_table_X does not exist") instead of a generic
                # 500 — the user needs to know what to fix in their SQL.
                logger.exception("Calculated table preview failed for dataset %s", dataset_id)
                message = _normalize_preview_error_message(exc) or "Calculated table preview failed."
                raise HTTPException(
                    status_code=400 if _is_fixable_preview_error(exc) else 422,
                    detail=f"Calculated table preview failed: {message}",
                ) from exc
        else:
            # Validate datasource exists
            datasource = db.query(DataSource).filter(DataSource.id == table.datasource_id).first()
            if not datasource:
                raise HTTPException(status_code=404, detail="Datasource not found")
            require_view_access(db, current_user, datasource, "data_sources")

        # Validate SQL query if source_kind is datasource-backed 'sql_query'
        if table.source_kind == "sql_query":
            from app.services.query_validator import QueryValidator, QueryValidationError
            try:
                # Validate and clean the query
                table.source_query = QueryValidator.validate_and_clean(table.source_query)
                if datasource is None:
                    raise HTTPException(status_code=404, detail="Datasource not found")

                sql_query_draft = SimpleNamespace(
                    id=None,
                    dataset_id=dataset_id,
                    datasource_id=table.datasource_id,
                    source_kind="sql_query",
                    source_table_name=None,
                    source_query=table.source_query,
                    display_name=str(table.display_name or "Untitled Table").strip(),
                    enabled=table.enabled,
                    transformations=table.transformations or [],
                    type_overrides=None,
                    columns_cache=None,
                )
                inferred_metadata, inferred_rows = _preview_live_table_draft(
                    datasource,
                    sql_query_draft,
                )
            except QueryValidationError as e:
                raise HTTPException(status_code=400, detail=f"Invalid SQL query: {str(e)}")
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except Exception as exc:
                if _is_fixable_preview_error(exc):
                    raise HTTPException(status_code=400, detail=_normalize_preview_error_message(exc)) from exc
                raise
        
        try:
            db_table = DatasetCRUDService.add_table_to_dataset(
                db, dataset_id, table
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        
        if not db_table:
            raise HTTPException(status_code=404, detail="Dataset not found")

        if not datasource_sync_enabled() and db_table.datasource_id is not None:
            db_table.query_mode = "live"
            db.commit()
            db.refresh(db_table)

        # ── Auto-detect table size and set query_mode ──
        if datasource_sync_enabled() and datasource is not None and db_table.source_kind == "physical_table" and db_table.source_table_name:
            try:
                ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
                stn = db_table.source_table_name.strip().strip('"').strip("'")
                if "." in stn:
                    schema_name, tbl_name = stn.split(".", 1)
                    schema_name = schema_name.strip('"').strip("'")
                    tbl_name = tbl_name.strip('"').strip("'")
                else:
                    schema_name = "public" if ds_type == "postgresql" else ""
                    tbl_name = stn

                size_info = LiveQueryService.get_table_size_metadata(
                    ds_type, datasource.config, schema_name, tbl_name,
                )
                if size_info.get("estimated_row_count") or size_info.get("estimated_size_bytes"):
                    db_table.estimated_row_count = size_info.get("estimated_row_count")
                    db_table.estimated_size_bytes = size_info.get("estimated_size_bytes")
                    if LiveQueryService.should_use_live_mode(
                        size_info.get("estimated_row_count"),
                        size_info.get("estimated_size_bytes"),
                    ):
                        db_table.query_mode = "live"
                        logger.info(
                            "Table %s auto-set to live mode (rows=%s, bytes=%s)",
                            db_table.source_table_name,
                            size_info.get("estimated_row_count"),
                            size_info.get("estimated_size_bytes"),
                        )
                    db.commit()
                    db.refresh(db_table)
            except Exception as e:
                logger.warning("Size detection failed for table %s: %s", db_table.source_table_name, e)
        elif datasource is not None and db_table.source_kind == "physical_table" and db_table.source_table_name:
            try:
                ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
                stn = db_table.source_table_name.strip().strip('"').strip("'")
                if "." in stn:
                    schema_name, tbl_name = stn.split(".", 1)
                    schema_name = schema_name.strip('"').strip("'")
                    tbl_name = tbl_name.strip('"').strip("'")
                else:
                    schema_name = "public" if ds_type == "postgresql" else ""
                    tbl_name = stn
                size_info = LiveQueryService.get_table_size_metadata(
                    ds_type, datasource.config, schema_name, tbl_name,
                )
                db_table.estimated_row_count = size_info.get("estimated_row_count")
                db_table.estimated_size_bytes = size_info.get("estimated_size_bytes")
                db.commit()
                db.refresh(db_table)
            except Exception as e:
                logger.warning("Size detection failed for live-only table %s: %s", db_table.source_table_name, e)

        try:
            if not inferred_metadata:
                inferred_metadata = _infer_dataset_table_columns(db, ds, datasource, db_table)
            if inferred_metadata:
                source_columns = _infer_dataset_table_source_columns(
                    db,
                    ds,
                    datasource,
                    db_table,
                    fallback_columns=inferred_metadata,
                )
                db_table = DatasetCRUDService.update_table_cache(
                    db,
                    db_table.id,
                    columns_cache=_build_columns_cache_payload(
                        db_table,
                        inferred_metadata,
                        source_columns=source_columns,
                    ),
                    sample_cache=_serialize_cached_rows(inferred_rows) or None,
                ) or db_table
        except Exception as e:
            logger.warning("Column inference failed for dataset table %s: %s", db_table.id, e)

        # Queue a single AI-description pipeline to avoid duplicate generate/embed work.
        DescriptionPipelineService.enqueue_table_pipeline(
            background_tasks,
            db,
            db_table.id,
            trigger="table_created",
        )

        _enqueue_auto_type_detection_if_needed(background_tasks, db_table)

        _sync_dataset_model_safely(db, dataset_id)
        db.refresh(db_table)

        # Return plain dict instead of model to avoid serialization issues
        return {
            "id": db_table.id,
            "dataset_id": db_table.dataset_id,
            "datasource_id": db_table.datasource_id,
            "source_kind": db_table.source_kind,
            "source_table_name": db_table.source_table_name,
            "source_query": db_table.source_query,
            "display_name": db_table.display_name,
            "enabled": db_table.enabled,
            "transformations": db_table.transformations,
            "columns_cache": db_table.columns_cache,
            "sample_cache": db_table.sample_cache,
            "type_overrides": db_table.type_overrides,
            "column_formats": db_table.column_formats,
            "query_mode": getattr(db_table, 'query_mode', 'synced') or 'synced',
            "estimated_row_count": getattr(db_table, 'estimated_row_count', None),
            "estimated_size_bytes": getattr(db_table, 'estimated_size_bytes', None),
            "created_at": db_table.created_at.isoformat() if db_table.created_at else None,
            "updated_at": db_table.updated_at.isoformat() if db_table.updated_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to add table to dataset")
        raise HTTPException(status_code=500, detail="Failed to add table to dataset.")


@router.put("/{dataset_id}/tables/{table_id}", response_model=TableResponse)
def update_dataset_table(
    dataset_id: int,
    table_id: int,
    table_update: TableUpdate,
    background_tasks: BackgroundTasks,
    force: bool = Query(False, description="Bypass the cascade guard that blocks dropping columns still referenced by dimensions/measures."),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a table in a dataset.

    Cascade guard: when transformations would drop columns currently used by
    a dimension or measure, the default request returns 409 with the list of
    affected semantic objects. Pass ``?force=true`` to override.
    """
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, ds, "datasets")
    # Verify table belongs to dataset
    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    if is_generated_calendar_table(db_table):
        raise HTTPException(
            status_code=400,
            detail="Standard Date table is managed by dataset calendar settings and cannot be edited here.",
        )

    # Reject source_query updates on unsupported table kinds
    if table_update.source_query is not None and db_table.source_kind not in {"sql_query", "derived_table"}:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot set source_query on a '{db_table.source_kind}' table.",
        )
    datasource: Optional[DataSource] = None
    preview_metadata: List[DatasetColumnMetadata] = []
    preview_rows: List[Dict[str, Any]] = []

    # Validate SQL query if source_query is being updated
    if table_update.source_query is not None:
        if db_table.source_kind == "derived_table":
            try:
                table_update.source_query = validate_and_clean_derived_query(table_update.source_query)
                # Phase-2: reject cycles before we accept the new source_query.
                # collect_derived_dependency_table_ids resolves alias → table_id;
                # check_derived_table_cycle then walks the downstream graph.
                proposed_deps = collect_derived_dependency_table_ids(
                    db,
                    dataset_id,
                    table_update.source_query,
                    exclude_table_id=db_table.id,
                )
                from app.services.dataset_table_sql_service import check_derived_table_cycle
                check_derived_table_cycle(
                    db,
                    dataset_id,
                    table_id=db_table.id,
                    proposed_dependency_ids=proposed_deps,
                )
                table_draft = _build_table_draft(db_table, table_update)
                datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                    db,
                    ds,
                    table_draft,
                )
                preview_metadata, preview_rows = _preview_live_table_draft(
                    datasource,
                    live_proxy_table,
                )
            except DatasetTableSqlError as exc:
                status_code = 422 if getattr(exc, "code", "") == "NOT_SYNCED" else 400
                detail: Any = str(exc)
                if getattr(exc, "code", "") == "NOT_SYNCED":
                    detail = {"code": exc.code, "message": str(exc)}
                raise HTTPException(status_code=status_code, detail=detail)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
        else:
            from app.services.query_validator import QueryValidator, QueryValidationError
            try:
                table_update.source_query = QueryValidator.validate_and_clean(table_update.source_query)
                datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
                if not datasource:
                    raise HTTPException(status_code=404, detail="Datasource not found")

                table_draft = _build_table_draft(db_table, table_update)
                preview_metadata, preview_rows = _preview_live_table_draft(
                    datasource,
                    table_draft,
                )
            except QueryValidationError as e:
                raise HTTPException(status_code=400, detail=f"Invalid SQL query: {str(e)}")
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except Exception as exc:
                if _is_fixable_preview_error(exc):
                    raise HTTPException(status_code=400, detail=_normalize_preview_error_message(exc)) from exc
                raise

    if table_update.type_overrides is not None:
        from app.services.type_override_service import _canonical_column_key

        normalized_overrides = normalize_type_overrides(table_update.type_overrides)
        current_overrides = normalize_type_overrides(getattr(db_table, "type_overrides", None))

        # Resolve override keys against the actual base-query columns. Frontend
        # may send display_name (e.g. "REV FINAL (TRỪ VAT, GỒM BBDS)") while
        # the SQL plan exposes a canonical/safe identifier. Without this remap,
        # save succeeds but the cast layer never matches the column at query
        # time -> SUM falls back to VARCHAR and fails on rows with text.
        if normalized_overrides and db_table.datasource_id is not None:
            try:
                _resolve_ds = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
                if _resolve_ds is not None:
                    _resolve_draft = _build_table_draft(db_table, table_update)
                    _resolve_plan = build_live_base_query_plan(
                        _resolve_ds, _resolve_draft, apply_type_overrides=False
                    )
                    _avail = [str(c) for c in (_resolve_plan.output_columns or [])]
                    _avail_set = set(_avail)
                    _canon_map = {_canonical_column_key(c): c for c in _avail}
                    remapped: Dict[str, str] = {}
                    for col, tgt in normalized_overrides.items():
                        if col in _avail_set:
                            remapped[col] = tgt
                        else:
                            resolved = _canon_map.get(_canonical_column_key(col))
                            remapped[resolved if resolved else col] = tgt
                    normalized_overrides = remapped
            except Exception:
                # Best-effort remap; fall through to existing audit which will
                # surface a precise "Unknown column" error if still mismatched.
                pass

        changed_overrides = {
            column: target_type
            for column, target_type in normalized_overrides.items()
            if current_overrides.get(column) != target_type
        }

        if changed_overrides:
            if db_table.datasource_id is not None:
                datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
                if not datasource:
                    raise HTTPException(status_code=404, detail="Datasource not found")
                table_draft = _build_table_draft(db_table, table_update)

                try:
                    # Specialty: the audit checks how many rows would FAIL to
                    # cast under the candidate overrides. We must run it
                    # against the raw base query — applying overrides here
                    # would make every check look successful by construction.
                    # Do NOT route through resolve_dataset_table_relation.
                    plan = build_live_base_query_plan(
                        datasource,
                        table_draft,
                        apply_type_overrides=False,
                    )
                    audits = audit_type_overrides(
                        datasource=datasource,
                        table_identifier=build_dataset_table_cache_identifier(table_draft),
                        base_query=plan.sql,
                        candidate_overrides=changed_overrides,
                        available_columns=plan.output_columns,
                        dialect=(
                            datasource.type.value
                            if hasattr(datasource.type, "value")
                            else str(datasource.type)
                        ),
                    )
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=str(exc))

                invalid_audits = [audit.to_dict() for audit in audits if audit.invalid_count > 0]
                if invalid_audits:
                    raise HTTPException(
                        status_code=400,
                        detail={
                            "message": _format_type_audit_error(invalid_audits),
                            "type_audit": invalid_audits,
                        },
                    )

        table_update.type_overrides = normalized_overrides

    schema_refresh_requested = any(
        value is not None
        for value in (
            table_update.source_query,
            table_update.transformations,
            table_update.type_overrides,
        )
    )

    if schema_refresh_requested and (
        table_update.transformations is not None or table_update.type_overrides is not None
    ):
        validation_draft = _build_table_draft(db_table, table_update)
        validation_datasource = datasource
        if validation_datasource is None and getattr(validation_draft, "datasource_id", None) is not None:
            validation_datasource = db.query(DataSource).filter(
                DataSource.id == validation_draft.datasource_id
            ).first()
        try:
            preview_metadata = _infer_dataset_table_columns(
                db,
                ds,
                validation_datasource,
                validation_draft,
            )
        except DatasetTableSqlError as exc:
            status_code = 422 if getattr(exc, "code", "") == "NOT_SYNCED" else 400
            detail: Any = str(exc)
            if getattr(exc, "code", "") == "NOT_SYNCED":
                detail = {"code": exc.code, "message": str(exc)}
            raise HTTPException(status_code=status_code, detail=detail)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            if _is_fixable_preview_error(exc):
                raise HTTPException(status_code=400, detail=_normalize_preview_error_message(exc)) from exc
            raise

        # Phase-2 / Phase-3 refinement: cascade check. When transformations
        # would drop columns currently referenced by a dimension or measure,
        # respond with 409 (soft conflict) plus structured payload so the FE
        # can show a confirm dialog instead of a generic toast. Caller may
        # retry with ?force=true to bypass.
        if preview_metadata and not force:
            new_cols = {
                str(col.get("name") if isinstance(col, dict) else col).strip()
                for col in preview_metadata
                if (col.get("name") if isinstance(col, dict) else col)
            }
            old_cols = _columns_for_table(db_table)
            dropped = old_cols - new_cols
            if dropped:
                refs = _find_semantic_refs_to_columns(db, table_id, dropped)
                if refs:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "COLUMN_CASCADE",
                            "message": (
                                f"{len(refs)} tham chiếu semantic đang dùng các cột sắp bị xoá. "
                                "Xác nhận để tiếp tục (các dimension/measure đó cần sửa lại sau)."
                            ),
                            "dropped_columns": sorted(dropped),
                            "affected_refs": refs,
                        },
                    )

    try:
        updated_table = DatasetCRUDService.update_table(
            db, table_id, table_update
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if updated_table and db_table.datasource_id is not None:
        query_cache.invalidate_datasource(db_table.datasource_id)

    if updated_table and schema_refresh_requested:
        datasource = db.query(DataSource).filter(DataSource.id == updated_table.datasource_id).first() if updated_table.datasource_id is not None else None
        try:
            inferred_metadata = preview_metadata or _infer_dataset_table_columns(db, ds, datasource, updated_table)
            if inferred_metadata:
                source_columns = _infer_dataset_table_source_columns(
                    db,
                    ds,
                    datasource,
                    updated_table,
                    fallback_columns=inferred_metadata,
                )
                updated_table = DatasetCRUDService.update_table_cache(
                    db,
                    updated_table.id,
                    columns_cache=_build_columns_cache_payload(
                        updated_table,
                        inferred_metadata,
                        source_columns=source_columns,
                    ),
                    sample_cache=_serialize_cached_rows(preview_rows) or None,
                ) or updated_table
                # Phase-2: flag the table as schema-changed synchronously so
                # any concurrent semantic-view save in the same session sees
                # the new column set. The background description pipeline
                # will clear this flag once it finishes re-describing.
                if updated_table is not None:
                    updated_table.schema_change_pending = True
                    db.commit()
        except Exception as exc:
            logger.warning("Column inference failed after updating table %s: %s", updated_table.id, exc)

    DescriptionPipelineService.enqueue_table_pipeline(
        background_tasks,
        db,
        table_id,
        trigger="table_updated",
    )

    _sync_dataset_model_safely(db, dataset_id)
    if updated_table:
        db.refresh(updated_table)

    return updated_table


@router.delete("/{dataset_id}/tables/{table_id}", status_code=204)
def remove_table_from_dataset(
    dataset_id: int,
    table_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove a table from a dataset, after checking for chart/formula dependencies"""
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, ds, "datasets")
    # Verify table belongs to dataset
    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    dataset_table_ids = [
        int(row[0])
        for row in db.query(DatasetTable.id).filter(DatasetTable.dataset_id == dataset_id).all()
    ]

    # ------------------------------------------------------------------
    # Check 1: charts that directly reference this table
    # ------------------------------------------------------------------
    blocking_charts = (
        db.query(Chart)
        .filter(Chart.dataset_table_id == table_id)
        .all()
    )

    # ------------------------------------------------------------------
    # Check 2: other tables in this dataset whose js_formula
    # transformations reference this table by its display label
    # ------------------------------------------------------------------
    table_label = db_table.display_name or db_table.source_table_name or str(table_id)
    other_tables = (
        db.query(DatasetTable)
        .filter(
            DatasetTable.dataset_id == dataset_id,
            DatasetTable.id != table_id,
        )
        .all()
    )
    blocking_lookups = []
    blocking_calculated_tables = []
    for t in other_tables:
        if is_derived_table(t) and t.source_query:
            depends_on_table = False
            try:
                depends_on_table = table_id in collect_derived_dependency_table_ids(
                    db,
                    dataset_id,
                    t.source_query,
                    exclude_table_id=t.id,
                )
            except DatasetTableSqlError as exc:
                # Parsing failed — the other derived table's SQL is itself broken.
                # Treating an unparseable SQL as a dependency via substring match
                # caused false-positive 409s when an alias happened to appear in a
                # comment or unrelated identifier. Skip this candidate instead.
                logger.warning(
                    "Skipping derived-table dependency check for table %s while deleting %s: %s",
                    t.id,
                    table_id,
                    exc,
                )
                depends_on_table = False

            if depends_on_table:
                calculated_name = t.display_name or t.source_table_name or f"Table {t.id}"
                blocking_calculated_tables.append(_build_delete_constraint(
                    "calculated_table",
                    table_id=t.id,
                    table_name=calculated_name,
                    object_label=f'Calculated table "{calculated_name}"',
                    detail="Its SQL still depends on this source table.",
                ))

        transforms = t.transformations or []
        for step in transforms:
            if step.get("type") == "js_formula" and step.get("enabled", True):
                formula = step.get("params", {}).get("formula", "")
                if _formula_references_dataset_table(formula, db_table):
                    lookup_table_name = t.display_name or t.source_table_name or f"Table {t.id}"
                    lookup_column = step.get("params", {}).get("newField", "")
                    blocking_lookups.append(_build_delete_constraint(
                        "lookup",
                        table_id=t.id,
                        table_name=lookup_table_name,
                        column=lookup_column,
                        object_label=(
                            f'Column "{lookup_column}" in table "{lookup_table_name}"'
                            if lookup_column
                            else f'Table "{lookup_table_name}"'
                        ),
                        detail="A LOOKUP or js_formula column here still references this table.",
                    ))
                    break  # one entry per table is enough

    # ------------------------------------------------------------------
    # Check 3: semantic filters / saved config that explicitly reference
    # this table's semantic fields (dashboard filters, public links, or
    # chart configs that store qualified fields).
    # ------------------------------------------------------------------
    semantic_prefixes = _semantic_prefixes_for_table(
        db,
        dataset_id=dataset_id,
        table=db_table,
    )
    blocking_semantic_refs = []
    if semantic_prefixes and dataset_table_ids:
        direct_chart_ids = {chart.id for chart in blocking_charts}
        dataset_charts = (
            db.query(Chart)
            .filter(Chart.dataset_table_id.in_(dataset_table_ids))
            .all()
        )
        for chart in dataset_charts:
            if chart.id in direct_chart_ids:
                continue
            chart_config = chart.config if isinstance(chart.config, dict) else {}
            if _config_references_semantic_prefix(chart_config, semantic_prefixes):
                chart_name = chart.name or f"Chart {chart.id}"
                blocking_semantic_refs.append(_build_delete_constraint(
                    "chart_filter",
                    id=chart.id,
                    name=chart_name,
                    object_label=f'Chart "{chart_name}"',
                    detail="Its saved semantic configuration still references fields from this table.",
                ))

        dashboard_ids = [
            int(row[0])
            for row in (
                db.query(Dashboard.id)
                .join(Dashboard.dashboard_charts)
                .join(DashboardChart.chart)
                .filter(Chart.dataset_table_id.in_(dataset_table_ids))
                .distinct()
                .all()
            )
        ]
        dashboards = (
            db.query(Dashboard)
            .filter(Dashboard.id.in_(dashboard_ids))
            .all()
            if dashboard_ids
            else []
        )
        dashboard_dataset_ids: dict[int, set[int]] = {dashboard_id: set() for dashboard_id in dashboard_ids}
        if dashboard_ids:
            dashboard_dataset_rows = (
                db.query(Dashboard.id, DatasetTable.dataset_id)
                .join(Dashboard.dashboard_charts)
                .join(DashboardChart.chart)
                .join(DatasetTable, Chart.dataset_table_id == DatasetTable.id)
                .filter(Dashboard.id.in_(dashboard_ids))
                .distinct()
                .all()
            )
            for dashboard_id, linked_dataset_id in dashboard_dataset_rows:
                if linked_dataset_id is not None:
                    dashboard_dataset_ids.setdefault(int(dashboard_id), set()).add(int(linked_dataset_id))
        public_links = (
            db.query(DashboardPublicLink)
            .filter(DashboardPublicLink.dashboard_id.in_(dashboard_ids))
            .all()
            if dashboard_ids
            else []
        )

        for dashboard in dashboards:
            allow_unscoped_filters = dashboard_dataset_ids.get(int(dashboard.id), set()) == {int(dataset_id)}
            for filter_obj in dashboard.filters_config or []:
                if _filter_references_semantic_prefix(
                    filter_obj,
                    dataset_id,
                    semantic_prefixes,
                    allow_unscoped=allow_unscoped_filters,
                ):
                    field_name = filter_obj.get("label") or filter_obj.get("semanticField") or filter_obj.get("field")
                    dashboard_name = dashboard.name or f"Dashboard {dashboard.id}"
                    blocking_semantic_refs.append(_build_delete_constraint(
                        "dashboard_filter",
                        id=dashboard.id,
                        name=dashboard_name,
                        field=field_name,
                        object_label=f'Dashboard "{dashboard_name}"',
                        detail=(
                            f'Filter "{field_name}" still references this table.'
                            if field_name
                            else "One of its filters still references this table."
                        ),
                    ))
                    break
            for filter_obj in dashboard.public_filters_config or []:
                if _filter_references_semantic_prefix(
                    filter_obj,
                    dataset_id,
                    semantic_prefixes,
                    allow_unscoped=allow_unscoped_filters,
                ):
                    field_name = filter_obj.get("label") or filter_obj.get("semanticField") or filter_obj.get("field")
                    dashboard_name = dashboard.name or f"Dashboard {dashboard.id}"
                    blocking_semantic_refs.append(_build_delete_constraint(
                        "public_link_filter",
                        id=dashboard.id,
                        name=dashboard_name,
                        field=field_name,
                        scope="dashboard_public_filters",
                        object_label=f'Dashboard "{dashboard_name}" public filters',
                        detail=(
                            f'Public filter "{field_name}" still references this table.'
                            if field_name
                            else "A public dashboard filter still references this table."
                        ),
                    ))
                    break

        for link in public_links:
            allow_unscoped_filters = dashboard_dataset_ids.get(int(link.dashboard_id), set()) == {int(dataset_id)}
            for filter_obj in link.filters_config or []:
                if _filter_references_semantic_prefix(
                    filter_obj,
                    dataset_id,
                    semantic_prefixes,
                    allow_unscoped=allow_unscoped_filters,
                ):
                    field_name = filter_obj.get("label") or filter_obj.get("semanticField") or filter_obj.get("field")
                    link_name = link.name or f"Public link {link.id}"
                    blocking_semantic_refs.append(_build_delete_constraint(
                        "public_link_filter",
                        id=link.dashboard_id,
                        link_id=link.id,
                        name=link_name,
                        field=field_name,
                        scope="public_link",
                        object_label=f'Public link "{link_name}"',
                        detail=(
                            f'Filter "{field_name}" still references this table.'
                            if field_name
                            else "One of its filters still references this table."
                        ),
                    ))
                    break

    # ------------------------------------------------------------------
    # Check 4: semantic measures defined on this table, and measures on
    # other tables that depend on them. Without this check, the silent
    # cascade in _cleanup_semantic_view_for_table would delete every
    # measure for the table and break any cross-view depends_on links.
    # ------------------------------------------------------------------
    from app.models.semantic import SemanticView

    blocking_measures: List[Dict[str, Any]] = []
    this_view = (
        db.query(SemanticView)
        .filter(SemanticView.dataset_table_id == table_id)
        .first()
    )
    this_measure_names: set[str] = set()
    if this_view is not None and isinstance(this_view.measures, list):
        own_measure_names = [
            str(m.get("name") or "").strip()
            for m in this_view.measures
            if isinstance(m, dict) and str(m.get("name") or "").strip()
        ]
        this_measure_names = {n for n in own_measure_names if n}
        if own_measure_names:
            preview = ", ".join(own_measure_names[:5])
            if len(own_measure_names) > 5:
                preview += f", … (+{len(own_measure_names) - 5})"
            blocking_measures.append(_build_delete_constraint(
                "semantic_measure",
                count=len(own_measure_names),
                names=own_measure_names,
                object_label=f'Bảng có {len(own_measure_names)} measure đang định nghĩa',
                detail=f"Xóa các measure trước hoặc giữ lại bảng. Measures: {preview}.",
            ))

    if this_measure_names and dataset_table_ids:
        other_views = (
            db.query(SemanticView)
            .filter(
                SemanticView.dataset_table_id.in_(dataset_table_ids),
                SemanticView.dataset_table_id != table_id,
            )
            .all()
        )
        for view in other_views:
            measures_list = view.measures if isinstance(view.measures, list) else []
            for measure in measures_list:
                if not isinstance(measure, dict):
                    continue
                depends_on = measure.get("depends_on") or []
                referenced = measure_dependencies_referencing_view(
                    depends_on,
                    owner_view_name=view.name,
                    target_view_name=this_view.name,
                    target_measure_names=this_measure_names,
                )
                if not referenced:
                    continue
                measure_name = str(measure.get("name") or "").strip() or "(unnamed)"
                blocking_measures.append(_build_delete_constraint(
                    "measure_dependency",
                    view_id=view.id,
                    view_name=view.name,
                    measure=measure_name,
                    references=sorted(referenced),
                    object_label=f'Measure "{measure_name}" in view "{view.name}"',
                    detail=(
                        f"Phụ thuộc vào measure: {', '.join(sorted(referenced))} của bảng này."
                    ),
                ))

    # ------------------------------------------------------------------
    # Check 5: workboards that reference this table either as the primary
    # table or via any screen.table_id inside their layout. Without this
    # block, the FK CASCADE on Workboard.primary_table_id silently deletes
    # the entire mini-app + submissions when the user removes a single
    # table; for screen-level references the row stays but every screen
    # bound to the missing table becomes a 400 at runtime.
    # ------------------------------------------------------------------
    from app.modules.workboards.models import Workboard
    blocking_workboards: list[dict[str, Any]] = []
    workboards_in_dataset = (
        db.query(Workboard)
        .filter(Workboard.dataset_id == dataset_id)
        .all()
    )
    for wb in workboards_in_dataset:
        if wb.primary_table_id == table_id:
            blocking_workboards.append(_build_delete_constraint(
                "workboard_primary_table",
                id=wb.id,
                name=wb.name,
                object_label=f'Workboard "{wb.name}" (primary table)',
                detail="This table is the workboard's primary data source.",
            ))
            continue
        layout = wb.layout_json or {}
        screens = layout.get("screens") if isinstance(layout, dict) else None
        if not isinstance(screens, list):
            continue
        screen_refs = []
        for screen in screens:
            if not isinstance(screen, dict):
                continue
            if screen.get("table_id") == table_id:
                screen_refs.append({
                    "screen_id": screen.get("id"),
                    "screen_kind": screen.get("kind"),
                    "screen_title": screen.get("title"),
                })
        if screen_refs:
            blocking_workboards.append(_build_delete_constraint(
                "workboard_screen",
                id=wb.id,
                name=wb.name,
                object_label=f'Workboard "{wb.name}" (screen reference)',
                detail=(
                    f"{len(screen_refs)} screen(s) bind this table — "
                    "remove or rebind them in the workboard builder first."
                ),
                screens=screen_refs,
            ))

    constraints = []
    for ch in blocking_charts:
        chart_name = ch.name or f"Chart {ch.id}"
        constraints.append(_build_delete_constraint(
            "chart",
            id=ch.id,
            name=chart_name,
            object_label=f'Chart "{chart_name}"',
            detail="This chart is built directly from the table you are trying to delete.",
        ))
    constraints.extend(blocking_calculated_tables)
    constraints.extend(blocking_lookups)
    constraints.extend(blocking_semantic_refs)
    constraints.extend(blocking_measures)
    constraints.extend(blocking_workboards)
    constraints = _dedupe_delete_constraints(constraints)

    if constraints:
        raise HTTPException(
            status_code=409,
            detail={
                "message": f"Bảng \"{table_label}\" đang được sử dụng và không thể xóa.",
                "constraints": constraints,
            },
        )

    EmbeddingService.delete_embedding(db, "dataset_table", table_id)

    if is_generated_calendar_table(db_table):
        current_settings = get_calendar_settings(ds, enabled_default=False)
        DatasetCRUDService.update_dataset(
            db,
            dataset_id,
            DatasetUpdate.model_validate({
                "settings": {
                    "calendar_dimension": {
                        **current_settings,
                        "enabled": False,
                    }
                }
            }),
        )
        success = True
    else:
        datasource_id = db_table.datasource_id
        _cleanup_semantic_view_for_table(db, table_id)
        success = DatasetCRUDService.delete_table(db, table_id)
        if datasource_id is not None:
            query_cache.invalidate_datasource(datasource_id)
            if not DatasetCRUDService.dataset_has_datasource_backed_table(db, dataset_id):
                current_settings = get_calendar_settings(ds, enabled_default=False)
                if current_settings.get("enabled"):
                    DatasetCRUDService.update_dataset(
                        db,
                        dataset_id,
                        DatasetUpdate.model_validate({
                            "settings": {
                                "calendar_dimension": {
                                    **current_settings,
                                    "enabled": False,
                                }
                            }
                        }),
                    )
    _sync_dataset_model_safely(db, dataset_id)

    if not success:
        raise HTTPException(status_code=404, detail="Table not found")


@router.post(
    "/{dataset_id}/tables/{table_id}/preview",
    response_model=TablePreviewResponse
)
def preview_dataset_table(
    dataset_id: int,
    table_id: int,
    preview_request: TablePreviewRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Preview data from a dataset table with transformations"""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    limit = min(preview_request.limit or 1000, 1000)
    offset = max(preview_request.offset or 0, 0)
    datasource: Optional[DataSource] = None
    target_table = db_table

    if is_generated_calendar_table(db_table) or is_derived_table(db_table):
        try:
            datasource, target_table = build_live_proxy_table_for_dataset_table(
                db,
                dataset_obj,
                db_table,
            )
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") == "NOT_SYNCED":
                raise HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)})
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
        if not datasource:
            raise HTTPException(status_code=404, detail=_build_datasource_missing_detail(db_table))

    # ── Preview directly from live source ──
    try:
        result = LiveQueryService.execute_preview_query(
            datasource=datasource,
            db_table=target_table,
            limit=limit,
            offset=offset,
            filters=[f.model_dump() for f in preview_request.filters] if preview_request.filters else None,
        )
        rows = result["rows"]
        columns = result["columns"]
        column_metadata = []
        for i, col in enumerate(columns):
            col_type = _infer_column_type(col, i, rows)
            column_metadata.append(DatasetColumnMetadata(name=col, type=col_type, nullable=True))

        from app.services.type_override_service import _override_type as _ovr_type
        type_overrides = db_table.type_overrides or {}
        for col_meta in column_metadata:
            if col_meta.name in type_overrides:
                resolved = _ovr_type(type_overrides[col_meta.name])
                if resolved:
                    col_meta.type = resolved

        def serialize_value(val):
            if isinstance(val, (datetime, date)):
                return val.isoformat()
            if isinstance(val, Decimal):
                return float(val)
            return val

        serializable_rows = []
        for row in rows[:500]:
            if isinstance(row, dict):
                serializable_rows.append({k: serialize_value(v) for k, v in row.items()})
            else:
                serializable_rows.append([serialize_value(v) for v in row])

        columns_cache_payload = (
            build_calendar_columns_cache()
            if is_generated_calendar_table(db_table)
            else _build_columns_cache_payload(
                db_table,
                column_metadata,
                source_columns=result.get("source_columns") or [],
            )
        )
        DatasetCRUDService.update_table_cache(
            db, table_id,
            columns_cache=columns_cache_payload,
            sample_cache=serializable_rows,
        )
        _sync_dataset_model_safely(db, dataset_id)

        total = len(rows)
        has_more = len(rows) >= limit
        if is_generated_calendar_table(db_table):
            settings = get_calendar_settings(dataset_obj, enabled_default=False)
            total = (
                date.fromisoformat(settings["end_date"]) - date.fromisoformat(settings["start_date"])
            ).days + 1
            has_more = (offset + len(rows)) < total

        return TablePreviewResponse(
            columns=column_metadata,
            rows=rows,
            total=total,
            has_more=has_more,
        )
    except HTTPException:
        raise
    except ValueError as e:
        detail = _build_preview_source_error_detail(db_table, datasource, e)
        if detail:
            raise HTTPException(status_code=400, detail=detail) from e
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        error_msg = _normalize_preview_error_message(e)
        if _is_fixable_preview_error(e):
            logger.warning("Preview execution error for table %d: %s", table_id, error_msg)
            detail = _build_preview_source_error_detail(db_table, datasource, e)
            if detail:
                raise HTTPException(status_code=400, detail=detail) from e
            if any(kw in error_msg.lower() for kw in ("syntax error", "invalidquery", "invalid query", "parse error")):
                raise HTTPException(status_code=400, detail=f"SQL error: {error_msg}")
            raise HTTPException(status_code=400, detail=error_msg or "Preview query failed.")
        logger.error("Failed to preview table %d: %s", table_id, e, exc_info=True)
        raise HTTPException(status_code=400, detail=error_msg or "Preview query failed.")


@router.get("/{dataset_id}/tables/{table_id}/export/excel")
def export_dataset_table_excel(
    dataset_id: int,
    table_id: int,
    max_rows: int = Query(EXCEL_MAX_DATA_ROWS, ge=1, le=EXCEL_MAX_DATA_ROWS),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    datasource: Optional[DataSource] = None
    target_table = db_table

    if is_generated_calendar_table(db_table) or is_derived_table(db_table):
        try:
            datasource, target_table = build_live_proxy_table_for_dataset_table(
                db,
                dataset_obj,
                db_table,
            )
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") == "NOT_SYNCED":
                raise HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)})
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
        if not datasource:
            raise HTTPException(status_code=404, detail="Datasource not found")

    try:
        export_result = export_dataset_table_to_excel(
            lambda limit, offset: LiveQueryService.execute_preview_query(
                datasource=datasource,
                db_table=target_table,
                limit=limit,
                offset=offset,
            ),
            sheet_title=db_table.display_name or db_table.source_table_name or f"Table {table_id}",
            max_rows=max_rows,
        )
        fallback_name, utf8_name = _build_excel_export_filenames(
            dataset_obj.name,
            db_table.display_name or db_table.source_table_name or f"table-{table_id}",
        )
        headers = {
            "Content-Disposition": (
                f"attachment; filename=\"{fallback_name}\"; filename*=UTF-8''{quote(utf8_name)}"
            ),
            "X-AppBI-Export-Rows": str(export_result.rows_written),
        }
        if export_result.truncated:
            headers["X-AppBI-Export-Truncated"] = "true"
        return Response(
            content=export_result.content,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        error_msg = _normalize_preview_error_message(exc)
        if _is_fixable_preview_error(exc):
            logger.warning("Excel export error for table %d: %s", table_id, error_msg)
            raise HTTPException(status_code=400, detail=error_msg or "Excel export failed.") from exc
        logger.error("Failed to export dataset table %d to Excel: %s", table_id, exc)
        raise HTTPException(status_code=500, detail="Failed to export dataset table.") from exc


@router.post(
    "/{dataset_id}/tables/{table_id}/execute",
    response_model=ExecuteQueryResponse
)
def execute_dataset_table_query(
    dataset_id: int,
    table_id: int,
    execute_request: ExecuteQueryRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Execute query on dataset table with dimensions, measures, and filters"""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    # Normalise field names: strip "baseView.field" -> "field" only when that
    # field is not a declared semantic dimension/measure. Real semantic fields
    # must stay qualified so formulas, filtered measures, and joins still run
    # through the semantic engine.
    execute_request = _strip_base_view_qualifiers(db, db_table, execute_request)

    if _contains_semantic_field_refs(execute_request):
        return _execute_semantic_dataset_query(db, dataset_obj, db_table, execute_request)

    # ── Resolve datasource and build live query target ──
    datasource: Optional[DataSource] = None
    target_table = db_table

    if is_generated_calendar_table(db_table) or is_derived_table(db_table):
        try:
            datasource, target_table = build_live_proxy_table_for_dataset_table(
                db,
                dataset_obj,
                db_table,
            )
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") == "NOT_SYNCED":
                raise HTTPException(
                    status_code=422,
                    detail={"code": exc.code, "message": str(exc)},
                )
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
        if not datasource:
            raise HTTPException(status_code=404, detail="Datasource not found")

    # ── Execute aggregation directly against the live source ──
    try:
        measures = [
            {"field": m.field, "agg": m.function}
            for m in (execute_request.measures or [])
        ]
        filters = normalize_filter_conditions(
            [
                {
                    "field": f.field,
                    "operator": f.operator,
                    "value": f.value,
                }
                for f in (execute_request.filters or [])
            ]
        )
        order_by = [
            {
                "field": ob.field,
                "direction": ob.direction,
            }
            for ob in (execute_request.order_by or [])
        ]

        rows = LiveQueryService.execute_dataset_query(
            datasource=datasource,
            db_table=target_table,
            dimensions=execute_request.dimensions or [],
            measures=measures,
            filters=filters,
            order_by=order_by,
            limit=execute_request.limit,
            time_grains=execute_request.time_grains or None,
        )

        columns = list(rows[0].keys()) if rows else []
        column_metadata = [
            DatasetColumnMetadata(
                name=col,
                type=_infer_column_type(col, idx, rows),
                nullable=True,
            )
            for idx, col in enumerate(columns)
        ]

        rows = _serialize_cached_rows(rows, limit=len(rows))
        return ExecuteQueryResponse(columns=column_metadata, rows=rows)
    except DatasetTableSqlError as exc:
        if getattr(exc, "code", "") == "NOT_SYNCED":
            raise HTTPException(
                status_code=422,
                detail={"code": exc.code, "message": str(exc)},
            )
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to execute query")
        raise HTTPException(
            status_code=400,
            detail=f"Failed to execute query: {e}",
        )


# ===== Table Description Endpoints =====

@router.get("/{dataset_id}/tables/{table_id}/description")
def get_table_description(
    dataset_id: int,
    table_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get AI-generated description and knowledge fields for a dataset table."""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    return _serialize_table_description(table)


@router.put("/{dataset_id}/tables/{table_id}/description")
def update_table_description(
    dataset_id: int,
    table_id: int,
    body: dict,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update description fields manually. Sets description_source='user' and re-embeds."""
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, ds, "datasets")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    if "auto_description" in body:
        table.auto_description = body["auto_description"]
    if "column_descriptions" in body:
        table.column_descriptions = body["column_descriptions"]
    if "common_questions" in body:
        table.common_questions = body["common_questions"]
    if "query_aliases" in body:
        table.query_aliases = body["query_aliases"]

    table.description_source = "user"
    table.description_updated_at = datetime.utcnow()
    table.schema_change_pending = False
    table.generation_status = "succeeded"
    table.generation_error = None
    table.generation_requested_at = None
    table.generation_finished_at = datetime.utcnow()
    table.stale_reason = None
    db.commit()

    background_tasks.add_task(
        DescriptionPipelineService.run_table_embedding,
        table_id,
        resolve_session_factory(db),
    )

    return _serialize_table_description(table)


@router.post("/{dataset_id}/tables/{table_id}/description/preview")
def preview_table_description(
    dataset_id: int,
    table_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Run AI description generation synchronously and return the draft without saving.

    Used by the Dictionary diff modal so users can review and edit the AI output
    before choosing to apply it.
    """
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, ds, "datasets")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    from app.services.auto_tagging_service import AutoTaggingService
    ok, payload, error = AutoTaggingService.preview_table_description(db, table_id)
    if not ok:
        raise HTTPException(status_code=502, detail=error or "AI generation failed")
    return payload


@router.post("/{dataset_id}/tables/{table_id}/description/regenerate")
def regenerate_table_description(
    dataset_id: int,
    table_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Force-regenerate AI description for a table, then re-embed."""
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, ds, "datasets")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    DescriptionPipelineService.enqueue_table_pipeline(
        background_tasks,
        db,
        table_id,
        trigger="manual_regenerate",
        force=True,
    )

    return {"status": "queued", "generation_status": "queued"}


# ===== Datasource Table List Endpoint =====

@router.get(
    "/datasources/{datasource_id}/tables",
    response_model=List[DatasourceTable],
    tags=["datasources"]
)
def list_datasource_tables(
    datasource_id: int,
    search: Optional[str] = Query(None, description="Search query for table names"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all tables from a datasource"""
    # Get datasource
    datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")
    require_view_access(db, current_user, datasource, "data_sources")
    
    try:
        tables = DataSourceConnectionService.list_tables(
            datasource.type,
            datasource.config,
            search_query=search
        )
        
        return [
            DatasourceTable(
                name=table["name"],
                schema=table.get("schema"),
                table_type=table.get("type", "table")
            )
            for table in tables
        ]
    
    except Exception as e:
        logger.error(f"Failed to list tables: {e}")
        raise HTTPException(
            status_code=500,
            detail="Failed to list tables."
        )


# ===== Datasource Table Columns Endpoint =====

@router.get(
    "/datasources/{datasource_id}/tables/columns",
    tags=["datasources"]
)
def list_datasource_table_columns(
    datasource_id: int,
    table: str = Query(..., description="Table name (e.g. public.orders or orders)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return columns for a specific table.
    Return columns for a table by querying the live source schema.
    """
    datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")
    require_view_access(db, current_user, datasource, "data_sources")
    try:
        columns = DataSourceConnectionService.list_columns(
            ds_id=datasource.id,
            ds_type=datasource.type,
            config=datasource.config,
            table_name=table,
        )
        return {"columns": columns}
    except Exception as e:
        logger.error(f"Failed to list columns for ds {datasource_id} table {table}: {e}")
        raise HTTPException(status_code=500, detail="Failed to list columns.")


# ============ Dataset Data Model (Semantic Layer) ============

@router.post(
    "/{dataset_id}/generate-model",
    summary="Auto-generate semantic model from dataset tables",
)
def generate_model(
    dataset_id: int,
    force: bool = Query(False, description="Force regenerate (overwrite existing)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Scan all tables in the dataset and auto-generate:
    - SemanticView per table (dimensions + measures from columns_cache)
    - SemanticModel for the dataset
    - SemanticExplores with auto-detected JOINs
    """
    from app.services.dataset_model_service import generate_dataset_model

    dataset_obj = db.query(Dataset).filter(
        Dataset.id == dataset_id
    ).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    try:
        result = generate_dataset_model(db, dataset_id, force=force)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to generate model for dataset {dataset_id}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate model: {str(e)}",
        )


@router.get(
    "/{dataset_id}/model",
    summary="Get the semantic model for a dataset",
)
def get_dataset_model_endpoint(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return the full semantic model for Visual Model UI:
    - All views (with dimensions/measures)
    - All explores (with join definitions)
    """
    from app.services.dataset_model_service import get_dataset_model

    dataset_obj = db.query(Dataset).filter(
        Dataset.id == dataset_id
    ).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")

    result = get_dataset_model(db, dataset_id)
    if not result:
        return {
            "model_id": None,
            "dataset_id": dataset_id,
            "dataset_name": dataset_obj.name,
            "views": [],
            "explores": [],
            "generated": False,
        }
    return result


@router.get(
    "/{dataset_id}/model/distinct-values",
    summary="Get distinct values for a semantic field",
)
def get_dataset_model_distinct_values(
    dataset_id: int,
    field: str = Query(..., description="Qualified field name, e.g. orders.country"),
    limit: int = Query(200, ge=1, le=500),
    filters: str | None = Query(
        default=None,
        description="JSON-encoded list of dashboard filter objects used to cascade distinct values.",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.services.dataset_model_service import get_distinct_field_values

    dataset_obj = db.query(Dataset).filter(
        Dataset.id == dataset_id
    ).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")

    filter_context: list[dict] = []
    if filters:
        try:
            parsed_filters = json.loads(filters)
            if not isinstance(parsed_filters, list):
                raise ValueError("filters must be a JSON array")
            filter_context = [item for item in parsed_filters if isinstance(item, dict)]
        except (json.JSONDecodeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid filters parameter: {e}")

    try:
        result = get_distinct_field_values(db, dataset_id, field, limit=limit, filters=filter_context)
        return {
            "field": field,
            "values": result.get("values", []),
            "dropped_filters": result.get("dropped_filters", []),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to load distinct values for dataset {dataset_id} field {field}: {e}")
        raise HTTPException(status_code=500, detail="Failed to load distinct values.")


def _coerce_join_column_values(raw_value: Any) -> list[str]:
    if raw_value is None:
        return []
    if isinstance(raw_value, str):
        candidates = [part.strip() for part in raw_value.split(",")]
    elif isinstance(raw_value, (list, tuple, set)):
        candidates = [str(part).strip() for part in raw_value]
    else:
        candidates = [str(raw_value).strip()]
    return [candidate for candidate in candidates if candidate]


def _extract_join_column_payload(
    payload: dict[str, Any],
    *,
    require_pairs: bool = True,
) -> tuple[list[str], list[str]]:
    from_columns = _coerce_join_column_values(payload.get("from_columns"))
    to_columns = _coerce_join_column_values(payload.get("to_columns"))

    if not from_columns and payload.get("from_column") is not None:
        from_columns = _coerce_join_column_values(payload.get("from_column"))
    if not to_columns and payload.get("to_column") is not None:
        to_columns = _coerce_join_column_values(payload.get("to_column"))

    if not from_columns and not to_columns and not require_pairs:
        return [], []
    if not from_columns or not to_columns:
        raise HTTPException(status_code=422, detail="Missing fields: {'from_column', 'to_column'}")
    if len(from_columns) != len(to_columns):
        raise HTTPException(
            status_code=422,
            detail="Join key definitions must have the same number of source and target columns",
        )
    return from_columns, to_columns


@router.put(
    "/{dataset_id}/model/views/{view_id}",
    summary="Update a semantic view (dimensions/measures)",
)
def update_dataset_view(
    dataset_id: int,
    view_id: int,
    update_data: dict,
    force: bool = Query(False, description="When true, bypass the cascade guard that blocks deleting/renaming measures still used by charts."),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Update dimensions/measures/description of a semantic view.
    Used by the Visual Model editor.

    Cascade guard (Phase-2 / refined in Phase-3): when a save removes or renames
    measures still referenced by charts, the default behaviour returns 409 with
    the list of affected charts so the front-end can prompt for confirmation.
    Pass ``?force=true`` to bypass the guard and let the save go through; charts
    will then surface a "field not found" error at query time until the user
    rebinds them.
    """
    from app.models.semantic import SemanticView
    from app.schemas.semantic import SemanticViewUpdate
    from pydantic import ValidationError

    dataset_obj = db.query(Dataset).filter(
        Dataset.id == dataset_id
    ).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    view = db.query(SemanticView).filter(SemanticView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found")

    # Validate the view belongs to this dataset's tables
    table = db.query(DatasetTable).filter(
        DatasetTable.id == view.dataset_table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table and view.dataset_table_id is not None:
        raise HTTPException(status_code=403, detail="View does not belong to this dataset")
    if view.dataset_table_id is None or (table and is_generated_calendar_table(table)):
        raise HTTPException(status_code=400, detail="System-managed model tables cannot be edited here.")

    # Phase-6: rename_map is an out-of-band field that the rewrite step
    # consumes — it must not be forwarded to the Pydantic SemanticViewUpdate
    # validator (which would treat it as unknown). Pop it first.
    allowed_fields = {"dimensions", "measures", "description", "rename_map"}
    unknown_fields = set(update_data.keys()) - allowed_fields
    if unknown_fields:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported model view fields: {', '.join(sorted(unknown_fields))}",
        )

    rename_map_raw = update_data.pop("rename_map", None) if isinstance(update_data, dict) else None

    # Phase-15.63 — DELETE/EDIT escape hatch for invalid legacy measures.
    # If MCP (or any older client) wrote a measure with a shape that fails
    # the current Pydantic model_validator (e.g. scope='dataset' missing
    # source_columns), the FE would PUT the full measures array on every
    # save — including the bad measure unchanged — and Pydantic would
    # re-reject the WHOLE batch, leaving the user unable to delete or
    # even edit OTHER measures.
    #
    # Fix: validate ONLY measures that are new or modified vs the persisted
    # view. Unchanged measures pass through as-is. This lets users delete
    # bad data without first hand-editing it, and keeps the strict
    # validator for new/edited measures.
    incoming_measures = update_data.get("measures")
    skipped_unchanged: list[dict] = []
    if isinstance(incoming_measures, list):
        # Index existing measures by name for O(1) compare.
        existing_by_name: dict[str, Any] = {}
        for m in (view.measures or []):
            if isinstance(m, dict):
                n = str(m.get("name") or "").strip()
                if n:
                    existing_by_name[n] = m
        kept_for_validation: list[Any] = []
        for m in incoming_measures:
            if not isinstance(m, dict):
                kept_for_validation.append(m)
                continue
            n = str(m.get("name") or "").strip()
            prev = existing_by_name.get(n) if n else None
            if prev is not None and prev == m:
                # Bit-identical to persisted version — pass through.
                skipped_unchanged.append(m)
            else:
                kept_for_validation.append(m)
        update_data["measures"] = kept_for_validation

    try:
        validated = SemanticViewUpdate(**update_data)
    except ValidationError as exc:
        # Phase-15.62 — Pydantic v2 .errors() embeds the raw exception
        # object in ctx['error'] when a @model_validator raised ValueError.
        # FastAPI's default json.dumps then crashes with "Object of type
        # ValueError is not JSON serializable" → 500 with empty body.
        # Stringify ctx values so the response stays a clean 422 with the
        # field-level validation messages the FE expects.
        cleaned: list[dict] = []
        for err in exc.errors():
            entry = dict(err)
            ctx = entry.get("ctx")
            if isinstance(ctx, dict):
                entry["ctx"] = {
                    k: (str(v) if isinstance(v, BaseException) else v)
                    for k, v in ctx.items()
                }
            cleaned.append(entry)
        raise HTTPException(status_code=422, detail=cleaned) from exc

    update_payload = validated.model_dump(exclude_unset=True)
    if "dimensions" in update_payload and update_payload["dimensions"] is not None:
        update_payload["dimensions"] = [dim.model_dump() for dim in validated.dimensions or []]
    if "measures" in update_payload and update_payload["measures"] is not None:
        # Phase-15.63 — re-merge the legacy-shape measures we skipped from
        # Pydantic validation. They keep their original (possibly invalid)
        # shape so the user's PUT round-trip preserves them; new/edited
        # measures use the validated dicts.
        validated_dicts = [measure.model_dump() for measure in validated.measures or []]
        # Rebuild in the order the client sent, mapping by name to either
        # the unchanged passthrough or the freshly-validated version.
        validated_by_name = {
            str((m or {}).get("name") or "").strip(): m
            for m in validated_dicts if isinstance(m, dict)
        }
        skipped_by_name = {
            str((m or {}).get("name") or "").strip(): m
            for m in skipped_unchanged if isinstance(m, dict)
        }
        merged: list[dict] = []
        for m in (incoming_measures or []):
            if not isinstance(m, dict):
                continue
            n = str(m.get("name") or "").strip()
            if n in validated_by_name:
                merged.append(validated_by_name[n])
            elif n in skipped_by_name:
                merged.append(skipped_by_name[n])
        _validate_measure_dependencies(db, dataset_id, view.name, merged)
        update_payload["measures"] = merged

    # Phase-2: ensure every dimension/measure points at a column that actually
    # exists on the bound table. Catches silent failures where the data layer
    # diverged from the semantic layer without anyone noticing.
    if (
        ("dimensions" in update_payload and update_payload["dimensions"] is not None)
        or ("measures" in update_payload and update_payload["measures"] is not None)
    ):
        # Take the proposed dimensions/measures when present, fall back to
        # whatever is already persisted on the view so we validate the full
        # final state, not just the patched fragment.
        final_dims = (
            update_payload.get("dimensions")
            if update_payload.get("dimensions") is not None
            else (view.dimensions or [])
        )
        final_measures = (
            update_payload.get("measures")
            if update_payload.get("measures") is not None
            else (view.measures or [])
        )
        # Phase-15.63 — skip column-existence check for measures that came
        # through the unchanged-passthrough fast lane. They may reference
        # legacy columns the table has since renamed; blocking the PUT
        # would lock the user out of deleting/editing OTHER measures.
        skipped_names = {
            str(m.get("name") or "").strip()
            for m in skipped_unchanged
            if isinstance(m, dict) and str(m.get("name") or "").strip()
        }
        validatable_measures = [
            m for m in final_measures
            if not (isinstance(m, dict) and str(m.get("name") or "").strip() in skipped_names)
        ]
        _validate_field_references(table, final_dims, validatable_measures)

    # Phase-6: optional rename_map carried alongside the measures patch.
    # Format: {"old_name": "new_name"}. When present, the cascade guard
    # excludes the listed old_names (they're not really dropped — they're
    # renamed) AND the engine auto-rewrites every Chart.config + cross-view
    # depends_on entry that still references the old qualified ref.
    rename_map: dict[str, str] = {}
    if isinstance(rename_map_raw, dict):
        for k, v in rename_map_raw.items():
            ok = str(k or "").strip()
            nv = str(v or "").strip()
            if ok and nv and ok != nv:
                rename_map[ok] = nv

    # Phase-2: cascade-rename guard. If a save removes measures that charts
    # in this dataset still reference, block the save and tell the user
    # which charts would break. A rename presents as "old name missing
    # from new measure list" — Phase-6 adds rename_map so the user can
    # opt into auto-rewrite without `force=true` (force still works for
    # genuine deletes).
    if "measures" in update_payload and update_payload["measures"] is not None and not force:
        old_measure_names = {
            str((m or {}).get("name") or "").strip()
            for m in (view.measures or [])
            if isinstance(m, dict) and str((m or {}).get("name") or "").strip()
        }
        new_measure_names = {
            str((m or {}).get("name") or "").strip()
            for m in (update_payload["measures"] or [])
            if isinstance(m, dict) and str((m or {}).get("name") or "").strip()
        }
        # Old names listed in rename_map are NOT considered dropped — the
        # rewrite step below remaps every consumer to the new name. Only
        # raise the cascade guard for genuinely deleted measures.
        dropped = (old_measure_names - new_measure_names) - set(rename_map.keys())
        if dropped:
            hits = _find_chart_refs_to_measures(db, view.name, dropped, dataset_id)
            if hits:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "MEASURE_CASCADE",
                        "message": (
                            f"{len(hits)} chart đang dùng measure sắp bị xoá. "
                            "Xác nhận để vẫn lưu (chart sẽ phải sửa lại sau), "
                            "hoặc dùng rename_map nếu bạn muốn đổi tên thay vì xoá."
                        ),
                        "dropped": sorted(dropped),
                        "affected_charts": hits,
                    },
                )

    for key, value in update_payload.items():
        setattr(view, key, value)

    # SQLAlchemy does not always detect in-place mutations of JSON columns;
    # flag them explicitly so the change is always persisted.
    from sqlalchemy.orm.attributes import flag_modified
    for json_col in ("dimensions", "measures"):
        if json_col in update_payload:
            flag_modified(view, json_col)

    db.commit()
    db.refresh(view)

    # Phase-6: after the view is persisted, fan out the rename to every
    # consumer that still references the old name. This is deliberately
    # AFTER the commit — if the rewrite fails we still keep the view's
    # new shape and report the issue so the user can rerun manually.
    rewrite_summary: dict[str, int] = {}
    if rename_map:
        try:
            rewrite_summary = _rewrite_measure_references(
                db,
                dataset_id=dataset_id,
                view_name=view.name,
                rename_map=rename_map,
            )
        except Exception as exc:  # pragma: no cover — best-effort
            logger.warning(
                "[rename] auto-rewrite failed for view=%s map=%s: %s",
                view.name, rename_map, exc,
            )
            rewrite_summary = {"error": 1}

    return {
        "id": view.id,
        "name": view.name,
        "dataset_table_id": view.dataset_table_id,
        "sql_table_name": view.sql_table_name,
        "dimensions": view.dimensions or [],
        "measures": view.measures or [],
        "description": view.description,
        "renamed": rewrite_summary,
    }


@router.delete(
    "/{dataset_id}/model/views/{view_id}/measures/{measure_name}",
    summary="Delete a single measure from a semantic view (bypasses batch validation)",
)
def delete_dataset_view_measure(
    dataset_id: int,
    view_id: int,
    measure_name: str,
    force: bool = Query(False, description="Bypass cascade guard (charts using this measure)."),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Phase-15.64 — surgical DELETE for a single measure.

    The PUT update_dataset_view path re-validates the entire measures
    array on every save. When a legacy measure has an invalid shape
    (e.g. pre-Phase-12 scope/source_columns drift), Pydantic blocks the
    whole PUT and the user gets stuck — they can't even delete the bad
    measure because the validator rejects the surrounding ones too.

    This endpoint sidesteps Pydantic entirely: read measures JSON list,
    drop the entry whose name matches, write back. Cascade-rename guard
    still runs (so we don't silently break charts), but per-measure
    shape validation is skipped — we trust the operation because the
    user is REMOVING data, not adding new bad data.
    """
    from app.models.semantic import SemanticView

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    view = db.query(SemanticView).filter(SemanticView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == view.dataset_table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table and view.dataset_table_id is not None:
        raise HTTPException(status_code=403, detail="View does not belong to this dataset")
    if view.dataset_table_id is None or (table and is_generated_calendar_table(table)):
        raise HTTPException(status_code=400, detail="System-managed model tables cannot be edited here.")

    target = (measure_name or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="measure_name is required")

    existing = list(view.measures or [])
    new_list = [
        m for m in existing
        if not (isinstance(m, dict) and str((m or {}).get("name") or "").strip() == target)
    ]
    if len(new_list) == len(existing):
        raise HTTPException(
            status_code=404,
            detail=f"Measure '{target}' không tồn tại trên view '{view.name}'.",
        )

    # Cascade guard: charts still using this measure would break. Same
    # rule as the PUT path — force=true to bypass after user confirms.
    if not force:
        hits = _find_chart_refs_to_measures(db, view.name, {target}, dataset_id)
        if hits:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "MEASURE_CASCADE",
                    "message": (
                        f"{len(hits)} chart đang dùng measure '{target}'. "
                        "Xác nhận để vẫn xoá (chart sẽ phải sửa lại sau) "
                        "bằng cách gọi lại với ?force=true."
                    ),
                    "dropped": [target],
                    "affected_charts": hits,
                },
            )

    view.measures = new_list
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(view, "measures")
    db.commit()
    db.refresh(view)
    return {
        "id": view.id,
        "name": view.name,
        "deleted_measure": target,
        "measures": view.measures or [],
    }


@router.get(
    "/{dataset_id}/lineage/column/{table_id}/{column_name}",
    summary="List every semantic object that depends on a column (Phase-4)",
)
def get_column_lineage(
    dataset_id: int,
    table_id: int,
    column_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Proactive lineage probe.

    Returns ``{ dimensions: [...], measures: [...], chart_count: int }``
    describing what would break if the column were removed. The FE can hit
    this before opening a destructive UI flow so the user sees the impact
    BEFORE clicking delete (rather than only when the cascade guard fires
    at save time).
    """
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")

    column = (column_name or "").strip()
    if not column:
        raise HTTPException(status_code=400, detail="Column name is required")

    refs = _find_semantic_refs_to_columns(db, table_id, {column})

    # Detect chart usage: any chart on this table whose config references
    # a measure that references the column. We keep this lightweight — a
    # simple count is enough for a "X measures and Y charts will break"
    # warning. Full per-chart lineage is in the cascade guard at save time.
    from app.models.models import Chart
    chart_count = (
        db.query(Chart)
        .filter(Chart.dataset_table_id == table_id)
        .count()
    )

    return {
        "column": column,
        "table_id": table_id,
        "dataset_id": dataset_id,
        "semantic_refs": refs,
        "chart_count_on_table": chart_count,
    }


@router.get(
    "/{dataset_id}/model/layout",
    summary="Get persisted canvas positions for the data-model view",
)
def get_dataset_model_layout(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return saved card positions for the Visual Model canvas.

    Phase-4: positions are stored in ``Dataset.settings.model_layout`` keyed
    by ``str(view_id)`` so they survive across browsers / users. Returns
    ``{}`` when nothing has been saved yet — the canvas falls back to its
    topology-aware auto layout.
    """
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")
    settings = dataset_obj.settings or {}
    return settings.get("model_layout") or {}


@router.put(
    "/{dataset_id}/model/layout",
    summary="Save canvas positions for the data-model view",
)
def update_dataset_model_layout(
    dataset_id: int,
    positions: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Persist canvas card positions. Body is ``{view_id: {x, y}}``.

    Phase-4: replaces the previous localStorage-only persistence so layout
    follows the dataset (not the browser) and stays synced across users
    sharing the dataset.
    """
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    # Normalise & validate. Only keep entries with numeric x/y; drop the rest.
    cleaned: dict[str, dict[str, float]] = {}
    if isinstance(positions, dict):
        for key, value in positions.items():
            if not isinstance(value, dict):
                continue
            try:
                x = float(value.get("x"))
                y = float(value.get("y"))
            except (TypeError, ValueError):
                continue
            cleaned[str(key)] = {"x": x, "y": y}

    settings = dict(dataset_obj.settings or {})
    settings["model_layout"] = cleaned
    dataset_obj.settings = settings
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(dataset_obj, "settings")
    db.commit()
    return cleaned


@router.put(
    "/{dataset_id}/model/explores/{explore_id}",
    summary="Update a semantic explore (joins)",
)
def update_dataset_explore(
    dataset_id: int,
    explore_id: int,
    update_data: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Update joins/description of a semantic explore.
    Used by the Visual Model editor for join management.
    """
    from app.models.semantic import SemanticExplore, SemanticModel

    dataset_obj = db.query(Dataset).filter(
        Dataset.id == dataset_id
    ).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    explore = db.query(SemanticExplore).filter(SemanticExplore.id == explore_id).first()
    if not explore:
        raise HTTPException(status_code=404, detail="Explore not found")

    # Validate explore belongs to this dataset's model
    model = db.query(SemanticModel).filter(
        SemanticModel.id == explore.model_id,
        SemanticModel.dataset_id == dataset_id,
    ).first()
    if not model:
        raise HTTPException(status_code=403, detail="Explore does not belong to this dataset")

    allowed_fields = {"joins", "description"}
    for key, value in update_data.items():
        if key not in allowed_fields:
            continue
        if key == "joins" and isinstance(value, list):
            managed_joins = [
                join for join in (explore.joins or [])
                if join.get("managed") and join.get("origin") not in {"auto_fk", "auto_calendar"}
            ]
            editable_joins = [
                join for join in value
                if not (join.get("managed") and join.get("origin") not in {"auto_fk", "auto_calendar"})
            ]
            setattr(explore, key, [*managed_joins, *editable_joins])
            continue
        setattr(explore, key, value)

    db.commit()
    db.refresh(explore)

    return {
        "id": explore.id,
        "name": explore.name,
        "base_view_name": explore.base_view_name,
        "base_view_id": explore.base_view_id,
        "joins": explore.joins or [],
        "description": explore.description,
    }


@router.post(
    "/{dataset_id}/model/generate-suggestions",
    summary="Compute relationship diff without persisting — backbone of the review modal",
)
def generate_join_suggestions_endpoint(
    dataset_id: int,
    payload: dict | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Non-destructive counterpart to /generate-model.

    Returns kept/recommended/obsolete/warnings without touching the model so
    the builder can review and apply selectively. Pass {"deep_scan": true}
    to opt into column-overlap probes that catch joins missed by the FK
    constraint and name-heuristic passes.
    """
    from app.services.dataset_model_service import generate_join_suggestions

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")

    deep_scan = bool((payload or {}).get("deep_scan"))
    try:
        return generate_join_suggestions(db, dataset_id, deep_scan=deep_scan)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to generate suggestions for dataset {dataset_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/{dataset_id}/model/joins/batch",
    summary="Apply a batch of reviewed relationship suggestions",
)
def apply_join_suggestions_endpoint(
    dataset_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Body: {"selections": [...]} where each item carries from_view, to_view,
    from_columns, to_columns, relationship.
    """
    from app.services.dataset_model_service import apply_join_suggestions

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    selections = payload.get("selections") or []
    if not isinstance(selections, list):
        raise HTTPException(status_code=422, detail="selections must be a list")

    try:
        return apply_join_suggestions(db, dataset_id, selections)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to apply suggestions for dataset {dataset_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/{dataset_id}/model/joins/reject",
    summary="Persist tombstones for suggestions the builder declined",
)
def reject_join_suggestions_endpoint(
    dataset_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Body: {"rejections": [...]} — same shape items as apply, but they go
    into SemanticModel.settings.rejected_auto_joins so they stop showing up
    in future suggestion runs.
    """
    from app.services.dataset_model_service import add_rejected_suggestions

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    rejections = payload.get("rejections") or []
    if not isinstance(rejections, list):
        raise HTTPException(status_code=422, detail="rejections must be a list")

    try:
        return add_rejected_suggestions(db, dataset_id, rejections)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete(
    "/{dataset_id}/model/joins/reject",
    summary="Clear all suggestion tombstones — used by the 'Reset rejections' button",
)
def clear_rejected_suggestions_endpoint(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.services.dataset_model_service import clear_rejected_suggestions

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    try:
        return clear_rejected_suggestions(db, dataset_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post(
    "/{dataset_id}/model/joins/suggestion",
    summary="Suggest and validate a relationship between two tables",
)
def suggest_model_join(
    dataset_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Inspect two semantic views + columns and suggest the relationship shape.
    Body: {from_view_id, to_view_id, from_column, to_column}
    or    {from_view_id, to_view_id, from_columns, to_columns}
    """
    from app.services.dataset_model_service import suggest_join_relationship

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")

    required = {"from_view_id", "to_view_id"}
    missing = required - set(payload.keys())
    if missing:
        raise HTTPException(status_code=422, detail=f"Missing fields: {missing}")
    from_columns, to_columns = _extract_join_column_payload(payload)

    try:
        return suggest_join_relationship(
            db,
            dataset_id=dataset_id,
            from_view_id=int(payload["from_view_id"]),
            to_view_id=int(payload["to_view_id"]),
            from_column=from_columns[0],
            to_column=to_columns[0],
            from_columns=from_columns,
            to_columns=to_columns,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to suggest join for dataset {dataset_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/{dataset_id}/model/joins",
    summary="Add or update a relationship between two tables",
)
def add_model_join(
    dataset_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Add or update a join/relationship between two semantic views.
    Body: {from_view_id, to_view_id, from_column, to_column, join_type, relationship}
    or    {from_view_id, to_view_id, from_columns, to_columns, join_type, relationship}
    """
    from app.services.dataset_model_service import add_join

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    required = {"from_view_id", "to_view_id"}
    missing = required - set(payload.keys())
    if missing:
        raise HTTPException(status_code=422, detail=f"Missing fields: {missing}")
    from_columns, to_columns = _extract_join_column_payload(payload)

    try:
        alias_value = payload.get("alias")
        if alias_value is not None:
            alias_value = str(alias_value).strip() or None
        # Phase-3b: optional is_active + cross_filter. Defaults preserved on
        # service side so callers from older clients keep working.
        raw_active = payload.get("is_active")
        is_active = True if raw_active is None else bool(raw_active)
        cross_filter = str(payload.get("cross_filter") or "single").strip().lower()
        if cross_filter not in ("single", "both"):
            cross_filter = "single"
        force = bool(payload.get("force", False))
        result = add_join(
            db,
            dataset_id=dataset_id,
            from_view_id=int(payload["from_view_id"]),
            to_view_id=int(payload["to_view_id"]),
            from_column=from_columns[0],
            to_column=to_columns[0],
            from_columns=from_columns,
            to_columns=to_columns,
            join_type=payload.get("join_type", "left"),
            relationship=payload.get("relationship", "many_to_one"),
            alias=alias_value,
            is_active=is_active,
            cross_filter=cross_filter,
            force=force,
        )
        return result
    except ValueError as e:
        # Phase-3 cascade: surface structured payload as 409 when present so
        # the FE can show a confirm dialog rather than a generic error.
        payload_attr = getattr(e, "cascade_payload", None)
        if payload_attr:
            raise HTTPException(status_code=409, detail=payload_attr)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to add join for dataset {dataset_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete(
    "/{dataset_id}/model/joins",
    summary="Remove a relationship between two tables",
)
def remove_model_join(
    dataset_id: int,
    from_view_id: int = Query(..., description="SemanticView ID of the source table"),
    to_view_name: str = Query(..., description="View name of the target table"),
    from_column: Optional[str] = Query(None, description="Optional source column for an exact join match"),
    to_column: Optional[str] = Query(None, description="Optional target column for an exact join match"),
    from_columns: Optional[str] = Query(None, description="Optional comma-separated source columns for an exact composite join match"),
    to_columns: Optional[str] = Query(None, description="Optional comma-separated target columns for an exact composite join match"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove a join/relationship from one semantic view to another."""
    from app.services.dataset_model_service import remove_join

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    try:
        match_from_columns, match_to_columns = _extract_join_column_payload(
            {
                "from_columns": from_columns,
                "to_columns": to_columns,
                "from_column": from_column,
                "to_column": to_column,
            },
            require_pairs=False,
        )
        result = remove_join(
            db,
            dataset_id,
            from_view_id,
            to_view_name,
            from_column=from_column,
            to_column=to_column,
            from_columns=match_from_columns,
            to_columns=match_to_columns,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to remove join for dataset {dataset_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ===== Data Quality Endpoints =====

from app.models.dataset import DatasetQualityRule, DatasetQualityRun
from app.schemas.dataset import (
    QualityRuleCreate,
    QualityRuleBulkCreate,
    QualityRuleUpdate,
    QualityRuleResponse,
    QualityRuleDuplicateRequest,
    QualityRunTriggerResponse,
    QualityRunResponse,
    QualitySummaryResponse,
    QualityRulePreviewRequest,
    QualityRulePreviewResponse,
    QualityRuleTestRequest,
    QualityRuleTestResponse,
)


def _get_dataset_or_404(db: Session, dataset_id: int) -> Dataset:
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return ds


# ── Rules ──────────────────────────────────────────────────────────────────

@router.get("/{dataset_id}/quality/summary", response_model=QualitySummaryResponse)
def get_quality_summary(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Aggregated quality summary: rule counts, score, dimension breakdown."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")
    return DatasetQualityService.get_summary(db, dataset_id)


@router.get("/{dataset_id}/quality/rules", response_model=List[QualityRuleResponse])
def list_quality_rules(
    dataset_id: int,
    table_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all quality rules for a dataset, optionally filtered by table."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")
    return DatasetQualityService.list_rules(db, dataset_id, table_id=table_id)


@router.post("/{dataset_id}/quality/rules/preview", response_model=QualityRulePreviewResponse)
def preview_quality_rule(
    dataset_id: int,
    body: QualityRulePreviewRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Preview a rule's SQL and descriptions without saving it."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")

    config_dict = body.config.model_dump(exclude_none=True) if body.config else {}
    result = DatasetQualityService.preview_rule(
        db=db,
        dataset_id=dataset_id,
        table_id=body.table_id,
        rule_type=body.rule_type,
        column_name=body.column_name,
        config=config_dict,
    )
    return QualityRulePreviewResponse(**result)


@router.post("/{dataset_id}/quality/rules/test", response_model=QualityRuleTestResponse)
def test_quality_rule(
    dataset_id: int,
    body: QualityRuleTestRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Execute a rule preview against live data without saving it."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")

    config_dict = body.config.model_dump(exclude_none=True) if body.config else {}
    result = DatasetQualityService.test_rule(
        db=db,
        dataset_id=dataset_id,
        table_id=body.table_id,
        rule_type=body.rule_type,
        column_name=body.column_name,
        config=config_dict,
    )
    return QualityRuleTestResponse(**result)


@router.post("/{dataset_id}/quality/rules", response_model=QualityRuleResponse, status_code=201)
def create_quality_rule(
    dataset_id: int,
    body: QualityRuleCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new quality rule."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    # Verify table belongs to dataset
    table = db.query(DatasetTable).filter(
        DatasetTable.id == body.table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    try:
        return DatasetQualityService.create_rule(db, dataset_id, body)
    except QualityRuleConflictError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{dataset_id}/quality/rules/bulk", response_model=List[QualityRuleResponse], status_code=201)
def create_quality_rules_bulk(
    dataset_id: int,
    body: QualityRuleBulkCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create multiple quality rules in one atomic request. Rolls back on any failure."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    # Verify all referenced tables belong to the dataset
    table_ids = {item.table_id for item in body.rules}
    valid_tables = {
        row.id
        for row in db.query(DatasetTable.id)
        .filter(DatasetTable.id.in_(table_ids), DatasetTable.dataset_id == dataset_id)
        .all()
    }
    missing = table_ids - valid_tables
    if missing:
        raise HTTPException(status_code=404, detail=f"Tables not found in this dataset: {sorted(missing)}")

    try:
        return DatasetQualityService.create_rules_bulk(db, dataset_id, body.rules)
    except QualityRuleConflictError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/{dataset_id}/quality/rules/{rule_id}", response_model=QualityRuleResponse)
def update_quality_rule(
    dataset_id: int,
    rule_id: int,
    body: QualityRuleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a quality rule."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    rule = db.query(DatasetQualityRule).filter(
        DatasetQualityRule.id == rule_id,
        DatasetQualityRule.dataset_id == dataset_id,
    ).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Quality rule not found")

    try:
        return DatasetQualityService.update_rule(db, rule, body)
    except QualityRuleConflictError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/{dataset_id}/quality/rules/{rule_id}", status_code=204)
def delete_quality_rule(
    dataset_id: int,
    rule_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a quality rule."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    rule = db.query(DatasetQualityRule).filter(
        DatasetQualityRule.id == rule_id,
        DatasetQualityRule.dataset_id == dataset_id,
    ).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Quality rule not found")

    DatasetQualityService.delete_rule(db, rule)


@router.post("/{dataset_id}/quality/rules/{rule_id}/duplicate", response_model=QualityRuleResponse, status_code=201)
def duplicate_quality_rule(
    dataset_id: int,
    rule_id: int,
    body: QualityRuleDuplicateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Duplicate a quality rule, optionally to a different table."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    rule = db.query(DatasetQualityRule).filter(
        DatasetQualityRule.id == rule_id,
        DatasetQualityRule.dataset_id == dataset_id,
    ).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Quality rule not found")

    # Validate target table belongs to this dataset
    if body.target_table_id is not None:
        from app.models.dataset import DatasetTable as DT
        target_table = db.query(DT).filter(
            DT.id == body.target_table_id,
            DT.dataset_id == dataset_id,
        ).first()
        if not target_table:
            raise HTTPException(status_code=404, detail="Target table not found in this dataset")

    try:
        return DatasetQualityService.duplicate_rule(
            db, rule,
            target_table_id=body.target_table_id,
            name_suffix=body.name_suffix,
        )
    except QualityRuleConflictError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ── Runs ───────────────────────────────────────────────────────────────────

@router.post(
    "/{dataset_id}/quality/runs",
    response_model=QualityRunTriggerResponse,
    status_code=202,
)
def trigger_quality_run(
    dataset_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Trigger a full quality-check run in the background."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    run = DatasetQualityService.create_run(
        db,
        dataset_id,
        triggered_by_id=str(current_user.id),
    )
    background_tasks.add_task(DatasetQualityService.execute_run, run.id)
    return QualityRunTriggerResponse(run_id=run.id, status=run.status)


@router.get("/{dataset_id}/quality/runs", response_model=List[QualityRunResponse])
def list_quality_runs(
    dataset_id: int,
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List recent quality run history."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")
    return DatasetQualityService.list_runs(db, dataset_id, limit=limit)


@router.get("/{dataset_id}/quality/runs/{run_id}", response_model=QualityRunResponse)
def get_quality_run(
    dataset_id: int,
    run_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a specific quality run result (used for polling)."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")

    run = db.query(DatasetQualityRun).filter(
        DatasetQualityRun.id == run_id,
        DatasetQualityRun.dataset_id == dataset_id,
    ).first()
    if not run:
        raise HTTPException(status_code=404, detail="Quality run not found")
    return run


# ── Schedule / Automation ─────────────────────────────────────────────────

from app.models.dataset import DatasetQualitySchedule
from app.schemas.dataset import (
    QualityScheduleResponse,
    QualityScheduleUpsert,
)


def _schedule_to_response(
    dataset_id: int,
    schedule: Optional[DatasetQualitySchedule],
) -> QualityScheduleResponse:
    if schedule is None:
        return QualityScheduleResponse(dataset_id=dataset_id)
    return QualityScheduleResponse.model_validate(schedule)


@router.get(
    "/{dataset_id}/quality/schedule",
    response_model=QualityScheduleResponse,
)
def get_quality_schedule(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Read the automation config for a dataset. Returns a default disabled
    payload when no schedule has been configured yet."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")
    schedule = (
        db.query(DatasetQualitySchedule)
        .filter(DatasetQualitySchedule.dataset_id == dataset_id)
        .first()
    )
    return _schedule_to_response(dataset_id, schedule)


@router.put(
    "/{dataset_id}/quality/schedule",
    response_model=QualityScheduleResponse,
)
def upsert_quality_schedule(
    dataset_id: int,
    body: QualityScheduleUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create or update the automation config for a dataset."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    schedule = (
        db.query(DatasetQualitySchedule)
        .filter(DatasetQualitySchedule.dataset_id == dataset_id)
        .first()
    )
    is_new = schedule is None
    if is_new:
        schedule = DatasetQualitySchedule(
            dataset_id=dataset_id,
            created_by_id=str(current_user.id),
        )
        db.add(schedule)

    schedule.enabled = bool(body.enabled)
    schedule.type = body.type
    schedule.cron = (body.cron or "").strip() or None
    schedule.timezone = (body.timezone or "UTC").strip() or "UTC"
    schedule.recipient_email = body.recipient_email
    schedule.cc_emails = list(body.cc_emails or [])
    schedule.notify_on_success = bool(body.notify_on_success)
    schedule.notify_on_failure = bool(body.notify_on_failure)
    if is_new is False:
        schedule.created_by_id = schedule.created_by_id or str(current_user.id)

    db.commit()
    db.refresh(schedule)

    # Sync the live APScheduler registry to match the DB.
    try:
        from app.services.dataset_quality_scheduler import sync_dataset_schedule
        sync_dataset_schedule(dataset_id)
        db.refresh(schedule)
    except Exception as exc:  # noqa: BLE001
        # Do not fail the API call — scheduler will rebuild on next startup.
        import logging as _logging
        _logging.getLogger(__name__).error(
            "[quality/schedule] sync_dataset_schedule failed: %s", exc
        )

    return _schedule_to_response(dataset_id, schedule)


# ── AI Rule Suggestion ────────────────────────────────────────────────────

from app.schemas.dataset import (
    QualityAISuggestRequest,
    QualityAISuggestResponse,
)


@router.post(
    "/{dataset_id}/quality/ai-suggest",
    response_model=QualityAISuggestResponse,
)
async def ai_suggest_quality_rule(
    dataset_id: int,
    body: QualityAISuggestRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Use AI to suggest a quality rule config from a natural-language description."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    from app.services.quality_ai_suggest import suggest_quality_rule
    result = await suggest_quality_rule(
        description=body.description,
        table_name=body.table_name,
        columns=[{"name": c.name, "type": c.type} for c in body.columns],
    )
    return result


@router.post("/{dataset_id}/tables/{table_id}/auto-detect-types")
def auto_detect_column_types(
    dataset_id: int,
    table_id: int,
    body: dict | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full-scan inference of best column types and apply non-conflicting suggestions.

    Body (all optional):
      - tolerance: float, max fraction of invalid casts allowed (default 0.001)
      - row_cap: int, override per-dialect default scan cap
      - apply: bool, write suggestions to type_overrides (default True)
      - overwrite_user_overrides: bool, replace existing overrides (default False)
      - columns: list[str], restrict to a subset
    """
    body = body or {}
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    datasource = db.query(DataSource).filter(DataSource.id == table.datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    from app.services.column_type_inference_service import (
        apply_suggestions_to_table,
        infer_full_column_types,
    )

    suggestions = infer_full_column_types(
        datasource,
        table,
        columns=body.get("columns"),
        tolerance=float(body.get("tolerance") or 0.001),
        row_cap=body.get("row_cap"),
    )
    applied: dict[str, str] = {}
    if body.get("apply", True):
        applied = apply_suggestions_to_table(
            db,
            table,
            suggestions,
            overwrite_user_overrides=bool(body.get("overwrite_user_overrides", False)),
        )

    return {
        "applied": applied,
        "suggestions": [s.to_dict() for s in suggestions],
    }


@router.get("/{dataset_id}/tables/{table_id}/columns/{column_name}/summary")
def get_column_summary_endpoint(
    dataset_id: int,
    table_id: int,
    column_name: str,
    top_limit: int = 10,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Kaggle-style summary for a single column: top values or histogram."""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    datasource = db.query(DataSource).filter(DataSource.id == table.datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    from app.services.column_summary_service import get_column_summary

    summary = get_column_summary(datasource, table, column_name, top_limit=int(top_limit))
    return summary.to_dict()


@router.post("/{dataset_id}/tables/{table_id}/profile")
def get_table_profile(
    dataset_id: int,
    table_id: int,
    sample_limit: int = Query(20, ge=1, le=200),
    include_stats: bool = Query(True),
    stats_top_limit: int = Query(5, ge=1, le=20),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Bundle schema + sample rows + per-column stats in one call.

    Designed for orchestrator agents (MCP) that need to reason about a table
    without making 1+N round-trips. The response is intentionally compact:

      {
        "table": {id, name, display_name, description, row_count_estimate},
        "columns": [{name, type, nullable, role, description}, ...],
        "sample_rows": [...],   # up to `sample_limit` rows
        "stats": {              # only when include_stats=True
            "<col>": {detected_kind, total_rows, null_count, distinct_count,
                       top_values, min_value, max_value, avg_value, histogram}
        }
      }

    Stats are computed per-column via the existing column_summary service so
    behavior matches the dataset table tooltip exactly.
    """
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    datasource: Optional[DataSource] = None
    target_table = db_table

    if is_generated_calendar_table(db_table) or is_derived_table(db_table):
        try:
            datasource, target_table = build_live_proxy_table_for_dataset_table(
                db, dataset_obj, db_table,
            )
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") == "NOT_SYNCED":
                raise HTTPException(
                    status_code=422,
                    detail={"code": exc.code, "message": str(exc)},
                )
            raise HTTPException(status_code=400, detail=str(exc))
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            # Proxy-build can raise SQLAlchemy / runtime errors that aren't
            # DatasetTableSqlError (source connection refused, malformed
            # derived source_query, missing calendar dep…). Without this
            # catch any of those escape as a body-less 500. Convert to a
            # structured 400 so MCP / FE clients see what actually failed.
            logger.exception(
                "Proxy build failed for dataset=%s table=%s",
                dataset_id, table_id,
            )
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Could not build a live preview for this "
                    f"{'calendar' if is_generated_calendar_table(db_table) else 'derived'} "
                    f"table: {type(exc).__name__}: {exc}"
                ),
            )
    else:
        datasource = db.query(DataSource).filter(
            DataSource.id == db_table.datasource_id
        ).first()
        if not datasource:
            raise HTTPException(
                status_code=404,
                detail=_build_datasource_missing_detail(db_table),
            )

    try:
        result = LiveQueryService.execute_preview_query(
            datasource=datasource,
            db_table=target_table,
            limit=int(sample_limit),
            offset=0,
            filters=None,
        )
    except Exception as exc:
        logger.warning("Profile preview failed for table %d: %s", table_id, exc)
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        rows = result.get("rows") or []
        columns = result.get("columns") or []
        column_metadata: List[DatasetColumnMetadata] = []
        for i, col in enumerate(columns):
            col_type = _infer_column_type(col, i, rows)
            column_metadata.append(
                DatasetColumnMetadata(name=col, type=col_type, nullable=True)
            )

        from app.services.type_override_service import _override_type as _ovr_type
        type_overrides = db_table.type_overrides or {}
        for col_meta in column_metadata:
            if col_meta.name in type_overrides:
                resolved = _ovr_type(type_overrides[col_meta.name])
                if resolved:
                    col_meta.type = resolved
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        # Column-metadata building can fail on legacy data (type_overrides
        # referencing renamed columns, broken _infer_column_type for an
        # unexpected value shape, or the type_override_service import path
        # missing on an old deployment). Surface a structured 400 instead
        # of a blank 500.
        logger.exception(
            "Column metadata build failed for dataset=%s table=%s",
            dataset_id, table_id,
        )
        raise HTTPException(
            status_code=400,
            detail=f"Could not build column metadata: {type(exc).__name__}: {exc}",
        )

    def _serialize(val):
        if isinstance(val, (datetime, date)):
            return val.isoformat()
        if isinstance(val, Decimal):
            return float(val)
        return val

    serialized_rows = []
    for row in rows[: int(sample_limit)]:
        if isinstance(row, dict):
            serialized_rows.append({k: _serialize(v) for k, v in row.items()})
        else:
            serialized_rows.append([_serialize(v) for v in row])

    column_descriptions = db_table.column_descriptions or {}
    columns_payload = [
        {
            "name": col.name,
            "type": col.type,
            "nullable": col.nullable,
            "description": column_descriptions.get(col.name) or "",
        }
        for col in column_metadata
    ]

    payload: Dict[str, Any] = {
        "table": {
            "id": db_table.id,
            "name": db_table.name,
            "display_name": db_table.display_name,
            "description": db_table.auto_description,
            "description_source": db_table.description_source,
            "common_questions": db_table.common_questions or [],
            "estimated_row_count": db_table.estimated_row_count,
        },
        "columns": columns_payload,
        "sample_rows": serialized_rows,
        "sample_size": len(serialized_rows),
    }

    if include_stats:
        from app.services.column_summary_service import get_column_summary

        stats: Dict[str, Any] = {}
        for col in columns_payload:
            try:
                summary = get_column_summary(
                    datasource, target_table, col["name"], top_limit=int(stats_top_limit),
                )
                stats[col["name"]] = summary.to_dict()
            except Exception as exc:
                logger.warning(
                    "Column stats failed for %s.%s: %s",
                    db_table.name, col["name"], exc,
                )
                stats[col["name"]] = {"error": str(exc)}
        payload["stats"] = stats

    return payload
