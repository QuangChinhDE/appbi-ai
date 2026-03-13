"""Manual Table Data Source

Allows users to manually input table data.
"""
from typing import List, Dict, Any


class ManualTableConnector:
    """Connector for manual table data source"""
    
    def __init__(self, data: Dict[str, Any]):
        """
        Initialize manual table connector.
        
        Args:
            data: Dictionary containing 'columns' and 'rows'
        """
        self.data = data
        self.columns = data.get('columns', [])
        self.rows = data.get('rows', [])
    
    def test_connection(self) -> bool:
        """Manual tables don't need connection test"""
        return True
    
    def get_table_data(self) -> Dict[str, Any]:
        """
        Get the manually entered table data.
        
        Returns:
            Dictionary with columns and rows
        """
        return {
            'columns': self.columns,
            'rows': self.rows,
            'row_count': len(self.rows)
        }
    
    def update_data(self, columns: List[Dict[str, str]], rows: List[Dict[str, Any]]):
        """
        Update the manual table data.
        
        Args:
            columns: List of column definitions [{'name': str, 'type': str}, ...]
            rows: List of row data
        """
        self.columns = columns
        self.rows = rows
        self.data = {
            'columns': columns,
            'rows': rows
        }


def create_manual_table_connector(config: Dict[str, Any]) -> ManualTableConnector:
    """
    Create a manual table connector from config.
    
    Args:
        config: Configuration dict with table data
        
    Returns:
        ManualTableConnector instance
    """
    data = config.get('data', {'columns': [], 'rows': []})
    return ManualTableConnector(data)
