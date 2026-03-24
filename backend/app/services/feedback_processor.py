"""
FeedbackProcessor — apply AI feedback to the knowledge system.

When a user says "the AI used the wrong table/chart", we:
1. Add the original user_query to query_aliases of the CORRECT resource
   so future searches match it directly.
2. Set description_source="feedback" (respects user edits: "user" > "feedback").
3. Re-embed the resource so the updated aliases are indexed.

This is the core of the Feedback-Driven Knowledge System feedback loop.
"""
import logging
from datetime import datetime
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


class FeedbackProcessor:

    @staticmethod
    def process(feedback, db: Session) -> None:
        """
        Process a single AIFeedback record.
        Safe to call in BackgroundTasks — all errors are caught.
        """
        if not feedback.correct_resource_id or not feedback.correct_resource_type:
            return  # Nothing to learn from

        user_query = (feedback.user_query or "").strip()
        if not user_query:
            return

        try:
            if feedback.correct_resource_type == "workspace_table":
                FeedbackProcessor._process_table_feedback(
                    db, feedback.correct_resource_id, user_query
                )
            elif feedback.correct_resource_type == "chart":
                FeedbackProcessor._process_chart_feedback(
                    db, feedback.correct_resource_id, user_query
                )
        except Exception as exc:
            logger.warning("FeedbackProcessor: process failed — %s", exc)
            try:
                db.rollback()
            except Exception:
                pass

    @staticmethod
    def _process_table_feedback(db: Session, table_id: int, user_query: str) -> None:
        from app.models.dataset_workspace import DatasetWorkspaceTable
        from app.services.embedding_service import EmbeddingService

        table = db.query(DatasetWorkspaceTable).filter(
            DatasetWorkspaceTable.id == table_id
        ).first()
        if not table:
            return

        # Add query to aliases if not already there
        aliases = list(table.query_aliases or [])
        if user_query not in aliases:
            aliases.append(user_query)
            table.query_aliases = aliases

        # Only set feedback source if not user-edited
        if table.description_source != "user":
            table.description_source = "feedback"
        table.description_updated_at = datetime.utcnow()
        table.generation_status = "succeeded"
        table.generation_error = None
        table.generation_finished_at = datetime.utcnow()
        table.stale_reason = None

        db.commit()
        logger.info(
            "FeedbackProcessor: table %s — added alias '%s'",
            table_id, user_query[:50],
        )

        # Re-embed with updated aliases
        EmbeddingService.embed_table(db, table_id)

    @staticmethod
    def _process_chart_feedback(db: Session, chart_id: int, user_query: str) -> None:
        from app.models.models import Chart, ChartMetadata
        from app.services.embedding_service import EmbeddingService
        chart = db.query(Chart).filter(Chart.id == chart_id).first()
        if not chart:
            return

        meta = db.query(ChartMetadata).filter(
            ChartMetadata.chart_id == chart_id
        ).first()
        if not meta:
            meta = ChartMetadata(chart_id=chart_id)
            db.add(meta)

        # Add query to aliases if not already there
        aliases = list(meta.query_aliases or [])
        if user_query not in aliases:
            aliases.append(user_query)
            meta.query_aliases = aliases

        # Only set feedback source if not user-edited
        if meta.description_source != "user":
            meta.description_source = "feedback"
        meta.description_updated_at = datetime.utcnow()
        meta.generation_status = "succeeded"
        meta.generation_error = None
        meta.generation_finished_at = datetime.utcnow()
        meta.stale_reason = None

        db.commit()
        logger.info(
            "FeedbackProcessor: chart %s — added alias '%s'",
            chart_id, user_query[:50],
        )

        # Re-embed with updated aliases
        EmbeddingService.embed_chart(db, chart_id)
