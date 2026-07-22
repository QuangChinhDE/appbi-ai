"""Pydantic schemas for the Workboard module.

The workboard layout is a mini-app definition: a list of screens
(``form`` / ``table`` / ``doc`` / ``dashboard``), each bound to one
dataset table, plus an adaptive navigation config. This file is the
single source of truth for that contract.

Phase-13 (2026-05-16): the previous ``list`` (read-only) and ``grid``
(editable) screen kinds were collapsed into a single ``table`` kind with
a ``mode: readonly | editable`` flag. No backwards-compatibility shim —
clients/MCP/templates emit ``kind='table'`` directly.
"""
from __future__ import annotations

import builtins as _builtins
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator


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
    """Lookup data source for select / lookup / map form widgets."""

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

    # ── Map widget (widget='map') — additive geometry projection ─────────────
    # These are consumed ONLY by the map widget. select/lookup ignore them.
    # When set, `_resolve_lookup_options` projects the extra column(s) into
    # each option dict so the FE can draw one polygon/marker per row.
    geometry_column: Optional[str] = Field(
        default=None,
        description="Column holding a GeoJSON Polygon/MultiPolygon string per row (map widget).",
    )
    lat_column: Optional[str] = Field(
        default=None, description="Centroid latitude column — marker fallback when geometry is absent."
    )
    lng_column: Optional[str] = Field(
        default=None, description="Centroid longitude column — marker fallback when geometry is absent."
    )
    basemap: Optional[Literal["satellite", "streets", "light"]] = Field(
        default="satellite", description="Basemap tile style for the map widget."
    )

    # ── Dependent / cascading lookup (widget=select/lookup) ──────────────────
    # When set, the FE narrows the options to the rows whose `filter_column`
    # equals the current value of another form field (`filter_by_field`).
    # `_resolve_lookup_options` projects `filter_column` into each option so the
    # FE can filter client-side as the parent field changes.
    filter_by_field: Optional[str] = Field(
        default=None,
        description="Column of ANOTHER form field whose value narrows these options (cascading select).",
    )
    filter_column: Optional[str] = Field(
        default=None,
        description="Remote column on the lookup table matched against filter_by_field's value.",
    )

    model_config = ConfigDict(extra="forbid")


class StatusState(BaseModel):
    """One state in a status/approval widget."""

    value: str = Field(..., min_length=1, max_length=64)
    label: Optional[str] = Field(default=None, max_length=120)
    color: Optional[str] = Field(
        default=None,
        description="Badge tone: slate|green|amber|red|blue|violet (FE maps to Tailwind).",
    )

    model_config = ConfigDict(extra="forbid")


