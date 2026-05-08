"""
Public (unauthenticated) endpoints for shared dashboard links.

POST /public/dashboards/{token}/auth               → exchange password for session token
GET  /public/dashboards/{token}                    → dashboard + chart configs
GET  /public/dashboards/{token}/charts/{chart_id}/data → chart query data

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
from app.services import ChartService
from app.services.dataset_model_service import get_dataset_model, get_distinct_field_values

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
    from app.modules.workboards.services.runtime_service import WorkboardRuntimeService
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

# 2 hours — covers a full business meeting/presentation session without excessive re-auth
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
            from_column = str(join.get("from_column") or "").strip()
            to_view = str(join.get("view") or "").strip()
            to_column = str(join.get("to_column") or "").strip()

            if from_view and from_column:
                fields.add(f"{from_view}.{from_column}")
            if to_view and to_column:
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


def _build_public_filter_fields(db: Session, dash: Dashboard) -> list[dict]:
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

        # Check password protection — require a valid session token
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
    dash, public_filters, link_name, appearance_config = _get_dashboard_by_token(
        token,
        db,
        session_token=x_public_session,
    )
    # Public viewers get view-level permission (read-only, no edit actions)
    dash.user_permission = "view"
    for dashboard_chart in dash.dashboard_charts or []:
        ChartService.hydrate_runtime_config(db, dashboard_chart.chart, auto_generate=False)
    # Expose the link-specific filters so the frontend can display filter badges
    dash.public_filters_config = public_filters
    dash.available_filter_fields = _build_public_filter_fields(db, dash)
    dash.public_link_name = link_name
    dash.public_link_appearance = appearance_config or {}
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
        mode = "view" if link.get("mode") == "view" else "form"
        payload = {
            "workboard": {
                "id": workboard.id,
                "name": workboard.name,
                "description": workboard.description,
            },
            "link": {
                "id": str(link.get("id")),
                "name": str(link.get("name") or workboard.name),
                "token": token,
                "mode": mode,
                "view_id": link.get("view_id"),
                "is_active": bool(link.get("is_active", True)),
                "has_password": bool(link.get("password_hash")),
                "access_count": int(link.get("access_count") or 0),
                "last_accessed_at": link.get("last_accessed_at"),
                "created_at": link.get("created_at"),
                "updated_at": link.get("updated_at"),
            },
            "mode": mode,
        }
        if mode == "form":
            payload["form"] = WorkboardRuntimeService.render_form(db, workboard)
        else:
            view_id = str(link.get("view_id") or "")
            if not view_id:
                raise HTTPException(status_code=400, detail="Shared workboard view is not configured.")
            rendered = WorkboardRuntimeService.render_view(
                db,
                workboard,
                view_id,
                page=1,
                page_size=50,
                filters=[],
            )
            if rendered.get("missing"):
                raise HTTPException(status_code=404, detail="Shared workboard view not found.")
            payload["rendered_view"] = rendered
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
        if link.get("mode") == "view":
            raise HTTPException(status_code=400, detail="This shared workboard link is read-only.")
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


    # ── Workspace public endpoints ────────────────────────────────────────
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
          1. Workspace-cookie session (the standard flow — set by /login or
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
        session_token, ttl = app_user_service.create_session_token(
            ws, matched_user
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
                context=dict(matched_user.context or {}),
            ),
        )


    @router.post("/workspaces/{token}/logout")
    def workspace_logout(token: str, response: Response, db: Session = Depends(get_db)):
        # Don't 404 here — let users clear their cookie even if the
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
                    "Workspace này chỉ mở cho AppBI staff đã đăng nhập. "
                    "Đăng nhập AppBI rồi mở lại."
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
                    "Workspace này chỉ mở cho AppBI staff đã đăng nhập."
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

        When ``app_user`` is supplied and the workboard has a per-workboard
        ``app_users_config`` override, callers from a different user table
        are rejected with 403 — guards against an authenticated nurse
        poking around a drivers-only mini-app by id.
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
                detail=(
                    "Tài khoản này thuộc bảng người dùng khác — không truy cập "
                    "được mini-app này."
                ),
            )
        return wb


    @router.get("/workspaces/{token}/workboards/{workboard_id}/form")
    def workspace_get_form(
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
        return WorkboardRuntimeService.render_form(db, wb)


    @router.post("/workspaces/{token}/workboards/{workboard_id}/rows/list")
    def workspace_list_rows(
        token: str,
        workboard_id: int,
        body: dict | None,
        request: Request,
        db: Session = Depends(get_db),
    ):
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        body = body or {}
        identity = identity_from_app_user(app_user)
        return WorkboardRuntimeService.list_rows(
            db,
            wb,
            page=int(body.get("page") or 1),
            page_size=int(body.get("page_size") or 50),
            filters=body.get("filters") or [],
            identity=identity,
        )


    @router.post("/workspaces/{token}/workboards/{workboard_id}/rows")
    def workspace_insert_row(
        token: str,
        workboard_id: int,
        body: dict,
        request: Request,
        db: Session = Depends(get_db),
    ):
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        from app.modules.workboards.services.rls_service import enforce_write_access
        from app.modules.workboards.schemas import LayoutJson as _Layout

        try:
            layout = _Layout.model_validate(wb.layout_json or {})
        except Exception:
            layout = _Layout()
        identity = identity_from_app_user(app_user)
        values = enforce_write_access(
            layout.rls,
            identity,
            op="insert",
            row_values=body.get("values") if isinstance(body, dict) else None,
        )
        if not isinstance(values, dict):
            raise HTTPException(status_code=400, detail="values is required.")
        try:
            result = WorkboardWriteService.insert_row(db, wb, values, None)
        except WorkboardValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"message": str(exc), "violations": exc.violations},
            ) from exc
        except WorkboardWriteError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        return {"action": "insert", **result}


    @router.patch("/workspaces/{token}/workboards/{workboard_id}/rows")
    def workspace_update_row(
        token: str,
        workboard_id: int,
        body: dict,
        request: Request,
        db: Session = Depends(get_db),
    ):
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )

        from app.modules.workboards.services.rls_service import (
            build_rls_filter,
            enforce_write_access,
        )
        from app.modules.workboards.schemas import LayoutJson as _Layout

        try:
            layout = _Layout.model_validate(wb.layout_json or {})
        except Exception:
            layout = _Layout()
        identity = identity_from_app_user(app_user)

        pk = body.get("pk") if isinstance(body, dict) else None
        values = enforce_write_access(
            layout.rls,
            identity,
            op="update",
            row_values=body.get("values") if isinstance(body, dict) else None,
        )

        # Make sure the targeted row is one this app_user is allowed to see;
        # otherwise a worker could update someone else's row by guessing PKs.
        rls_filters, allowed = build_rls_filter(layout.rls, identity)
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to that row.",
            )
        if rls_filters:
            existing = WorkboardRuntimeService.list_rows(
                db,
                wb,
                page=1,
                page_size=1,
                filters=[
                    *(
                        [
                            {"field": k, "operator": "eq", "value": v}
                            for k, v in (pk or {}).items()
                        ]
                    ),
                    *rls_filters,
                ],
                identity=identity,
            )
            if not (existing.get("rows") or []):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="You don't have access to that row.",
                )

        try:
            result = WorkboardWriteService.update_row(
                db, wb, pk or {}, values, None,
            )
        except WorkboardValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"message": str(exc), "violations": exc.violations},
            ) from exc
        except WorkboardWriteError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        return {"action": "update", **result}


    @router.get("/workspaces/{token}/workboards/{workboard_id}/doc/{view_id}")
    def workspace_render_doc(
        token: str,
        workboard_id: int,
        view_id: str,
        request: Request,
        db: Session = Depends(get_db),
    ):
        ws = _load_workspace_or_404(db, token)
        app_user = _require_workspace_app_user(request, ws, db=db)
        wb = _resolve_workboard_for_workspace(
            db, ws, workboard_id, request=request, app_user=app_user
        )
        identity = identity_from_app_user(app_user)
        rendered = WorkboardRuntimeService.render_doc(
            db,
            wb,
            view_id=view_id,
            user=None,
            view_filters=None,
            identity=identity,
            app_user_payload=app_user,
        )
        if rendered.get("missing"):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Doc view '{view_id}' not found",
            )
        return rendered


    # ── Mini-app screen-based endpoints ───────────────────────────────────
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
        if screen.kind == "list":
            return {
                **screen_runtime.render_list_screen(
                    db, wb, screen, identity=identity
                ),
                "screen_id": screen.id,
                "kind": "list",
                "title": screen.title,
                "icon": screen.icon,
                "description": screen.description,
            }
        if screen.kind == "doc":
            return screen_runtime.render_doc_screen(
                db, wb, screen, identity=identity, app_user_payload=app_user
            )
        raise HTTPException(status_code=400, detail=f"Unsupported screen kind '{screen.kind}'.")


    @router.post("/workspaces/{token}/workboards/{workboard_id}/screens/{screen_id}/list")
    def workspace_screen_list_rows(
        token: str,
        workboard_id: int,
        screen_id: str,
        body: dict | None,
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
        body = body or {}
        return screen_runtime.render_list_screen(
            db,
            wb,
            screen,
            identity=identity,
            page=int(body.get("page") or 1),
            page_size=int(body.get("page_size") or 50),
            extra_filters=body.get("filters") or [],
        )


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

    public_filter_fields = _build_public_filter_fields(db, dash)
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

    combined_filters = [
        *[item for item in (public_filters or []) if isinstance(item, dict)],
        *sanitized_viewer_filters,
    ]

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
# (easily 15–20 for an HTML-imported dashboard), plus re-fetches on every
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

    combined_filters = [
        *[item for item in (public_filters or []) if isinstance(item, dict)],
        *viewer_filters,
    ]

    try:
        return ChartService.get_chart_data(
            db,
            chart_id,
            extra_filters=combined_filters or None,
            filter_context="dashboard",
        )
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chart data not found.")
    except Exception as exc:
        logger.exception("Public chart data error for token=%s chart=%s", token, chart_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load chart data.",
        )


# ── Dashboard AI Bot endpoints ────────────────────────────────────────────────
#
# These endpoints power the BYOK AI chat widget on public dashboard pages.
# The user's API key is passed in X-User-Ai-Key and is NEVER stored or logged.
# Context (chart data) is fetched fresh per session and sent to the LLM.

class _AiChatBody(BaseModel):
    messages: list[dict]
    context_snapshot: dict | None = None


@router.get("/dashboards/{token}/ai/context")
@_limiter.limit("20/minute")
def get_dashboard_ai_context(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Return chart data context for the AI bot.

    The AI bot fetches this once on first open, caches it client-side for
    the session, and sends a snapshot with each chat turn.
    """
    from app.services import dashboard_ai_service  # local import — optional feature

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

    try:
        context = dashboard_ai_service.build_ai_context(db, dash, public_filters)
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
    from app.services import dashboard_ai_service  # local import — optional feature

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
        try:
            context = dashboard_ai_service.build_ai_context(db, dash, public_filters)
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


