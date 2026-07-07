"""
Native governance catalog models — Glossary (terms) + Classification (tags).

AppBI's own store for the Govern module, replacing the external OpenMetadata
dependency. FQN format mirrors OM ("<parent>.<child>") so glossary-term / tag
references already stored on measures (semantic_views.measures) keep resolving.
"""
from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
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


class GovernMetric(Base):
    """A MANAGEMENT METRIC the business governs by — the core of "metrics quản
    trị doanh nghiệp". This is authored DATA (nhập liệu), not code: a business
    records how it defines/tracks a KPI, and the AI + reports read it as the
    authoritative meaning. Bind to physical data so a concept ties to real
    columns/measures instead of being guessed from names.
    """
    __tablename__ = "govern_metrics"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(128), nullable=False, unique=True, index=True)   # machine name / FQN-safe
    display_name = Column(String(255), nullable=False)
    definition = Column(String, nullable=True)          # what it means, in business language
    formula = Column(String, nullable=True)             # how it's calculated (expression / prose)
    unit = Column(String(32), nullable=True)            # "BRL", "%", "đơn", "ngày"...
    grain = Column(String(32), nullable=True)           # daily|weekly|monthly|quarterly|yearly|point_in_time
    category = Column(String(128), nullable=True)       # folder: Sales | Ops | Finance | CX ...
    direction = Column(String(16), nullable=False, default="neutral")  # up_good | down_good | neutral
    target_value = Column(Float, nullable=True)
    target_operator = Column(String(8), nullable=True)  # >= | <= | = | between
    target_value2 = Column(Float, nullable=True)        # upper bound when operator = between
    owner = Column(String(128), nullable=True)          # accountable person/team
    related_term_fqn = Column(String(256), nullable=True)   # link to a GlossaryTerm (glossary.term)
    # Physical binding — concept ↔ real data (replaces name-guessing).
    dataset_id = Column(Integer, nullable=True, index=True)
    dataset_table_id = Column(Integer, nullable=True, index=True)
    measure_ref = Column(String(256), nullable=True)    # semantic measure name / column ref
    # Home / source-of-truth: the knowledge doc where this metric is DEFINED.
    # Other docs reference it via {{metric:slug}} tokens (see govern_metric_usage)
    # and render it as "reused from" with a link back here. Single source of truth.
    home_doc_id = Column(Integer, nullable=True, index=True)
    anchor = Column(String(128), nullable=True)          # optional section anchor within home doc
    synonyms = Column(JSON, nullable=False, default=list)   # NL aliases users say
    status = Column(String(24), nullable=False, default="Draft")  # Draft | Approved | Deprecated
    version = Column(Integer, nullable=False, default=1)
    provider = Column(String(16), nullable=False, default="user")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())


