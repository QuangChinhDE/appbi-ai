"""Google Sheets data source connector."""
from typing import List, Dict, Any, Optional
import json
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError


class GoogleSheetsConnector:
    """Connector for Google Sheets data source"""
    
    def __init__(self, credentials_source: Any):
        """
        Initialize Google Sheets connector.
        
        Args:
            credentials_source: service-account JSON or user OAuth credentials
        """
        try:
            if isinstance(credentials_source, str) or isinstance(credentials_source, dict):
                # Private keys in PEM format contain real newlines. When the
                # credentials JSON string is stored inside another JSON field
                # and later retrieved, those newline characters can break the
                # parser. Re-escape them before parsing.
                if isinstance(credentials_source, dict):
                    credentials_dict = credentials_source
                else:
                    try:
                        credentials_dict = json.loads(credentials_source)
                    except json.JSONDecodeError:
                        fixed = (
                            credentials_source
                            .replace("\r\n", "\\n")
                            .replace("\r", "\\n")
                            .replace("\n", "\\n")
                        )
                        credentials_dict = json.loads(fixed)
                self.credentials = service_account.Credentials.from_service_account_info(
                    credentials_dict,
                    scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
                )
            else:
                self.credentials = credentials_source
            self.service = build('sheets', 'v4', credentials=self.credentials)
        except Exception as e:
            raise ValueError(f"Failed to initialize Google Sheets connector: {str(e)}")
    
    def test_connection(self, spreadsheet_id: str) -> bool:
        """Test if connection to Google Sheets API is working by fetching spreadsheet metadata."""
        try:
            self.service.spreadsheets().get(
                spreadsheetId=spreadsheet_id,
                fields='properties.title',
            ).execute()
            return True
        except Exception:
            return False
    
    def get_sheet_data(
        self,
        spreadsheet_id: str,
        range_name: str = 'A:Z',
        sheet_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get data from a Google Sheet.
        
        Args:
            spreadsheet_id: The ID of the spreadsheet
            range_name: The A1 notation range (default: 'A:Z')
            sheet_name: Optional sheet name (default: first sheet)
            
        Returns:
            Dictionary with columns and rows
        """
        try:
            # Build range with sheet name if provided
            if sheet_name:
                full_range = f"{sheet_name}!{range_name}"
            else:
                full_range = range_name
            
            # Get values from sheet
            result = self.service.spreadsheets().values().get(
                spreadsheetId=spreadsheet_id,
                range=full_range
            ).execute()
            
            values = result.get('values', [])
            
            if not values:
                return {
                    'columns': [],
                    'rows': [],
                    'row_count': 0
                }
            
            # First row as headers
            headers = values[0] if values else []
            data_rows = values[1:] if len(values) > 1 else []
            
            # Convert to list of dicts
            rows = []
            for row in data_rows:
                # Pad row if it's shorter than headers
                padded_row = row + [''] * (len(headers) - len(row))
                row_dict = {headers[i]: padded_row[i] for i in range(len(headers))}
                rows.append(row_dict)
            
            # Infer column types (simplified - all as string for now)
            columns = [
                {'name': header, 'type': 'string'}
                for header in headers
            ]
            
            return {
                'columns': columns,
                'rows': rows,
                'row_count': len(rows)
            }
            
        except HttpError as e:
            raise ValueError(f"Google Sheets API error: {str(e)}")
        except Exception as e:
            raise ValueError(f"Failed to get sheet data: {str(e)}")
    
    def list_sheets(self, spreadsheet_id: str) -> List[str]:
        """
        List all sheet names in a spreadsheet.
        
        Args:
            spreadsheet_id: The ID of the spreadsheet
            
        Returns:
            List of sheet names
        """
        try:
            spreadsheet = self.service.spreadsheets().get(
                spreadsheetId=spreadsheet_id
            ).execute()
            
            sheets = spreadsheet.get('sheets', [])
            return [sheet['properties']['title'] for sheet in sheets]
            
        except HttpError as e:
            raise ValueError(f"Google Sheets API error: {str(e)}")
        except Exception as e:
            raise ValueError(f"Failed to list sheets: {str(e)}")


def create_google_sheets_connector(config: Dict[str, Any]) -> GoogleSheetsConnector:
    """
    Create a Google Sheets connector from config.
    """
    from app.services.datasource_service import _build_gcp_credentials

    credentials = _build_gcp_credentials(config)
    return GoogleSheetsConnector(credentials)
