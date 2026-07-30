"""
Chart configuration schemas.
"""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any


# Canonical per-chart-type required + optional role_config keys.
# Mirrors the FE chart-role registry and the MCP CHART_ROLE_REQUIREMENTS so
# ChartCreate / ChartUpdate validators can reject configs that miss required
# roles BEFORE they hit the DB. Without this, e.g. a BAR chart with no
# `dimension` slips past Pydantic and only fails at render time.
#
# Token grammar:
#   "key"          → key must be present in role_config and non-empty
#   "key[0]"       → role_config[key] must be a non-empty list (≥1 entry)
#   "key=value"    → role_config[key] must equal exactly `value`
#
# Optional keys are advisory only — not enforced, listed for downstream
# tooling (MCP / FE) that wants to surface "what else can I set here".
CHART_REQUIRED_ROLE_KEYS: Dict[str, Dict[str, List[str]]] = {
    "TABLE":          {"required": [],                                                                                                         "optional": ["selectedColumns"]},
    "MATRIX":         {"required": ["tableMode=pivot", "tableRowDimension", "tableColumnDimension", "tablePivotMetric"],                       "optional": []},
    "KPI":            {"required": ["metrics[0]"],                                                                                              "optional": ["benchmarkMetric"]},
    "GAUGE":          {"required": ["metrics[0]"],                                                                                              "optional": ["benchmarkMetric"]},
    "BULLET":         {"required": ["metrics[0]"],                                                                                              "optional": ["benchmarkMetric"]},
    "PODIUM":         {"required": ["dimension", "metrics[0]"],                                                                                 "optional": []},
    "BAR":            {"required": ["dimension", "metrics[0]"],                                                                                 "optional": ["breakdown"]},
    "HORIZONTAL_BAR": {"required": ["dimension", "metrics[0]"],                                                                                 "optional": []},
    "GROUPED_BAR":    {"required": ["dimension", "breakdown", "metrics[0]"],                                                                    "optional": []},
    "STACKED_BAR":    {"required": ["dimension", "breakdown", "metrics[0]"],                                                                    "optional": []},
    "BAR_LINE":       {"required": ["dimension", "metrics[0]", "lineMetric"],                                                                   "optional": []},
    "WATERFALL":      {"required": ["dimension", "metrics[0]"],                                                                                 "optional": []},
    "LINE":           {"required": ["dimension", "metrics[0]"],                                                                                 "optional": ["breakdown", "timeGrains"]},
    "AREA":           {"required": ["dimension", "metrics[0]"],                                                                                 "optional": ["breakdown", "timeGrains"]},
    "TIME_SERIES":    {"required": ["timeField", "metrics[0]"],                                                                                 "optional": ["breakdown", "timeGrains"]},
    "RIBBON":         {"required": ["timeField", "breakdown", "metrics[0]"],                                                                    "optional": ["timeGrains"]},
    "TIMELINE":       {"required": ["timeField", "dimension"],                                                                                  "optional": ["metrics"]},
    "PIE":            {"required": ["dimension", "metrics[0]"],                                                                                 "optional": []},
    "DONUT":          {"required": ["dimension", "metrics[0]"],                                                                                 "optional": []},
    "POLAR_AREA":     {"required": ["dimension", "metrics[0]"],                                                                                 "optional": []},
    "RADAR":          {"required": ["dimension", "metrics[0]"],                                                                                 "optional": []},
    "TREEMAP":        {"required": ["dimension", "metrics[0]"],                                                                                 "optional": []},
    "FUNNEL":         {"required": ["dimension", "metrics[0]"],                                                                                 "optional": []},
    "WORD_CLOUD":     {"required": ["dimension", "metrics[0]"],                                                                                 "optional": []},
    "SCATTER":        {"required": ["scatterX", "scatterY"],                                                                                    "optional": ["dimension"]},
    "BUBBLE":         {"required": ["scatterX", "scatterY", "metrics[0]"],                                                                      "optional": ["dimension"]},
    "MAP_POINT":      {"required": ["scatterX", "scatterY"],                                                                                    "optional": ["dimension", "metrics"]},
    # NINE_BOX — talent / BCG 3×3 grid. X & Y are the two axis fields (numeric
    # → auto-binned into tertiles, or a 3-level category used directly);
    # `dimension` labels each plotted item; `metrics[0]` is the optional bubble
    # size. Same scatter-family query semantics as SCATTER (each row a point;
    # a declared-measure axis aggregates per item via the shared classifier).
    "NINE_BOX":       {"required": ["scatterX", "scatterY"],                                                                                    "optional": ["dimension", "metrics"]},
    "MAP_REGION":     {"required": ["dimension", "metrics[0]"],                                                                                 "optional": []},
    "HEATMAP":        {"required": ["dimension", "breakdown", "metrics[0]"],                                                                    "optional": []},
    "BOXPLOT":        {"required": ["dimension", "metrics[0]"],                                                                                 "optional": []},
    "SANKEY":         {"required": ["dimension", "breakdown", "metrics[0]"],                                                                    "optional": []},
    "SUNBURST":       {"required": ["dimension", "breakdown", "metrics[0]"],                                                                    "optional": []},
}


