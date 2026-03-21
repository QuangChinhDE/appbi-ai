"""
Dataset Workspace Models - Table-based dataset like NocoDB/Airtable
"""
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text, JSON
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from datetime import datetime

from app.core.database import Base


class DatasetWorkspace(Base):
    """
    Dataset Workspace - like NocoDB Base or Airtable Base
    A workspace contains multiple tables from various datasources
    """
    __tablename__ = "dataset_workspaces"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=True)
    
    # Relationship
    tables = relationship("DatasetWorkspaceTable", back_populates="workspace", cascade="all, delete-orphan")


class DatasetWorkspaceTable(Base):
    """
    Table in a dataset workspace
    References a physical table/view from a datasource
    """
    __tablename__ = "dataset_workspace_tables"
    
    id = Column(Integer, primary_key=True, index=True)
    workspace_id = Column(Integer, ForeignKey("dataset_workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    datasource_id = Column(Integer, ForeignKey("data_sources.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # Source specification
    source_kind = Column(String(50), default="physical_table", nullable=False)  # "physical_table" or "sql_query"
    source_table_name = Column(String(500), nullable=True)  # For physical_table: e.g., "public.orders"
    source_query = Column(Text, nullable=True)  # For sql_query: SELECT statement
    display_name = Column(String(255), nullable=False)  # User-friendly name
    
    # Status and config
    enabled = Column(Boolean, default=True, nullable=True)
    transformations = Column(JSON, default=None, nullable=True)  # Transform steps
    
    # Cache for performance
    columns_cache = Column(JSON, nullable=True)  # Cached column metadata
    sample_cache = Column(JSON, nullable=True)  # Cached sample data
    type_overrides = Column(JSON, nullable=True)  # {"col_name": "integer"} user-defined type overrides
    column_formats = Column(JSON, nullable=True)  # {"col_name": {formatType, decimalPlaces, ...}} full display format per column
    
    # AI metadata — populated automatically by TableStatsService
    column_stats = Column(JSONB, nullable=True, default=None)
    auto_description = Column(Text, nullable=True, default=None)
    stats_updated_at = Column(DateTime, nullable=True, default=None)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=True)

    # Relationships
    workspace = relationship("DatasetWorkspace", back_populates="tables")
