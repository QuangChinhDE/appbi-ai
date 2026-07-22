"""
CRUD service for dashboards.
"""
from typing import List, Optional
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.exc import IntegrityError

from app.models import Dashboard, DashboardChart
from app.schemas import DashboardCreate, DashboardUpdate
from app.schemas.chart_config import DashboardChartItem, DashboardChartLayout, DashboardLayoutUpdate
from app.services.chart_service import ChartService
from app.core.logging import get_logger

logger = get_logger(__name__)
DEFAULT_DASHBOARD_PAGE = {"id": "page-1", "name": "Page 1"}
DEFAULT_DASHBOARD_PAGE_ID = DEFAULT_DASHBOARD_PAGE["id"]


_NAMED_ACCENT_COLORS = {
    "blue": "#2563eb",
    "green": "#10b981",
    "emerald": "#10b981",
    "amber": "#f59e0b",
    "orange": "#f97316",
    "red": "#ef4444",
    "rose": "#e11d48",
    "purple": "#7c3aed",
    "slate": "#475569",
}


_FONT_PRESETS = {
    "inter": 'var(--font-inter), Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    "dm-sans": 'var(--font-dm-sans), "DM Sans", var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif',
    "dm sans": 'var(--font-dm-sans), "DM Sans", var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif',
    "roboto": 'var(--font-roboto), Roboto, var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif',
}


def normalize_dashboard_theme_config(theme_config: Optional[dict]) -> Optional[dict]:
    """Accept MCP-friendly aliases while storing the frontend runtime shape.

    The MCP guide historically used keys such as ``font``, ``backgroundColor``,
    ``density`` and ``cardStyle='elevated'``.  Keeping those aliases here lets
    older prompts and new guided prompts produce the same dashboard rendering.
    """
    if not isinstance(theme_config, dict):
        return theme_config

    normalized = dict(theme_config)

    font = normalized.get("fontFamily") or normalized.get("font")
    if isinstance(font, str) and font.strip():
        normalized["fontFamily"] = _FONT_PRESETS.get(font.strip().lower(), font.strip())

    background = normalized.get("background")
    if background is None:
        background = normalized.get("backgroundColor")
    if isinstance(background, str) and background.strip():
        normalized["background"] = background.strip()

    accent = normalized.get("accent")
    if isinstance(accent, str) and accent.strip():
        normalized["accent"] = _NAMED_ACCENT_COLORS.get(accent.strip().lower(), accent.strip())

    density = normalized.get("density")
    if isinstance(density, str):
        density_value = density.strip().lower()
        if density_value == "comfortable":
            density_value = "normal"
        if density_value in {"compact", "normal", "spacious"}:
            normalized["density"] = density_value

    card_style = normalized.get("cardStyle")
    if isinstance(card_style, str):
        card_style_value = card_style.strip().lower()
        if card_style_value in {"soft", "sharp", "flat", "elevated"}:
            normalized["cardStyle"] = card_style_value

    return normalized


def normalize_dashboard_widget_config(widget_type: str | None, widget_config: Optional[dict]) -> dict:
    """Normalize MCP/spec widget aliases to the runtime config keys."""
    config = dict(widget_config or {})
    wt = str(widget_type or "chart").strip().lower()

    if wt == "text":
        text_value = config.get("template")
        if text_value is None:
            text_value = config.get("markdown")
        if text_value is None:
            text_value = config.get("text")
        if text_value is not None:
            config["template"] = str(text_value)

    elif wt == "countdown":
        target_value = config.get("target")
        if target_value is None:
            target_value = config.get("target_date")
        if target_value is None:
            target_value = config.get("targetDate")
        if target_value is not None:
            config["target"] = str(target_value)

    elif wt == "shape":
        kind_value = config.get("kind")
        if kind_value is None:
            kind_value = config.get("shape")
        if isinstance(kind_value, str) and kind_value.strip():
            normalized_kind = kind_value.strip().lower()
            if normalized_kind == "rectangle":
                normalized_kind = "rect"
            if normalized_kind in {"rect", "circle", "line", "divider"}:
                config["kind"] = normalized_kind

    return config


def _resolve_dashboard_chart_page_id(layout: DashboardChartLayout | dict | None) -> str:
    if isinstance(layout, DashboardChartLayout):
        page_id = layout.pageId
    elif isinstance(layout, dict):
        page_id = layout.get("pageId")
    else:
        page_id = None

    if isinstance(page_id, str) and page_id.strip():
        return page_id.strip()
    return DEFAULT_DASHBOARD_PAGE_ID


