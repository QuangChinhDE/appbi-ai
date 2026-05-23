"""Object-level permission helpers for Workboard dataset bindings."""
from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.dependencies import require_view_access
from app.models.dataset import Dataset
from app.models.user import User


def require_dataset_binding_access(
    db: Session,
    current_user: User,
    dataset_id: int,
) -> Dataset:
    dataset = db.query(Dataset).filter(Dataset.id == int(dataset_id)).first()
    if dataset is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Dataset not found",
        )
    require_view_access(db, current_user, dataset, "datasets")
    return dataset
