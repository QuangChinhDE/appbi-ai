"""
Workboard model — mini-app builder bound to a dataset + primary table.

A Workboard is a lightweight CRUD app over an external database that has
already been wired through Datasource → Dataset. Each Workboard exposes
three view kinds inside its layout payload: "form" (data entry),
"table" (list with inline edit) and "doc" (block-based summary report).

Schema-first: a Workboard never runs DDL. The external DB schema is the
source of truth; admins evolve it outside of AppBI and re-sync the dataset.
"""
from __future__ import annotations

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.core.database import Base


class Workboard(Base):
    """A mini-app definition. One workboard = one dataset + one primary table."""

    __tablename__ = "workboards"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    slug = Column(String(120), nullable=True, unique=True, index=True)
    description = Column(Text, nullable=True)
    icon = Column(String(64), nullable=True)

    # Schema binding — workboard is meaningless without its dataset/table.
    dataset_id = Column(
        Integer,
        ForeignKey("datasets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    primary_table_id = Column(
        Integer,
        ForeignKey("dataset_tables.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Cached schema metadata so the runtime/builder doesn't have to
    # introspect the source DB on every request. Refreshed on demand.
    primary_key_columns = Column(JSONB, nullable=False, server_default="[]")
    lookup_tables = Column(JSONB, nullable=False, server_default="[]")

    # The full workboard definition (form fields, table columns, doc blocks,
    # row-level security, optimistic-lock config, …). See
    # ``app.schemas.workboard.LayoutJson`` for the canonical shape.
    layout_json = Column(JSONB, nullable=False, server_default="{}")

    # MVP: only "direct" writes through the source datasource connector.
    write_mode = Column(String(20), nullable=False, server_default="direct")

    # Optional column used for optimistic locking on UPDATE/DELETE
    # (typically ``updated_at`` or ``version``). NULL → last-write-wins.
    optimistic_lock_column = Column(String(120), nullable=True)

    is_published = Column(
        Boolean,
        nullable=False,
        default=False,
        server_default="false",
    )
    version = Column(Integer, nullable=False, default=1, server_default="1")

    # ── Draft / Published separation ──────────────────────────────────────
    # ``layout_json`` above is the mutable DRAFT the builder/autosave writes.
    # ``published_layout_json`` is the immutable LIVE snapshot the public
    # runtime serves — set only when Publish runs (atomic draft→published
    # copy). NULL means "never published" → the live runtime must refuse to
    # serve the app. The builder and internal Preview always read the draft.
    # ``published_version`` records the draft ``version`` captured at publish
    # time; draft ``version`` > ``published_version`` ⇒ "unpublished changes".
    published_layout_json = Column(JSONB, nullable=True, default=None)
    published_version = Column(Integer, nullable=True, default=None)
    published_at = Column(DateTime(timezone=True), nullable=True, default=None)
    # Typed, versioned snapshot of the NON-layout Live config frozen at Publish
    # (binding / write / integrations). The public/live runtime resolves these
    # from here, NOT the mutable columns above — see runtime_config.py. NULL =
    # never published (or a legacy board pending backfill → resolver falls back
    # to the live columns).
    published_runtime_config = Column(JSONB, nullable=True, default=None)

    # Free-form per-workboard settings (theme, default filters, …).
    settings = Column(JSONB, nullable=True, default=None)

    owner_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    submissions = relationship(
        "WorkboardSubmission",
        back_populates="workboard",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    __table_args__ = (
        UniqueConstraint("slug", name="uq_workboards_slug"),
    )


class WorkboardSubmission(Base):
    """
    Audit-grade record of a single row mutation (insert/update/delete)
    performed through a workboard. Kept separate from ``audit_logs`` so
    high-volume data-entry traffic doesn't dominate the security audit
    feed and so we can query submissions per-workboard cheaply.
    """

    __tablename__ = "workboard_submissions"

    id = Column(Integer, primary_key=True, index=True)
    workboard_id = Column(
        Integer,
        ForeignKey("workboards.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # "insert" | "update" | "delete"
    action = Column(String(20), nullable=False)

    # Physical table that was mutated (qualified name when available).
    table_name = Column(String(500), nullable=False)

    # Primary key values used to locate the row (insert => RETURNING values,
    # update/delete => the values supplied by the caller).
    row_pk = Column(JSONB, nullable=True)

    # Sanitised payload that was sent to the DB (no raw secrets).
    payload = Column(JSONB, nullable=True)

    # Soft validation issues (severity=warning rules) recorded but not
    # blocking. Hard validation errors raise before the submission is
    # written, so they never reach this table.
    validation_warnings = Column(JSONB, nullable=False, server_default="[]")

    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True,
    )

    workboard = relationship("Workboard", back_populates="submissions")


class WorkboardWorkspace(Base):
    """A public-facing workspace bundling several workboards behind one link.

    The link target audience is end-users (workers, foremen, drivers...) who
    do *not* have AppBI accounts. They authenticate as Workboard app users
    stored in AppBI, while screen RLS binds those identities to business
    rows in the Workboard's dataset.

    Layout example::

        {
          "name": "Nhật ký sản xuất",
          "menu": [
            {"workboard_slug": "prod-shift", "label": "Khai báo ca",
             "roles": ["team_lead"]},
            {"workboard_slug": "prod-hourly", "label": "Báo cáo sản lượng",
             "roles": ["worker", "team_lead"]}
          ]
        }

    The runtime renders ``menu[]`` filtered by the logged-in app_user's role.
    """

    __tablename__ = "workboard_workspaces"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    slug = Column(String(120), nullable=True, unique=True, index=True)
    description = Column(Text, nullable=True)
    icon = Column(String(64), nullable=True)

    # Public access token — unguessable, opaque, used in /w/{token} URLs.
    token = Column(String(64), nullable=False, unique=True, index=True)

    # Access mode controls who can open the workspace's public link.
    #   - "internal": only AppBI-authenticated staff can open workboards
    #     through the workspace (admin/test path).
    #   - "public_app_users": end-users (workers, foremen) login via PIN
    #     against Workboard app-user rows stored by AppBI.
    access_mode = Column(
        String(32),
        nullable=False,
        server_default="internal",
    )

    # Menu config: list of {workboard_slug, label, icon, roles[]}.
    menu_config = Column(JSONB, nullable=False, server_default="[]")

    # Optional branding (logo, primary color, app_name shown in title bar).
    branding = Column(JSONB, nullable=True)

    is_active = Column(
        Boolean,
        nullable=False,
        default=True,
        server_default="true",
    )

    # Login session lifetime in seconds (default 8h ≈ one production shift).
    session_ttl_seconds = Column(
        Integer,
        nullable=False,
        server_default="28800",
    )

    owner_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint("slug", name="uq_workboard_workspaces_slug"),
        UniqueConstraint("token", name="uq_workboard_workspaces_token"),
    )


class WorkboardAppUser(Base):
    """End-user account scoped to a single workboard.

    Identity for the public mini-app login flow lives here, not in any
    project dataset. One row per (workboard, username); credentials are
    bcrypt-hashed in AppBI's own DB so dataset re-imports never wipe or
    leak them. ``context`` is a flexible bag the workboard's RLS rules
    read via ``{{app_user.<key>}}`` placeholders — vertical-specific
    fields (``nong_trai_id``, ``clinic_id``, ``dept_id`` …) live here
    without forcing a schema migration each time a new vertical is added.
    Mini-app hierarchy also lives in ``context``: ``manager_username`` links
    direct reports, while ``scope_admin_usernames`` / ``scope_usernames``
    grant branch or explicit-user visibility for scoped admin accounts.
    """

    __tablename__ = "workboard_app_users"

    id = Column(Integer, primary_key=True, index=True)
    workboard_id = Column(
        Integer,
        ForeignKey("workboards.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    username = Column(String(255), nullable=False)
    pin_hash = Column(String(255), nullable=False)
    full_name = Column(String(255), nullable=True)
    role = Column(String(64), nullable=True)
    active = Column(
        Boolean,
        nullable=False,
        default=True,
        server_default="true",
    )
    context = Column(JSONB, nullable=False, server_default="{}", default=dict)

    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint(
            "workboard_id", "username", name="uq_wb_app_user"
        ),
    )


class WorkboardPushSubscription(Base):
    """A Web Push subscription for one mini-app user on one device.

    Stored per (workboard, username, endpoint). The endpoint is the unique
    per-device push URL the browser hands us; p256dh + auth are the keys the
    server needs to encrypt payloads (RFC 8291). Sent via VAPID.
    """

    __tablename__ = "workboard_push_subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    workboard_id = Column(
        Integer,
        ForeignKey("workboards.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    username = Column(String(255), nullable=False, index=True)
    endpoint = Column(Text, nullable=False)
    p256dh = Column(String(255), nullable=False)
    auth = Column(String(255), nullable=False)
    user_agent = Column(String(500), nullable=True)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint(
            "workboard_id", "username", "endpoint", name="uq_wb_push_sub"
        ),
    )


class WorkboardSyncRun(Base):
    """One outbound webhook execution kicked off from a doc data_table block.

    A single trigger on the frontend may fan out to multiple webhooks; we
    write one row per (run, webhook) so each webhook has its own status,
    progress counters and response excerpt. All rows from the same fan-out
    share ``group_id`` so the public runtime can poll them as one unit.

    ``cancel_requested`` is the cooperative cancellation flag — the
    executor reads it between batches and stops if set. Stuck runs (still
    ``running`` long after process start) are reclaimed at startup by
    :func:`reap_stuck_sync_runs`.
    """

    __tablename__ = "workboard_sync_runs"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(String(32), nullable=False, unique=True, index=True)
    group_id = Column(String(32), nullable=False, index=True)

    workboard_id = Column(
        Integer,
        ForeignKey("workboards.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    screen_id = Column(String(64), nullable=False)
    block_index = Column(Integer, nullable=False)
    trigger_id = Column(String(64), nullable=False)
    webhook_id = Column(String(64), nullable=False)
    # Snapshot of the webhook URL at run time; the config may be edited later.
    webhook_url = Column(String(2048), nullable=False)
    webhook_name = Column(String(160), nullable=True)

    # pending | running | success | failed | partial | cancelled
    status = Column(String(20), nullable=False, server_default="pending", index=True)
    cancel_requested = Column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    total_rows = Column(Integer, nullable=False, default=0, server_default="0")
    total_batches = Column(Integer, nullable=False, default=0, server_default="0")
    completed_batches = Column(Integer, nullable=False, default=0, server_default="0")
    failed_batches = Column(Integer, nullable=False, default=0, server_default="0")

    last_response_status = Column(Integer, nullable=True)
    last_error = Column(Text, nullable=True)
    # Last response body excerpt (truncated to ~2KB) for debugging.
    response_excerpt = Column(JSONB, nullable=True)

    triggered_by_app_user_id = Column(
        Integer,
        ForeignKey("workboard_app_users.id", ondelete="SET NULL"),
        nullable=True,
    )
    triggered_by_user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    duration_ms = Column(Integer, nullable=True)

    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True,
    )


class WorkboardAutoNumberSequence(Base):
    """Running counter for ``LayoutJson.auto_number_columns``.

    Keyed by ``(workboard_id, column_name, bucket)``. ``bucket`` is the
    date partition (``"all"`` for ``reset='never'``, ``"2026"`` for yearly,
    ``"2026-05"`` for monthly, ``"2026-05-15"`` for daily). Scoped rules
    append a ``"|s|<sha256>"`` digest of the scope-column values so each scope
    counts independently within the same period (hence the 128-char width).
    The write service does an UPSERT-then-RETURNING to claim the next value
    atomically so two concurrent inserts cannot collide on the same id.
    """

    __tablename__ = "workboard_auto_number_sequences"

    id = Column(Integer, primary_key=True, index=True)
    workboard_id = Column(
        Integer,
        ForeignKey("workboards.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    column_name = Column(String(120), nullable=False)
    bucket = Column(String(128), nullable=False)
    next_value = Column(Integer, nullable=False, default=1, server_default="1")
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint(
            "workboard_id",
            "column_name",
            "bucket",
            name="uq_wb_auto_number_sequence",
        ),
    )


class WorkboardAppLoginAttempt(Base):
    """Rate-limit tracker for workspace app-user login attempts.

    Stores a sliding window of recent login failures per (workspace_id,
    username, ip_address) so the login endpoint can lock out brute-force
    attempts without forcing a full blocklist table.
    """

    __tablename__ = "workboard_app_login_attempts"

    id = Column(Integer, primary_key=True, index=True)
    workspace_id = Column(
        Integer,
        ForeignKey("workboard_workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    username_attempted = Column(String(255), nullable=False)
    ip_address = Column(String(64), nullable=True)
    success = Column(Boolean, nullable=False, default=False, server_default="false")
    attempted_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True,
    )


class WorkboardOpLog(Base):
    """Idempotency log for client-submitted write operations.

    Each offline form submit carries a client-generated ``op_id``. We INSERT
    the op_id here BEFORE writing the data row and cache the successful result.
    A replay returns the original row/PK, allowing dependent offline writes to
    resolve generated keys without inserting the parent twice.
    """

    __tablename__ = "workboard_op_log"

    op_id = Column(String(64), primary_key=True)
    workboard_id = Column(Integer, nullable=True, index=True)
    screen_id = Column(String(255), nullable=True)
    actor_key = Column(String(255), nullable=True)
    request_fingerprint = Column(String(64), nullable=True)
    result_payload = Column(JSONB, nullable=True)
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
