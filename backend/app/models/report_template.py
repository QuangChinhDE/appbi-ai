"""
ReportTemplate model — customizable report templates with drag-drop blocks.
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.core.database import Base


class ReportTemplate(Base):
    """
    A report template that defines a structured layout with blocks
    (title, table, signature, text, spacer, image).
    """
    __tablename__ = "report_templates"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    description = Column(Text, nullable=True)

    # Page settings
    page_size = Column(String(20), nullable=False, default="A4")       # A4, A3, Letter
    orientation = Column(String(20), nullable=False, default="portrait")  # portrait, landscape

    # Blocks stored as JSON array
    # Each block: {"id": "uuid", "type": "title|table|signature|text|spacer|image",
    #              "layout": {"x":0,"y":0,"w":12,"h":4}, "config": {...}}
    blocks = Column(JSON, nullable=False, default=list)

    # User-defined filters (array of filter definitions)
    filters = Column(JSON, nullable=False, default=list)

    # Ownership
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
