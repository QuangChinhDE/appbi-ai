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
from app.services.dataset_model_service import get_dataset_model, get_distinct_field_values
from app.services.dashboard_ai_bot.public_link_config import (
    resolve_public_ai_cost_cap,
    resolve_public_ai_credentials,
    resolve_public_ai_critique_enabled,
    sanitize_report_context_note,
)

from slowapi import Limiter
from slowapi.util import get_remote_address

if settings.WORKBOARDS_ENABLED:
    from app.modules.workboards.models import WorkboardWorkspace
    from app.modules.workboards.roles import is_owner_role
    from app.modules.workboards.services import app_user_service
    from app.modules.workboards.services.public_links import WorkboardPublicLinkService
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

    return [{
        "key": ordered_semantic_fields[0],
        "name": "date",
        "label": "Date",
        "tableLabel": table_labels_by_field.get(ordered_semantic_fields[0]),
        "type": "date",
        "semanticField": ordered_semantic_fields[0],
        "datasetId": next(iter(dataset_ids)) if len(dataset_ids) == 1 else None,
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
    """
    if public_filters:
        return _build_filter_fields_from_public_filters(db, dash, public_filters)

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
        return [*calendar_columns, *non_date_columns]

    return normalized_columns


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


def _dedupe_filters_by_field(filters: list[dict]) -> list[dict]:
    """Dedupe filter list by (datasetId, semanticField); later entries win.

    Used to combine DA-defined access filters with viewer overrides so the
    viewer's value supersedes the default rather than AND-ing into an empty
    set (e.g. Level=3 AND Level=1).
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
    # Public viewers get view-level permission (read-only, no edit actions)
    dash.user_permission = "view"
    for dashboard_chart in dash.dashboard_charts or []:
        ChartService.hydrate_runtime_config(db, dashboard_chart.chart, auto_generate=False)

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
    top_bar_filters = list(dash.filters_config or [])
    dash.public_filters_config = top_bar_filters
    dash.available_filter_fields = _build_public_filter_fields(db, dash, top_bar_filters)
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
    return dash


if settings.WORKBOARDS_ENABLED:
    def _get_workboard_by_token(
        token: str,
        db: Session,
        session_token: str | None = None,
        *,
        track_access: bool = True,
    ):
        workboard, link = WorkboardPublicLinkService.find_by_token(db, token)
        if not workboard or not link:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Shared workboard not found or link has been revoked.",
            )
        if not bool(link.get("is_active", True)):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Shared workboard not found or link has been revoked.",
            )
        if link.get("password_hash"):
            if not session_token or not _verify_public_session(session_token, token):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="This shared link requires a password.",
                    headers={"X-Link-Password-Required": "true"},
                )
        if track_access:
            touched = WorkboardPublicLinkService.touch_access(db, workboard, str(link.get("id")))
            if touched:
                link = touched
        return workboard, link


    @router.post("/workboards/{token}/auth")
    @_limiter.limit("10/minute")
    def auth_public_workboard_link(
        token: str,
        body: _PasswordBody,
        request: Request,
        db: Session = Depends(get_db),
    ):
        workboard, link = WorkboardPublicLinkService.find_by_token(db, token)
        if not workboard or not link or not bool(link.get("is_active", True)):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Shared workboard not found or link has been revoked.",
            )
        if not link.get("password_hash"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This link does not require a password.")
        if not WorkboardPublicLinkService.verify_password(link, body.password):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Incorrect password.")
        return {"session_token": _create_public_session(token), "expires_in": PUBLIC_SESSION_SECONDS}


    @router.get("/workboards/{token}")
    @_limiter.limit("30/minute")
    def get_public_workboard(
        token: str,
        request: Request,
        db: Session = Depends(get_db),
        x_public_session: str | None = Header(default=None),
    ):
        workboard, link = _get_workboard_by_token(
            token,
            db,
            session_token=x_public_session,
        )
        # Mini-app contract: a public link is just an authenticated handle
        # on a workboard. The FE consumes ``workboard.layout`` (screens[])
        # and drives everything through the workspace screen endpoints.
        payload = {
            "workboard": {
                "id": workboard.id,
                "name": workboard.name,
                "description": workboard.description,
                "slug": workboard.slug,
                "layout": workboard.layout_json or {},
            },
            "link": {
                "id": str(link.get("id")),
                "name": str(link.get("name") or workboard.name),
                "token": token,
                "is_active": bool(link.get("is_active", True)),
                "has_password": bool(link.get("password_hash")),
                "access_count": int(link.get("access_count") or 0),
                "last_accessed_at": link.get("last_accessed_at"),
                "created_at": link.get("created_at"),
                "updated_at": link.get("updated_at"),
            },
        }
        return payload


    @router.post("/workboards/{token}/submit")
    @_limiter.limit("30/minute")
    def submit_public_workboard_form(
        token: str,
        body: dict,
        request: Request,
        db: Session = Depends(get_db),
        x_public_session: str | None = Header(default=None),
    ):
        workboard, link = _get_workboard_by_token(
            token,
            db,
            session_token=x_public_session,
            track_access=False,
        )
        values = body.get("values") if isinstance(body, dict) else None
        if not isinstance(values, dict):
            raise HTTPException(status_code=400, detail="values is required.")
        try:
            result = WorkboardWriteService.insert_row(db, workboard, values, None)
        except WorkboardValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"message": str(exc), "violations": exc.violations},
            ) from exc
        except WorkboardWriteError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        return {
            "action": "insert",
            **result,
        }


    # â”€â”€ Workspace public endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    #
    # Workspaces are the public face of a project's mini-app. End-users
    # (workers, foremen, drivers) authenticate against the project's own
    # employee table via `app_user_service.authenticate`, then drive a
    # role-filtered menu of workboards. Cookie name is namespaced to the
    # workspace token so multiple workspaces on the same domain don't
    # clobber each other's sessions.

    _WORKSPACE_COOKIE_PREFIX = "wbws_"  # final cookie: wbws_<short-hash-of-token>

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
        return wb


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
        return screen_runtime.render_app_shell(wb, identity)


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
        if not screen_runtime.is_screen_visible_for(screen, identity):
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
            return screen_runtime.render_form_screen(
                db, wb, screen, identity=identity, shared_context=shared_context
            )
        if screen.kind == "table":
            return {
                **screen_runtime.render_table_screen(
                    db, wb, screen, identity=identity
                ),
                "screen_id": screen.id,
                "kind": "table",
                "title": screen.title,
                "icon": screen.icon,
                "description": screen.description,
            }
        if screen.kind == "doc":
            return screen_runtime.render_doc_screen(
                db, wb, screen, identity=identity, app_user_payload=app_user
            )
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
            resolved_token = resolve_managed_token(
                layout_json=wb.layout_json,
                screen_id=screen.id,
                app_user_role=app_user.get("role") if isinstance(app_user, dict) else None,
            )
            effective_token = resolved_token or screen.dashboard.share_token
            if not effective_token:
                raise HTTPException(
                    status_code=400,
                    detail="Dashboard screen has no share token for this role.",
                )
            return {
                "screen_id": screen.id,
                "kind": "dashboard",
                "title": screen.title,
                "icon": screen.icon,
                "description": screen.description,
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
        if not screen_runtime.is_screen_visible_for(screen, identity):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        content, filename = screen_runtime.export_doc_data_block_to_excel(
            db, wb, screen, block_index, identity=identity
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
        if not screen_runtime.is_screen_visible_for(screen, identity):
            raise HTTPException(
                status_code=403, detail="You don't have access to that screen."
            )
        trigger_id = (body or {}).get("trigger_id")
        if not isinstance(trigger_id, str) or not trigger_id:
            raise HTTPException(status_code=400, detail="trigger_id is required")

        try:
            group_id, runs = _sync_svc.trigger_sync(
                db,
                wb,
                screen_id,
                block_index,
                trigger_id,
                identity=identity,
                app_user_payload=app_user,
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
        if not screen_runtime.is_screen_visible_for(screen, identity):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        body = body or {}
        return {
            **screen_runtime.render_table_screen(
                db,
                wb,
                screen,
                identity=identity,
                page=int(body.get("page") or 1),
                page_size=int(body["page_size"]) if body.get("page_size") else None,
                extra_filters=body.get("filters") or [],
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
        if not screen_runtime.is_screen_visible_for(screen, identity):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        values = body.get("values") if isinstance(body, dict) else None
        if not isinstance(values, dict):
            raise HTTPException(status_code=400, detail="values is required.")
        try:
            result = screen_runtime.insert_screen_row(
                db, wb, screen, values, identity=identity
            )
        except WorkboardValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"message": str(exc), "violations": exc.violations},
            ) from exc
        except WorkboardWriteError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        return {"action": "insert", **result}


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
        if not screen_runtime.is_screen_visible_for(screen, identity):
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
        if not screen_runtime.is_screen_visible_for(screen, identity):
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
        return {"action": "update", **result}


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
        if not screen_runtime.is_screen_visible_for(screen, identity):
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
        if not screen_runtime.is_screen_visible_for(screen, identity):
            raise HTTPException(status_code=403, detail="You don't have access to that screen.")
        pk = body.get("pk") if isinstance(body, dict) else None
        if not isinstance(pk, dict) or not pk:
            raise HTTPException(status_code=400, detail="pk is required.")
        try:
            result = screen_runtime.delete_screen_row(
                db, wb, screen, pk, identity=identity
            )
        except WorkboardValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"message": str(exc), "violations": exc.violations},
            ) from exc
        except WorkboardWriteError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        return {"action": "delete", **result}


@router.get("/dashboards/{token}/filters/distinct-values")
@_limiter.limit("30/minute")
def get_public_filter_distinct_values(
    token: str,
    request: Request,
    dataset_id: int = Query(..., ge=1),
    field: str = Query(..., description="Qualified field name, e.g. orders.country"),
    limit: int = Query(200, ge=1, le=500),
    filters: str | None = Query(
        default=None,
        description="JSON-encoded list of additional viewer filter objects.",
    ),
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    dash, public_filters, _, _ = _get_dashboard_by_token(
        token,
        db,
        session_token=x_public_session,
        track_access=False,
    )

    public_filter_fields = _build_public_filter_fields(db, dash, public_filters)
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

    combined_filters = _dedupe_filters_by_field([
        *[item for item in (public_filters or []) if isinstance(item, dict)],
        *sanitized_viewer_filters,
    ])

    try:
        return {
            "field": field,
            "values": get_distinct_field_values(
                db,
                dataset_id,
                field,
                limit=limit,
                filters=combined_filters,
            ),
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
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Return chart data for a public shared link.

    Validates that chart_id belongs to the shared dashboard so a stray token
    cannot be used to access arbitrary charts.
    Password-protected links require X-Public-Session header from /auth.
    """
    dash, public_filters, _, _ = _get_dashboard_by_token(
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

    combined_filters = _dedupe_filters_by_field([
        *[item for item in (public_filters or []) if isinstance(item, dict)],
        *viewer_filters,
    ])

    try:
        return ChartService.get_chart_data(
            db,
            chart_id,
            extra_filters=combined_filters or None,
            filter_context="dashboard",
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


# â”€â”€ Dashboard AI Bot endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
#
# These endpoints power the BYOK AI chat widget on public dashboard pages.
# The user's API key is passed in X-User-Ai-Key and is NEVER stored or logged.
# Context (chart data) is fetched fresh per session and sent to the LLM.

class _AiChatBody(BaseModel):
    messages: list[dict]
    context_snapshot: dict | None = None
    # Viewer-applied slicer filters (currently set on the dashboard UI).
    # When present, merged with the link's DA-defined public filters so the
    # bot sees exactly what the dashboard is showing.
    viewer_filters: list[dict] | None = None


@router.get("/dashboards/{token}/ai/context")
@_limiter.limit("20/minute")
def get_dashboard_ai_context(
    token: str,
    request: Request,
    filters: str | None = Query(
        default=None,
        description="JSON-encoded list of viewer-applied slicer filter objects.",
    ),
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Return chart data context for the AI bot.

    The AI bot fetches this once on first open, caches it client-side for
    the session, and sends a snapshot with each chat turn. ``filters``
    carries the viewer's current slicer state so the snapshot reflects the
    same data the dashboard is rendering.
    """
    from app.services import dashboard_ai_service  # local import â€” optional feature

    dash, public_filters, _, appearance_config = _get_dashboard_by_token(
        token,
        db,
        session_token=x_public_session,
        track_access=False,
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

    combined_filters = _dedupe_filters_by_field([
        *[item for item in (public_filters or []) if isinstance(item, dict)],
        *viewer_filters,
    ])

    try:
        context = dashboard_ai_service.build_ai_context(db, dash, combined_filters)
    except Exception as exc:
        logger.exception("AI context build error for token=%s", token)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to build AI context.",
        )

    from fastapi.responses import JSONResponse
    return JSONResponse(content=context, headers={"Cache-Control": "no-store"})


@router.post("/dashboards/{token}/ai/chat")
@_limiter.limit("20/minute")
async def chat_dashboard_ai(
    token: str,
    body: _AiChatBody,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
    x_user_ai_key: str | None = Header(default=None),
    x_user_ai_provider: str | None = Header(default=None),
):
    """Stream an LLM response for a chat turn using the user's own API key (BYOK).

    The key is forwarded to the provider and NEVER persisted or logged.
    Returns a text/event-stream (SSE) response.
    """
    from fastapi.responses import StreamingResponse
    from app.services import dashboard_ai_service  # local import â€” optional feature

    dash, public_filters, _, appearance_config = _get_dashboard_by_token(
        token,
        db,
        session_token=x_public_session,
        track_access=False,
    )

    if not (appearance_config or {}).get("ai_bot_enabled"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="AI bot is not enabled for this shared link.",
        )

    if not x_user_ai_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-User-Ai-Key header is required for AI chat.",
        )

    provider = (x_user_ai_provider or "gemini").strip().lower()
    if provider not in ("anthropic", "openai", "gemini"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-User-Ai-Provider must be one of: anthropic, openai, gemini.",
        )

    messages = body.messages or []
    if not messages:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="messages is required.")

    # Use snapshot context if provided; otherwise build fresh (more expensive)
    context_snapshot = body.context_snapshot
    if context_snapshot and isinstance(context_snapshot, dict):
        # Validate: chart_ids in snapshot must belong to this dashboard
        dash_chart_ids = {dc.chart_id for dc in (dash.dashboard_charts or []) if dc.chart_id}
        for chart in context_snapshot.get("charts") or []:
            cid = chart.get("id")
            if cid is not None and cid not in dash_chart_ids:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=f"Chart {cid} does not belong to this dashboard.",
                )
        context = context_snapshot
    else:
        # Merge viewer slicer filters with link-level public filters so the
        # context the LLM sees matches what the dashboard is rendering.
        viewer_filters_body = body.viewer_filters if isinstance(body.viewer_filters, list) else []
        combined_filters = _dedupe_filters_by_field([
            *[item for item in (public_filters or []) if isinstance(item, dict)],
            *[item for item in viewer_filters_body if isinstance(item, dict)],
        ])
        try:
            context = dashboard_ai_service.build_ai_context(db, dash, combined_filters)
        except Exception:
            logger.exception("AI context build error (chat fallback) for token=%s", token)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to build AI context.",
            )

    system_prompt = dashboard_ai_service.build_system_prompt(context)

    # Capture key before yielding into async generator (keep off stack after entry)
    captured_key = x_user_ai_key

    async def sse_stream():
        async for chunk in dashboard_ai_service.stream_llm_byok(
            messages=messages,
            user_key=captured_key,
            provider=provider,
            system_prompt=system_prompt,
        ):
            if chunk:
                # SSE format: "data: <payload>\n\n"
                safe = chunk.replace("\n", "\\n")
                yield f"data: {safe}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        sse_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# â”€â”€ Agentic AI Bot endpoints (v2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
