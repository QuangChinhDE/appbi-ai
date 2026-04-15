"""
CRUD service for report templates.
"""
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.report_template import ReportTemplate
from app.schemas.report_template import (
    ReportTemplateCreate,
    ReportTemplateUpdate,
)
from app.core.logging import get_logger

logger = get_logger(__name__)


class ReportTemplateService:
    """Service for report-template operations."""

    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[ReportTemplate]:
        return (
            db.query(ReportTemplate)
            .order_by(ReportTemplate.updated_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    @staticmethod
    def get_by_id(db: Session, template_id: int) -> Optional[ReportTemplate]:
        return db.query(ReportTemplate).filter(ReportTemplate.id == template_id).first()

    @staticmethod
    def _serialize_blocks(blocks):
        """Serialize blocks — handles both List[TemplateBlock] and SheetData dict."""
        if isinstance(blocks, dict):
            # SheetData v2 format — store as-is
            return blocks
        if isinstance(blocks, list):
            return [
                b.model_dump() if hasattr(b, "model_dump") else b
                for b in blocks
            ]
        return blocks

    @staticmethod
    def create(
        db: Session,
        payload: ReportTemplateCreate,
        owner_id=None,
    ) -> ReportTemplate:
        db_obj = ReportTemplate(
            name=payload.name,
            description=payload.description,
            page_size=payload.page_size,
            orientation=payload.orientation,
            blocks=ReportTemplateService._serialize_blocks(payload.blocks),
            filters=payload.filters or [],
            owner_id=owner_id,
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        logger.info("Created report template: %s (id=%s)", db_obj.name, db_obj.id)
        return db_obj

    @staticmethod
    def update(
        db: Session,
        template_id: int,
        payload: ReportTemplateUpdate,
    ) -> Optional[ReportTemplate]:
        db_obj = db.query(ReportTemplate).filter(ReportTemplate.id == template_id).first()
        if not db_obj:
            return None

        update_data = payload.model_dump(exclude_unset=True)

        # Serialise blocks if present
        if "blocks" in update_data and update_data["blocks"] is not None:
            update_data["blocks"] = ReportTemplateService._serialize_blocks(
                update_data["blocks"]
            )

        for key, value in update_data.items():
            setattr(db_obj, key, value)

        db.commit()
        db.refresh(db_obj)
        logger.info("Updated report template id=%s", template_id)
        return db_obj

    @staticmethod
    def delete(db: Session, template_id: int) -> bool:
        db_obj = db.query(ReportTemplate).filter(ReportTemplate.id == template_id).first()
        if not db_obj:
            return False
        db.delete(db_obj)
        db.commit()
        logger.info("Deleted report template id=%s", template_id)
        return True
