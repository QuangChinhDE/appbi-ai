"""Pydantic schemas for the Workboard module.

The workboard layout is a mini-app definition: a list of screens (form /
list / doc / dashboard), each bound to one dataset table, plus an
adaptive navigation config. This file is the single source of truth for
that contract — there is no legacy v1/v2 layer anymore.
"""
from __future__ import annotations

import builtins as _builtins
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Lookup config + form fields
# ---------------------------------------------------------------------------

class LookupHop(BaseModel):
    """One hop along a nested-lookup chain.

    A chain like ``orders.customer_id → customers.id, customers.city_id →
    cities.id`` resolves the ultimate label (city name) for an order. The
    primary table's foreign-key column is the option ``value``; the last
    hop's ``label_column`` provides the human-readable ``label``.
    """

    table_id: Optional[int] = None
    value_column: str = Field(..., min_length=1)
    label_column: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class LookupConfig(BaseModel):
    """Lookup data source for select / lookup form widgets."""

    kind: Literal["static", "dataset_table"] = "static"
    values: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        description="Static enum values: [{label, value}]",
    )
    table_id: Optional[int] = Field(
        default=None, description="dataset_tables.id when kind=dataset_table"
    )
    value_column: Optional[str] = None
    label_column: Optional[str] = None
    relationship_path: Optional[List[LookupHop]] = None

    model_config = ConfigDict(extra="forbid")


class FormField(BaseModel):
    column: str = Field(..., min_length=1, max_length=255)
    widget: Literal[
        "text",
        "textarea",
        "number",
        "select",
        "date",
        "datetime",
        "checkbox",
        "lookup",
    ] = "text"
    label: Optional[str] = None
    required: bool = False
    default: Optional[Any] = None
    help_text: Optional[str] = None
    placeholder: Optional[str] = None
    readonly: bool = False
    lookup: Optional[LookupConfig] = None
    section: Optional[str] = Field(
        default=None,
        description="Optional section heading for grouping inside one page",
    )
    page: Optional[int] = Field(
        default=None,
        ge=1,
        description="When a form declares pages[], this places the field on a specific page",
    )
    show_if: Optional[str] = Field(default=None, description="Hide field when expression is false")
    required_if: Optional[str] = Field(
        default=None,
        description="Mark field required only when expression is true (overrides static `required` if both set)",
    )
    readonly_if: Optional[str] = Field(default=None, description="Force readonly when expression is true")
    computed_from_dataset: Optional[str] = Field(
        default=None,
        description="Field name of the dataset transformation that produces this column",
    )

    model_config = ConfigDict(extra="forbid")


class FormPage(BaseModel):
    """A single page of a multi-step form."""

    id: int = Field(..., ge=1)
    title: str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = None
    show_if: Optional[str] = Field(
        default=None,
        description="Skip this page entirely when the expression is false (uses values from earlier pages).",
    )

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# List filters
# ---------------------------------------------------------------------------

class ListFilter(BaseModel):
    column: str = Field(..., min_length=1)
    kind: Literal["text", "select", "date_range", "number_range"] = "text"
    label: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Doc blocks (block-based rendering, independent of report layout modules)
# ---------------------------------------------------------------------------

class DocPage(BaseModel):
    size: Literal["A4", "A3", "Letter"] = "A4"
    orientation: Literal["portrait", "landscape"] = "portrait"
    margin_mm: int = Field(default=15, ge=0, le=50)

    model_config = ConfigDict(extra="forbid")


class HeaderBlock(BaseModel):
    type: Literal["header"]
    logo_url: Optional[str] = None
    title: str = ""
    subtitle: Optional[str] = None
    align: Literal["left", "center", "right"] = "center"

    model_config = ConfigDict(extra="forbid")


class KvGridItem(BaseModel):
    label: str = ""
    value: str = ""

    model_config = ConfigDict(extra="forbid")


