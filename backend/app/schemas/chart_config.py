"""
Chart configuration schemas.
"""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any


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
    w: int = Field(..., ge=1, le=12, description="Width in grid columns (1-12)")
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