#
# These endpoints back the new agentic flow built in
# ``app.services.dashboard_ai_bot``. They coexist with the legacy
# ``/ai/context`` + ``/ai/chat`` endpoints above (which power any old client
# binaries still in the wild). New frontend code should prefer ``/ai/recon``
# + ``/ai/agent/chat``.
#
# SSE wire format (NEW): every line is a JSON envelope so the client can
# distinguish text deltas from tool status updates from errors.
#   data: {"type":"text","text":"..."}\n\n
#   data: {"type":"status","text":"...","tool":"..."}\n\n
#   data: {"type":"tool_result","tool":"...","ok":true}\n\n
#   data: {"type":"error","text":"..."}\n\n
#   data: {"type":"done"}\n\n


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
    from app.services.dashboard_ai_bot.thinking.agent import build_proactive_recon
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
        ctx = ToolContext.from_dashboard(db=db, dashboard=dash, public_filters=public_filters)
        recon = build_proactive_recon(ctx)
    except Exception:
        logger.exception("AI recon build error for token=%s", token)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to build AI recon.",
        )

    import json
    from datetime import date, datetime

    def _default(obj):
        if isinstance(obj, (date, datetime)):
            return obj.isoformat()
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


@router.get("/dashboards/{token}/ai/dashboard.pdf")
@_limiter.limit("10/minute")
def get_dashboard_ai_pdf(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Render the dashboard as a multi-page PDF â€” one page per chart plus a
    cover page. The user can download this and re-feed it into ANY LLM
    (Claude, ChatGPT) for offline analysis â€” same data, "real images" the
    way the user described.
    """
    from app.services.dashboard_ai_bot.thinking.advanced_tools import (
        _detect_dim_idx, _detect_measure_idx,
    )
    from app.services.dashboard_ai_bot.thinking.chart_renderer import render_dashboard_pdf
    from app.services.dashboard_ai_bot.tool_context import _fetch_chart_data, ToolContext

    dash, public_filters, _, appearance_config = _get_dashboard_by_token(
        token, db, session_token=x_public_session, track_access=False,
    )
    if not (appearance_config or {}).get("ai_bot_enabled"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="AI bot is not enabled for this shared link.",
        )

    ctx = ToolContext.from_dashboard(db=db, dashboard=dash, public_filters=public_filters)
    payloads: list[dict] = []
    for chart_id in sorted(ctx.allowed_chart_ids):
        meta = ctx.chart_meta.get(chart_id, {})
        try:
            data = _fetch_chart_data(ctx, chart_id)
        except Exception:
            logger.warning("AI PDF: failed to load chart_id=%s", chart_id)
            continue
        cols = data["columns"]
        rows = data["rows"][:200]
        m_idx = _detect_measure_idx(cols, rows)
        d_idx = _detect_dim_idx(cols, rows, m_idx, prefer_datetime=True)
        ctype = (meta.get("chart_type") or "").lower()
        role = "kpi" if any(h in ctype for h in ("kpi", "metric", "card", "number", "stat")) else (
            "trend" if any(h in ctype for h in ("line", "area")) else (
                "distribution" if any(h in ctype for h in ("pie", "donut")) else "breakdown"
            )
        )
        payloads.append({
            "chart_id": chart_id,
            "chart_name": meta.get("name", f"Chart {chart_id}"),
            "chart_type": meta.get("chart_type", ""),
            "chart_role": role,
            "columns": cols,
            "rows": rows,
            "dim_idx": d_idx,
            "measure_idx": m_idx,
        })

    try:
        pdf_bytes = render_dashboard_pdf(
            dashboard_name=dash.name or "Dashboard",
            chart_payloads=payloads,
        )
    except Exception:
        logger.exception("AI PDF render failed for token=%s", token)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to render PDF.",
        )

    safe_name = (dash.name or "dashboard").replace(" ", "_")[:60]
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}.pdf"',
            "Cache-Control": "no-store",
        },
    )


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
    from app.services.dashboard_ai_bot.thinking.agent import build_proactive_recon
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

    combined_filters = _dedupe_filters_by_field([
        *[item for item in (public_filters or []) if isinstance(item, dict)],
        *viewer_filters,
    ])

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
    from app.services.dashboard_ai_bot.thinking.agent import build_proactive_recon
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
    combined_filters = _dedupe_filters_by_field([
        *[item for item in (public_filters or []) if isinstance(item, dict)],
        *[item for item in viewer_filters_body if isinstance(item, dict)],
    ])
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

    _get_dashboard_by_token(token, db, session_token=x_public_session, track_access=False)

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
    x_user_ai_cost_cap_usd: str | None = Header(default=None, alias="X-User-Ai-Cost-Cap-Usd"),
    x_user_ai_mode: str | None = Header(default=None, alias="X-User-Ai-Mode"),
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
    cost_cap_val = resolve_public_ai_cost_cap(
        appearance_config,
        x_user_ai_cost_cap_usd=x_user_ai_cost_cap_usd,
        x_user_ai_mode=x_user_ai_mode,
    )
    critique_enabled_flag = resolve_public_ai_critique_enabled(appearance_config)

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
    # Merge link-level public filters with viewer-applied slicer filters from
    # the dashboard UI. Same pattern as the public chart-data endpoint at
    # line ~1864 â€” later entries (viewer overrides) win via dedupe.
    viewer_filters_body = body.viewer_filters if isinstance(body.viewer_filters, list) else []
    combined_filters = _dedupe_filters_by_field([
        *[item for item in (public_filters or []) if isinstance(item, dict)],
        *[item for item in viewer_filters_body if isinstance(item, dict)],
    ])
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
        async for ev in run_agent_stream(
            mode=x_user_ai_mode,
            ctx=ctx,
            user_messages=safe_messages,
            api_key=captured_key,
            provider=provider,
            model=model,
            briefing=briefing_obj,
            state=state_obj,
            cost_cap_usd=cost_cap_val,
            enable_critique=critique_enabled_flag,
            report_context_note=sanitize_report_context_note(
                (appearance_config or {}).get("ai_bot_report_context_note"),
            ),
        ):
            envelope = _event_to_envelope(ev)
            if envelope is None:
                continue
            yield f"data: {_json.dumps(envelope, ensure_ascii=False, default=str)}\n\n"

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
    # tool_call is internal; not sent to FE
    return None
