"""Sharing endpoints + cascade share logic for users and teams."""

import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session, joinedload

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_full_access
from app.core.share_access import require_share_access
from app.models.audit_log import AuditAction
from app.models.dataset import Dataset, DatasetTable
from app.models.models import Chart, Dashboard, DashboardChart
from app.models.resource_share import ResourceShare, ResourceType, SharePermission
from app.models.team import Team
from app.models.user import User, UserStatus
from app.schemas.auth import ShareAllTeamRequest, ShareCreate, ShareResponse, ShareUpdate
from app.services.audit_service import audit

router = APIRouter(prefix="/shares", tags=["shares"])


# ── Cascade helpers ───────────────────────────────────────────────────────────

def _upsert_share(
    db: Session,
    resource_type: ResourceType,
    resource_id: int | str,
    permission: SharePermission,
    shared_by: uuid.UUID,
    *,
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
) -> None:
    """Insert share; update permission if a share already exists."""
    if (user_id is None) == (team_id is None):
        raise ValueError("Exactly one share target must be provided")

    target_values = {"user_id": user_id, "team_id": team_id}
    conflict_name = "uq_resource_shares_user" if user_id is not None else "uq_resource_shares_team"
    stmt = (
        pg_insert(ResourceShare)
        .values(
            resource_type=resource_type,
            resource_id=str(resource_id),
            permission=permission,
            shared_by=shared_by,
            **target_values,
        )
        .on_conflict_do_update(
            constraint=conflict_name,
            set_={"permission": permission, "shared_by": shared_by},
        )
    )
    db.execute(stmt)


def _share_target_filters(*, user_id: uuid.UUID | None = None, team_id: uuid.UUID | None = None):
    if user_id is not None and team_id is None:
        return [ResourceShare.user_id == user_id, ResourceShare.team_id.is_(None)]
    if team_id is not None and user_id is None:
        return [ResourceShare.team_id == team_id, ResourceShare.user_id.is_(None)]
    raise ValueError("Exactly one share target must be provided")


def _load_share_or_404(
    db: Session,
    resource_type: ResourceType,
    resource_id: str,
    share_id: int,
) -> ResourceShare:
    share = (
        db.query(ResourceShare)
        .options(joinedload(ResourceShare.user), joinedload(ResourceShare.team))
        .filter(
            ResourceShare.id == share_id,
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id == str(resource_id),
        )
        .first()
    )
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    return share


def _get_share_for_target(
    db: Session,
    resource_type: ResourceType,
    resource_id: str,
    *,
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
) -> ResourceShare:
    filters = _share_target_filters(user_id=user_id, team_id=team_id)
    share = (
        db.query(ResourceShare)
        .options(joinedload(ResourceShare.user), joinedload(ResourceShare.team))
        .filter(
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id == str(resource_id),
            *filters,
        )
        .first()
    )
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    return share


def cascade_share_dashboard(
    db: Session,
    dashboard_id: int,
    permission: SharePermission,
    shared_by: uuid.UUID,
    *,
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
) -> None:
    """
    Share a dashboard and cascade-share all its charts + their datasets.
    """
    _upsert_share(
        db,
        ResourceType.DASHBOARD,
        dashboard_id,
        permission,
        shared_by,
        user_id=user_id,
        team_id=team_id,
    )

    dataset_ids: set[int] = set()

    dc_rows = (
        db.query(DashboardChart)
        .filter(DashboardChart.dashboard_id == dashboard_id)
        .all()
    )
    for dc in dc_rows:
        chart: Chart | None = db.query(Chart).filter(Chart.id == dc.chart_id).first()
        if not chart:
            continue
        _upsert_share(
            db,
            ResourceType.CHART,
            chart.id,
            permission,
            shared_by,
            user_id=user_id,
            team_id=team_id,
        )

        if chart.dataset_table_id:
            wt = db.query(DatasetTable).filter(
                DatasetTable.id == chart.dataset_table_id
            ).first()
            if wt:
                dataset_ids.add(wt.dataset_id)

    for wid in dataset_ids:
        _upsert_share(
            db,
            ResourceType.DATASET,
            wid,
            permission,
            shared_by,
            user_id=user_id,
            team_id=team_id,
        )

    db.commit()


