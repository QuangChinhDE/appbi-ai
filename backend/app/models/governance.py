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
    Index,
    Integer,
    JSON,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
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
    """Company vocabulary, owned by a glossary rather than by any dataset.

    Dataset columns, semantic measures, governed KPIs, and documents may all point
    to the same term. That reuse is the purpose of the term; putting its authoring
    UI inside one dataset would incorrectly make a shared definition look local.
    """
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
    authoritative meaning. It is owned by the Governance Registry. Bindings point
    to executable semantic measures; datasets realize the KPI but never own it.
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
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True, index=True)
    dataset_table_id = Column(Integer, ForeignKey("dataset_tables.id", ondelete="SET NULL"), nullable=True, index=True)
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

    #: Every place this one definition is computed. Cascade-deleted with the
    #: metric: a binding without its statement is a pointer to nothing.
    bindings = relationship(
        "GovernMetricBinding", cascade="all, delete-orphan", lazy="selectin",
    )


class GovernMetricBinding(Base):
    """WHERE a governed metric is realized in real data. Many per metric.

    WHY THIS TABLE EXISTS
    ---------------------
    `GovernMetric` carried ONE realization — a single `dataset_id`,
    `dataset_table_id` and `measure_ref`. That shape decided more than it looked
    like it decided:

      * A company metric realized in two datasets (an operational one and a
        warehouse one, say) could not be expressed at all. The author had to pick
        one and mislabel the rest, or bind nothing and lose the connection.
      * Because a metric could belong to exactly one dataset, the only sensible
        place to edit it was inside that dataset — which made the whole metric
        catalogue read as "this dataset's semantic dictionary" rather than the
        company's vocabulary. The information architecture followed the column.
      * An assistant reading the catalogue saw fragments. "What does GMV mean
        here" could be answered on one report and nowhere else, for the same word.

    A metric is a STATEMENT the business governs by; a binding is one place that
    statement is computed. Separating them is what lets one definition serve many
    reports without being owned by any of them.

    The scalar columns on `GovernMetric` are still read as a fallback, so a
    deployment mid-upgrade keeps working. `20260815_0048` copies each existing
    scalar binding into a row here.
    """

    __tablename__ = "govern_metric_bindings"

    id = Column(Integer, primary_key=True, index=True)
    metric_id = Column(
        Integer, ForeignKey("govern_metrics.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    #: Which dataset realizes it. Kept alongside the table id because a metric may
    #: be pinned at dataset level before anyone picks the exact measure.
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True, index=True)
    dataset_table_id = Column(Integer, ForeignKey("dataset_tables.id", ondelete="SET NULL"), nullable=True, index=True)
    #: `dataset_table_<id>.<measure>` — the same spelling the semantic layer uses.
    measure_ref = Column(String(256), nullable=True)
    #: The one shown first, and the one the legacy scalar columns mirror. Exactly
    #: one per metric is primary; the service enforces it rather than a partial
    #: index, because promoting a binding also demotes the previous one and that
    #: belongs in one transaction.
    is_primary = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "metric_id", "dataset_table_id", "measure_ref",
            name="uq_metric_binding_target",
        ),
        Index("ix_metric_binding_dataset", "dataset_id"),
    )


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