class StatusConfig(BaseModel):
    """Config for widget='status' — a colored lifecycle select with per-role gating.

    Distinct from a plain select: it renders a badge, and `editable_by_roles`
    restricts WHO may change it (approval gate) on top of the screen RLS
    ``writable_columns``. Empty ``editable_by_roles`` = every role that can write
    the row may change it.
    """

    states: List[StatusState] = Field(default_factory=list)
    editable_by_roles: List[str] = Field(
        default_factory=list,
        description="Roles allowed to change the status. Empty = anyone who can write the row.",
    )
    allowed_transitions: Dict[str, List[str]] = Field(
        default_factory=dict,
        description=(
            "Optional lifecycle guard: from-value -> allowed to-values. When set, the "
            "SERVER blocks any status change whose (previous -> new) pair is not listed "
            "(an empty list for a value = terminal state). A value absent from the map "
            "is unconstrained. Because status_config is per-field-per-screen, giving a "
            "role its own screen with a narrower map yields per-role transitions "
            "(e.g. the driver's form omits '-> Huỷ', the manager's form allows it)."
        ),
    )

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
        "file",
        "image",
        "map",
        "geopoint",   # capture device GPS -> "lat,lng"
        "images",     # multiple photos -> JSON array of data URLs
        "signature",  # canvas signature -> data:image PNG
        "barcode",    # QR/barcode scan (BarcodeDetector) + manual fallback
        "audio",      # voice note -> data:audio data URL
        "computed",   # readonly, value computed live from `formula`
        "status",     # colored lifecycle select (approval)
        # ── Rich input types (AppSheet-parity) ──────────────────────────
        "email",      # typed text, email validation + mailto: view
        "phone",      # typed text, tel: view + numeric inputmode
        "url",        # typed text, url validation + link view
        "rich_text",  # markdown editor -> markdown string
        "enum_list",  # multi-select chips -> JSON array (source = lookup)
        "rating",     # star rating -> number
        "slider",     # range slider -> number
        "currency",   # money input -> number (raw), symbol via currency_code
        "percent",    # percent input -> number (0-100)
        "time",       # time-of-day -> "HH:MM"
        "duration",   # h/m -> total minutes (number)
        "color",      # color picker -> hex string
        "video",      # short capture/upload -> data:video data URL
        "qr",         # display-only: render a QR from a column value / template (print label)
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
    valid_if: Optional[str] = Field(
        default=None,
        description=(
            "Expression that MUST evaluate truthy at submit time. Use to enforce "
            "cross-field rules the database cannot express on its own, e.g. "
            "`[end_date] >= [start_date]` or `[status] != 'cancelled' || [reason] != null`. "
            "When falsy the submit is blocked with `valid_if_error` (or a default message)."
        ),
    )
    valid_if_error: Optional[str] = Field(
        default=None,
        max_length=200,
        description="User-facing message shown when valid_if rejects the value.",
    )
    computed_from_dataset: Optional[str] = Field(
        default=None,
        description="Field name of the dataset transformation that produces this column",
    )
    max_file_kb: Optional[int] = Field(
        default=None,
        ge=1,
        le=10240,
        description=(
            "For widget='file' / 'image' / 'images' / 'signature' / 'audio': max size "
            "in KB the FE will accept per item. BE enforces a hard ceiling at 1024 KB "
            "regardless — media is base64-into-JSONB so anything larger destroys the row."
        ),
    )
    # ── Capture / media extras ───────────────────────────────────────────────
    capture_only: Optional[bool] = Field(
        default=None,
        description="widget=image/images: force live camera capture (no gallery pick) — field-work anti-fraud.",
    )
    max_items: Optional[int] = Field(
        default=None, ge=1, le=20,
        description="widget=images: max number of photos.",
    )
    unit: Optional[str] = Field(
        default=None, max_length=16,
        description="widget=number/computed: unit suffix shown after the value (e.g. 'kg', '%').",
    )
    formula: Optional[str] = Field(
        default=None, max_length=1000,
        description=(
            "widget=computed: arithmetic expression over [other_column] evaluated LIVE "
            "on the form and stored on submit, e.g. `[san_luong] * [drc] / 100`."
        ),
    )
    status_config: Optional[StatusConfig] = Field(
        default=None, description="widget=status only: the lifecycle states + approval gating.",
    )
    # ── Rich input-type config ───────────────────────────────────────────────
    max_stars: Optional[int] = Field(
        default=None, ge=1, le=10, description="widget=rating: number of stars (default 5).",
    )
    allow_half: Optional[bool] = Field(
        default=None, description="widget=rating: allow half-star values.",
    )
    min_value: Optional[float] = Field(
        default=None, description="widget=slider: minimum value (default 0).",
    )
    max_value: Optional[float] = Field(
        default=None, description="widget=slider: maximum value (default 100).",
    )
    step: Optional[float] = Field(
        default=None, gt=0, description="widget=slider: step increment (default 1).",
    )
    currency_code: Optional[str] = Field(
        default=None, max_length=8,
        description="widget=currency: ISO code / symbol shown (e.g. 'VND', '$').",
    )
    max_select: Optional[int] = Field(
        default=None, ge=1, le=50,
        description="widget=enum_list: max number of selected chips.",
    )
    # ── QR display (widget='qr') — renders a QR image, never writes the column ──
    qr_source_column: Optional[str] = Field(
        default=None,
        description="widget=qr: column whose current value is encoded. Defaults to this field's own `column`.",
    )
    qr_value_template: Optional[str] = Field(
        default=None, max_length=1000,
        description=(
            "widget=qr: a template encoded instead of a single column, with [other_column] "
            "placeholders (e.g. a deep-link URL). Takes precedence over qr_source_column."
        ),
    )
    qr_size: Optional[int] = Field(
        default=None, ge=48, le=1024, description="widget=qr: rendered size in px (default 160).",
    )
    qr_caption: Optional[str] = Field(
        default=None, max_length=200, description="widget=qr: text printed under the code.",
    )
    # ── Scan -> navigate (widget='barcode') — jump to a screen carrying the code ─
    scan_go_to_screen: Optional[str] = Field(
        default=None,
        description="widget=barcode: on a successful scan, navigate to this screen id (in-app scan-to-form).",
    )
    scan_carry_as: Optional[str] = Field(
        default=None, max_length=255,
        description="widget=barcode: column name the scanned value is carried under to scan_go_to_screen (default = this field's column).",
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
    columns: Union[str, List[str]] = Field(..., description="Column key (str) or list of keys for multi-level pivot")
    values: str = Field(..., min_length=1)
    agg: Literal["sum", "avg", "min", "max", "count", "first"] = "sum"
    max_columns: int = Field(default=50, ge=1, le=200)
    fill_value: Optional[Any] = None

    model_config = ConfigDict(extra="forbid")


DataTableTransform = Union[DataTableUnpivot, DataTablePivot]


class DataTableColumnMeta(BaseModel):
    """Optional per-column presentation metadata written by the builder.

    The runtime currently still consumes `columns`, `group_by`, `totals`
    as the canonical contract — the builder derives those arrays from
    `column_metadata` and ships both, so this block is purely additive
    until the runtime is taught to read it.
    """

    label: Optional[str] = None
    width_px: Optional[int] = Field(default=None, ge=1, le=2000)
    format: Optional[str] = None
    align: Optional[Literal["left", "center", "right"]] = None
    total: Optional[Literal["sum", "avg", "count", "min", "max"]] = None
    merge: Optional[bool] = None

    model_config = ConfigDict(extra="forbid")


class DataTableSyncTrigger(BaseModel):
    """A "Sync" button rendered on a doc ``data_table`` block.

    The trigger references one or more workboard-level webhook configs
    (see ``WorkboardWebhookConfig``) by id and fans the resolved table
    out to each of them. Multiple webhooks per trigger run either in
    parallel (default) or one-after-the-other.
    """

    id: str = Field(..., min_length=1, max_length=64)
    label: str = Field(default="Đồng bộ", min_length=1, max_length=120)
    icon: Optional[str] = None
    confirm_message: Optional[str] = None
    webhook_ids: List[str] = Field(default_factory=list, min_length=1)
    run_mode: Literal["parallel", "sequential"] = "parallel"
    # When sequential, by default stop the chain on the first failure.
    # Has no effect when run_mode == "parallel".
    stop_chain_on_error: bool = True
    visible_for_roles: List[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class DataTableContextFilter(BaseModel):
    """Filter a doc data_table by a value carried in the runtime shared context.

    When a row action (or a POS submit) navigates to a doc screen carrying e.g.
    ``ma_don``, that value lands in the shared context. Binding it here makes a
    per-record document — a printable phiếu — show ONLY that record's rows
    instead of every row the viewer can see.
    """

    column: str = Field(..., min_length=1, description="data_table column to filter.")
    from_shared: str = Field(
        ..., min_length=1, description="Key in the shared context that supplies the match value."
    )
    required: bool = Field(
        default=True,
        description="When the shared value is absent: True → show no rows; False → skip this filter.",
    )

    model_config = ConfigDict(extra="forbid")


class DataTableBlock(BaseModel):
    type: Literal["data_table"]
    source: str = Field(
        default="primary",
        description="`primary` (the screen's bound table) or `lookup:<table_id>`",
    )
    context_filters: List[DataTableContextFilter] = Field(
        default_factory=list,
        description="Filter rows by runtime shared-context values (for per-record docs like a printable phiếu).",
    )
    columns: List[str] = Field(default_factory=list)
    column_groups: List[DataTableColumnGroup] = Field(default_factory=list)
    column_metadata: Dict[str, DataTableColumnMeta] = Field(default_factory=dict)
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
    # Optional "Sync" buttons that POST the rendered table to webhooks.
    sync_triggers: List[DataTableSyncTrigger] = Field(default_factory=list)

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


class QrCodeBlock(BaseModel):
    """A QR code rendered on a printable doc (e.g. a shipping label).

    ``value`` is the string encoded — a static code or a placeholder such as
    ``{{shared.ma_don}}`` / ``{{app_user.username}}`` resolved server-side at
    render time. Pair it with a HeaderBlock/KvGridBlock to build a full label.
    """

    type: Literal["qr_code"]
    value: str = ""
    size: int = Field(default=180, ge=48, le=1024)
    caption: Optional[str] = Field(default=None, max_length=200)
    align: Literal["left", "center", "right"] = "center"

    model_config = ConfigDict(extra="forbid")


DocBlock = Union[
    HeaderBlock,
    KvGridBlock,
    DataTableBlock,
    TextBlock,
    SpacerBlock,
    SignatureBlock,
    FooterBlock,
    QrCodeBlock,
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


class ThemeBackground(BaseModel):
    """Background for the app shell or login page. Images are stored as a
    bounded ``data:`` URI (the FE compresses on upload) so they satisfy the
    ``img-src 'self' data:`` CSP — external URLs are blocked in production."""

    kind: Literal["color", "gradient", "image"] = "color"
    color: Optional[str] = Field(default=None, max_length=32)
    gradient_preset: Optional[str] = Field(default=None, max_length=48)
    image_data: Optional[str] = Field(
        default=None, description="data: URI (client-compressed, ~200KB cap)."
    )

    model_config = ConfigDict(extra="ignore")


class ThemeCardStyle(BaseModel):
    radius: Optional[Literal["none", "sm", "md", "lg", "xl"]] = None
    shadow: Optional[Literal["none", "sm", "md"]] = None
    border: Optional[bool] = None

    model_config = ConfigDict(extra="ignore")


class ThemeLogin(BaseModel):
    background: Optional[ThemeBackground] = None
    tagline: Optional[str] = Field(default=None, max_length=240)

    model_config = ConfigDict(extra="ignore")


class BrandingConfig(BaseModel):
    """Theme + branding for a workboard's public mini-app shell.

    Superset "design system" config (AppSheet-parity): colors, dark mode,
    background, font, card/header style, and a per-login override. Kept as
    ``extra="ignore"`` (not forbid) because it is purely cosmetic — a stray
    legacy key must never 422 an entire layout save.
    """

    app_name: Optional[str] = None
    logo_url: Optional[str] = None
    logo_data: Optional[str] = None
    logo_layout: Optional[Literal["mark", "wide"]] = None
    primary_color: Optional[str] = Field(default=None, max_length=32)
    accent_color: Optional[str] = Field(default=None, max_length=32)
    welcome_text: Optional[str] = None
    # Mode drives the CSS-variable theme + ``data-theme`` on the shell root.
    theme: Literal["light", "dark", "auto"] = "auto"
    background: Optional[ThemeBackground] = None
    font_family: Optional[
        Literal["system", "inter", "be-vietnam", "roboto", "serif", "mono"]
    ] = None
    card_style: Optional[ThemeCardStyle] = None
    header_style: Optional[Literal["fill", "line", "minimal"]] = None
    login: Optional[ThemeLogin] = None

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

class OcrConfig(BaseModel):
    """Per-form "chụp ảnh tự điền" (OCR) configuration.

    When ``enabled``, the runtime shows a photo-capture card; the backend
    sends the image to a vision model and returns values keyed by the form's
    columns. ``api_key`` is BYOK — the builder configures it, the backend
    ENCRYPTS it at rest inside ``layout_json`` and NEVER returns the raw key
    to the runtime (only ``enabled`` reaches the public app). On the builder
    GET it is masked (the runtime/public serializers strip it entirely).
    """

    enabled: bool = False
    provider: Literal["anthropic", "openai", "gemini"] = "anthropic"
    model: Optional[str] = Field(
        default=None, max_length=120,
        description="Vision model id (e.g. claude-3-5-sonnet-latest, gpt-4o, gemini-2.5-flash).",
    )
    api_key: Optional[str] = Field(
        default=None, max_length=600,
        description="BYOK token. Stored encrypted; blank on save = keep existing.",
    )
    hint: Optional[str] = Field(
        default=None, max_length=1000,
        description="Optional guidance for the model (e.g. layout of the paper form).",
    )
    # Response-only flag: builder GET sets True when a key is stored (so the UI
    # can show "đã lưu khoá") without exposing the secret. Popped on save.
    api_key_set: Optional[bool] = None
    # 'ignore' (not 'forbid') tolerates legacy/extra keys round-tripping.
    model_config = ConfigDict(extra="ignore")


class GeocodeConfig(BaseModel):
    """Auto-fill latitude/longitude from an address during Workboard writes.

    This belongs to the write workflow, not the map renderer. Any form/table
    screen can opt in by mapping its address and coordinate columns; the
    coordinates are then persisted business data (deterministic + reusable),
    not recomputed on every map paint.
    """

    enabled: bool = True
    provider: Literal["nominatim", "none"] = Field(
        default="nominatim",
        description="'nominatim' uses OpenStreetMap Nominatim; 'none' disables external calls.",
    )
    address_column: Optional[str] = Field(
        default=None,
        description="Column containing the address to geocode.",
    )
    address_template: Optional[str] = Field(
        default=None,
        max_length=1000,
        description="Optional '[Column]' template used instead of address_column, e.g. '[DiaChiGiao], Việt Nam'.",
    )
    lat_column: str = Field(..., min_length=1, description="Latitude target column.")
    lng_column: str = Field(..., min_length=1, description="Longitude target column.")
    status_column: Optional[str] = Field(
        default=None,
        description="Optional column stamped with geocoding status.",
    )
    provider_label_column: Optional[str] = Field(
        default=None,
        description="Optional column storing the provider's resolved display label.",
    )
    overwrite_existing: bool = Field(
        default=False,
        description="When false, existing lat/lng values are preserved.",
    )
    country_codes: Optional[str] = Field(default=None, description="Provider country filter, e.g. 'vn'.")
    language: Optional[str] = Field(default=None, description="Provider response language, e.g. 'vi'.")
    timeout_seconds: float = Field(default=5, ge=1, le=20)

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
    pages: List[FormPage] = Field(default_factory=list)
    sections: List[str] = Field(default_factory=list)
    ocr: Optional[OcrConfig] = None
    geo_stamp_column: Optional[str] = Field(
        default=None,
        description=(
            "When set, the FE captures the device GPS at submit and writes 'lat,lng' "
            "into this column (readonly, anti-fraud geo-audit of who was where)."
        ),
    )
    geocode: Optional[GeocodeConfig] = Field(
        default=None,
        description="Auto-fill latitude/longitude from an address column/template on submit.",
    )

    model_config = ConfigDict(extra="forbid")


class TableComputedColumn(BaseModel):
    """A read-only column whose value is evaluated server-side via the
    QuickJS sandbox (see ``services/js_evaluator.py``).

    Phase-15 (2026-05-16): the Sheets-style formula engine was removed —
    every computed column is now a JS function body. Target audience is
    data engineers, who write JS comfortably; surface area dropped from
    two engines to one.

    The body is wrapped as ``function(row, rows, index){ <body> }`` and
    the scope exposes:
      - ``row``     — current row dict (``row.<column_name>``)
      - ``rows``    — full page (array of row dicts) for cross-row work
      - ``index``   — zero-based row index in the page
      - ``$helpers`` — namespace with sum/avg/min/max/count/sumIf/countIf/
                       lookup/today/now/dayjs/format(...)

    The sandbox enforces a 1000ms wall-clock per row and a deny-list of
    escape hatches (``eval`` / ``Function`` / ``require`` / ``fetch`` /
    timers / ``globalThis``).
    """

    name: str = Field(..., min_length=1, max_length=120)
    label: Optional[str] = Field(default=None, max_length=200)
    formula: str = Field(
        default="",
        max_length=8000,
        description=(
            "JavaScript function body. Example: "
            "``return row.qty > 0 ? row.qty * row.price : 0``."
        ),
    )
    format: Optional[Literal[
        "text", "number", "integer", "currency", "percent", "date", "datetime"
    ]] = None

    # extra='ignore' (not 'forbid') so old layouts that still carry the
    # Phase-14 ``engine`` field round-trip without 422. The runtime will
    # treat them as JS regardless — formula support was removed.
    model_config = ConfigDict(extra="ignore")


class TableLookupColumn(BaseModel):
    """A read-only column populated by joining one cell value against
    another dataset table — a "VLOOKUP done relationally".

    Empty ``from_table_id`` / ``match_column_*`` / ``return_column`` mean
    the lookup is still being configured in the builder — the runtime
    skips evaluation for incomplete lookups instead of erroring, so
    autosave never rejects an in-progress edit.
    """

    name: str = Field(..., min_length=1, max_length=120)
    label: Optional[str] = Field(default=None, max_length=200)
    from_table_id: int = Field(default=0, ge=0)
    match_column_local: str = Field(default="", max_length=120)
    match_column_remote: str = Field(default="", max_length=120)
    return_column: str = Field(default="", max_length=120)
    format: Optional[Literal[
        "text", "number", "integer", "currency", "percent", "date", "datetime"
    ]] = None

    model_config = ConfigDict(extra="forbid")


class TableRollupColumn(BaseModel):
    """A read-only column that AGGREGATES child rows from a related table —
    a reverse-reference roll-up ("order total = SUM of its line-items",
    "records-per-plot = COUNT").

    The inverse of :class:`TableLookupColumn`: instead of pulling one value
    for a matching key, it gathers ALL child rows whose ``match_column_remote``
    equals this row's ``match_column_local`` and reduces them with ``agg``.
    Runtime fetches the child rows in one batched ``IN`` query (RLS of the
    child table is NOT applied — the parent rows are already scoped) and
    aggregates in Python, so no GROUP-BY transport is needed.

    Incomplete config (blank columns / from_table_id=0) is skipped at runtime.
    """

    name: str = Field(..., min_length=1, max_length=120)
    label: Optional[str] = Field(default=None, max_length=200)
    from_table_id: int = Field(default=0, ge=0)
    match_column_local: str = Field(default="", max_length=120)
    match_column_remote: str = Field(default="", max_length=120)
    agg: Literal["sum", "count", "avg", "min", "max"] = "count"
    value_column: str = Field(
        default="", max_length=120,
        description="Child column to aggregate. Ignored for agg=count.",
    )
    format: Optional[Literal[
        "text", "number", "integer", "currency", "percent", "date", "datetime"
    ]] = None

    model_config = ConfigDict(extra="forbid")


class FormatRule(BaseModel):
    """Conditional formatting: tint a row (or specific columns) when a
    row-local expression is truthy — AppSheet-style "format rules".

    ``when`` uses the shared wb-expr grammar over the row's values
    (including computed/lookup/rollup columns). Evaluated on the FE per row.
    First matching rule wins per cell. ``columns`` empty = whole row.
    """

    when: str = Field(..., min_length=1, max_length=1000)
    color: Literal["slate", "green", "amber", "red", "blue", "violet"] = "amber"
    columns: List[str] = Field(
        default_factory=list,
        description="Columns to tint; empty = the whole row.",
    )
    icon: Optional[str] = Field(default=None, max_length=40, description="Optional emoji/marker prefix.")
    label: Optional[str] = Field(default=None, max_length=80, description="Legend label for this rule.")

    model_config = ConfigDict(extra="forbid")


class TableColumnOption(BaseModel):
    """A static option for a select / enum_list inline cell."""

    label: str = Field(..., max_length=200)
    value: Any = None

    model_config = ConfigDict(extra="forbid")


class TableColumnMeta(BaseModel):
    """Per-column presentation metadata (label override, width, align,
    format hint, merge flag) plus — for editable columns — the typed inline
    editor (``input_type``) and its config. The runtime consumes label/format;
    width/align are FE-only hints; input_type drives the inline cell control.
    """

    label: Optional[str] = Field(default=None, max_length=200)
    width_px: Optional[int] = Field(default=None, ge=1, le=2000)
    format: Optional[Literal[
        "text", "number", "integer", "currency", "percent", "date", "datetime", "qr"
    ]] = None
    align: Optional[Literal["left", "center", "right"]] = None
    merge: Optional[bool] = None
    # ── Typed inline editor (editable columns only) ──────────────────────
    input_type: Optional[Literal[
        "text", "number", "currency", "percent", "date", "datetime", "time",
        "checkbox", "select", "enum_list", "rating", "color", "slider",
    ]] = Field(
        default=None,
        description="Control used to edit this cell inline. None = plain text.",
    )
    options: Optional[List[TableColumnOption]] = Field(
        default=None, description="Static options for input_type=select/enum_list.",
    )
    currency_code: Optional[str] = Field(default=None, max_length=8)
    max_stars: Optional[int] = Field(default=None, ge=1, le=10)
    min_value: Optional[float] = None
    max_value: Optional[float] = None
    step: Optional[float] = Field(default=None, gt=0)

    model_config = ConfigDict(extra="forbid")


class TableDetailPanel(BaseModel):
    """Side-panel that opens when an end user clicks a table row.

    The panel is **always present** on a table screen (it's the canonical
    way to view/edit fields that the grid doesn't surface). The builder
    only controls which columns are visible, the order, optional sections,
    and which subset can be edited from inside the panel.

    When ``enabled=False`` the runtime falls back to inline-only editing —
    clicking a row does nothing. Use this for ultra-wide tables where the
    grid itself is the whole UX and a side panel would be redundant.
    """

    enabled: bool = True
    title: Optional[str] = Field(
        default=None,
        max_length=120,
        description="Header shown at the top of the panel. Defaults to the screen title.",
    )
    columns: List[str] = Field(
        default_factory=list,
        description=(
            "Columns shown in the panel, in display order. Empty = mirror "
            "the table's ``columns`` list (so the panel shows every grid "
            "column). Add columns here that the grid hides for density."
        ),
    )
    editable_columns: List[str] = Field(
        default_factory=list,
        description=(
            "Subset of ``columns`` editable from the panel. Empty = the "
            "panel is read-only (user must use inline edit on the grid). "
            "Useful pattern: grid edits the 2-3 hot columns, panel edits "
            "everything else."
        ),
    )
    sections: Dict[str, List[str]] = Field(
        default_factory=dict,
        description=(
            "Optional grouping: {section_label: [column, ...]}. Columns "
            "listed here are rendered under the matching header; unlisted "
            "columns go in the default 'Other' section."
        ),
    )

    model_config = ConfigDict(extra="forbid")


class GalleryConfig(BaseModel):
    """Card/photo layout for a Table screen when ``display_mode='gallery'``.

    Same query, RLS, filters and detail-panel as the table grid — only the
    render changes: rows become image cards, optionally bucketed into
    sections by ``group_by_column`` (e.g. one section per capture date,
    header shows the value + count "16/05/2025 (3)").
    """

    image_column: str = Field(
        ..., min_length=1,
        description="Column holding a data:image base64 string, shown as the card image.",
    )
    title_column: Optional[str] = Field(default=None, description="Card title caption.")
    subtitle_column: Optional[str] = Field(default=None, description="Card subtitle caption.")
    group_by_column: Optional[str] = Field(
        default=None,
        description="Bucket cards into sections by this column's value (distinct from TableScreenSpec.group_by, which is cell-merge only).",
    )
    columns_per_row: int = Field(default=3, ge=1, le=6)

    model_config = ConfigDict(extra="forbid")


class CalendarConfig(BaseModel):
    """Month-calendar layout for a Table screen when ``display_mode='calendar'``.

    Same query / RLS / filters / detail-panel as the grid — rows are placed on
    a month grid by ``date_column``. Clicking a chip opens the detail panel.
    """

    date_column: str = Field(
        ..., min_length=1,
        description="Column holding the date each row is placed on (ISO date / datetime).",
    )
    title_column: Optional[str] = Field(
        default=None, description="Column shown as each day-chip's label (defaults to the PK).",
    )
    color_column: Optional[str] = Field(
        default=None,
        description="Optional column whose value tints the chip (e.g. a status column).",
    )

    model_config = ConfigDict(extra="forbid")


class RouteMapConfig(BaseModel):
    """Route/map layout for a Table screen when ``display_mode='route_map'``.

    Intentionally a table display mode, not a separate screen kind: the same
    rows, RLS, filters, row actions and detail panel are reused, while the
    renderer projects rows onto a map with an optional ordered route line. It
    covers delivery routes, technician visits, field-sales plans, asset
    inspections — any "ordered stops on a map" use case. The renderer stays
    generic and reads ONLY these column mappings.
    """

    lat_column: str = Field(..., min_length=1, description="Latitude column for each stop.")
    lng_column: str = Field(..., min_length=1, description="Longitude column for each stop.")
    title_column: Optional[str] = Field(
        default=None,
        description="Primary marker/list label. Defaults to the first primary key or first visible column.",
    )
    subtitle_columns: List[str] = Field(
        default_factory=list,
        description="Secondary values shown under each stop in the side panel.",
    )
    route_id_column: Optional[str] = Field(
        default=None,
        description="Groups rows into routes/trips. When omitted all visible rows are one route.",
    )
    route_filter_default: Optional[str] = Field(
        default=None,
        description="Optional route id selected by default when rows contain multiple routes.",
    )
    order_column: Optional[str] = Field(
        default=None,
        description="Column used to sort stops inside each route (delivery sequence).",
    )
    weight_column: Optional[str] = Field(default=None, description="Optional weight column for route totals.")
    value_column: Optional[str] = Field(default=None, description="Optional value/amount column for route totals.")
    deadline_column: Optional[str] = Field(default=None, description="Optional due/deadline column shown per stop.")
    vehicle_column: Optional[str] = Field(default=None, description="Optional vehicle/trip resource column.")
    status_column: Optional[str] = Field(default=None, description="Optional status column shown per stop.")
    basemap: Literal["satellite", "streets", "light"] = Field(
        default="streets",
        description="Basemap tile style for the route map.",
    )
    line_mode: Literal["straight", "road"] = Field(
        default="road",
        description="'straight' draws ordered coordinates; 'road' asks a route provider for road geometry.",
    )
    route_provider: Literal["osrm"] = Field(
        default="osrm",
        description="Provider used when line_mode='road'.",
    )
    route_profile: Literal["driving"] = Field(
        default="driving",
        description="Routing profile used by the provider.",
    )
    fallback_line_mode: Literal["straight"] = Field(
        default="straight",
        description="Fallback when road routing fails.",
    )
    show_side_panel: bool = Field(default=True, description="Show ordered stop list next to the map.")
    side_panel_title: Optional[str] = Field(default=None, max_length=80)

    model_config = ConfigDict(extra="forbid")


class StatTile(BaseModel):
    """One KPI tile shown above a Table screen.

    Aggregates a column across the loaded (RLS-filtered) rows so a worker sees
    e.g. "Σ Sản lượng hôm nay" without opening a whole dashboard. Computed on
    the same page cap as footer totals — cheap, no extra query.
    """

    label: str = Field(..., min_length=1, max_length=80)
    column: str = Field(..., min_length=1)
    agg: Literal["sum", "avg", "min", "max", "count"] = "sum"
    format: Optional[str] = Field(
        default=None,
        description="Optional cell format key (number|integer|currency|percent|...).",
    )
    unit: Optional[str] = Field(default=None, max_length=16, description="Suffix after the value.")

    model_config = ConfigDict(extra="forbid")


class PosCartHeaderInput(BaseModel):
    """One header field captured ONCE per POS submit and written onto EVERY
    line row (denormalised), e.g. Loại phiếu / Kho / Người giao/nhận."""

    column: str = Field(..., min_length=1, description="Header/line column key.")
    label: str = Field(..., min_length=1, max_length=80)
    kind: Literal["text", "select", "date"] = "text"
    options: List[str] = Field(
        default_factory=list, description="Choices when kind='select'."
    )
    default: Optional[str] = None
    required: bool = False
    write_to_line: bool = Field(
        default=True,
        description=(
            "True → the value is written onto every saved line. False → captured "
            "and carried to the receipt only (metadata that is not a line column, "
            "e.g. Người giao when lines live in a detail table)."
        ),
    )

    model_config = ConfigDict(extra="forbid")


class PosCartConfig(BaseModel):
    """Supermarket-style batch scan cart on a ``table`` screen.

    When present the runtime renders a point-of-sale interface instead of the
    editable grid: scan a barcode (phone camera) → the product is resolved from
    a catalog table and appended to an on-screen list with an editable quantity
    → press *Submit* to persist EVERY line at once through the screen's
    bulk-insert endpoint. Nothing touches the datasource until submit — exactly
    like a checkout scanner. A phiếu id is generated per submit and, optionally,
    the user is routed to a printable doc screen (the receipt).

    The read side attaches the resolved catalog rows as ``pos_catalog`` so the
    scanner resolves codes instantly client-side (no per-scan round trip).
    """

    barcode_column: str = Field(..., min_length=1, description="Line column that stores the scanned code.")
    quantity_column: str = Field(..., min_length=1, description="Line column for the quantity.")
    catalog_table_id: int = Field(..., description="Dataset table id of the product master.")
    catalog_match_column: str = Field(..., min_length=1, description="Catalog column matched against the scanned code.")
    catalog_label_column: Optional[str] = Field(default=None, description="Product-name column in the catalog.")
    catalog_price_column: Optional[str] = Field(default=None, description="Unit-price column in the catalog.")
    catalog_copy: Dict[str, str] = Field(
        default_factory=dict,
        description="line_column -> catalog_column values copied onto every appended line.",
    )
    amount_column: Optional[str] = Field(default=None, description="Line column set to quantity × unit price.")
    header_inputs: List[PosCartHeaderInput] = Field(default_factory=list)
    order_id_column: Optional[str] = Field(default=None, description="Line column for the generated phiếu id.")
    order_id_prefix: str = Field(default="PN", max_length=12)
    date_column: Optional[str] = Field(default=None, description="Line column auto-set to today's date.")
    header_screen_id: Optional[str] = Field(
        default=None,
        description=(
            "Screen id (bound to the phiếu HEADER table, usually hidden from nav) "
            "that receives ONE row per submit with the header values (phiếu id, "
            "loại, kho, người giao, ngày). Keeps the header table in sync so "
            "phiếu lists show POS-created phiếu. None = lines only."
        ),
    )
    submit_label: str = Field(default="Lưu phiếu", max_length=40)
    after_submit_screen: Optional[str] = Field(default=None, description="Doc screen opened after a successful save (the receipt).")
    after_submit_carry: List[str] = Field(
        default_factory=list,
        description="Header/line columns carried to after_submit_screen (e.g. the generated phiếu id).",
    )
    allow_manual_search: bool = Field(default=True, description="Show a searchable catalog picker beside the scanner.")
    catalog_group_column: Optional[str] = Field(default=None, description="Optional catalog column used to group the picker.")
    empty_hint: Optional[str] = Field(default=None, max_length=200)

    model_config = ConfigDict(extra="forbid")


class BulkPreviewAggregate(BaseModel):
    """A running total of the SELECTED rows, shown on the bulk-action bar before
    commit (Phase-1 "tự tính tổng"). Computed client-side over the loaded
    selection — no query — so a user sees e.g. "Tổng tiền: 57.800.000đ · 3 đơn"
    before pressing the gộp button.
    """

    column: str = Field(..., min_length=1, max_length=120)
    agg: Literal["sum", "avg", "min", "max", "count"] = "sum"
    label: str = Field(..., min_length=1, max_length=80)
    format: Optional[str] = Field(
        default=None, description="Cell format key: number|integer|currency|percent|…"
    )

    model_config = ConfigDict(extra="forbid")


class BulkResourceInput(BaseModel):
    """A related-table record the operator PICKS before running a bulk action.

    Its columns can be written onto the new parent (``feeds``) and one numeric
    column can act as a capacity limit for a constraint (``capacity_column``).
    Example: pick a Vehicle → write its plate onto the trip + use its max-load
    as the "tổng khối lượng ≤ tải trọng" limit.
    """

    id: str = Field(..., min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=80)
    source_screen_id: str = Field(
        ..., min_length=1, max_length=64,
        description="A table screen (usually hidden from nav) whose rows populate the picker — RLS-scoped read.",
    )
    value_column: str = Field(..., min_length=1, max_length=120, description="Column used as the option value.")
    label_column: Optional[str] = Field(default=None, description="Column shown in the picker (defaults to value_column).")
    required: bool = True
    capacity_column: Optional[str] = Field(
        default=None, description="Numeric column exposing a limit a constraint can reference."
    )

    model_config = ConfigDict(extra="forbid")


class BulkConstraint(BaseModel):
    """A numeric guard over the SELECTION before commit: ``agg(column) op limit``.

    ``limit`` is a fixed number, OR ``limit_from_resource`` names a
    ``resource_inputs`` id whose ``capacity_column`` supplies the limit at
    runtime (e.g. tổng khối lượng ≤ tải trọng của xe đã chọn). Evaluated on the
    FE (badge + block) and re-checked by the server executor.
    """

    agg_column: str = Field(..., min_length=1, max_length=120)
    agg: Literal["sum", "count", "avg", "min", "max"] = "sum"
    op: Literal["<=", "<", ">=", ">"] = "<="
    limit: Optional[float] = None
    limit_from_resource: Optional[str] = Field(default=None, max_length=64)
    label: Optional[str] = Field(default=None, max_length=80)
    error_message: Optional[str] = Field(default=None, max_length=200)

    model_config = ConfigDict(extra="forbid")


class BulkStep(BaseModel):
    """One step of a SERVER-executed bulk recipe. Steps run in order; on a
    failure the executor compensates (deletes the rows created by earlier
    steps) so a partial "gộp" never lingers.

    Kinds:
      * ``create_record`` — insert ONE row into ``screen_id`` (the parent/header,
        or a chained downstream record). May generate a code (``code_column`` +
        ``code_prefix``), aggregate the selection (``aggregate_from_selected``),
        pull a picked resource (``from_resource``) and link a prior step's code
        (``link_columns``).
      * ``create_lines_from_selected`` — insert ONE row per selected row into
        ``screen_id`` (the detail lines). ``copy`` maps line→selected columns,
        ``link_columns`` writes a parent step's code, ``assign_sequence`` sorts
        the selection and numbers it into a column (thứ tự giao).
      * ``update_selected`` — update EVERY selected row on THIS screen's table
        (e.g. mark the source đề xuất as "Đã gộp"); ``link_columns`` can write a
        created parent's code back onto the sources.
    """

    id: str = Field(..., min_length=1, max_length=64, description="Step id (referenced by link_columns).")
    kind: Literal["create_record", "create_lines_from_selected", "update_selected"]
    screen_id: Optional[str] = Field(
        default=None, description="Screen the step writes to. Omit for update_selected (uses the action's screen)."
    )
    code_column: Optional[str] = Field(default=None, max_length=120, description="create_record: column to receive the generated code.")
    code_prefix: Optional[str] = Field(default=None, max_length=12)
    defaults: Dict[str, Any] = Field(default_factory=dict, description="Static values (support {{today}}/{{app_user.x}}).")
    aggregate_from_selected: Dict[str, Dict[str, str]] = Field(
        default_factory=dict,
        description="create_record: {target_col: {column, agg}} — aggregate the selection into the new row.",
    )
    copy_from_selected: Dict[str, str] = Field(
        default_factory=dict,
        description=(
            "create_record: {target_col: selected_source_col} — copy a shared "
            "value from the selected rows into the new parent. Pair with "
            "BulkAction.require_same for keys such as supplier/customer."
        ),
    )
    from_resource: Dict[str, str] = Field(
        default_factory=dict,
        description="{target_col: 'resource_id.resource_col'} — write a picked resource's field.",
    )
    copy: Dict[str, str] = Field(
        default_factory=dict,
        description="create_lines_from_selected: {line_col: selected_source_col} copied from each selected row.",
    )
    set: Dict[str, Any] = Field(default_factory=dict, description="Static values set on the written row(s).")
    link_columns: Dict[str, str] = Field(
        default_factory=dict,
        description="{col: '<step_id>'} — write the code produced by an earlier create_record step.",
    )
    assign_sequence: Optional[Dict[str, str]] = Field(
        default=None,
        description="create_lines_from_selected: {order_by, into_col} — sort the selection then number 1..N.",
    )

    model_config = ConfigDict(extra="forbid")


class BulkAction(BaseModel):
    """A "select many rows → combine into one parent" action on a table screen.

    When a table screen declares ``bulk_actions`` the runtime renders a
    checkbox column + a sticky action bar ("Đã chọn N — [actions]"). Clicking an
    action GROUPS the selected child rows under one newly-created parent:

    1. The runtime creates ONE parent row via ``parent_screen_id`` — a
       client-generated code (``code_prefix`` + date/time) is written to the
       parent's ``parent_code_column`` along with ``parent_defaults``.
    2. Every selected child row is then updated: ``set_column`` = that code
       (plus any ``also_set`` columns), through the normal per-row update path
       so RLS/writable-column rules still apply.

    This is exactly "gom nhiều đơn thành 1 hóa đơn" / "gom nhiều hóa đơn vào 1
    chuyến giao" — no bespoke bulk-write endpoint, just orchestration over the
    existing insert + update paths.
    """

    id: str = Field(..., min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=120)
    icon: Optional[str] = None
    style: Literal["primary", "secondary", "ghost", "danger"] = "primary"
    set_column: str = Field(
        default="", max_length=120,
        description="SIMPLE mode (no steps): child column set to the new parent's code on every selected row (the FK link).",
    )
    also_set: Dict[str, Any] = Field(
        default_factory=dict,
        description="SIMPLE mode: extra child columns set on every selected row (e.g. {'trang_thai': 'Đã gom vào hóa đơn'}).",
    )
    parent_screen_id: str = Field(
        default="", max_length=64,
        description="SIMPLE mode: screen id (bound to the parent table) used to create the ONE parent row.",
    )
    parent_code_column: str = Field(
        default="", max_length=120,
        description="SIMPLE mode: parent column that receives the generated code (e.g. ma_hoa_don / ma_chuyen).",
    )
    code_prefix: str = Field(default="HD", max_length=12, description="Prefix of the generated code (e.g. HD / CH).")
    parent_defaults: Dict[str, Any] = Field(
        default_factory=dict,
        description="Other values for the new parent row (e.g. {'trang_thai': 'Nháp'}). Supports {{today}}/{{app_user.x}}.",
    )
    confirm_message: Optional[str] = Field(default=None, max_length=200)
    min_selection: int = Field(default=1, ge=1, le=200)
    success_message: Optional[str] = Field(default=None, max_length=200)
    visible_for_roles: List[str] = Field(default_factory=list)
    # ── Phase-1 precondition guard + running totals (FE-evaluated) ──────────
    require_same: List[str] = Field(
        default_factory=list,
        description=(
            "Precondition: every selected row must share the SAME value in each of "
            "these columns or the action is blocked with a reason (e.g. ['ma_kh'] = "
            "chỉ gộp các đơn CÙNG khách hàng / ['nha_cung_cap'] = cùng nhà cung cấp)."
        ),
    )
    preview_aggregates: List[BulkPreviewAggregate] = Field(
        default_factory=list,
        description="Running totals of the selected rows shown on the action bar before commit (tự tính tổng).",
    )
    route_preview: Optional[RouteMapConfig] = Field(
        default=None,
        description=(
            "Optional map preview of the SELECTED rows inside the action modal "
            "(same config shape as a route_map screen: lat/lng/order/title…). "
            "Lets the operator see the delivery route + ordered stops right where "
            "they pick the rows, alongside the capacity/weight badge."
        ),
    )
    # ── Phase-2 advanced: server-executed multi-step recipe + guards + pickers ──
    resource_inputs: List[BulkResourceInput] = Field(
        default_factory=list,
        description="Related records the operator picks before running (e.g. Xe/Kho); feed the parent + supply constraint limits.",
    )
    constraints: List[BulkConstraint] = Field(
        default_factory=list,
        description="Numeric guards over the selection (e.g. tổng khối lượng ≤ tải trọng xe). Shown as a live badge + block.",
    )
    steps: List[BulkStep] = Field(
        default_factory=list,
        description=(
            "SERVER-executed recipe. When non-empty the runtime opens a modal (pick "
            "resources → live totals/badge → confirm) and the server runs the steps in "
            "order with compensation-rollback — instead of the simple client path. Empty "
            "= simple mode (uses set_column/parent_screen_id/parent_code_column)."
        ),
    )

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _check_bulk_mode(self) -> "BulkAction":
        if not self.steps:
            missing = [
                name for name, val in (
                    ("set_column", self.set_column),
                    ("parent_screen_id", self.parent_screen_id),
                    ("parent_code_column", self.parent_code_column),
                )
                if not str(val or "").strip()
            ]
            if missing:
                raise ValueError(
                    f"bulk_action '{self.id}': simple mode (no steps) requires {missing}."
                )
        # A constraint that references a resource must name an existing input.
        res_ids = {r.id for r in self.resource_inputs}
        for c in self.constraints:
            if c.limit_from_resource and c.limit_from_resource not in res_ids:
                raise ValueError(
                    f"bulk_action '{self.id}': constraint.limit_from_resource "
                    f"'{c.limit_from_resource}' has no matching resource_inputs id."
                )
            if c.limit is None and not c.limit_from_resource:
                raise ValueError(
                    f"bulk_action '{self.id}': constraint on '{c.agg_column}' needs limit or limit_from_resource."
                )
        return self


class TableScreenSpec(BaseModel):
    """A spreadsheet-style screen bound to one dataset table.

    One screen kind for both viewing and editing data. There is **no**
    read-only / editable mode flag — instead, ``editable_columns`` is the
    single source of truth for which cells accept inline input:

    * Empty ``editable_columns`` → table is read-only (cells display text
      with a small lock icon on hover). End users still get every other
      feature: filters, sort, pagination, computed/lookup columns, totals,
      row actions, the detail panel.
    * Non-empty ``editable_columns`` → listed cells become inline-editable;
      everything else stays read-only with the lock icon. Add-row /
      delete-row buttons appear only when at least one column is editable.

    The detail side panel (``detail_panel``) opens when a row is clicked
    and shows the full record (including columns hidden from the grid for
    density). This replaces the old "click row → navigate to form screen"
    pattern with an in-place side panel — no tab switching, no separate
    screen to author and maintain.

    Three forms of derived data are supported:

    * ``computed_columns`` — per-row formula columns (Sheets-style).
    * ``lookup_columns``   — pull values from a related dataset table.
    * ``totals``           — footer aggregations (sum / avg / min / max / count).

    Multi-header (``column_groups``) and row-merge (``group_by``) come from
    the old DocScreen data-table block — reused here so users coming from
    Google Sheets can replicate "merge cells" / "merged header" layouts.
    """

    columns: List[str] = Field(default_factory=list)
    """Columns surfaced on the table, in display order. May include the
    names of computed/lookup columns — they're rendered in the same row
    as regular columns but marked read-only."""

    editable_columns: List[str] = Field(default_factory=list)
    """Single source of truth for inline editability. Subset of ``columns``
    that the end user may edit at the cell. Must NOT include the name of
    any computed/lookup column. Empty list = entire table is read-only
    inline (row click still opens the detail panel)."""

    filters: List[ListFilter] = Field(default_factory=list)
    context_filters: List[DataTableContextFilter] = Field(
        default_factory=list,
        description=(
            "Filter table rows by runtime shared-context values carried from "
            "row actions/forms. Example: detail table MaDonGop = {{shared.MaDonGop}}."
        ),
    )

    page_size: int = Field(default=50, ge=10, le=500)
    default_sort_column: Optional[str] = None
    default_sort_direction: Literal["asc", "desc"] = "desc"

    row_actions: List[ScreenAction] = Field(default_factory=list)
    """Per-row action buttons that navigate to another screen and carry
    column values across. Independent of inline edit / detail panel."""

    allow_add_row: bool = False
    """Show the 'Add row' button. Requires at least one entry in
    ``editable_columns`` — the dry-run validator rejects otherwise."""
    allow_delete_row: bool = False
    """Show the per-row delete button. Independent of ``allow_add_row``."""

    required_columns: List[str] = Field(default_factory=list)
    default_values: Dict[str, Any] = Field(default_factory=dict)

    computed_columns: List[TableComputedColumn] = Field(default_factory=list)
    lookup_columns: List[TableLookupColumn] = Field(default_factory=list)
    rollup_columns: List[TableRollupColumn] = Field(default_factory=list)
    totals: Dict[str, Literal["sum", "avg", "min", "max", "count"]] = Field(
        default_factory=dict,
    )

    column_groups: List[DataTableColumnGroup] = Field(
        default_factory=list,
        description=(
            "Multi-level header: one grouped header label spans several "
            "contiguous columns. Reused from DocScreen DataTableBlock."
        ),
    )
    group_by: List[str] = Field(
        default_factory=list,
        description=(
            "When rows share a value in a group_by column, the cell on the "
            "first row spans the rest (Google-Sheets merge). A column "
            "listed here must NOT appear in ``editable_columns`` — merge "
            "+ inline edit conflict."
        ),
    )
    column_metadata: Dict[str, TableColumnMeta] = Field(default_factory=dict)

    detail_panel: TableDetailPanel = Field(default_factory=TableDetailPanel)
    """Side panel opened on row click. Always present unless explicitly
    disabled via ``detail_panel.enabled=False``."""

    empty_state_message: Optional[str] = None

    display_mode: Literal["table", "gallery", "calendar", "route_map"] = Field(
        default="table",
        description=(
            "'table' = grid (default). 'gallery' = image cards (gallery_config). "
            "'calendar' = month view (calendar_config). 'route_map' = ordered stops on a map (route_map_config)."
        ),
    )
    gallery_config: Optional[GalleryConfig] = Field(
        default=None,
        description="Card layout config; required (and its image_column must be in `columns`) when display_mode='gallery'.",
    )
    calendar_config: Optional[CalendarConfig] = Field(
        default=None,
        description="Month-view config; required (and its date_column must be in `columns`) when display_mode='calendar'.",
    )
    route_map_config: Optional[RouteMapConfig] = Field(
        default=None,
        description="Route-map config; required when display_mode='route_map'.",
    )
    stat_tiles: List[StatTile] = Field(
        default_factory=list,
        description="KPI tiles shown above the table/gallery (aggregate a column across the loaded rows).",
    )
    format_rules: List[FormatRule] = Field(
        default_factory=list,
        description="Conditional formatting: tint rows/cells when a row-local expression is truthy.",
    )
    pos_cart: Optional[PosCartConfig] = Field(
        default=None,
        description=(
            "Turns this table screen into a supermarket-style batch scan cart: "
            "scan → on-screen line list → one Submit persists all lines via "
            "bulk-insert. The read side attaches the resolved product catalog as "
            "``pos_catalog``. None = ordinary editable/read-only grid."
        ),
    )
    geocode: Optional[GeocodeConfig] = Field(
        default=None,
        description="Auto-fill latitude/longitude from an address column/template on insert/update.",
    )
    bulk_actions: List[BulkAction] = Field(
        default_factory=list,
        description=(
            "Select-many → combine-into-one actions. When non-empty the runtime "
            "renders a per-row checkbox + a sticky action bar; each action creates "
            "one parent row and links the selected rows to it (gom đơn → hóa đơn, "
            "gom hóa đơn → chuyến giao)."
        ),
    )

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _check_name_collisions(self) -> "TableScreenSpec":
        """Ensure derived column names don't collide with each other or
        with declared DB columns.

        Collision rules (strict — extra='forbid' won't catch these):
        * Two computed columns with same name → ambiguous in formula/JS scope.
        * Two lookup columns with same name → grid would render duplicate keys.
        * A computed column and a lookup column with the same name → unclear
          which one wins.
        * A derived column (computed or lookup) shadowing a declared DB
          column from ``columns`` is REJECTED — the user almost certainly
          made a typo and would lose access to the original column.

        Empty / draft entries (blank name) are skipped — autosave creates
        shells before the user types a name.
        """
        computed_names: list[str] = []
        for col in self.computed_columns or []:
            name = (col.name or "").strip()
            if not name:
                continue
            if name in computed_names:
                raise ValueError(
                    f"Computed column name '{name}' is used more than once. "
                    f"Each computed column must have a unique name."
                )
            computed_names.append(name)

        lookup_names: list[str] = []
        for col in self.lookup_columns or []:
            name = (col.name or "").strip()
            if not name:
                continue
            if name in lookup_names:
                raise ValueError(
                    f"Lookup column name '{name}' is used more than once. "
                    f"Each lookup column must have a unique name."
                )
            if name in computed_names:
                raise ValueError(
                    f"Lookup column '{name}' collides with a computed column "
                    f"of the same name. Rename one."
                )
            lookup_names.append(name)

        rollup_names: list[str] = []
        for col in self.rollup_columns or []:
            name = (col.name or "").strip()
            if not name:
                continue
            if name in rollup_names:
                raise ValueError(
                    f"Roll-up column name '{name}' is used more than once."
                )
            if name in computed_names or name in lookup_names:
                raise ValueError(
                    f"Roll-up column '{name}' collides with a computed/lookup "
                    f"column of the same name. Rename one."
                )
            rollup_names.append(name)

        # Visible DB columns = anything in ``columns`` that ISN'T a derived
        # name. Derived names ARE expected to appear in ``columns`` (the
        # user includes them in display order) — that's fine.
        derived = set(computed_names) | set(lookup_names) | set(rollup_names)
        # `columns` may include both DB cols and derived names; we only
        # detect a shadow when the SAME name appears more than once in
        # ``columns`` itself.
        seen: set[str] = set()
        for raw in self.columns or []:
            name = (raw or "").strip()
            if not name:
                continue
            if name in seen:
                raise ValueError(
                    f"Column '{name}' appears more than once in 'columns'. "
                    f"Remove the duplicate."
                )
            seen.add(name)

        # ``group_by`` cells must not be inline-editable (merge + edit
        # conflict at runtime).
        editable_set = set(self.editable_columns or [])
        for col in self.group_by or []:
            if col in editable_set:
                raise ValueError(
                    f"Column '{col}' is in 'group_by' AND 'editable_columns'. "
                    f"Merge + inline edit conflict — pick one."
                )

        # Gallery display mode requires a config whose image_column is a real,
        # surfaced column — otherwise the runtime would not return the image
        # value in the row payload and every card would be blank.
        if self.display_mode == "gallery":
            if self.gallery_config is None:
                raise ValueError(
                    "display_mode='gallery' requires gallery_config."
                )
            gc = self.gallery_config
            visible = set(self.columns or [])
            for label, col in (
                ("image_column", gc.image_column),
                ("title_column", gc.title_column),
                ("subtitle_column", gc.subtitle_column),
                ("group_by_column", gc.group_by_column),
            ):
                if col and col not in visible:
                    raise ValueError(
                        f"gallery_config.{label} '{col}' must be listed in "
                        f"'columns' so the runtime returns its value."
                    )

        # Calendar display mode: date_column drives placement, so it (and any
        # title/color column) must be surfaced in `columns` to reach the FE.
        if self.display_mode == "calendar":
            if self.calendar_config is None:
                raise ValueError(
                    "display_mode='calendar' requires calendar_config."
                )
            cc = self.calendar_config
            visible = set(self.columns or [])
            for label, col in (
                ("date_column", cc.date_column),
                ("title_column", cc.title_column),
                ("color_column", cc.color_column),
            ):
                if col and col not in visible:
                    raise ValueError(
                        f"calendar_config.{label} '{col}' must be listed in "
                        f"'columns' so the runtime returns its value."
                    )

        # Route-map display mode: coordinate columns are required and every
        # configured display/group/order column must be surfaced in the row
        # payload. The renderer stays generic and reads only these mappings.
        if self.display_mode == "route_map":
            if self.route_map_config is None:
                raise ValueError(
                    "display_mode='route_map' requires route_map_config."
                )
            mc = self.route_map_config
            visible = set(self.columns or [])
            route_cols = [
                ("lat_column", mc.lat_column),
                ("lng_column", mc.lng_column),
                ("title_column", mc.title_column),
                ("route_id_column", mc.route_id_column),
                ("order_column", mc.order_column),
                ("weight_column", mc.weight_column),
                ("value_column", mc.value_column),
                ("deadline_column", mc.deadline_column),
                ("vehicle_column", mc.vehicle_column),
                ("status_column", mc.status_column),
            ]
            route_cols.extend(
                (f"subtitle_columns[{i}]", col)
                for i, col in enumerate(mc.subtitle_columns or [])
            )
            for label, col in route_cols:
                if col and col not in visible:
                    raise ValueError(
                        f"route_map_config.{label} '{col}' must be listed in "
                        f"'columns' so the runtime returns its value."
                    )

        return self


class DocScreenSpec(BaseModel):
    """A document-view screen (printable A4 layout: header, kv_grid, data_table, signature)."""

    page: DocPage = Field(default_factory=DocPage)
    blocks: List[DocBlock] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class DashboardRoleFilterMapping(BaseModel):
    """Map one dashboard filter slot to ``app_user.role``.

    The workboard provisions managed public links per distinct app_user role.
    Each managed link's ``filters_config`` substitutes the role value into
    this slot's ``value``: ``{datasetId, semanticField, operator, value: <role>}``.

    The dashboard runtime treats this exactly like any other filter on a
    public link — no special-casing, no override semantics — which keeps the
    dashboard module's own filter pipeline (incl. ACR) untouched.
    """

    datasetId: int
    semanticField: str = Field(..., min_length=1, max_length=256)
    operator: str = Field(default="eq", max_length=32)

    model_config = ConfigDict(extra="forbid")


class DashboardStaticFilter(BaseModel):
    """A pinned filter that applies to every managed public link of the screen.

    Distinct from ``role_filter_mapping``: this one carries an explicit
    ``value`` (text, number, or list) — it doesn't depend on the viewing
    app_user. Every managed link gets these filters merged in; if the viewer
    sends a request that targets the same ``(datasetId, semanticField)`` slot
    the existing dashboard runtime's dedupe rules apply (legacy behaviour
    unchanged — no special hard-lock).
    """

    datasetId: int
    semanticField: str = Field(..., min_length=1, max_length=256)
    operator: str = Field(default="eq", max_length=32)
    value: Any
    type: Optional[str] = Field(default=None, max_length=32)

    model_config = ConfigDict(extra="forbid")


class DashboardScreenSpec(BaseModel):
    """A screen that embeds an existing AppBI Dashboard.

    Two binding modes:

    1. **Managed** (recommended) — set ``dashboard_id`` + optionally
       ``role_filter_mapping``. The workboard owner picks a dashboard they can
       view; the backend provisions one ``DashboardPublicLink``
       (``source='workboard'``) per distinct app_user role on the workboard.
       For each mapping the link's ``filters_config`` substitutes ``value`` =
       the role string. Link tokens are surfaced through ``managed_links``;
       the runtime picks the token matching the logged-in app_user's role.

    2. **Manual** — paste an existing ``share_token``. No auto-provisioning,
       no per-role filtering.

    Mini-app users cannot authenticate against the AppBI platform so the
    iframe always points at ``/embed/{token}``.
    """

    # — Managed mode —
    dashboard_id: Optional[int] = Field(
        default=None,
        description="When set, workboard manages public links for this dashboard automatically.",
    )
    role_filter_mapping: List[DashboardRoleFilterMapping] = Field(
        default_factory=list,
        description=(
            "Filter slots whose value is filled with the viewing app_user's role. "
            "Empty = every role gets the same link (no per-role filtering)."
        ),
    )
    static_filters: List[DashboardStaticFilter] = Field(
        default_factory=list,
        description=(
            "Filters with hard-coded values that apply to every managed link "
            "of this screen regardless of the viewer's role."
        ),
    )
    # role -> share_token. Server-owned; written by the app_user sync hook
    # whenever the set of distinct roles, the mapping, or static_filters change.
    managed_links: Dict[str, str] = Field(default_factory=dict)

    # — Manual mode —
    share_token: Optional[str] = Field(default=None, min_length=1, max_length=128)

    # — Shared options —
    password: Optional[str] = Field(default=None, max_length=128)
    height_px: Optional[int] = Field(
        default=None, ge=200, le=4000,
        description="Optional fixed iframe height. When omitted the runtime expands as the embed reports its own height.",
    )

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
    kind: Literal["form", "table", "doc", "dashboard"] = "form"
    title: str = Field(..., min_length=1, max_length=120)
    icon: Optional[str] = None
    description: Optional[str] = None
    table_id: Optional[int] = None
    primary_key_columns: List[str] = Field(default_factory=list)
    visible_for_roles: List[str] = Field(default_factory=list)
    show_in_nav: bool = True

    form: Optional[FormScreenSpec] = None
    table: Optional[TableScreenSpec] = None
    doc: Optional[DocScreenSpec] = None
    dashboard: Optional[DashboardScreenSpec] = None

    # Central column label map: {db_column_name: display_label}.
    # Used by table/doc screens to show friendly column headers instead of raw
    # column names. Example: {"nh_b50_025": "PLNC Bao 50 kg; Cỡ hạt ≤ 0,25mm"}
    column_labels: Dict[str, str] = Field(default_factory=dict)

    rls: List[ScreenRlsRule] = Field(default_factory=list)
    rls_default: Optional[ScreenRlsRule] = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _heal_pre_phase13_kinds(cls, data: Any) -> Any:
        """Backward-compat shim for pre-Phase-13 (2026-05-16) screens.

        Before Phase-13 the screen kinds ``grid`` (editable) and ``list``
        (read-only) were distinct, each with a same-named config block. They
        were collapsed into a single ``table`` kind (editability now driven by
        ``editable_columns``) and — per this module's docstring — shipped
        *without* a compat shim. Workboards authored before that date still
        carry ``kind='grid'/'list'`` plus a ``grid``/``list`` block in their
        stored ``layout_json``; the strict response model (``extra='forbid'``
        + the ``kind`` literal) then raises ``ResponseValidationError`` and
        500s the whole list/detail/runtime. This normalizes the legacy shape
        on read.

        ``grid`` (editable) and ``list`` (read-only) both map to ``table`` —
        the legacy block's fields are a subset of :class:`TableScreenSpec`
        (we keep only the recognised ones so a stray legacy sub-field can't
        re-trip ``forbid``). Post-Phase-13 payloads have no ``grid``/``list``
        keys, so this returns untouched for them (a no-op on the hot path).

        Legacy data self-heals: opening such a workboard now deserializes as
        ``kind='table'``, so the next save writes the clean shape back.
        """
        if not isinstance(data, dict):
            return data
        if (
            data.get("kind") not in ("grid", "list")
            and "grid" not in data
            and "list" not in data
        ):
            return data
        out = dict(data)
        if out.get("kind") in ("grid", "list"):
            out["kind"] = "table"
        table_fields = set(TableScreenSpec.model_fields)
        for legacy_key in ("grid", "list"):
            legacy_cfg = out.pop(legacy_key, None)
            if isinstance(legacy_cfg, dict) and not out.get("table"):
                out["table"] = {
                    k: v for k, v in legacy_cfg.items() if k in table_fields
                }
        return out


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


class AutoNumberConfig(BaseModel):
    """Server-generated identifier for a column.

    Whenever an insert reaches this workboard with ``column`` missing or
    blank, the write service replaces it with a value rendered from
    ``pattern``. Two placeholders are supported inside the pattern:

    * ``{N}`` / ``{N:4}`` — running sequence number, optionally
      zero-padded to ``:N`` digits. Each AutoNumberConfig owns its own
      counter in :class:`WorkboardAutoNumberSequence`.
    * ``{YYYY}`` / ``{YY}`` / ``{MM}`` / ``{DD}`` — date parts of the
      moment the insert lands.

    ``reset`` controls when the running sequence rolls back to 1. ``never``
    is the safest default — the sequence keeps growing forever.
    """

    column: str = Field(..., min_length=1, max_length=120)
    pattern: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="e.g. 'PO-{YYYY}{MM}{DD}-{N:4}'",
    )
    reset: Literal["never", "daily", "monthly", "yearly"] = "never"
    padding: int = Field(default=0, ge=0, le=12)
    """When >0 and the pattern has no ``{N:<digits>}`` directive, the
    sequence number gets zero-padded to this many digits."""
    start_at: int = Field(default=1, ge=0)
    """First sequence number issued. Bumped by the runtime on each insert."""

    model_config = ConfigDict(extra="forbid")


class ScreenGroup(BaseModel):
    """A named group of screens inside a workboard — surfaced to builders as
    a "Workspace".

    Purely a navigation/display construct: screens are NOT moved or
    duplicated, the group just references ``screen_ids`` (in display order).
    When a workboard defines no groups, the runtime nav stays flat exactly as
    before (today's behaviour), so the field is fully backward-compatible.

    ``visible_for_roles`` hides the group HEADER from the nav for non-matching
    roles (empty = everyone). NOTE: this is a NAV-DISPLAY filter only — it is
    NOT an access-control gate. Per-screen ``Screen.visible_for_roles`` / RLS
    remains the authoritative access check (the screen-content endpoint enforces
    that, not group membership).

    RESERVED / NOT EXPOSED IN THE BUILDER (as of the Workspaces v1): the builder
    never sets this field, so it is always empty and the runtime filter is inert
    — a group's visibility is derived purely from its members (the runtime drops
    a group whose member screens are all role-hidden). The field + the
    ``is_group_visible_for`` filter are kept for forward-compat. Be aware of the
    semantics before wiring a UI for it: hiding a group for a role does NOT hide
    its still-visible member screens — they relocate ungrouped into the runtime
    "Khác" bucket. If "hide group => also drop its members from that role's nav"
    is the desired behaviour, ``render_app_shell`` must additionally exclude
    those member ids from ``nav_items`` — decide + add a test when exposing it.
    """

    id: str = Field(..., min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=120)
    icon: Optional[str] = None
    screen_ids: List[str] = Field(default_factory=_builtins.list)
    visible_for_roles: List[str] = Field(default_factory=_builtins.list)

    model_config = ConfigDict(extra="forbid")


class PrintTemplate(BaseModel):
    """Reusable letterhead applied to EVERY doc screen's print + Excel export.

    Set up once in App Settings; the runtime auto-renders it as a header band
    atop each document (logo + company + address) and the Excel exporter
    prepends the same details as styled header rows. This is the "mẫu in được
    setup trước" — one config, consistent phiếu / báo cáo output.
    """

    enabled: bool = True
    company_name: Optional[str] = Field(default=None, max_length=200)
    address: Optional[str] = Field(default=None, max_length=300)
    tax_code: Optional[str] = Field(default=None, max_length=60)
    hotline: Optional[str] = Field(default=None, max_length=80)
    email: Optional[str] = Field(default=None, max_length=120)
    website: Optional[str] = Field(default=None, max_length=120)
    logo_data: Optional[str] = Field(default=None, description="Logo as a data: URI (CSP-safe; external URLs blocked).")
    footer_note: Optional[str] = Field(default=None, max_length=300)
    accent_color: Optional[str] = Field(default=None, description="Hex for the letterhead accent rule.")

    model_config = ConfigDict(extra="ignore")


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
    auto_number_columns: List[AutoNumberConfig] = Field(default_factory=_builtins.list)
    # Named groups of screens (UI: "Workspace"). Empty = flat nav (today's
    # behaviour). Additive + backward-compatible; see ScreenGroup.
    screen_groups: List[ScreenGroup] = Field(default_factory=_builtins.list)
    # Reusable print letterhead for doc screens (print + Excel export).
    print_template: Optional[PrintTemplate] = None

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
    settings: Optional[Dict[str, Any]] = None
    # Optimistic concurrency for DRAFT saves: when provided, the update is
    # rejected 409 if the stored version differs (a concurrent tab/session
    # already advanced it) so a stale autosave can't clobber a newer edit.
    expected_version: Optional[int] = Field(default=None, ge=1)
    # NOTE: ``is_published`` is intentionally NOT accepted here. Going Live and
    # taking down MUST go through the dedicated POST /{id}/publish and
    # /{id}/unpublish endpoints so the readiness audit + atomic promotion can
    # never be bypassed by a generic PATCH.


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
    # Draft/Published lifecycle. ``version`` is the DRAFT counter; the builder
    # edits ``layout_json``. ``published_version`` is the draft version captured
    # at the last publish; ``published_at`` when it happened. The live runtime
    # serves the published snapshot only (not exposed here — builder reads draft).
    published_version: Optional[int] = None
    published_at: Optional[datetime] = None
    settings: Optional[Dict[str, Any]] = None
    owner_id: Optional[UUID] = None
    owner_email: Optional[str] = None
    user_permission: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def publish_status(self) -> str:
        """One of ``draft`` | ``live`` | ``live_unpublished_changes`` — the
        single source of truth the builder chrome renders for its status pill."""
        if not self.is_published or self.published_version is None:
            return "draft"
        if (self.version or 1) > (self.published_version or 0):
            return "live_unpublished_changes"
        return "live"

    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Row-level write payloads
# ---------------------------------------------------------------------------

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

    ``context`` also carries mini-app hierarchy fields:
    ``manager_username`` for direct reports, ``scope_admin_usernames`` for
    admin branches, and ``scope_usernames`` for explicit usernames.
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


# ---------------------------------------------------------------------------
# Runtime (table list) responses
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Webhook integrations
# ---------------------------------------------------------------------------

class WorkboardWebhookHeader(BaseModel):
    """One static header sent with every webhook POST."""

    key: str = Field(..., min_length=1, max_length=120)
    value: str = Field(..., max_length=2048)

    model_config = ConfigDict(extra="forbid")


class WorkboardWebhookConfig(BaseModel):
    """A reusable outbound webhook configuration.

    Stored as part of ``workboard.settings.webhooks`` so it travels with
    the workboard on import/export. URL validation is intentionally
    permissive (any http/https URL is accepted) — the integration layer
    on the receiving side handles auth and mapping.

    Each webhook is scoped to a single doc screen via ``screen_id`` —
    a webhook is built for the row shape of one specific doc, so reusing
    it across docs would mix incompatible payloads. The field is
    ``Optional`` only to accommodate webhooks created before this binding
    existed; the UI nudges users to fill it.
    """

    id: str = Field(..., min_length=1, max_length=64)
    name: str = Field(..., min_length=1, max_length=160)
    url: str = Field(..., min_length=1, max_length=2048)
    # The doc screen this webhook serves. Empty = orphaned (legacy data
    # or screen was deleted) — surfaced as a warning in the admin UI.
    screen_id: Optional[str] = Field(default=None, max_length=64)
    headers: List[WorkboardWebhookHeader] = Field(default_factory=list)

    batch_size: int = Field(default=500, ge=1, le=500)
    delay_between_batches_ms: int = Field(default=0, ge=0, le=60000)
    timeout_ms: int = Field(default=15000, ge=1000, le=120000)
    # When True, a non-2xx response on any batch stops the run and marks
    # it as ``failed``. When False the run keeps going and ends as
    # ``partial`` if any batch failed.
    stop_on_error: bool = True
    is_active: bool = True
    description: Optional[str] = Field(default=None, max_length=500)

    model_config = ConfigDict(extra="forbid")


class WorkboardWebhookCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=160)
    url: str = Field(..., min_length=1, max_length=2048)
    screen_id: str = Field(..., min_length=1, max_length=64)
    headers: List[WorkboardWebhookHeader] = Field(default_factory=list)
    batch_size: int = Field(default=500, ge=1, le=500)
    delay_between_batches_ms: int = Field(default=0, ge=0, le=60000)
    timeout_ms: int = Field(default=15000, ge=1000, le=120000)
    stop_on_error: bool = True
    is_active: bool = True
    description: Optional[str] = Field(default=None, max_length=500)

    model_config = ConfigDict(extra="forbid")


class WorkboardWebhookUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    url: Optional[str] = Field(default=None, min_length=1, max_length=2048)
    screen_id: Optional[str] = Field(default=None, min_length=1, max_length=64)
    headers: Optional[List[WorkboardWebhookHeader]] = None
    batch_size: Optional[int] = Field(default=None, ge=1, le=500)
    delay_between_batches_ms: Optional[int] = Field(default=None, ge=0, le=60000)
    timeout_ms: Optional[int] = Field(default=None, ge=1000, le=120000)
    stop_on_error: Optional[bool] = None
    is_active: Optional[bool] = None
    description: Optional[str] = Field(default=None, max_length=500)

    model_config = ConfigDict(extra="forbid")


class WorkboardWebhookTestRequest(BaseModel):
    """Test a webhook with a small synthetic sample."""

    sample_rows: int = Field(default=3, ge=1, le=20)
    sample_columns: List[str] = Field(default_factory=lambda: ["col_a", "col_b"])

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Sync runs
# ---------------------------------------------------------------------------

SyncRunStatus = Literal[
    "pending", "running", "success", "failed", "partial", "cancelled"
]


class WorkboardSyncRunResponse(BaseModel):
    """Status payload returned by both admin and public endpoints.

    Public callers only get a subset (no per-batch URL/response detail) —
    this same model is reused with selective field population.
    """

    run_id: str
    status: SyncRunStatus
    workboard_id: int
    screen_id: str
    block_index: int
    trigger_id: str
    webhook_id: str
    webhook_name: Optional[str] = None

    total_rows: int = 0
    total_batches: int = 0
    completed_batches: int = 0
    failed_batches: int = 0

    last_response_status: Optional[int] = None
    last_error: Optional[str] = None

    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    duration_ms: Optional[int] = None
    created_at: datetime

    triggered_by_app_user_username: Optional[str] = None
    triggered_by_user_email: Optional[str] = None


class WorkboardSyncRunDetailResponse(WorkboardSyncRunResponse):
    """Admin detail view — adds the snapshot URL and response excerpt."""

    webhook_url: Optional[str] = None
    response_excerpt: Optional[Dict[str, Any]] = None