def _require_dashboard_cascade_access(db: Session, current_user: User, dashboard_id: int) -> None:
    """Dashboard sharing may only cascade resources the user fully controls."""
    dc_rows = (
        db.query(DashboardChart)
        .filter(DashboardChart.dashboard_id == dashboard_id)
        .all()
    )
    for dc in dc_rows:
        chart = db.query(Chart).filter(Chart.id == dc.chart_id).first()
        if not chart:
            continue
        require_full_access(db, current_user, chart, "explore_charts")
        if not chart.dataset_table_id:
            continue
        dataset_table_ref = db.query(DatasetTable).filter(
            DatasetTable.id == chart.dataset_table_id
        ).first()
        if not dataset_table_ref:
            continue
        dataset_obj = db.query(Dataset).filter(
            Dataset.id == dataset_table_ref.dataset_id
        ).first()
        if dataset_obj:
            require_full_access(db, current_user, dataset_obj, "datasets")


def _revoke_cascade(
    db: Session,
    dashboard_id: int,
    *,
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
) -> None:
    """
    Revoke dashboard share and cascade-revoke charts/datasets that
    were ONLY shared via this dashboard (no direct share record).
    """
    # Collect resources linked to dashboard
    dc_rows = (
        db.query(DashboardChart)
        .filter(DashboardChart.dashboard_id == dashboard_id)
        .all()
    )
    child_records: list[tuple[ResourceType, int]] = []
    dataset_ids: set[int] = set()

    for dc in dc_rows:
        chart = db.query(Chart).filter(Chart.id == dc.chart_id).first()
        if not chart:
            continue
        child_records.append((ResourceType.CHART, chart.id))
        if chart.dataset_table_id:
            wt = db.query(DatasetTable).filter(
                DatasetTable.id == chart.dataset_table_id
            ).first()
            if wt:
                dataset_ids.add(wt.dataset_id)

    for wid in dataset_ids:
        child_records.append((ResourceType.DATASET, wid))

    # Delete cascade shares
    filters = _share_target_filters(user_id=user_id, team_id=team_id)
    for rtype, rid in child_records:
        db.query(ResourceShare).filter(
            ResourceShare.resource_type == rtype,
            ResourceShare.resource_id == str(rid),
            *filters,
        ).delete()

    # Delete dashboard share itself
    db.query(ResourceShare).filter(
        ResourceShare.resource_type == ResourceType.DASHBOARD,
        ResourceShare.resource_id == str(dashboard_id),
        *filters,
    ).delete()

    db.commit()


def _resolve_share_target_user(db: Session, body: ShareCreate) -> User:
    if body.user_id is not None:
        target_user = db.query(User).filter(User.id == body.user_id).first()
    else:
        normalized_email = str(body.email).strip().lower()
        target_user = (
            db.query(User)
            .filter(func.lower(User.email) == normalized_email)
            .first()
        )

    if not target_user or target_user.status != UserStatus.ACTIVE:
        raise HTTPException(status_code=404, detail="Target user not found")

    return target_user


def _resolve_share_target_team(db: Session, team_id: uuid.UUID) -> Team:
    target_team = db.query(Team).filter(Team.id == team_id).first()
    if not target_team:
        raise HTTPException(status_code=404, detail="Target team not found")
    return target_team


# ── CRUD Endpoints ────────────────────────────────────────────────────────────

