"""
Per-user notification feed — GET/PATCH surface for the bell icon.

Personal-scoped, not admin-configurable, so unlike /observability this
router has no module-floor gate: any authenticated user reads/writes only
their own rows.
"""
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core import get_db
from app.core.dependencies import get_current_user
from app.models.user import User
from app.models.user_notification import UserNotification
from app.services.user_notification_service import notification_dict

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
def list_notifications(
    unread_only: bool = Query(False),
    limit: int = Query(50, le=200),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    q = db.query(UserNotification).filter(UserNotification.user_id == user.id)
    if unread_only:
        q = q.filter(UserNotification.read == False)  # noqa: E712
    rows = q.order_by(UserNotification.created_at.desc()).limit(limit).all()
    return [notification_dict(n) for n in rows]


@router.get("/unread-count")
def unread_count(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, int]:
    count = db.query(UserNotification).filter(
        UserNotification.user_id == user.id,
        UserNotification.read == False,  # noqa: E712
    ).count()
    return {"unreadCount": count}


def _owned_notification(db: Session, user: User, notification_id: int) -> UserNotification:
    row = db.query(UserNotification).filter(
        UserNotification.id == notification_id,
        UserNotification.user_id == user.id,
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Notification not found")
    return row


@router.patch("/{notification_id}/read")
def mark_read(
    notification_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    row = _owned_notification(db, user, notification_id)
    row.read = True
    db.commit()
    return notification_dict(row)


@router.post("/read-all")
def mark_all_read(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, int]:
    updated = db.query(UserNotification).filter(
        UserNotification.user_id == user.id,
        UserNotification.read == False,  # noqa: E712
    ).update({"read": True})
    db.commit()
    return {"updated": updated}


@router.delete("/{notification_id}", status_code=204)
def delete_notification(
    notification_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    row = _owned_notification(db, user, notification_id)
    db.delete(row)
    db.commit()


@router.delete("")
def clear_all(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, int]:
    deleted = db.query(UserNotification).filter(UserNotification.user_id == user.id).delete()
    db.commit()
    return {"deleted": deleted}
