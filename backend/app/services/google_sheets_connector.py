"""Google Sheets data source connector."""
from typing import List, Dict, Any, Optional, Tuple
import json
import os
import random
import threading
import time
import uuid as _uuid
import httplib2
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# ---------------------------------------------------------------------------
# Per-spreadsheet write mutex
# ---------------------------------------------------------------------------
# GSheets has no native row-level locking. All mutating operations
# (append / update / delete) are read-modify-write sequences. Without a
# mutex two concurrent requests can read the same snapshot and clobber each
# other. A threading.Lock per spreadsheet_id serialises writes within the
# same process instance, which covers the typical single-worker deployment.
# For multi-worker setups (multiple Gunicorn processes) the Sheets API
# itself serialises at the spreadsheet level — the last write wins, but the
# optimistic-lock check below will raise a 409 to the loser so the client
# can retry with fresh data.

_WRITE_LOCK_REGISTRY: Dict[str, threading.Lock] = {}
_WRITE_LOCK_REGISTRY_LOCK = threading.Lock()
_HEADER_CACHE: Dict[Tuple[str, str], Tuple[float, List[str]]] = {}
_HEADER_CACHE_LOCK = threading.Lock()
_HEADER_CACHE_TTL_SECONDS = 300.0


def _get_write_lock(spreadsheet_id: str) -> threading.Lock:
    """Return (or create) a per-spreadsheet write mutex."""
    with _WRITE_LOCK_REGISTRY_LOCK:
        if spreadsheet_id not in _WRITE_LOCK_REGISTRY:
            _WRITE_LOCK_REGISTRY[spreadsheet_id] = threading.Lock()
        return _WRITE_LOCK_REGISTRY[spreadsheet_id]


def _invalidate_workbook_cache(spreadsheet_id: str) -> None:
    """Drop the cached whole-workbook read after a mutation so the next read
    reflects the change. Lazy import keeps the connector importable even if the
    cache module is unavailable."""
    try:
        from app.services import google_sheets_cache
        google_sheets_cache.invalidate(spreadsheet_id)
    except Exception:  # pragma: no cover - cache is best-effort
        pass


def _invalidate_header_cache(spreadsheet_id: str, sheet_name: Optional[str] = None) -> None:
    with _HEADER_CACHE_LOCK:
        if sheet_name is None:
            for key in list(_HEADER_CACHE.keys()):
                if key[0] == spreadsheet_id:
                    _HEADER_CACHE.pop(key, None)
        else:
            _HEADER_CACHE.pop((spreadsheet_id, sheet_name), None)


def _is_retryable_sheets_error(exc: HttpError) -> bool:
    status = getattr(getattr(exc, "resp", None), "status", None)
    if status in (429, 500, 502, 503, 504):
        return True
    if status == 403:
        content = getattr(exc, "content", b"")
        if isinstance(content, bytes):
            text = content.decode("utf-8", errors="ignore").lower()
        else:
            text = str(content).lower()
        return "ratelimit" in text or "quota" in text or "user_rate_limit" in text
    return False


