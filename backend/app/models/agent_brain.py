"""Storage for AI Agent brains.

ONE TABLE, KEYED BY (key, version)
----------------------------------
A brain serving live public links must not change under them. So a brain is not a
row that gets edited: it is a series of versions, one of which is `published`.
Editing writes a new draft; publishing swaps which version answers. That shape is
what makes "who is affected if I change this" answerable, and with brains shared
across many links the question is no longer optional — one edit can change what
every link on the deployment says.

WHY NOT A SEPARATE `agent_brains` PARENT TABLE
----------------------------------------------
It would hold name, owner and description — all of which belong to a version,
because renaming or re-owning a published brain is itself a change somebody may
want to roll back. A parent row would also be a second place to record the owner,
and the owner is what the whole delegation rule rests on.

SHARING reuses `resource_shares` with `ResourceType.AGENT_BRAIN`, the same
mechanism Datasets and Dashboards use. A brain is a first-class resource, so it is
shared the way every other first-class resource is; a bespoke table would be a
second answer to "who may use this".
"""
from __future__ import annotations

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB

from app.core.database import Base


class AgentBrainVersion(Base):
    """One version of one brain."""

    __tablename__ = "agent_brain_versions"

    id = Column(Integer, primary_key=True, index=True)

    #: Stable identity across versions. A public link stores this, never a version
    #: number — a link points at "the Olist brain", and publishing decides which
    #: version that currently means.
    brain_key = Column(String(64), nullable=False, index=True)
    version = Column(Integer, nullable=False, default=1)

    #: draft | published | archived. Exactly one `published` row per brain_key,
    #: enforced in the service rather than by a partial index, because publishing
    #: also has to demote the previous one and that belongs in one transaction.
    status = Column(String(16), nullable=False, default="draft", index=True)

    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)

    #: The `Brain` contract, serialised. JSON rather than columns-per-field: the
    #: shape is the contract's business, and the last module split it across a
    #: schema and a JSON blob so the two could disagree about what a step was.
    body = Column(JSONB, nullable=False)

    #: WHOSE READING RIGHTS THIS BRAIN CARRIES.
    #:
    #: The delegation rule lives here. Attached knowledge is re-checked at run time
    #: against this user, not against the viewer (anonymous) and not against
    #: whoever assigned the brain to a link. Sharing the brain lends these rights;
    #: losing them narrows what the brain can read, immediately and without a
    #: republish.
    owner_email = Column(String(255), nullable=True, index=True)

    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    published_at = Column(DateTime(timezone=True), nullable=True)

    #: Seeded starter brains. Marked so the UI can label them and so a cleanup
    #: pass can tell "shipped with the product" from "somebody built this".
    is_builtin = Column(Boolean, nullable=False, default=False)

    __table_args__ = (
        UniqueConstraint("brain_key", "version", name="uq_agent_brain_version"),
        Index("ix_agent_brain_key_status", "brain_key", "status"),
    )
