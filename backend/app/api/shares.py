"""
Sharing endpoints + cascade share logic.

Cascade share when sharing a dashboard:
  Dashboard → Charts → (workspace_table_id → workspace)
"""

import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_full_access
from app.models.models import Chart, Dashboard, DashboardChart, DataSource
from app.models.dataset_workspace import DatasetWorkspace, DatasetWorkspaceTable
from app.models.resource_share import ResourceShare, ResourceType, SharePermission
from app.models.user import User, UserStatus
from app.schemas.auth import ShareAllTeamRequest, ShareCreate, ShareResponse, ShareUpdate

router = APIRouter(prefix="/shares", tags=["shares"])


# ── Cascade helpers ───────────────────────────────────────────────────────────

def _upsert_share(
    db: Session,
    resource_type: ResourceType,
    resource_id: int,
    user_id: uuid.UUID,
    permission: SharePermission,
    shared_by: uuid.UUID,
) -> None:
    """Insert share; update permission if a share already exists."""
    stmt = (
        pg_insert(ResourceShare)
        .values(
            resource_type=resource_type,
            resource_id=str(resource_id),
            user_id=user_id,
            permission=permission,
            shared_by=shared_by,
        )
        .on_conflict_do_update(
            constraint="uq_resource_shares",
            set_={"permission": permission, "shared_by": shared_by},
        )
    )
    db.execute(stmt)


def cascade_share_dashboard(
    db: Session,
    dashboard_id: int,
    user_id: uuid.UUID,
    permission: SharePermission,
    shared_by: uuid.UUID,
) -> None:
    """
    Share a dashboard and cascade-share all its charts + their datasets/workspaces.
    """
    _upsert_share(db, ResourceType.DASHBOARD, dashboard_id, user_id, permission, shared_by)

    workspace_ids: set[int] = set()

    dc_rows = (
        db.query(DashboardChart)
        .filter(DashboardChart.dashboard_id == dashboard_id)
        .all()
    )
    for dc in dc_rows:
        chart: Chart | None = db.query(Chart).filter(Chart.id == dc.chart_id).first()
        if not chart:
            continue
        _upsert_share(db, ResourceType.CHART, chart.id, user_id, permission, shared_by)

        if chart.workspace_table_id:
            wt = db.query(DatasetWorkspaceTable).filter(
                DatasetWorkspaceTable.id == chart.workspace_table_id
            ).first()
            if wt:
                workspace_ids.add(wt.workspace_id)

    for wid in workspace_ids:
        _upsert_share(db, ResourceType.WORKSPACE, wid, user_id, permission, shared_by)

    db.commit()


def _revoke_cascade(
    db: Session,
    dashboard_id: int,
    user_id: uuid.UUID,
) -> None:
    """
    Revoke dashboard share and cascade-revoke charts/datasets/workspaces that
    were ONLY shared via this dashboard (no direct share record).
    """
    # Collect resources linked to dashboard
    dc_rows = (
        db.query(DashboardChart)
        .filter(DashboardChart.dashboard_id == dashboard_id)
        .all()
    )
    child_records: list[tuple[ResourceType, int]] = []
    workspace_ids: set[int] = set()

    for dc in dc_rows:
        chart = db.query(Chart).filter(Chart.id == dc.chart_id).first()
        if not chart:
            continue
        child_records.append((ResourceType.CHART, chart.id))
        if chart.workspace_table_id:
            wt = db.query(DatasetWorkspaceTable).filter(
                DatasetWorkspaceTable.id == chart.workspace_table_id
            ).first()
            if wt:
                workspace_ids.add(wt.workspace_id)

    for wid in workspace_ids:
        child_records.append((ResourceType.WORKSPACE, wid))

    # Delete cascade shares
    for rtype, rid in child_records:
        db.query(ResourceShare).filter(
            ResourceShare.resource_type == rtype,
            ResourceShare.resource_id == str(rid),
            ResourceShare.user_id == user_id,
        ).delete()

    # Delete dashboard share itself
    db.query(ResourceShare).filter(
        ResourceShare.resource_type == ResourceType.DASHBOARD,
        ResourceShare.resource_id == str(dashboard_id),
        ResourceShare.user_id == user_id,
    ).delete()

    db.commit()


# ── Resource lookup for ownership check ───────────────────────────────────────

