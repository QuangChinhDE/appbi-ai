"""
Feedback API — capture AI correction feedback from users.

POST /ai/feedback    — submit feedback (any authenticated user)
GET  /ai/feedback/stats — usage stats (admin only)
"""
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.models.ai_feedback import AIFeedback
from app.models.user import User
from app.services.feedback_processor import FeedbackProcessor

router = APIRouter(prefix="/ai", tags=["ai-feedback"])


class FeedbackCreate(BaseModel):
    session_id: Optional[str] = None
    message_id: Optional[str] = None
    user_query: str
    feedback_type: str  # "wrong_table" | "wrong_chart" | "unclear" | "other"
    correct_resource_type: Optional[str] = None   # "chart" | "workspace_table"
    correct_resource_id: Optional[int] = None
    ai_matched_resource_type: Optional[str] = None
    ai_matched_resource_id: Optional[int] = None
    notes: Optional[str] = None
    is_positive: bool = False


@router.post("/feedback")
def submit_feedback(
    body: FeedbackCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Submit AI correction feedback. Triggers background knowledge update."""
    feedback = AIFeedback(
        session_id=body.session_id,
        message_id=body.message_id,
        user_id=current_user.id,
        user_query=body.user_query,
        feedback_type=body.feedback_type,
        correct_resource_type=body.correct_resource_type,
        correct_resource_id=body.correct_resource_id,
        ai_matched_resource_type=body.ai_matched_resource_type,
        ai_matched_resource_id=body.ai_matched_resource_id,
        notes=body.notes,
        is_positive=body.is_positive,
    )
    db.add(feedback)
    db.commit()
    db.refresh(feedback)

    # Process in background — update query_aliases + re-embed
    if body.correct_resource_id and body.correct_resource_type:
        background_tasks.add_task(FeedbackProcessor.process, feedback, db)

    return {"status": "ok", "feedback_id": str(feedback.id)}


@router.get("/feedback/stats")
def get_feedback_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("user_management", "view")),
):
    """Get feedback statistics. Requires user_management >= view permission."""
    from sqlalchemy import func
    from app.models.ai_feedback import AIFeedback as FB

    total = db.query(func.count(FB.id)).scalar() or 0
    positive = db.query(func.count(FB.id)).filter(FB.is_positive == True).scalar() or 0
    negative = total - positive

    # Top corrected workspace tables
    top_tables = (
        db.query(FB.correct_resource_id, func.count(FB.id).label("cnt"))
        .filter(
            FB.correct_resource_type == "workspace_table",
            FB.correct_resource_id.isnot(None),
        )
        .group_by(FB.correct_resource_id)
        .order_by(func.count(FB.id).desc())
        .limit(5)
        .all()
    )

    # Top corrected charts
    top_charts = (
        db.query(FB.correct_resource_id, func.count(FB.id).label("cnt"))
        .filter(
            FB.correct_resource_type == "chart",
            FB.correct_resource_id.isnot(None),
        )
        .group_by(FB.correct_resource_id)
        .order_by(func.count(FB.id).desc())
        .limit(5)
        .all()
    )

    return {
        "total": total,
        "positive_count": positive,
        "negative_count": negative,
        "top_corrected_tables": [
            {"resource_id": row[0], "count": row[1]} for row in top_tables
        ],
        "top_corrected_charts": [
            {"resource_id": row[0], "count": row[1]} for row in top_charts
        ],
    }
