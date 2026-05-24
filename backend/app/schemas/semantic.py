"""
Semantic Layer Schemas
Pydantic schemas for LookML-style semantic definitions
"""
from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field, field_validator, model_validator
from datetime import datetime


# Dimension & Measure Definitions
class DimensionDefinition(BaseModel):
    """Dimension = friendly mapping over a single column.

    Dimensions are intentionally NOT a place to compute new values. For any
    per-row calculation, create a Calculated Column (Transformation.add_column)
    on the underlying DatasetTable; the column then becomes available to every
    measure and dimension on that table. See backend/app/api/DATASETS_README.md.

    Enforcement: ``sql`` MUST be empty or equal to ``name`` (qualified forms like
    ``${TABLE}.col`` are also accepted when ``col`` matches ``name``). Anything
    that looks like an expression is rejected so the data layer stays the single
    place where calculation lives.
    """
    name: str
    type: Literal["string", "number", "date", "datetime", "yesno"] = "string"
    sql: Optional[str] = None
    label: Optional[str] = None
    description: Optional[str] = None
    hidden: bool = False
    # Phase-13: optional drill-down parent. Pure metadata — engine doesn't
    # consume it; FE Explore uses it to surface "drill down to <child>"
    # actions and to group related dimensions in the column panel.
    # MUST point to another dimension's `name` on the SAME view (validator
    # at view-save time enforces this). Does NOT create a new calculation
    # mechanism — drill is purely "swap one dimension for another" at query
    # time. Keeps Phase-1 "2 cơ chế" invariant intact.
    parent: Optional[str] = None

    @field_validator("sql")
    @classmethod
    def _enforce_bare_column(cls, value: Optional[str], info) -> Optional[str]:
        if value is None:
            return None
        text = value.strip()
        if not text:
            return None
        name = (info.data.get("name") or "").strip()
        # Accept bare identifier, qualified `table.col`, or `${TABLE}.col`
        # forms — as long as the final segment matches the dimension's `name`.
        stripped = text
        if stripped.startswith("${") and "}" in stripped:
            stripped = stripped.split("}", 1)[1].lstrip(".")
        last_segment = stripped.rsplit(".", 1)[-1].strip()
        bare_pattern = r"^[A-Za-z_][A-Za-z0-9_]*$"
        import re as _re
        if not _re.fullmatch(bare_pattern, last_segment) or (name and last_segment != name):
            raise ValueError(
                "Dimension.sql phải bằng chính tên cột (không hỗ trợ biểu thức). "
                "Nếu cần tính toán, hãy tạo Calculated Column trên bảng nguồn rồi "
                "thêm dimension trỏ vào cột đó."
            )
        return text


class MeasureFilter(BaseModel):
    """A single filter condition applied inside a measure aggregation.

    Built via UI (column + operator + value) and translated to a SQL
    `CASE WHEN ... THEN expr END` wrapper at compile time so users with
    no SQL skill can still author filtered measures (Looker-style).
    """
    field: str  # Bare column or qualified ${view.field}; resolved against the host view
    operator: Literal[
        "eq", "ne", "gt", "gte", "lt", "lte",
        "in", "not_in", "between",
        "contains", "starts_with", "ends_with",
        "is_null", "is_not_null",
    ]
    value: Any = None  # Scalar, list (for in/not_in), or [low, high] for between


class MeasureFormat(BaseModel):
    """Display format hint for a measure.

    Compiler/UI use this to render values; it does not affect SQL.
    """
    kind: Literal["number", "currency", "percent", "duration", "custom"] = "number"
    decimals: Optional[int] = Field(default=None, ge=0, le=10)
    currency: Optional[str] = Field(default=None, max_length=8)  # e.g. "USD", "VND"
    suffix: Optional[str] = Field(default=None, max_length=16)
    prefix: Optional[str] = Field(default=None, max_length=16)
    pattern: Optional[str] = Field(default=None, max_length=64)  # for custom


class MeasureSourceColumn(BaseModel):
    """Phase-12: reference to a column in a specific view, used by dataset-scope
    measures to declare which views/columns the engine must join in before
    evaluating the measure expression. The engine then auto-resolves the join
    path via the dataset's join graph.
    """
    view: str
    field: str