class GovernMetricUsage(Base):
    """A 'reuse' edge: a knowledge doc references a metric (via a
    {{metric:slug}} token) that is DEFINED in another doc. Powers lineage
    ("defined at X, reused at Y, Z") + impact analysis. Auto-synced from doc
    bodies on save; the metric's own home_doc_id is the definition, not a reuse."""
    __tablename__ = "govern_metric_usage"

    id = Column(Integer, primary_key=True, index=True)
    metric_id = Column(Integer, nullable=False, index=True)
    doc_id = Column(Integer, nullable=False, index=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (UniqueConstraint("metric_id", "doc_id", name="uq_metric_usage"),)


class GovernDocAssetLink(Base):
    """Generic link from a knowledge doc to a reporting ASSET it references via
    a {{dashboard:id}} / {{dataset:id}} / {{term:fqn}} token. Lets a doc embed
    (and back-link) reports, datasets and glossary terms — so Govern shows the
    WHOLE reporting system, not just text + metrics. (Metrics keep their own
    usage table because they carry SSOT/home semantics.) Auto-synced on save."""
    __tablename__ = "govern_doc_asset_links"

    id = Column(Integer, primary_key=True, index=True)
    doc_id = Column(Integer, nullable=False, index=True)
    asset_type = Column(String(24), nullable=False, index=True)   # dashboard | dataset | term
    asset_ref = Column(String(256), nullable=False, index=True)   # dashboard/dataset id (str) or term fqn
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (UniqueConstraint("doc_id", "asset_type", "asset_ref", name="uq_doc_asset_link"),)


class GovernKnowledgeDoc(Base):
    """A knowledge article/page — the heart of the Knowledge Hub (Cẩm nang tri
    thức). Rich narrative TEXT that captures how the business/report works so a
    NEW employee can absorb the whole system. Organized into spaces + a tree
    (parent_id) like a wiki; metrics/glossary/dashboards ride along as related
    links. Evolves over time (version + change log)."""
    __tablename__ = "govern_knowledge_docs"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255), nullable=False)
    slug = Column(String(255), nullable=True, index=True)
    # Top-level collection ("Onboarding", "Doanh thu", "Vận hành", "Quy trình"…).
    space = Column(String(128), nullable=False, default="Chung", index=True)
    parent_id = Column(Integer, nullable=True, index=True)   # self-ref → nested pages
    position = Column(Integer, nullable=False, default=0)    # ordering within space/parent
    doc_type = Column(String(32), nullable=False, default="article")  # overview|guide|domain|process|faq|article
    summary = Column(String(512), nullable=True)            # short blurb for cards / onboarding
    body = Column(Text, nullable=True)                      # markdown narrative
    tags = Column(JSON, nullable=False, default=list)
    # Companions — metrics/glossary/reports this knowledge references.
    related_metrics = Column(JSON, nullable=False, default=list)   # [managed-metric machine_name]
    related_terms = Column(JSON, nullable=False, default=list)     # [glossary term fqn]
    related_dashboard_ids = Column(JSON, nullable=False, default=list)
    related_dataset_ids = Column(JSON, nullable=False, default=list)
    status = Column(String(16), nullable=False, default="Draft")  # Draft | Published | Archived
    version = Column(Integer, nullable=False, default=1)
    pinned = Column(Boolean, nullable=False, default=False)  # highlight on the onboarding landing
    owner = Column(String(128), nullable=True)
    provider = Column(String(16), nullable=False, default="user")
    # sha256(body)+embedding-model of the last body embedded into govern_doc_chunk;
    # lets a re-save with unchanged body skip embedding entirely (no wasted tokens).
    embedded_hash = Column(String(80), nullable=True)
    # ── Knowledge Hub metadata (AI-readable node, review workflow) ─────────
    business_domain = Column(String(120), nullable=True)   # e.g. "Bán hàng", "Vận hành"
    process_ref = Column(String(160), nullable=True)       # business process this doc serves
    review_date = Column(Date, nullable=True)              # next scheduled review
    last_verified_at = Column(DateTime, nullable=True)     # owner pressed "verified"
    importance = Column(String(12), nullable=False, default="normal")  # low|normal|high
    # ── AI section: generated on save (hash-gated), user-editable ──────────
    ai_summary = Column(Text, nullable=True)
    ai_keywords = Column(JSON, nullable=True)              # [str]
    ai_summary_hash = Column(String(80), nullable=True)    # sha256(model\nbody) of last gen
    # ── usage telemetry (most viewed / most retrieved insights) ────────────
    view_count = Column(Integer, nullable=False, default=0)
    last_viewed_at = Column(DateTime, nullable=True)
    retrieval_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())


class GovernKnowledgeDocVersion(Base):
    """Immutable snapshot of a business document at a point in time. Every
    publish/edit locks a version so the evolution of the business write-up is
    preserved ("bản hôm nay vs bản mai") and any past version can be viewed or
    restored. This is the historical record the AI can also mine later."""
    __tablename__ = "govern_knowledge_doc_versions"

    id = Column(Integer, primary_key=True, index=True)
    doc_id = Column(Integer, nullable=False, index=True)
    version = Column(Integer, nullable=False)
    title = Column(String(255), nullable=False)
    space = Column(String(128), nullable=True)
    doc_type = Column(String(32), nullable=True)
    summary = Column(String(512), nullable=True)
    body = Column(Text, nullable=True)          # full snapshot of the markdown
    status = Column(String(16), nullable=True)
    change_note = Column(String(512), nullable=True)  # optional "what changed"
    changed_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=func.now(), index=True)

    __table_args__ = (UniqueConstraint("doc_id", "version", name="uq_doc_version"),)


class GovernChangeLog(Base):
    """Audit trail of Govern knowledge edits — "log Business domain theo sự phát
    triển của doanh nghiệp". Every create/update/delete/status-change on a
    governed entity appends a row, so the evolution of the domain is recorded
    and reviewable (governance / quản trị)."""
    __tablename__ = "govern_change_log"

    id = Column(Integer, primary_key=True, index=True)
    entity_type = Column(String(32), nullable=False, index=True)  # metric | glossary_term | glossary | classification | tag
    entity_fqn = Column(String(256), nullable=False, index=True)
    action = Column(String(16), nullable=False)                   # create | update | delete | status
    summary = Column(String(512), nullable=True)                  # human-readable what-changed
    changed_by = Column(String(128), nullable=True)               # user email / id when known
    snapshot = Column(JSON, nullable=True)                        # post-change state (for metric: full dict)
    created_at = Column(DateTime, default=func.now(), index=True)


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
