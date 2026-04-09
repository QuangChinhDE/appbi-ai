"""
Filter Utility Functions
Helper functions for dashboard filters and filter compatibility checking
"""
from typing import Dict, List, Any, Optional
from sqlalchemy.orm import Session
from app.models.semantic import SemanticView, SemanticExplore
from app.models import Chart
from app.services.chart_contracts import get_chart_active_role_config
from app.services.chart_semantic_service import with_chart_semantic_binding
from app.core.logging import get_logger

logger = get_logger(__name__)


class FilterUtils:
    """Utility class for filter operations"""
    
    @staticmethod
    def field_exists_in_explore(
        db: Session,
        explore_name: str,
        field: str
    ) -> bool:
        """
        Check if a field exists in an explore's views
        
        Args:
            db: Database session
            explore_name: Name of the explore
            field: Qualified field name (e.g., "customers.country")
        
        Returns:
            True if field exists in explore, False otherwise
        """
        try:
            # Parse field reference
            if '.' not in field:
                return False
            
            view_name, field_name = field.split('.', 1)
            
            # Get explore
            explore = db.query(SemanticExplore).filter(
                SemanticExplore.name == explore_name
            ).first()
            
            if not explore:
                return False
            
            # Check base view
            base_view = db.query(SemanticView).filter(
                SemanticView.id == explore.base_view_id
            ).first()
            
            if base_view and base_view.name == view_name:
                # Check dimensions
                for dim in base_view.dimensions:
                    if dim.get('name') == field_name:
                        return True
                # Check measures
                for measure in base_view.measures:
                    if measure.get('name') == field_name:
                        return True
            
            # Check joined views
            for join_def in explore.joins:
                if join_def.get('view') == view_name:
                    # Get joined view
                    joined_view = db.query(SemanticView).filter(
                        SemanticView.name == view_name
                    ).first()
                    
                    if joined_view:
                        # Check dimensions
                        for dim in joined_view.dimensions:
                            if dim.get('name') == field_name:
                                return True
                        # Check measures
                        for measure in joined_view.measures:
                            if measure.get('name') == field_name:
                                return True
            
            return False

        except Exception:
            logger.warning("field_exists_in_explore failed for explore=%s field=%s", explore_name, field, exc_info=True)
            return False

    @staticmethod
    def field_exists_in_view(
        db: Session,
        view_name: str,
        field: str
    ) -> bool:
        """
        Check if a field exists in a view
        
        Args:
            db: Database session
            view_name: Name of the view
            field: Field name (without view prefix)
        
        Returns:
            True if field exists, False otherwise
        """
        try:
            view = db.query(SemanticView).filter(
                SemanticView.name == view_name
            ).first()
            
            if not view:
                return False
            
            # Check dimensions
            for dim in view.dimensions:
                if dim.get('name') == field:
                    return True
            
            # Check measures
            for measure in view.measures:
                if measure.get('name') == field:
                    return True
            
            return False

        except Exception:
            logger.warning("field_exists_in_view failed for view=%s field=%s", view_name, field, exc_info=True)
            return False

    @staticmethod
    def merge_filters(
        persistent_filters: List[Dict[str, Any]],
        cross_filters: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Merge persistent dashboard filters and temporary cross-filters
        
        Args:
            persistent_filters: List of dashboard filter dicts
            cross_filters: List of cross-filter dicts
        
        Returns:
            Merged filter dictionary for semantic query
        """
        merged = {}
        
        # Add persistent filters
        for pf in persistent_filters:
            field = pf.get('field')
            if field:
                merged[field] = {
                    'operator': pf.get('operator', 'eq'),
                    'value': pf.get('value')
                }
        
        # Add cross-filters (may override persistent)
        for cf in cross_filters:
            field = cf.get('field')
            if field:
                merged[field] = {
                    'operator': cf.get('operator', 'eq'),
                    'value': cf.get('value')
                }
        
        return merged
    
    @staticmethod
    def is_filter_compatible_with_chart(
        db: Session,
        chart_id: int,
        filter_field: str
    ) -> bool:
        """
        Check if a filter is compatible with a chart
        
        Args:
            db: Database session
            chart_id: Chart ID
            filter_field: Qualified field name
        
        Returns:
            True if compatible, False otherwise
        """
        try:
            # Get chart
            chart = db.query(Chart).filter(Chart.id == chart_id).first()
            if not chart:
                return False

            config = with_chart_semantic_binding(
                db,
                chart.dataset_table_id,
                chart.config if isinstance(chart.config, dict) else {},
                auto_generate=True,
            )
            binding = config.get("semanticBinding") if isinstance(config.get("semanticBinding"), dict) else {}
            if not filter_field:
                return False

            if "." not in filter_field:
                role_config = get_chart_active_role_config(config)
                chart_fields = {
                    value
                    for key, value in role_config.items()
                    if isinstance(value, str) and key not in {"chartType"}
                }
                for metric_key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
                    metric = role_config.get(metric_key)
                    if isinstance(metric, dict) and metric.get("field"):
                        chart_fields.add(metric.get("field"))
                chart_fields.update(
                    metric.get("field")
                    for metric in (role_config.get("metrics") or [])
                    if isinstance(metric, dict) and metric.get("field")
                )
                chart_fields.update(
                    column_name
                    for column_name in (role_config.get("selectedColumns") or [])
                    if isinstance(column_name, str) and column_name
                )
                return filter_field in chart_fields

            if filter_field in (binding.get("dimensionFields") or []):
                return True
            if filter_field in (binding.get("measureFields") or []):
                return True
            if filter_field in (binding.get("fieldMap") or {}).values():
                return True

            explore_name = binding.get("exploreName")
            if isinstance(explore_name, str) and explore_name:
                return FilterUtils.field_exists_in_explore(db, explore_name, filter_field)

            return False

        except Exception:
            logger.warning("is_filter_compatible_with_chart failed for chart=%s filter_field=%s", chart_id, filter_field, exc_info=True)
            return False

    @staticmethod
    def convert_dashboard_filter_to_semantic(
        dashboard_filter: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Convert dashboard filter format to semantic query filter format
        
        Args:
            dashboard_filter: Dashboard filter dict with operator and value
        
        Returns:
            Semantic query filter dict
        """
        return {
            'operator': dashboard_filter.get('operator', 'eq'),
            'value': dashboard_filter.get('value')
        }