class ContextModifier(BaseModel):
    """Phase-14: a single filter-context modifier on a Measure.

    Maps loosely to DAX `CALCULATE(measure, modifier1, modifier2)`. We
    intentionally only cover the 3 modifier kinds that compile cleanly to
    SQL window functions:

      * ``type="all"``        — emit the measure as a window aggregate
                                with NO partition (i.e. the grand total
                                across the result set). Used for
                                "% of total".
      * ``type="all_except"`` — window aggregate partitioned only by the
                                fields listed in ``keep_fields``; every
                                other dim is "blanked" from the context.
                                Used for "% of region total".
      * ``type="use_relationship"`` — pick a specific JOIN alias from the
                                explore's join graph instead of the
                                default path. Mirrors PowerBI's
                                USERELATIONSHIP(). The alias must match
                                a `JoinDefinition.alias` declared in
                                the dataset's SemanticExplore.joins.
                                **Phase-14 status: schema only.** The
                                engine accepts the modifier (validates the
                                alias exists) but does NOT yet route via
                                that alias when compiling FROM/JOIN. A
                                follow-up phase will wire it in once the
                                'all' / 'all_except' paths have settled.

    What we deliberately did NOT add: ``type="filter"`` (overlaps with
    the existing ``filters[]`` + ``where_sql`` fields on MeasureDefinition
    — adding a third spelling would re-introduce the "user doesn't know
    which to use" problem Phase-1 fixed) and row-iterator modifiers
    (SUMX/RANKX-equivalents — those need row context, not expressible as
    a single SQL window).
    """
    type: Literal["all", "all_except", "use_relationship"]
    # For type='all_except'. Names of dimensions on the chart's anchor
    # view to KEEP in the partition. Other slicer dims drop out.
    keep_fields: List[str] = Field(default_factory=list)
    # For type='use_relationship'. The alias of a JoinDefinition on the
    # dataset's SemanticExplore. Validator (BE save-time) checks it.
    join_alias: Optional[str] = None


