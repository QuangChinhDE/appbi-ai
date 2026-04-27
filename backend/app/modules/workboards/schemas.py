"""Pydantic schemas for the Workboard module.

LayoutJson is versioned. v2 = AppSheet-style multi-table / multi-view app.
v1 inputs are auto-upgraded by a ``model_validator(mode='before')`` so that
existing rows continue to load.
"""
from __future__ import annotations

import builtins as _builtins
import uuid as _uuid
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ---------------------------------------------------------------------------
# Form view
# ---------------------------------------------------------------------------

class LookupHop(BaseModel):
    """One hop along a nested-lookup chain.

    A chain like ``orders.customer_id → customers.id, customers.city_id →
    cities.id`` resolves the ultimate label (city name) for an order. The
    primary table's foreign-key column is the option ``value``; the last
    hop's ``label_column`` provides the human-readable ``label``.
    """

    # Optional so imported templates with unresolved tables can still
    # round-trip — the builder shows them as "needs wiring" instead of
    # 500-ing on layout deserialisation.
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
    table_id: Optional[int] = Field(default=None, description="dataset_tables.id when kind=dataset_table")
    value_column: Optional[str] = None
    label_column: Optional[str] = None
    # Optional join chain. When set, the final option label is taken from
    # the last hop's ``label_column`` instead of the directly referenced
    # table. The original ``table_id``/``value_column``/``label_column``
    # remain authoritative for the immediate FK so single-hop configs keep
    # working unchanged.
    relationship_path: Optional[List[LookupHop]] = None

    model_config = ConfigDict(extra="forbid")


_FORM_WIDGETS = (
    "text",
    "textarea",
    "number",
    "select",
    "date",
    "datetime",
    "checkbox",
    "lookup",
)


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
    # Multi-step / section-grouped form support.
    section: Optional[str] = Field(
        default=None, description="Optional section heading for grouping inside one page"
    )
    page: Optional[int] = Field(
        default=None,
        ge=1,
        description="When a form declares pages[], this places the field on a specific page",
    )
    # Conditional visibility — uses the dataset transformation grammar
    # ([col_name] == 0, IF([x] > 0, true, false), &&, ||, etc.). Evaluated
    # client-side (runtime) and server-side (write enforcement).
    show_if: Optional[str] = Field(default=None, description="Hide field when expression is false")
    required_if: Optional[str] = Field(
        default=None,
        description="Mark field required only when expression is true (overrides static `required` if both set)",
    )
    readonly_if: Optional[str] = Field(default=None, description="Force readonly when expression is true")
    # Reference a dataset table's transformations.add_column expression.
    # When set, the value is computed client-side from the same expression
    # and not editable, so a single source-of-truth lives in the dataset.
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


class FormView(BaseModel):
    title: Optional[str] = None
    fields: List[FormField] = Field(default_factory=list)
    submit_label: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# List/table view
# ---------------------------------------------------------------------------

class ListFilter(BaseModel):
    column: str = Field(..., min_length=1)
    kind: Literal["text", "select", "date_range", "number_range"] = "text"
    label: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class ListView(BaseModel):
    columns: List[str] = Field(default_factory=list)
    filters: List[ListFilter] = Field(default_factory=list)
    page_size: int = Field(default=50, ge=10, le=500)
    row_actions: List[Literal["edit", "delete", "duplicate"]] = Field(default_factory=list)
    default_sort_column: Optional[str] = None
    default_sort_direction: Literal["asc", "desc"] = "desc"

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Doc view (block-based, independent of report layout modules)
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


class DataTableBlock(BaseModel):
    type: Literal["data_table"]
    source: str = Field(
        default="primary",
        description="`primary` (the workboard's primary table) or `lookup:<table_id>`",
    )
    columns: List[str] = Field(default_factory=list)
    filters_from_view: bool = True
    totals: List[str] = Field(default_factory=list)
    # Phase 1 merge: rows are sorted by these columns and consecutive rows
    # sharing the same value collapse into a single rowspan cell. Empty list
    # = no merging (legacy flat-table behaviour).
    group_by: List[str] = Field(default_factory=list)
    max_rows: int = Field(default=500, ge=1, le=5000)
    show_index: bool = False
    title: Optional[str] = None

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


class DocView(BaseModel):
    id: str = Field(..., min_length=1, max_length=64)
    title: Optional[str] = None
    page: DocPage = Field(default_factory=DocPage)
    blocks: List[DocBlock] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Cross-cutting layout sections
# ---------------------------------------------------------------------------