def _retry_after_seconds(exc: HttpError) -> Optional[float]:
    resp = getattr(exc, "resp", None)
    try:
        raw = resp.get("retry-after") if resp is not None else None
        return float(raw) if raw is not None else None
    except Exception:
        return None


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
            # cache_discovery=False skips the on-disk discovery-doc cache (a
            # file-lock + warning under concurrency) — the doc is tiny and the
            # client is reused, so it's pure overhead here.
            self.service = build('sheets', 'v4', credentials=self.credentials, cache_discovery=False)
        except Exception as e:
            raise ValueError(f"Failed to initialize Google Sheets connector: {str(e)}")

    def _execute(self, request: Any, operation: str) -> Any:
        """Execute a Google Sheets request with bounded retry/backoff.

        Sheets quotas are per-user/per-project and can spike during bulk
        workboard operations. Retrying only retryable responses keeps normal
        validation errors fast while making transient quota bursts survivable.
        """
        attempts = max(1, int(os.getenv("GOOGLE_SHEETS_RETRY_ATTEMPTS", "5")))
        base_delay = max(0.1, float(os.getenv("GOOGLE_SHEETS_RETRY_BASE_SECONDS", "0.75")))
        max_delay = max(base_delay, float(os.getenv("GOOGLE_SHEETS_RETRY_MAX_SECONDS", "8")))
        for attempt in range(attempts):
            try:
                return request.execute()
            except HttpError as exc:
                if attempt >= attempts - 1 or not _is_retryable_sheets_error(exc):
                    raise
                delay = _retry_after_seconds(exc)
                if delay is None:
                    delay = min(max_delay, base_delay * (2 ** attempt))
                    delay += random.uniform(0, min(0.5, delay / 2))
                time.sleep(delay)
            except (OSError, httplib2.HttpLib2Error):
                # Transient network / TLS / timeout — the Sheets API occasionally
                # stalls and the socket read times out. Previously these escaped
                # the HttpError-only retry above and failed the user's save
                # outright ("TimeoutError: The read operation timed out"). Retry
                # with the same backoff so a slow moment is survivable.
                # TimeoutError / ConnectionError / BrokenPipeError / ssl.SSLError
                # are all OSError subclasses; ServerNotFoundError is HttpLib2Error.
                if attempt >= attempts - 1:
                    raise
                delay = min(max_delay, base_delay * (2 ** attempt))
                delay += random.uniform(0, min(0.5, delay / 2))
                time.sleep(delay)
        raise RuntimeError(f"Google Sheets request failed after retry: {operation}")
    
    def test_connection(self, spreadsheet_id: str) -> bool:
        """Test if connection to Google Sheets API is working by fetching spreadsheet metadata."""
        try:
            self._execute(
                self.service.spreadsheets().get(
                    spreadsheetId=spreadsheet_id,
                    fields='properties.title',
                ),
                "test_connection",
            )
            return True
        except Exception:
            return False
    
    def get_sheet_data(
        self,
        spreadsheet_id: str,
        range_name: str = 'A:ZZ',
        sheet_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get data from a Google Sheet.

        Args:
            spreadsheet_id: The ID of the spreadsheet
            range_name: The A1 notation range (default: 'A:ZZ' — up to 702
                columns, matching the write path. The previous 'A:Z' cap
                silently dropped every column past the 26th on read, so a
                Sheet-backed table wider than 26 columns lost its tail
                columns — while writes still touched them via 'A:ZZ'.)
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
            result = self._execute(
                self.service.spreadsheets().values().get(
                    spreadsheetId=spreadsheet_id,
                    range=full_range
                ),
                "get_sheet_data",
            )
            
            return self._parse_values(result.get('values', []))

        except HttpError as e:
            raise ValueError(f"Google Sheets API error: {str(e)}")
        except Exception as e:
            raise ValueError(f"Failed to get sheet data: {str(e)}")

    @staticmethod
    def _parse_values(values: list) -> Dict[str, Any]:
        """Turn a raw Sheets ``values`` matrix into {columns, rows, row_count}.
        Shared by get_sheet_data AND the batchGet path so both produce
        BYTE-IDENTICAL output (headers = row 0, short rows padded, every column
        typed 'string')."""
        if not values:
            return {'columns': [], 'rows': [], 'row_count': 0}
        headers = values[0] if values else []
        data_rows = values[1:] if len(values) > 1 else []
        rows = []
        for row in data_rows:
            padded_row = row + [''] * (len(headers) - len(row))
            rows.append({headers[i]: padded_row[i] for i in range(len(headers))})
        columns = [{'name': header, 'type': 'string'} for header in headers]
        return {'columns': columns, 'rows': rows, 'row_count': len(rows)}

    def get_sheets_data_batch(
        self,
        spreadsheet_id: str,
        sheet_names: List[str],
        range_name: str = 'A:ZZ',
    ) -> Dict[str, Dict[str, Any]]:
        """Fetch MANY tabs in ONE ``values.batchGet`` call → {sheet_name: {columns,
        rows, row_count}}. Replaces N sequential ``get_sheet_data`` calls: cuts a
        cold whole-workbook read from (list_sheets + N gets) to (list_sheets +
        1 batchGet) — the fix for the 60-reads/min Sheets quota AND the per-tab
        latency. Uses the SAME ``A:Z`` range + ``_parse_values`` as get_sheet_data
        so the cached workbook is byte-identical. Falls back to per-tab on any
        shape mismatch so a tab is never silently dropped."""
        if not sheet_names:
            return {}
        ranges = [f"{sn}!{range_name}" for sn in sheet_names]
        result = self._execute(
            self.service.spreadsheets().values().batchGet(
                spreadsheetId=spreadsheet_id, ranges=ranges,
            ),
            "get_sheets_data_batch",
        )
        value_ranges = result.get('valueRanges', []) or []
        out: Dict[str, Dict[str, Any]] = {}
        if len(value_ranges) == len(sheet_names):
            # batchGet preserves request order → zip is safe.
            for sn, vr in zip(sheet_names, value_ranges):
                out[sn] = self._parse_values(vr.get('values', []))
        else:
            # Unexpected shape → per-tab fallback (correctness over the batch win).
            logger.warning(
                "batchGet returned %d ranges for %d sheets (ss=%s) — per-tab fallback",
                len(value_ranges), len(sheet_names), spreadsheet_id,
            )
            for sn in sheet_names:
                out[sn] = self.get_sheet_data(spreadsheet_id, sheet_name=sn)
        return out
    
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
        result = self._execute(
            self.service.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=f"{sheet_name}!A:ZZ"),
            f"read {sheet_name}",
        )
        values = result.get("values", []) or []
        if not values:
            return [], []
        headers = list(values[0])
        with _HEADER_CACHE_LOCK:
            _HEADER_CACHE[(spreadsheet_id, sheet_name)] = (time.time(), headers)
        rows = values[1:] if len(values) > 1 else []
        # Pad short rows so caller can index by header position safely.
        rows = [row + [""] * (len(headers) - len(row)) for row in rows]
        return headers, rows

    def _read_headers(
        self,
        spreadsheet_id: str,
        sheet_name: str,
    ) -> list[str]:
        key = (spreadsheet_id, sheet_name)
        now = time.time()
        with _HEADER_CACHE_LOCK:
            cached = _HEADER_CACHE.get(key)
            if cached and now - cached[0] < _HEADER_CACHE_TTL_SECONDS:
                return list(cached[1])
        result = self._execute(
            self.service.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=f"{sheet_name}!1:1"),
            f"read headers {sheet_name}",
        )
        values = result.get("values", []) or []
        headers = list(values[0]) if values else []
        with _HEADER_CACHE_LOCK:
            _HEADER_CACHE[key] = (time.time(), headers)
        return headers

    def append_row(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        values_by_col: Dict[str, Any],
        auto_pk_columns: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Append a single row using the sheet's header row to align values.

        If ``auto_pk_columns`` is provided and any of those columns are
        absent or empty in ``values_by_col``, a UUID is generated and
        inserted automatically so the row always has a stable primary key.

        The entire read-then-write is protected by a per-spreadsheet mutex
        to serialise concurrent inserts within the same process.

        Returns the appended row as a dict (columns → values).
        """
        with _get_write_lock(spreadsheet_id):
            headers = self._read_headers(spreadsheet_id, sheet_name)
            if not headers:
                raise ValueError(
                    f"Sheet '{sheet_name}' has no header row — cannot append."
                )

            # Auto-fill PK columns with a UUID if caller didn't provide them.
            filled = dict(values_by_col)
            for pk_col in (auto_pk_columns or []):
                if pk_col in headers and not str(filled.get(pk_col, "")).strip():
                    filled[pk_col] = str(_uuid.uuid4())

            row_values: list[Any] = []
            for h in headers:
                v = filled.get(h)
                row_values.append("" if v is None else v)

            body = {"values": [row_values]}
            try:
                self._execute(
                    self.service.spreadsheets().values().append(
                        spreadsheetId=spreadsheet_id,
                        range=f"{sheet_name}!A:ZZ",
                        valueInputOption="USER_ENTERED",
                        insertDataOption="INSERT_ROWS",
                        body=body,
                    ),
                    f"append {sheet_name}",
                )
            except HttpError as e:
                raise ValueError(f"Google Sheets append error: {str(e)}")
            _invalidate_workbook_cache(spreadsheet_id)
            return {h: row_values[i] for i, h in enumerate(headers)}

    def append_rows(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        rows_values: List[Dict[str, Any]],
        auto_pk_columns: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Append multiple rows in a single API call.

        Reads headers once, converts all dicts to ordered row arrays, then
        writes them in one ``values().append`` call.  Returns the list of
        appended rows as dicts.
        """
        if not rows_values:
            return {"appended": 0, "rows": []}
        with _get_write_lock(spreadsheet_id):
            headers = self._read_headers(spreadsheet_id, sheet_name)
            if not headers:
                raise ValueError(
                    f"Sheet '{sheet_name}' has no header row — cannot append."
                )

            all_row_arrays: list[list[Any]] = []
            result_rows: list[dict] = []
            for values_by_col in rows_values:
                filled = dict(values_by_col)
                for pk_col in (auto_pk_columns or []):
                    if pk_col in headers and not str(filled.get(pk_col, "")).strip():
                        filled[pk_col] = str(_uuid.uuid4())
                row_values = ["" if filled.get(h) is None else filled.get(h) for h in headers]
                all_row_arrays.append(row_values)
                result_rows.append({h: row_values[i] for i, h in enumerate(headers)})

            body = {"values": all_row_arrays}
            try:
                self._execute(
                    self.service.spreadsheets().values().append(
                        spreadsheetId=spreadsheet_id,
                        range=f"{sheet_name}!A:ZZ",
                        valueInputOption="USER_ENTERED",
                        insertDataOption="INSERT_ROWS",
                        body=body,
                    ),
                    f"batch append {sheet_name}",
                )
            except HttpError as e:
                raise ValueError(f"Google Sheets batch append error: {str(e)}")
            _invalidate_workbook_cache(spreadsheet_id)
            return {"appended": len(result_rows), "rows": result_rows}

    def import_csv(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        csv_data: str,
    ) -> Dict[str, Any]:
        """Replace the content of a sheet tab with parsed CSV data.

        The first CSV row is treated as the header row. Existing data in the
        tab is overwritten from row 1 onward.
        """
        import csv
        import io
        reader = csv.reader(io.StringIO(csv_data.strip()))
        all_rows = list(reader)
        if not all_rows:
            raise ValueError("CSV data is empty.")
        body = {"values": all_rows}
        try:
            self._execute(
                self.service.spreadsheets().values().update(
                    spreadsheetId=spreadsheet_id,
                    range=f"{sheet_name}!A1",
                    valueInputOption="USER_ENTERED",
                    body=body,
                ),
                f"import csv {sheet_name}",
            )
        except HttpError as e:
            raise ValueError(f"Google Sheets CSV import error: {str(e)}")
        _invalidate_workbook_cache(spreadsheet_id)
        _invalidate_header_cache(spreadsheet_id, sheet_name)
        return {
            "sheet_name": sheet_name,
            "header_row": all_rows[0] if all_rows else [],
            "data_rows_written": max(0, len(all_rows) - 1),
        }

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

        Raises ValueError when no row matches, when MORE THAN ONE row matches
        (the PK is not unique in the sheet — refuse rather than touch an
        arbitrary first match), or when a PK column is not present in the
        sheet's headers.
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
        matches = [
            (r_idx, row)
            for r_idx, row in enumerate(rows)
            if all(
                str(row[idx_by_col[col]]) == str(val)
                for col, val in pk.items()
            )
        ]
        if not matches:
            raise ValueError(f"No row in '{sheet_name}' matches primary key {pk}.")
        if len(matches) > 1:
            # Sheets enforces no uniqueness; updating/deleting the first match
            # would silently corrupt a different record. Fail loud instead.
            raise ValueError(
                f"Primary key {pk} matches {len(matches)} rows in '{sheet_name}'. "
                "Refusing to update/delete an ambiguous row — make the PK column unique."
            )
        r_idx, row = matches[0]
        return headers, r_idx, row

    def update_row_by_pk(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        pk: Dict[str, Any],
        values_by_col: Dict[str, Any],
        lock_column: Optional[str] = None,
        lock_token: Any = None,
    ) -> Dict[str, Any]:
        """Update a row by primary key with optional optimistic-lock check.

        If ``lock_column`` and ``lock_token`` are provided, the current
        value of that column is compared to ``lock_token`` before writing.
        A mismatch raises ``ValueError`` with code OPTIMISTIC_LOCK so the
        caller can surface a 409 to the end user.

        The entire read-modify-write is protected by a per-spreadsheet
        mutex to prevent concurrent requests from clobbering each other
        within the same process.
        """
        with _get_write_lock(spreadsheet_id):
            return self._update_row_by_pk_locked(
                spreadsheet_id, sheet_name, pk, values_by_col,
                lock_column=lock_column, lock_token=lock_token,
            )

    def _update_row_by_pk_locked(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        pk: Dict[str, Any],
        values_by_col: Dict[str, Any],
        lock_column: Optional[str] = None,
        lock_token: Any = None,
    ) -> Dict[str, Any]:
        headers, r_idx, current = self._find_row_index(
            spreadsheet_id, sheet_name, pk
        )
        # Optimistic-lock check: compare stored value against client token.
        if lock_column and lock_token is not None:
            idx_by_col = {h: i for i, h in enumerate(headers)}
            if lock_column in idx_by_col:
                stored = str(current[idx_by_col[lock_column]])
                if stored != str(lock_token):
                    raise ValueError(
                        f"OPTIMISTIC_LOCK: row was modified since you last read it "
                        f"(expected {lock_token!r}, found {stored!r}). "
                        "Reload the form and try again."
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
            self._execute(
                self.service.spreadsheets().values().update(
                    spreadsheetId=spreadsheet_id,
                    range=f"{sheet_name}!A{spreadsheet_row}:ZZ{spreadsheet_row}",
                    valueInputOption="USER_ENTERED",
                    body={"values": [new_row]},
                ),
                f"update {sheet_name}",
            )
        except HttpError as e:
            raise ValueError(f"Google Sheets update error: {str(e)}")
        _invalidate_workbook_cache(spreadsheet_id)
        return {h: new_row[i] for i, h in enumerate(headers)}

    def update_rows_by_pk(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        updates: List[Dict[str, Any]],
        lock_column: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Update multiple rows by PK after one sheet scan and one batchUpdate."""
        if not updates:
            return {"updated": 0, "rows": []}
        with _get_write_lock(spreadsheet_id):
            headers, rows = self._read_headers_and_rows(spreadsheet_id, sheet_name)
            if not headers:
                raise ValueError(f"Sheet '{sheet_name}' has no header row.")
            idx_by_col = {h: i for i, h in enumerate(headers)}
            data: List[Dict[str, Any]] = []
            returned_rows: List[Dict[str, Any]] = []
            used_row_indexes: set[int] = set()

            for item in updates:
                pk = item.get("pk") if isinstance(item, dict) else None
                values_by_col = item.get("values") if isinstance(item, dict) else None
                lock_token = item.get("lock_token") if isinstance(item, dict) else None
                if not isinstance(pk, dict) or not isinstance(values_by_col, dict):
                    raise ValueError("Each update must include pk and values dictionaries.")
                for col in pk.keys():
                    if col not in idx_by_col:
                        raise ValueError(
                            f"PK column '{col}' is not present in sheet '{sheet_name}'."
                        )
                matches = [
                    (r_idx, row)
                    for r_idx, row in enumerate(rows)
                    if r_idx not in used_row_indexes
                    and all(str(row[idx_by_col[col]]) == str(val) for col, val in pk.items())
                ]
                if not matches:
                    raise ValueError(f"No row in '{sheet_name}' matches primary key {pk}.")
                if len(matches) > 1:
                    raise ValueError(
                        f"Primary key {pk} matches {len(matches)} rows in '{sheet_name}'. "
                        "Refusing to update an ambiguous row."
                    )
                r_idx, current = matches[0]
                used_row_indexes.add(r_idx)
                if lock_column and lock_token is not None and lock_column in idx_by_col:
                    stored = str(current[idx_by_col[lock_column]])
                    if stored != str(lock_token):
                        raise ValueError(
                            f"OPTIMISTIC_LOCK: row was modified since you last read it "
                            f"(expected {lock_token!r}, found {stored!r}). "
                            "Reload the form and try again."
                        )
                new_row = list(current)
                for col, value in values_by_col.items():
                    if col in idx_by_col:
                        new_row[idx_by_col[col]] = "" if value is None else value
                spreadsheet_row = r_idx + 2
                data.append({
                    "range": f"{sheet_name}!A{spreadsheet_row}:ZZ{spreadsheet_row}",
                    "values": [new_row],
                })
                returned_rows.append({h: new_row[i] for i, h in enumerate(headers)})

            try:
                self._execute(
                    self.service.spreadsheets().values().batchUpdate(
                        spreadsheetId=spreadsheet_id,
                        body={"valueInputOption": "USER_ENTERED", "data": data},
                    ),
                    f"batch update {sheet_name}",
                )
            except HttpError as e:
                raise ValueError(f"Google Sheets batch update error: {str(e)}")
            _invalidate_workbook_cache(spreadsheet_id)
            return {"updated": len(returned_rows), "rows": returned_rows}

    def delete_row_by_pk(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        pk: Dict[str, Any],
        lock_column: Optional[str] = None,
        lock_token: Any = None,
    ) -> int:
        """Delete the row matching ``pk``; returns the spreadsheet row number deleted.

        Accepts the same ``lock_column``/``lock_token`` optimistic-lock
        parameters as ``update_row_by_pk``. Protected by the same
        per-spreadsheet mutex.
        """
        with _get_write_lock(spreadsheet_id):
            return self._delete_row_by_pk_locked(
                spreadsheet_id, sheet_name, pk,
                lock_column=lock_column, lock_token=lock_token,
            )

    def _delete_row_by_pk_locked(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        pk: Dict[str, Any],
        lock_column: Optional[str] = None,
        lock_token: Any = None,
    ) -> int:
        # Look up the sheet ID (numeric, separate from sheet_name) — the
        # batchUpdate API uses sheetId for row deletion.
        spreadsheet = self._execute(
            self.service.spreadsheets()
            .get(spreadsheetId=spreadsheet_id),
            f"metadata {sheet_name}",
        )
        sheet_id = None
        for s in spreadsheet.get("sheets", []):
            if s.get("properties", {}).get("title") == sheet_name:
                sheet_id = s["properties"]["sheetId"]
                break
        if sheet_id is None:
            raise ValueError(f"Sheet '{sheet_name}' not found in spreadsheet.")

        headers, r_idx, current = self._find_row_index(spreadsheet_id, sheet_name, pk)

        # Optimistic-lock check.
        if lock_column and lock_token is not None:
            idx_by_col = {h: i for i, h in enumerate(headers)}
            if lock_column in idx_by_col:
                stored = str(current[idx_by_col[lock_column]])
                if stored != str(lock_token):
                    raise ValueError(
                        f"OPTIMISTIC_LOCK: row was modified since you last read it "
                        f"(expected {lock_token!r}, found {stored!r}). "
                        "Reload the form and try again."
                    )

        spreadsheet_row = r_idx + 2  # 1-based, +1 for header
        try:
            self._execute(
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
                ),
                f"delete {sheet_name}",
            )
        except HttpError as e:
            raise ValueError(f"Google Sheets delete error: {str(e)}")
        _invalidate_workbook_cache(spreadsheet_id)
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
            spreadsheet = self._execute(
                self.service.spreadsheets().get(
                    spreadsheetId=spreadsheet_id
                ),
                "list sheets",
            )
            
            sheets = spreadsheet.get('sheets', [])
            return [sheet['properties']['title'] for sheet in sheets]
            
        except HttpError as e:
            raise ValueError(f"Google Sheets API error: {str(e)}")
        except Exception as e:
            raise ValueError(f"Failed to list sheets: {str(e)}")

    def create_spreadsheet(
        self,
        title: str,
        tab_names: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Create a NEW Google Spreadsheet owned by THIS credential — the
        app-owned OLTP store behind a Workboard (Destination = Google Sheets,
        managed). Optionally seed initial tabs. Returns
        ``{spreadsheet_id, spreadsheet_url, tabs}``.

        NB: a service-account credential creates a spreadsheet owned by the SA
        (not in a human's Drive); that is intended for an app-managed store. To
        let a person open it, share it separately (needs Drive scope) or use an
        OAuth credential. Only the ``spreadsheets`` scope is required to create."""
        body: Dict[str, Any] = {"properties": {"title": title}}
        if tab_names:
            body["sheets"] = [{"properties": {"title": t}} for t in tab_names if str(t or "").strip()]
        try:
            result = self._execute(
                self.service.spreadsheets().create(
                    body=body,
                    fields="spreadsheetId,spreadsheetUrl,sheets.properties.title",
                ),
                f"create spreadsheet {title}",
            )
        except HttpError as e:
            raise ValueError(f"Google Sheets create spreadsheet error: {str(e)}")
        return {
            "spreadsheet_id": result.get("spreadsheetId"),
            "spreadsheet_url": result.get("spreadsheetUrl"),
            "tabs": [
                s.get("properties", {}).get("title")
                for s in (result.get("sheets") or [])
            ],
        }

    def create_sheet(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        headers: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Create a new sheet tab in an existing spreadsheet.

        Optionally writes a header row as the first row so the sheet is
        immediately usable for workboard forms.

        Args:
            spreadsheet_id: The spreadsheet to add the tab to.
            sheet_name: Title for the new tab.
            headers: Optional list of column header names to write in row 1.

        Returns:
            Dict with sheet_name, sheet_id (numeric), and headers written.
        """
        # Check the sheet doesn't already exist
        existing = self.list_sheets(spreadsheet_id)
        if sheet_name in existing:
            raise ValueError(
                f"Sheet '{sheet_name}' already exists in the spreadsheet."
            )

        try:
            result = self._execute(
                self.service.spreadsheets().batchUpdate(
                    spreadsheetId=spreadsheet_id,
                    body={
                        "requests": [
                            {
                                "addSheet": {
                                    "properties": {"title": sheet_name}
                                }
                            }
                        ]
                    },
                ),
                f"create sheet {sheet_name}",
            )
        except HttpError as e:
            raise ValueError(f"Google Sheets create sheet error: {str(e)}")

        sheet_id = (
            result.get("replies", [{}])[0]
            .get("addSheet", {})
            .get("properties", {})
            .get("sheetId")
        )

        # Write header row if provided
        if headers:
            try:
                self._execute(
                    self.service.spreadsheets().values().update(
                        spreadsheetId=spreadsheet_id,
                        range=f"{sheet_name}!A1",
                        valueInputOption="RAW",
                        body={"values": [headers]},
                    ),
                    f"write headers {sheet_name}",
                )
            except HttpError as e:
                raise ValueError(
                    f"Sheet created but failed to write headers: {str(e)}"
                )
            with _HEADER_CACHE_LOCK:
                _HEADER_CACHE[(spreadsheet_id, sheet_name)] = (time.time(), list(headers))

        return {
            "sheet_name": sheet_name,
            "sheet_id": sheet_id,
            "headers": headers or [],
        }

    def write_header_row(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        headers: List[str],
    ) -> Dict[str, Any]:
        """Write (overwrite) the header row (row 1) of an EXISTING tab.

        Used to lay out the schema of tabs seeded by ``create_spreadsheet`` when
        provisioning an operational (Workboard) dataset's OLTP store. Refreshes
        the header cache so subsequent reads see the columns immediately."""
        if not headers:
            raise ValueError("headers must be a non-empty list")
        try:
            self._execute(
                self.service.spreadsheets().values().update(
                    spreadsheetId=spreadsheet_id,
                    range=f"{sheet_name}!A1",
                    valueInputOption="RAW",
                    body={"values": [list(headers)]},
                ),
                f"write headers {sheet_name}",
            )
        except HttpError as e:
            raise ValueError(f"Google Sheets write header error: {str(e)}")
        with _HEADER_CACHE_LOCK:
            _HEADER_CACHE[(spreadsheet_id, sheet_name)] = (time.time(), list(headers))
        return {"sheet_name": sheet_name, "headers": list(headers)}

    def get_header_row(self, spreadsheet_id: str, sheet_name: str) -> List[str]:
        """Public read of a tab's header row (row 1). Used when BINDING an
        existing spreadsheet as an operational Destination to discover columns."""
        return self._read_headers(spreadsheet_id, sheet_name)

    def rename_column(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        old_name: str,
        new_name: str,
    ) -> Dict[str, Any]:
        """Rename a single column header in row 1 of a sheet tab."""
        with _get_write_lock(spreadsheet_id):
            headers, _ = self._read_headers_and_rows(spreadsheet_id, sheet_name)
            if not headers:
                raise ValueError(f"Sheet '{sheet_name}' has no header row.")
            if old_name not in headers:
                raise ValueError(
                    f"Column '{old_name}' not found in sheet '{sheet_name}'. "
                    f"Available columns: {headers}"
                )
            if new_name in headers and new_name != old_name:
                raise ValueError(
                    f"Column '{new_name}' already exists in sheet '{sheet_name}'."
                )
            col_index = headers.index(old_name)
            col_letter = _col_index_to_letter(col_index)
            cell_range = f"{sheet_name}!{col_letter}1"
            try:
                self._execute(
                    self.service.spreadsheets().values().update(
                        spreadsheetId=spreadsheet_id,
                        range=cell_range,
                        valueInputOption="RAW",
                        body={"values": [[new_name]]},
                    ),
                    f"rename column {sheet_name}",
                )
            except HttpError as e:
                raise ValueError(f"Google Sheets rename column error: {str(e)}")
            _invalidate_header_cache(spreadsheet_id, sheet_name)
            return {
                "old_name": old_name,
                "new_name": new_name,
                "col_index": col_index,
                "sheet_name": sheet_name,
            }

    def rename_tab(
        self,
        spreadsheet_id: str,
        sheet_name: str,
        new_sheet_name: str,
    ) -> Dict[str, Any]:
        """Rename a sheet tab using batchUpdate → updateSheetProperties."""
        try:
            spreadsheet = self._execute(
                self.service.spreadsheets().get(
                    spreadsheetId=spreadsheet_id
                ),
                f"metadata {sheet_name}",
            )
            sheet_id: Optional[int] = None
            for sheet in spreadsheet.get("sheets", []):
                if sheet["properties"]["title"] == sheet_name:
                    sheet_id = sheet["properties"]["sheetId"]
                    break
            if sheet_id is None:
                raise ValueError(f"Sheet '{sheet_name}' not found in spreadsheet.")
            existing_titles = [s["properties"]["title"] for s in spreadsheet.get("sheets", [])]
            if new_sheet_name in existing_titles and new_sheet_name != sheet_name:
                raise ValueError(
                    f"A sheet named '{new_sheet_name}' already exists in the spreadsheet."
                )
            self._execute(
                self.service.spreadsheets().batchUpdate(
                    spreadsheetId=spreadsheet_id,
                    body={
                        "requests": [
                            {
                                "updateSheetProperties": {
                                    "properties": {
                                        "sheetId": sheet_id,
                                        "title": new_sheet_name,
                                    },
                                    "fields": "title",
                                }
                            }
                        ]
                    },
                ),
                f"rename tab {sheet_name}",
            )
        except HttpError as e:
            raise ValueError(f"Google Sheets rename tab error: {str(e)}")
        _invalidate_header_cache(spreadsheet_id, sheet_name)
        return {"old_name": sheet_name, "new_name": new_sheet_name}

    def clear_data_rows(
        self,
        spreadsheet_id: str,
        sheet_name: str,
    ) -> Dict[str, Any]:
        """Clear all data rows (row 2+), keeping the header row in row 1."""
        with _get_write_lock(spreadsheet_id):
            try:
                self._execute(
                    self.service.spreadsheets().values().clear(
                        spreadsheetId=spreadsheet_id,
                        range=f"{sheet_name}!A2:ZZ",
                        body={},
                    ),
                    f"clear rows {sheet_name}",
                )
            except HttpError as e:
                raise ValueError(f"Google Sheets clear rows error: {str(e)}")
            return {"sheet_name": sheet_name, "cleared": True}


def _col_index_to_letter(index: int) -> str:
    """Convert 0-based column index to sheet column letter (A, B, ..., Z, AA, ...)."""
    letters = ""
    n = index + 1
    while n > 0:
        n, remainder = divmod(n - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def create_google_sheets_connector(config: Dict[str, Any]) -> GoogleSheetsConnector:
    """
    Create a Google Sheets connector from config.
    """
    from app.services.datasource_service import _build_gcp_credentials

    credentials = _build_gcp_credentials(config)
    return GoogleSheetsConnector(credentials)
