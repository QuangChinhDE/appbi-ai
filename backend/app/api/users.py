"""
User management endpoints.
"""

import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import require_permission, get_current_user
from app.models.user import User, UserStatus
from app.schemas.auth import UserCreate, UserResponse, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


class ShareableUser(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    email: str
    full_name: str


@router.get("/shareable", response_model=List[ShareableUser])
def list_shareable_users(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "view")),
):
    """List active users (id, email, full_name) for sharing dialogs. Editor+Admin."""
    return (
        db.query(User)
        .filter(User.status == UserStatus.ACTIVE)
        .order_by(User.full_name)
        .all()
    )


@router.get("/", response_model=List[UserResponse])
def list_users(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "view")),
):
    """List all users (admin and editor)."""
    return db.query(User).offset(skip).limit(limit).all()


@router.get("/{user_id}", response_model=UserResponse)
def get_user(
    user_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "full")),
):
    """Get user by ID (admin only)."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.post("/", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    body: UserCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_permission("settings", "full")),
):
    """Create a new user (admin only). Sets status=active immediately."""
    from app.api.auth import hash_password

    if db.query(User).filter(User.email == body.email).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Email '{body.email}' is already registered",
        )

    user = User(
        email=body.email,
        password_hash=hash_password(body.password),
        full_name=body.full_name,
        invited_by=admin.id,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.put("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: uuid.UUID,
    body: UserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_permission("settings", "full")),
):
    """Update user role or status (admin only). Admin cannot deactivate themselves."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if body.status is not None and body.status.value == "deactivated" and user.id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot deactivate your own account",
        )

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(user, field, value)

    db.commit()
    db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def deactivate_user(
    user_id: uuid.UUID,
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

    from app.models.user import UserStatus
    user.status = UserStatus.DEACTIVATED
    db.commit()
