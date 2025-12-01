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
    colors: Optional[List[str]] = Field(None, description="Custom color palette")
    
    class Config:
        extra = "allow"  # Allow additional fields for extensibility


class DashboardChartLayout(BaseModel):
    """
    Layout configuration for a chart in a dashboard.
    Compatible with react-grid-layout format.
    """
    i: str = Field(..., description="Unique identifier (chart ID as string)")
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
    
    class Config:
        extra = "allow"  # Allow react-grid-layout to add more fields


class DashboardChartItem(BaseModel):
    """Item representing a chart in a dashboard with its layout."""
    chart_id: int = Field(..., description="ID of the chart to display")
    layout: DashboardChartLayout = Field(..., description="Layout configuration")


class DashboardLayoutUpdate(BaseModel):
    """Update for a single chart's layout in a dashboard."""
    id: int = Field(..., description="DashboardChart ID")
    layout: DashboardChartLayout = Field(..., description="New layout configuration")
