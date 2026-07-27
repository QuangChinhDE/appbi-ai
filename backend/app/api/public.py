"""
Public (unauthenticated) endpoints for shared dashboard links.

POST /public/dashboards/{token}/auth               â†’ exchange password for session token
GET  /public/dashboards/{token}                    â†’ dashboard + chart configs
GET  /public/dashboards/{token}/charts/{chart_id}/data â†’ chart query data

Password-protected links require a session token obtained from /auth.
Session tokens are JWTs signed with the app SECRET_KEY, valid for 2 hours.
Send them via the X-Public-Session request header.
"""
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from app.core import get_db
from app.core.config import settings
from app.core.dependencies import ALGORITHM
from app.core.logging import get_logger
from app.models.models import Dashboard, DashboardChart, DashboardPublicLink
from app.schemas import ChartDataResponse, DashboardResponse
from app.schemas.schemas import AiChatSessionSave
from app.services import ChartService
from app.services.dataset_model_service import get_dataset_model, get_distinct_field_values, _DISTINCT_FETCH_CEILING
from app.services.dashboard_ai_bot.public_link_config import (
    resolve_public_ai_credentials,
    resolve_public_ai_critique_enabled,
    resolve_public_ai_mode,
    sanitize_report_context_note,
    web_search_enabled,
)
import uuid as _uuid

from fastapi.responses import FileResponse

from app.services import pdf_export_service
from app.services.embed_link_service import resolve_embed_grant_link
from app.services.filter_layered_merge import (
    apply_link_scope_bounds,
    link_entry_has_value,
    link_entry_is_scope,
    link_managed_field_keys,
    make_public_layers,
    merge_layered_filters,
    split_dashboard_filters_by_public_mode,
    split_link_filters_locked_vs_hidden,
)

# Keep this at module scope as well as inside the workspace router factory.
# Some deployed builds expose the cookie helper as a module-level function;
# without the module constant those builds raise NameError during login.
_WORKSPACE_COOKIE_PREFIX = "wbws_"

from slowapi import Limiter
from slowapi.util import get_remote_address

if settings.WORKBOARDS_ENABLED:
    from app.modules.workboards.models import WorkboardWorkspace
    from app.modules.workboards.roles import is_owner_role
    from app.modules.workboards.services import app_user_service
    from app.modules.workboards.services.public_links import WorkboardPublicLinkService
    from app.modules.workboards.services.ocr_secrets import (
        strip_layout_ocr_keys as _strip_ocr,
        get_screen_ocr_config,
    )
    from app.modules.workboards.services.rls_service import (
        identity_from_app_user,
    )
    from app.modules.workboards.services.write_service import (
        WorkboardValidationError,
        WorkboardWriteError,
        WorkboardWriteService,
    )
    from app.modules.workboards.workspace_schemas import (
        WorkspaceAppUserPublic,
        WorkspaceBranding,
        WorkspaceLoginRequest,
        WorkspaceLoginResponse,
        WorkspaceMenuItem,
        WorkspaceMenuItemPublic,
        WorkspaceMenuResponse,
        WorkspaceMetaPublic,
        WorkspaceMetaResponse,
    )
    from app.modules.workboards.models import Workboard as _WorkboardModel

router = APIRouter(prefix="/public", tags=["public"])
_limiter = Limiter(key_func=get_remote_address)
logger = get_logger(__name__)
_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

# 2 hours â€” covers a full business meeting/presentation session without excessive re-auth
# friction, while limiting the exposure window for forgotten open browser tabs.
PUBLIC_SESSION_SECONDS = 7200


class _PasswordBody(BaseModel):
    password: str


def _semantic_dimension_to_filter_type(dimension_type: str | None) -> str:
    normalized = str(dimension_type or "").lower()
    if normalized in {"date", "datetime"}:
        return "date"
    if normalized == "number":
        return "number"
    return "dropdown"


def _collect_join_key_fields(model: dict | None) -> set[str]:
    fields: set[str] = set()

    for explore in model.get("explores", []) if isinstance(model, dict) else []:
        base_view_name = str(explore.get("base_view_name") or "").strip()
        for join in explore.get("joins", []) or []:
            if join.get("origin") == "auto_calendar":
                continue

            from_view = str(join.get("from_view") or base_view_name or "").strip()
            to_view = str(join.get("view") or "").strip()
            from_columns = [
                str(value).strip()
                for value in (join.get("from_columns") or [])
                if str(value).strip()
            ]
            to_columns = [
                str(value).strip()
                for value in (join.get("to_columns") or [])
                if str(value).strip()
            ]
            if not from_columns and join.get("from_column"):
                from_columns = [str(join.get("from_column") or "").strip()]
            if not to_columns and join.get("to_column"):
                to_columns = [str(join.get("to_column") or "").strip()]

            if from_view:
                for from_column in from_columns:
                    if from_column:
                        fields.add(f"{from_view}.{from_column}")
            if to_view:
                for to_column in to_columns:
                    if to_column:
                        fields.add(f"{to_view}.{to_column}")

    return fields


def _build_public_calendar_filter_fields(db: Session, dash: Dashboard) -> list[dict]:
    semantic_fields: set[str] = set()
    charts_with_calendar: set[int] = set()
    dataset_ids: set[int] = set()
    table_labels_by_field: dict[str, str] = {}
    dataset_models: dict[int, dict] = {}
    total_dashboard_chart_count = len(dash.dashboard_charts or [])

    for dashboard_chart in dash.dashboard_charts or []:
        chart_config = dashboard_chart.chart.config if dashboard_chart.chart else {}
        binding = chart_config.get("semanticBinding") if isinstance(chart_config, dict) else None
        if not isinstance(binding, dict):
            continue

        dataset_id = binding.get("datasetId")
        if isinstance(dataset_id, int):
            dataset_ids.add(dataset_id)
            if dataset_id not in dataset_models:
                model = get_dataset_model(db, dataset_id)
                if model:
                    dataset_models[dataset_id] = model

        date_mappings = [
            mapping for mapping in (binding.get("calendarFieldMappings") or [])
            if isinstance(mapping, dict)
            and mapping.get("calendarField") == "date"
            and isinstance(mapping.get("semanticField"), str)
            and "." in str(mapping.get("semanticField"))
        ]
        if not date_mappings:
            continue

        charts_with_calendar.add(dashboard_chart.chart_id)
        for mapping in date_mappings:
            semantic_field = str(mapping["semanticField"])
            semantic_fields.add(semantic_field)
            if isinstance(dataset_id, int) and "." in semantic_field:
                view_name = semantic_field.split(".", 1)[0]
                model = dataset_models.get(dataset_id) or {}
                view = next(
                    (
                        item for item in (model.get("views") or [])
                        if isinstance(item, dict) and item.get("name") == view_name
                    ),
                    None,
                )
                if isinstance(view, dict):
                    table_label = view.get("table_display_name") or view.get("name")
                    if table_label:
                        table_labels_by_field[semantic_field] = str(table_label)

    ordered_semantic_fields = sorted(semantic_fields)
    if not ordered_semantic_fields:
        return []

    single_dataset_id = next(iter(dataset_ids)) if len(dataset_ids) == 1 else None
    single_dataset_name = (
        (dataset_models.get(single_dataset_id) or {}).get("dataset_name")
        if single_dataset_id is not None
        else None
    )
    return [{
        "key": ordered_semantic_fields[0],
        "name": "date",
        "label": "Date",
        "tableLabel": table_labels_by_field.get(ordered_semantic_fields[0]),
        "type": "date",
        "semanticField": ordered_semantic_fields[0],
        "datasetId": single_dataset_id,
        "datasetName": single_dataset_name,
        "defaultLinkedFields": ordered_semantic_fields[1:],
        "chartCoverage": len(charts_with_calendar),
        "datasetChartCount": total_dashboard_chart_count,
        "sharedAcrossDataset": total_dashboard_chart_count > 0 and len(charts_with_calendar) == total_dashboard_chart_count,
    }]


def _resolve_semantic_field_metadata(
    db: Session,
    dataset_id: int,
    semantic_field: str,
    dataset_models: dict[int, dict] | None = None,
) -> dict | None:
    """Resolve label/type/tableLabel for a `view.field` semantic ref from the dataset model.

    Returns a partial column dict, or None when the field cannot be resolved.
    Mutates `dataset_models` cache when provided.
    """
    if not isinstance(semantic_field, str) or "." not in semantic_field:
        return None
    view_name, field_name = semantic_field.split(".", 1)

    cache = dataset_models if dataset_models is not None else {}
    if dataset_id not in cache:
        model = get_dataset_model(db, dataset_id)
        if not model:
            return None
        cache[dataset_id] = model
    model = cache.get(dataset_id) or {}

    view = next(
        (
            item for item in (model.get("views") or [])
            if isinstance(item, dict) and item.get("name") == view_name
        ),
        None,
    )
    if not isinstance(view, dict):
        return None

    dimension = next(
        (
            item for item in (view.get("dimensions") or [])
            if isinstance(item, dict) and item.get("name") == field_name
        ),
        None,
    )

    label = field_name
    dim_type = None
    if isinstance(dimension, dict):
        label = dimension.get("label") or field_name
        dim_type = dimension.get("type")

    return {
        "key": semantic_field,
        "name": field_name,
        "label": label,
        "tableLabel": view.get("table_display_name") or view.get("name"),
        "type": _semantic_dimension_to_filter_type(dim_type),
        "datasetId": dataset_id,
        "datasetName": model.get("dataset_name"),
        "semanticField": semantic_field,
    }


def _build_filter_fields_from_public_filters(
    db: Session,
    dash: Dashboard,
    public_filters: list[dict],
) -> list[dict]:
    """Slicer-model column list: one slot per unique (datasetId, semanticField)
    in `public_filters`, in the order DA configured them."""
    dataset_models: dict[int, dict] = {}
    total_dashboard_chart_count = len(dash.dashboard_charts or [])
    seen: set[tuple[int, str]] = set()
    out: list[dict] = []

    for filter_condition in public_filters:
        if not isinstance(filter_condition, dict):
            continue
        dataset_id = filter_condition.get("datasetId")
        if not isinstance(dataset_id, int):
            continue
        refs = _public_filter_semantic_refs(filter_condition)
        if not refs:
            continue
        semantic_field = refs[0]
        key = (dataset_id, semantic_field)
        if key in seen:
            continue
        seen.add(key)

        column = _resolve_semantic_field_metadata(
            db, dataset_id, semantic_field, dataset_models=dataset_models,
        )
        if not column:
            continue

        # Honor explicit filter type override from DA (e.g. date stored as text but
        # configured as a date filter in Edit Public Link).
        explicit_type = filter_condition.get("type")
        if isinstance(explicit_type, str) and explicit_type:
            column["type"] = explicit_type

        # Collect any linkedFields/cross-dataset hints provided by DA so the FE can
        # fan out the filter to other datasets (e.g. global Date over all models).
        linked_fields = filter_condition.get("linkedFields")
        if isinstance(linked_fields, list):
            extra = [str(ref) for ref in linked_fields if isinstance(ref, str) and "." in ref and ref != semantic_field]
            if extra:
                column["defaultLinkedFields"] = extra

        column["chartCoverage"] = total_dashboard_chart_count
        column["datasetChartCount"] = total_dashboard_chart_count
        column["sharedAcrossDataset"] = True
        out.append(column)

    return out


def _augment_with_slicer_fields(
    db: Session,
    dash: Dashboard,
    base: list[dict],
) -> list[dict]:
    """Guarantee every canvas slicer's field is a queryable public filter field.

    A slicer is rendered on the public page, so its dropdown MUST be able to
    fetch distinct values. The base list (access filters, or the chart-binding
    scan) may omit a slicer's field — e.g. a slicer on a dim no chart binding
    references — which made the public distinct-values endpoint 404 and the FE
    mis-render it as "No values match … Try relaxing". Union the slicers'
    own fields in (deduped) so the slicer always resolves. This is not a
    privilege escalation: the slicer is already exposed on the canvas by the
    dashboard author; we only allow reading its OWN domain.
    """
    slicers = getattr(dash, "slicers_config", None) or []
    if not slicers:
        return base
    existing = {
        (c.get("datasetId"), str(c.get("semanticField") or ""))
        for c in base
        if isinstance(c, dict)
    }
    models: dict[int, dict] = {}
    augmented = list(base)
    for slc in slicers:
        if not isinstance(slc, dict):
            continue
        dataset_id = slc.get("datasetId")
        if not isinstance(dataset_id, int):
            continue
        refs = _public_filter_semantic_refs(slc)
        if not refs:
            continue
        semantic_field = refs[0]
        key = (dataset_id, semantic_field)
        if key in existing:
            continue
        column = _resolve_semantic_field_metadata(
            db, dataset_id, semantic_field, dataset_models=models,
        )
        if not column:
            continue
        existing.add(key)
        total = len(dash.dashboard_charts or [])
        column["chartCoverage"] = total
        column["datasetChartCount"] = total
        column["sharedAcrossDataset"] = True
        augmented.append(column)
    return augmented


def _build_public_filter_fields(
    db: Session,
    dash: Dashboard,
    public_filters: list[dict] | None = None,
) -> list[dict]:
    """Public-link filter columns.

    Slicer model (Looker/PowerBI): when the link has `filters_config` (Access filters)
    configured, the returned slots are EXACTLY those fields â€” one card per unique
    (datasetId, semanticField) referenced by `public_filters`, in the order DA defined.
    Legacy fallback: when no `public_filters`, scan chart bindings (preserves
    behavior for older shares that never configured Access filters).

    In BOTH modes the dashboard's canvas slicers are unioned in
    (`_augment_with_slicer_fields`) so a slicer's dropdown never 404s.
    """
    if public_filters:
        return _augment_with_slicer_fields(
            db, dash, _build_filter_fields_from_public_filters(db, dash, public_filters)
        )

    dataset_models: dict[int, dict] = {}
    dataset_join_key_fields: dict[int, set[str]] = {}
    columns: dict[str, dict] = {}
    counts: dict[str, set[int]] = {}
    total_dashboard_chart_count = len(dash.dashboard_charts or [])

    for dashboard_chart in dash.dashboard_charts or []:
        chart_config = dashboard_chart.chart.config if dashboard_chart.chart else {}
        binding = chart_config.get("semanticBinding") if isinstance(chart_config, dict) else None
        if not isinstance(binding, dict):
            continue

        dataset_id = binding.get("datasetId")
        if not isinstance(dataset_id, int):
            continue

        if dataset_id not in dataset_models:
            model = get_dataset_model(db, dataset_id)
            if not model:
                continue
            dataset_models[dataset_id] = model
            dataset_join_key_fields[dataset_id] = _collect_join_key_fields(model)

        model = dataset_models.get(dataset_id)
        if not model:
            continue

        views_by_name = {
            str(view.get("name")): view
            for view in model.get("views", [])
            if isinstance(view, dict) and view.get("name")
        }
        join_key_fields = dataset_join_key_fields.get(dataset_id, set())
        candidate_fields = (
            binding.get("reachableFields")
            or binding.get("dimensionFields")
            or list((binding.get("fieldMap") or {}).values())
        )

        for semantic_field in candidate_fields:
            if not isinstance(semantic_field, str) or "." not in semantic_field:
                continue
            view_name, field_name = semantic_field.split(".", 1)
            view = views_by_name.get(view_name)
            if not isinstance(view, dict) or view.get("hidden_in_canvas"):
                continue

            dimension = next(
                (
                    item for item in (view.get("dimensions") or [])
                    if isinstance(item, dict) and item.get("name") == field_name
                ),
                None,
            )
            if not isinstance(dimension, dict):
                continue

            if bool(dimension.get("hidden")) and semantic_field not in join_key_fields:
                continue

            if semantic_field not in columns:
                columns[semantic_field] = {
                    "key": semantic_field,
                    "name": field_name,
                    "label": dimension.get("label") or field_name,
                    "tableLabel": view.get("table_display_name") or view.get("name"),
                    "type": _semantic_dimension_to_filter_type(dimension.get("type")),
                    "datasetId": dataset_id,
                    "datasetName": model.get("dataset_name"),
                    "semanticField": semantic_field,
                }

            counts.setdefault(semantic_field, set()).add(dashboard_chart.chart_id)

    normalized_columns: list[dict] = []
    for key, column in columns.items():
        chart_coverage = len(counts.get(key, set()))
        normalized_columns.append({
            **column,
            "chartCoverage": chart_coverage,
            "datasetChartCount": total_dashboard_chart_count,
            "sharedAcrossDataset": total_dashboard_chart_count > 0 and chart_coverage == total_dashboard_chart_count,
        })

    normalized_columns.sort(
        key=lambda item: (
            -(1 if item.get("sharedAcrossDataset") else 0),
            -(item.get("chartCoverage") or 0),
            str(item.get("label") or item.get("name") or ""),
        )
    )

    calendar_columns = _build_public_calendar_filter_fields(db, dash)
    if calendar_columns:
        non_date_columns = [item for item in normalized_columns if item.get("type") != "date"]
        return _augment_with_slicer_fields(db, dash, [*calendar_columns, *non_date_columns])

    return _augment_with_slicer_fields(db, dash, normalized_columns)