class MeasureDefinition(BaseModel):
    """Measure definition (extended Phase-1, Phase-12).

    Backwards compatible: legacy measures with only {name, type, sql, ...}
    still validate. New optional fields:
      - expression: free SQL expression (advanced); when set, takes precedence
                    over `sql` as the value being aggregated.
      - filters:    structured filter list rendered as CASE WHEN.
      - where_sql:  raw WHERE fragment for power users; combined with `filters`
                    via AND inside the same CASE WHEN.
      - depends_on: list of measure names in the same view this measure
                    references (e.g. ratio = revenue / orders). Used for
                    dependency-cycle checks; the actual reference still
                    happens through `expression` SQL.
      - format:     display format hint.
      - folder:     UI grouping label.
      - scope:      Phase-12. "view" (default) means measure lives in the
                    parent SemanticView and only references columns in that
                    view. "dataset" means the measure references columns from
                    other views in the dataset (declared via source_columns);
                    the engine auto-joins those views via the join graph.
                    Power BI parity: a measure that spans multiple tables.
      - source_columns: Phase-12. Required when scope="dataset". List of
                    {view, field} entries — every view referenced here must be
                    reachable from the chart's base view via the join graph
                    at query time. The parent SemanticView acts as an
                    organizational container; its dataset_table_id is NOT
                    used to anchor the measure's data.
    """
    name: str
    type: Literal["count", "sum", "avg", "min", "max", "count_distinct", "percent_of_total"]
    sql: Optional[str] = None  # Column or simple SQL — value being aggregated
    expression: Optional[str] = None  # Advanced: full SQL expression aggregated by `type`
    filters: List[MeasureFilter] = Field(default_factory=list)
    where_sql: Optional[str] = Field(default=None, max_length=2000)
    depends_on: List[str] = Field(default_factory=list)
    format: Optional[MeasureFormat] = None
    folder: Optional[str] = Field(default=None, max_length=80)
    label: Optional[str] = None
    description: Optional[str] = None
    hidden: bool = False
    # Phase-12 additions
    scope: Literal["view", "dataset"] = "view"
    source_columns: List[MeasureSourceColumn] = Field(default_factory=list)
    # Phase-14: filter-context modifiers. When non-empty the engine emits
    # the measure as a SQL window aggregate (`agg(expr) OVER (...)`)
    # instead of a plain group aggregate. The set is intentionally small —
    # see ContextModifier docstring for what's in and what's out.
    # Combining modifiers: 'use_relationship' is orthogonal to all/all_except
    # and can co-exist with either. Combining 'all' and 'all_except' on the
    # same measure is rejected at save time (they mean the opposite thing).
    context_modifiers: List[ContextModifier] = Field(default_factory=list)

    @field_validator("expression", "where_sql")
    @classmethod
    def validate_sql_fragment(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        text = value.strip()
        if not text:
            return None
        lowered = text.lower()
        forbidden = [
            ";",
            "--",
            "/*",
            "*/",
            " drop ",
            " delete ",
            " insert ",
            " update ",
            " alter ",
            " create ",
            " truncate ",
            " execute ",
            " grant ",
            " revoke ",
        ]
        padded = f" {lowered} "
        if any(token in padded for token in forbidden):
            raise ValueError("Measure SQL fragment contains a forbidden token")
        return text

    @model_validator(mode="after")
    def _validate_sql_or_expression_required(self):
        # Phase-15.29: non-count measures MUST declare the value being
        # aggregated, either via `sql` (column form) or `expression`
        # (advanced form). Without it, the engine falls back to '*' which
        # produces invalid SQL (e.g. SUM(*)) for any agg ≠ count, or
        # silently resolves to a column matching the measure name —
        # surfacing as the "MCP-created measure has sql=<measure_name>"
        # bug DA hit on 2026-05-18.
        if self.type != "count":
            has_sql = bool((self.sql or "").strip())
            has_expr = bool((self.expression or "").strip())
            if not has_sql and not has_expr:
                raise ValueError(
                    f"measure '{self.name}' type='{self.type}' requires "
                    "either `sql` (the column to aggregate, e.g. "
                    "'${TABLE}.amount') or `expression` (advanced SQL). "
                    "Only `type='count'` may omit both — it counts rows."
                )
        return self

    @model_validator(mode="after")
    def _validate_context_modifiers(self):
        # Phase-14: per-modifier shape + cross-modifier consistency.
        if not self.context_modifiers:
            return self
        has_all = False
        has_all_except = False
        for idx, mod in enumerate(self.context_modifiers):
            if mod.type == "all_except":
                if not mod.keep_fields:
                    raise ValueError(
                        f"context_modifiers[{idx}] type='all_except' phải có "
                        "keep_fields (danh sách dim giữ lại trong partition)."
                    )
                has_all_except = True
            elif mod.type == "all":
                if mod.keep_fields:
                    raise ValueError(
                        f"context_modifiers[{idx}] type='all' không nhận "
                        "keep_fields. Dùng type='all_except' nếu muốn giữ "
                        "một số dim."
                    )
                has_all = True
            elif mod.type == "use_relationship":
                if not (mod.join_alias or "").strip():
                    raise ValueError(
                        f"context_modifiers[{idx}] type='use_relationship' "
                        "phải có join_alias trỏ vào JoinDefinition.alias."
                    )
        if has_all and has_all_except:
            raise ValueError(
                "context_modifiers không thể đồng thời có 'all' và 'all_except' "
                "trên cùng measure — chúng có ngữ nghĩa đối lập. Pick 1."
            )
        return self

    @model_validator(mode="after")
    def _validate_scope_and_source_columns(self):
        # Phase-12: scope and source_columns must agree.
        # view-scope measures cannot declare source_columns (their data comes
        # from the parent SemanticView). dataset-scope measures must declare
        # at least one source column so the engine knows which views to join.
        if self.scope == "view" and self.source_columns:
            raise ValueError(
                "source_columns chỉ dùng cho measure scope='dataset'. "
                "Đã xoá source_columns hoặc đổi scope sang 'dataset'."
            )
        if self.scope == "dataset" and not self.source_columns:
            raise ValueError(
                "Measure scope='dataset' phải khai báo ít nhất một entry trong "
                "source_columns (view, field)."
            )
        # Reject empty view/field strings — fail fast at save time
        for entry in self.source_columns:
            if not entry.view.strip() or not entry.field.strip():
                raise ValueError("source_columns entry phải có cả 'view' và 'field' không rỗng.")
        return self


# Join Definition
class JoinDefinition(BaseModel):
    """LookML-style join definition.

    `alias` is the name used to reference the joined view in semantic field
    references (e.g. `creator.email` vs `users.email`). When omitted, the join
    is referenced by `view` name. Aliasing enables role-playing dimensions
    (same view joined multiple times via different keys).
    """
    name: str
    view: str  # Name of the view to join
    alias: Optional[str] = None  # Optional alias for role-playing dimensions
    type: Literal["left", "inner", "right", "full"] = "left"
    sql_on: str  # SQL join condition, can use ${view.field} placeholders
    relationship: Optional[Literal["one_to_one", "one_to_many", "many_to_one", "many_to_many"]] = None
    from_view: Optional[str] = None
    from_column: Optional[str] = None
    to_column: Optional[str] = None
    from_columns: List[str] = Field(default_factory=list)
    to_columns: List[str] = Field(default_factory=list)
    origin: Optional[str] = None
    managed: Optional[bool] = None
    presentation_view: Optional[str] = None
    calendar_source_field: Optional[str] = None
    # Phase-3b: edge controls inspired by Power BI's "Manage relationships".
    # Default both fields preserve pre-Phase-3 behaviour so legacy joins keep
    # working without migration: every existing join is active + single-direction.
    is_active: bool = True
    cross_filter: Literal["single", "both"] = "single"


# Semantic View
class SemanticViewBase(BaseModel):
    """A semantic view bound to one DatasetTable.

    Phase-4 invariant: when ``dataset_table_id`` is set, ``sql_table_name``
    must be empty. The reverse path (``sql_table_name`` only, no
    ``dataset_table_id``) is grandfathered for legacy external-table views
    and is logged as a deprecation warning at validation time.
    """
    name: str
    sql_table_name: Optional[str] = None
    dataset_table_id: Optional[int] = None
    dimensions: List[DimensionDefinition] = []
    measures: List[MeasureDefinition] = []
    description: Optional[str] = None

    @field_validator("sql_table_name")
    @classmethod
    def _reject_dual_binding(cls, value: Optional[str], info) -> Optional[str]:
        # Field validator order follows declaration: dataset_table_id is
        # declared AFTER sql_table_name in the class body, so it isn't yet
        # in info.data when this validator runs. We can only validate the
        # other direction in __init__ via model-level rules. So here we just
        # normalise to None for empty strings; the cross-field check happens
        # at the API boundary (cleaner and easier to surface to the user).
        if isinstance(value, str) and not value.strip():
            return None
        return value


class SemanticViewCreate(SemanticViewBase):
    pass


class SemanticViewUpdate(BaseModel):
    name: Optional[str] = None
    sql_table_name: Optional[str] = None
    dataset_table_id: Optional[int] = None
    dimensions: Optional[List[DimensionDefinition]] = None
    measures: Optional[List[MeasureDefinition]] = None
    description: Optional[str] = None


class SemanticView(SemanticViewBase):
    id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# Semantic Explore
class SemanticExploreBase(BaseModel):
    name: str
    base_view_name: str
    base_view_id: int
    joins: List[JoinDefinition] = []
    default_filters: Optional[Dict[str, Any]] = {}
    description: Optional[str] = None


class SemanticExploreCreate(SemanticExploreBase):
    model_id: int


class SemanticExploreUpdate(BaseModel):
    name: Optional[str] = None
    base_view_name: Optional[str] = None
    base_view_id: Optional[int] = None
    joins: Optional[List[JoinDefinition]] = None
    default_filters: Optional[Dict[str, Any]] = None
    description: Optional[str] = None


class SemanticExplore(SemanticExploreBase):
    id: int
    model_id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# Semantic Model
class SemanticModelBase(BaseModel):
    name: str
    dataset_id: Optional[int] = None
    description: Optional[str] = None


class SemanticModelCreate(SemanticModelBase):
    pass


class SemanticModelUpdate(BaseModel):
    name: Optional[str] = None
    dataset_id: Optional[int] = None
    description: Optional[str] = None


class SemanticModel(SemanticModelBase):
    id: int
    created_at: datetime
    updated_at: datetime
    explores: List[SemanticExplore] = []

    class Config:
        from_attributes = True


# ── Dataset Model Response (aggregated view for Visual Model UI) ──────────

class DatasetModelView(BaseModel):
    """A semantic view with its source table info for Visual Model UI"""
    id: int
    name: str
    dataset_table_id: Optional[int] = None
    table_display_name: Optional[str] = None
    sql_table_name: Optional[str] = None
    dimensions: List[DimensionDefinition] = []
    measures: List[MeasureDefinition] = []
    description: Optional[str] = None

    class Config:
        from_attributes = True


class DatasetModelExplore(BaseModel):
    """An explore with resolved join info"""
    id: int
    name: str
    base_view_name: str
    base_view_id: int
    joins: List[JoinDefinition] = []
    description: Optional[str] = None

    class Config:
        from_attributes = True


class DatasetModelResponse(BaseModel):
    """Full dataset data model for Visual Model UI"""
    model_id: Optional[int] = None
    dataset_id: int
    dataset_name: str
    views: List[DatasetModelView] = []
    explores: List[DatasetModelExplore] = []
    generated: bool = False  # True if model was auto-generated this request


# Query Request & Response
class FilterCondition(BaseModel):
    """Filter condition for semantic query"""
    operator: Literal["eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "starts_with", "ends_with"]
    value: Any


class WindowFunctionDefinition(BaseModel):
    """Window function definition for semantic query"""
    name: str  # Output column name
    base_measure: str  # e.g. "orders.total_revenue"
    partition_by: List[str] = []  # Dimension fields
    order_by: List[str] = []  # Dimension/measure fields
    type: Literal["running_sum", "running_avg", "rank", "dense_rank", "row_number"]


class CalculatedFieldDefinition(BaseModel):
    """Calculated field definition for semantic query"""
    name: str  # Output column name
    sql: str  # SQL expression with ${view.field} placeholders
    type: Literal["string", "number", "date", "datetime"] = "number"


class SortDefinition(BaseModel):
    """Sort definition for semantic query"""
    field: str  # Qualified field name
    direction: Literal["asc", "desc"] = "asc"


class TopNDefinition(BaseModel):
    """Top N filtering definition"""
    field: str  # Field to rank by
    n: int = Field(ge=1, le=1000)


class SemanticQueryRequest(BaseModel):
    """Request to execute a semantic query (v2 with advanced features)"""
    explore: str  # Explore name
    dimensions: List[str] = []  # Qualified field names like "orders.order_date"
    measures: List[str] = []  # Qualified field names like "orders.total_revenue"
    filters: Dict[str, FilterCondition] = {}  # Field name -> filter condition
    pivots: List[str] = []  # Dimensions to pivot (currently supports max 1)
    sorts: List[SortDefinition] = []  # Sort specifications
    # Phase-15.83 — Pydantic upper bound bumped from 10000 to 10M sentinel.
    # The FE Explore editor now sends NO_LIMIT_SENTINEL after the row-cap
    # removal; old callers that omit the field still get the conservative
    # 500 default.
    limit: int = Field(default=500, ge=1, le=10_000_000)
    window_functions: List[WindowFunctionDefinition] = []  # Window function definitions
    calculated_fields: List[CalculatedFieldDefinition] = []  # Calculated fields
    time_grains: Dict[str, Literal["day", "week", "month", "quarter", "year"]] = {}  # Dimension -> grain
    top_n: Optional[TopNDefinition] = None  # Top N filtering
    measure_agg_overrides: Dict[str, str] = {}  # measure field -> agg type override (e.g. {"view.col": "max"})


class PivotedColumn(BaseModel):
    """Metadata for pivoted column"""
    base_field: str  # Original pivot dimension
    value: str  # Pivot value (e.g. "US")
    alias: str  # Column alias (e.g. "total_revenue_US")


class SemanticQueryResponse(BaseModel):
    """Response from semantic query execution (v2 with pivot metadata)"""
    sql: str
    columns: List[str]
    data: List[Dict[str, Any]]
    row_count: int
    execution_time_ms: Optional[float] = None
    pivoted_columns: List[PivotedColumn] = []  # Metadata for pivoted columns
    warnings: List[str] = []  # Any warnings about query execution