# ── Agentic AI Bot endpoints (v2) ─────────────────────────────────────────────
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
    from app.services.dashboard_ai_bot.agent import build_proactive_recon
    from app.services.dashboard_ai_bot.tools import ToolContext

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

    from fastapi.responses import JSONResponse
    return JSONResponse(content=recon, headers={"Cache-Control": "no-store"})


class _AiAgentChatBody(BaseModel):
    messages: list[dict]


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
):
    """Run an agentic chat turn. Streams typed SSE events.

    Honors the dashboard's public filters automatically — every tool the
    agent calls applies the same filters the dashboard is currently showing.
    """
    import json as _json
    from fastapi.responses import StreamingResponse
    from app.services.dashboard_ai_bot.agent import run_agent_stream
    from app.services.dashboard_ai_bot.tools import ToolContext

    dash, public_filters, _, appearance_config = _get_dashboard_by_token(
        token, db, session_token=x_public_session, track_access=False,
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
    model = (x_user_ai_model or "").strip() or None
    if model is not None and len(model) > 120:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-User-Ai-Model is too long.",
        )

    messages = body.messages or []
    if not messages:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="messages is required.")

    # Sanitize: strip any tool/assistant turns referencing chart_ids outside
    # this dashboard (defensive — clients shouldn't send these but we guard).
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
        # Drop any tool_calls echoed back — agent treats turns as fresh
        safe_messages.append(out)

    if not safe_messages:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No valid messages.")

    captured_key = x_user_ai_key
    ctx = ToolContext.from_dashboard(db=db, dashboard=dash, public_filters=public_filters)

    async def sse_stream():
        async for ev in run_agent_stream(
            ctx=ctx,
            user_messages=safe_messages,
            api_key=captured_key,
            provider=provider,
            model=model,
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
    if et == "error":
        return {"type": "error", "text": ev.text}
    if et == "done":
        return {"type": "done"}
    # tool_call is internal; not sent to FE
    return None