class GovernDocLink(Base):
    """Explicit doc↔doc wikilink ([[Doc Title]], Obsidian-style). Resolved to a
    target doc id at save time and stored as a directed edge, so the hub is a
    real navigable/AI-traversable knowledge graph (backlinks + graph view).
    Stored by id → survives a later title rename. Auto-synced on save."""
    __tablename__ = "govern_doc_links"

    id = Column(Integer, primary_key=True, index=True)
    from_doc_id = Column(Integer, nullable=False, index=True)
    to_doc_id = Column(Integer, nullable=False, index=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (UniqueConstraint("from_doc_id", "to_doc_id", name="uq_govern_doc_link"),)


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
    owner = Column(String(128), nullable=True)          # free-text label (person/team)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)  # resource owner (sharing/permissions)
    provider = Column(String(16), nullable=False, default="user")
    # sha256(body)+embedding profile of the last body embedded into govern_doc_chunk;
    # lets a re-save with unchanged body skip embedding entirely (no wasted tokens).
    embedded_hash = Column(String(80), nullable=True)
    #: Fingerprint of the SOURCE the AST was built from, and which document
    #: version that was. Separate from `embedded_hash` on purpose: the source
    #: changing means re-extract (and for a scanned PDF, re-OCR), while the
    #: chunker or model changing means only re-chunk. One hash for both made every
    #: chunker change re-run extraction.
    ast_hash = Column(String(80), nullable=True)
    ast_version = Column(Integer, nullable=True)
    # ── External-embedding control (what may leave for a third party) ──────
    # Embedding sends the document's full text to an external provider. This is
    # the veto for documents that must not go, and the honest cost of using it
    # is that the doc becomes unreachable by AI — stated, never silent.
    #: What may leave for a third party: 'none' | 'embedding' | 'full'.
    #: Replaced a boolean named after the embedding call, which could not govern
    #: OCR or figure description — so a document marked "do not send" would have
    #: had its page images sent while its prose was correctly withheld.
    external_processing = Column(String(16), nullable=False, default="embedding")
    sensitivity = Column(String(16), nullable=False, default="internal")  # internal|confidential|restricted
    # ── Knowledge Hub metadata (AI-readable node, review workflow) ─────────
    business_domain = Column(String(120), nullable=True)   # e.g. "Bán hàng", "Vận hành"
    process_ref = Column(String(160), nullable=True)       # business process this doc serves
    review_date = Column(Date, nullable=True)              # next scheduled review
    last_verified_at = Column(DateTime, nullable=True)     # owner pressed "verified"
    importance = Column(String(12), nullable=False, default="normal")  # low|normal|high
    # Version-level publishing: which version is LIVE (RAG/public reads it).
    # null = nothing published yet. Independent of the latest working draft, so
    # v1 can stay published while v2 is an in-progress draft.
    published_version = Column(Integer, nullable=True)
    # ── AI section: generated on save (hash-gated), user-editable ──────────
    ai_summary = Column(Text, nullable=True)
    ai_keywords = Column(JSON, nullable=True)              # [str]
    ai_summary_hash = Column(String(80), nullable=True)    # sha256(model\nbody) of last gen
    # ── usage telemetry (most viewed / most retrieved insights) ────────────
    view_count = Column(Integer, nullable=False, default=0)
    last_viewed_at = Column(DateTime, nullable=True)
    retrieval_count = Column(Integer, nullable=False, default=0)
    # ── External source (Source & Sync tab) — None = hand-typed (today's only path) ─
    source_type = Column(String(24), nullable=True)   # google_doc | file | web | null
    source_config = Column(JSON, nullable=False, default=dict)  # {datasource_id, google_doc_id} | {} | {url}
    sync_schedule = Column(JSON, nullable=True)        # {mode, at, cron, timezone} — same shape as dataset snapshot schedule
    last_synced_at = Column(DateTime, nullable=True)
    last_sync_status = Column(String(16), nullable=True)  # ok | error | running
    # ── Embedding configuration (Embedding tab) — was hardcoded in govern_doc_embeddings.py ─
    chunk_strategy = Column(String(16), nullable=False, default="paragraph")  # paragraph | heading | fixed
    chunk_size = Column(Integer, nullable=False, default=850)
    chunk_overlap = Column(Integer, nullable=False, default=0)
    # Materialized per document. It never follows a later application-default
    # change; switching it requires the explicit reset + rebuild operation.
    embedding_model = Column(
        String(100), nullable=False, default="text-embedding-3-small"
    )
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


class GovernDocSourceFile(Base):
    """The CURRENT uploaded file (PDF/DOCX/XLSX) backing a doc whose
    source_type == 'file'. doc_id is the PRIMARY KEY (not a surrogate id) —
    content history is already fully covered by GovernKnowledgeDocVersion (a
    re-upload produces a new extracted body -> new doc save -> new version,
    same as a hand edit), so this table only ever needs to answer "what is
    the current file," making it a plain upsert-by-doc_id."""
    __tablename__ = "govern_doc_source_files"

    doc_id = Column(Integer, ForeignKey("govern_knowledge_docs.id", ondelete="CASCADE"), primary_key=True)
    filename = Column(String(255), nullable=False)
    content_type = Column(String(120), nullable=False, default="application/octet-stream")
    byte_size = Column(Integer, nullable=False, default=0)
    data = Column(LargeBinary, nullable=False)
    extracted_text_hash = Column(String(64), nullable=True)  # sha256 of last extracted text; skip re-extraction on identical re-upload
    uploaded_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    uploaded_at = Column(DateTime, default=func.now())


class GovernDocRun(Base):
    """Unified sync + embed run history for a Knowledge Doc — the History tab's
    data source. Previously the result of every embed_doc() call was computed
    then thrown away; this table is what makes that transparent. One table
    (not two) with a run_type discriminator so History renders a single
    time-sorted timeline instead of a UNION of two tables."""
    __tablename__ = "govern_doc_runs"

    id = Column(Integer, primary_key=True, index=True)
    doc_id = Column(Integer, ForeignKey("govern_knowledge_docs.id", ondelete="CASCADE"), nullable=False, index=True)
    run_type = Column(String(16), nullable=False)      # sync | embed
    trigger = Column(String(16), nullable=False, default="manual")  # manual | scheduled | save | publish
    status = Column(String(16), nullable=False)        # ok | error | skipped
    detail = Column(String(512), nullable=True)         # short human message
    stats = Column(JSON, nullable=True)                 # {chunks, new_chunks, chars, ...}
    started_at = Column(DateTime, default=func.now())
    finished_at = Column(DateTime, nullable=True)
    triggered_by = Column(String(128), nullable=True)   # user email, or 'scheduler'


# ═══════════════════════════════════════════════════════════════════════════
# Intelligence modules — the knowledge types that TEACH the AI how to analyze
# (rules / playbooks / verified Q&A / instructions), plus the governance spine
# that keeps them trustworthy (single review ledger, caveats, AI data scope,
# per-answer provenance). All AUTHORED data; the bot only consumes Approved.
# ═══════════════════════════════════════════════════════════════════════════


class GovernRule(Base):
    """A business rule the AI must respect: condition → conclusion (+exceptions).
    MUST be bound via applies_to so retrieval is scoped to the question's data
    instead of injecting every rule into every turn."""
    __tablename__ = "govern_rules"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    condition_text = Column(Text, nullable=False)      # "Doanh thu giảm >10% YoY"
    conclusion_text = Column(Text, nullable=False)     # "cảnh báo + phân rã theo bang"
    exceptions_text = Column(Text, nullable=True)      # "Black Friday, Tết"
    # [{kind: metric|dataset|column, ref: "<machine name / id>", label}] — retrieval binding
    applies_to = Column(JSON, nullable=False, default=list)
    status = Column(String(24), nullable=False, default="Draft")  # Draft | Approved | Deprecated
    version = Column(Integer, nullable=False, default=1)
    owner = Column(String(128), nullable=True)
    provider = Column(String(16), nullable=False, default="user")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())