class DashboardService:
    """Service for dashboard operations."""
    
    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[Dashboard]:
        """Get all dashboards with pagination."""
        return db.query(Dashboard).offset(skip).limit(limit).all()
    
    @staticmethod
    def get_by_id(db: Session, dashboard_id: int) -> Optional[Dashboard]:
        """Get a dashboard by ID."""
        dashboard = db.query(Dashboard)\
            .options(joinedload(Dashboard.dashboard_charts).joinedload(DashboardChart.chart))\
            .filter(Dashboard.id == dashboard_id).first()
        if dashboard:
            for dashboard_chart in dashboard.dashboard_charts or []:
                ChartService.hydrate_runtime_config(db, dashboard_chart.chart, auto_generate=False)
        return dashboard
    
    @staticmethod
    def get_by_name(db: Session, name: str) -> Optional[Dashboard]:
        """Get a dashboard by name."""
        return db.query(Dashboard).filter(Dashboard.name == name).first()
    
    @staticmethod
    def create(db: Session, dashboard: DashboardCreate, owner_id=None) -> Dashboard:
        """Create a new dashboard."""
        try:
            db_dashboard = Dashboard(
                name=dashboard.name,
                description=dashboard.description,
                owner_id=owner_id,
                filters_config=dashboard.filters_config or [],
                slicers_config=dashboard.slicers_config or [],
                slicer_cluster_layout=dashboard.slicer_cluster_layout,
                public_filters_config=dashboard.public_filters_config or [],
                pages_config=dashboard.pages_config or [DEFAULT_DASHBOARD_PAGE],
                layout_mode=dashboard.layout_mode or "grid",
                theme_config=normalize_dashboard_theme_config(dashboard.theme_config),
                canvas_config=dashboard.canvas_config,
            )
            db.add(db_dashboard)
            db.flush()  # Get the ID without committing
            
            # Add charts if provided
            for chart_item in dashboard.charts:
                widget_type = str(chart_item.widget_type or "chart").strip().lower()
                if widget_type and widget_type != "chart":
                    db_dashboard_chart = DashboardChart(
                        dashboard_id=db_dashboard.id,
                        chart_id=None,
                        widget_type=widget_type,
                        widget_config=normalize_dashboard_widget_config(widget_type, chart_item.widget_config),
                        layout=chart_item.layout.model_dump(),
                        parameters=chart_item.parameters or {},
                    )
                    db.add(db_dashboard_chart)
                    continue

                if chart_item.chart_id is None:
                    db.rollback()
                    raise ValueError("chart_id is required for chart widgets")

                # Verify chart exists
                chart = ChartService.get_by_id(db, chart_item.chart_id)
                if not chart:
                    db.rollback()
                    raise ValueError(f"Chart with ID {chart_item.chart_id} not found")
                
                db_dashboard_chart = DashboardChart(
                    dashboard_id=db_dashboard.id,
                    chart_id=chart_item.chart_id,
                    layout=chart_item.layout.model_dump(),
                    parameters=chart_item.parameters or {},
                )
                db.add(db_dashboard_chart)
            
            db.commit()
            db.refresh(db_dashboard)
            logger.info(f"Created dashboard: {dashboard.name}")
            return DashboardService.get_by_id(db, db_dashboard.id)
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Dashboard with name '{dashboard.name}' already exists")
    
    @staticmethod
    def update(
        db: Session,
        dashboard_id: int,
        dashboard_update: DashboardUpdate
    ) -> Optional[Dashboard]:
        """Update a dashboard."""
        db_dashboard = DashboardService.get_by_id(db, dashboard_id)
        if not db_dashboard:
            return None
        
        try:
            update_data = dashboard_update.model_dump(exclude_unset=True)
            if "theme_config" in update_data:
                update_data["theme_config"] = normalize_dashboard_theme_config(update_data.get("theme_config"))
            for field, value in update_data.items():
                setattr(db_dashboard, field, value)
            
            db.commit()
            db.refresh(db_dashboard)
            logger.info(f"Updated dashboard: {db_dashboard.name}")
            return DashboardService.get_by_id(db, dashboard_id)
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Dashboard with name '{dashboard_update.name}' already exists")
    
    @staticmethod
    def delete(db: Session, dashboard_id: int) -> bool:
        """Delete a dashboard."""
        db_dashboard = DashboardService.get_by_id(db, dashboard_id)
        if not db_dashboard:
            return False
        
        db.delete(db_dashboard)
        db.commit()
        logger.info(f"Deleted dashboard: {db_dashboard.name}")
        return True
    
    @staticmethod
    def add_chart(
        db: Session,
        dashboard_id: int,
        chart_id: int,
        layout: DashboardChartLayout,
        parameters: Optional[dict] = None,
    ) -> Optional[Dashboard]:
        """Add a chart to a dashboard."""
        db_dashboard = DashboardService.get_by_id(db, dashboard_id)
        if not db_dashboard:
            return None
        
        # Verify chart exists
        chart = ChartService.get_by_id(db, chart_id)
        if not chart:
            raise ValueError(f"Chart with ID {chart_id} not found")
        
        # Reusable chart tiles: the SAME chart may be placed any number of times
        # on the same page and across pages of a dashboard. Each DashboardChart
        # row is an independent tile instance (identified by its own id), so we
        # do NOT dedupe by (dashboard_id, chart_id, page) here — adding a chart
        # that already appears on the page just creates another tile.
        db_dashboard_chart = DashboardChart(
            dashboard_id=dashboard_id,
            chart_id=chart_id,
            layout=layout.model_dump(),
            parameters=parameters or {},
        )
        db.add(db_dashboard_chart)
        db.commit()
        db.refresh(db_dashboard)
        logger.info(f"Added chart {chart_id} to dashboard {dashboard_id}")
        return DashboardService.get_by_id(db, dashboard_id)
    
    @staticmethod
    def add_widget(
        db: Session,
        dashboard_id: int,
        widget_type: str,
        layout: DashboardChartLayout,
        widget_config: Optional[dict] = None,
    ) -> Optional[Dashboard]:
        """Add a non-chart widget (text/countdown/image/shape/parameter_switcher)."""
        db_dashboard = DashboardService.get_by_id(db, dashboard_id)
        if not db_dashboard:
            return None
        db_dashboard_chart = DashboardChart(
            dashboard_id=dashboard_id,
            chart_id=None,
            widget_type=widget_type,
            widget_config=normalize_dashboard_widget_config(widget_type, widget_config),
            layout=layout.model_dump(),
            parameters={},
        )
        db.add(db_dashboard_chart)
        db.commit()
        db.refresh(db_dashboard)
        logger.info(f"Added {widget_type} widget to dashboard {dashboard_id}")
        return DashboardService.get_by_id(db, dashboard_id)

    @staticmethod
    def remove_chart(
        db: Session,
        dashboard_id: int,
        dashboard_chart_id: int
    ) -> Optional[Dashboard]:
        """Remove a chart instance from a dashboard."""
        db_dashboard = DashboardService.get_by_id(db, dashboard_id)
        if not db_dashboard:
            return None
        
        db_dashboard_chart = db.query(DashboardChart).filter(
            DashboardChart.dashboard_id == dashboard_id,
            DashboardChart.id == dashboard_chart_id
        ).first()
        
        if not db_dashboard_chart:
            raise ValueError(f"Dashboard chart with ID {dashboard_chart_id} not found")
        
        db.delete(db_dashboard_chart)
        db.commit()
        db.refresh(db_dashboard)
        logger.info(f"Removed dashboard chart {dashboard_chart_id} from dashboard {dashboard_id}")
        return DashboardService.get_by_id(db, dashboard_id)
    
    @staticmethod
    def update_layout(
        db: Session,
        dashboard_id: int,
        chart_layouts: List[DashboardLayoutUpdate]
    ) -> Optional[Dashboard]:
        """Update layout for all charts in a dashboard."""
        db_dashboard = DashboardService.get_by_id(db, dashboard_id)
        if not db_dashboard:
            return None
        
        for chart_layout_update in chart_layouts:
            dashboard_chart_id = chart_layout_update.id
            layout = chart_layout_update.layout
            
            db_dashboard_chart = db.query(DashboardChart).filter(
                DashboardChart.id == dashboard_chart_id,
                DashboardChart.dashboard_id == dashboard_id
            ).first()
            
            if db_dashboard_chart:
                # Reusable tiles: a chart can repeat on the same page, so moving
                # or re-laying-out a tile never conflicts with another instance
                # of the same chart. No same-page dedupe here.
                db_dashboard_chart.layout = layout.model_dump()
        
        db.commit()
        db.refresh(db_dashboard)
        logger.info(f"Updated layout for dashboard {dashboard_id}")
        return DashboardService.get_by_id(db, dashboard_id)