@router.get("/{resource_type}/{resource_id}", response_model=List[ShareResponse])
def list_shares(
    resource_type: ResourceType,
    resource_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all shares for a resource. Only owner or admin can list."""
    require_share_access(db, current_user, resource_type, resource_id)
    shares = (
        db.query(ResourceShare)
        .options(joinedload(ResourceShare.user), joinedload(ResourceShare.team))
        .filter(
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id == resource_id,
        )
        .order_by(ResourceShare.created_at.asc(), ResourceShare.id.asc())
        .all()
    )
    return shares


@router.post("/{resource_type}/{resource_id}", response_model=ShareResponse,
             status_code=status.HTTP_201_CREATED)
def add_share(
    resource_type: ResourceType,
    resource_id: str,
    body: ShareCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Share a resource with a user.
    Dashboards trigger cascade-share of charts + datasets.
    """
    require_share_access(db, current_user, resource_type, resource_id)

    target_user_id: uuid.UUID | None = None
    target_team_id: uuid.UUID | None = None
    if body.team_id is not None:
        target_team_id = _resolve_share_target_team(db, body.team_id).id
    else:
        target_user_id = _resolve_share_target_user(db, body).id

    if resource_type == ResourceType.DASHBOARD:
        _require_dashboard_cascade_access(db, current_user, int(resource_id))
        cascade_share_dashboard(
            db,
            int(resource_id),
            body.permission,
            current_user.id,
            user_id=target_user_id,
            team_id=target_team_id,
        )
    else:
        _upsert_share(
            db,
            resource_type,
            resource_id,
            body.permission,
            current_user.id,
            user_id=target_user_id,
            team_id=target_team_id,
        )
        db.commit()

    # Granting access to a resource is a permission change; it belongs in the same
    # trail as one. SHARE_CREATED was declared in AuditAction and never emitted.
    audit(
        db,
        AuditAction.SHARE_CREATED,
        request=request,
        user_id=current_user.id,
        resource_type=resource_type.value,
        resource_id=str(resource_id),
        details={
            "permission": body.permission.value if hasattr(body.permission, "value") else str(body.permission),
            "target_user_id": str(target_user_id) if target_user_id else None,
            "target_team_id": str(target_team_id) if target_team_id else None,
            "cascaded": resource_type == ResourceType.DASHBOARD,
        },
    )

    return _get_share_for_target(
        db,
        resource_type,
        resource_id,
        user_id=target_user_id,
        team_id=target_team_id,
    )


@router.put("/{resource_type}/{resource_id}/entries/{share_id}", response_model=ShareResponse)
def update_share_entry(
    resource_type: ResourceType,
    resource_id: str,
    share_id: int,
    body: ShareUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update permission on an existing direct user share or team share."""
    require_share_access(db, current_user, resource_type, resource_id)

    share = _load_share_or_404(db, resource_type, resource_id, share_id)
    if resource_type == ResourceType.DASHBOARD:
        _require_dashboard_cascade_access(db, current_user, int(resource_id))
        cascade_share_dashboard(
            db,
            int(resource_id),
            body.permission,
            current_user.id,
            user_id=share.user_id,
            team_id=share.team_id,
        )
        return _load_share_or_404(db, resource_type, resource_id, share_id)

    share.permission = body.permission
    db.commit()
    db.refresh(share)
    return share


@router.put("/{resource_type}/{resource_id}/{user_id}", response_model=ShareResponse)
def update_share(
    resource_type: ResourceType,
    resource_id: str,
    user_id: uuid.UUID,
    body: ShareUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Backward-compatible update for direct user shares."""
    require_share_access(db, current_user, resource_type, resource_id)
    share = _get_share_for_target(db, resource_type, resource_id, user_id=user_id)
    return update_share_entry(resource_type, resource_id, share.id, body, db, current_user)


@router.delete("/{resource_type}/{resource_id}/{user_id}",
               status_code=status.HTTP_204_NO_CONTENT)
def revoke_share(
    resource_type: ResourceType,
    resource_id: str,
    user_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Backward-compatible revoke for direct user shares."""
    require_share_access(db, current_user, resource_type, resource_id)
    share = _get_share_for_target(db, resource_type, resource_id, user_id=user_id)
    revoke_share_entry(resource_type, resource_id, share.id, request, db, current_user)


@router.delete("/{resource_type}/{resource_id}/entries/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_share_entry(
    resource_type: ResourceType,
    resource_id: str,
    share_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Revoke direct user shares or team shares by share entry id."""
    require_share_access(db, current_user, resource_type, resource_id)

    share = _load_share_or_404(db, resource_type, resource_id, share_id)
    audit(
        db,
        AuditAction.SHARE_REVOKED,
        request=request,
        user_id=current_user.id,
        resource_type=resource_type.value,
        resource_id=str(resource_id),
        details={
            "target_user_id": str(share.user_id) if share.user_id else None,
            "target_team_id": str(share.team_id) if share.team_id else None,
        },
    )
    if resource_type == ResourceType.DASHBOARD:
        _revoke_cascade(
            db,
            int(resource_id),
            user_id=share.user_id,
            team_id=share.team_id,
        )
        return

    db.delete(share)
    db.commit()


@router.post("/{resource_type}/{resource_id}/all-team",
             status_code=status.HTTP_410_GONE)
def share_all_team(
    resource_type: ResourceType,
    resource_id: str,
    body: ShareAllTeamRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Deprecated: team sharing is now limited to configured teams only."""
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="Deprecated. Share with a configured team instead.",
    )