class GovernPlaybook(Base):
    """How the AI should analyze a situation: trigger → ordered steps →
    expected output, with dimension priorities and bound metrics. The bot runs
    the business's OWN analysis recipe instead of improvising one."""
    __tablename__ = "govern_playbooks"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    trigger_text = Column(Text, nullable=False)        # when to run (prose condition)
    steps = Column(JSON, nullable=False, default=list)  # [str] ordered analysis steps
    dim_priority = Column(JSON, nullable=False, default=list)  # [str] dimension names in priority order
    expected_output = Column(Text, nullable=True)      # what a good answer looks like
    linked_metrics = Column(JSON, nullable=False, default=list)  # [govern_metric machine name]
    status = Column(String(24), nullable=False, default="Draft")
    version = Column(Integer, nullable=False, default=1)
    owner = Column(String(128), nullable=True)
    run_count = Column(Integer, nullable=False, default=0)
    last_run_at = Column(DateTime, nullable=True)
    provider = Column(String(16), nullable=False, default="user")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())


class GovernVerifiedQA(Base):
    """An author-approved answer pinned to trigger phrases. When a user question
    matches, the bot must anchor on this answer (and cite the pinned chart)
    instead of free-generating. Approved rows double as regression tests."""
    __tablename__ = "govern_verified_qa"

    id = Column(Integer, primary_key=True, index=True)
    question = Column(String(512), nullable=False)
    trigger_phrases = Column(JSON, nullable=False, default=list)  # [str] lowercase match phrases
    answer_md = Column(Text, nullable=False)
    chart_id = Column(Integer, nullable=True)          # pinned visual (optional)
    dashboard_id = Column(Integer, nullable=True, index=True)  # null = applies to all dashboards
    playbook_id = Column(Integer, nullable=True)       # answer = "run this playbook"
    status = Column(String(24), nullable=False, default="Draft")
    as_test = Column(Boolean, nullable=False, default=True)  # export as regression golden case
    owner = Column(String(128), nullable=True)
    use_count = Column(Integer, nullable=False, default=0)
    last_used_at = Column(DateTime, nullable=True)
    version = Column(Integer, nullable=False, default=1)
    provider = Column(String(16), nullable=False, default="user")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())