class RlsRoleRule(BaseModel):
    """Per-role RLS recipe used when the workboard is opened via a workspace.

    The role string is matched (case-insensitive) against the logged-in
    app_user's role column. ``unrestricted=True`` lets the role see every
    row; otherwise ``filter_column`` must equal ``filter_value`` (which is
    typically a placeholder like ``{{app_user.username}}`` /
    ``{{app_user.team_id}}``).

    Optional ``writable_columns`` and ``readonly_columns`` constrain what
    fields the role may set on insert/update; by default every column is
    writable.
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


class RowLevelSecurity(BaseModel):
    """RLS configuration used by both AppBI users and workspace app users.

    * ``enabled=False`` → no filtering, every authenticated caller sees
      every row (legacy behaviour).
    * ``owner_column`` (legacy) → simple "rows owned by current AppBI user"
      filter; kept for backward compatibility with the previous schema.
    * ``app_user_rules`` → per-role filtering applied when the request
      arrives through a workspace public link. Workers, foremen, and
      admins can each have their own filter recipe.
    * ``app_user_default`` (optional) → fall-back rule applied to roles
      not covered by ``app_user_rules``. Defaults to "deny everything".
    """

    enabled: bool = False
    owner_column: Optional[str] = Field(
        default=None,
        description="Column whose value must equal current user id (e.g. 'created_by').",
    )
    app_user_rules: List[RlsRoleRule] = Field(default_factory=list)
    app_user_default: Optional[RlsRoleRule] = None

    model_config = ConfigDict(extra="forbid")


class AuditConfig(BaseModel):
    """Convention columns to auto-fill on writes when present in the table."""

    created_by_column: Optional[str] = None
    created_at_column: Optional[str] = None
    updated_by_column: Optional[str] = None
    updated_at_column: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# v2 — AppSheet-style multi-table / multi-view layout
# ---------------------------------------------------------------------------

VIEW_KINDS = (
    "table",
    "deck",
    "detail",
    "form",
    "gallery",
    "calendar",
    "map",
    "chart",
    "dashboard",
    "onboarding",
)


class BrandingConfig(BaseModel):
    app_name: Optional[str] = None
    logo_url: Optional[str] = None
    primary_color: Optional[str] = Field(default=None, max_length=32)
    accent_color: Optional[str] = Field(default=None, max_length=32)
    theme: Literal["light", "dark", "auto"] = "auto"

    model_config = ConfigDict(extra="ignore")


class ColumnConfig(BaseModel):
    label: Optional[str] = None
    type: Optional[str] = None
    required: bool = False
    editable: bool = True
    show: bool = True
    show_in: List[Literal["table", "detail", "form"]] = Field(default_factory=list)
    initial_value_expr: Optional[str] = None
    formula_expr: Optional[str] = None
    valid_if_expr: Optional[str] = None
    show_if_expr: Optional[str] = None
    editable_if_expr: Optional[str] = None
    required_if_expr: Optional[str] = None
    enum_values: Optional[List[Dict[str, Any]]] = None
    ref_table_id: Optional[str] = None
    ref_action: Optional[Literal["navigate", "inline"]] = None

    model_config = ConfigDict(extra="ignore")


class AppTable(BaseModel):
    id: str = Field(..., min_length=1)
    # Nullable so imported templates with unresolved tables can still
    # round-trip — the builder surfaces them as "needs wiring".
    table_id: Optional[int] = Field(default=None, description="dataset_tables.id")
    label: Optional[str] = None
    icon: Optional[str] = None
    label_column: Optional[str] = None
    pk: List[str] = Field(default_factory=list)
    column_config: Dict[str, ColumnConfig] = Field(default_factory=dict)

    model_config = ConfigDict(extra="ignore")


class AppRef(BaseModel):
    id: str
    from_table: str
    from_column: str
    to_table: str
    to_column: str
    cardinality: Literal["one_to_many", "many_to_one"] = "one_to_many"
    inline_view: Optional[str] = None

    model_config = ConfigDict(extra="ignore")


class AppSlice(BaseModel):
    id: str
    label: str
    source_table: str
    row_filter_expr: Optional[str] = None
    visible_columns: Optional[List[str]] = None
    sort: Optional[List[Dict[str, Any]]] = None
    action_ids: List[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


class AppAction(BaseModel):
    id: str
    label: str
    source_table: str
    kind: Literal[
        "navigate",
        "set_values",
        "open_url",
        "compose_email",
        "webhook",
        "add_row",
        "delete_row",
        "go_back",
    ]
    icon: Optional[str] = None
    condition_expr: Optional[str] = None
    prominence: Literal["overlay", "display", "inline", "detail_only"] = "display"
    # per-kind config (kept open)
    navigate_to: Optional[str] = None  # view id
    set_columns: Optional[List[Dict[str, Any]]] = None
    url: Optional[str] = None
    email: Optional[Dict[str, Any]] = None
    webhook: Optional[Dict[str, Any]] = None
    add_to_table: Optional[str] = None
    add_with_values: Optional[Dict[str, Any]] = None
    confirm_message: Optional[str] = None

    model_config = ConfigDict(extra="ignore")


class AppViewSource(BaseModel):
    kind: Literal["table", "slice"] = "table"
    id: str

    model_config = ConfigDict(extra="ignore")


class AppView(BaseModel):
    id: str
    label: str
    kind: Literal[
        "table",
        "deck",
        "detail",
        "form",
        "gallery",
        "calendar",
        "map",
        "chart",
        "dashboard",
        "onboarding",
    ]
    source: AppViewSource
    position: Literal["primary", "menu", "ref", "system"] = "menu"
    icon: Optional[str] = None
    visible_columns: Optional[List[str]] = None
    group_by: Optional[str] = None
    sort: Optional[List[Dict[str, Any]]] = None
    action_ids: List[str] = Field(default_factory=list)
    # per-kind, free-form config blob (validated by FE)
    config: Dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="ignore")


class NavConfig(BaseModel):
    primary_view: Optional[str] = None
    menu_view_ids: List[str] = Field(default_factory=list)
    bottom_tab_view_ids: List[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


class ColumnPermPolicy(BaseModel):
    table: str
    column: str
    read_if_expr: Optional[str] = None
    edit_if_expr: Optional[str] = None

    model_config = ConfigDict(extra="ignore")


class SecurityConfig(BaseModel):
    rls: RowLevelSecurity = Field(default_factory=RowLevelSecurity)
    column_perms: List[ColumnPermPolicy] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


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

    Mirrors :class:`RlsRoleRule` but applies *only* on this screen's table.
    Each screen reads/writes its own table so RLS is scoped per screen,
    not per workboard.
    """

    role: str = Field(..., min_length=1, max_length=64)
    unrestricted: bool = False
    filter_column: Optional[str] = None
    filter_value: Optional[Any] = None
    can_create: bool = True
    can_update: bool = True
    can_delete: bool = False
    writable_columns: Optional[List[str]] = None
    readonly_columns: Optional[List[str]] = None

    model_config = ConfigDict(extra="forbid")


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
    # Multi-step support. When ``pages`` has 2+ entries the runtime renders a
    # wizard with Back/Next + a progress indicator; fields are placed on the
    # page declared by ``field.page`` (defaults to page 1).
    pages: List[FormPage] = Field(default_factory=list)
    # Section list — purely visual heading groups inside one page. Fields
    # whose ``section`` matches a section's title appear under that heading.
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
    # Bind to one dataset_tables.id. Required for form/list, optional for doc.
    table_id: Optional[int] = None
    primary_key_columns: List[str] = Field(default_factory=list)
    # Roles allowed to see this screen at all. Empty list = visible to every
    # logged-in app user (subject to RLS).
    visible_for_roles: List[str] = Field(default_factory=list)
    # Whether to show in the bottom-nav / sidebar.
    show_in_nav: bool = True

    form: Optional[FormScreenSpec] = None
    list: Optional[ListScreenSpec] = None
    doc: Optional[DocScreenSpec] = None

    rls: List[ScreenRlsRule] = Field(default_factory=list)
    rls_default: Optional[ScreenRlsRule] = None

    model_config = ConfigDict(extra="forbid")