class KvGridBlock(BaseModel):
    type: Literal["kv_grid"]
    columns: int = Field(default=2, ge=1, le=4)
    items: List[KvGridItem] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class DataTableColumnGroup(BaseModel):
    """One grouped header spanning several contiguous table columns."""

    label: str = Field(..., min_length=1, max_length=120)
    columns: List[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class DataTableUnpivot(BaseModel):
    """Unpivot wide → long.

    A "wide" source like ``(ma_kho, ngay, t1, t2, …, t12)`` becomes a "long"
    table ``(ma_kho, ngay, thang, so_luong)`` where each of the listed
    ``value_columns`` becomes one row with its column name in ``var_name``
    and its cell value in ``value_name``. Useful when the source is a
    Google Sheet with one column per month and the report wants a flat
    pivot-friendly shape.
    """

    kind: Literal["unpivot"]
    id_columns: List[str] = Field(default_factory=list)
    value_columns: List[str] = Field(default_factory=list, min_length=1)
    var_name: str = Field(default="variable", min_length=1, max_length=64)
    value_name: str = Field(default="value", min_length=1, max_length=64)
    drop_nulls: bool = True

    model_config = ConfigDict(extra="forbid")


class DataTablePivot(BaseModel):
    """Pivot long → wide (in-memory after fetch).

    Builds one column per distinct value of ``columns`` and aggregates
    ``values`` per ``(index…, columns)`` combination. ``max_columns`` is
    a safety cap — exceeding it raises 422 so a runaway pivot can't blow
    up the FE.
    """

    kind: Literal["pivot"]
    index: List[str] = Field(default_factory=list, min_length=1)
    columns: str = Field(..., min_length=1)
    values: str = Field(..., min_length=1)
    agg: Literal["sum", "avg", "min", "max", "count", "first"] = "sum"
    max_columns: int = Field(default=50, ge=1, le=200)
    fill_value: Optional[Any] = None

    model_config = ConfigDict(extra="forbid")


DataTableTransform = Union[DataTableUnpivot, DataTablePivot]


class DataTableBlock(BaseModel):
    type: Literal["data_table"]
    source: str = Field(
        default="primary",
        description="`primary` (the screen's bound table) or `lookup:<table_id>`",
    )
    columns: List[str] = Field(default_factory=list)
    column_groups: List[DataTableColumnGroup] = Field(default_factory=list)
    filters_from_view: bool = True
    totals: List[str] = Field(default_factory=list)
    group_by: List[str] = Field(default_factory=list)
    max_rows: int = Field(default=500, ge=1, le=5000)
    show_index: bool = False
    title: Optional[str] = None
    # Optional pivot/unpivot transform applied AFTER fetch but BEFORE
    # column projection, group_by merges and totals. Lets a wide source
    # be reported in long form (unpivot) or a long source be reported as
    # a matrix (pivot) without touching the underlying DB / Google Sheet.
    transform: Optional[DataTableTransform] = Field(
        default=None,
        discriminator="kind",
    )
    # When true the mini-app runtime shows a download button on this
    # block that exports the *rendered* table (post-transform) to XLSX.
    # Off by default so reports don't leak data unless the builder
    # opted in.
    allow_export_excel: bool = False

    model_config = ConfigDict(extra="forbid")


class TextBlock(BaseModel):
    type: Literal["text"]
    content: str = ""
    markdown: bool = False
    align: Literal["left", "center", "right"] = "left"

    model_config = ConfigDict(extra="forbid")


class SpacerBlock(BaseModel):
    type: Literal["spacer"]
    height_mm: int = Field(default=10, ge=1, le=200)

    model_config = ConfigDict(extra="forbid")


class SignatureSlot(BaseModel):
    label: str
    role: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class SignatureBlock(BaseModel):
    type: Literal["signature"]
    slots: List[SignatureSlot] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class FooterBlock(BaseModel):
    type: Literal["footer"]
    left: Optional[str] = None
    center: Optional[str] = None
    right: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


DocBlock = Union[
    HeaderBlock,
    KvGridBlock,
    DataTableBlock,
    TextBlock,
    SpacerBlock,
    SignatureBlock,
    FooterBlock,
]


# ---------------------------------------------------------------------------
# Cross-cutting layout sections
# ---------------------------------------------------------------------------

class AuditConfig(BaseModel):
    """Convention columns to auto-fill on writes when present in the table."""

    created_by_column: Optional[str] = None
    created_at_column: Optional[str] = None
    updated_by_column: Optional[str] = None
    updated_at_column: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class BrandingConfig(BaseModel):
    app_name: Optional[str] = None
    logo_url: Optional[str] = None
    primary_color: Optional[str] = Field(default=None, max_length=32)
    accent_color: Optional[str] = Field(default=None, max_length=32)
    theme: Literal["light", "dark", "auto"] = "auto"

    model_config = ConfigDict(extra="ignore")


# ---------------------------------------------------------------------------
# Screen actions + per-screen RLS
# ---------------------------------------------------------------------------

class ScreenAction(BaseModel):
    """An action button rendered inside a screen header / row.

    The simplest form is ``{label, go_to_screen, carry}``: clicking the
    button navigates the public runtime to ``go_to_screen`` while carrying
    the listed columns from the current row / form into the next screen's
    context. Carried values land in ``shared_context`` and prefill matching
    field columns on the destination screen.
    """

    id: str = Field(..., min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=120)
    icon: Optional[str] = None
    style: Literal["primary", "secondary", "ghost", "danger"] = "primary"
    go_to_screen: Optional[str] = None
    carry: List[str] = Field(default_factory=list)
    confirm_message: Optional[str] = None
    visible_for_roles: List[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ScreenRlsRule(BaseModel):
    """Per-screen RLS rule keyed by app-user role.

    Each screen reads/writes its own table so RLS is scoped per screen,
    not per workboard. The role string is matched (case-insensitive)
    against the logged-in app_user's role column.

    * ``unrestricted=True`` lets the role see every row on the screen's table.
    * Otherwise ``filter_column`` must equal ``filter_value`` (typically a
      placeholder such as ``{{app_user.username}}`` / ``{{app_user.team_id}}``).
    * ``writable_columns`` / ``readonly_columns`` constrain what fields the
      role may set on insert/update. Defaults: every column writable.
    """

    role: str = Field(..., min_length=1, max_length=64)
    unrestricted: bool = False
    filter_column: Optional[str] = None
    filter_value: Optional[Any] = Field(
        default=None,
        description="Static value or {{app_user.<col>}} placeholder",
    )
    can_create: bool = True
    can_update: bool = True
    can_delete: bool = False
    writable_columns: Optional[List[str]] = None
    readonly_columns: Optional[List[str]] = None

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Screen specs (one per kind)
# ---------------------------------------------------------------------------

class FormScreenSpec(BaseModel):
    """A data-entry screen bound to one dataset table.

    ``after_submit`` is what makes mini-apps feel like a flow rather than
    a row of disconnected forms: when the user saves, the runtime can
    auto-advance to ``go_to_screen`` and copy ``carry`` columns into
    ``shared_context``.
    """

    fields: List[FormField] = Field(default_factory=list)
    submit_label: Optional[str] = None
    after_submit: Optional[ScreenAction] = None
    initial_values: Dict[str, Any] = Field(
        default_factory=dict,
        description="Per-column defaults; supports {{app_user.x}} / {{today}} placeholders.",
    )
    pages: List[FormPage] = Field(default_factory=list)
    sections: List[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ListScreenSpec(BaseModel):
    """A read-only list screen bound to one dataset table."""

    columns: List[str] = Field(default_factory=list)
    filters: List[ListFilter] = Field(default_factory=list)
    page_size: int = Field(default=50, ge=10, le=500)
    default_sort_column: Optional[str] = None
    default_sort_direction: Literal["asc", "desc"] = "desc"
    row_actions: List[ScreenAction] = Field(default_factory=list)
    empty_state_message: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class DocScreenSpec(BaseModel):
    """A report/dashboard screen rendered from a doc-view layout."""

    page: DocPage = Field(default_factory=DocPage)
    blocks: List[DocBlock] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Screen + navigation + layout root
# ---------------------------------------------------------------------------

class Screen(BaseModel):
    """A single screen of the mini-app.

    The combination ``(kind, table_id)`` decides what runtime + write logic
    applies; ``rls`` is per-screen so e.g. the "Submit hourly output"
    screen filters by ``worker_username = {{app_user.username}}`` while
    the "Shift overview" screen filters by ``team_lead_username``.
    """

    id: str = Field(..., min_length=1, max_length=64)
    kind: Literal["form", "list", "doc", "dashboard"] = "form"
    title: str = Field(..., min_length=1, max_length=120)
    icon: Optional[str] = None
    description: Optional[str] = None
    table_id: Optional[int] = None
    primary_key_columns: List[str] = Field(default_factory=list)
    visible_for_roles: List[str] = Field(default_factory=list)
    show_in_nav: bool = True

    form: Optional[FormScreenSpec] = None
    list: Optional[ListScreenSpec] = None
    doc: Optional[DocScreenSpec] = None

    # Central column label map: {db_column_name: display_label}.
    # Used by list/doc screens to show friendly column headers instead of raw
    # column names. Example: {"nh_b50_025": "PLNC Bao 50 kg; Cỡ hạt ≤ 0,25mm"}
    column_labels: Dict[str, str] = Field(default_factory=dict)

    rls: List[ScreenRlsRule] = Field(default_factory=list)
    rls_default: Optional[ScreenRlsRule] = None

    model_config = ConfigDict(extra="forbid")


class MiniAppNav(BaseModel):
    """Adaptive navigation config for the public runtime.

    The runtime picks ``mobile_kind`` when the viewport is below 768px wide
    and ``desktop_kind`` otherwise. End users can override the auto-detected
    layout via a header toggle so a tablet user with a keyboard sees the
    desktop layout if they prefer.
    """

    mobile_kind: Literal["bottom_nav", "drawer"] = "bottom_nav"
    desktop_kind: Literal["sidebar", "top_tabs"] = "sidebar"
    items: List[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class LayoutJson(BaseModel):
    """Top-level workboard layout payload.

    A workboard is a mini-app: an ordered list of screens plus a navigation
    config. ``branding`` and ``audit`` are workboard-wide conventions
    consumed by the runtime and the write service respectively.
    """

    screens: List[Screen] = Field(default_factory=_builtins.list)
    mini_app_nav: MiniAppNav = Field(default_factory=MiniAppNav)
    branding: BrandingConfig = Field(default_factory=BrandingConfig)
    audit: AuditConfig = Field(default_factory=AuditConfig)

    # ignore unknown future fields rather than erroring out clients
    model_config = ConfigDict(extra="ignore")


# ---------------------------------------------------------------------------
# Workboard CRUD schemas
# ---------------------------------------------------------------------------

class WorkboardBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    slug: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=120,
        pattern=r"^[a-z0-9][a-z0-9-_]*$",
    )
    description: Optional[str] = None
    icon: Optional[str] = Field(default=None, max_length=64)


class WorkboardCreate(WorkboardBase):
    dataset_id: int = Field(..., gt=0)
    # primary_table_id is optional at creation — when omitted, the API auto-
    # picks the first physical table of the dataset so the user only has to
    # pick a dataset to start building. Each screen carries its own table_id
    # anyway; this field is a fallback referenced by the FK on the model.
    primary_table_id: Optional[int] = Field(default=None, gt=0)
    primary_key_columns: List[str] = Field(default_factory=list)
    layout_json: LayoutJson = Field(default_factory=LayoutJson)
    optimistic_lock_column: Optional[str] = Field(default=None, max_length=120)


class WorkboardUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    slug: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=120,
        pattern=r"^[a-z0-9][a-z0-9-_]*$",
    )
    description: Optional[str] = None
    icon: Optional[str] = Field(default=None, max_length=64)
    dataset_id: Optional[int] = Field(default=None, gt=0)
    primary_table_id: Optional[int] = Field(default=None, gt=0)
    layout_json: Optional[LayoutJson] = None
    optimistic_lock_column: Optional[str] = Field(default=None, max_length=120)
    is_published: Optional[bool] = None
    settings: Optional[Dict[str, Any]] = None


class WorkboardResponse(WorkboardBase):
    id: int
    dataset_id: int
    primary_table_id: int
    primary_key_columns: List[str] = Field(default_factory=list)
    lookup_tables: List[Dict[str, Any]] = Field(default_factory=list)
    layout_json: LayoutJson = Field(default_factory=LayoutJson)
    write_mode: str = "direct"
    optimistic_lock_column: Optional[str] = None
    is_published: bool = False
    version: int = 1
    settings: Optional[Dict[str, Any]] = None
    owner_id: Optional[UUID] = None
    owner_email: Optional[str] = None
    user_permission: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Row-level write payloads
# ---------------------------------------------------------------------------

class WorkboardRowPayload(BaseModel):
    """Generic envelope for INSERT/UPDATE row submissions."""

    values: Dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")


class WorkboardRowUpdatePayload(WorkboardRowPayload):
    """UPDATE/DELETE require row PK + optional optimistic-lock token."""

    pk: Dict[str, Any] = Field(..., description="Primary key column → value")
    lock_token: Optional[Any] = Field(
        default=None,
        description="Value of optimistic_lock_column captured when row was loaded.",
    )

    model_config = ConfigDict(extra="forbid")


class WorkboardRowDeletePayload(BaseModel):
    pk: Dict[str, Any] = Field(...)
    lock_token: Optional[Any] = None

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# App-user CRUD (Builder "Users" tab)
# ---------------------------------------------------------------------------

class AppUserCreate(BaseModel):
    """Admin payload for creating a workboard app-user.

    PIN is sent in plain text and bcrypt-hashed before storage. Username
    must be unique within the workboard *and* across all workboards
    sharing a workspace menu — the latter is enforced server-side because
    the public login form has no idea which workboard a username belongs
    to until match time.
    """

    username: str = Field(..., min_length=1, max_length=255)
    pin: str = Field(..., min_length=1, max_length=128)
    full_name: Optional[str] = Field(default=None, max_length=255)
    role: Optional[str] = Field(default=None, max_length=64)
    active: bool = True
    context: Dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")


class AppUserUpdate(BaseModel):
    """All fields optional; PATCH semantics. Pass ``pin`` to reset PIN."""

    username: Optional[str] = Field(default=None, min_length=1, max_length=255)
    pin: Optional[str] = Field(default=None, min_length=1, max_length=128)
    full_name: Optional[str] = Field(default=None, max_length=255)
    role: Optional[str] = Field(default=None, max_length=64)
    active: Optional[bool] = None
    context: Optional[Dict[str, Any]] = None

    model_config = ConfigDict(extra="forbid")


class AppUserResponse(BaseModel):
    id: int
    workboard_id: int
    username: str
    full_name: Optional[str] = None
    role: Optional[str] = None
    active: bool
    context: Dict[str, Any] = Field(default_factory=dict)
    has_pin: bool = True
    using_default_pin: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AppUserBulkImport(BaseModel):
    """Used by the import flow + the Users tab CSV uploader."""

    users: List[Dict[str, Any]] = Field(default_factory=list)
    skip_existing: bool = True

    model_config = ConfigDict(extra="forbid")


class WorkboardWriteResult(BaseModel):
    """Standard envelope returned by row-write endpoints."""

    action: Literal["insert", "update", "delete"]
    row: Optional[Dict[str, Any]] = None
    pk: Optional[Dict[str, Any]] = None
    affected_rows: int = 0
    warnings: List[Dict[str, Any]] = Field(default_factory=list)
    submission_id: Optional[int] = None

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Runtime (table list) responses
# ---------------------------------------------------------------------------

class WorkboardRowsRequest(BaseModel):
    """Filters + pagination for the list view."""

    filters: List[Dict[str, Any]] = Field(default_factory=list)
    page: int = Field(default=1, ge=1)
    page_size: Optional[int] = Field(default=None, ge=1, le=500)
    sort_column: Optional[str] = None
    sort_direction: Optional[Literal["asc", "desc"]] = None

    model_config = ConfigDict(extra="forbid")


class WorkboardRowsResponse(BaseModel):
    columns: List[str] = Field(default_factory=list)
    rows: List[Dict[str, Any]] = Field(default_factory=list)
    total: Optional[int] = None
    page: int = 1
    page_size: int = 50
    has_more: bool = False


# ---------------------------------------------------------------------------
# Public links / public runtime
# ---------------------------------------------------------------------------

class WorkboardPublicLinkCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    mode: Literal["form", "view"] = "form"
    view_id: Optional[str] = Field(default=None, min_length=1, max_length=128)
    password: Optional[str] = Field(default=None, min_length=1, max_length=128)


class WorkboardPublicLinkUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    mode: Optional[Literal["form", "view"]] = None
    view_id: Optional[str] = Field(default=None, max_length=128)
    is_active: Optional[bool] = None
    # None = no change; empty string = clear password; non-empty = set new password
    password: Optional[str] = Field(default=None, max_length=128)


class WorkboardPublicLinkResponse(BaseModel):
    id: str
    name: str
    token: str
    mode: Literal["form", "view"] = "form"
    view_id: Optional[str] = None
    is_active: bool = True
    has_password: bool = False
    access_count: int = 0
    last_accessed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class WorkboardPublicAuthResponse(BaseModel):
    session_token: str
    expires_in: int


class WorkboardPublicPayload(BaseModel):
    workboard: Dict[str, Any]
    link: WorkboardPublicLinkResponse
    mode: Literal["form", "view"] = "form"
    form: Optional[Dict[str, Any]] = None
    rendered_view: Optional[Dict[str, Any]] = None