class GovernAIInstruction(Base):
    """Versioned AI instructions — system-level steering, scoped Global →
    Dataset → Dashboard (injected in that order; the legacy per-public-link
    note stays as a final override during migration). Admin-owned CONFIG, not
    ordinary knowledge: one active row per (scope, scope_id)."""
    __tablename__ = "govern_ai_instructions"

    id = Column(Integer, primary_key=True, index=True)
    scope = Column(String(16), nullable=False, default="global")  # global | dataset | dashboard
    scope_id = Column(Integer, nullable=True, index=True)         # dataset_id / dashboard_id
    content_md = Column(Text, nullable=False)
    version = Column(Integer, nullable=False, default=1)
    status = Column(String(16), nullable=False, default="active")  # active | archived
    eval_pass_rate = Column(Float, nullable=True)   # recorded when an eval gated this version
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=func.now())


class GovernReviewItem(Base):
    """THE single review ledger. Every approval in the Intelligence group —
    AI suggestions, in-context certifies, re-certifies on binding drift,
    flagged answers, retires — is a row here, so "what is pending and who
    approved what" always has one answer."""
    __tablename__ = "govern_review_items"

    id = Column(Integer, primary_key=True, index=True)
    entity_type = Column(String(24), nullable=False, index=True)  # metric|term|rule|playbook|qa|instruction|doc|caveat
    entity_id = Column(Integer, nullable=True)
    action = Column(String(24), nullable=False, default="suggest")  # suggest|certify|recertify|flag|retire
    title = Column(String(512), nullable=False)
    payload = Column(JSON, nullable=True)        # proposed content (entity fields) for suggest-type items
    evidence = Column(Text, nullable=True)       # why AI/user proposed it
    confidence = Column(Float, nullable=True)    # AI confidence 0..1 (null for human actions)
    source = Column(String(16), nullable=False, default="user")  # ai | user | system
    status = Column(String(16), nullable=False, default="pending", index=True)  # pending|approved|rejected
    note = Column(String(512), nullable=True)
    created_by = Column(String(128), nullable=True)
    resolved_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=func.now(), index=True)
    resolved_at = Column(DateTime, nullable=True)


class GovernDataCaveat(Base):
    """Governed warning centrally authored in the Governance Registry.

    ``dataset_id`` is application scope, not ownership: null means organization-
    wide and a value means the warning applies to that dataset. Approved caveats
    are injected deterministically because similarity search can miss critical
    freshness, grain, fan-out, or quality warnings.
    """
    __tablename__ = "govern_data_caveats"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(
        Integer, ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True, index=True,
    )  # null = organization-wide
    title = Column(String(255), nullable=False)
    content = Column(Text, nullable=False)
    always_inject = Column(Boolean, nullable=False, default=True)
    status = Column(String(24), nullable=False, default="Approved")
    owner = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())