def _is_present(role_config: Dict[str, Any], token: str) -> Optional[str]:
    """Return None if role_config satisfies the requirement token, else the
    human-readable reason it's missing.

    Tokens: "key" / "key[0]" / "key=value" — see CHART_REQUIRED_ROLE_KEYS.
    """
    if "=" in token:
        key, _, expected = token.partition("=")
        value = role_config.get(key.strip())
        if str(value).strip() != expected.strip():
            return f"{key.strip()} must equal {expected.strip()!r} (got {value!r})"
        return None
    if "[" in token and token.endswith("]"):
        key = token.split("[", 1)[0]
        value = role_config.get(key)
        if not isinstance(value, list) or len(value) == 0:
            return f"{key} must be a non-empty list"
        return None
    value = role_config.get(token)
    if value is None or (isinstance(value, (str, list, dict)) and len(value) == 0):
        return f"{token} is required"
    return None


def check_chart_required_role_keys(
    chart_type: str,
    role_config: Optional[Dict[str, Any]],
) -> List[str]:
    """Return a list of human-readable missing-requirement messages.

    Empty list = config satisfies BE chart-type contract.
    Unknown chart_type: returns []. ChartCreate already checks the enum
    upstream, so we don't double-error here.
    """
    spec = CHART_REQUIRED_ROLE_KEYS.get(str(chart_type).upper())
    if not spec:
        return []
    role_config = role_config if isinstance(role_config, dict) else {}
    errors: List[str] = []
    for token in spec.get("required", []):
        reason = _is_present(role_config, token)
        if reason:
            errors.append(reason)
    return errors


# Phase-15.82 — strict structural typecheck for role_config. Catches
# malformed payloads (e.g. `metrics: "sum_revenue"` instead of a list of
# dicts) that the token-based checker above can't see. Returns list of
# human-readable errors, mirroring `check_chart_required_role_keys` so
# callers can concat both for a complete validation pass.
_VALID_AGG = {"sum", "avg", "count", "min", "max", "count_distinct", "auto"}


def _check_metric_shape(metric: Any, path: str) -> List[str]:
    """Phase-15.82 — STRUCTURAL shape only. We deliberately do NOT reject
    empty/whitespace `field` here because legacy charts saved during the
    draft-builder flow (Phase-13/14) routinely persisted placeholder
    metrics like ``{field: "", agg: "sum"}`` and any UPDATE that
    re-submits the full config would otherwise crash with 422.

    The per-chart-type required-key validator
    (:func:`check_chart_required_role_keys`) is the layer that checks
    emptiness when the chart is actually expected to render — that's the
    right place to enforce "you need a metric to draw a BAR chart".
    """
    errors: List[str] = []
    if not isinstance(metric, dict):
        return [f"{path} must be an object with field+agg (got {type(metric).__name__})"]
    field = metric.get("field")
    if field is not None and not isinstance(field, str):
        errors.append(f"{path}.field must be a string when present (got {type(field).__name__})")
    agg = metric.get("agg")
    # agg may be omitted on legacy/draft rows; only fail on outright-wrong types.
    if agg is not None and (not isinstance(agg, str) or agg not in _VALID_AGG):
        errors.append(f"{path}.agg must be one of {sorted(_VALID_AGG)} (got {agg!r})")
    return errors