def _public_filter_semantic_refs(filter_condition: dict) -> list[str]:
    refs: list[str] = []

    def add_ref(raw_value) -> None:
        raw = str(raw_value or "").strip()
        if "." in raw and raw not in refs:
            refs.append(raw)

    for key in ("semanticField", "fieldKey", "field"):
        add_ref(filter_condition.get(key))
    linked_fields = filter_condition.get("linkedFields")
    if isinstance(linked_fields, list):
        for linked_field in linked_fields:
            add_ref(linked_field)
    return refs


def _sanitize_public_viewer_filters(
    public_filter_fields: list[dict],
    dataset_id: int,
    viewer_filters: list[dict],
) -> list[dict]:
    allowed_fields = {
        str(item.get("semanticField"))
        for item in public_filter_fields
        if item.get("datasetId") == dataset_id and item.get("semanticField")
    }
    if not allowed_fields:
        return []

    sanitized: list[dict] = []
    for filter_condition in viewer_filters:
        filter_dataset_id = filter_condition.get("datasetId")
        if filter_dataset_id not in (None, dataset_id):
            continue

        matched_field = next(
            (ref for ref in _public_filter_semantic_refs(filter_condition) if ref in allowed_fields),
            None,
        )
        if not matched_field:
            continue

        _, field_name = matched_field.split(".", 1)
        sanitized.append({
            **filter_condition,
            "field": field_name,
            "fieldKey": matched_field,
            "semanticField": matched_field,
            "datasetId": dataset_id,
        })

    return sanitized


def _build_public_chart_filters(
    dash: Dashboard,
    link_filters_config: list[dict] | None,
    viewer_filters: list[dict] | None,
    *,
    context_for_log: str = "public_chart",
) -> list[dict]:
    """Phase-B (PBI-parity rework) — single layered merge for every
    public endpoint that fetches chart data.

    Precedence (see docs/filter-semantics.md §3):

      chart_base  (handled inside ChartService.get_chart_data)
        < dashboard_filter (Dashboard.filters_config, publicMode=visible)
        < dashboard_slicer (Dashboard.slicers_config — Phase-A column)
        < viewer_slicer    (FE-sent runtime filter list)
        < viewer_filter    (mini-pane overrides — reserved, empty until Phase F)
        < dashboard_filter_locked (Dashboard.filters_config, publicMode=locked/hidden —
                                   authoritative, sits ABOVE the viewer layers so a
                                   slicer/viewer choice cannot relax an author lock)
        < link_locked      (DashboardPublicLink.filters_config, value-bearing entries)

    `link_hidden` entries on the public link drop the matching field
    entirely (no banner, no slicer — see filter-semantics.md §2.3).

    Centralizing this means every endpoint that talks to the chart
    engine for a public viewer applies the same precedence — the
    chart-data endpoint, the distinct-values endpoint, and every AI
    bot endpoint that summarizes chart data. The memory
    `dashboard_ai_bot_filters` calls out the previous drift between
    those sites; this helper closes it.
    """
    raw_link = [item for item in (link_filters_config or []) if isinstance(item, dict)]
    # Peel off 'limit' (allow-list scope) entries BEFORE the lock/hide split:
    # they must NOT land in the authoritative locked layer (which would override
    # the viewer's choice). Instead they BOUND the viewer's pick via
    # apply_link_scope_bounds AFTER the merge, keeping the slicer interactive.
    scope_link = [e for e in raw_link if link_entry_is_scope(e)]
    non_scope_link = [e for e in raw_link if not link_entry_is_scope(e)]
    locked_link, hidden_link = split_link_filters_locked_vs_hidden(non_scope_link)
    # PBI-parity "Hide filter": a hidden link entry that carries a VALUE still
    # ENFORCES that value (the data IS filtered) — only its banner/control is
    # suppressed for the viewer. So route value-bearing hidden entries into the
    # locked (authoritative, applied) layer; keep only value-LESS hidden entries
    # as the kill-list ("remove this field from the link" legacy behaviour).
    # Before this, ANY hidden entry dropped the field, so an "Ẩn" lock silently
    # un-filtered the public data — diverging from the build view.
    # `link_entry_has_value` is the SINGLE source of truth (filter_layered_merge);
    # the structure-response strip (_get_share_dashboard) reuses it via
    # `link_managed_field_keys` so the two sites can never disagree.
    enforced_hidden = [e for e in hidden_link if link_entry_has_value(e)]
    if enforced_hidden:
        locked_link = [*locked_link, *enforced_hidden]
        hidden_link = [e for e in hidden_link if not link_entry_has_value(e)]
    # Phase-H — split the dashboard filter pane by publicMode so locked/
    # hidden entries land in the authoritative tier (above the viewer
    # layers) instead of the low default tier. Visible ones stay as
    # overridable defaults.
    visible_filters, authoritative_filters = split_dashboard_filters_by_public_mode(
        list(getattr(dash, "filters_config", None) or [])
    )
    merge_diagnostics: list[dict] = []
    merged = merge_layered_filters(
        make_public_layers(
            dashboard_filters=visible_filters,
            dashboard_filters_locked=authoritative_filters,
            dashboard_slicers=list(getattr(dash, "slicers_config", None) or []),
            viewer_slicers=list(viewer_filters or []),
            viewer_filters=[],  # mini-pane overrides — wired in Phase F
            link_locked=locked_link,
            link_hidden=hidden_link,
        ),
        diagnostics=merge_diagnostics,
    )
    # Per-link 'limit' allow-lists bound the viewer's effective selection
    # (intersect) without removing the interactive slicer — enforced
    # server-side so a crafted request can't escape the allow-list.
    merged = apply_link_scope_bounds(merged, scope_link)
    if merge_diagnostics:
        logger.info(
            "filter_merge context=%s dropped=%s",
            context_for_log,
            [d.get("reason") for d in merge_diagnostics],
        )
    return merged


def _link_scope_allowlist_for_field(
    link_filters_config: list[dict] | None,
    dataset_id: int,
    field: str,
) -> list[str] | None:
    """Return the 'limit' allow-list for ``(dataset_id, field)`` if this link
    bounds that field, else None.

    Used by the public distinct-values endpoint to cap a limited slicer's
    dropdown to its allowed subset. Matches on qualified semanticField first,
    then bare field, mirroring the rest of the public filter plumbing.
    """
    for entry in link_filters_config or []:
        if not isinstance(entry, dict) or not link_entry_is_scope(entry):
            continue
        if entry.get("datasetId") not in (None, dataset_id):
            continue
        refs = _public_filter_semantic_refs(entry)
        candidates = {str(r) for r in refs}
        if entry.get("field"):
            candidates.add(str(entry.get("field")))
        if entry.get("semanticField"):
            candidates.add(str(entry.get("semanticField")))
        if field in candidates:
            value = entry.get("value")
            if isinstance(value, (list, tuple)):
                return [str(v) for v in value if v not in (None, "")]
            if value not in (None, ""):
                return [str(value)]
            return None
    return None


def _dedupe_filters_by_field(filters: list[dict]) -> list[dict]:
    """Dedupe filter list by (datasetId, semanticField); later entries win.

    Phase-15.81 v4 — callers must order filters so the higher-priority
    source comes LAST:

      viewer top-bar overrides → hidden link filters (Loại 2)

    Rationale: a DA-stamped hidden constraint must never be relaxable by
    a viewer choosing a different value for the same field. Top-bar
    slicers (Loại 1) reach this function via `viewer_filters` (the FE
    seeds the slicer state from dashboard.filters_config then sends what
    the viewer settled on), so we treat them as overrides, not defaults.
    """
    by_key: dict[tuple, dict] = {}
    order: list[tuple] = []
    for index, item in enumerate(filters):
        if not isinstance(item, dict):
            continue
        refs = _public_filter_semantic_refs(item)
        semantic_field = refs[0] if refs else None
        dataset_id = item.get("datasetId")
        # Fallback identity for items without resolvable field â€” keep them all.
        key = (dataset_id, semantic_field) if semantic_field else ("__unkeyed__", index)
        if key not in by_key:
            order.append(key)
        by_key[key] = item
    return [by_key[key] for key in order]


def _strip_link_managed_filter_fields(
    dash: Dashboard,
    link_filters_config: list[dict] | None,
) -> None:
    """Remove fields this public link enforces or kills from viewer controls."""
    hidden_link_keys = link_managed_field_keys(link_filters_config)
    if not hidden_link_keys:
        return

    def _is_link_managed_field(entry: dict) -> bool:
        if not isinstance(entry, dict):
            return False
        return (
            (entry.get("semanticField") or entry.get("field") or "")
            .strip()
            .lower()
        ) in hidden_link_keys

    dash.slicers_config = [
        s for s in (getattr(dash, "slicers_config", None) or [])
        if not _is_link_managed_field(s)
    ]
    dash.filters_config = [
        f for f in (dash.filters_config or [])
        if not _is_link_managed_field(f)
    ]

    stripped_pages = []
    for page in (dash.pages_config or []):
        if isinstance(page, dict):
            page = {**page}
            if page.get("slicers"):
                page["slicers"] = [
                    s for s in page["slicers"]
                    if not _is_link_managed_field(s)
                ]
            if page.get("filters"):
                page["filters"] = [
                    f for f in page["filters"]
                    if not _is_link_managed_field(f)
                ]
        stripped_pages.append(page)
    dash.pages_config = stripped_pages


def _public_viewer_filter_inventory(dash: Dashboard) -> list[dict]:
    """Fields the public viewer can actually see/control on this dashboard."""
    top_bar_filters = list(dash.filters_config or [])
    top_bar_slicers = list(getattr(dash, "slicers_config", None) or [])
    pages_filters_flat: list[dict] = []
    pages_slicers_flat: list[dict] = []
    for page in dash.pages_config or []:
        if not isinstance(page, dict):
            continue
        for f in page.get("filters") or []:
            if isinstance(f, dict):
                pages_filters_flat.append(f)
        for s in page.get("slicers") or []:
            if isinstance(s, dict):
                pages_slicers_flat.append(s)

    return _dedupe_filters_by_field([
        *pages_filters_flat,
        *pages_slicers_flat,
        *top_bar_filters,
        *top_bar_slicers,
    ])


def _create_public_session(link_token: str) -> str:
    payload = {
        "sub": link_token,
        "type": "public_link_session",
        "exp": datetime.now(timezone.utc) + timedelta(seconds=PUBLIC_SESSION_SECONDS),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)


def _verify_public_session(session_token: str, link_token: str) -> bool:
    try:
        data = jwt.decode(session_token, settings.SECRET_KEY, algorithms=[ALGORITHM])
        return data.get("sub") == link_token and data.get("type") == "public_link_session"
    except JWTError:
        return False


def _get_dashboard_by_token(
    token: str,
    db: Session,
    session_token: str | None = None,
    *,
    track_access: bool = True,
) -> tuple[Dashboard, list[dict], str | None, dict]:
    """Look up dashboard by token. Checks new multi-link table first, falls back to legacy share_token.
    Returns (dashboard, filters_config_for_this_link, link_name, appearance_config)."""
    # Embed-grant tokens (from the M2M /integrations/embed/resolve endpoint)
    # resolve to a managed link WITHOUT exposing that link's own token. Purely
    # additive: normal public/share tokens never start with the grant prefix, so
    # the entire block below is unchanged for them. Grants carry their own
    # expiry/revocation (checked in resolve_embed_grant_link); they are gated by
    # the token-authenticated integration endpoint, not by a viewer password.
    grant_link = resolve_embed_grant_link(token, db)
    if grant_link is not None:
        dash = (
            db.query(Dashboard)
            .options(joinedload(Dashboard.dashboard_charts).joinedload(DashboardChart.chart))
            .filter(Dashboard.id == grant_link.dashboard_id)
            .first()
        )
        if not dash:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found.")
        if track_access:
            grant_link.access_count = (grant_link.access_count or 0) + 1
            grant_link.last_accessed_at = datetime.now(timezone.utc)
            db.commit()
        return dash, grant_link.filters_config or [], grant_link.name, grant_link.appearance_config or {}

    # Try new multi-link table first
    link = db.query(DashboardPublicLink).filter(
        DashboardPublicLink.token == token,
        DashboardPublicLink.is_active == True,
    ).first()
    if link:
        # Check expiry
        if link.expires_at and datetime.now(timezone.utc) > link.expires_at:
            raise HTTPException(status_code=status.HTTP_410_GONE, detail="This shared link has expired.")

        # Check max access count
        if link.max_access_count and (link.access_count or 0) >= link.max_access_count:
            raise HTTPException(status_code=status.HTTP_410_GONE, detail="This shared link has reached its access limit.")

        # Check password protection â€” require a valid session token
        if link.password_hash:
            if not session_token or not _verify_public_session(session_token, token):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="This shared link requires a password.",
                    headers={"X-Link-Password-Required": "true"},
                )

        dash = (
            db.query(Dashboard)
            .options(joinedload(Dashboard.dashboard_charts).joinedload(DashboardChart.chart))
            .filter(Dashboard.id == link.dashboard_id)
            .first()
        )
        if not dash:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found.")
        if track_access:
            link.access_count = (link.access_count or 0) + 1
            link.last_accessed_at = datetime.now(timezone.utc)
            db.commit()
        return dash, link.filters_config or [], link.name, link.appearance_config or {}

    # Fallback to legacy share_token on Dashboard model
    dash = (
        db.query(Dashboard)
        .options(joinedload(Dashboard.dashboard_charts).joinedload(DashboardChart.chart))
        .filter(Dashboard.share_token == token)
        .first()
    )
    if not dash:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Shared dashboard not found or link has been revoked.",
        )
    return dash, dash.public_filters_config or [], dash.name, {}


@router.post("/dashboards/{token}/auth")
@_limiter.limit("10/minute")
def auth_public_link(
    token: str,
    body: _PasswordBody,
    request: Request,
    db: Session = Depends(get_db),
):
    """Authenticate a password-protected public link. Returns a short-lived session token.

    The session token (JWT, valid for 2 hours) must be sent as the
    X-Public-Session header on subsequent GET requests for this link.
    """
    link = db.query(DashboardPublicLink).filter(
        DashboardPublicLink.token == token,
        DashboardPublicLink.is_active == True,
    ).first()
    if not link:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shared dashboard not found or link has been revoked.")
    if link.expires_at and datetime.now(timezone.utc) > link.expires_at:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="This shared link has expired.")
    if not link.password_hash:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This link does not require a password.")
    if not _pwd_ctx.verify(body.password, link.password_hash):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Incorrect password.")
    return {"session_token": _create_public_session(token), "expires_in": PUBLIC_SESSION_SECONDS}


