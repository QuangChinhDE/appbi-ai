"""
Multi-table Dataset Model (Power BI-style data model)
Supports fact/dimension tables, relationships, and calculated columns.
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean, Enum, ForeignKey, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum

from app.core.database import Base


class TableRole(str, enum.Enum):
    """Role of table in the dataset model."""
    FACT = "fact"
    DIM = "dim"


class JoinType(str, enum.Enum):
    """Type of join between tables."""
    LEFT = "left"
    INNER = "inner"


class DatasetModel(Base):
    """
    Multi-table dataset model container.
    Similar to Power BI data model - contains multiple tables with relationships.
    """
    __tablename__ = "dataset_models"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    tables = relationship("DatasetTable", back_populates="dataset_model", cascade="all, delete-orphan")
    relationships = relationship("DatasetRelationship", back_populates="dataset_model", cascade="all, delete-orphan")
    calculated_columns = relationship("DatasetCalculatedColumn", back_populates="dataset_model", cascade="all, delete-orphan")


class DatasetTable(Base):
    """
    Individual table in a dataset model.
    Can be FACT or DIM, has its own datasource, SQL query, and transformations.
    """
    __tablename__ = "dataset_tables"

    id = Column(Integer, primary_key=True, index=True)
    dataset_model_id = Column(Integer, ForeignKey("dataset_models.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)  # User-friendly name
    role = Column(Enum(TableRole), nullable=False, default=TableRole.DIM)
    
    # Data source and query
    data_source_id = Column(Integer, ForeignKey("data_sources.id", ondelete="RESTRICT"), nullable=False, index=True)
    base_sql = Column(Text, nullable=False)  # SELECT-only query
    
    # Transformations and schema cache
    transformations = Column(JSON, nullable=False, default=list)  # List of transformation steps
    columns = Column(JSON, nullable=True, default=list)  # Cached schema after preview
    
    # Metadata
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    dataset_model = relationship("DatasetModel", back_populates="tables")
    data_source = relationship("DataSource")
    
    # Relationships where this table is on the left
    left_relationships = relationship(
        "DatasetRelationship",
        foreign_keys="DatasetRelationship.left_table_id",
        back_populates="left_table",
        cascade="all, delete-orphan"
    )
    
    # Relationships where this table is on the right
    right_relationships = relationship(
        "DatasetRelationship",
        foreign_keys="DatasetRelationship.right_table_id",
        back_populates="right_table",
        cascade="all, delete-orphan"
    )


class DatasetRelationship(Base):
    """
    Relationship (join) between two tables in a dataset model.
    Defines how fact table joins with dimension tables.
    """
    __tablename__ = "dataset_relationships"

    id = Column(Integer, primary_key=True, index=True)
    dataset_model_id = Column(Integer, ForeignKey("dataset_models.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # Tables involved in relationship
    left_table_id = Column(Integer, ForeignKey("dataset_tables.id", ondelete="CASCADE"), nullable=False)
    right_table_id = Column(Integer, ForeignKey("dataset_tables.id", ondelete="CASCADE"), nullable=False)
    
    # Join configuration
    join_type = Column(Enum(JoinType), nullable=False, default=JoinType.LEFT)
    on = Column(JSON, nullable=False)  # List of {"leftField": "...", "rightField": "..."}
    
    # Metadata
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Relationships
    dataset_model = relationship("DatasetModel", back_populates="relationships")
    left_table = relationship("DatasetTable", foreign_keys=[left_table_id], back_populates="left_relationships")
    right_table = relationship("DatasetTable", foreign_keys=[right_table_id], back_populates="right_relationships")


class DatasetCalculatedColumn(Base):
    """
    Calculated column in a dataset model.
    SQL expression applied to the final joined result.
    """
    __tablename__ = "dataset_calculated_columns"

    id = Column(Integer, primary_key=True, index=True)
    dataset_model_id = Column(Integer, ForeignKey("dataset_models.id", ondelete="CASCADE"), nullable=False, index=True)
    
    name = Column(String(255), nullable=False)  # Column alias
    expression = Column(Text, nullable=False)  # SQL expression (can reference table_alias.field)
    data_type = Column(String(50), nullable=True)  # Optional data type hint
    enabled = Column(Boolean, nullable=False, default=True)
    
    # Metadata
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    dataset_model = relationship("DatasetModel", back_populates="calculated_columns")