def check_role_config_shape(role_config: Optional[Dict[str, Any]]) -> List[str]:
    """Validate the structural shape of role_config independent of chart type.

    Catches drift like passing `metrics` as a string, `breakdown` as a list,
    or a malformed `lineMetric`. Combined with `check_chart_required_role_keys`
    it forms a two-layer validator: structural shape + chart-type required
    keys.
    """
    if role_config is None:
        return []
    if not isinstance(role_config, dict):
        return [f"role_config must be an object (got {type(role_config).__name__})"]
    errors: List[str] = []

    metrics = role_config.get("metrics")
    if metrics is not None:
        if not isinstance(metrics, list):
            errors.append(f"metrics must be a list (got {type(metrics).__name__})")
        else:
            for i, m in enumerate(metrics):
                errors.extend(_check_metric_shape(m, f"metrics[{i}]"))

    for single_metric_key in ("lineMetric", "tablePivotMetric", "benchmarkMetric"):
        m = role_config.get(single_metric_key)
        if m is not None:
            errors.extend(_check_metric_shape(m, single_metric_key))

    for str_key in ("dimension", "breakdown", "timeField", "scatterX", "scatterY",
                    "tableRowDimension", "tableColumnDimension", "tableMode"):
        value = role_config.get(str_key)
        if value is not None and not isinstance(value, str):
            errors.append(f"{str_key} must be a string (got {type(value).__name__})")

    selected = role_config.get("selectedColumns")
    if selected is not None:
        if not isinstance(selected, list):
            errors.append(f"selectedColumns must be a list (got {type(selected).__name__})")
        else:
            for i, c in enumerate(selected):
                if not isinstance(c, str):
                    errors.append(f"selectedColumns[{i}] must be a string")

    time_grains = role_config.get("timeGrains")
    if time_grains is not None:
        if not isinstance(time_grains, dict):
            errors.append(f"timeGrains must be an object (got {type(time_grains).__name__})")
        else:
            valid_grains = {"day", "week", "month", "quarter", "year"}
            for k, v in time_grains.items():
                if not isinstance(v, str) or v not in valid_grains:
                    errors.append(f"timeGrains[{k!r}] must be one of {sorted(valid_grains)} (got {v!r})")

    return errors


class ChartConfigBase(BaseModel):
    """
    Base chart configuration model.
    Different chart types use different subsets of these fields.
    """
    # For bar/line charts
    x_axis: Optional[str] = Field(None, description="Column name for X axis")
    y_axis: Optional[str] = Field(None, description="Column name for Y axis (single value)")
    
    # For multi-series charts
    y_fields: Optional[List[str]] = Field(None, description="Column names for multiple Y values")
    
    # For time-series charts
    time_column: Optional[str] = Field(None, description="Column name for time axis")
    value_column: Optional[str] = Field(None, description="Column name for value")
    
    # For pie charts
    label_column: Optional[str] = Field(None, description="Column name for labels")
    value_column_pie: Optional[str] = Field(None, description="Column name for pie values")
    
    # Common options
    title: Optional[str] = Field(None, description="Chart title")
    filters: Optional[Dict[str, Any]] = Field(None, description="Additional filters to apply")
    colors: Optional[List[str]] = Field(None, description="Custom color palette (deprecated, use color or series_colors)")
    
    # Color configuration
    color: Optional[str] = Field(None, description="Single color for single-series charts (PIE, KPI)")
    series_colors: Optional[Dict[str, str]] = Field(None, description="Per-series colors: {'sales': '#ff0000', 'profit': '#00aa88'}")
    
    # Theme and palette
    palette: Optional[str] = Field(None, description="Named color palette: 'default', 'vibrant', 'classic', 'monochrome', 'pastel'")
    color_by_dimension: Optional[str] = Field(None, description="Dimension name to use for color mapping (e.g., 'country', 'category')")
    
    # Explore 2.0: Advanced features
    dimensions: Optional[List[str]] = Field(None, description="Selected dimension columns (legacy, for backward compatibility)")
    measures: Optional[List[str]] = Field(None, description="Selected measure columns (legacy, for backward compatibility)")
    dimension_configs: Optional[List[Dict[str, Any]]] = Field(None, description="Dimension configs with labels: [{field, label}]")
    measure_configs: Optional[List[Dict[str, Any]]] = Field(None, description="Measure configs: [{field, agg, label}]")
    grouping: Optional[Dict[str, Any]] = Field(None, description="Grouping config: {rowDimensions: [], columnDimension: ''}")
    sorts: Optional[List[Dict[str, Any]]] = Field(None, description="Sort configs: [{field, direction, index}]")
    conditional_formatting: Optional[List[Dict[str, Any]]] = Field(
        None,
        description="Conditional format rules: [{field, operator, value|benchmarkField, color, backgroundColor}]",
    )
    
    class Config:
        extra = "allow"  # Allow additional fields for extensibility