class MiniAppNav(BaseModel):
    """Adaptive navigation config for the public runtime.

    The runtime picks ``mobile_kind`` when the viewport is below 768px
    wide and ``desktop_kind`` otherwise. End users can override the
    auto-detected layout via a header toggle so a tablet user with a
    keyboard sees the desktop layout if they prefer.
    """

    mobile_kind: Literal["bottom_nav", "drawer"] = "bottom_nav"
    desktop_kind: Literal["sidebar", "top_tabs"] = "sidebar"
    # Ordered list of screen ids that appear in the nav. Defaults to every
    # screen with show_in_nav=True in declaration order.
    items: List[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class LayoutJson(BaseModel):
    """Top-level workboard layout payload (v1 + v2 union).

    v1 (legacy): single primary table, with `form` + `list` + `doc_views` only.
    v2: multi-table / multi-view AppSheet-style. v1 docs are auto-upgraded to
    v2 on read by ``crud_service._normalize_layout``; both shapes coexist
    in the JSONB column for backward-compatibility.
    """

    version: int = 1

    # v1 fields (kept for back-compat & doc engine reuse)
    form: FormView = Field(default_factory=FormView)
    list: ListView = Field(default_factory=ListView)
    # Use builtins here because the `list` field above shadows the builtin name
    # inside the class body, which breaks Pydantic's default_factory handling.
    doc_views: List[DocView] = Field(default_factory=_builtins.list)
    rls: RowLevelSecurity = Field(default_factory=RowLevelSecurity)
    audit: AuditConfig = Field(default_factory=AuditConfig)

    # v2 additive fields
    branding: BrandingConfig = Field(default_factory=BrandingConfig)
    tables: List[AppTable] = Field(default_factory=_builtins.list)
    refs: List[AppRef] = Field(default_factory=_builtins.list)
    slices: List[AppSlice] = Field(default_factory=_builtins.list)
    actions: List[AppAction] = Field(default_factory=_builtins.list)
    views: List[AppView] = Field(default_factory=_builtins.list)
    nav: NavConfig = Field(default_factory=NavConfig)
    security: SecurityConfig = Field(default_factory=SecurityConfig)

    # Mini-app fields (M1+) — the modern layout. When ``screens`` is
    # non-empty the workboard is treated as a mini-app and the public
    # runtime renders an app shell with adaptive navigation. When empty,
    # the runtime falls back to the legacy single-form layout above.
    screens: List[Screen] = Field(default_factory=_builtins.list)
    mini_app_nav: MiniAppNav = Field(default_factory=MiniAppNav)

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
    # pick a dataset to start building. The mini-app screens[] each carry
    # their own table_id anyway; this field is a v1-layout fallback.
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