@router.get("/dashboards/{token}", response_model=DashboardResponse)
@_limiter.limit("30/minute")
def get_public_dashboard(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Return dashboard structure for a public shared link. No auth required.
    Password-protected links require X-Public-Session header from /auth."""
    dash, link_hidden_filters, link_name, appearance_config = _get_dashboard_by_token(
        token,
        db,
        session_token=x_public_session,
    )

    # Perf: everything built below (hydrate every chart + resolve every dataset's
    # semantic model + build the filter inventory) is IDENTICAL for all viewers
    # of a token and is the GATE before any tile can load — so N concurrent
    # viewers each rebuild it. Cache the built response by token (short TTL;
    # structure edits still surface within the TTL) and coalesce concurrent
    # builds across workers — the same mechanism as chart-data. Auth + the
    # access-count bump already ran per-request in `_get_dashboard_by_token`.
    from app.services import query_cache as _qc
    _meta_cached = _qc.get_public_meta(token)
    _meta_leader = False
    if _meta_cached is None:
        _meta_cached, _meta_leader = _qc.begin_coalesced_public_meta(token)
    if _meta_cached is not None:
        return _meta_cached

    # Public viewers get view-level permission (read-only, no edit actions)
    dash.user_permission = "view"
    for dashboard_chart in dash.dashboard_charts or []:
        ChartService.hydrate_runtime_config(db, dashboard_chart.chart, auto_generate=False)

    # Public-link gates (🔒 Khoá + 🚫 Ẩn): a field that this link LOCKS or
    # HIDES has its value enforced server-side (see _build_public_chart_filters)
    # and the viewer must NOT get an editable control for it — otherwise they
    # see a slicer they can click that silently does nothing (link_locked wins).
    # This is the "filter chặn" / RLS behaviour: the gate can't be touched by
    # the viewer. Strip BOTH locked and hidden link fields from the slicer/
    # filter configs the FE renders. (Only shapes the structure response — the
    # chart-data endpoint builds its own dash + link merge, so values still
    # apply.) The 🔒-vs-🚫 difference — a read-only banner for locked — is a
    # separate future enhancement; for now both correctly block viewer edits.
    # A field is "managed" — its viewer control + any same-field page/dashboard
    # filter are stripped from the served structure — exactly when the link
    # ENFORCES or KILLS it. This MUST mirror the chart-data merge's notion of
    # "enforces"; both derive from `link_managed_field_keys` /
    # `link_entry_has_value` (filter_layered_merge) so the structure response and
    # the data merge can never disagree. Critically, an EMPTY locked value is a
    # no-op: it does NOT strip the field, so an author who locks a field but
    # hasn't picked a value yet keeps the page-scope filter + slicer instead of
    # silently leaking MORE data than the page is scoped to (repro 2026-06-18 on
    # dashboard 53: empty Product lock leaked 303K → 11M / 2 → 8 products).
    _strip_link_managed_filter_fields(dash, link_hidden_filters)

    # Phase-15.81 — TWO filter mechanisms surface differently:
    #
    #   A. dashboard.filters_config + pages_config[i].filters
    #      Set by the dashboard owner via the editor FilterPane. Intent:
    #      "DA-defined slicers for viewer interactivity" (Looker/PowerBI
    #      style). Viewer SEES these in the top-bar and can change values.
    #
    #   B. DashboardPublicLink.filters_config
    #      Set per-link in the Public Links modal. Intent: "DA wants to
    #      stamp a hidden constraint on THIS link only" — different links
    #      to the same dashboard can have different hidden filters. Viewer
    #      MUST NOT see / change these; they apply silently to every
    #      chart query.
    #
    # We attach (B) to a non-public field so FE merges it into chart-data
    # requests but doesn't render it. The top-bar slicer set served to FE
    # comes from (A) only.
    #
    # Phase-15.81 v6 — build available_filter_fields from BOTH the
    # all-pages set (dash.filters_config) AND every per-page filter set
    # (pages_config[i].filters), de-duped by (datasetId, semanticField).
    # The FE viewer seeds the top-bar slicer from active page + all
    # pages, so the picker (Add Filter modal) must offer the SAME field
    # surface — otherwise the picker hides legitimate per-page slots and
    # the viewer can't re-create or relabel a filter DA defined on
    # another page.
    top_bar_filters = list(dash.filters_config or [])
    # Phase-C (PBI-parity rework) — slicers and filters both feed the
    # public viewer's top-bar inventory. Slicers always reach the
    # viewer; filter-pane entries reach the viewer only when their
    # publicMode is 'visible' (the default). Locked / hidden ones
    # stay in `filters_config` for BE chart-data merging but do NOT
    # show up as pickable fields.
    field_inventory = _public_viewer_filter_inventory(dash)
    # public_filters_config still mirrors only the all-pages set; per-
    # page filters reach the viewer via dash.pages_config (FE seed
    # effect handles activation by page). available_filter_fields,
    # however, is the picker inventory and MUST cover both scopes.
    dash.public_filters_config = top_bar_filters
    dash.available_filter_fields = _build_public_filter_fields(db, dash, field_inventory)
    # Phase-B19 — attach the dataset semantic models for every chart's dataset so
    # a LOGGED-OUT public viewer's tiles can build label/format maps WITHOUT the
    # authed GET /datasets/{id}/model call. That call 401'd for anonymous viewers
    # and the global axios interceptor bounced them to the AppBI /login page —
    # i.e. public links appeared to "require an account". Serving the models here
    # keeps the public link password-only (or open), no account needed.
    try:
        from app.services.dataset_model_service import get_dataset_model
        _ds_ids: set[int] = set()
        for dc in dash.dashboard_charts or []:
            cfg = (dc.chart.config if getattr(dc, "chart", None) else None) or {}
            if not isinstance(cfg, dict):
                continue
            sb = cfg.get("semanticBinding")
            ds_id = sb.get("datasetId") if isinstance(sb, dict) else None
            if ds_id is None:
                ds_id = cfg.get("dataset_id")
            if ds_id is not None:
                try:
                    _ds_ids.add(int(ds_id))
                except (TypeError, ValueError):
                    pass
        def _trim_model_for_public(m: dict) -> dict:
            # SECURITY: expose ONLY the field label + measure-format the public
            # tiles need (buildSemanticLabelMap/FormatMap). Strip measure
            # expressions/SQL/where, join/explore definitions, source-table
            # names and any view/field internals — anonymous viewers must not
            # see the dataset's structure/logic, only what's needed to label
            # the charts already shown.
            views_out = []
            for v in (m.get("views") or []):
                if not isinstance(v, dict):
                    continue
                dims = [
                    {"name": d.get("name"), "label": d.get("label")}
                    for d in (v.get("dimensions") or [])
                    if isinstance(d, dict) and d.get("name")
                ]
                meas = []
                for me in (v.get("measures") or []):
                    if not isinstance(me, dict) or not me.get("name"):
                        continue
                    fmt = me.get("format")
                    meas.append({
                        "name": me.get("name"),
                        "label": me.get("label"),
                        "format": {"kind": fmt.get("kind")} if isinstance(fmt, dict) else None,
                    })
                views_out.append({"name": v.get("name"), "dimensions": dims, "measures": meas})
            return {"views": views_out}

        _models: dict = {}
        for ds_id in _ds_ids:
            try:
                m = get_dataset_model(db, ds_id)
                if m:
                    _models[str(ds_id)] = _trim_model_for_public(m)
            except Exception:
                pass
        dash.public_dataset_models = _models
    except Exception:
        dash.public_dataset_models = {}
    # New: pass link's hidden filters as a separate field for the FE viewer
    # to merge silently into every chart-data request. Empty list when the
    # legacy share_token path is used (legacy never had per-link filters).
    dash.public_link_hidden_filters = list(link_hidden_filters or [])
    dash.public_link_name = link_name
    # Strip the admin-only ai_bot_key before sending to public viewers.
    # Replace it with a safe boolean so the AI bot UI can skip key entry.
    safe_appearance: dict = dict(appearance_config or {})
    if safe_appearance.pop("ai_bot_key", None):
        safe_appearance["ai_bot_key_configured"] = True
    else:
        safe_appearance.pop("ai_bot_key_configured", None)
    safe_appearance.pop("ai_bot_report_context_note", None)
    dash.public_link_appearance = safe_appearance

    # Serialize the built structure to a plain dict, cache it by token, and wake
    # any workers coalescing on this token. Returning the dict (validated by the
    # response_model) is fine; on any serialization hiccup we fall back to the ORM
    # and simply skip caching (correctness over the perf optimization).
    from fastapi.encoders import jsonable_encoder as _jsonable_encoder
    _meta_payload = None
    try:
        _meta_payload = _jsonable_encoder(DashboardResponse.model_validate(dash))
    except Exception:
        logger.debug("public dashboard meta serialize failed; returning ORM", exc_info=True)
    if _meta_payload is not None:
        _qc.set_public_meta(token, _meta_payload)
    if _meta_leader:
        _qc.end_coalesced_public_meta(token)
    return _meta_payload if _meta_payload is not None else dash


if settings.WORKBOARDS_ENABLED:
    # Prefix for the per-workspace session cookie; final name is
    # ``wbws_<short-hash-of-token>`` (see _workspace_cookie_name). Must be a
    # module-level constant so the login/logout paths can resolve it —
    # omitting it raises ``NameError: _WORKSPACE_COOKIE_PREFIX is not defined``
    # AFTER auth succeeds, surfacing to the user as a false "Đăng nhập thất bại".
    _WORKSPACE_COOKIE_PREFIX = "wbws_"

    def _workspace_cookie_name(workspace_token: str) -> str:
        import hashlib
        digest = hashlib.sha256(workspace_token.encode("utf-8")).hexdigest()[:12]
        return f"{_WORKSPACE_COOKIE_PREFIX}{digest}"

    def _secure_cookie_for_request(request: Request) -> bool:
        if not settings.COOKIE_SECURE:
            return False
        proto = (
            request.headers.get("x-forwarded-proto")
            or request.url.scheme
            or ""
        ).split(",")[0].strip().lower()
        return proto == "https"

    def _workspace_branding(workspace) -> WorkspaceBranding | None:
        raw = workspace.branding or None
        if not raw:
            return None
        try:
            return WorkspaceBranding.model_validate(raw)
        except Exception:
            return None

    def _workspace_meta_public(workspace) -> WorkspaceMetaPublic:
        access_mode = (workspace.access_mode or "internal")
        return WorkspaceMetaPublic(
            name=workspace.name,
            description=workspace.description,
            branding=_workspace_branding(workspace),
            access_mode=access_mode,
            requires_login=access_mode == "public_app_users",
        )

    def _load_workspace_or_404(db: Session, token: str):
        ws = app_user_service.get_workspace_by_token(db, token)
        if ws is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Workspace not found or has been disabled.",
            )
        return ws

    def _read_workspace_session_from_request(
        request: Request,
        workspace,
    ) -> dict | None:
        cookie_name = _workspace_cookie_name(workspace.token)
        token = request.cookies.get(cookie_name)
        if not token:
            auth = request.headers.get("X-Workspace-Session")
            if auth:
                token = auth
        if not token:
            return None
        data = app_user_service.decode_session_token(token, workspace.token)
        if not data:
            return None
        return data


    def _try_appbi_user_from_request(request: Request, db: Session):
        """Decode the AppBI Bearer token if present; return the User row.

        Used to let workspaces with ``access_mode='internal'`` accept staff
        sessions instead of mandating a separate PIN-based app_user. Returns
        ``None`` on any failure (no token, expired, revoked, etc.) so callers
        can fall through to the workspace-cookie path or 401.
        """
        try:
            from app.models.user import User, UserStatus
            from app.models.revoked_token import RevokedToken
        except Exception:  # pragma: no cover
            return None
        auth_header = request.headers.get("Authorization") or ""
        token = ""
        if auth_header.lower().startswith("bearer "):
            token = auth_header.split(" ", 1)[1].strip()
        if not token:
            return None
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
            user_id = payload.get("sub")
            if not user_id:
                return None
            jti = payload.get("jti")
            if jti and db.query(RevokedToken).filter(RevokedToken.jti == jti).first():
                return None
            import uuid as _uuid
            user = db.query(User).filter(User.id == _uuid.UUID(str(user_id))).first()
            if not user or getattr(user, "status", None) != UserStatus.ACTIVE:
                return None
            return user
        except (JWTError, ValueError, TypeError):
            return None

    def _read_app_user_from_request(
        request: Request,
        workspace,
        *,
        db: Session | None = None,
    ) -> dict | None:
        """Resolve the active app_user dict for a workspace request.

        Order:
          1. Workspace-cookie session (the standard flow â€” set by /login or
             by the admin preview-session endpoint).
          2. For ``access_mode='internal'`` workspaces only: any valid AppBI
             Bearer token in the Authorization header. The AppBI user is
             surfaced as the app_user so RLS / write enforcement still has
             a stable identity.
        """
        data = _read_workspace_session_from_request(request, workspace)
        if data:
            return data.get("app_user") or {}
        if (workspace.access_mode or "internal") == "internal" and db is not None:
            user = _try_appbi_user_from_request(request, db)
            if user is not None:
                return {
                    "username": str(getattr(user, "email", "") or user.id),
                    "role": "appbi_staff",
                    "full_name": getattr(user, "full_name", None) or getattr(user, "email", ""),
                    "_internal": True,
                }
        return None


    @router.get("/workspaces/{token}", response_model=WorkspaceMetaResponse)
    @_limiter.limit("60/minute")
    def get_public_workspace_meta(
        token: str,
        request: Request,
        db: Session = Depends(get_db),
    ):
        ws = _load_workspace_or_404(db, token)
        return WorkspaceMetaResponse(workspace=_workspace_meta_public(ws))


    @router.post("/workspaces/{token}/login", response_model=WorkspaceLoginResponse)
    @_limiter.limit("10/minute")
    def workspace_login(
        token: str,
        body: WorkspaceLoginRequest,
        request: Request,
        response: Response,
        db: Session = Depends(get_db),
    ):
        ws = _load_workspace_or_404(db, token)
        client_ip = (request.client.host if request.client else None) or None
        matched_user, _matched_wb = app_user_service.authenticate(
            db, ws, body.username.strip(), body.pin, ip=client_ip
        )
        scope_context = app_user_service.compute_scope_context(db, matched_user)
        session_token, ttl = app_user_service.create_session_token(
            ws, matched_user, db=db
        )

        # Cookie is httpOnly so JS cannot read it (XSS-resistant). SameSite=lax
        # so navigations from /w/{token}/... pages keep the cookie attached.
        response.set_cookie(
            key=_workspace_cookie_name(token),
            value=session_token,
            max_age=ttl,
            httponly=True,
            secure=_secure_cookie_for_request(request),
            samesite="lax",
            path="/",
        )
        return WorkspaceLoginResponse(
            session_token=session_token,
            expires_in=ttl,
            app_user=WorkspaceAppUserPublic(
                username=matched_user.username,
                role=matched_user.role,
                full_name=matched_user.full_name,
                context={
                    **dict(matched_user.context or {}),
                    **scope_context,
                },
            ),
        )


    @router.post("/workspaces/{token}/logout")
    def workspace_logout(token: str, response: Response, db: Session = Depends(get_db)):
        # Don't 404 here â€” let users clear their cookie even if the
        # workspace was deleted, otherwise they'd be stuck.
        response.delete_cookie(
            key=_workspace_cookie_name(token),
            path="/",
        )
        return {"ok": True}


    @router.get("/workspaces/{token}/menu", response_model=WorkspaceMenuResponse)
    def workspace_menu(
        token: str,
        request: Request,
        db: Session = Depends(get_db),
    ):
        ws = _load_workspace_or_404(db, token)
        app_user = _read_app_user_from_request(request, ws, db=db)
        if app_user is None:
            access_mode = (ws.access_mode or "internal")
            if access_mode == "internal":
                detail = (
                    "Workspace nÃ y chá»‰ má»Ÿ cho AppBI staff Ä‘Ã£ Ä‘Äƒng nháº­p. "
                    "ÄÄƒng nháº­p AppBI rá»“i má»Ÿ láº¡i."
                )
            else:
                detail = "Sign in to access this workspace."
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=detail,
            )

        # Resolve menu items: keep only items whose roles[] contains the
        # caller's role (or that omit roles[], meaning "everyone").
        role = (app_user.get("role") or "").strip().lower()
        configured_items: list[WorkspaceMenuItem] = []
        for raw in ws.menu_config or []:
            try:
                configured_items.append(WorkspaceMenuItem.model_validate(raw))
            except Exception:
                continue
        slug_set = [i.workboard_slug for i in configured_items]
        wb_rows = (
            db.query(_WorkboardModel)
            .filter(_WorkboardModel.slug.in_(slug_set))
            .all()
            if slug_set
            else []
        )
        wb_by_slug = {wb.slug: wb for wb in wb_rows}

        out_items: list[WorkspaceMenuItemPublic] = []
        for item in configured_items:
            wb = wb_by_slug.get(item.workboard_slug)
            if wb is None:
                continue
            allowed_roles = [r.strip().lower() for r in item.roles or []]
            if allowed_roles and role not in allowed_roles and not is_owner_role(role):
                continue
            # Hide workboards the matched session isn't bound to. The JWT
            # carries the workboard_id of the row that authenticated, so a
            # nurse who logged in against Workboard A doesn't see (and
            # can't poke at) Workboard B sitting in the same workspace
            # menu.
            if not app_user_service.can_app_user_access_workboard(
                db, wb, app_user
            ):
                continue
            out_items.append(
                WorkspaceMenuItemPublic(
                    workboard_id=wb.id,
                    workboard_slug=wb.slug or "",
                    label=item.label,
                    description=item.description or wb.description,
                    icon=item.icon or wb.icon,
                    view_id=item.view_id,
                )
            )

        full_name = None
        return WorkspaceMenuResponse(
            workspace=_workspace_meta_public(ws),
            app_user=WorkspaceAppUserPublic(
                username=str(app_user.get("username") or ""),
                role=app_user.get("role"),
                full_name=full_name,
                context={
                    k: v
                    for k, v in app_user.items()
                    if k not in {"username", "role"}
                },
            ),
            menu=out_items,
        )


    def _require_workspace_app_user(
        request: Request,
        workspace,
        *,
        db: Session | None = None,
    ) -> dict:
        app_user = _read_app_user_from_request(request, workspace, db=db)
        if app_user is None:
            access_mode = (workspace.access_mode or "internal")
            if access_mode == "internal":
                detail = (
                    "Workspace nÃ y chá»‰ má»Ÿ cho AppBI staff Ä‘Ã£ Ä‘Äƒng nháº­p."
                )
            else:
                detail = "Sign in to use this workspace."
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=detail,
            )
        return app_user

    def _resolve_workboard_for_workspace(
        db: Session,
        workspace,
        workboard_id: int,
        *,
        request: Request | None = None,
        app_user: dict | None = None,
    ):
        """Make sure the requested workboard is visible in this workspace.

        Otherwise an authenticated app user could brute-force IDs to read
        any workboard on the deployment. Admin preview sessions may carry a
        one-workboard bypass so newly imported mini-apps can be previewed
        before they are published into the workspace menu.

        When ``app_user`` is supplied, its Workboard ownership is verified
        before it can open the app by id. This stops one authenticated
        mini-app user from poking around a sibling app in the workspace.
        """
        configured_slugs = {
            (item.get("workboard_slug") or "")
            for item in (workspace.menu_config or [])
            if isinstance(item, dict)
        }
        wb = db.query(_WorkboardModel).filter(_WorkboardModel.id == workboard_id).first()
        if wb is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Workboard not found in this workspace.",
            )

        in_menu = (wb.slug or "") in configured_slugs

        preview_workboard_id: int | None = None
        if request is not None:
            session_data = _read_workspace_session_from_request(request, workspace)
            try:
                preview_workboard_id = int(
                    (session_data or {}).get("preview_workboard_id") or 0
                )
            except (TypeError, ValueError):
                preview_workboard_id = None

        if not in_menu and preview_workboard_id != workboard_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Workboard not found in this workspace.",
            )

        if app_user is not None and not app_user_service.can_app_user_access_workboard(
            db, wb, app_user
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This account does not belong to this mini-app.",
            )

        # Draft/Published read-split. A real end-user request serves the
        # immutable PUBLISHED snapshot; an admin PREVIEW session (its
        # preview_workboard_id targets this board) serves the live DRAFT so
        # unpublished edits are testable. Stamp a transient flag that
        # parse_layout()/render_app_shell() read downstream (same pattern as
        # the _cleared_screens transient attr).
        is_preview = preview_workboard_id == workboard_id
        if not is_preview and (not wb.is_published or wb.published_layout_json is None):
            # Not live: never published (no snapshot) OR un-published
            # (is_published flipped off — the snapshot is kept so re-publish is
            # instant, but the live runtime must stop serving). Preview sessions
            # bypass this so admins can still test the draft.
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Ứng dụng chưa được xuất bản.",
            )
        wb._wb_use_published = not is_preview
        return wb


    def _public_hidden_screen_ids(workspace, workboard) -> set:
        """Screen ids this Cổng hides for this workboard ON THE PUBLIC LINK.

        Read from the Cổng's menu item (``hidden_screen_ids``) — the builder
        layout is untouched, so these screens still exist for editing; they are
        just dropped from the public nav and blocked from public content
        endpoints (so a hidden screen can't be deep-linked either).
        """
        slug = getattr(workboard, "slug", None)
        for item in (workspace.menu_config or []):
            if isinstance(item, dict) and (item.get("workboard_slug") or "") == slug:
                return {str(i) for i in (item.get("hidden_screen_ids") or []) if i}
        return set()

    def _screen_blocked(screen, identity, workspace, workboard) -> bool:
        """Whether a public app-user is denied access to ``screen``.

        The Cổng's explicit ``hidden_screen_ids`` is a hard block. Otherwise a
        screen is reachable when it is EITHER nav-visible to the role
        (``visible_for_roles``) OR the role has an RLS grant to it — the latter
        lets a screen hidden from the nav still open when reached via an
        explicit row-action / after_submit navigation. ``visible_for_roles`` is
        a nav-DISPLAY concern; per-screen RLS (fail-closed) is the real access
        boundary, so this never widens data access beyond what RLS already
        allows.
        """
        if screen.id in _public_hidden_screen_ids(workspace, workboard):
            return True
        if screen_runtime.is_screen_visible_for(screen, identity):
            return False
        return not screen_runtime.role_has_screen_grant(screen, identity)


    # â”€â”€ Mini-app screen-based endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    #
    # The "screens" model is the modern public runtime: instead of one form
    # + one list per workboard, the workboard holds N screens (form/list/
    # doc/dashboard) wired together by ``after_submit.go_to_screen``. These
    # endpoints serve a single-page-app shell on top of that contract.

    from app.modules.workboards.services import screen_runtime  # noqa: E402

    @router.get("/workspaces/{token}/workboards/{workboard_id}/app")
    def workspace_app_shell(
        token: str,
        workboard_id: int,
        request: Request,
        db: Session = Depends(get_db),
    ):
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        return screen_runtime.render_app_shell(
            wb, identity, hidden_screen_ids=_public_hidden_screen_ids(ws, wb), db=db
        )


    @router.get("/workspaces/{token}/workboards/{workboard_id}/screens/{screen_id}")
    def workspace_get_screen(
        token: str,
        workboard_id: int,
        screen_id: str,
        request: Request,
        db: Session = Depends(get_db),
        shared: str | None = Query(default=None, description="JSON-encoded shared_context"),
    ):
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        layout = screen_runtime.parse_layout(wb)
        screen = screen_runtime.get_screen(layout, screen_id)
        if _screen_blocked(screen, identity, ws, wb):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to that screen.",
            )
        shared_context: dict | None = None
        if shared:
            try:
                shared_context = json.loads(shared)
                if not isinstance(shared_context, dict):
                    shared_context = None
            except Exception:
                shared_context = None
        if screen.kind == "form":
            return {
                **screen_runtime.render_form_screen(
                    db, wb, screen, identity=identity, shared_context=shared_context
                ),
                "presentation": (
                    screen.presentation.model_dump(exclude_none=True)
                    if screen.presentation is not None
                    else None
                ),
            }
        if screen.kind == "table":
            return {
                **screen_runtime.render_table_screen(
                    db, wb, screen, identity=identity, shared_context=shared_context
                ),
                "screen_id": screen.id,
                "kind": "table",
                "title": screen.title,
                "icon": screen.icon,
                "description": screen.description,
                "presentation": (
                    screen.presentation.model_dump(exclude_none=True)
                    if screen.presentation is not None
                    else None
                ),
            }
        if screen.kind == "doc":
            return {
                **screen_runtime.render_doc_screen(
                    db, wb, screen, identity=identity, app_user_payload=app_user,
                    shared_context=shared_context,
                ),
                "presentation": (
                    screen.presentation.model_dump(exclude_none=True)
                    if screen.presentation is not None
                    else None
                ),
            }
        if screen.kind == "dashboard":
            if screen.dashboard is None:
                raise HTTPException(
                    status_code=400,
                    detail="Dashboard screen is missing its dashboard config.",
                )
            # Pick the right share token for this app_user's role. Managed mode
            # uses the per-role map (with a default fallback); manual mode just
            # surfaces whatever share_token the builder pasted.
            from app.modules.workboards.services.dashboard_link_service import (
                resolve_managed_token,
            )
            from app.modules.workboards.services.runtime_config import effective_layout_raw

            # Resolve the per-role managed token from the PUBLISHED layout for Live
            # (draft for Preview). NOTE: this fixes the token MAP source; the
            # underlying DashboardPublicLink rows are still a single shared set —
            # full draft/published row isolation (stage column) is Slice 2.
            resolved_token = resolve_managed_token(
                layout_json=effective_layout_raw(wb),
                screen_id=screen.id,
                app_user_role=app_user.get("role") if isinstance(app_user, dict) else None,
            )
            # In MANAGED mode (dashboard_id or per-role mapping configured) the
            # token MUST be the role-resolved one. Never fall back to the manual
            # share_token — that link is unfiltered and would leak the full
            # dashboard to a role that has no managed link for it.
            dash = screen.dashboard
            is_managed = bool(getattr(dash, "dashboard_id", None)) or bool(
                getattr(dash, "role_filter_mapping", None)
            )
            effective_token = resolved_token if is_managed else (resolved_token or dash.share_token)
            if not effective_token:
                raise HTTPException(
                    status_code=403,
                    detail=(
                        "Your role has no dashboard access for this screen."
                        if is_managed
                        else "Dashboard screen has no share token."
                    ),
                )
            return {
                "screen_id": screen.id,
                "kind": "dashboard",
                "title": screen.title,
                "icon": screen.icon,
                "description": screen.description,
                "presentation": (
                    screen.presentation.model_dump(exclude_none=True)
                    if screen.presentation is not None
                    else None
                ),
                "dashboard": {
                    "share_token": effective_token,
                    "password": screen.dashboard.password,
                    "height_px": screen.dashboard.height_px,
                },
            }
        raise HTTPException(status_code=400, detail=f"Unsupported screen kind '{screen.kind}'.")


    @router.get(
        "/workspaces/{token}/workboards/{workboard_id}/screens/{screen_id}/blocks/{block_index}/export.xlsx"
    )
    def workspace_screen_doc_block_export(
        token: str,
        workboard_id: int,
        screen_id: str,
        block_index: int,
        request: Request,
        db: Session = Depends(get_db),
        shared: str | None = Query(default=None, description="JSON-encoded shared_context"),
    ):
        """Stream a doc data_table block as XLSX (opt-in per block)."""
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        layout = screen_runtime.parse_layout(wb)
        screen = screen_runtime.get_screen(layout, screen_id)
        if _screen_blocked(screen, identity, ws, wb):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        shared_context: dict | None = None
        if shared:
            try:
                shared_context = json.loads(shared)
                if not isinstance(shared_context, dict):
                    shared_context = None
            except Exception:
                shared_context = None
        content, filename = screen_runtime.export_doc_data_block_to_excel(
            db, wb, screen, block_index, identity=identity, shared_context=shared_context,
        )
        from urllib.parse import quote
        return Response(
            content=content,
            media_type=(
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            ),
            headers={
                "Content-Disposition": (
                    f"attachment; filename*=UTF-8''{quote(filename)}"
                ),
                "Cache-Control": "no-store",
            },
        )


    @router.post(
        "/workspaces/{token}/workboards/{workboard_id}/screens/{screen_id}/blocks/{block_index}/sync"
    )
    def workspace_block_sync(
        token: str,
        workboard_id: int,
        screen_id: str,
        block_index: int,
        body: dict | None,
        request: Request,
        db: Session = Depends(get_db),
    ):
        """Kick off webhook sync for one data_table block trigger.

        Returns ``{group_id, runs:[…]}`` immediately; the actual HTTP work
        runs in background asyncio tasks. The frontend polls
        ``GET .../sync-runs/{run_id}`` (or group) for progress.
        """
        from app.modules.workboards.services import (
            webhook_sync_service as _sync_svc,
        )

        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        layout = screen_runtime.parse_layout(wb)
        screen = screen_runtime.get_screen(layout, screen_id)
        if _screen_blocked(screen, identity, ws, wb):
            raise HTTPException(
                status_code=403, detail="You don't have access to that screen."
            )
        trigger_id = (body or {}).get("trigger_id")
        if not isinstance(trigger_id, str) or not trigger_id:
            raise HTTPException(status_code=400, detail="trigger_id is required")
        shared_ctx = (body or {}).get("shared")
        if not isinstance(shared_ctx, dict):
            shared_ctx = None

        try:
            group_id, runs = _sync_svc.trigger_sync(
                db,
                wb,
                screen_id,
                block_index,
                trigger_id,
                identity=identity,
                app_user_payload=app_user,
                shared_context=shared_ctx,
            )
        except _sync_svc.WebhookSyncError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        return {
            "group_id": group_id,
            "runs": [
                {
                    "run_id": r.run_id,
                    "status": r.status,
                    "webhook_id": r.webhook_id,
                    "webhook_name": r.webhook_name,
                }
                for r in runs
            ],
        }


    @router.get(
        "/workspaces/{token}/workboards/{workboard_id}/sync-runs/{run_id}"
    )
    def workspace_get_sync_run(
        token: str,
        workboard_id: int,
        run_id: str,
        request: Request,
        db: Session = Depends(get_db),
    ):
        from app.modules.workboards.models import WorkboardSyncRun

        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        run = (
            db.query(WorkboardSyncRun)
            .filter(
                WorkboardSyncRun.run_id == run_id,
                WorkboardSyncRun.workboard_id == wb.id,
            )
            .one_or_none()
        )
        if run is None:
            raise HTTPException(status_code=404, detail="Sync run not found")
        # Public payload omits the snapshot URL.
        return {
            "run_id": run.run_id,
            "group_id": run.group_id,
            "status": run.status,
            "webhook_id": run.webhook_id,
            "webhook_name": run.webhook_name,
            "total_rows": run.total_rows,
            "total_batches": run.total_batches,
            "completed_batches": run.completed_batches,
            "failed_batches": run.failed_batches,
            "last_response_status": run.last_response_status,
            "last_error": run.last_error,
            "started_at": run.started_at,
            "finished_at": run.finished_at,
            "duration_ms": run.duration_ms,
        }


    @router.get(
        "/workspaces/{token}/workboards/{workboard_id}/sync-groups/{group_id}"
    )
    def workspace_get_sync_group(
        token: str,
        workboard_id: int,
        group_id: str,
        request: Request,
        db: Session = Depends(get_db),
    ):
        from app.modules.workboards.models import WorkboardSyncRun

        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        runs = (
            db.query(WorkboardSyncRun)
            .filter(
                WorkboardSyncRun.group_id == group_id,
                WorkboardSyncRun.workboard_id == wb.id,
            )
            .all()
        )
        if not runs:
            raise HTTPException(status_code=404, detail="Sync group not found")
        # Aggregate: still running if any pending/running, success if all
        # success, failed if all failed, otherwise partial.
        statuses = {r.status for r in runs}
        if statuses & {"pending", "running"}:
            agg = "running"
        elif statuses == {"success"}:
            agg = "success"
        elif statuses == {"cancelled"} or statuses <= {"cancelled", "failed"} and "cancelled" in statuses:
            agg = "cancelled" if statuses == {"cancelled"} else "failed"
        elif statuses == {"failed"}:
            agg = "failed"
        else:
            agg = "partial"
        return {
            "group_id": group_id,
            "status": agg,
            "runs": [
                {
                    "run_id": r.run_id,
                    "status": r.status,
                    "webhook_id": r.webhook_id,
                    "webhook_name": r.webhook_name,
                    "total_rows": r.total_rows,
                    "total_batches": r.total_batches,
                    "completed_batches": r.completed_batches,
                    "failed_batches": r.failed_batches,
                    "last_response_status": r.last_response_status,
                    "last_error": r.last_error,
                }
                for r in runs
            ],
        }


    @router.post(
        "/workspaces/{token}/workboards/{workboard_id}/sync-runs/{run_id}/cancel"
    )
    def workspace_cancel_sync_run(
        token: str,
        workboard_id: int,
        run_id: str,
        request: Request,
        db: Session = Depends(get_db),
    ):
        from app.modules.workboards.services import (
            webhook_sync_service as _sync_svc,
        )

        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        run = _sync_svc.request_cancel(db, run_id)
        if run is None or run.workboard_id != wb.id:
            raise HTTPException(status_code=404, detail="Sync run not found")
        return {"run_id": run.run_id, "status": run.status, "cancel_requested": True}


    @router.post(
        "/workspaces/{token}/workboards/{workboard_id}/sync-groups/{group_id}/cancel"
    )
    def workspace_cancel_sync_group(
        token: str,
        workboard_id: int,
        group_id: str,
        request: Request,
        db: Session = Depends(get_db),
    ):
        from app.modules.workboards.services import (
            webhook_sync_service as _sync_svc,
        )

        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        runs = _sync_svc.request_cancel_group(db, group_id)
        scoped = [r for r in runs if r.workboard_id == wb.id]
        if not scoped:
            raise HTTPException(status_code=404, detail="Sync group not found")
        return {
            "group_id": group_id,
            "runs": [
                {"run_id": r.run_id, "status": r.status, "cancel_requested": r.cancel_requested}
                for r in scoped
            ],
        }


    @router.post("/workspaces/{token}/workboards/{workboard_id}/screens/{screen_id}/table")
    def workspace_screen_table_rows(
        token: str,
        workboard_id: int,
        screen_id: str,
        body: dict | None,
        request: Request,
        db: Session = Depends(get_db),
    ):
        """Paginated rows for a table screen — includes computed/lookup
        cells, totals, multi-header, row-merges, plus the panel-augmented
        row payload so the detail side-panel doesn't need a second fetch
        when opening a row already on screen.
        """
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        layout = screen_runtime.parse_layout(wb)
        screen = screen_runtime.get_screen(layout, screen_id)
        if _screen_blocked(screen, identity, ws, wb):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        body = body or {}
        shared_context = body.get("shared") if isinstance(body.get("shared"), dict) else None
        return {
            **screen_runtime.render_table_screen(
                db,
                wb,
                screen,
                identity=identity,
                page=int(body.get("page") or 1),
                page_size=int(body["page_size"]) if body.get("page_size") else None,
                extra_filters=body.get("filters") or [],
                shared_context=shared_context,
            ),
            "screen_id": screen.id,
            "kind": "table",
            "title": screen.title,
            "icon": screen.icon,
            "description": screen.description,
        }


    @router.post("/workspaces/{token}/workboards/{workboard_id}/screens/{screen_id}/rows")
    def workspace_screen_insert(
        token: str,
        workboard_id: int,
        screen_id: str,
        body: dict,
        request: Request,
        db: Session = Depends(get_db),
    ):
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        layout = screen_runtime.parse_layout(wb)
        screen = screen_runtime.get_screen(layout, screen_id)
        if _screen_blocked(screen, identity, ws, wb):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        values = body.get("values") if isinstance(body, dict) else None
        if not isinstance(values, dict):
            raise HTTPException(status_code=400, detail="values is required.")
        client_op_id = body.get("client_op_id") if isinstance(body, dict) else None
        relation_context = body.get("relation_context") if isinstance(body, dict) else None
        try:
            result = screen_runtime.insert_screen_row(
                db, wb, screen, values, identity=identity,
                client_op_id=client_op_id if isinstance(client_op_id, str) else None,
                relation_context=relation_context if isinstance(relation_context, dict) else None,
            )
            # Persist the submission audit and cached idempotency result. The
            # datasource connector owns its write transaction; this metadata
            # transaction must also be committed before returning success.
            db.commit()
        except WorkboardValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"message": str(exc), "violations": exc.violations},
            ) from exc
        except WorkboardWriteError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        return {"action": "insert", **result}


    @router.get("/workspaces/{token}/workboards/{workboard_id}/related-records")
    def workspace_related_records(
        token: str,
        workboard_id: int,
        request: Request,
        parent_screen_id: str = Query(...),
        relation_id: str = Query(...),
        parent_key_value: str = Query(...),
        db: Session = Depends(get_db),
    ):
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        try:
            parsed_parent_key_value = json.loads(parent_key_value)
        except Exception:
            parsed_parent_key_value = parent_key_value
        return screen_runtime.render_related_records(
            db,
            wb,
            parent_screen_id=parent_screen_id,
            relation_id=relation_id,
            parent_key_value=parsed_parent_key_value,
            identity=identity,
        )


    @router.post(
        "/workspaces/{token}/workboards/{workboard_id}"
        "/screens/{screen_id}/actions/{action_id}/open-related-records"
    )
    def workspace_open_related_records(
        token: str,
        workboard_id: int,
        screen_id: str,
        action_id: str,
        body: dict,
        request: Request,
        db: Session = Depends(get_db),
    ):
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        layout = screen_runtime.parse_layout(wb)
        screen = screen_runtime.get_screen(layout, screen_id)
        if _screen_blocked(screen, identity, ws, wb):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        pk = body.get("pk") if isinstance(body, dict) else None
        if not isinstance(pk, dict) or not pk:
            raise HTTPException(status_code=400, detail="pk is required.")
        return screen_runtime.open_related_records_context(
            db,
            wb,
            screen,
            action_id=action_id,
            pk=pk,
            identity=identity,
        )


    @router.post("/workspaces/{token}/workboards/{workboard_id}/screens/{screen_id}/ocr-extract")
    @_limiter.limit("20/minute")
    def workspace_screen_ocr_extract(
        token: str,
        workboard_id: int,
        screen_id: str,
        body: dict,
        request: Request,
        db: Session = Depends(get_db),
    ):
        """Run "chụp ảnh tự điền": send a captured photo to the form's configured
        vision model and return values keyed by the form columns. Token/model are
        read (decrypted) from the workboard server-side — never from the client."""
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        layout = screen_runtime.parse_layout(wb)
        screen = screen_runtime.get_screen(layout, screen_id)
        if _screen_blocked(screen, identity, ws, wb):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        if screen.kind != "form" or screen.form is None:
            raise HTTPException(status_code=400, detail="Screen is not a form.")

        image = body.get("image") if isinstance(body, dict) else None
        if not isinstance(image, str) or not image:
            raise HTTPException(status_code=400, detail="image is required.")
        if len(image) > 12_000_000:  # ~9 MB raw
            raise HTTPException(status_code=413, detail="Ảnh quá lớn (tối đa ~9 MB).")

        # Live OCR config must come from the PUBLISHED snapshot, not the mutable
        # draft (a draft edit to the vision model/token must not change Live).
        from app.modules.workboards.services.runtime_config import effective_layout_raw

        cfg = get_screen_ocr_config(effective_layout_raw(wb), screen_id)
        if not cfg:
            raise HTTPException(status_code=400, detail="Tính năng chụp ảnh tự điền chưa được bật cho biểu mẫu này.")

        fields = [
            {
                "column": f.column,
                "label": f.label,
                "widget": f.widget,
                "lookup": f.lookup.model_dump() if getattr(f, "lookup", None) is not None else None,
            }
            for f in screen.form.fields
            if not getattr(f, "readonly", False)
            and not getattr(f, "computed_from_dataset", None)
        ]
        from app.modules.workboards.services import form_ocr_service
        try:
            result = form_ocr_service.extract(
                image=image,
                fields=fields,
                provider=cfg.get("provider") or "anthropic",
                api_key=cfg.get("api_key") or "",
                model=cfg.get("model"),
                hint=cfg.get("hint"),
            )
        except form_ocr_service.OcrError as exc:
            raise HTTPException(status_code=getattr(exc, "status_code", 400), detail=str(exc)) from exc
        return result


    @router.post("/workspaces/{token}/workboards/{workboard_id}/screens/{screen_id}/rows/bulk")
    def workspace_screen_bulk_insert(
        token: str,
        workboard_id: int,
        screen_id: str,
        body: dict,
        request: Request,
        db: Session = Depends(get_db),
    ):
        """Insert many rows in one call — used by the table's bulk-paste UI.

        Each row goes through the normal ``insert_screen_row`` pipeline
        (RLS, auto-number, audit fields, validation) so the contract is
        identical to a one-by-one insert. We loop instead of doing a true
        batch SQL because the dataset-side validation rules + auto-number
        sequencing both depend on the inserted row's resolved values.

        Hard cap: 500 rows per call to keep the request reasonable.
        Returns one entry per input row: ``{ok, error?, pk?, warnings?}``.
        Partial failure does NOT roll back successful rows — the caller
        sees which rows landed and which didn't so they can retry only the
        rejects.
        """
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        layout = screen_runtime.parse_layout(wb)
        screen = screen_runtime.get_screen(layout, screen_id)
        if _screen_blocked(screen, identity, ws, wb):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        if screen.kind != "table":
            raise HTTPException(status_code=400, detail="Bulk insert is only for table screens.")
        rows = body.get("rows") if isinstance(body, dict) else None
        if not isinstance(rows, list):
            raise HTTPException(status_code=400, detail="rows (list) is required.")
        if not rows:
            raise HTTPException(status_code=400, detail="rows cannot be empty.")
        BULK_CAP = 500
        if len(rows) > BULK_CAP:
            raise HTTPException(
                status_code=413,
                detail=f"Bulk insert limited to {BULK_CAP} rows per call (got {len(rows)}).",
            )

        results: list[dict] = []
        success_count = 0
        failure_count = 0
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                failure_count += 1
                results.append({
                    "index": index,
                    "ok": False,
                    "error": "Row must be an object",
                })
                continue
            try:
                outcome = screen_runtime.insert_screen_row(
                    db, wb, screen, row, identity=identity
                )
                success_count += 1
                results.append({
                    "index": index,
                    "ok": True,
                    "pk": outcome.get("pk"),
                    "warnings": outcome.get("warnings") or [],
                })
            except WorkboardValidationError as exc:
                failure_count += 1
                results.append({
                    "index": index,
                    "ok": False,
                    "error": str(exc),
                    "violations": getattr(exc, "violations", []),
                })
            except WorkboardWriteError as exc:
                failure_count += 1
                results.append({
                    "index": index,
                    "ok": False,
                    "error": str(exc),
                })
            except HTTPException as exc:
                failure_count += 1
                detail = exc.detail
                results.append({
                    "index": index,
                    "ok": False,
                    "error": (
                        detail.get("message") if isinstance(detail, dict) and detail.get("message")
                        else str(detail)
                    ),
                    "violations": (
                        detail.get("violations") if isinstance(detail, dict) else None
                    ),
                })
        return {
            "action": "bulk_insert",
            "total": len(rows),
            "success": success_count,
            "failure": failure_count,
            "results": results,
        }


    @router.post("/workspaces/{token}/workboards/{workboard_id}/screens/{screen_id}/bulk-action")
    def workspace_screen_bulk_action(
        token: str,
        workboard_id: int,
        screen_id: str,
        body: dict,
        request: Request,
        db: Session = Depends(get_db),
    ):
        """Run an advanced bulk "gộp & điều phối" recipe (BulkAction.steps) server-side.

        Body: ``{action_id, selected_pks:[{pk}], resources:{resource_id:{row}}}``.
        Creates the parent + detail lines + updates the sources in one call, with
        compensation rollback on failure. Returns ``{ok, primary_code, per_step, …}``.
        """
        from app.modules.workboards.services import bulk_action_service

        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        layout = screen_runtime.parse_layout(wb)
        screen = screen_runtime.get_screen(layout, screen_id)
        if _screen_blocked(screen, identity, ws, wb):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        action_id = str(body.get("action_id") or "").strip() if isinstance(body, dict) else ""
        if not action_id:
            raise HTTPException(status_code=400, detail="action_id is required.")
        selected_pks = body.get("selected_pks") if isinstance(body, dict) else None
        if not isinstance(selected_pks, list) or not selected_pks:
            raise HTTPException(status_code=400, detail="selected_pks (non-empty list) is required.")
        resources = body.get("resources") if isinstance(body, dict) else {}
        try:
            return bulk_action_service.run_bulk_action(
                db, wb, screen,
                action_id=action_id,
                selected_pks=[p for p in selected_pks if isinstance(p, dict)],
                resources=resources if isinstance(resources, dict) else {},
                identity=identity,
            )
        except bulk_action_service.BulkActionError as exc:
            raise HTTPException(
                status_code=422,
                detail={"message": exc.message, "per_step": exc.per_step},
            ) from exc


    @router.patch("/workspaces/{token}/workboards/{workboard_id}/screens/{screen_id}/rows")
    def workspace_screen_update(
        token: str,
        workboard_id: int,
        screen_id: str,
        body: dict,
        request: Request,
        db: Session = Depends(get_db),
    ):
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        layout = screen_runtime.parse_layout(wb)
        screen = screen_runtime.get_screen(layout, screen_id)
        if _screen_blocked(screen, identity, ws, wb):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        pk = body.get("pk") if isinstance(body, dict) else None
        values = body.get("values") if isinstance(body, dict) else None
        if not isinstance(values, dict):
            raise HTTPException(status_code=400, detail="values is required.")
        try:
            result = screen_runtime.update_screen_row(
                db, wb, screen, pk or {}, values, identity=identity
            )
        except WorkboardValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"message": str(exc), "violations": exc.violations},
            ) from exc
        except WorkboardWriteError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        # Web-push (C13): when someone reviews/edits a row owned by another
        # app-user, notify that owner ("your record was updated"). Best-effort.
        try:
            row = result.get("row") if isinstance(result, dict) else None
            owner = row.get("miniapp_user") if isinstance(row, dict) else None
            updater = app_user.get("username") if isinstance(app_user, dict) else None
            if owner and owner != updater:
                from app.modules.workboards.services import push_service
                push_service.send_to_user(
                    db, wb.id, owner,
                    title=f"Cập nhật: {screen.title}",
                    body=f"Bản ghi của bạn vừa được {updater or 'quản lý'} cập nhật.",
                    url=f"/ws/{token}/workboards/{wb.id}",
                )
        except Exception:
            logger.exception("push notify on update failed")
        return {"action": "update", **result}


    @router.get("/workspaces/{token}/push/config")
    def workspace_push_config(token: str, db: Session = Depends(get_db)):
        """VAPID public key for the browser's pushManager.subscribe. Public."""
        from app.modules.workboards.services import push_service
        _load_workspace_or_404(db, token)
        return {"enabled": push_service.is_configured(), "public_key": push_service.get_public_key()}

    @router.post("/workspaces/{token}/workboards/{workboard_id}/push/subscribe")
    def workspace_push_subscribe(
        token: str,
        workboard_id: int,
        body: dict,
        request: Request,
        db: Session = Depends(get_db),
    ):
        from app.modules.workboards.services import push_service
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(db, ws, workboard_id, request=request, app_user=app_user)
        sub = (body or {}).get("subscription") if isinstance(body, dict) else None
        unsub = (body or {}).get("unsubscribe") if isinstance(body, dict) else None
        username = app_user.get("username") if isinstance(app_user, dict) else None
        if not isinstance(sub, dict) or not sub.get("endpoint"):
            raise HTTPException(status_code=400, detail="subscription with endpoint is required.")
        if unsub:
            push_service.delete_subscription(db, wb.id, sub["endpoint"])
            return {"ok": True, "unsubscribed": True}
        try:
            push_service.save_subscription(
                db, wb.id, username, sub, user_agent=request.headers.get("user-agent"),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True}

    @router.post("/workspaces/{token}/workboards/{workboard_id}/push/test")
    def workspace_push_test(
        token: str,
        workboard_id: int,
        request: Request,
        db: Session = Depends(get_db),
    ):
        from app.modules.workboards.services import push_service
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(db, ws, workboard_id, request=request, app_user=app_user)
        username = app_user.get("username") if isinstance(app_user, dict) else None
        sent = push_service.send_to_user(
            db, wb.id, username,
            title="Thông báo thử",
            body="Bạn đã bật thông báo cho mini-app này ✅",
            url=f"/ws/{token}/workboards/{wb.id}",
        )
        return {"ok": True, "delivered": sent}


    @router.post("/workspaces/{token}/workboards/{workboard_id}/screens/{screen_id}/row")
    def workspace_screen_row_detail(
        token: str,
        workboard_id: int,
        screen_id: str,
        body: dict | None,
        request: Request,
        db: Session = Depends(get_db),
    ):
        """Fetch a single row by PK for the table screen's detail panel.

        Payload: ``{"pk": {pk_col: value, ...}}``. Returns ``{row, columns,
        panel}`` where ``columns`` is the panel's column list and ``panel``
        carries the panel spec so the FE can render sections + editable
        masks without re-reading the layout. Honours the same RLS rules as
        the table rendering — a row outside the viewer's scope is returned
        as 403.
        """
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        layout = screen_runtime.parse_layout(wb)
        screen = screen_runtime.get_screen(layout, screen_id)
        if _screen_blocked(screen, identity, ws, wb):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        if screen.kind != "table" or screen.table is None:
            raise HTTPException(status_code=400, detail="Screen is not a table.")
        pk = (body or {}).get("pk") if isinstance(body, dict) else None
        if not isinstance(pk, dict) or not pk:
            raise HTTPException(status_code=400, detail="pk is required.")
        return screen_runtime.fetch_table_row_for_panel(
            db, wb, screen, pk, identity=identity
        )


    @router.delete("/workspaces/{token}/workboards/{workboard_id}/screens/{screen_id}/rows")
    def workspace_screen_delete(
        token: str,
        workboard_id: int,
        screen_id: str,
        body: dict,
        request: Request,
        db: Session = Depends(get_db),
    ):
        """Delete one row via a table screen.

        Payload: ``{"pk": {pk_col: value, ...}}``. RLS ``can_delete`` is
        enforced server-side; the row is also confirmed against the read
        filters before the DELETE is issued.
        """
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        layout = screen_runtime.parse_layout(wb)
        screen = screen_runtime.get_screen(layout, screen_id)
        if _screen_blocked(screen, identity, ws, wb):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        pk = body.get("pk") if isinstance(body, dict) else None
        if not isinstance(pk, dict) or not pk:
            raise HTTPException(status_code=400, detail="pk is required.")
        try:
            result = screen_runtime.delete_screen_row(
                db, wb, screen, pk, identity=identity
            )
            db.commit()
        except WorkboardValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"message": str(exc), "violations": exc.violations},
            ) from exc
        except WorkboardWriteError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        return {"action": "delete", **result}


