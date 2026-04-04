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
    correct_resource_type: Optional[str] = None   # "chart" | "dataset_table"
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
    month: Optional[str] = None,  # e.g. "2026-03"; omit for all-time
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("settings", "full")),
):
    """Get feedback statistics. Requires settings = full permission.
    Pass ?month=YYYY-MM to filter to a specific calendar month.
    """
    from sqlalchemy import func
    from app.models.ai_feedback import AIFeedback as FB
    import datetime as _dt

    base_q = db.query(FB)
    if month:
        try:
            parsed = _dt.datetime.strptime(month, "%Y-%m")
            month_start = parsed.replace(day=1, hour=0, minute=0, second=0)
            if parsed.month == 12:
                month_end = parsed.replace(year=parsed.year + 1, month=1, day=1)
            else:
                month_end = parsed.replace(month=parsed.month + 1, day=1)
            base_q = base_q.filter(FB.created_at >= month_start, FB.created_at < month_end)
        except ValueError:
            pass  # invalid format — ignore filter

    total = base_q.with_entities(func.count(FB.id)).scalar() or 0
    positive = base_q.filter(FB.is_positive == True).with_entities(func.count(FB.id)).scalar() or 0
    negative = total - positive

    # Top corrected dataset tables (respects month filter)
    top_tables = (
        base_q.with_entities(FB.correct_resource_id, func.count(FB.id).label("cnt"))
        .filter(
            FB.correct_resource_type == "dataset_table",
            FB.correct_resource_id.isnot(None),
        )
        .group_by(FB.correct_resource_id)
        .order_by(func.count(FB.id).desc())
        .limit(5)
        .all()
    )

    # Top corrected charts (respects month filter)
    top_charts = (
        base_q.with_entities(FB.correct_resource_id, func.count(FB.id).label("cnt"))
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
