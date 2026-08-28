"""
User management endpoints.
"""

import uuid
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.database import get_db
from app.core.share_access import require_share_access
from app.core.dependencies import get_current_user, require_permission
from app.core.user_deletion import reassign_user_resources, summarize_owned_resources
from app.models.audit_log import AuditAction
from app.models.resource_share import ResourceType
from app.models.team import Team, TeamMembership
from app.models.user import AuthProvider, User, UserStatus
from app.schemas.auth import UserCreate, UserResponse, UserUpdate
from app.services.audit_service import audit

router = APIRouter(prefix="/users", tags=["users"])

#: Ceiling on one sharing-picker response. Enough to pick from, far short of a
#: directory export.
_SHAREABLE_RESULT_LIMIT = 25


def _send_invite_email(db: Session, invited: User, invited_by: User) -> None:
    """Best-effort invite email. `create_user` used to leave the invited user
    with no signal at all that an account was created for them — only an
    audit-log row admins could see. Never raises: a failed/unconfigured SMTP
    must not block user creation."""
    import logging
    from app.services.quality_email_service import send_quality_report
    from app.services.user_notification_service import notify_user

    logger = logging.getLogger(__name__)
    inviter_name = invited_by.full_name or invited_by.email
    subject = "Bạn đã được mời vào AppBI"
    html_body = (
        f"<p>Xin chào {invited.full_name or invited.email},</p>"
        f"<p><b>{inviter_name}</b> đã tạo tài khoản AppBI cho bạn với email "
        f"<b>{invited.email}</b>.</p>"
        f"<p>Đăng nhập để bắt đầu sử dụng.</p>"
    )
    text_body = f"{inviter_name} đã tạo tài khoản AppBI cho bạn ({invited.email}). Đăng nhập để bắt đầu."
    try:
        delivered = send_quality_report(
            subject=subject, html_body=html_body, text_body=text_body,
            primary_recipient=invited.email,
        )
        if not delivered:
            logger.info("[users] invite email not delivered (SMTP unconfigured) to %s", invited.email)
            notify_user(
                db, invited_by.id,
                level="warning", title="Email mời chưa được gửi",
                description=f"Đã tạo tài khoản {invited.email} nhưng SMTP chưa cấu hình — hãy báo trực tiếp cho người dùng.",
                source="invite",
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[users] invite email failed for %s: %s", invited.email, exc)


def _normalize_email(email: str) -> str:
    return email.strip().lower()


class ShareableUser(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    email: str
    full_name: str


class UserDeletionImpact(BaseModel):
    """What a permanent delete will touch, so the admin can confirm knowingly."""
    status: str
    counts: Dict[str, int]
    total_owned: int
    reassign_to_email: str


def _base_user_query(db: Session):
    return db.query(User).options(
        selectinload(User.teams),
        selectinload(User.team_memberships),
    )


def _load_user_or_404(db: Session, user_id: uuid.UUID) -> User:
    user = _base_user_query(db).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


def _replace_user_teams(db: Session, user: User, team_ids: list[uuid.UUID]) -> None:
    unique_team_ids = list(dict.fromkeys(team_ids))
    if not unique_team_ids:
        user.team_memberships = []
        return

    teams = db.query(Team).filter(Team.id.in_(unique_team_ids)).all()
    resolved_team_ids = {team.id for team in teams}
    missing = [str(team_id) for team_id in unique_team_ids if team_id not in resolved_team_ids]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown team ids: {', '.join(missing)}",
        )

    existing_memberships = {membership.team_id: membership for membership in user.team_memberships}
    user.team_memberships = [
        existing_memberships.get(team_id) or TeamMembership(team_id=team_id)
        for team_id in unique_team_ids
    ]


@router.get("/shareable", response_model=List[ShareableUser])
def list_shareable_users(
    resource_type: ResourceType = Query(...),
    resource_id: str = Query(..., min_length=1),
    q: str = Query("", max_length=120, description="Name or email fragment"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Users matching *q*, for an authorized sharing dialog.

    SEARCH, NOT A DIRECTORY DUMP. This used to return every active user — email and
    full name — to anyone who could share any one resource, which is to say to
    anyone who had ever made a dashboard. That is a ready-made phishing list and an
    account-enumeration oracle, handed out by a picker.

    An empty query returns the people already reachable (teammates), so the dialog
    still opens with something useful rather than a blank list.
    """
    require_share_access(db, current_user, resource_type, resource_id)

    base = db.query(User).filter(User.status == UserStatus.ACTIVE)
    term = q.strip()

    if term:
        pattern = f"%{term.lower()}%"
        base = base.filter(
            or_(
                func.lower(User.email).like(pattern),
                func.lower(User.full_name).like(pattern),
            )
        )
    else:
        # No search term → teammates only.
        my_team_ids = select(TeamMembership.team_id).where(
            TeamMembership.user_id == current_user.id
        )
        base = base.filter(
            User.id.in_(
                select(TeamMembership.user_id).where(
                    TeamMembership.team_id.in_(my_team_ids)
                )
            )
        )

    return base.order_by(User.full_name).limit(_SHAREABLE_RESULT_LIMIT).all()


@router.get("/", response_model=List[UserResponse])
def list_users(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    # `settings` only accepts none|full in the matrix (MODULE_ALLOWED_LEVELS), so
    # "view" was a level no admin could actually grant — this read was
    # admin-only in practice while the docstring promised otherwise. Stating the
    # level that is real beats asking for one that cannot exist.
    _: User = Depends(require_permission("settings", "full")),
):
    """List all users (admin only)."""
    return _base_user_query(db).order_by(User.full_name.asc()).offset(skip).limit(limit).all()


@router.get("/{user_id}", response_model=UserResponse)
def get_user(
    user_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "full")),
):
    """Get user by ID (admin only)."""
    return _load_user_or_404(db, user_id)


@router.post("/", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    body: UserCreate,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_permission("settings", "full")),
):
    """Create a new user (admin only). Sets status=active immediately."""
    from app.api.auth import hash_password
    normalized_email = _normalize_email(body.email)

    if db.query(User).filter(User.email.ilike(normalized_email)).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Email '{normalized_email}' is already registered",
        )

    user = User(
        email=normalized_email,
        password_hash=hash_password(body.password) if body.password else None,
        auth_provider=body.auth_provider or AuthProvider.GOOGLE.value,
        full_name=body.full_name,
        invited_by=admin.id,
    )
    db.add(user)
    db.flush()
    _replace_user_teams(db, user, body.team_ids)
    db.commit()
    audit(
        db,
        AuditAction.USER_CREATED,
        request=request,
        user_id=admin.id,
        resource_type="user",
        resource_id=str(user.id),
        details={"email": user.email, "auth_provider": user.auth_provider},
    )
    _send_invite_email(db, user, admin)
    return _load_user_or_404(db, user.id)


@router.put("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: uuid.UUID,
    body: UserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_permission("settings", "full")),
):
    """Update user role or status (admin only). Admin cannot deactivate themselves."""
    user = _load_user_or_404(db, user_id)

    if body.status is not None and body.status.value == "deactivated" and user.id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot deactivate your own account",
        )

    payload = body.model_dump(exclude_unset=True)
    team_ids = payload.pop("team_ids", None)

    for field, value in payload.items():
        setattr(user, field, value)

    if team_ids is not None:
        _replace_user_teams(db, user, team_ids)

    db.commit()
    return _load_user_or_404(db, user.id)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def deactivate_user(
    user_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_permission("settings", "full")),
):
    """Deactivate a user (soft delete). Admin cannot deactivate themselves."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot deactivate your own account",
        )

    user.status = UserStatus.DEACTIVATED
    db.commit()
    audit(
        db,
        AuditAction.USER_DEACTIVATED,
        request=request,
        user_id=admin.id,
        resource_type="user",
        resource_id=str(user.id),
        details={"email": user.email},
    )


# Resource keys counted as "owned" (reassigned on delete). shares_given / api_tokens
# are cascade-deleted, reported separately.
_OWNED_RESOURCE_KEYS = ("data_sources", "datasets", "explore_charts", "dashboards", "workboards")


@router.get("/{user_id}/deletion-impact", response_model=UserDeletionImpact)
def get_user_deletion_impact(
    user_id: uuid.UUID,
    db: Session = Depends(get_db),
    admin: User = Depends(require_permission("settings", "full")),
):
    """Preview what a permanent delete does: owned resources are reassigned to the
    acting admin; shares and API tokens are removed."""
    user = _load_user_or_404(db, user_id)
    counts = summarize_owned_resources(db, user.id)
    total_owned = sum(counts.get(key, 0) for key in _OWNED_RESOURCE_KEYS)
    return UserDeletionImpact(
        status=user.status.value,
        counts=counts,
        total_owned=total_owned,
        reassign_to_email=admin.email,
    )


@router.delete("/{user_id}/permanent", status_code=status.HTTP_204_NO_CONTENT)
def delete_user_permanently(
    user_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_permission("settings", "full")),
):
    """Permanently delete a user. Requires the account to be deactivated first;
    reassigns their owned resources to the acting admin so nothing goes dark,
    then removes the row (cascading tokens, permissions, memberships, shares)."""
    user = _load_user_or_404(db, user_id)

    if user.id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot delete your own account",
        )
    if user.status != UserStatus.DEACTIVATED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Deactivate the account before deleting it permanently",
        )

    deleted_email = user.email
    reassign_user_resources(db, user.id, admin.id)
    db.delete(user)
    db.commit()
    audit(
        db,
        AuditAction.USER_DEACTIVATED,
        request=request,
        user_id=admin.id,
        resource_type="user",
        resource_id=str(user_id),
        details={"email": deleted_email, "permanent": True,
                 "resources_reassigned_to": admin.email},
    )