class DashboardChartLayout(BaseModel):
    """
    Layout configuration for a chart in a dashboard.
    Compatible with react-grid-layout format; canvas-mode geometry lives in
    the optional ``*Px`` fields and ``z`` for stacking.
    """
    i: Optional[str] = Field(None, description="Unique identifier (chart ID as string)")
    x: int = Field(..., ge=0, description="X position in grid (columns)")
    y: int = Field(..., ge=0, description="Y position in grid (rows)")
    w: int = Field(..., ge=1, le=36, description="Width in grid columns (1-36; finer grid)")
    h: int = Field(..., ge=1, description="Height in grid rows")

    # Optional properties
    minW: Optional[int] = Field(None, ge=1, description="Minimum width")
    maxW: Optional[int] = Field(None, ge=1, description="Maximum width")
    minH: Optional[int] = Field(None, ge=1, description="Minimum height")
    maxH: Optional[int] = Field(None, ge=1, description="Maximum height")
    static: Optional[bool] = Field(False, description="Whether item is static (non-draggable)")
    pageId: Optional[str] = Field(None, description="Dashboard page identifier")

    # Canvas-mode geometry (pixels). Stored alongside grid coords so toggling
    # back to grid never loses the original cell positions.
    xPx: Optional[float] = Field(None, description="Canvas X (px)")
    yPx: Optional[float] = Field(None, description="Canvas Y (px)")
    wPx: Optional[float] = Field(None, ge=1, description="Canvas width (px)")
    hPx: Optional[float] = Field(None, ge=1, description="Canvas height (px)")
    z: Optional[int] = Field(None, description="Stacking order in canvas mode")

    class Config:
        extra = "allow"  # Allow react-grid-layout to add more fields


WidgetType = str  # "chart" | "text" | "countdown" | "image" | "shape" | "parameter_switcher"


class DashboardChartItem(BaseModel):
    """Item representing a chart or widget in a dashboard with its layout."""
    chart_id: Optional[int] = Field(
        None, description="ID of the chart to display (None for non-chart widgets)"
    )
    layout: DashboardChartLayout = Field(..., description="Layout configuration")
    parameters: Optional[Dict[str, Any]] = Field(
        None, description="Runtime parameter values for this chart instance"
    )
    widget_type: Optional[WidgetType] = Field(
        "chart", description="Widget kind: chart/text/countdown/image/shape/parameter_switcher"
    )
    widget_config: Optional[Dict[str, Any]] = Field(
        None, description="Per-widget config (ignored when widget_type=='chart')"
    )


class DashboardThemeConfig(BaseModel):
    """Dashboard-level theme tokens applied to every tile and widget."""
    mode: Optional[str] = Field("light", description="'light' or 'dark'")
    accent: Optional[str] = Field(None, description="Accent color hex, e.g. '#facc15'")
    fontFamily: Optional[str] = Field(None, description="CSS font-family stack")
    cardStyle: Optional[str] = Field("soft", description="'soft' | 'sharp' | 'flat'")
    background: Optional[str] = Field(None, description="Optional canvas background color")

    class Config:
        extra = "allow"


class DashboardCanvasConfig(BaseModel):
    """Canvas geometry used when ``layout_mode == 'canvas'``."""
    width: int = Field(1440, ge=320, le=4000)
    height: int = Field(900, ge=320, le=10000)
    snap: int = Field(8, ge=1, le=64, description="Snap grid in px")
    background: Optional[str] = Field(None, description="Optional override; falls back to theme")

    class Config:
        extra = "allow"


class DashboardLayoutUpdate(BaseModel):
    """Update for a single chart's layout in a dashboard."""
    id: int = Field(..., description="DashboardChart ID")
    layout: DashboardChartLayout = Field(..., description="New layout configuration")