class GovernAIScope(Base):
    """AI data scope per dataset (Power-BI "AI data schema" parity): columns /
    measures the bot must NOT see. Default (no row) = everything allowed, so
    existing dashboards keep working untouched."""
    __tablename__ = "govern_ai_scope"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, nullable=False, unique=True, index=True)
    excluded_columns = Column(JSON, nullable=False, default=list)   # ["column_name", ...]
    excluded_measures = Column(JSON, nullable=False, default=list)  # [semantic measure/dimension name]
    updated_by = Column(String(128), nullable=True)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())


class GovernAnswerProvenance(Base):
    """Which knowledge was INJECTED for one bot answer — the provenance store
    behind "AI đang dùng gì". Written best-effort per turn; powers the cockpit
    and "questions with no knowledge backing" analytics."""
    __tablename__ = "govern_answer_provenance"

    id = Column(Integer, primary_key=True, index=True)
    dashboard_id = Column(Integer, nullable=True, index=True)
    question = Column(String(512), nullable=True)
    # [{kind: metric|term|doc|rule|playbook|qa|caveat|instruction, ref, name}]
    refs = Column(JSON, nullable=False, default=list)
    grounded = Column(Boolean, nullable=False, default=True)  # False = nothing authored matched
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


class GovernDocBlock(Base):
    """One structural block of a document — the AST, as rows.

    Extraction produces this ONCE per document version; chunking is a projection
    of it. That separation is what stops a chunker change from re-running OCR, and
    what gives a citation an anchor (`ordinal`) that survives a re-chunk when a
    chunk id does not.

    Carries the same `doc_status`/`space`/`trust` labels as the chunk table, kept
    correct by triggers and enforced by the same row-level policy: any table
    holding text derived from a document has to, or the isolation reopens through
    the new table.
    """
    __tablename__ = "govern_doc_block"

    id = Column(Integer, primary_key=True, index=True)
    doc_id = Column(Integer, nullable=False, index=True)
    source_version = Column(Integer, nullable=False, default=0)
    ordinal = Column(Integer, nullable=False)
    parent_id = Column(Integer, nullable=True)
    kind = Column(String(16), nullable=False, default="paragraph")
    level = Column(Integer, nullable=False, default=0)
    text = Column(Text, nullable=False, default="")
    heading_path = Column(Text, nullable=True)
    page = Column(Integer, nullable=True)
    bbox = Column(JSON, nullable=True)
    table_header = Column(Text, nullable=True)
    meta = Column(JSON, nullable=False, default=dict)
    token_count = Column(Integer, nullable=False, default=0)
    doc_status = Column(String(16), nullable=False, default="Draft")
    space = Column(String(128), nullable=False, default="Chung")
    trust = Column(String(16), nullable=False, default="authored")
    created_at = Column(DateTime, default=func.now())


class GovernDocEgressLog(Base):
    """One row per transfer of document text to an external embedding provider.

    Written per RUN, not per chunk: an audit asks "did this document leave, when,
    to whom, how much of it" — a row per chunk would bury that answer in volume.
    A refusal is logged too (`outcome='blocked'`); proving something did NOT leave
    is half the value of keeping the record.
    """
    __tablename__ = "govern_doc_egress_log"

    id = Column(Integer, primary_key=True, index=True)
    doc_id = Column(Integer, nullable=False, index=True)
    doc_title = Column(String(300), nullable=True)
    sensitivity = Column(String(16), nullable=True)
    purpose = Column(String(24), nullable=False, default="embedding")
    provider = Column(String(64), nullable=True)
    model = Column(String(100), nullable=True)
    chunks_sent = Column(Integer, nullable=False, default=0)
    chars_sent = Column(Integer, nullable=False, default=0)
    outcome = Column(String(16), nullable=False, default="sent")  # sent | blocked | failed
    triggered_by = Column(String(128), nullable=True)
    occurred_at = Column(DateTime, default=func.now())
