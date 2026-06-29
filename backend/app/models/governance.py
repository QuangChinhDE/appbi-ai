"""
Native governance catalog models — Glossary (terms) + Classification (tags).

AppBI's own store for the Govern module, replacing the external OpenMetadata
dependency. FQN format mirrors OM ("<parent>.<child>") so glossary-term / tag
references already stored on measures (semantic_views.measures) keep resolving.
"""
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import relationship

from app.core.database import Base


class Glossary(Base):
    __tablename__ = "glossaries"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(128), nullable=False, unique=True, index=True)  # machine name, FQN-safe
    display_name = Column(String(255), nullable=False)
    description = Column(String, nullable=True)
    provider = Column(String(16), nullable=False, default="user")  # user | system
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    terms = relationship("GlossaryTerm", back_populates="glossary", cascade="all, delete-orphan")


class GlossaryTerm(Base):
    __tablename__ = "glossary_terms"

    id = Column(Integer, primary_key=True, index=True)
    glossary_id = Column(Integer, ForeignKey("glossaries.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(128), nullable=False)  # machine name (FQN = glossary.name + "." + name)
    display_name = Column(String(255), nullable=False)
    description = Column(String, nullable=True)
    synonyms = Column(JSON, nullable=False, default=list)
    status = Column(String(24), nullable=False, default="Approved")  # Draft | Approved | Deprecated
    provider = Column(String(16), nullable=False, default="user")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    glossary = relationship("Glossary", back_populates="terms")

    __table_args__ = (UniqueConstraint("glossary_id", "name", name="uq_glossary_term_name"),)


class Classification(Base):
    __tablename__ = "classifications"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(128), nullable=False, unique=True, index=True)
    display_name = Column(String(255), nullable=False)
    description = Column(String, nullable=True)
    mutually_exclusive = Column(Boolean, nullable=False, default=False)
    provider = Column(String(16), nullable=False, default="user")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    tags = relationship("ClassificationTag", back_populates="classification", cascade="all, delete-orphan")


class ClassificationTag(Base):
    __tablename__ = "classification_tags"

    id = Column(Integer, primary_key=True, index=True)
    classification_id = Column(Integer, ForeignKey("classifications.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(128), nullable=False)  # machine name (FQN = classification.name + "." + name)
    display_name = Column(String(255), nullable=False)
    description = Column(String, nullable=True)
    provider = Column(String(16), nullable=False, default="user")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    classification = relationship("Classification", back_populates="tags")

    __table_args__ = (UniqueConstraint("classification_id", "name", name="uq_classification_tag_name"),)
