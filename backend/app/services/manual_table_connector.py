"""Manual Table Data Source

Allows users to import file data (CSV / Excel) as a data source.
Config format (new): { "sheets": { "SheetName": { "columns": [...], "rows": [...] } } }
Config format (legacy): { "columns": [...], "rows": [...] }
"""
from typing import List, Dict, Any
import re


class ManualTableConnector:
    """Connector for imported-file data source (CSV / Excel)"""

    def __init__(self, config: Dict[str, Any]):
        """
        Args:
            config: Top-level datasource config dict.
                    New format:    {"sheets": {"Sheet1": {"columns": [...], "rows": [...]}, ...}}
                    Legacy format: {"columns": [...], "rows": [...]}
        """
        self._config = config
        # Normalise to sheets dict for uniform access
        if 'sheets' in config and isinstance(config['sheets'], dict):
            self._sheets: Dict[str, Dict[str, Any]] = config['sheets']
        else:
            # Legacy flat format — wrap it
            self._sheets = {
                'manual_data': {
                    'columns': config.get('columns', []),
                    'rows':    config.get('rows', []),
                }
            }

    def test_connection(self) -> bool:
        return True

    def list_sheets(self) -> List[str]:
        """Return all available sheet / table names."""
        return list(self._sheets.keys())

    def get_sheet_data(self, sheet_name: str) -> Dict[str, Any]:
        """Return data for a specific sheet."""
        data = self._sheets.get(sheet_name)
        if data is None:
            # Fallback: case-insensitive match
            for k, v in self._sheets.items():
                if k.lower() == sheet_name.lower():
                    data = v
                    break
        if data is None:
            # Last resort: return first available sheet
            data = next(iter(self._sheets.values())) if self._sheets else {'columns': [], 'rows': []}
        return {'columns': data.get('columns', []), 'rows': data.get('rows', [])}

    def get_table_data(self) -> Dict[str, Any]:
        """Legacy helper — returns first sheet's data."""
        return self.get_sheet_data(list(self._sheets.keys())[0] if self._sheets else 'manual_data')


def create_manual_table_connector(config: Dict[str, Any]) -> ManualTableConnector:
    """
    Create a ManualTableConnector from a datasource config dict.

    New config:    {"sheets": {"Sheet1": {"columns": [...], "rows": [...]}, ...}}
    Legacy config: {"columns": [...], "rows": [...]}
    """
    return ManualTableConnector(config)


def extract_sheet_name_from_sql(sql: str) -> str:
    """
    Parse the table / sheet name from a SQL statement.
    Handles all common quoting styles and ignores trailing clauses:
      SELECT * FROM Sheet1
      SELECT * FROM manual.Sheet1
      SELECT * FROM "Sales Data"
      SELECT * FROM `Sheet1`
      SELECT * FROM "Sheet1" LIMIT 100
      SELECT * FROM "spreadsheet-id-with-hyphens"."Sheet1"

    The optional schema prefix uses "[^"]+" (any chars) instead of "\\w+"
    so spreadsheet IDs that contain hyphens (valid base64url) are consumed
    correctly and the table name is always captured in the groups.
    """
    match = re.search(
        r"""\bFROM\s+(?:(?:"[^"]+"|\w+)\.)?(?:`([^`]+)`|"([^"]+)"|'([^']+)'|(\w+))""",
        sql.strip(),
        re.IGNORECASE,
    )
    if match:
        return (match.group(1) or match.group(2) or match.group(3) or match.group(4) or '').strip()
    return 'manual_data'