def _resolve_public_snapshot_ttl(appearance_config: dict | None) -> int | None:
    """Public per-link snapshot freshness (Stage 2), from
    ``appearance_config['cache_ttl_minutes']``:
      • absent/None → default (settings.MATERIALIZATION_DEFAULT_TTL_MINUTES)
      • 0  → Realtime (bypass snapshots → live)
      • -1 → Manual (serve the current snapshot forever, never auto-rebuild) → None
      • N  → serve-stale, async-rebuild once older than N minutes
    Returned value is what ChartService.get_chart_data / get_distinct_field_values
    expect: None = current-no-rebuild, 0 = live, N>0 = lazy TTL."""
    raw = (appearance_config or {}).get("cache_ttl_minutes")
    if raw is None:
        from app.core.config import settings
        return int(getattr(settings, "MATERIALIZATION_DEFAULT_TTL_MINUTES", 30) or 30)
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return None
    return None if v == -1 else v


@router.get("/dashboards/{token}/snapshots/info")
def get_public_snapshot_info(
    token: str,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Report-level "data as of" + staleness for the public viewer header, so
    viewers see when the numbers were last refreshed (perf #5)."""
    from app.api.dashboards import _dashboard_snapshot_as_of
    from app.services import snapshot_service
    dash, _, _, appearance = _get_dashboard_by_token(
        token, db, session_token=x_public_session, track_access=False,
    )
    ts = _dashboard_snapshot_as_of(db, dash)
    ttl = _resolve_public_snapshot_ttl(appearance)
    return {
        "as_of": ts.isoformat() if ts else None,
        "mode": "snapshot" if ts else "live",
        "stale": snapshot_service.is_stale(ts, ttl),
    }


@router.get("/dashboards/{token}/filters/distinct-values")
@_limiter.limit("30/minute")
def get_public_filter_distinct_values(
    token: str,
    request: Request,
    dataset_id: int = Query(..., ge=1),
    field: str = Query(..., description="Qualified field name, e.g. orders.country"),
    limit: int = Query(200, ge=1, le=1000, description="Page size (values returned)."),
    offset: int = Query(0, ge=0, description="Page offset into the (searched) distinct set."),
    search: str | None = Query(
        default=None,
        description="Case-insensitive substring; server-side search over the cached full distinct set (no per-keystroke warehouse query).",
    ),
    filters: str | None = Query(
        default=None,
        description="JSON-encoded list of additional viewer filter objects.",
    ),
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    dash, public_filters, _, _distinct_appearance = _get_dashboard_by_token(
        token,
        db,
        session_token=x_public_session,
        track_access=False,
    )

    # Match the allow-list exposed by GET /public/dashboards/{token}. For a
    # multi-link token, `public_filters` is the link's hidden/locked constraint
    # set; it must constrain the data query below, not replace the viewer-facing
    # filter inventory.
    _strip_link_managed_filter_fields(dash, public_filters)
    public_filter_fields = _build_public_filter_fields(
        db,
        dash,
        _public_viewer_filter_inventory(dash),
    )
    allowed_field = next(
        (
            item for item in public_filter_fields
            if item.get("datasetId") == dataset_id and item.get("semanticField") == field
        ),
        None,
    )
    if not allowed_field:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Filter field is not available for this shared dashboard.",
        )

    viewer_filters: list[dict] = []
    if filters:
        try:
            parsed_filters = json.loads(filters)
            if not isinstance(parsed_filters, list):
                raise ValueError("filters must be a JSON array")
            viewer_filters = [item for item in parsed_filters if isinstance(item, dict)]
        except (json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid filters parameter: {exc}",
            ) from exc

    sanitized_viewer_filters = _sanitize_public_viewer_filters(
        public_filter_fields,
        dataset_id,
        viewer_filters,
    )

    combined_filters = _build_public_chart_filters(
        dash,
        public_filters,
        sanitized_viewer_filters,
        context_for_log=f"distinct_values:{token}:{dataset_id}:{field}",
    )

    try:
        # Fetch the FULL searched set (server-side search over the cached full
        # distinct list — no per-keystroke warehouse query), then apply the
        # per-link scope allow-list, THEN paginate. Order matters: scope_allow
        # must bound BEFORE pagination so total/has_more reflect the allowed set.
        result = get_distinct_field_values(
            db,
            dataset_id,
            field,
            limit=_DISTINCT_FETCH_CEILING,
            offset=0,
            search=search,
            filters=combined_filters,
            snapshot_ttl_minutes=_resolve_public_snapshot_ttl(_distinct_appearance),
        )
        values = result.get("values", [])
        # PBI-parity (core): a slicer's dropdown cascades STRICTLY by the other
        # active filters (page-filters + sibling slicers), same as the builder.
        # When the cascade legitimately yields no rows we return the EMPTY list
        # and let the FE surface a clear "No values match the active filter"
        # message (via distinctStatus) — we do NOT relax the cascade and show
        # the full domain. Showing "all" on an empty cascade violates the core
        # filter contract (`applyScopeBound`: "never escape, never show 'all'")
        # and reads to the DA as "the slicer isn't limited by my other filters".
        # If this field is under a per-link 'limit' allow-list, the slicer
        # stays interactive but its dropdown must offer ONLY the allowed
        # subset. get_distinct_field_values self-strips the dropdown's own
        # filter (so the cascade can't pin it), which also drops the scope —
        # so bound the returned values to the allow-list here.
        scope_allow = _link_scope_allowlist_for_field(public_filters, dataset_id, field)
        if scope_allow is not None:
            allow_set = {str(v) for v in scope_allow}
            values = [v for v in values if str(v) in allow_set]
        total = len(values)
        page = values[offset:offset + limit]
        return {
            "field": field,
            "values": page,
            "total": total,
            "has_more": (offset + limit) < total,
            "dropped_filters": result.get("dropped_filters", []),
        }
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        logger.error(f"Public distinct values error for token={token} dataset={dataset_id} field={field}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load distinct values.",
        )


@router.get("/dashboards/{token}/charts/{chart_id}/data", response_model=ChartDataResponse)
# Each dashboard page load fires one request per chart tile in parallel
# (easily 15â€“20 for an HTML-imported dashboard), plus re-fetches on every
# filter/page change. The previous 30/min ceiling was trivial to exceed
# for a single honest viewer, so keep it generous but still enough to
# block automated scraping.
@_limiter.limit("300/minute")
def get_public_chart_data(
    token: str,
    chart_id: int,
    request: Request,
    filters: str | None = Query(
        default=None,
        description="JSON-encoded list of additional viewer filter objects.",
    ),
    granularity: str | None = Query(
        default=None,
        description="#2 viewer date-hierarchy: re-bucket the time axis (raw|day|week|month|quarter|year).",
    ),
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Return chart data for a public shared link.

    Validates that chart_id belongs to the shared dashboard so a stray token
    cannot be used to access arbitrary charts.
    Password-protected links require X-Public-Session header from /auth.
    """
    dash, public_filters, _, _chart_appearance = _get_dashboard_by_token(
        token,
        db,
        session_token=x_public_session,
        track_access=False,
    )

    # Confirm the chart belongs to this dashboard
    link = (
        db.query(DashboardChart)
        .filter(
            DashboardChart.dashboard_id == dash.id,
            DashboardChart.chart_id == chart_id,
        )
        .first()
    )
    if not link:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Chart not found in this shared dashboard.",
        )

    viewer_filters: list[dict] = []
    if filters:
        try:
            parsed_filters = json.loads(filters)
            if not isinstance(parsed_filters, list):
                raise ValueError("filters must be a JSON array")
            viewer_filters = [item for item in parsed_filters if isinstance(item, dict)]
        except (json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid filters parameter: {exc}",
            ) from exc

    combined_filters = _build_public_chart_filters(
        dash,
        public_filters,
        viewer_filters,
        context_for_log=f"chart_data:{token}:{chart_id}",
    )

    # #2 — viewer date-hierarchy drill grain (validate against a whitelist;
    # unknown values are ignored so a stray param can't break the query).
    _grain = str(granularity or "").strip().lower()
    granularity_override = _grain if _grain in {"raw", "day", "week", "month", "quarter", "year"} else None

    try:
        return ChartService.get_chart_data(
            db,
            chart_id,
            extra_filters=combined_filters or None,
            filter_context="dashboard",
            granularity_override=granularity_override,
            snapshot_ttl_minutes=_resolve_public_snapshot_ttl(_chart_appearance),
        )
    except ValueError as exc:
        # Phase-12.7: previously this swallowed the engine's Vietnamese
        # message ("Bảng X chưa có relationship..." etc.) and returned a
        # generic "Chart data not found." 404 — making DAs sharing a
        # dashboard think the chart was missing rather than mis-
        # configured. Forward the message verbatim with the right status.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )
    except Exception as exc:
        logger.exception("Public chart data error for token=%s chart=%s", token, chart_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load chart data.",
        )


class _PublicChartsBatchItem(BaseModel):
    chart_id: int
    # Viewer filters for THIS chart (already scope-bounded + cross-filter-merged
    # by the FE, exactly like the single-chart endpoint's `filters` query param).
    filters: list[dict] | None = None
    granularity: str | None = None


class _PublicChartsBatchBody(BaseModel):
    items: list[_PublicChartsBatchItem]


@router.post("/dashboards/{token}/charts/data")
# "1 request = 1 page": one open/page-switch now sends ONE request for all its
# tiles instead of N. Kept generous but bounded (a viewer flips pages a handful
# of times per minute; each is one call here regardless of tile count).
@_limiter.limit("120/minute")
def get_public_charts_data_batch(
    token: str,
    request: Request,
    body: _PublicChartsBatchBody,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Batch chart-data for a public link — the server side of "1 request = 1
    page". Resolves the dashboard + link filters + snapshot TTL ONCE (vs once
    per tile before), then fans the charts out server-side via
    ``ChartService.get_charts_data_batch`` (own session/thread each). Returns
    per-chart ``{chart_id, data | error, status}``; a bad/unauthorised-to-this-
    dashboard tile is isolated and never fails the whole page. Each chart uses
    the SAME merge + engine path as the single-chart endpoint, so results are
    byte-identical."""
    dash, public_filters, _, _chart_appearance = _get_dashboard_by_token(
        token, db, session_token=x_public_session, track_access=False,
    )
    ttl = _resolve_public_snapshot_ttl(_chart_appearance)
    valid_ids = {dc.chart_id for dc in (dash.dashboard_charts or []) if dc.chart_id}

    items: list[dict] = []
    not_found: list[int] = []
    seen: set[int] = set()
    for it in body.items:
        cid = int(it.chart_id)
        if cid in seen:
            continue
        seen.add(cid)
        if cid not in valid_ids:
            not_found.append(cid)
            continue
        viewer_filters = [f for f in (it.filters or []) if isinstance(f, dict)]
        combined_filters = _build_public_chart_filters(
            dash, public_filters, viewer_filters,
            context_for_log=f"chart_data_batch:{token}:{cid}",
        )
        _grain = str(it.granularity or "").strip().lower()
        grain = _grain if _grain in {"raw", "day", "week", "month", "quarter", "year"} else None
        items.append({
            "chart_id": cid,
            "extra_filters": combined_filters or None,
            "filter_context": "dashboard",
            "granularity_override": grain,
            "snapshot_ttl_minutes": ttl,
        })

    # Serialize INSIDE each worker thread (session still open) so the Chart ORM
    # in the result is copied into ChartDataResponse before the session closes —
    # otherwise the request thread hits DetachedInstanceError on lazy attributes.
    raw_results = ChartService.get_charts_data_batch(
        items, serialize=lambda d: ChartDataResponse(**d),
    )

    results: list[dict] = []
    for r in raw_results:
        if r.get("ok"):
            results.append({"chart_id": r["chart_id"], "data": r["data"]})
        else:
            results.append({
                "chart_id": r["chart_id"],
                "error": r.get("error"),
                "status": r.get("status", 500),
            })
    for cid in not_found:
        results.append({
            "chart_id": cid,
            "error": "Chart not found in this shared dashboard.",
            "status": 404,
        })
    return {"results": results}


# â”€â”€ Agentic AI Bot endpoints (v2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
#
# These endpoints back the agentic flow built in
# ``app.services.dashboard_ai_bot``. The frontend uses ``/ai/recon`` +
# ``/ai/agent/chat`` (plus the briefing + session endpoints). The earlier
# non-agentic ``/ai/context`` + ``/ai/chat`` pair (service
# ``dashboard_ai_service``) was removed — no client referenced it.
#
# SSE wire format (NEW): every line is a JSON envelope so the client can
# distinguish text deltas from tool status updates from errors.
#   data: {"type":"text","text":"..."}\n\n
#   data: {"type":"status","text":"...","tool":"..."}\n\n
#   data: {"type":"tool_result","tool":"...","ok":true}\n\n
#   data: {"type":"error","text":"..."}\n\n
#   data: {"type":"done"}\n\n


# ── Server-side PDF export ───────────────────────────────────────────────────
#
# The browser used to build the PDF itself: minutes of work on the viewer's
# machine, dead if the tab closed, impossible to schedule or audit. These
# endpoints record the request as a job; the `pdf-worker` container renders it
# with headless Chromium and stores the file. The frontend polls status and then
# downloads through a secret-bearing URL.
#
# When no worker is deployed, /exports/capabilities reports the engine as
# unavailable and the frontend transparently keeps using the in-browser
# exporter — a stack without the worker behaves exactly as before.


class _ExportCreateBody(BaseModel):
    # Dashboard page ids to include, in order. Empty → the whole report.
    pages: list[str] | None = None
    orientation: str | None = "landscape"
    page_format: str | None = "a4"
    layout: str | None = "tiled"
    # The viewer's slicer selections at click time, so the rendered PDF is the
    # slice they were looking at (the render page re-applies them).
    filters: list[dict] | None = None
    # Session token for a password-protected link — the worker must be able to
    # open the same protected view the requester can.
    session: str | None = None


@router.get("/dashboards/{token}/exports/capabilities")
@_limiter.limit("60/minute")
def get_public_export_capabilities(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Does this deployment have a render worker? Drives engine selection in the UI."""
    _get_dashboard_by_token(token, db, session_token=x_public_session, track_access=False)
    return {
        "server_engine": pdf_export_service.engine_available(),
        "max_pages_per_hour": settings.PDF_QUOTA_PER_LINK_HOUR,
    }


@router.post("/dashboards/{token}/exports", status_code=status.HTTP_202_ACCEPTED)
@_limiter.limit("30/minute")
def create_public_export_job(
    token: str,
    request: Request,
    body: _ExportCreateBody,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Queue a server-side PDF render for this shared link."""
    if not pdf_export_service.engine_available():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Server-side PDF export is not enabled on this deployment.",
        )
    dash, _public_filters, _link, _appearance = _get_dashboard_by_token(
        token, db, session_token=x_public_session, track_access=False,
    )
    # Denormalise what the worker needs for the running header/footer so it never
    # has to re-resolve the dashboard: page names, report title, provenance line
    # and the download filename all travel with the job.
    pages_config = dash.pages_config if isinstance(dash.pages_config, list) else []
    page_names = {
        str(pc.get("id")): str(pc.get("name") or "")
        for pc in pages_config
        if isinstance(pc, dict) and pc.get("id")
    }
    report_title = str(getattr(dash, "public_link_name", None) or dash.name or "Báo cáo")
    exported_at = datetime.now(timezone.utc).astimezone().strftime("%d/%m/%Y %H:%M")
    params = {
        "title": report_title,
        "subtitle": f"Xuất lúc {exported_at}",
        "page_names": page_names,
        "filename": f"{report_title}.pdf",
        "pages": [str(p) for p in (body.pages or [])],
        "orientation": "portrait" if str(body.orientation or "").lower() == "portrait" else "landscape",
        "format": (body.page_format or "a4").lower() if (body.page_format or "a4").lower() in {"a4", "a3", "letter"} else "a4",
        "layout": "single" if str(body.layout or "").lower() == "single" else "tiled",
        "filters": [f for f in (body.filters or []) if isinstance(f, dict)],
        "surface": "public",
        "session": body.session or x_public_session or None,
    }
    try:
        job = pdf_export_service.create_job(
            db,
            dashboard_id=dash.id,
            params=params,
            link_token=token,
            requester_ip=get_remote_address(request),
        )
    except pdf_export_service.ExportQuotaExceeded as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Đã vượt giới hạn {exc.limit} lượt xuất PDF mỗi giờ cho link này. Vui lòng thử lại sau.",
        ) from exc
    return pdf_export_service.job_to_dict(job)


def _load_public_job(token: str, job_id: str, db: Session):
    try:
        parsed = _uuid.UUID(str(job_id))
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Export job not found.")
    job = pdf_export_service.get_job(db, parsed)
    # Scope the job to the link that created it: a token holder can only ever
    # see their own link's exports, never another share's.
    if job is None or job.link_token != token:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Export job not found.")
    return job


@router.get("/dashboards/{token}/exports/{job_id}")
@_limiter.limit("600/minute")
def get_public_export_job(
    token: str,
    job_id: str,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Poll one job. Rate limit is generous — this is a 1s progress poll."""
    _get_dashboard_by_token(token, db, session_token=x_public_session, track_access=False)
    return pdf_export_service.job_to_dict(_load_public_job(token, job_id, db))


@router.post("/dashboards/{token}/exports/{job_id}/cancel")
@_limiter.limit("60/minute")
def cancel_public_export_job(
    token: str,
    job_id: str,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Viewer pressed Stop / closed the dialog — free the worker."""
    _get_dashboard_by_token(token, db, session_token=x_public_session, track_access=False)
    job = _load_public_job(token, job_id, db)
    return pdf_export_service.job_to_dict(pdf_export_service.cancel_job(db, job))


@router.get("/dashboards/{token}/exports/{job_id}/download")
@_limiter.limit("60/minute")
def download_public_export(
    token: str,
    job_id: str,
    request: Request,
    dl: str = Query(..., description="download_secret returned with the finished job"),
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Stream the rendered PDF. Requires the job's own random secret, so a
    guessed job id alone never yields the bytes."""
    _get_dashboard_by_token(token, db, session_token=x_public_session, track_access=False)
    job = _load_public_job(token, job_id, db)
    if not pdf_export_service.verify_download_secret(job, dl):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid download token.")
    if not pdf_export_service.download_ready(job):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Export file is no longer available.")
    filename = str((job.params or {}).get("filename") or "bao-cao.pdf")
    return FileResponse(
        job.file_path,
        media_type="application/pdf",
        filename=filename if filename.lower().endswith(".pdf") else f"{filename}.pdf",
    )


@router.get("/dashboards/{token}/ai/recon")
@_limiter.limit("20/minute")
def get_dashboard_ai_recon(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Proactive recon: chart manifest + Insight Packs for the first few charts.

    Frontend calls this once when the bot opens to render a "what's notable"
    welcome message and to seed suggested questions. No LLM call here.
    """
    from app.services.dashboard_ai_bot.thinking.agent import (
        build_proactive_recon_cached as build_proactive_recon,  # Phase 16.1 — TTL cache
    )
    from app.services.dashboard_ai_bot.tool_context import ToolContext

    dash, public_filters, _, appearance_config = _get_dashboard_by_token(
        token, db, session_token=x_public_session, track_access=False,
    )
    if not (appearance_config or {}).get("ai_bot_enabled"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="AI bot is not enabled for this shared link.",
        )

    try:
        # Route link filters through the SAME merge every other public surface
        # uses, so recon sees dashboard filter-pane + slicer defaults + link
        # locks (and empty/hidden entries are normalized) — never the raw,
        # un-merged link.filters_config. Closes the AI-bypass drift; matches
        # the chat/briefing endpoints which already merge.
        combined_filters = _build_public_chart_filters(
            dash, public_filters, [], context_for_log="ai_recon",
        )
        ctx = ToolContext.from_dashboard(db=db, dashboard=dash, public_filters=combined_filters)
        recon = build_proactive_recon(ctx)
    except Exception:
        logger.exception("AI recon build error for token=%s", token)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to build AI recon.",
        )

    import json
    from datetime import date, datetime
    from decimal import Decimal

    def _default(obj):
        if isinstance(obj, (date, datetime)):
            return obj.isoformat()
        # Postgres NUMERIC / aggregated measure values come back as Decimal,
        # which the stdlib JSON encoder can't serialize — coerce to float so the
        # proactive-recon Insight Packs render instead of 500-ing the bot open.
        if isinstance(obj, Decimal):
            return float(obj)
        raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")

    from fastapi.responses import Response
    return Response(
        content=json.dumps(recon, default=_default),
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


class _AiAgentChatBody(BaseModel):
    messages: list[dict]
    # Phase A â€” confirmed user briefing (domain, role, focus, timeframe).
    # Optional: if missing, agent runs without briefing customisation.
    briefing: dict | None = None
    # Phase B â€” conversation state from previous turns. Optional first turn.
    state: dict | None = None
    # Viewer-applied slicer filters (currently set on the dashboard UI). When
    # present, merged with the link's DA-defined public filters so the agent's
    # tool calls see exactly what the dashboard is rendering. Without this the
    # bot is blind to live slicer changes â€” it would answer with un-filtered
    # numbers while the user is looking at a filtered view.
    viewer_filters: list[dict] | None = None
    # Browser-tab session id (localStorage UUID) so per-turn telemetry rows
    # can be tied back to a conversation for later cost/UX analysis.
    session_key: str | None = None


class _AiBriefingGuessQuery(BaseModel):
    pass  # currently no body, just GET


class _AiBriefingBriefBody(BaseModel):
    """Confirmed briefing â€” backend uses it (+ recon) to call BYOK LLM and
    produce an Executive Brief paragraph.
    """
    briefing: dict
    # Same purpose as on _AiAgentChatBody: viewer slicer state so the recon
    # snapshot reflects the dashboard the user is actually looking at.
    viewer_filters: list[dict] | None = None


@router.get("/dashboards/{token}/ai/briefing/guess")
@_limiter.limit("20/minute")
def get_dashboard_ai_briefing_guess(
    token: str,
    request: Request,
    filters: str | None = Query(
        default=None,
        description="JSON-encoded list of viewer-applied slicer filter objects.",
    ),
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Heuristic guess of the dashboard's domain, role audience, and key
    metrics. The frontend wizard renders this as Step 1 (confirm/correct).
    No LLM call.
    """
    from app.services.dashboard_ai_bot.thinking.agent import (
        build_proactive_recon_cached as build_proactive_recon,  # Phase 16.1 — TTL cache
    )
    from app.services.dashboard_ai_bot.thinking.briefing import guess_briefing_from_recon
    from app.services.dashboard_ai_bot.tool_context import ToolContext

    dash, public_filters, _, appearance_config = _get_dashboard_by_token(
        token, db, session_token=x_public_session, track_access=False,
    )
    if not (appearance_config or {}).get("ai_bot_enabled"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="AI bot is not enabled for this shared link.",
        )

    viewer_filters: list[dict] = []
    if filters:
        try:
            parsed = json.loads(filters)
            if not isinstance(parsed, list):
                raise ValueError("filters must be a JSON array")
            viewer_filters = [item for item in parsed if isinstance(item, dict)]
        except (json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid filters parameter: {exc}",
            ) from exc

    combined_filters = _build_public_chart_filters(
        dash,
        public_filters,
        viewer_filters,
        context_for_log=f"ai_bot:{token}",
    )

    try:
        ctx = ToolContext.from_dashboard(db=db, dashboard=dash, public_filters=combined_filters)
        recon = build_proactive_recon(ctx)
        guess = guess_briefing_from_recon(
            recon,
            dashboard_name=dash.name or "",
            dashboard_description=getattr(dash, "description", "") or "",
        )
    except Exception:
        logger.exception("AI briefing guess error for token=%s", token)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to build AI briefing guess.",
        )

    from datetime import date, datetime as _dt

    def _default(obj):
        if isinstance(obj, (date, _dt)):
            return obj.isoformat()
        raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")

    return Response(
        content=json.dumps(guess, default=_default),
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/dashboards/{token}/ai/briefing/brief")
@_limiter.limit("10/minute")
async def post_dashboard_ai_briefing_brief(
    token: str,
    body: _AiBriefingBriefBody,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
    x_user_ai_key: str | None = Header(default=None),
    x_user_ai_provider: str | None = Header(default=None),
    x_user_ai_model: str | None = Header(default=None),
):
    """Generate an Executive Brief paragraph using the user's confirmed
    briefing + the dashboard recon. Streams text via SSE.
    """
    import json as _json
    from fastapi.responses import StreamingResponse
    from app.services.dashboard_ai_bot.thinking.agent import (
        build_proactive_recon_cached as build_proactive_recon,  # Phase 16.1 — TTL cache
    )
    from app.services.dashboard_ai_bot.thinking.briefing import (
        Briefing,
        EXEC_BRIEF_SYSTEM_PROMPT,
        build_executive_brief_user_prompt,
    )
    from app.services.dashboard_ai_bot.providers import (
        stream_anthropic, stream_gemini_singleshot, stream_openai,
    )
    from app.services.dashboard_ai_bot.tool_context import ToolContext

    dash, public_filters, _, appearance_config = _get_dashboard_by_token(
        token, db, session_token=x_public_session, track_access=False,
    )
    if not (appearance_config or {}).get("ai_bot_enabled"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="AI bot is not enabled for this shared link.",
        )
    effective_key, provider, model = resolve_public_ai_credentials(
        appearance_config,
        x_user_ai_key=x_user_ai_key,
        x_user_ai_provider=x_user_ai_provider,
        x_user_ai_model=x_user_ai_model,
        missing_key_detail="X-User-Ai-Key header is required.",
    )

    briefing = Briefing.from_dict(body.briefing or {})
    briefing.confirmed = True

    viewer_filters_body = body.viewer_filters if isinstance(body.viewer_filters, list) else []
    combined_filters = _build_public_chart_filters(
        dash,
        public_filters,
        [item for item in viewer_filters_body if isinstance(item, dict)],
        context_for_log=f"ai_bot_briefing:{token}",
    )
    ctx = ToolContext.from_dashboard(db=db, dashboard=dash, public_filters=combined_filters)
    recon = build_proactive_recon(ctx)
    user_prompt = build_executive_brief_user_prompt(
        briefing=briefing,
        recon=recon,
        report_context_note=sanitize_report_context_note(
            (appearance_config or {}).get("ai_bot_report_context_note"),
        ),
    )

    if provider == "anthropic":
        streamer = stream_anthropic
    elif provider == "openai":
        streamer = stream_openai
    else:
        streamer = stream_gemini_singleshot

    captured_key = effective_key

    async def sse_stream():
        try:
            async for ev in streamer(
                api_key=captured_key,
                system_prompt=EXEC_BRIEF_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_prompt}],
                tools=None,
                model=model or None,
            ):
                envelope = _event_to_envelope(ev)
                if envelope is None:
                    continue
                yield f"data: {_json.dumps(envelope, ensure_ascii=False, default=str)}\n\n"
        except Exception as exc:
            logger.exception("AI briefing brief streaming failed")
            yield f"data: {_json.dumps({'type':'error','text':f'Brief failed: {type(exc).__name__}'})}\n\n"
        finally:
            yield f"data: {_json.dumps({'type':'done'})}\n\n"

    return StreamingResponse(
        sse_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# â”€â”€ AI Chat Session persistence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@router.get("/dashboards/{token}/ai/session/{session_key}")
async def load_ai_chat_session(
    token: str,
    session_key: str,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Load a persisted chat session by session_key.

    Returns 404 when no session exists yet â€” the frontend treats this as a
    fresh conversation.  The public-link auth check ensures the viewer is
    allowed to see this dashboard before returning any messages.
    """
    # Verify the token is valid (raises 404/401 otherwise)
    _get_dashboard_by_token(token, db, session_token=x_public_session, track_access=False)

    from app.models.ai_chat_session import AiChatSession
    session_key = session_key.strip()
    if len(session_key) > 64 or not session_key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid session_key.")
    row = db.query(AiChatSession).filter(
        AiChatSession.token == token,
        AiChatSession.session_key == session_key,
    ).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found.")
    return {
        "session_key": row.session_key,
        "provider": row.provider,
        "model": row.model,
        "messages": row.messages or [],
        "briefing": row.briefing,
        "conv_state": row.conv_state,
        "turn_count": row.turn_count,
        "prompt_tokens": row.prompt_tokens,
        "completion_tokens": row.completion_tokens,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.put("/dashboards/{token}/ai/session/{session_key}")
@_limiter.limit("60/minute")
async def save_ai_chat_session(
    token: str,
    session_key: str,
    body: AiChatSessionSave,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Create or update a chat session (upsert by session_key).

    Called by the frontend after every completed turn and whenever the
    briefing changes.  Rate-limited to 60/min which is generous for
    human conversation cadence.
    """
    from app.models.ai_chat_session import AiChatSession
    from datetime import datetime

    _dash_for_kb, _pf_kb, _z_kb, _ap_kb = _get_dashboard_by_token(
        token, db, session_token=x_public_session, track_access=False,
    )

    session_key = session_key.strip()
    if len(session_key) > 64 or not session_key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid session_key.")

    # Sanitize messages: keep only role/content/rating, drop tool internals
    safe_messages = []
    for msg in (body.messages or []):
        role = (msg.get("role") or "")
        content = msg.get("content") or ""
        if role in ("user", "assistant") and isinstance(content, str):
            entry: dict = {"role": role, "content": content}
            rating = msg.get("rating")
            if rating in ("up", "down"):
                entry["rating"] = rating
            safe_messages.append(entry)

    row = db.query(AiChatSession).filter(
        AiChatSession.token == token,
        AiChatSession.session_key == session_key,
    ).first()

    if row is None:
        row = AiChatSession(
            token=token,
            session_key=session_key,
        )
        db.add(row)

    row.provider = (body.provider or "")[:20] or None
    row.model = (body.model or "")[:120] or None
    row.messages = safe_messages
    row.briefing = body.briefing
    row.conv_state = body.conv_state
    row.turn_count = max(0, body.turn_count)
    row.prompt_tokens = max(0, body.prompt_tokens)
    row.completion_tokens = max(0, body.completion_tokens)
    row.updated_at = datetime.utcnow()

    db.commit()

    # ── Learning capture (institutional memory) ─────────────────────────────
    # Distil THIS turn's high-confidence findings into the company knowledge
    # base and fold in any thumbs up/down. Best-effort — never break a save.
    try:
        from app.services.dashboard_ai_bot import knowledge as _kb
        dash_id = getattr(_dash_for_kb, "id", None)
        if isinstance(dash_id, int):
            cs = body.conv_state if isinstance(body.conv_state, dict) else {}
            all_findings = cs.get("findings") if isinstance(cs.get("findings"), list) else []
            cur_turn = cs.get("turn_index")
            # Only THIS turn's findings, so cumulative state doesn't re-inflate
            # support_count on every save.
            findings = [
                f for f in all_findings
                if not isinstance(cur_turn, int) or f.get("turn_index") == cur_turn
            ]
            last_rating = None
            for m in reversed(safe_messages):
                if m.get("role") == "assistant":
                    last_rating = m.get("rating")
                    break
            _kb.capture_findings(
                db, dashboard_id=dash_id, findings=findings,
                rated_down=(last_rating == "down"),
            )
            for m in safe_messages:
                if m.get("role") == "assistant" and m.get("rating") in ("up", "down"):
                    _kb.apply_feedback(
                        db, dashboard_id=dash_id,
                        claim_text=str(m.get("content") or ""),
                        positive=(m.get("rating") == "up"),
                    )
            db.commit()
    except Exception:
        logger.warning("ai knowledge capture failed", exc_info=True)
        db.rollback()

    return {"ok": True}


@router.post("/dashboards/{token}/ai/session/{session_key}/clear")
async def clear_ai_chat_session(
    token: str,
    session_key: str,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Clear a chat session's messages/state while keeping the session_key.

    Used when the viewer clicks "XÃ³a lá»‹ch sá»­".
    """
    from app.models.ai_chat_session import AiChatSession
    from datetime import datetime

    _get_dashboard_by_token(token, db, session_token=x_public_session, track_access=False)
    session_key = session_key.strip()
    row = db.query(AiChatSession).filter(
        AiChatSession.token == token,
        AiChatSession.session_key == session_key,
    ).first()
    if row:
        row.messages = []
        row.briefing = None
        row.conv_state = None
        row.turn_count = 0
        row.updated_at = datetime.utcnow()
        db.commit()
    return {"ok": True}


# ── AI bot institutional memory (learned company knowledge) ──────────────────

@router.post("/dashboards/{token}/ai/agent/chat")
@_limiter.limit("20/minute")
async def chat_dashboard_ai_agent(
    token: str,
    body: _AiAgentChatBody,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
    x_user_ai_key: str | None = Header(default=None),
    x_user_ai_provider: str | None = Header(default=None),
    x_user_ai_model: str | None = Header(default=None),
    x_user_ai_mode: str | None = Header(default=None, alias="X-User-Ai-Mode"),
    x_user_ai_intent: str | None = Header(default=None, alias="X-User-Ai-Intent"),
):
    """Run an agentic chat turn. Streams typed SSE events.

    Honors the dashboard's public filters automatically â€” every tool the
    agent calls applies the same filters the dashboard is currently showing.
    """
    import json as _json
    from fastapi.responses import StreamingResponse
    from app.services.dashboard_ai_bot import run_agent_stream
    from app.services.dashboard_ai_bot.tool_context import ToolContext

    dash, public_filters, _, appearance_config = _get_dashboard_by_token(
        token, db, session_token=x_public_session, track_access=False,
    )
    if not (appearance_config or {}).get("ai_bot_enabled"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="AI bot is not enabled for this shared link.",
        )

    effective_key, provider, model = resolve_public_ai_credentials(
        appearance_config,
        x_user_ai_key=x_user_ai_key,
        x_user_ai_provider=x_user_ai_provider,
        x_user_ai_model=x_user_ai_model,
        missing_key_detail="X-User-Ai-Key header is required for AI chat.",
    )
    critique_enabled_flag = resolve_public_ai_critique_enabled(appearance_config)
    effective_mode = resolve_public_ai_mode(appearance_config, x_user_ai_mode=x_user_ai_mode)
    web_search_flag = web_search_enabled(appearance_config)

    # Guide mode ("Hướng dẫn xem báo cáo") — teach a NEW viewer how to READ this
    # report, step by step, in plain language. Appended to the report system
    # prompt only for this intent so the bot acts like a patient instructor.
    report_note = sanitize_report_context_note(
        (appearance_config or {}).get("ai_bot_report_context_note"),
    )
    if (x_user_ai_intent or "").strip().lower() == "guide":
        report_note = (
            report_note
            + "\n\n═══ CHẾ ĐỘ HƯỚNG DẪN (dạy người MỚI đọc báo cáo, theo 3 CẤP) ═══\n"
            + "Bạn là người hướng dẫn kiên nhẫn. Đi theo 3 cấp, MỖI LƯỢT chỉ làm MỘT cấp, "
            + "giọng đơn giản dễ hiểu. Luôn gọi `list_charts` để lấy đúng tên trang/biểu đồ + "
            + "trường `pages` (flow) và `related` (biểu đồ dùng chung measure). KHÔNG bịa tên.\n\n"
            + "• CẤP 1 — BẢN ĐỒ TỔNG QUAN (lượt ĐẦU TIÊN): vẽ bức tranh TOÀN báo cáo — liệt kê "
            + "TẤT CẢ các trang theo thứ tự, mỗi trang 1-2 câu (trang đó gồm biểu đồ gì, cho biết "
            + "điều gì). CHƯA đào số liệu. Kết thúc, mời chọn và phát MỖI TRANG một dòng:\n"
            + "    [FOLLOWUP] Đi sâu trang: <tên trang>\n"
            + "  (Người xem có thể bấm chip, hoặc tự gõ tên trang/biểu đồ — đều nhận.)\n\n"
            + "• CẤP 2 — MỘT TRANG: khi người xem chọn/gõ một trang, giới thiệu NGẮN các biểu đồ "
            + "trên trang đó (mỗi cái cho biết gì, chưa đào số). Kết thúc, phát MỖI BIỂU ĐỒ một dòng:\n"
            + "    [FOLLOWUP] Giải thích chi tiết: <tên biểu đồ>\n\n"
            + "• CẤP 3 — MỘT BIỂU ĐỒ (đào sâu): gọi `get_chart_summary` (và `get_chart_glossary` nếu cần) rồi:\n"
            + "    1) Giải thích CÁCH RA CON SỐ: đo lường nào, phép tính gì (tổng/trung bình/đếm…), "
            + "gom theo chiều nào, lọc gì — đơn giản, KÈM VÍ DỤ SỐ cụ thể từ chính báo cáo "
            + "(vd: 'Doanh thu Core = tổng cột amount của các dòng tier=Core = 10,389,059').\n"
            + "    2) Cuối cùng, phát các BIỂU ĐỒ LIÊN QUAN lấy từ trường `related` trong KẾT QUẢ "
            + "`get_chart_summary` của biểu đồ đó (dùng chung measure) — nếu danh sách `related` rỗng "
            + "thì bỏ qua, đừng bịa. Mỗi cái một dòng để người xem xem nhanh, không đứt mạch:\n"
            + "    [FOLLOWUP] Xem biểu đồ liên quan: <tên biểu đồ>\n\n"
            + "Mỗi lượt vẫn kết bằng một câu mời tiếp tục thân thiện."
        ).strip()

    messages = body.messages or []
    if not messages:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="messages is required.")

    # Sanitize: strip any tool/assistant turns referencing chart_ids outside
    # this dashboard (defensive â€” clients shouldn't send these but we guard).
    allowed_chart_ids = {dc.chart_id for dc in (dash.dashboard_charts or []) if dc.chart_id}
    safe_messages: list[dict] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role not in ("user", "assistant", "tool"):
            continue
        # For previous tool turns the FE shouldn't be sending raw tool history
        # back; we accept user/assistant text only from the wire and let the
        # agent rebuild the tool log fresh each turn.
        if role == "tool":
            continue
        out: dict = {"role": role}
        content = msg.get("content")
        if content is not None:
            out["content"] = str(content)
        # Drop any tool_calls echoed back â€” agent treats turns as fresh
        safe_messages.append(out)

    if not safe_messages:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No valid messages.")

    captured_key = effective_key
    # Merge link-level public filters with viewer-applied slicer filters
    # from the dashboard UI through the shared layered-merge helper.
    viewer_filters_body = body.viewer_filters if isinstance(body.viewer_filters, list) else []
    combined_filters = _build_public_chart_filters(
        dash,
        public_filters,
        [item for item in viewer_filters_body if isinstance(item, dict)],
        context_for_log=f"ai_bot_chat_extra:{token}",
    )
    ctx = ToolContext.from_dashboard(db=db, dashboard=dash, public_filters=combined_filters)

    # Phase A + B: parse briefing + state, default-construct if missing.
    from app.services.dashboard_ai_bot.thinking.briefing import Briefing as _Briefing
    from app.services.dashboard_ai_bot.thinking.conversation_state import ConversationState as _ConvState
    briefing_obj = _Briefing.from_dict(body.briefing or {}) if body.briefing else None
    state_obj = _ConvState.from_dict(body.state or {}) if body.state is not None else _ConvState()
    # Briefing on the state may be older than what FE sent â€” sync to caller's
    # current briefing so role/focus changes take effect immediately.
    if briefing_obj is not None:
        state_obj.briefing = briefing_obj

    # Phase 15.77 — Normal/Thinking dispatch. The chat UI's toggle
    # comes through as X-User-Ai-Mode header; the dispatcher routes
    # to dashboard_ai_bot/normal or dashboard_ai_bot/thinking and
    # silently strips kwargs the normal variant doesn't accept
    # (briefing, state).
    async def sse_stream():
        import asyncio
        # Watchdog: a turn must never strand the UI on "Thinking…". If no event
        # arrives for IDLE_TIMEOUT (a tool/LLM/proxy stall) or the whole turn
        # exceeds HARD_TIMEOUT, emit a terminal error+done so the client can
        # recover (show Retry) instead of hanging forever.
        IDLE_TIMEOUT = 60.0
        HARD_TIMEOUT = 240.0
        loop = asyncio.get_event_loop()
        started = loop.time()
        # Knowledge grounding — GENERIC, data-driven. Assembles whatever a
        # business has AUTHORED for this dashboard's datasets (Govern glossary,
        # data dictionary, semantic descriptions, aliases) PLUS institutional
        # memory, and injects it so the bot reasons from authored definitions
        # instead of guessing from column names. Zero per-report logic; empty
        # (ungrounded fallback) when nothing is authored. Best-effort.
        learned_block = ""
        try:
            from app.services.dashboard_ai_bot import knowledge_context as _kc
            _last_q = ""
            for _m in reversed(safe_messages):
                if _m.get("role") == "user":
                    _last_q = str(_m.get("content") or "")
                    break
            learned_block = _kc.build_knowledge_context_block(
                db, dashboard_id=dash.id, question=_last_q,
            )
        except Exception:
            logger.warning("ai knowledge context build failed", exc_info=True)

        agen = run_agent_stream(
            mode=effective_mode,
            ctx=ctx,
            user_messages=safe_messages,
            api_key=captured_key,
            provider=provider,
            model=model,
            briefing=briefing_obj,
            state=state_obj,
            enable_critique=critique_enabled_flag,
            web_search_enabled=web_search_flag,
            guide_mode=(x_user_ai_intent or "").strip().lower() == "guide",
            report_context_note=report_note,
            learned_knowledge_block=learned_block,
        ).__aiter__()
        timed_out = False
        # Per-turn telemetry accumulators (written to ai_chat_turn_logs at end).
        m_tools: list[str] = []
        m_web = False
        m_mode = effective_mode
        m_prompt = m_completion = m_rounds = 0
        m_usd: float | None = None
        m_answer = False
        m_error = False
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(agen.__anext__(), timeout=IDLE_TIMEOUT)
                except StopAsyncIteration:
                    break
                except asyncio.TimeoutError:
                    timed_out = True
                    break
                # Tally telemetry from the raw event.
                _et = getattr(ev, "type", None)
                if _et == "route":
                    m_mode = ((ev.extra or {}).get("route") or {}).get("mode") or m_mode
                elif _et == "tool_result":
                    tn = getattr(ev, "tool_name", None)
                    if tn:
                        m_tools.append(tn)
                        if tn == "web_search":
                            m_web = True
                elif _et == "cost":
                    c = (ev.extra or {}).get("cost") or {}
                    m_prompt = int(c.get("prompt_tokens") or m_prompt)
                    m_completion = int(c.get("completion_tokens") or m_completion)
                    m_rounds = int(c.get("rounds") or m_rounds)
                    m_usd = c.get("usd", m_usd)
                elif _et == "text" and getattr(ev, "text", ""):
                    m_answer = True
                elif _et == "error":
                    m_error = True
                envelope = _event_to_envelope(ev)
                if envelope is not None:
                    yield f"data: {_json.dumps(envelope, ensure_ascii=False, default=str)}\n\n"
                if envelope is not None and envelope.get("type") == "done":
                    return
                if loop.time() - started > HARD_TIMEOUT:
                    timed_out = True
                    break
        finally:
            try:
                await agen.aclose()
            except Exception:
                pass
            # Write per-turn telemetry (best-effort, never breaks the stream).
            try:
                from app.core.database import SessionLocal as _SL
                from app.models.ai_chat_turn_log import AiChatTurnLog
                _q = ""
                for _m in reversed(safe_messages):
                    if _m.get("role") == "user":
                        _q = str(_m.get("content") or "")[:1000]
                        break
                _log_db = _SL()
                try:
                    _log_db.add(AiChatTurnLog(
                        token=token,
                        session_key=(body.session_key or None),
                        mode=m_mode,
                        routed=("auto" if (x_user_ai_mode or "").strip().lower() in ("", "auto") else "manual"),
                        provider=provider,
                        model=model,
                        question=_q,
                        prompt_tokens=m_prompt,
                        completion_tokens=m_completion,
                        rounds=m_rounds,
                        usd=(round(float(m_usd), 6) if m_usd is not None else None),
                        tools_used=m_tools or None,
                        web_searched=m_web,
                        had_answer=m_answer,
                        errored=(m_error or timed_out),
                        latency_ms=int((loop.time() - started) * 1000),
                    ))
                    _log_db.commit()
                finally:
                    _log_db.close()
            except Exception:
                logger.debug("ai_bot turn-log write failed", exc_info=True)
        if timed_out:
            logger.warning("ai_bot turn watchdog fired token=%s mode=%s", token, effective_mode)
            yield (
                "data: "
                + _json.dumps({
                    "type": "error",
                    "text": "Truy vấn mất quá nhiều thời gian và đã bị dừng. Bạn thử hỏi lại hoặc thu hẹp câu hỏi nhé.",
                }, ensure_ascii=False)
                + "\n\n"
            )
            yield "data: " + _json.dumps({"type": "done"}) + "\n\n"

    return StreamingResponse(
        sse_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


class _AiAgentExploreBody(BaseModel):
    """Body for the goal-driven exploration run ("Phân tích toàn diện")."""
    briefing: dict | None = None
    viewer_filters: list[dict] | None = None
    session_key: str | None = None
    # Bounded server-side (explorer.MAX_BREADTH/MAX_DEPTH) — the FE default
    # of (3, 1) keeps a run under ~2-4 minutes.
    breadth: int | None = None
    depth: int | None = None


@router.post("/dashboards/{token}/ai/agent/explore")
@_limiter.limit("6/minute")
async def explore_dashboard_ai_agent(
    token: str,
    body: _AiAgentExploreBody,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
    x_user_ai_key: str | None = Header(default=None),
    x_user_ai_provider: str | None = Header(default=None),
    x_user_ai_model: str | None = Header(default=None),
):
    """Phase 16 — goal-driven exploration (InsightBench/AgentPoirot loop).

    One SSE run: generate root questions from the SMART goal + chart
    schema, answer each with the chart tools, extract typed insights,
    follow up on the most promising thread, then stream a ranked summary
    with action items. Same filter contract as chat: every tool call sees
    exactly what the dashboard renders.
    """
    import json as _json
    from fastapi.responses import StreamingResponse
    from app.services.dashboard_ai_bot.thinking.briefing import Briefing as _Briefing
    from app.services.dashboard_ai_bot.thinking.explorer import run_exploration_stream
    from app.services.dashboard_ai_bot.tool_context import ToolContext

    dash, public_filters, _, appearance_config = _get_dashboard_by_token(
        token, db, session_token=x_public_session, track_access=False,
    )
    if not (appearance_config or {}).get("ai_bot_enabled"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="AI bot is not enabled for this shared link.",
        )

    effective_key, provider, model = resolve_public_ai_credentials(
        appearance_config,
        x_user_ai_key=x_user_ai_key,
        x_user_ai_provider=x_user_ai_provider,
        x_user_ai_model=x_user_ai_model,
        missing_key_detail="X-User-Ai-Key header is required for AI explore.",
    )
    report_note = sanitize_report_context_note(
        (appearance_config or {}).get("ai_bot_report_context_note"),
    )

    viewer_filters_body = body.viewer_filters if isinstance(body.viewer_filters, list) else []
    combined_filters = _build_public_chart_filters(
        dash,
        public_filters,
        [item for item in viewer_filters_body if isinstance(item, dict)],
        context_for_log=f"ai_bot_explore:{token}",
    )
    ctx = ToolContext.from_dashboard(db=db, dashboard=dash, public_filters=combined_filters)
    briefing_obj = _Briefing.from_dict(body.briefing or {}) if body.briefing else None

    captured_key = effective_key

    async def sse_stream():
        import asyncio
        # Exploration is a multi-question run — a longer leash than chat,
        # but the same never-strand-the-UI watchdog contract.
        IDLE_TIMEOUT = 90.0
        HARD_TIMEOUT = 420.0
        loop = asyncio.get_event_loop()
        started = loop.time()
        agen = run_exploration_stream(
            ctx=ctx,
            api_key=captured_key,
            provider=provider,
            model=model,
            briefing=briefing_obj,
            report_context_note=report_note,
            breadth=body.breadth or 3,
            depth=body.depth if body.depth is not None else 1,
        ).__aiter__()
        timed_out = False
        m_insights = 0
        m_prompt = m_completion = m_rounds = 0
        m_usd = None
        m_error = False
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(agen.__anext__(), timeout=IDLE_TIMEOUT)
                except StopAsyncIteration:
                    break
                except asyncio.TimeoutError:
                    timed_out = True
                    break
                _et = getattr(ev, "type", None)
                if _et == "insight":
                    m_insights += 1
                elif _et == "cost":
                    c = (ev.extra or {}).get("cost") or {}
                    m_prompt = int(c.get("prompt_tokens") or m_prompt)
                    m_completion = int(c.get("completion_tokens") or m_completion)
                    m_rounds = int(c.get("rounds") or m_rounds)
                    m_usd = c.get("usd", m_usd)
                elif _et == "error":
                    m_error = True
                envelope = _event_to_envelope(ev)
                if envelope is not None:
                    yield f"data: {_json.dumps(envelope, ensure_ascii=False, default=str)}\n\n"
                if envelope is not None and envelope.get("type") == "done":
                    return
                if loop.time() - started > HARD_TIMEOUT:
                    timed_out = True
                    break
        finally:
            try:
                await agen.aclose()
            except Exception:
                pass
            # Same telemetry table as chat turns; mode="explore" separates
            # exploration runs in cost/UX analysis.
            try:
                from app.core.database import SessionLocal as _SL
                from app.models.ai_chat_turn_log import AiChatTurnLog
                _log_db = _SL()
                try:
                    _log_db.add(AiChatTurnLog(
                        token=token,
                        session_key=(body.session_key or None),
                        mode="explore",
                        routed="manual",
                        provider=provider,
                        model=model,
                        question=(briefing_obj.smart_goal[:1000] if briefing_obj else ""),
                        prompt_tokens=m_prompt,
                        completion_tokens=m_completion,
                        rounds=m_rounds,
                        usd=(round(float(m_usd), 6) if m_usd is not None else None),
                        tools_used=None,
                        web_searched=False,
                        had_answer=(m_insights > 0),
                        errored=(m_error or timed_out),
                        latency_ms=int((loop.time() - started) * 1000),
                    ))
                    _log_db.commit()
                finally:
                    _log_db.close()
            except Exception:
                logger.debug("ai_bot explore turn-log write failed", exc_info=True)
        if timed_out:
            logger.warning("ai_bot explore watchdog fired token=%s", token)
            yield (
                "data: "
                + _json.dumps({
                    "type": "error",
                    "text": "Phân tích toàn diện mất quá nhiều thời gian và đã dừng. Các insight đã tìm được vẫn hiển thị ở trên.",
                }, ensure_ascii=False)
                + "\n\n"
            )
            yield "data: " + _json.dumps({"type": "done"}) + "\n\n"

    return StreamingResponse(
        sse_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _event_to_envelope(ev) -> dict | None:
    """Convert an AgentEvent into the wire envelope.

    Hides internal fields and trims tool_result payloads to keep SSE small.
    """
    et = ev.type
    if et == "text":
        return {"type": "text", "text": ev.text}
    if et == "sources":
        # Web-search sources the answer drew on (title+url) → FE shows links.
        return {"type": "sources", "sources": (ev.extra or {}).get("sources") or []}
    if et == "route":
        # Auto-router decision (which depth was chosen + why). Lets the FE
        # show a read-only "đã chọn chế độ" chip instead of a toggle.
        info = (ev.extra or {}).get("route") or {}
        return {
            "type": "route",
            "mode": info.get("mode"),
            "auto": bool(info.get("auto")),
            "reasons": info.get("reasons") or [],
        }
    if et == "status":
        return {"type": "status", "text": ev.text, "tool": ev.tool_name}
    if et == "tool_result":
        # Send only ok/error so the FE can flag failures without leaking the
        # full payload (which can be large).
        result = ev.tool_result or {}
        return {
            "type": "tool_result",
            "tool": ev.tool_name,
            "ok": bool(result.get("ok")),
            "error": result.get("error") if not result.get("ok") else None,
        }
    if et == "reading_plan":
        # Phase-15.71 — forward the analyst-style reading plan to the
        # FE. The structured items are safe to send (already validated
        # in tool_emit_reading_plan: chart_id ∈ allowed set, phase
        # whitelisted, question is plain text).
        extra = ev.extra or {}
        return {
            "type": "reading_plan",
            "items": extra.get("items") or [],
            "overall_goal": extra.get("overall_goal"),
        }
    if et == "plan_step":
        # Phase 15.72 — per-step progress badge update. Lets the FE flip
        # each plan step from pending → running → done as the agent
        # works through it.
        extra = ev.extra or {}
        return {
            "type": "plan_step",
            "step_index": extra.get("step_index"),
            "chart_id": extra.get("chart_id"),
            "status": extra.get("status"),
        }
    if et == "insight":
        # Phase 16 — one typed Insight extracted by the exploration engine
        # (rung + statement + evidence chart ids + justification + action).
        # Already sanitized in explorer._parse_insight (chart ids validated
        # against the dashboard, strings capped).
        return {"type": "insight", "insight": (ev.extra or {}).get("insight") or {}}
    if et == "exploration_step":
        # Phase 16 — exploration progress tick (stage + question metadata).
        return {"type": "exploration_step", **(ev.extra or {})}
    if et == "error":
        return {"type": "error", "text": ev.text}
    if et == "state":
        return {"type": "state", "state": (ev.extra or {}).get("state") or {}}
    if et == "cost":
        # Running USD spend for the current question. Sent every round.
        info = (ev.extra or {}).get("cost") or {}
        return {"type": "cost", **info}
    if et == "usage":
        # Per-round token counts (informational; FE may ignore).
        return {"type": "usage", **(ev.extra or {})}
    if et == "done":
        return {"type": "done"}
    # tool_call (and the explorer-internal _answer) never reach the FE
    return None