_RESOURCE_MODEL_MAP = {
    ResourceType.DASHBOARD: (Dashboard, "dashboards"),
    ResourceType.CHART: (Chart, "explore_charts"),
    ResourceType.DATASOURCE: (DataSource, "data_sources"),
    ResourceType.WORKSPACE: (DatasetWorkspace, "workspaces"),
}


def _check_share_ownership(db: Session, current_user: User, resource_type: ResourceType, resource_id: str):
    """Verify the current user owns the resource or has full module access before allowing share operations."""
    model_info = _RESOURCE_MODEL_MAP.get(resource_type)
    if not model_info:
        return  # Unknown types — skip check
    model, module = model_info
    resource = db.query(model).filter(model.id == int(resource_id)).first()
    if not resource:
        raise HTTPException(status_code=404, detail="Resource not found")
    require_full_access(db, current_user, resource, module)


# ── CRUD Endpoints ────────────────────────────────────────────────────────────

@router.get("/{resource_type}/{resource_id}", response_model=List[ShareResponse])
def list_shares(
    resource_type: ResourceType,
    resource_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all shares for a resource. Only owner or admin can list."""
    shares = (
        db.query(ResourceShare)
        .filter(
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id == resource_id,
        )
        .all()
    )
    return shares


@router.post("/{resource_type}/{resource_id}", response_model=ShareResponse,
             status_code=status.HTTP_201_CREATED)
def add_share(
    resource_type: ResourceType,
    resource_id: str,
    body: ShareCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Share a resource with a user.
    Dashboards trigger cascade-share of charts + datasets/workspaces.
    """
    _check_share_ownership(db, current_user, resource_type, resource_id)

    target_user = db.query(User).filter(User.id == body.user_id).first()
    if not target_user:
        raise HTTPException(status_code=404, detail="Target user not found")

    if resource_type == ResourceType.DASHBOARD:
        cascade_share_dashboard(db, int(resource_id), body.user_id, body.permission, current_user.id)
        share = db.query(ResourceShare).filter(
            ResourceShare.resource_type == ResourceType.DASHBOARD,
            ResourceShare.resource_id == resource_id,
            ResourceShare.user_id == body.user_id,
        ).first()
    else:
        _upsert_share(db, resource_type, resource_id, body.user_id, body.permission, current_user.id)
        db.commit()
        share = db.query(ResourceShare).filter(
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id == resource_id,
            ResourceShare.user_id == body.user_id,
        ).first()

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
    """Update permission on an existing share."""
    _check_share_ownership(db, current_user, resource_type, resource_id)

    share = db.query(ResourceShare).filter(
        ResourceShare.resource_type == resource_type,
        ResourceShare.resource_id == resource_id,
        ResourceShare.user_id == user_id,
    ).first()
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")

    share.permission = body.permission
    db.commit()
    db.refresh(share)
    return share


@router.delete("/{resource_type}/{resource_id}/{user_id}",
               status_code=status.HTTP_204_NO_CONTENT)
def revoke_share(
    resource_type: ResourceType,
    resource_id: str,
    user_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Revoke access. For dashboards, also revokes cascaded chart/dataset shares."""
    _check_share_ownership(db, current_user, resource_type, resource_id)

    if resource_type == ResourceType.DASHBOARD:
        _revoke_cascade(db, int(resource_id), user_id)
        return

    deleted = db.query(ResourceShare).filter(
        ResourceShare.resource_type == resource_type,
        ResourceShare.resource_id == resource_id,
        ResourceShare.user_id == user_id,
    ).delete()
    if not deleted:
        raise HTTPException(status_code=404, detail="Share not found")
    db.commit()


@router.post("/{resource_type}/{resource_id}/all-team",
             status_code=status.HTTP_204_NO_CONTENT)
def share_all_team(
    resource_type: ResourceType,
    resource_id: str,
    body: ShareAllTeamRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Share a resource with ALL active users (except the current user)."""
    _check_share_ownership(db, current_user, resource_type, resource_id)

    active_users = (
        db.query(User)
        .filter(User.status == UserStatus.ACTIVE, User.id != current_user.id)
        .all()
    )
    for user in active_users:
        if resource_type == ResourceType.DASHBOARD:
            cascade_share_dashboard(db, int(resource_id), user.id, body.permission, current_user.id)
        else:
            _upsert_share(db, resource_type, resource_id, user.id, body.permission, current_user.id)

    if resource_type != ResourceType.DASHBOARD:
        db.commit()
