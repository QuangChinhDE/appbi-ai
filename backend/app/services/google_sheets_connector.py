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
                    # Read+write scope so workboard forms can append/update
                    # rows. Read-only mode used to be the default; widening
                    # is required for mini-app data entry.
                    scopes=["https://www.googleapis.com/auth/spreadsheets"],
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
    
    # ── Write operations ──────────────────────────────────────────────
    #
    # The Sheets API doesn't have row-level primary keys, so we treat the
    # first row as headers + use it to translate caller-supplied
    # ``{column: value}`` payloads into A1 ranges. Updates and deletes
    # find the target row by scanning for a matching primary-key value
    # in the relevant column. This is intentionally simple — workboards
    # typically operate on sheets with hundreds of rows, not millions.

    def _read_headers_and_rows(
        self,
        spreadsheet_id: str,
        sheet_name: str,
    ) -> tuple[list[str], list[list[Any]]]:
        result = (
            self.service.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=f"{sheet_name}!A:ZZ")
            .execute()
        )
        values = result.get("values", []) or []
        if not values:
            return [], []
        headers = list(values[0])
        rows = values[1:] if len(values) > 1 else []
        # Pad short rows so caller can index by header position safely.
        rows = [row + [""] * (len(headers) - len(row)) for row in rows]
        return headers, rows

    def append_row(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        values_by_col: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Append a single row using the sheet's header row to align values.

        Returns the appended row as a dict (columns → values) so the
        workboard write service can echo it back to the caller.
        """
        headers, _ = self._read_headers_and_rows(spreadsheet_id, sheet_name)
        if not headers:
            raise ValueError(
                f"Sheet '{sheet_name}' has no header row — cannot append."
            )
        row_values: list[Any] = []
        for h in headers:
            v = values_by_col.get(h)
            row_values.append("" if v is None else v)

        body = {"values": [row_values]}
        try:
            self.service.spreadsheets().values().append(
                spreadsheetId=spreadsheet_id,
                range=f"{sheet_name}!A:ZZ",
                valueInputOption="USER_ENTERED",
                insertDataOption="INSERT_ROWS",
                body=body,
            ).execute()
        except HttpError as e:
            raise ValueError(f"Google Sheets append error: {str(e)}")
        return {h: row_values[i] for i, h in enumerate(headers)}

    def _find_row_index(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        pk: Dict[str, Any],
    ) -> tuple[list[str], int, list[Any]]:
        """Locate a row by its composite primary key.

        Returns ``(headers, row_index_in_data, row_values)`` where
        ``row_index_in_data`` is the offset inside the data block (0-based,
        excludes the header). Caller adds +2 to get the spreadsheet row
        number (1-based, header occupies row 1).

        Raises ValueError when no row matches or when a PK column is not
        present in the sheet's headers.
        """
        headers, rows = self._read_headers_and_rows(spreadsheet_id, sheet_name)
        if not headers:
            raise ValueError(f"Sheet '{sheet_name}' has no header row.")
        for col in pk.keys():
            if col not in headers:
                raise ValueError(
                    f"PK column '{col}' is not present in sheet '{sheet_name}'."
                )
        idx_by_col = {h: i for i, h in enumerate(headers)}
        for r_idx, row in enumerate(rows):
            if all(
                str(row[idx_by_col[col]]) == str(val)
                for col, val in pk.items()
            ):
                return headers, r_idx, row
        raise ValueError(f"No row in '{sheet_name}' matches primary key {pk}.")

    def update_row_by_pk(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        pk: Dict[str, Any],
        values_by_col: Dict[str, Any],
    ) -> Dict[str, Any]:
        headers, r_idx, current = self._find_row_index(
            spreadsheet_id, sheet_name, pk
        )
        # Merge: keep existing values for cols not in payload.
        new_row = list(current)
        for col, v in values_by_col.items():
            if col not in headers:
                continue
            new_row[headers.index(col)] = "" if v is None else v
        # Sheet rows are 1-based; header is row 1.
        spreadsheet_row = r_idx + 2
        try:
            self.service.spreadsheets().values().update(
                spreadsheetId=spreadsheet_id,
                range=f"{sheet_name}!A{spreadsheet_row}:ZZ{spreadsheet_row}",
                valueInputOption="USER_ENTERED",
                body={"values": [new_row]},
            ).execute()
        except HttpError as e:
            raise ValueError(f"Google Sheets update error: {str(e)}")
        return {h: new_row[i] for i, h in enumerate(headers)}

    def delete_row_by_pk(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        pk: Dict[str, Any],
    ) -> int:
        """Delete the row matching ``pk``; returns the spreadsheet row number deleted."""
        # Look up the sheet ID (numeric, separate from sheet_name) — the
        # batchUpdate API uses sheetId for row deletion.
        spreadsheet = (
            self.service.spreadsheets()
            .get(spreadsheetId=spreadsheet_id)
            .execute()
        )
        sheet_id = None
        for s in spreadsheet.get("sheets", []):
            if s.get("properties", {}).get("title") == sheet_name:
                sheet_id = s["properties"]["sheetId"]
                break
        if sheet_id is None:
            raise ValueError(f"Sheet '{sheet_name}' not found in spreadsheet.")

        _, r_idx, _ = self._find_row_index(spreadsheet_id, sheet_name, pk)
        spreadsheet_row = r_idx + 2  # 1-based, +1 for header
        try:
            self.service.spreadsheets().batchUpdate(
                spreadsheetId=spreadsheet_id,
                body={
                    "requests": [
                        {
                            "deleteDimension": {
                                "range": {
                                    "sheetId": sheet_id,
                                    "dimension": "ROWS",
                                    # 0-based, end exclusive.
                                    "startIndex": spreadsheet_row - 1,
                                    "endIndex": spreadsheet_row,
                                }
                            }
                        }
                    ]
                },
            ).execute()
        except HttpError as e:
            raise ValueError(f"Google Sheets delete error: {str(e)}")
        return spreadsheet_row

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
