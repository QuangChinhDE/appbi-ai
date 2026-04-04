"""
Semantic Layer Models
LookML-style semantic definitions for views, models, and explores
"""
from sqlalchemy import Column, Integer, String, JSON, ForeignKey, DateTime, UniqueConstraint, func
from sqlalchemy.orm import relationship
from app.core.database import Base


class SemanticView(Base):
    """
    Represents a semantic view (similar to LookML view)
    Contains dimensions and measures definitions
    """
    __tablename__ = "semantic_views"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)
    sql_table_name = Column(String, nullable=True)  # Direct table name
    dataset_table_id = Column(Integer, ForeignKey("dataset_tables.id", ondelete="SET NULL"), nullable=True, index=True)
    dimensions = Column(JSON, nullable=False, default=list)  # List of dimension definitions
    measures = Column(JSON, nullable=False, default=list)  # List of measure definitions
    description = Column(String, nullable=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("dataset_table_id", name="uq_semantic_views_dataset_table_id"),
    )

    # Relationships
    explores = relationship("SemanticExplore", back_populates="base_view_obj", foreign_keys="SemanticExplore.base_view_id")
    dataset_table = relationship("DatasetTable", foreign_keys=[dataset_table_id])


class SemanticModel(Base):
    """
    Represents a semantic model (similar to LookML model)
    Groups multiple explores together
    """
    __tablename__ = "semantic_models"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True, index=True)
    description = Column(String, nullable=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("dataset_id", name="uq_semantic_models_dataset_id"),
    )

    # Relationships
    explores = relationship("SemanticExplore", back_populates="model", cascade="all, delete-orphan")
    dataset = relationship("Dataset", foreign_keys=[dataset_id])


class SemanticExplore(Base):
    """
    Represents a semantic explore (similar to LookML explore)
    Defines base view, joins, and accessible fields
    """
    __tablename__ = "semantic_explores"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)
    model_id = Column(Integer, ForeignKey("semantic_models.id"), nullable=False)
    base_view_id = Column(Integer, ForeignKey("semantic_views.id"), nullable=False)
    base_view_name = Column(String, nullable=False)  # For quick reference
    joins = Column(JSON, nullable=False, default=list)  # List of join definitions
    default_filters = Column(JSON, nullable=True, default=dict)
    description = Column(String, nullable=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    # Relationships
    model = relationship("SemanticModel", back_populates="explores")
    base_view_obj = relationship("SemanticView", foreign_keys=[base_view_id])
