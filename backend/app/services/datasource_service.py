"""
Data source connection service.
Handles connecting to and querying external data sources.
"""
import base64
import hashlib
import os
import re
import time
from typing import Generator, Iterator, List, Dict, Any, Tuple, Optional
import pymysql
import psycopg2
from google.cloud import bigquery
from google.oauth2 import service_account
import json

from app.core.logging import get_logger
from app.core.config import settings
from app.models import DataSourceType
from app.services.sql_validator import validate_select_only
from app.services import physical_type_map as _ptm
from app.services.google_sheets_connector import create_google_sheets_connector
from app.services.manual_table_connector import create_manual_table_connector
from app.services.google_data_access_service import get_google_credentials_for_user_id

logger = get_logger(__name__)


def _bigquery_dedup_outer_select(client, original_query: str) -> Optional[str]:
    """Rewrite outer SELECT to dedupe columns when source SQL has
    duplicate-named outputs (vd JOIN trả về 2 cột `name`).

    Strategy:
      1. Probe the source's INNERMOST subquery via LIMIT 0 to learn
         every output column name (free — no bytes scanned).
      2. If no duplicates, return None (signals "real error, not a
         dedup case").
      3. Otherwise, rewrite outer `SELECT *` to an explicit list with
         unique aliases: `col_a, col_b, dup AS dup, dup AS dup_2, ...`.

    Pattern recognised: `SELECT * FROM ((<source>) AS _appbi_live)
    [WHERE ...] LIMIT N`. The dataset-level executor in
    `live_query_service.build_live_dataset_query` always emits this
    shape when no explicit dims/measures are picked.

    Returns the rewritten SQL, or None if we can't safely rewrite
    (caller should re-raise the original error).
    """
    # Find the source CTE/subquery between `FROM (` and `) AS _appbi_live`.
    # Use a balanced-paren parse from the rightmost `) AS _appbi_live`.
    marker = ") AS _appbi_live"
    idx = original_query.find(marker)
    if idx == -1:
        return None
    # Walk backwards to find the matching `(` for the source subquery.
    depth = 1
    pos = idx - 1
    while pos >= 0 and depth > 0:
        c = original_query[pos]
        if c == ")":
            depth += 1
        elif c == "(":
            depth -= 1
            if depth == 0:
                break
        pos -= 1
    if depth != 0 or pos < 0:
        return None
    source_sql = original_query[pos + 1 : idx]  # raw source SQL inside parens

    # Probe schema via dry-run (no bytes scanned, no execution). The
    # dry-run query job reports `schema` of the OUTPUT columns even
    # when actual execution would fail with ambiguous — because the
    # ambiguity is detected at query compilation BEFORE result framing.
    # If dry-run itself errors, we accept the original failure.
    try:
        from google.cloud import bigquery as _bq
        job_config = _bq.QueryJobConfig(dry_run=True, use_query_cache=False)
        probe_job = client.query(source_sql, job_config=job_config)
        # dry-run job has `.schema` directly without `.result()`.
        cols = [f.name for f in (probe_job.schema or [])]
        if not cols:
            return None
    except Exception:
        return None

    seen: dict[str, int] = {}
    has_dup = False
    expanded: list[str] = []
    for col in cols:
        seen[col] = seen.get(col, 0) + 1
        if seen[col] == 1:
            expanded.append(f"`{col}`")
        else:
            has_dup = True
            alias = f"{col}_{seen[col]}"
            expanded.append(f"`{col}` AS `{alias}`")
    if not has_dup:
        return None  # No duplicates — original error was something else.

    explicit_select = ", ".join(expanded)
    # Replace the leading "SELECT *" with the explicit list. Be precise:
    # only the OUTERMOST SELECT, not any nested ones.
    if not original_query.lstrip().upper().startswith("SELECT *"):
        return None
    return original_query.replace("SELECT *", f"SELECT {explicit_select}", 1)


def _coerce_sheet_value(value: Any, declared_type: str) -> Any:
    if value is None:
        return None

    if declared_type == "number":
        if isinstance(value, (int, float)):
            return value

        text = str(value).strip()
        if text in ("", "-", "—", "–"):
            return None

        negative = False
        if text.startswith("(") and text.endswith(")"):
            negative = True
            text = text[1:-1]

        is_percentage = text.endswith("%")
        if is_percentage:
            text = text[:-1]

        cleaned = text.replace(",", "").replace(" ", "").replace("\xa0", "")
        if not cleaned:
            return None

        try:
            number = float(cleaned)
        except ValueError:
            return None

        if negative:
            number = -number
        if is_percentage:
            number = number / 100
        return number

    if declared_type == "date":
        text = str(value).strip()
        return text or None

    text = str(value).strip()
    return text or None


def _duckdb_quote_ident(name: str) -> str:
    """Quote an identifier for DuckDB (double quotes, doubling internal ones)."""
    return '"' + str(name).replace('"', '""') + '"'


def _sheets_referenced_by_sql(sql_query: str, sheet_names: List[str]) -> List[str]:
    """Return the subset of ``sheet_names`` that the SQL appears to reference.

    A Sheets query is executed by registering each tab as a DuckDB table, then
    running the SQL. Registering EVERY tab for EVERY tile is the dominant
    per-tile cost on multi-tab workbooks (Arrow build + CREATE TABLE per tab).
    Most chart/lookup SQL touches ONE tab, so we scan for tab names that appear
    as identifier tokens in the SQL and load only those.

    Detection matches a tab name when it occurs in the SQL either bare
    (``Sheet1``) or double-quoted (``"My Sheet"``) — covering the two forms the
    Sheets DuckDB registration creates (raw name + space-stripped ``safe_name``).
    To stay CORRECT, this is conservative: if NOTHING matches (a tab named in a
    way we can't parse, dynamic SQL, etc.) it returns ALL tabs so a JOIN/CTE
    never silently loses a table. The optimisation only kicks in when we are
    confident which tabs are used.
    """
    if not sql_query or not sheet_names:
        return list(sheet_names)

    # Pull bare + quoted identifier tokens out of the SQL once.
    quoted = set(re.findall(r'"([^"]+)"', sql_query))
    bare_tokens = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", sql_query))
    bare_tokens_lower = {t.lower() for t in bare_tokens}

    referenced: List[str] = []
    for name in sheet_names:
        safe_name = name.replace(" ", "_")
        # Quoted form: exact match against the literal tab name or safe_name.
        if name in quoted or safe_name in quoted:
            referenced.append(name)
            continue
        # Bare form: the safe_name (no spaces) can appear as a bare identifier.
        # Matching against the TOKEN SET (not substring containment) is what
        # prevents a tab "Orders" from falsely matching a column "OrdersTotal"
        # — the tokenizer extracts "OrdersTotal" as one token, so "orders" is
        # absent from the set. A loose `name in sql` substring test would
        # over-match here, needlessly loading the extra tab (correct results,
        # but it defeats the optimisation), so we deliberately do NOT do that.
        if safe_name.lower() in bare_tokens_lower or name.lower() in bare_tokens_lower:
            referenced.append(name)
            continue

    # Conservative fallback: detected nothing → load everything (correctness
    # beats the optimisation). Also covers SELECT-* dynamic SQL with no FROM
    # we can parse.
    if not referenced:
        return list(sheet_names)
    return referenced


def _python_value_type_token(value: Any) -> str:
    """The physical type token implied by a value a query engine returned.

    Used for schema-less sources (imported files, Google Sheets) where the only
    authority on a column's type is the engine that produced it. Tokens are the
    ones `physical_type_map` understands, so the snapshot loader and the semantic
    engine read the same vocabulary."""
    import datetime as _dt
    from decimal import Decimal as _Dec

    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "bigint"
    if isinstance(value, float):
        return "double"
    if isinstance(value, _Dec):
        return "numeric"
    if isinstance(value, _dt.datetime):
        return "timestamp"
    if isinstance(value, _dt.date):
        return "date"
    if isinstance(value, _dt.time):
        return "time"
    if isinstance(value, (bytes, bytearray)):
        return "bytes"
    if isinstance(value, (dict, list, tuple)):
        return "json"
    return "string"


def _build_arrow_table_from_sheet(pa_module, col_defs: List[Dict[str, Any]], rows: List[Dict[str, Any]]):
    col_names = [c["name"] for c in col_defs]
    col_types = {c["name"]: c.get("type", "string") for c in col_defs}

    arrays = []
    for col_name in col_names:
        declared_type = col_types.get(col_name, "string")
        values = [_coerce_sheet_value(row.get(col_name), declared_type) for row in rows]
        if declared_type == "number":
            arrays.append(pa_module.array(values, type=pa_module.float64()))
        else:
            arrays.append(pa_module.array(values, type=pa_module.string()))

    return pa_module.table(dict(zip(col_names, arrays)))


def _resolve_gcp_credentials_json(config: Dict[str, Any]) -> str:
    """
    Return the GCP credentials JSON string to use for a connection.

    Priority:
      1. credentials_json supplied in the datasource config (user-provided key).
      2. GCP_SERVICE_ACCOUNT_JSON from platform settings (.env).

    Raises ValueError when neither source is available.
    """
    from_config = config.get("credentials_json") or ""
    if isinstance(from_config, str) and from_config.strip():
        return from_config.strip()
    platform_json = (settings.GCP_SERVICE_ACCOUNT_JSON or "").strip()
    if platform_json:
        return platform_json
    raise ValueError(
        "No GCP credentials found. Either provide credentials_json in the "
        "datasource config or set GCP_SERVICE_ACCOUNT_JSON in the platform .env."
    )


def _build_gcp_credentials(config: Dict[str, Any]):
    # Decrypt here so EVERY caller works whether or not it pre-decrypted the
    # config. Execution paths (list_tables/execute_query) call decrypt_config
    # upfront, but the schema/type/column-inference paths pass the raw stored
    # config — there `google_oauth_user_id` is still the "_enc:…" ciphertext,
    # so `uuid.UUID(...)` raised "Invalid Google OAuth credential owner id."
    # and BigQuery schema/column inference silently failed (dataset "không
    # nhận" the BQ columns). decrypt_config is idempotent (skips non-"_enc:"
    # values) so calling it on an already-decrypted config is a no-op.
    from app.core.crypto import decrypt_config
    config = decrypt_config(config)
    auth_mode = str(config.get("auth_mode") or "service_account").strip().lower()
    if auth_mode == "google_oauth":
        # A data source owns its Google credential, so two sources can read
        # through two different Google accounts. Sources connected before that
        # (no per-source token) still resolve via the AppBI user who connected.
        from app.services.google_data_access_service import credentials_from_source_config
        own = credentials_from_source_config(config)
        if own is not None:
            return own
        google_oauth_user_id = str(config.get("google_oauth_user_id") or "").strip()
        if not google_oauth_user_id:
            raise ValueError(
                "This data source has no Google account connected. Open it and press Connect Google."
            )
        return get_google_credentials_for_user_id(google_oauth_user_id)

    credentials_info = json.loads(_resolve_gcp_credentials_json(config))
    return service_account.Credentials.from_service_account_info(credentials_info)


def _materialization_write_credentials_json(dc: Dict[str, Any]) -> str:
    """Resolve the write-SA key JSON. Precedence: per-datasource
    `materialization_write_credentials_json` → global `.env`
    MATERIALIZATION_SA_KEY_FILE (path) → MATERIALIZATION_SA_CREDENTIALS_JSON
    (inline) → '' (fall back to the datasource read credential)."""
    per_ds = str(dc.get("materialization_write_credentials_json") or "").strip()
    if per_ds:
        return per_ds
    try:
        from app.core.config import settings
        key_file = str(getattr(settings, "MATERIALIZATION_SA_KEY_FILE", "") or "").strip()
        if key_file and os.path.exists(key_file):
            with open(key_file, "r", encoding="utf-8") as fh:
                return fh.read().strip()
        inline = str(getattr(settings, "MATERIALIZATION_SA_CREDENTIALS_JSON", "") or "").strip()
        if inline:
            return inline
    except Exception:  # noqa: BLE001 — never let config lookup break materialization
        logger.warning("[snapshot] global write-SA lookup failed", exc_info=True)
    return ""


def _materialization_bq_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Config for snapshot CREATE+LOAD + reading the SA-only snapshot dataset.
    Uses the write service account (per-datasource cred, else the global .env SA)
    so it never rides the datasource read identity; falls back to the read
    credential only when no write SA is configured. Returns a DECRYPTED config so
    `_build_bigquery_client` keys the client cache by the write identity."""
    from app.core.crypto import decrypt_config
    dc = decrypt_config(config)
    write_cred = _materialization_write_credentials_json(dc)
    if write_cred:
        wc = dict(dc)
        wc["auth_mode"] = "service_account"
        wc["credentials_json"] = write_cred
        wc.pop("google_oauth_user_id", None)  # force SA path, not oauth
        return wc
    return dc


def _partition_by_expr(pf: str, ftype: str, gran: str) -> Optional[str]:
    """BigQuery DDL ``PARTITION BY`` expression for a CTAS, from the partition
    column's type + granularity. None ⇒ cannot partition (caller builds a plain/
    clustered table). Mirrors what ``bigquery.TimePartitioning(type_, field)`` does
    on the streaming path, expressed as SQL for the one-shot CREATE TABLE AS."""
    ftype = (ftype or "").upper()
    gran = (gran or "DAY").upper()
    q = f"`{pf}`"
    if ftype == "DATE":
        if gran in ("MONTH", "YEAR"):
            return f"DATE_TRUNC({q}, {gran})"
        return q  # DAY (and HOUR, invalid on DATE, degrades to daily) → the column
    if ftype == "TIMESTAMP":
        if gran == "DAY":
            return f"DATE({q})"
        return f"TIMESTAMP_TRUNC({q}, {gran})"  # HOUR / MONTH / YEAR
    if ftype == "DATETIME":
        return f"DATETIME_TRUNC({q}, {gran})"  # DAY / HOUR / MONTH / YEAR all valid
    return None


def _is_quota_exceeded(exc: Exception) -> bool:
    """True when a BigQuery error is a 403 quota exhaustion (notably
    ``partition_modifications_per_column_partitioned_table``) — so the caller can
    surface a clear message and NOT hammer the quota with auto-retries."""
    try:
        for e in (getattr(exc, "errors", None) or []):
            if str(e.get("reason", "")).lower() == "quotaexceeded":
                return True
        msg = str(exc).lower()
        if "partition_modifications" in msg:
            return True
        if "quotaexceeded" in msg.replace(" ", ""):
            return True
        if getattr(exc, "code", None) == 403 and "quota" in msg:
            return True
    except Exception:  # noqa: BLE001
        pass
    return False


def _partition_bounds(partition_id: str, gran: str) -> Tuple[str, str]:
    """[lo, hi) date/datetime bounds for a BigQuery partition_id at a given
    granularity, used to prune the source extract to one partition."""
    import datetime as _dt
    g = (gran or "DAY").upper()
    if g == "YEAR":
        y = int(partition_id[:4])
        return f"{y:04d}-01-01", f"{y + 1:04d}-01-01"
    if g == "MONTH":
        y, m = int(partition_id[:4]), int(partition_id[4:6])
        nxt = _dt.date(y + (1 if m == 12 else 0), (m % 12) + 1, 1)
        return f"{y:04d}-{m:02d}-01", nxt.isoformat()
    if g == "HOUR":
        d = _dt.datetime.strptime(partition_id, "%Y%m%d%H")
        return d.strftime("%Y-%m-%d %H:00:00"), (d + _dt.timedelta(hours=1)).strftime("%Y-%m-%d %H:00:00")
    d = _dt.datetime.strptime(partition_id, "%Y%m%d").date()  # DAY
    return d.isoformat(), (d + _dt.timedelta(days=1)).isoformat()


_BQ_CLIENT_CACHE: Dict[str, Tuple[float, bigquery.Client]] = {}
_BQ_CLIENT_CACHE_TTL_SEC = 300  # 5 min — keeps client warm across dashboard requests


def _bigquery_client_cache_key(config: Dict[str, Any]) -> str | None:
    """Stable cache key over credential identity + project. None = uncacheable."""
    auth_mode = str(config.get("auth_mode") or "service_account").strip().lower()
    if auth_mode == "google_oauth":
        # Fix #8 (2026-06-10): OAuth datasources ARE now cacheable. Prod logs
        # showed a BQ-OAuth dashboard rebuilding the client ~20x per load
        # (every dry-run + every query) — each rebuild = a DB roundtrip in
        # get_google_credentials_for_user_id + a possible token refresh + a TLS
        # handshake, piled on top of BQ's own 8-17s query latency.
        #
        # Why this is safe: google.oauth2.credentials.Credentials carries the
        # REFRESH token, and the BigQuery client's transport auto-refreshes the
        # short-lived access token on demand. So a cached client stays valid for
        # as long as the refresh token is — far beyond our 5-min TTL. We key on
        # the connected AppBI user id (the credential owner) + project, so two
        # datasources sharing one Google identity reuse one warm client. The
        # id may be encrypted in the raw config; decrypt to get a stable key.
        from app.core.crypto import decrypt_config
        dc = decrypt_config(config)
        owner = str(dc.get("google_oauth_user_id") or "").strip()
        if not owner:
            return None  # can't key it safely → rebuild every time (old behaviour)
        project_id = str(dc.get("project_id") or config.get("project_id") or "").strip()
        return f"google_oauth:{project_id}:{owner}"
    try:
        creds_json = _resolve_gcp_credentials_json(config)
    except ValueError:
        return None
    project_id = str(config.get("project_id") or "").strip()
    import hashlib
    creds_fp = hashlib.sha256(creds_json.encode("utf-8")).hexdigest()
    return f"{auth_mode}:{project_id}:{creds_fp}"


def _bq_client_cache_hit(cache_key: str | None) -> bigquery.Client | None:
    """Return a warm cached client for the key, or None if cold/expired/uncacheable."""
    if cache_key is None:
        return None
    cached = _BQ_CLIENT_CACHE.get(cache_key)
    if cached and (time.time() - cached[0]) < _BQ_CLIENT_CACHE_TTL_SEC:
        return cached[1]
    return None


def _build_bigquery_client(config: Dict[str, Any]) -> bigquery.Client:
    project_id = str(config.get("project_id") or "").strip() or None
    cache_key = _bigquery_client_cache_key(config)

    # Fast path (unlocked): a warm client, the overwhelmingly common case —
    # served with zero lock contention. Fix #5 keeps cached clients open.
    hit = _bq_client_cache_hit(cache_key)
    if hit is not None:
        logger.debug("[perf] bq client cache=HIT project=%s", project_id)
        return hit

    def _build() -> bigquery.Client:
        # Re-check inside the flight: a burst of concurrent requests that all
        # missed the cold cache serialise here; the LEADER builds + caches, and
        # every waiter (which enters after the leader populated the cache) takes
        # this hit instead of issuing its own credential-load + TLS handshake.
        # This is the single_flight() contract (compute re-checks the cache).
        warm = _bq_client_cache_hit(cache_key)
        if warm is not None:
            logger.debug("[perf] bq client cache=HIT(after-flight) project=%s", project_id)
            return warm
        # [perf] cold build: credential load + TLS handshake. Expensive; should be
        # RARE per datasource (~once per 5-min TTL). A burst of these on one
        # dashboard load means the cache isn't sticking — only expected when the
        # key can't be derived (no project / no OAuth owner id).
        _build_reason = "uncacheable(no project/owner)" if cache_key is None else "cold/expired"
        logger.info("[perf] bq client cache=MISS project=%s reason=%s (building new client)", project_id, _build_reason)
        client = bigquery.Client(
            credentials=_build_gcp_credentials(config),
            project=project_id,
        )
        if cache_key is not None:
            _BQ_CLIENT_CACHE[cache_key] = (time.time(), client)
        return client

    # Single-flight the cold build so a cache stampede (N concurrent cold-cache
    # requests) collapses to ONE client build instead of N — the real source of
    # the 17-26s outliers. Only when we have a key to dedup on; an uncacheable
    # config (no project / no OAuth owner) has a distinct identity per call, so
    # there is nothing to collapse — build directly (old behaviour).
    if cache_key is None:
        return _build()
    from app.services import query_cache as _qc
    return _qc.single_flight(f"bqclient::{cache_key}", _build)


def _bq_client_is_cached(config: Dict[str, Any], client: "bigquery.Client") -> bool:
    """True when ``client`` is the live entry in ``_BQ_CLIENT_CACHE``.

    Callers MUST NOT ``close()`` a cached client: the cache keeps it warm for
    ~5 min so a burst of dashboard tiles reuses one HTTP transport instead of
    rebuilding (credential load + TLS handshake) per query. Closing it tore
    down the shared transport, so the very next tile either rebuilt the client
    or hit a closed socket — defeating the cache entirely. OAuth clients are
    never cached (refresh state) so they still get closed by the caller.
    """
    cache_key = _bigquery_client_cache_key(config)
    if cache_key is None:
        return False
    cached = _BQ_CLIENT_CACHE.get(cache_key)
    return bool(cached and cached[1] is client)


def evict_bigquery_client_cache(*configs: Dict[str, Any]) -> int:
    """Drop cached BigQuery client(s) so the NEXT query rebuilds with fresh
    credentials. Call this after a datasource's credential/config CHANGES — the
    whole Source→Dataset→Explore→Dashboard chain resolves the datasource live and
    builds its client through this one cache, so evicting here makes a key change
    take effect immediately instead of the warm client (built from the OLD key)
    lingering up to the 5-min TTL. Pass the config(s) whose entries to drop (e.g.
    the pre- AND post-update config, since an auth-mode switch changes the key);
    pass none to clear ALL. NEVER raises.

    Per-process: with multiple uvicorn workers only the worker handling the update
    is evicted synchronously. Other workers self-correct because the cache key is
    derived from the credential (SA creds fingerprint / OAuth owner) — a real key
    change yields a new cache key there too — bounded by the TTL for same-key
    changes (e.g. OAuth re-auth)."""
    try:
        if configs:
            keys = []
            for cfg in configs:
                try:
                    k = _bigquery_client_cache_key(cfg)
                except Exception:
                    k = None
                if k:
                    keys.append(k)
        else:
            keys = list(_BQ_CLIENT_CACHE.keys())
        evicted = 0
        for k in keys:
            entry = _BQ_CLIENT_CACHE.pop(k, None)
            if entry is not None:
                evicted += 1
                try:
                    entry[1].close()
                except Exception:  # noqa: BLE001 — closing a torn-down client is best-effort
                    pass
        if evicted:
            logger.info("[bq] evicted %d cached client(s) after datasource change", evicted)
        return evicted
    except Exception:  # noqa: BLE001 — cache eviction must never break an update
        logger.debug("evict_bigquery_client_cache failed", exc_info=True)
        return 0


_TRAILING_ROW_LIMIT_RE = re.compile(
    r"(?:\bLIMIT\s+\d+\s*(?:OFFSET\s+\d+\s*)?|\bOFFSET\s+\d+\s+LIMIT\s+\d+\s*|\bFETCH\s+FIRST\s+\d+\s+ROWS?\s+ONLY)\s*$",
    re.IGNORECASE | re.DOTALL,
)


def _normalize_sql_query(sql_query: str) -> str:
    """Trim trailing semicolons/whitespace so LIMIT handling stays stable."""
    return sql_query.rstrip().rstrip(";").rstrip()


def _query_has_explicit_row_limit(sql_query: str) -> bool:
    """Return True when the SQL already ends with a row limiting clause."""
    return bool(_TRAILING_ROW_LIMIT_RE.search(_normalize_sql_query(sql_query)))


def _apply_optional_limit(sql_query: str, limit: int | None) -> str:
    """
    Append LIMIT only when the caller requested one and the SQL does not
    already end with LIMIT / FETCH FIRST.
    """
    normalized = _normalize_sql_query(sql_query)
    if not limit or _query_has_explicit_row_limit(normalized):
        return normalized
    return f"{normalized} LIMIT {int(limit)}"


class DataSourceConnectionService:
    """Service for managing connections to external data sources."""
    
    @staticmethod
    def test_connection(ds_type: str, config: Dict[str, Any]) -> Tuple[bool, str]:
        """
        Test a data source connection.
        
        Args:
            ds_type: Type of data source
            config: Connection configuration
            
        Returns:
            Tuple of (success: bool, message: str)
        """
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)
        try:
            if ds_type == DataSourceType.POSTGRESQL.value:
                return DataSourceConnectionService._test_postgresql(config)
            elif ds_type == DataSourceType.MYSQL.value:
                return DataSourceConnectionService._test_mysql(config)
            elif ds_type == DataSourceType.BIGQUERY.value:
                return DataSourceConnectionService._test_bigquery(config)
            elif ds_type == DataSourceType.GOOGLE_SHEETS.value:
                return DataSourceConnectionService._test_google_sheets(config)
            elif ds_type == DataSourceType.GOOGLE_DOCS.value:
                return DataSourceConnectionService._test_google_docs(config)
            elif ds_type == DataSourceType.MANUAL.value:
                return DataSourceConnectionService._test_manual(config)
            else:
                return False, f"Unsupported data source type: {ds_type}"
        except Exception as e:
            logger.error(f"Connection test failed: {str(e)}")
            return False, f"Connection failed: {str(e)}"
    
    @staticmethod
    def _test_google_docs(config: Dict[str, Any]) -> Tuple[bool, str]:
        """A Google Docs source holds no tabular data — it names WHICH Google
        account a Knowledge Doc reads documents through. So "test" verifies the
        stored credential is usable and carries the Docs scope."""
        from app.services.google_data_access_service import source_google_capabilities
        if str(config.get("auth_mode") or "").strip().lower() != "google_oauth":
            return False, "A Google Docs source must be connected with a Google account."
        if not config.get("google_oauth_credentials") and not config.get("google_oauth_user_id"):
            return False, "Press \"Connect Google\" to choose the Google account this source uses."
        caps = source_google_capabilities(config)
        if config.get("google_oauth_credentials") and not caps.get("docs"):
            return False, (
                "This Google account was connected without permission to read Docs. "
                "Press Connect Google again and approve Google Docs access."
            )
        try:
            # There is no document to read at source level, and the granted
            # scope is Docs-only (no Drive listing), so the honest check is
            # that the stored token still exchanges/refreshes successfully.
            creds = _build_gcp_credentials(config)
            if getattr(creds, "expired", False) and not getattr(creds, "refresh_token", None):
                return False, "The stored Google token has expired. Press Connect Google again."
            email = config.get("google_oauth_email") or "the connected account"
            return True, f"Google account connected ({email}) with permission to read Docs."
        except Exception as exc:  # noqa: BLE001
            return False, f"Google Docs connection failed: {exc}"

    @staticmethod
    def _test_postgresql(config: Dict[str, Any]) -> Tuple[bool, str]:
        """Test PostgreSQL connection."""
        conn = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=5
            )
            # Apply schema search_path if specified
            schema = config.get("schema_name") or config.get("schema")
            if schema:
                with conn.cursor() as cur:
                    cur.execute(f"SET search_path TO {schema}")
            return True, "Connection successful"
        except Exception as e:
            return False, str(e)
        finally:
            if conn:
                conn.close()
    
    @staticmethod
    def _test_mysql(config: Dict[str, Any]) -> Tuple[bool, str]:
        """Test MySQL connection."""
        conn = None
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=config.get("port", 3306),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=5
            )
            return True, "Connection successful"
        except Exception as e:
            return False, str(e)
        finally:
            if conn:
                conn.close()
    
    @staticmethod
    def _test_bigquery(config: Dict[str, Any]) -> Tuple[bool, str]:
        """Test BigQuery connection."""
        client = None
        try:
            client = _build_bigquery_client(config)
            # Test basic API access
            query = "SELECT 1"
            client.query(query).result()

            # Also verify dataset/table listing permission — this is what the datasource
            # actually needs after connecting.  If default_dataset is set, probe that
            # dataset directly (covers per-dataset IAM roles).  Otherwise attempt a
            # project-level dataset listing so the user gets an early warning.
            default_dataset = config.get("default_dataset", "").strip()
            if default_dataset:
                try:
                    list(client.list_tables(default_dataset, max_results=1))
                except Exception as e:
                    return True, f"Connection successful, but could not list tables in dataset '{default_dataset}': {e}"
            else:
                try:
                    datasets = list(client.list_datasets(max_results=1))
                    if not datasets:
                        return True, (
                            "Connection successful, but no datasets found in the project. "
                            "Check that the connected credential has bigquery.datasets.list on the project, "
                            "or set a Default Dataset to target a specific dataset."
                        )
                except Exception as e:
                    return True, f"Connection successful, but could not list datasets: {e}. Set a Default Dataset if the credential only has per-dataset access."

            return True, "Connection successful"
        except Exception as e:
            return False, str(e)
        finally:
            if client:
                client.close()
    
    @staticmethod
    def _test_google_sheets(config: Dict[str, Any]) -> Tuple[bool, str]:
        """Test Google Sheets connection by verifying API access to the spreadsheet."""
        try:
            spreadsheet_id = (config.get("spreadsheet_id") or "").strip()
            if not spreadsheet_id:
                return False, "Spreadsheet ID is required"
            connector = create_google_sheets_connector(config)
            if connector.test_connection(spreadsheet_id):
                # Also verify we can list sheets (confirms read access)
                sheets = connector.list_sheets(spreadsheet_id)
                return True, f"Connection successful — {len(sheets)} sheet(s) found"
            return False, "Failed to connect to Google Sheets. Check that the spreadsheet is shared with the service account."
        except Exception as e:
            return False, str(e)
    
    @staticmethod
    def _test_manual(config: Dict[str, Any]) -> Tuple[bool, str]:
        """Test manual table (always succeeds)."""
        return True, "Manual table ready"
    
    @staticmethod
    def execute_query(
        ds_type: str,
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None,
        timeout_seconds: int = 30,
        query_params: list = None,
        skip_bigquery_cost_check: bool = False,
    ) -> Tuple[List[str], List[Dict[str, Any]], float]:
        """
        Execute a SQL query against a data source.
        
        Args:
            ds_type: Type of data source
            config: Connection configuration
            sql_query: SQL query to execute
            limit: Optional row limit
            timeout_seconds: Query timeout in seconds (default: 30)
            query_params: Optional list of parameter values for %s placeholders
            skip_bigquery_cost_check: Skip dry-run scan guard for BigQuery callers
            
        Returns:
            Tuple of (columns, data, execution_time_ms)
            
        Raises:
            ValueError: If query is not a SELECT statement
        """
        # Validate SQL query for safety
        validate_select_only(sql_query)

        from app.core.crypto import decrypt_config
        config = decrypt_config(config)

        start_time = time.time()
        
        try:
            if ds_type == DataSourceType.POSTGRESQL.value:
                result = DataSourceConnectionService._execute_postgresql(config, sql_query, limit, timeout_seconds, query_params)
            elif ds_type == DataSourceType.MYSQL.value:
                result = DataSourceConnectionService._execute_mysql(config, sql_query, limit, timeout_seconds, query_params)
            elif ds_type == DataSourceType.BIGQUERY.value:
                result = DataSourceConnectionService._execute_bigquery(
                    config,
                    sql_query,
                    limit,
                    timeout_seconds,
                    skip_cost_check=skip_bigquery_cost_check,
                )
            elif ds_type == DataSourceType.GOOGLE_SHEETS.value:
                result = DataSourceConnectionService._execute_google_sheets(config, sql_query, limit)
            elif ds_type == DataSourceType.MANUAL.value:
                result = DataSourceConnectionService._execute_manual(config, sql_query, limit)
            else:
                raise ValueError(f"Unsupported data source type: {ds_type}")
            
            execution_time_ms = (time.time() - start_time) * 1000
            return result[0], result[1], execution_time_ms
            
        except Exception as e:
            logger.error(f"Query execution failed: {str(e)}")
            raise

    @staticmethod
    def execute_write(
        ds_type: str,
        config: Dict[str, Any],
        sql_query: str,
        query_params: list = None,
        timeout_seconds: int = 30,
    ) -> Tuple[List[str], List[Dict[str, Any]], int, float]:
        """
        Execute a write statement (INSERT/UPDATE/DELETE) against a data source.

        Unlike :meth:`execute_query`, this path does NOT pass through
        ``validate_select_only`` — write SQL is built by trusted internal
        callers (see ``workboard_write_service``) using parameterised queries.
        Callers MUST use parameter placeholders (``%s``) for every value;
        never interpolate user input into the SQL string.

        Currently supported on PostgreSQL and MySQL only. Other datasource
        types (Google Sheets, BigQuery) need to use :meth:`execute_write_op`
        instead — see workboard write service for the row-level abstraction.

        Returns:
            (columns, rows, rowcount, execution_time_ms)

            ``columns`` and ``rows`` are populated when the SQL ends with a
            ``RETURNING`` clause (PostgreSQL) — empty lists otherwise.
        """
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)

        start_time = time.time()
        if ds_type == DataSourceType.POSTGRESQL.value:
            columns, rows, rowcount = DataSourceConnectionService._execute_postgresql_write(
                config, sql_query, query_params, timeout_seconds
            )
        elif ds_type == DataSourceType.MYSQL.value:
            columns, rows, rowcount = DataSourceConnectionService._execute_mysql_write(
                config, sql_query, query_params, timeout_seconds
            )
        else:
            raise ValueError(
                f"Write operations are not supported on datasource type '{ds_type}'."
            )

        execution_time_ms = (time.time() - start_time) * 1000
        return columns, rows, rowcount, execution_time_ms

    @staticmethod
    def execute_write_op(
        ds_type: str,
        config: Dict[str, Any],
        op: str,                      # "insert" | "update" | "delete"
        table_name: str,
        values: Dict[str, Any] | List[Dict[str, Any]] | None = None,
        pk: Dict[str, Any] | None = None,
        lock_column: Optional[str] = None,
        lock_token: Any = None,
        auto_pk_columns: Optional[List[str]] = None,
    ) -> Tuple[Dict[str, Any], int, float]:
        """Row-level write that doesn't require SQL strings.

        Designed for datasources that don't speak SQL (Google Sheets) or
        where the workboard layer prefers a high-level operation over
        building SQL. Returns ``(row_values, rowcount, ms)``:

          * ``row_values`` echoes the inserted/updated row as a dict, or
            ``{"rows": [...]}`` for ``insert_many``;
          * ``rowcount`` is the number of affected rows.

        SQL-speaking datasources can still go through this helper —
        internally it builds the equivalent INSERT/UPDATE/DELETE and routes
        to :meth:`execute_write`.

        Extra GSheets-only params:
          * ``lock_column``/``lock_token`` — optimistic-lock column name and
            the token value the client read. If set, update/delete will raise
            ValueError("OPTIMISTIC_LOCK: ...") when the stored value differs.
          * ``auto_pk_columns`` — for insert only. UUID is auto-generated for
            each listed column that is absent/empty in ``values``.
        """
        from app.core.crypto import decrypt_config
        cfg = decrypt_config(config)

        start = time.time()

        if ds_type == DataSourceType.GOOGLE_SHEETS.value:
            from app.services.google_sheets_connector import (
                create_google_sheets_connector,
            )
            connector = create_google_sheets_connector(cfg)
            spreadsheet_id = cfg.get("spreadsheet_id")
            if not spreadsheet_id:
                raise ValueError("Google Sheets datasource missing spreadsheet_id.")
            # ``table_name`` is the sheet name for Sheets datasources.
            sheet_name = table_name
            if op == "insert":
                row = connector.append_row(
                    spreadsheet_id,
                    sheet_name,
                    values if isinstance(values, dict) else {},
                    auto_pk_columns=auto_pk_columns,
                )
                ms = (time.time() - start) * 1000
                return row, 1, ms
            if op == "insert_many":
                rows = values if isinstance(values, list) else []
                result = connector.append_rows(
                    spreadsheet_id, sheet_name, rows,
                    auto_pk_columns=auto_pk_columns,
                )
                ms = (time.time() - start) * 1000
                return {"rows": result.get("rows") or []}, int(result.get("appended") or 0), ms
            if op == "update":
                if not pk:
                    raise ValueError("update requires a primary-key dict.")
                row = connector.update_row_by_pk(
                    spreadsheet_id, sheet_name, pk, values or {},
                    lock_column=lock_column, lock_token=lock_token,
                )
                ms = (time.time() - start) * 1000
                return row, 1, ms
            if op == "update_many":
                rows = values if isinstance(values, list) else []
                result = connector.update_rows_by_pk(
                    spreadsheet_id,
                    sheet_name,
                    rows,
                    lock_column=lock_column,
                )
                ms = (time.time() - start) * 1000
                return {"rows": result.get("rows") or []}, int(result.get("updated") or 0), ms
            if op == "delete":
                if not pk:
                    raise ValueError("delete requires a primary-key dict.")
                connector.delete_row_by_pk(
                    spreadsheet_id, sheet_name, pk,
                    lock_column=lock_column, lock_token=lock_token,
                )
                ms = (time.time() - start) * 1000
                return {}, 1, ms
            raise ValueError(f"Unsupported op '{op}'.")

        # Fall through: build SQL and re-use execute_write for SQL backends.
        if ds_type not in (
            DataSourceType.POSTGRESQL.value,
            DataSourceType.MYSQL.value,
        ):
            raise ValueError(
                f"Write operations are not supported on datasource type '{ds_type}'."
            )

        # The legacy WorkboardWriteService still builds SQL itself; this
        # branch exists so future callers can hand off ops directly.
        raise NotImplementedError(
            "SQL-backed write_op routing is intentionally not implemented yet — "
            "callers should keep using execute_write for Postgres/MySQL."
        )

    @staticmethod
    def _execute_postgresql_write(
        config: Dict[str, Any],
        sql_query: str,
        query_params: list,
        timeout_seconds: int,
    ) -> Tuple[List[str], List[Dict[str, Any]], int]:
        conn = None
        cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=min(timeout_seconds, 10),
            )
            cursor = conn.cursor()
            cursor.execute(f"SET statement_timeout = {timeout_seconds * 1000}")
            schema = config.get("schema_name") or config.get("schema")
            if schema:
                cursor.execute(f"SET search_path TO {schema}")
            cursor.execute(sql_query, query_params)
            rowcount = cursor.rowcount or 0
            columns: List[str] = []
            rows: List[Dict[str, Any]] = []
            if cursor.description:
                columns = [desc[0] for desc in cursor.description]
                fetched = cursor.fetchall()
                rows = [dict(zip(columns, row)) for row in fetched]
            conn.commit()
            return columns, rows, rowcount
        except Exception:
            if conn is not None:
                try:
                    conn.rollback()
                except Exception:
                    pass
            raise
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()

    @staticmethod
    def _execute_mysql_write(
        config: Dict[str, Any],
        sql_query: str,
        query_params: list,
        timeout_seconds: int,
    ) -> Tuple[List[str], List[Dict[str, Any]], int]:
        conn = None
        cursor = None
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=config.get("port", 3306),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=min(timeout_seconds, 10),
                read_timeout=timeout_seconds,
                write_timeout=timeout_seconds,
                autocommit=False,
            )
            cursor = conn.cursor()
            cursor.execute(sql_query, query_params)
            rowcount = cursor.rowcount or 0
            conn.commit()
            # MySQL does not support RETURNING; callers must SELECT separately.
            return [], [], rowcount
        except Exception:
            if conn is not None:
                try:
                    conn.rollback()
                except Exception:
                    pass
            raise
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()

    @staticmethod
    def fetch_table_data(
        ds_type: str,
        config: Dict[str, Any],
        schema: str,
        table: str,
        limit: int = None,
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """
        Fetch rows from a single table / sheet directly — no fake SQL.

        Used by the sync engine and live fallback paths so each connector uses
        its native fetch API instead of building fake SQL that connectors then
        have to re-parse (fragile for GSheets / Manual).

        The sentinel schema value ``"default"`` is resolved to the connector's
        actual default schema (``public`` for PostgreSQL, the configured
        database for MySQL) so callers don't have to know the real default.

        Args:
            ds_type: DataSourceType value
            config:  Connection config (decrypted internally)
            schema:  Schema name, or ``"default"`` for the connector default,
                     or spreadsheet_id for GSheets
            table:   Table / sheet name
            limit:   Optional row limit (None = all rows)

        Returns:
            (column_names, rows)
        """
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)

        if ds_type == DataSourceType.POSTGRESQL.value:
            # Resolve "default" sentinel to the configured schema or "public"
            real_schema = schema if schema != "default" else (
                config.get("schema_name") or config.get("schema") or "public"
            )
            sql = f'SELECT * FROM "{real_schema}"."{table}"'
            if limit:
                sql += f" LIMIT {int(limit)}"
            cols, rows = DataSourceConnectionService._execute_postgresql(
                config, sql, limit=None
            )
            return cols, rows

        elif ds_type == DataSourceType.MYSQL.value:
            # Resolve "default" sentinel to the configured database
            real_schema = schema if schema != "default" else (
                config.get("database") or schema
            )
            sql = f'SELECT * FROM `{real_schema}`.`{table}`'
            if limit:
                sql += f" LIMIT {int(limit)}"
            cols, rows = DataSourceConnectionService._execute_mysql(
                config, sql, limit=None
            )
            return cols, rows

        elif ds_type == DataSourceType.BIGQUERY.value:
            project_id = config.get("project_id", "")
            sql = f"SELECT * FROM `{project_id}.{schema}.{table}`"
            if limit:
                sql += f" LIMIT {int(limit)}"
            cols, rows = DataSourceConnectionService._execute_bigquery(
                config, sql, limit=None,
            )
            return cols, rows

        elif ds_type == DataSourceType.GOOGLE_SHEETS.value:
            from app.services.google_sheets_connector import create_google_sheets_connector
            spreadsheet_id = config.get("spreadsheet_id") or schema
            connector = create_google_sheets_connector(config)
            data = connector.get_sheet_data(spreadsheet_id, sheet_name=table)
            columns = [col["name"] for col in data.get("columns", [])]
            rows = data.get("rows", [])
            if limit:
                rows = rows[:limit]
            return columns, rows

        elif ds_type == DataSourceType.MANUAL.value:
            from app.services.manual_table_connector import create_manual_table_connector
            connector = create_manual_table_connector(config)
            data = connector.get_sheet_data(table)
            columns = [col["name"] for col in data.get("columns", [])]
            rows = data.get("rows", [])
            if limit:
                rows = rows[:limit]
            return columns, rows

        else:
            raise ValueError(f"fetch_table_data: unsupported datasource type {ds_type!r}")

    @staticmethod
    def _execute_postgresql(
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None,
        timeout_seconds: int = 30,
        query_params: list = None,
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Execute query against PostgreSQL."""
        conn = None
        cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=min(timeout_seconds, 10)
            )
            cursor = conn.cursor()
            
            # Set statement timeout
            cursor.execute(f"SET statement_timeout = {timeout_seconds * 1000}")
            
            # Apply schema search_path if specified
            schema = config.get("schema_name") or config.get("schema")
            if schema:
                cursor.execute(f"SET search_path TO {schema}")
            
            # Apply limit if specified
            query = _apply_optional_limit(sql_query, limit)
            
            cursor.execute(query, query_params)
            
            # Get column names
            columns = [desc[0] for desc in cursor.description]
            
            # Fetch data
            rows = cursor.fetchall()
            data = [dict(zip(columns, row)) for row in rows]
            
            return columns, data
            
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
    
    @staticmethod
    def _execute_mysql(
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None,
        timeout_seconds: int = 30,
        query_params: list = None,
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Execute query against MySQL."""
        conn = None
        cursor = None
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=config.get("port", 3306),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=min(timeout_seconds, 10),
                read_timeout=timeout_seconds,
                write_timeout=timeout_seconds
            )
            cursor = conn.cursor()
            
            # Apply limit if specified
            query = _apply_optional_limit(sql_query, limit)
            
            cursor.execute(query, query_params)
            
            # Get column names
            columns = [desc[0] for desc in cursor.description]
            
            # Fetch data
            rows = cursor.fetchall()
            data = [dict(zip(columns, row)) for row in rows]

            return columns, data
            
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
    
    @staticmethod
    def _execute_bigquery(
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None,
        timeout_seconds: int = 30,
        skip_cost_check: bool = False,
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Execute query against BigQuery."""
        client = None
        try:
            project_id = config.get("project_id")
            
            client = _build_bigquery_client(config)
            
            # Apply limit if specified
            query = _apply_optional_limit(sql_query, limit)

            if not skip_cost_check:
                # Phase-15.59b — cost-check dry-run hits the SAME
                # ambiguous-column failure as the real query (BigQuery
                # validates syntax during dry-run). If the dry-run
                # fails specifically with "ambiguous", swallow it here
                # and skip the cost check — the dedup retry path below
                # will catch + retry the real query and may succeed.
                try:
                    estimated_bytes = DataSourceConnectionService._estimate_bigquery_bytes(config, query)
                    max_bytes = settings.BQ_MAX_BYTES_SCANNED
                    if estimated_bytes > max_bytes:
                        gb_est = estimated_bytes / (1024**3)
                        gb_max = max_bytes / (1024**3)
                        raise ValueError(
                            f"Query would scan {gb_est:.1f} GB (limit: {gb_max:.0f} GB). "
                            "Add filters or reduce selected columns before running it."
                        )
                except Exception as cost_err:
                    if "ambiguous" in str(cost_err).lower():
                        logger.info(
                            "[bq_dedup] cost-check dry-run hit ambiguous; "
                            "skipping cost check so retry-with-dedup can run."
                        )
                    else:
                        raise

            logger.info(f"Executing BigQuery query on project {project_id}")
            # Phase-15.58 — log the actual SQL string so DA can grep
            # backend logs when BigQuery rejects with cryptic errors
            # like "Column name is ambiguous". A 2-second snippet of
            # the SQL (first 1500 chars) is enough to spot a missing
            # table alias without dumping multi-KB queries.
            sql_preview = (query or "").strip().replace("\n", " ")
            if len(sql_preview) > 1500:
                sql_preview = sql_preview[:1500] + " ... [truncated]"
            logger.info(f"[bq_sql] {sql_preview}")

            try:
                query_job = client.query(query)
                results = query_job.result(timeout=timeout_seconds)
            except Exception as first_err:
                # Phase-15.58/59 — retry-with-dedup for ambiguous-column
                # failure. Try 2 strategies in order:
                #   1. LiveQueryService path: wrapper `(source) AS _appbi_live`
                #      → probe source schema + rewrite outer SELECT *.
                #   2. Semantic engine path: full SELECT with explicit
                #      column list. Dump SQL for human review — engine
                #      bug, can't auto-fix without breaking semantics.
                err_msg = str(first_err)
                if "ambiguous" not in err_msg.lower():
                    # The INFO preview above is truncated at 1500 chars,
                    # which hides the real failure site when the engine
                    # emits a multi-KB nested-CTE / EXISTS chain that BQ
                    # rejects (e.g. "Unexpected keyword SELECT at [419:76]").
                    # Dump the FULL SQL on ERROR so DA can match the line/col
                    # in the BQ error to the exact emitted text.
                    logger.error(
                        "[bq_sql_failed] BigQuery rejected query (full SQL follows). "
                        "err=%s\n----- FULL SQL -----\n%s\n----- END SQL -----",
                        err_msg, query,
                    )
                    raise
                logger.warning(
                    "[bq_dedup] ambiguous-column error received. SQL=%s",
                    (query or "").replace("\n", " ")[:2000],
                )
                rewritten = _bigquery_dedup_outer_select(client, query)
                if rewritten is None:
                    logger.error(
                        "[bq_dedup] dedup rewrite skipped — pattern not matched. "
                        "Likely semantic-engine emit bug. Re-raising original error."
                    )
                    raise
                logger.info(f"[bq_sql_retry] {rewritten[:1500]}")
                query_job = client.query(rewritten)
                results = query_job.result(timeout=timeout_seconds)
            
            # Get column names
            columns = [field.name for field in results.schema]
            
            # Fetch data and handle encoding issues
            data = []
            for row in results:
                row_dict = {}
                for key, value in row.items():
                    # Handle bytes/binary data
                    if isinstance(value, bytes):
                        try:
                            row_dict[key] = value.decode('utf-8')
                        except UnicodeDecodeError:
                            # If UTF-8 decode fails, use base64 encoding
                            import base64
                            row_dict[key] = base64.b64encode(value).decode('ascii')
                    else:
                        row_dict[key] = value
                data.append(row_dict)
            
            logger.info(f"BigQuery query completed. Rows returned: {len(data)}")
            return columns, data
            
        except Exception as e:
            logger.error(f"BigQuery execution failed on project {config.get('project_id')}: {str(e)}")
            raise
        finally:
            # Perf (#5): only close a client we OWN. A cached client is shared
            # across dashboard tiles for ~5 min; closing it here tore down the
            # warm transport and forced a rebuild on the next tile.
            if client and not _bq_client_is_cached(config, client):
                client.close()

    # ── Snapshot materialization DDL (Dashboard perf #5) ────────────────────
    # These are the ONLY DDL entrypoints. They deliberately bypass
    # `validate_select_only` + the SELECT cost-check because the CTAS body is
    # built solely from the engine's own `_sql_table_for_table` output (never
    # user free-text), and the target is always a fixed `appbi_snapshots.snap_*`
    # table. They use the write credential when one is configured.
    @staticmethod
    def extract_bigquery_for_snapshot(
        config: Dict[str, Any], sql: str, timeout_seconds: int = 280
    ) -> Tuple[list, List[Dict[str, Any]]]:
        """EXTRACT step of snapshot materialization: run `sql` with the datasource's
        OWN (read) credential and return (bq_schema, json_safe_rows). The schema is
        the source query's exact BigQuery schema so the LOAD preserves types 1:1
        (no autodetect drift — parity is non-negotiable). Rows are coerced to
        JSON-loadable values (dates→ISO, NUMERIC/Decimal→str, bytes→base64)."""
        import base64
        import datetime as _dt
        from decimal import Decimal
        client = None
        try:
            client = _build_bigquery_client(config)  # datasource READ credential
            job = client.query(sql)
            it = job.result(timeout=timeout_seconds)
            schema = list(it.schema)

            def _coerce(v):
                if v is None:
                    return None
                if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
                    return v.isoformat()
                if isinstance(v, Decimal):
                    return str(v)
                if isinstance(v, bytes):
                    return base64.b64encode(v).decode("ascii")
                if isinstance(v, dict):
                    return {k: _coerce(x) for k, x in v.items()}
                if isinstance(v, (list, tuple)):
                    return [_coerce(x) for x in v]
                return v

            rows = [{k: _coerce(val) for k, val in dict(r).items()} for r in it]
            return schema, rows
        finally:
            if client and not _bq_client_is_cached(config, client):
                client.close()

    @staticmethod
    def extract_generic_for_snapshot(
        ds_type: str, config: Dict[str, Any], sql: str,
        columns_meta: Optional[List[Dict[str, Any]]] = None, timeout_seconds: int = 280,
        effective_types_out: Optional[Dict[str, str]] = None,
    ) -> Tuple[Optional[list], List[Dict[str, Any]]]:
        """EXTRACT step for a NON-BigQuery source (Google Sheets / manual / other
        warehouse) in a federated dataset: run `sql` on the source's OWN engine and
        return (bq_schema, json_safe_rows) to LOAD into the host BigQuery.

        When ``columns_meta`` (the dataset table's declared columns_cache columns)
        is given, the BigQuery schema + per-value coercion are derived from the
        DECLARED types — NOT blind autodetect. This is critical for correctness:
        autodetect can type a join key differently than the BigQuery fact it joins
        (e.g. a dim key guessed INT64 while the fact key is STRING) → BQ then
        rejects the JOIN (`No matching signature for operator =`). Declared types
        keep join keys consistent. Falls back to autodetect (None) only when no
        column metadata is available.

        The declared type → BigQuery type mapping lives in ``physical_type_map``
        and is SHARED with the semantic engine's SAFE_CAST gates, so a token can
        never mean "text" to the loader and "number" to the engine (that split is
        what produced `SUM(STRING)` 400s on CSV/manual snapshots). Each column's
        declared type is then VERIFIED against the extracted values: a column the
        data does not honour (``"007"`` in a numeric column, ``"01/01/2026"`` in a
        DATE column) is loaded as STRING instead of corrupting values or failing
        the whole LOAD job. ``effective_types_out``, when given, receives the
        ``{column: BQ type}`` actually used so the caller can record it."""
        import base64
        import datetime as _dt
        import json as _json
        from decimal import Decimal

        def _json_safe(v):
            if v is None:
                return None
            if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
                return v.isoformat()
            if isinstance(v, Decimal):
                return str(v)
            if isinstance(v, bytes):
                return base64.b64encode(v).decode("ascii")
            if isinstance(v, dict):
                return {k: _json_safe(x) for k, x in v.items()}
            if isinstance(v, (list, tuple)):
                return [_json_safe(x) for x in v]
            return v

        def _bq_type(meta: Dict[str, Any]) -> str:
            # ONE shared vocabulary with the semantic engine's cast gates — see
            # app/services/physical_type_map.py for why this must not be a local
            # substring table (a dropped "number" token here typed every CSV
            # numeric column as STRING while the engine summed it uncast → 400).
            return _ptm.bq_extract_load_type(meta.get("source_type"), meta.get("type"))

        def _coerce_to(bq_t: str, v):
            """Coerce a JSON-safe value to match its declared BigQuery type so the
            LOAD never fails on a string-shaped number etc. Unparseable → NULL."""
            if v is None:
                return None
            try:
                if bq_t == "INT64":
                    return int(float(v)) if not isinstance(v, bool) else int(v)
                if bq_t == "FLOAT64":
                    return float(v)
                if bq_t in ("NUMERIC", "BIGNUMERIC"):
                    # Keep as STRING for the JSON load so BigQuery parses it as
                    # exact NUMERIC (float() would lose precision). Decimal was
                    # already str()'d by _json_safe; pass numbers through as str.
                    return v if isinstance(v, str) else str(v)
                if bq_t == "BOOL":
                    if isinstance(v, str):
                        return v.strip().lower() in ("true", "1", "yes", "t")
                    return bool(v)
                if bq_t in ("STRING",):
                    return v if isinstance(v, str) else (_json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v))
                return v  # DATE/TIME/TIMESTAMP already ISO strings
            except (TypeError, ValueError):
                return None

        # execute_query decrypts internally + validates SELECT-only; pass the
        # source datasource's (encrypted) config exactly like the chart path.
        _cols, rows, _ms = DataSourceConnectionService.execute_query(
            ds_type, config, sql, timeout_seconds=timeout_seconds,
        )
        safe_rows = [{k: _json_safe(val) for k, val in dict(r).items()} for r in rows]

        cols = [c for c in (columns_meta or []) if c.get("name")]
        if not cols:
            return None, safe_rows  # no metadata → autodetect fallback

        type_by_name = {c["name"]: _bq_type(c) for c in cols}
        # VERIFY the declared type against the data actually extracted. A
        # declared type the values do not honour is not worth betting a build on:
        # a bad DATE fails the whole BigQuery LOAD job, and "007"/"1,234" in a
        # numeric column would be silently corrupted or NULLed. Such a column
        # falls back to STRING — the caller records that (effective_types_out) so
        # the engine's gates SAFE_CAST it, exactly like a Google-Sheets column.
        for _name, _bt in list(type_by_name.items()):
            _verified = _ptm.verified_bq_type(_bt, (row.get(_name) for row in safe_rows))
            if _verified != _bt:
                logger.info(
                    "[snapshot] column %r declared %s but values do not fit → loading as STRING",
                    _name, _bt,
                )
                type_by_name[_name] = _verified
        if effective_types_out is not None:
            effective_types_out.clear()
            effective_types_out.update(type_by_name)
        bq_schema = [bigquery.SchemaField(name, bt) for name, bt in type_by_name.items()]
        typed_rows = [
            {name: _coerce_to(bt, row.get(name)) for name, bt in type_by_name.items()}
            for row in safe_rows
        ]
        return bq_schema, typed_rows

    @staticmethod
    def load_bigquery_snapshot(
        config: Dict[str, Any], dataset_name: str, table_name: str,
        bq_schema: list, rows: List[Dict[str, Any]], timeout_seconds: int = 280,
        *, partition_field: str | None = None, partition_type: str = "DAY",
        cluster_fields: Optional[List[str]] = None,
    ) -> int:
        """LOAD step: write `rows` into `<snapshot_dataset>.<table_name>` using the
        WRITE service account (materialization credential) with the EXACT source
        schema. WRITE_TRUNCATE = full replace. The write SA never reads the source.
        Returns loaded row count.

        Pha A — when ``partition_field`` / ``cluster_fields`` are given, the target
        table is created PARTITIONED (time-partitioning on that DATE/TIMESTAMP
        column) and/or CLUSTERED so chart-time queries prune partitions + cluster
        blocks instead of full-scanning a plain table. Caller (build_table_snapshot)
        validates the field types against the schema before passing them here."""
        mat_cfg = _materialization_bq_config(config)
        client = None
        try:
            client = _build_bigquery_client(mat_cfg)
            project = str(mat_cfg.get("project_id") or "").strip()
            table_ref = f"{project}.{dataset_name}.{table_name}"
            # BQ source → exact typed schema (parity). Non-BQ source (Sheets /
            # manual / other warehouse) passes no schema → autodetect from the
            # JSON value types, which mirrors the source engine's own typing.
            if bq_schema:
                job_config = bigquery.LoadJobConfig(
                    schema=bq_schema,
                    write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
                    source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
                )
            else:
                job_config = bigquery.LoadJobConfig(
                    autodetect=True,
                    write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
                    source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
                )
            if partition_field:
                _pt = {
                    "HOUR": bigquery.TimePartitioningType.HOUR,
                    "DAY": bigquery.TimePartitioningType.DAY,
                    "MONTH": bigquery.TimePartitioningType.MONTH,
                    "YEAR": bigquery.TimePartitioningType.YEAR,
                }.get(str(partition_type).upper(), bigquery.TimePartitioningType.DAY)
                job_config.time_partitioning = bigquery.TimePartitioning(type_=_pt, field=partition_field)
            if cluster_fields:
                job_config.clustering_fields = list(cluster_fields)[:4]
            job = client.load_table_from_json(rows, table_ref, job_config=job_config)
            job.result(timeout=timeout_seconds)
            return int(getattr(client.get_table(table_ref), "num_rows", len(rows)) or len(rows))
        finally:
            if client and not _bq_client_is_cached(mat_cfg, client):
                client.close()

    @staticmethod
    def bigquery_ctas_snapshot(
        *, host_config: Dict[str, Any], target_ref: str, resolved_sql: str,
        storage: Dict[str, Any], timeout_seconds: int = 280, location: str | None = None,
    ) -> Tuple[int, Optional[str]]:
        """BQ→BQ snapshot via a SINGLE ``CREATE OR REPLACE TABLE … PARTITION BY …
        CLUSTER BY … AS <resolved_sql>``. One query job writes every partition
        ONCE — so it never hits ``partition_modifications_per_column_partitioned_
        table`` the way N chunked WRITE_APPEND loads do (each re-touching the same
        day-partitions) — and the data never round-trips through the VM.

        Runs on the HOST materialization identity (same as the calendar CTAS +
        `execute_bigquery_ddl`). A free dry-run first gives the output schema (to
        build the PARTITION BY expression) AND doubles as a permission probe: if
        that identity can't read the source (2-account model) / cross-project /
        wrong location, this RAISES and the caller falls back to streaming.
        Returns (row_count, storage_warning). NEVER silently succeeds on error."""
        from app.services import dataset_snapshot_config as _sc

        mat_cfg = _materialization_bq_config(host_config)
        client = _build_bigquery_client(mat_cfg)
        try:
            dry = client.query(
                resolved_sql,
                job_config=bigquery.QueryJobConfig(dry_run=True, use_query_cache=False),
                **({"location": location} if location else {}),
            )
            schema = list(getattr(dry, "schema", []) or [])
            pf, gran, cf, warn = _sc.resolved_partition_cluster(storage, schema)
            types = {
                getattr(f, "name", None): str(getattr(f, "field_type", "") or getattr(f, "type_", "") or "").upper()
                for f in schema
            }
            clauses = []
            if pf:
                expr = _partition_by_expr(pf, types.get(pf, ""), gran)
                if expr:
                    clauses.append(f"PARTITION BY {expr}")
            if cf:
                clauses.append("CLUSTER BY " + ", ".join(f"`{c}`" for c in cf))
            ddl = (
                f"CREATE OR REPLACE TABLE `{target_ref}`\n"
                + ("\n".join(clauses) + "\n" if clauses else "")
                + "AS\n" + resolved_sql
            )
            job = client.query(ddl, **({"location": location} if location else {}))
            job.result(timeout=timeout_seconds)
            n = int(getattr(client.get_table(target_ref), "num_rows", 0) or 0)
            return n, warn
        finally:
            if client is not None and not _bq_client_is_cached(mat_cfg, client):
                client.close()

    @staticmethod
    def stream_extract_load_snapshot(
        *, source_ds_type: str, source_config: Dict[str, Any],
        resolved_sql: Optional[str], source_select_sql: Optional[str],
        columns_meta: Optional[List[Dict[str, Any]]],
        host_config: Dict[str, Any], dataset_name: str, table_name: str,
        storage: Dict[str, Any], chunk_size: Optional[int] = None,
        timeout_seconds: int = 280, progress_cb=None,
        effective_types_out: Optional[Dict[str, str]] = None,
    ) -> Tuple[int, Optional[str]]:
        """Batched EXTRACT+LOAD (Pha-C-lite): stream the source in bounded chunks
        and load into a PARTITIONED/CLUSTERED snapshot table — first chunk
        WRITE_TRUNCATE (creates the table + partition/cluster), the rest
        WRITE_APPEND. Bounds VM memory to ~chunk_size rows instead of holding the
        whole result set, and avoids the single-job 280s ceiling on huge tables.
        The target is built fresh (not the current pointer) so the caller's atomic
        swap keeps reads consistent; a mid-stream failure just orphans the partial
        table. Returns (row_count, storage_warning). ``effective_types_out``, when
        given, receives the ``{column: BigQuery type}`` the snapshot was ACTUALLY
        built with, so the caller can reconcile the model's recorded types with
        what the physical table holds."""
        import base64, datetime as _dt
        from decimal import Decimal
        from app.services import dataset_snapshot_config as _sc

        chunk_size = int(chunk_size or DataSourceConnectionService.STREAM_BATCH_SIZE)
        mat_cfg = _materialization_bq_config(host_config)
        write_client = _build_bigquery_client(mat_cfg)
        project = str(mat_cfg.get("project_id") or "").strip()
        table_ref = f"{project}.{dataset_name}.{table_name}"

        def _coerce(v):
            if v is None:
                return None
            if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
                return v.isoformat()
            if isinstance(v, Decimal):
                return str(v)
            if isinstance(v, bytes):
                return base64.b64encode(v).decode("ascii")
            if isinstance(v, dict):
                return {k: _coerce(x) for k, x in v.items()}
            if isinstance(v, (list, tuple)):
                return [_coerce(x) for x in v]
            return v

        # ── schema + a ROW GENERATOR (bounded memory) ──
        read_client = None
        if source_ds_type == "bigquery":
            read_client = _build_bigquery_client(source_config)
            job = read_client.query(resolved_sql)
            it = job.result(timeout=timeout_seconds)
            bq_schema = list(it.schema)
            if effective_types_out is not None:
                # BQ→BQ keeps the source's own schema, so the effective types are
                # simply what the source query returned.
                effective_types_out.clear()
                effective_types_out.update({
                    str(getattr(f, "name", "")): str(
                        getattr(f, "field_type", "") or getattr(f, "type_", "") or ""
                    ).upper()
                    for f in bq_schema
                    if getattr(f, "name", None)
                })
            def _rows():
                for r in it:  # RowIterator pages from BigQuery — bounded memory
                    yield {k: _coerce(val) for k, val in dict(r).items()}
        else:
            # Non-BQ (Sheets/manual/other warehouse): reuse the typed extract, which
            # applies DECLARED types (join-key correctness). Sheets are small; large
            # Postgres would stream via execute_query's cursor path upstream.
            bq_schema, safe_rows = DataSourceConnectionService.extract_generic_for_snapshot(
                source_ds_type, source_config, source_select_sql,
                columns_meta=columns_meta, timeout_seconds=timeout_seconds,
                effective_types_out=effective_types_out,
            )
            def _rows():
                for r in safe_rows:
                    yield r

        pf, pt, cf, warn = _sc.resolved_partition_cluster(storage, bq_schema)
        # When the target is PARTITIONED, load chunks into a NON-partitioned STAGING
        # table (no partition-modification quota) then do ONE CTAS into the
        # partitioned+clustered target — a single, bounded partition write. This
        # avoids `partition_modifications_per_column_partitioned_table` blowing up
        # from N chunked WRITE_APPENDs each re-touching the same day-partitions, and
        # works in the 2-account model (the write SA reads its OWN staging table).
        use_staging = bool(pf)
        load_ref = f"{table_ref}__stg" if use_staging else table_ref

        def _flush(buf: list, first: bool) -> None:
            if first:
                jc = bigquery.LoadJobConfig(
                    write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
                    source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
                )
                if bq_schema:
                    jc.schema = bq_schema
                else:
                    jc.autodetect = True
                # Staging is a PLAIN table (the CTAS re-partitions). A non-partitioned
                # but clustered target still clusters directly (no partition quota).
                if not use_staging and cf:
                    jc.clustering_fields = list(cf)[:4]
            else:
                jc = bigquery.LoadJobConfig(
                    write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
                    source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
                )
                if bq_schema:
                    jc.schema = bq_schema
            job2 = write_client.load_table_from_json(buf, load_ref, job_config=jc)
            job2.result(timeout=timeout_seconds)

        total, first, buf = 0, True, []
        try:
            for row in _rows():
                buf.append(row)
                if len(buf) >= chunk_size:
                    _flush(buf, first); total += len(buf); first = False; buf = []
                    if progress_cb:
                        progress_cb(total)
            # final chunk (also creates an empty table if the source had 0 rows,
            # so the generation stays complete)
            if buf or first:
                _flush(buf, first); total += len(buf)
                if progress_cb:
                    progress_cb(total)
            # ONE partition write: CTAS staging → partitioned+clustered target.
            if use_staging:
                types = {
                    getattr(f, "name", None): str(getattr(f, "field_type", "") or getattr(f, "type_", "") or "").upper()
                    for f in (bq_schema or [])
                }
                clauses = []
                expr = _partition_by_expr(pf, types.get(pf, ""), pt)
                if expr:
                    clauses.append(f"PARTITION BY {expr}")
                if cf:
                    clauses.append("CLUSTER BY " + ", ".join(f"`{c}`" for c in cf))
                ddl = (
                    f"CREATE OR REPLACE TABLE `{table_ref}`\n"
                    + ("\n".join(clauses) + "\n" if clauses else "")
                    + f"AS SELECT * FROM `{load_ref}`"
                )
                write_client.query(ddl).result(timeout=timeout_seconds)
        finally:
            if use_staging:
                try:
                    write_client.query(f"DROP TABLE IF EXISTS `{load_ref}`").result(timeout=60)
                except Exception:  # noqa: BLE001 — staging cleanup best-effort
                    logger.warning("[snapshot] staging drop failed %s", load_ref, exc_info=True)
            if read_client is not None and not _bq_client_is_cached(source_config, read_client):
                read_client.close()
            if write_client is not None and not _bq_client_is_cached(mat_cfg, write_client):
                write_client.close()
        return int(total), warn

    @staticmethod
    def try_partition_incremental_snapshot(
        *, source_config: Dict[str, Any], source_table_name: str, partition_field: str,
        host_config: Dict[str, Any], dataset_name: str, new_table_name: str,
        clone_from_ref: Optional[str], since, timeout_seconds: int = 280,
        max_changed_partitions: int = 60, progress_cb=None,
    ) -> Optional[Dict[str, Any]]:
        """Task-1 partition-scoped incremental refresh for a DIRECT physical table.

        Eligible only when the SOURCE is a real time-partitioned BigQuery table
        partitioned on `partition_field`, there is a previous snapshot to clone,
        and a manageable number of partitions changed. Then: zero-copy CLONE the
        previous snapshot into the new generation table and re-load ONLY the source
        partitions modified since `since` (source pruning → scans just those). Old
        partitions ride along in the clone untouched — no full re-scan.

        Returns {row_count, changed} on success, or None when not eligible (caller
        falls back to the full batched rebuild). NEVER mutates the previous
        snapshot table (generation immutability preserved)."""
        from app.core.crypto import decrypt_config
        if not clone_from_ref or since is None:
            return None
        src = decrypt_config(source_config)
        read_client = _build_bigquery_client(src)
        mat = _materialization_bq_config(host_config)
        write_client = None
        try:
            src_project = str(src.get("project_id") or "").strip()
            raw = str(source_table_name or "").strip().strip("`")
            src_fqn = raw if raw.count(".") >= 2 else f"{src_project}.{raw}"
            # 1) source must be time-partitioned on exactly `partition_field`
            st = read_client.get_table(src_fqn)
            tp = getattr(st, "time_partitioning", None)
            if tp is None or tp.field != partition_field:
                return None
            gran = str(tp.type_ or "DAY").upper()
            col_type = next((f.field_type.upper() for f in st.schema if f.name == partition_field), "DATE")
            proj_ds = src_fqn.rsplit(".", 1)[0]
            tbl_only = src_fqn.rsplit(".", 1)[1]
            # 2) partitions changed since the last snapshot build
            q = read_client.query(
                f"SELECT partition_id FROM `{proj_ds}.INFORMATION_SCHEMA.PARTITIONS` "
                f"WHERE table_name = @t AND partition_id NOT IN ('__NULL__','__UNPARTITIONED__') "
                f"AND last_modified_time > @since",
                job_config=bigquery.QueryJobConfig(query_parameters=[
                    bigquery.ScalarQueryParameter("t", "STRING", tbl_only),
                    bigquery.ScalarQueryParameter("since", "TIMESTAMP", since),
                ]),
            )
            changed = [r.partition_id for r in q.result(timeout=timeout_seconds)]
            if not changed or len(changed) > max_changed_partitions:
                return None  # nothing (Nấc A handles) / too many → full rebuild is simpler
            # 3) zero-copy CLONE previous snapshot → new generation table
            write_client = _build_bigquery_client(mat)
            mat_project = str(mat.get("project_id") or "").strip()
            new_ref = f"{mat_project}.{dataset_name}.{new_table_name}"
            write_client.query(f"CREATE OR REPLACE TABLE `{new_ref}` CLONE `{clone_from_ref}`").result(timeout=timeout_seconds)
            # 4) re-load ONLY the changed partitions (source prunes to each)
            def _lit(v):
                return f"{col_type} '{v}'" if col_type in ("DATE", "DATETIME", "TIMESTAMP") else f"'{v}'"
            for pid in changed:
                lo, hi = _partition_bounds(pid, gran)
                sel = (f"SELECT * FROM `{src_fqn}` WHERE `{partition_field}` >= {_lit(lo)} "
                       f"AND `{partition_field}` < {_lit(hi)}")
                schema, rows = DataSourceConnectionService.extract_bigquery_for_snapshot(
                    source_config, sel, timeout_seconds=timeout_seconds
                )
                # WRITE_TRUNCATE into the partition decorator → replaces just that
                # partition; do NOT re-declare partition/cluster (inherited from clone).
                DataSourceConnectionService.load_bigquery_snapshot(
                    host_config, dataset_name, f"{new_table_name}${pid}", schema, rows,
                    timeout_seconds=timeout_seconds,
                )
                if progress_cb:
                    progress_cb(len(changed))
            n = int(getattr(write_client.get_table(new_ref), "num_rows", 0) or 0)
            return {"row_count": n, "changed": changed}
        except Exception as exc:  # noqa: BLE001 — any failure → caller full-rebuilds
            logger.warning("[snapshot] partition-incremental not applied (%s) — full rebuild", str(exc)[:200])
            return None
        finally:
            if read_client is not None and not _bq_client_is_cached(src, read_client):
                read_client.close()
            if write_client is not None and not _bq_client_is_cached(mat, write_client):
                write_client.close()

    @staticmethod
    def snapshot_query_config(config: Dict[str, Any]) -> Dict[str, Any]:
        """Config for READING snapshot tables at chart time — uses the write
        service account (which is the only identity granted on the SA-only
        snapshot dataset). Returns a decrypted config ready for execute_query."""
        return _materialization_bq_config(config)

    @staticmethod
    def bigquery_source_watermark(config: Dict[str, Any], sql: str, timeout_seconds: int = 30):
        """MAX(last_modified_time) across the source tables that `sql` reads,
        for change-driven snapshot refresh (perf #5). Resolves the referenced
        tables via a FREE dry-run (no scan / no cost), then reads each table's
        `.modified` from metadata. Uses the datasource's READ credential (the SA
        can't see source). Returns a tz-aware UTC datetime, or None when it
        can't be determined (no refs / view / federated / permission) → callers
        fall back to TTL. NEVER raises."""
        from app.core.crypto import decrypt_config
        dc = decrypt_config(config)
        client = None
        try:
            client = _build_bigquery_client(dc)
            job = client.query(
                sql,
                job_config=bigquery.QueryJobConfig(dry_run=True, use_query_cache=False),
            )
            refs = list(getattr(job, "referenced_tables", []) or [])
            mods = []
            for ref in refs:
                try:
                    t = client.get_table(ref)
                    if getattr(t, "modified", None) is not None:
                        mods.append(t.modified)
                except Exception:  # noqa: BLE001 — skip tables we can't stat
                    continue
            return max(mods) if mods else None
        except Exception:  # noqa: BLE001 — watermark is best-effort → None → TTL fallback
            logger.debug("[snapshot] source watermark unavailable", exc_info=True)
            return None
        finally:
            if client and not _bq_client_is_cached(dc, client):
                client.close()

    @staticmethod
    def bigquery_count(config: Dict[str, Any], sql: str, timeout_seconds: int = 120) -> Optional[int]:
        """Row count of a BigQuery source query — the sync %-of-total denominator
        on a FIRST sync (no prior snapshot row_count to estimate from). One COUNT
        scan, on the source's READ credential (so no write-SA permission issue).
        Best-effort → None on any error (caller falls back to a table-count %)."""
        from app.core.crypto import decrypt_config
        dc = decrypt_config(config)
        client = None
        try:
            client = _build_bigquery_client(dc)
            job = client.query(f"SELECT COUNT(*) AS c FROM (\n{sql}\n) AS _src")
            rows = list(job.result(timeout=timeout_seconds))
            return int(rows[0]["c"]) if rows else None
        except Exception:  # noqa: BLE001 — estimate is best-effort
            logger.debug("[snapshot] source count unavailable", exc_info=True)
            return None
        finally:
            if client and not _bq_client_is_cached(dc, client):
                client.close()

    @staticmethod
    def get_bigquery_location(config: Dict[str, Any]) -> str | None:
        """Location of the source's default dataset, so a snapshot dataset can be
        COLOCATED (BQ cannot CTAS across locations). None → BQ default (US).
        Uses the READ credential (it can see the source dataset)."""
        from app.core.crypto import decrypt_config
        dc = decrypt_config(config)
        default_ds = str(dc.get("default_dataset") or "").strip()
        if not default_ds:
            return None
        client = None
        try:
            client = _build_bigquery_client(dc)
            project = str(dc.get("project_id") or "").strip()
            return client.get_dataset(f"{project}.{default_ds}").location
        except Exception:
            return None
        finally:
            if client and not _bq_client_is_cached(dc, client):
                client.close()

    @staticmethod
    def execute_bigquery_ddl(
        config: Dict[str, Any], ddl_sql: str, timeout_seconds: int = 300,
        location: str | None = None,
    ) -> Dict[str, Any]:
        """Run a DDL/CTAS statement on BigQuery. Returns job stats. `location`
        pins the job to the source location (required for cross-dataset CTAS)."""
        mat_cfg = _materialization_bq_config(config)
        client = None
        t0 = time.time()
        try:
            client = _build_bigquery_client(mat_cfg)
            job = client.query(ddl_sql, location=location) if location else client.query(ddl_sql)
            job.result(timeout=timeout_seconds)
            return {
                "ok": True,
                "elapsed_ms": int((time.time() - t0) * 1000),
                "affected_rows": getattr(job, "num_dml_affected_rows", None),
            }
        finally:
            if client and not _bq_client_is_cached(mat_cfg, client):
                client.close()

    @staticmethod
    def ensure_bigquery_dataset(
        config: Dict[str, Any], dataset_name: str, location: str | None = None
    ) -> None:
        """Make sure the snapshot dataset exists — tolerant of the strict-perms
        model. Checks existence FIRST (needs only read/get, which the write SA's
        dataEditor grants); only attempts create when it's missing. So a SA that
        has dataEditor on a PRE-CREATED dataset but NO project-level
        `datasets.create` never hits a 403 here.

        Snapshot tables must NOT auto-expire. A dataset-level default expiration
        makes BigQuery silently drop the physical snapshot tables after N days
        while the registry still marks them current — every chart on the dataset
        then reads a dead ref and errors until a manual Dataset Refresh. Superseded
        snapshots are GC'd explicitly on each atomic swap (build_table_snapshot),
        so no default expiration is set. A legacy dataset that still carries one
        (the old 2-day default) has it CLEARED here so future rebuilds persist."""
        from google.api_core.exceptions import NotFound
        mat_cfg = _materialization_bq_config(config)
        client = None
        try:
            client = _build_bigquery_client(mat_cfg)
            project = str(mat_cfg.get("project_id") or "").strip()
            ref = f"{project}.{dataset_name}"
            try:
                existing = client.get_dataset(ref)
                # Legacy datasets were created with a 2-day default expiration,
                # which dropped still-current snapshot tables and broke dashboards.
                # Clear it (best-effort) so rebuilt snapshots stop expiring.
                if existing.default_table_expiration_ms is not None:
                    existing.default_table_expiration_ms = None
                    try:
                        client.update_dataset(existing, ["default_table_expiration_ms"])
                        logger.info("[snapshot] cleared legacy default_table_expiration on %s", ref)
                    except Exception:  # noqa: BLE001 — not fatal; build still proceeds
                        logger.warning("[snapshot] could not clear default expiration on %s", ref, exc_info=True)
                return  # already exists → no create needed (strict-perms friendly)
            except NotFound:
                pass
            ds = bigquery.Dataset(ref)
            if location:
                ds.location = location
            # No default_table_expiration_ms: a fixed expiry would silently drop a
            # still-current snapshot. Cleanup is explicit (GC on swap).
            client.create_dataset(ds, exists_ok=True)
        finally:
            if client and not _bq_client_is_cached(mat_cfg, client):
                client.close()

    @staticmethod
    def drop_bigquery_table(config: Dict[str, Any], physical_ref: str) -> None:
        mat_cfg = _materialization_bq_config(config)
        client = None
        try:
            client = _build_bigquery_client(mat_cfg)
            client.delete_table(physical_ref, not_found_ok=True)
        finally:
            if client and not _bq_client_is_cached(mat_cfg, client):
                client.close()

    @staticmethod
    def get_bigquery_table_num_rows(config: Dict[str, Any], physical_ref: str) -> int | None:
        mat_cfg = _materialization_bq_config(config)
        client = None
        try:
            client = _build_bigquery_client(mat_cfg)
            return int(client.get_table(physical_ref).num_rows)
        except Exception:
            return None
        finally:
            if client and not _bq_client_is_cached(mat_cfg, client):
                client.close()

    @staticmethod
    def verify_bigquery_dataset_writable(
        config: Dict[str, Any], dataset_name: str, location: str | None = None
    ) -> Tuple[bool, str | None]:
        """Preflight: can we create + drop a table in the snapshot dataset?
        Returns (ok, error). Never raises — a False result → caller falls back to
        live execution."""
        try:
            DataSourceConnectionService.ensure_bigquery_dataset(config, dataset_name, location)
            project = str(_materialization_bq_config(config).get("project_id") or "").strip()
            probe = f"{project}.{dataset_name}.appbi_wtest_{int(time.time())}"
            DataSourceConnectionService.execute_bigquery_ddl(
                config, f"CREATE OR REPLACE TABLE `{probe}` AS SELECT 1 AS x", timeout_seconds=60
            )
            DataSourceConnectionService.drop_bigquery_table(config, probe)
            return True, None
        except Exception as e:
            return False, str(e)

    @staticmethod
    def _estimate_bigquery_bytes(config: Dict[str, Any], sql_query: str) -> int:
        """Dry-run a BigQuery query and return estimated bytes processed."""
        client = None
        try:
            project_id = config.get("project_id")
            client = _build_bigquery_client(config)
            job_config = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)
            job = client.query(sql_query, job_config=job_config)
            return int(job.total_bytes_processed or 0)
        finally:
            # Perf (#5): never close a cached (warm) client — see _execute_bigquery.
            if client and not _bq_client_is_cached(config, client):
                client.close()

    # ── Streaming methods (for sync / large-table ingestion) ──────────────────
    # These return (columns, generator_of_row_batches) so callers can write
    # data to Parquet incrementally without loading the entire result set into
    # RAM.  Each yielded batch is a list of dicts with at most `batch_size`
    # items.
    # Larger batches = fewer DB round-trips AND larger Parquet row groups,
    # which dramatically speeds DuckDB zone-map pushdown on 100M+ row tables.
    STREAM_BATCH_SIZE = int(os.environ.get("SYNC_STREAM_BATCH_SIZE", "50000"))

    @staticmethod
    def _stream_postgresql(
        config: Dict[str, Any],
        sql_query: str,
        timeout_seconds: int = 3600,
    ) -> Tuple[List[str], Generator[List[Dict[str, Any]], None, None]]:
        """Stream rows from PostgreSQL using a server-side cursor."""
        conn = psycopg2.connect(
            host=config.get("host"),
            port=config.get("port", 5432),
            database=config.get("database"),
            user=config.get("username"),
            password=config.get("password"),
            connect_timeout=min(timeout_seconds, 10),
        )
        try:
            conn.autocommit = False  # Required for server-side cursors

            # SET commands must run on a regular cursor, not the named
            # (server-side) one — psycopg2 wraps named-cursor queries in
            # DECLARE ... CURSOR FOR ..., which causes a syntax error.
            setup_cur = conn.cursor()
            setup_cur.execute(f"SET statement_timeout = {timeout_seconds * 1000}")
            schema = config.get("schema_name") or config.get("schema")
            if schema:
                setup_cur.execute(f"SET search_path TO {schema}")
            setup_cur.close()

            cursor = conn.cursor(name="sync_stream_cursor")
            cursor.itersize = DataSourceConnectionService.STREAM_BATCH_SIZE
            cursor.execute(sql_query)

            # Server-side (named) cursors don't populate .description
            # until the first fetch, so we must fetch before reading it.
            first_batch = cursor.fetchmany(
                DataSourceConnectionService.STREAM_BATCH_SIZE
            )

            if cursor.description:
                columns = [desc[0] for desc in cursor.description]
            else:
                # Empty result — get column names via a regular cursor.
                cursor.close()
                meta_cur = conn.cursor()
                meta_cur.execute(sql_query + " LIMIT 0")
                columns = [desc[0] for desc in meta_cur.description]
                meta_cur.close()
                # No data to stream — return empty generator
                def _empty():
                    conn.close()
                    return
                    yield  # noqa: make this a generator
                return columns, _empty()

            def _gen():
                try:
                    yield [dict(zip(columns, r)) for r in first_batch]
                    while True:
                        rows = cursor.fetchmany(
                            DataSourceConnectionService.STREAM_BATCH_SIZE
                        )
                        if not rows:
                            break
                        yield [dict(zip(columns, r)) for r in rows]
                finally:
                    cursor.close()
                    conn.close()

            return columns, _gen()
        except Exception:
            conn.close()
            raise

    @staticmethod
    def _stream_mysql(
        config: Dict[str, Any],
        sql_query: str,
        timeout_seconds: int = 3600,
    ) -> Tuple[List[str], Generator[List[Dict[str, Any]], None, None]]:
        """Stream rows from MySQL using SSDictCursor (server-side streaming)."""
        conn = pymysql.connect(
            host=config.get("host"),
            port=config.get("port", 3306),
            database=config.get("database"),
            user=config.get("username"),
            password=config.get("password"),
            connect_timeout=min(timeout_seconds, 10),
            read_timeout=timeout_seconds,
            write_timeout=timeout_seconds,
        )
        try:
            cursor = conn.cursor(pymysql.cursors.SSCursor)
            cursor.execute(sql_query)

            columns = [desc[0] for desc in cursor.description]

            def _gen():
                try:
                    while True:
                        rows = cursor.fetchmany(DataSourceConnectionService.STREAM_BATCH_SIZE)
                        if not rows:
                            break
                        yield [dict(zip(columns, r)) for r in rows]
                finally:
                    cursor.close()
                    conn.close()

            return columns, _gen()
        except Exception:
            conn.close()
            raise

    @staticmethod
    def _stream_bigquery(
        config: Dict[str, Any],
        sql_query: str,
        timeout_seconds: int = 3600,
    ) -> Tuple[List[str], Generator[List[Dict[str, Any]], None, None]]:
        """Stream rows from BigQuery using page iteration (constant memory)."""
        project_id = config.get("project_id")

        client = _build_bigquery_client(config)

        try:
            logger.info("Streaming BigQuery query on project %s", project_id)
            query_job = client.query(sql_query)
            result_iter = query_job.result(
                timeout=timeout_seconds,
                page_size=DataSourceConnectionService.STREAM_BATCH_SIZE,
            )

            columns = [field.name for field in result_iter.schema]

            def _gen():
                try:
                    batch: List[Dict[str, Any]] = []
                    for row in result_iter:
                        row_dict = {}
                        for key, value in row.items():
                            if isinstance(value, bytes):
                                try:
                                    row_dict[key] = value.decode("utf-8")
                                except UnicodeDecodeError:
                                    row_dict[key] = base64.b64encode(value).decode("ascii")
                            else:
                                row_dict[key] = value
                        batch.append(row_dict)
                        if len(batch) >= DataSourceConnectionService.STREAM_BATCH_SIZE:
                            yield batch
                            batch = []
                    if batch:
                        yield batch
                finally:
                    client.close()

            return columns, _gen()
        except Exception:
            client.close()
            raise

    @staticmethod
    def stream_bigquery_arrow(
        config: Dict[str, Any],
        sql_query: str,
        timeout_seconds: int = 3600,
    ) -> Generator["pa.RecordBatch", None, None]:
        """
        Stream BigQuery results as Arrow RecordBatches **directly**.

        This is 3-5x faster than `_stream_bigquery()` because:
        - BigQuery returns data in Arrow wire format natively
        - No row-by-row Python dict conversion
        - RecordBatches are written to Parquet with zero-copy

        Yields pa.RecordBatch objects (not list-of-dicts).
        Caller must handle pyarrow import.
        """
        import pyarrow as pa

        project_id = config.get("project_id")

        client = _build_bigquery_client(config)

        try:
            logger.info("Streaming BigQuery (Arrow) query on project %s", project_id)
            query_job = client.query(sql_query)
            result_iter = query_job.result(timeout=timeout_seconds)

            for record_batch in result_iter.to_arrow_iterable():
                yield record_batch
        finally:
            client.close()

    @staticmethod
    def stream_table_data(
        ds_type: str,
        config: Dict[str, Any],
        schema: str,
        table: str,
    ) -> Tuple[List[str], Generator[List[Dict[str, Any]], None, None]]:
        """
        Stream rows from a table in constant-memory batches.

        Returns (column_names, generator_of_batches) where each batch is a
        list of dicts with at most STREAM_BATCH_SIZE items.

        For datasource types that don't support streaming (Google Sheets,
        Manual), falls back to a single-batch wrapper around fetch_table_data.
        """
        from app.core.crypto import decrypt_config
        raw_config = config  # keep original for fallback (fetch_table_data decrypts internally)
        config = decrypt_config(config)

        ds_type_val = ds_type if isinstance(ds_type, str) else ds_type.value

        if ds_type_val == DataSourceType.POSTGRESQL.value:
            real_schema = schema if schema != "default" else (
                config.get("schema_name") or config.get("schema") or "public"
            )
            sql = f'SELECT * FROM "{real_schema}"."{table}"'
            return DataSourceConnectionService._stream_postgresql(config, sql)

        elif ds_type_val == DataSourceType.MYSQL.value:
            real_schema = schema if schema != "default" else (
                config.get("database") or schema
            )
            sql = f'SELECT * FROM `{real_schema}`.`{table}`'
            return DataSourceConnectionService._stream_mysql(config, sql)

        elif ds_type_val == DataSourceType.BIGQUERY.value:
            project_id = config.get("project_id", "")
            sql = f"SELECT * FROM `{project_id}.{schema}.{table}`"
            return DataSourceConnectionService._stream_bigquery(config, sql)

        else:
            # Google Sheets / Manual — data is small, wrap in single batch
            cols, rows = DataSourceConnectionService.fetch_table_data(
                ds_type, raw_config, schema, table,
            )

            def _single_batch():
                if rows:
                    yield rows

            return cols, _single_batch()

    @staticmethod
    def stream_query(
        ds_type: str,
        config: Dict[str, Any],
        sql_query: str,
        timeout_seconds: int = 3600,
    ) -> Tuple[List[str], Generator[List[Dict[str, Any]], None, None]]:
        """
        Stream an arbitrary SQL query in constant-memory batches.

        Used by sync engine for incremental queries (WHERE watermark > ...).
        For datasource types without streaming support, falls back to
        execute_query wrapped in a single batch.
        """
        from app.core.crypto import decrypt_config
        from app.services.sql_validator import validate_select_only

        validate_select_only(sql_query)
        raw_config = config  # keep for fallback (execute_query decrypts internally)
        config = decrypt_config(config)

        ds_type_val = ds_type if isinstance(ds_type, str) else ds_type.value

        if ds_type_val == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._stream_postgresql(
                config, sql_query, timeout_seconds,
            )
        elif ds_type_val == DataSourceType.MYSQL.value:
            return DataSourceConnectionService._stream_mysql(
                config, sql_query, timeout_seconds,
            )
        elif ds_type_val == DataSourceType.BIGQUERY.value:
            return DataSourceConnectionService._stream_bigquery(
                config, sql_query, timeout_seconds,
            )
        else:
            # Fallback: load-all and wrap
            col_names, rows, _ = DataSourceConnectionService.execute_query(
                ds_type, raw_config, sql_query, limit=None,
                timeout_seconds=timeout_seconds,
            )

            def _single():
                if rows:
                    yield rows

            return col_names, _single()

    @staticmethod
    def infer_column_types(
        ds_type: str,
        config: Dict[str, Any],
        sql_query: str
    ) -> List[Dict[str, str]]:
        """
        Infer column types from a query result.

        Args:
            ds_type: Type of data source
            config: Connection configuration
            sql_query: SQL query

        Returns:
            List of column metadata dicts. Each entry has:
            - `name`: original column name as returned by the engine (kept for back-compat
              with consumers that still query by raw label, e.g. older datasets stored
              with Vietnamese identifiers).
            - `display_name`: user-facing label, identical to `name` here.
            - `safe_name`: deterministic ASCII snake_case identifier suitable for
              calculated-field references (`[safe_name]`) and any new SQL composition.
              Always unique within the result set.
            - `type`: inferred SQL type token.
        """
        try:
            if ds_type == DataSourceType.POSTGRESQL.value:
                raw = DataSourceConnectionService._infer_postgresql_types(config, sql_query)
            elif ds_type == DataSourceType.MYSQL.value:
                raw = DataSourceConnectionService._infer_mysql_types(config, sql_query)
            elif ds_type == DataSourceType.BIGQUERY.value:
                raw = DataSourceConnectionService._infer_bigquery_types(config, sql_query)
            elif ds_type == DataSourceType.GOOGLE_SHEETS.value:
                raw = DataSourceConnectionService._infer_google_sheets_types(config, sql_query)
            elif ds_type == DataSourceType.MANUAL.value:
                raw = DataSourceConnectionService._infer_manual_types(config, sql_query)
            else:
                raise ValueError(f"Unsupported data source type: {ds_type}")
            return DataSourceConnectionService._enrich_columns_with_safe_names(raw)
        except Exception as e:
            logger.error(f"Type inference failed: {str(e)}")
            raise

    @staticmethod
    def _enrich_columns_with_safe_names(columns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Attach `display_name` and `safe_name` to each column entry without mutating `name`.

        Existing dataset rows still address columns via the original `name`; the new
        `safe_name` is purely additive and is the canonical reference for new code paths
        such as calculated-field formulas.
        """
        from app.services.identifier_utils import normalize_column_identifier

        enriched: List[Dict[str, Any]] = []
        used_safe_names: List[str] = []
        for entry in columns or []:
            if not isinstance(entry, dict):
                continue
            original_name = str(entry.get("name") or "")
            existing_display = entry.get("display_name")
            existing_safe = entry.get("safe_name")
            display_name = str(existing_display) if existing_display else original_name
            if existing_safe:
                safe_name = str(existing_safe)
            else:
                safe_name = normalize_column_identifier(
                    original_name or display_name,
                    existing=used_safe_names,
                    fallback="col",
                )
            used_safe_names.append(safe_name)
            merged = dict(entry)
            merged["name"] = original_name
            merged["display_name"] = display_name
            merged["safe_name"] = safe_name
            enriched.append(merged)
        return enriched
    
    @staticmethod
    def _infer_postgresql_types(config: Dict[str, Any], sql_query: str) -> List[Dict[str, str]]:
        """Infer column types from PostgreSQL query.

        Decrypts the config first. Execution paths (`execute_query`,
        `list_tables`) decrypt upfront, but the type-inference paths receive the
        RAW stored config, where `password` is still the `_enc:…` ciphertext — so
        this connect failed authentication, physical-type resolution silently
        returned nothing, and every Postgres column fell back to its
        value-sampled type (the same class of bug as `_build_gcp_credentials`
        already documents for BigQuery). `decrypt_config` is idempotent."""
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)
        conn = None
        cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password")
            )
            cursor = conn.cursor()
            
            # Execute with LIMIT 0 to get column info without data
            cursor.execute(f"{sql_query.rstrip(';')} LIMIT 0")
            
            columns = []
            for desc in cursor.description:
                columns.append({
                    "name": desc[0],
                    "type": DataSourceConnectionService._pg_type_to_string(desc[1]),
                    "_oid": desc[1],
                })
            # Anything the static OID map missed (enums, domains, extension
            # types) is resolved from the catalog on this same connection.
            DataSourceConnectionService._pg_resolve_unknown_oids(cursor, columns)
            for col in columns:
                col.pop("_oid", None)

            return columns

        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
    
    @staticmethod
    def _infer_mysql_types(config: Dict[str, Any], sql_query: str) -> List[Dict[str, str]]:
        """Infer column types from MySQL query.

        Decrypts the config first — see `_infer_postgresql_types` for why the
        inference paths cannot assume a pre-decrypted config."""
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)
        conn = None
        cursor = None
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=config.get("port", 3306),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password")
            )
            cursor = conn.cursor()
            
            # Execute with LIMIT 0 to get column info without data
            cursor.execute(f"{sql_query.rstrip(';')} LIMIT 0")
            
            columns = []
            for desc in cursor.description:
                columns.append({
                    "name": desc[0],
                    "type": DataSourceConnectionService._mysql_type_to_string(desc[1])
                })
            
            return columns
            
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
    
    @staticmethod
    def _infer_bigquery_types(config: Dict[str, Any], sql_query: str) -> List[Dict[str, str]]:
        """Infer column types from BigQuery query."""
        client = None
        try:
            project_id = config.get("project_id")
            
            client = _build_bigquery_client(config)
            
            logger.info(f"Inferring BigQuery schema for project {project_id}")
            
            # Use dry run to get schema without executing
            job_config = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)
            query_job = client.query(sql_query, job_config=job_config)
            
            columns = []
            for field in query_job.schema:
                columns.append({
                    "name": field.name,
                    "type": field.field_type.lower()
                })
            
            logger.info(f"BigQuery schema inference completed. Columns: {len(columns)}")
            return columns
            
        except Exception as e:
            logger.error(f"BigQuery schema inference failed on project {config.get('project_id')}: {str(e)}")
            raise
        finally:
            if client:
                client.close()
    
    @staticmethod
    def _infer_manual_types(config: Dict[str, Any], sql_query: str) -> List[Dict[str, str]]:
        """Physical column types for an imported-file (manual) datasource.

        An imported file has no warehouse schema, so its physical types are the
        ones the query ENGINE produces. The query is executed (LIMIT 0) on the
        same DuckDB the live path uses, and DuckDB's own result schema is
        reported. That matters for more than tidiness:

        * a column declared ``number`` on upload materialises as DuckDB
          ``DOUBLE`` — reporting the width-less label ``number`` instead made the
          snapshot loader read it as text and store CSV numbers as STRING, so
          ``SUM`` worked in preview and 400'd on the dashboard;
        * the SQL passed here is the table's FULL projection (transformations and
          type overrides included), so a computed column or a DA's "this column
          is a date" conversion is described too. Reading the sheet's declared
          columns instead — the previous behaviour — could not see either, and a
          converted date column was recorded as text.

        Falls back to the sheet's declared columns when DuckDB is unavailable."""
        try:
            from app.services.manual_table_connector import (
                create_manual_table_connector,
                extract_sheet_name_from_sql,
            )
            connector = create_manual_table_connector(config)
            try:
                cols = DataSourceConnectionService._duckdb_result_types(
                    config, sql_query, source="manual",
                )
                if cols:
                    return cols
            except Exception as exc:  # noqa: BLE001 — fall back to declarations
                logger.info("Manual DuckDB type probe failed (%s); using declared types", exc)
            sheet_name = extract_sheet_name_from_sql(sql_query)
            data = connector.get_sheet_data(sheet_name)
            return [
                {
                    "name": col["name"],
                    "type": (
                        "double"
                        if str(col.get("type") or "").strip().lower() == "number"
                        else "string"
                    ),
                }
                for col in data["columns"]
            ]
        except Exception as e:
            logger.error(f"Manual type inference failed: {str(e)}")
            raise

    @staticmethod
    def _duckdb_result_types(
        config: Dict[str, Any], sql_query: str, *, source: str
    ) -> List[Dict[str, str]]:
        """``[{name, type}]`` for a manual / Google-Sheets query, read from what
        the DuckDB engine actually RETURNS.

        Schema-less sources have no catalog to ask, so the engine that executes
        the query is the only honest authority on its types — and it is the same
        engine the live path uses, which is exactly why this closes the gap: the
        recorded physical type, the snapshot column type, and the type charts read
        can no longer disagree. A handful of rows is enough (these sources are
        small and their reads are cached), and a column whose sample is entirely
        NULL stays ``string`` — the conservative choice, since the loader then
        keeps it as text and the engine SAFE_CASTs it."""
        cols, rows, _ms = DataSourceConnectionService.execute_query(
            source, config, sql_query, limit=20, timeout_seconds=120,
        )
        out: List[Dict[str, str]] = []
        for name in (cols or []):
            token = "string"
            for row in (rows or []):
                value = row.get(name) if isinstance(row, dict) else None
                if value is None:
                    continue
                token = _python_value_type_token(value)
                break
            out.append({"name": str(name), "type": token})
        return out

    @staticmethod
    def _infer_google_sheets_types(config: Dict[str, Any], sql_query: str) -> List[Dict[str, str]]:
        """Physical column types for a Google Sheets query.

        Sheet cells arrive as text, so most columns genuinely ARE text — that part
        never changed. What did change: the types are now read from what the
        engine RETURNS rather than hard-coded to ``string``, so a column the DA
        converted with a type override, or one produced by a transformation, is
        described as the number/date it has become. Hard-coding ``string`` meant a
        converted Sheets column was still materialized as text in the snapshot.
        Falls back to all-``string`` (the previous behaviour) on any probe
        failure."""
        try:
            from app.core.crypto import decrypt_config

            live_config = decrypt_config(config)
            try:
                probed = DataSourceConnectionService._duckdb_result_types(
                    live_config, sql_query, source="google_sheets",
                )
                if probed:
                    return probed
            except Exception as exc:  # noqa: BLE001
                logger.info("Sheets type probe failed (%s); assuming text columns", exc)
            columns, _ = DataSourceConnectionService._execute_google_sheets(
                live_config,
                sql_query,
                limit=1,
            )
            return [{"name": str(column), "type": "string"} for column in columns]
        except Exception as e:
            logger.error(f"Google Sheets type inference failed: {str(e)}")
            raise

    @staticmethod
    def _pg_type_to_string(type_code: int) -> str:
        """Convert PostgreSQL type OID to a type token.

        This map is the PHYSICAL type a Postgres column reports, and it feeds
        both the snapshot LOAD schema and the engine's SAFE_CAST gates — so a
        missing OID is not cosmetic. OID 1700 (``numeric``) used to be absent:
        every Postgres NUMERIC/DECIMAL money column reported ``unknown`` →
        materialized as STRING → ``SUM(STRING)`` 400 on the snapshot, and the
        "exact-decimal keeps its precision" rule could never fire because the
        token it looks for was never produced. Unmapped OIDs are resolved from
        the live ``pg_type`` catalog by the caller (extensions, enums, domains),
        so ``unknown`` is now a genuine last resort."""
        type_map = {
            16: "boolean",
            17: "bytea",
            18: "char",
            20: "bigint",
            21: "smallint",
            23: "integer",
            25: "text",
            26: "bigint",         # oid
            114: "json",
            700: "real",
            701: "double precision",
            790: "money",
            1042: "bpchar",
            1043: "varchar",
            1082: "date",
            1083: "time",
            1114: "timestamp",
            1184: "timestamptz",
            1266: "timetz",
            1700: "numeric",      # ← the gap: PG's default exact-decimal type
            2950: "uuid",
            3802: "jsonb",
        }
        return type_map.get(type_code, "unknown")

    @staticmethod
    def _pg_resolve_unknown_oids(cursor, columns: List[Dict[str, str]]) -> None:
        """Fill in ``unknown`` tokens from the live ``pg_type`` catalog, in place.

        Enums, domains, extension types (citext, hstore, PostGIS…) and any OID
        the static map does not carry would otherwise reach the snapshot loader
        as ``unknown``. Domains resolve to their BASE type so a
        ``CREATE DOMAIN money_amount AS numeric`` column still materializes as
        exact NUMERIC. Best-effort: any failure leaves the tokens untouched."""
        oids = sorted({
            int(c["_oid"]) for c in columns
            if c.get("type") == "unknown" and c.get("_oid") is not None
        })
        if not oids:
            return
        try:
            cursor.execute(
                "SELECT t.oid, COALESCE(bt.typname, t.typname) "
                "FROM pg_type t "
                "LEFT JOIN pg_type bt ON bt.oid = t.typbasetype AND t.typtype = 'd' "
                "WHERE t.oid = ANY(%s)",
                (oids,),
            )
            by_oid = {int(row[0]): str(row[1] or "").strip().lower() for row in cursor.fetchall()}
        except Exception as exc:  # noqa: BLE001 — never break type inference
            logger.info("pg_type catalog lookup failed (%s); keeping 'unknown'", exc)
            return
        for col in columns:
            if col.get("type") != "unknown":
                continue
            name = by_oid.get(int(col.get("_oid") or -1))
            if name:
                col["type"] = name
    
    @staticmethod
    def _mysql_type_to_string(type_code: int) -> str:
        """Convert MySQL type code to string."""
        # Common MySQL type codes from pymysql
        type_map = {
            1: "tinyint",
            2: "smallint",
            3: "integer",
            4: "float",
            5: "double",
            7: "timestamp",
            8: "bigint",
            10: "date",
            12: "datetime",
            246: "decimal",
            252: "text",
            253: "varchar",
            254: "char",
        }
        return type_map.get(type_code, "unknown")
    
    @staticmethod
    def list_tables(
        ds_type: str,
        config: Dict[str, Any],
        search_query: str = None
    ) -> List[Dict[str, str]]:
        """
        List all tables from a datasource.
        
        Args:
            ds_type: Type of data source
            config: Connection configuration
            search_query: Optional search query to filter tables
            
        Returns:
            List of table dicts with 'name', 'schema', and 'type' keys
        """
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)
        try:
            if ds_type == DataSourceType.POSTGRESQL.value:
                return DataSourceConnectionService._list_postgresql_tables(config, search_query)
            elif ds_type == DataSourceType.MYSQL.value:
                return DataSourceConnectionService._list_mysql_tables(config, search_query)
            elif ds_type == DataSourceType.BIGQUERY.value:
                return DataSourceConnectionService._list_bigquery_tables(config, search_query)
            elif ds_type == DataSourceType.GOOGLE_SHEETS.value:
                return DataSourceConnectionService._list_google_sheets(config, search_query)
            elif ds_type == DataSourceType.MANUAL.value:
                return DataSourceConnectionService._list_manual_tables(config, search_query)
            else:
                raise ValueError(f"Unsupported data source type: {ds_type}")
        except Exception as e:
            logger.error(f"Failed to list tables: {str(e)}")
            raise
    
    @staticmethod
    def _list_postgresql_tables(
        config: Dict[str, Any],
        search_query: str = None
    ) -> List[Dict[str, str]]:
        """List tables from PostgreSQL."""
        conn = None
        cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password")
            )
            cursor = conn.cursor()
            
            # Query information_schema for tables and views
            query = """
                SELECT 
                    table_schema,
                    table_name,
                    table_type
                FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            """
            
            if search_query:
                query += " AND table_name ILIKE %s"
                params = (f"%{search_query}%",)
            else:
                params = ()

            query += " ORDER BY table_schema, table_name"

            cursor.execute(query, params)
            rows = cursor.fetchall()
            
            tables = []
            for schema, name, table_type in rows:
                tables.append({
                    "name": f"{schema}.{name}",
                    "schema": schema,
                    "type": "view" if table_type == "VIEW" else "table"
                })
            
            return tables
            
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
    
    @staticmethod
    def _list_mysql_tables(
        config: Dict[str, Any],
        search_query: str = None
    ) -> List[Dict[str, str]]:
        """List tables from MySQL."""
        conn = None
        cursor = None
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=config.get("port", 3306),
                user=config.get("username"),
                password=config.get("password")
            )
            cursor = conn.cursor()
            
            database = config.get("database")
            
            # Query information_schema for tables
            query = """
                SELECT 
                    TABLE_NAME,
                    TABLE_TYPE
                FROM information_schema.tables
                WHERE TABLE_SCHEMA = %s
            """
            params: tuple = (database,)

            if search_query:
                query += " AND TABLE_NAME LIKE %s"
                params = (database, f"%{search_query}%")

            query += " ORDER BY TABLE_NAME"

            cursor.execute(query, params)
            rows = cursor.fetchall()
            
            tables = []
            for name, table_type in rows:
                tables.append({
                    "name": name,
                    "schema": database,
                    "type": "view" if table_type == "VIEW" else "table"
                })
            
            return tables
            
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
    
    @staticmethod
    def _list_bigquery_tables(
        config: Dict[str, Any],
        search_query: str = None
    ) -> List[Dict[str, str]]:
        """List tables from BigQuery."""
        client = None
        try:
            project_id = config.get("project_id")

            client = _build_bigquery_client(config)

            logger.info(f"Listing BigQuery tables for project {project_id}")

            class _DS:
                def __init__(self, ds_id):
                    self.dataset_id = ds_id

            default_dataset = config.get("default_dataset", "").strip()

            if default_dataset:
                # User explicitly set a dataset — scope listing to that dataset only.
                logger.info(f"default_dataset configured: listing only '{default_dataset}'")
                datasets = [_DS(default_dataset)]
            else:
                # No dataset filter — list all datasets in the project.
                datasets = list(client.list_datasets())
                if not datasets:
                    logger.warning(
                        f"list_datasets() returned empty for project {project_id}. "
                        "Grant bigquery.datasets.list on the project or set a Default Dataset."
                    )

            tables = []
            for dataset in datasets:
                dataset_id = dataset.dataset_id

                try:
                    dataset_tables = list(client.list_tables(dataset_id))
                except Exception as e:
                    logger.warning(f"Could not list tables in dataset '{dataset_id}': {e}")
                    continue

                for table in dataset_tables:
                    table_name = f"{dataset_id}.{table.table_id}"

                    # Apply search filter
                    if search_query and search_query.lower() not in table_name.lower():
                        continue

                    tables.append({
                        "name": table_name,
                        "schema": dataset_id,
                        "type": "view" if table.table_type == "VIEW" else "table"
                    })

            logger.info(f"BigQuery tables listed: {len(tables)}")
            return tables

        except Exception as e:
            logger.error(f"BigQuery list tables failed on project {config.get('project_id')}: {str(e)}")
            raise
        finally:
            if client:
                client.close()
    
    @staticmethod
    def _list_google_sheets(
        config: Dict[str, Any],
        search_query: str = None
    ) -> List[Dict[str, str]]:
        """List sheets from the live Google Sheets workbook."""
        try:
            spreadsheet_id, connector = DataSourceConnectionService._get_google_sheets_connector(config)
            sheet_names = connector.list_sheets(spreadsheet_id)
            logger.info(f"Google Sheets list via API: {len(sheet_names)} sheets")

            tables = []
            for sheet_name in sheet_names:
                if search_query and search_query.lower() not in sheet_name.lower():
                    continue
                tables.append({
                    "name": sheet_name,
                    "schema": spreadsheet_id,
                    "type": "sheet"
                })

            return tables

        except Exception as e:
            logger.error(f"Google Sheets list failed: {str(e)}")
            raise

    @staticmethod
    def _get_google_sheets_connector(config: Dict[str, Any]):
        from app.services.google_sheets_connector import create_google_sheets_connector

        spreadsheet_id = str(config.get("spreadsheet_id") or "").strip()
        if not spreadsheet_id:
            raise ValueError("spreadsheet_id is required")
        return spreadsheet_id, create_google_sheets_connector(config)
    
    @staticmethod
    def _list_manual_tables(
        config: Dict[str, Any],
        search_query: str = None
    ) -> List[Dict[str, str]]:
        """List all sheets / tables from an imported file datasource."""
        try:
            from app.services.manual_table_connector import create_manual_table_connector
            connector = create_manual_table_connector(config)
            tables = [
                {"name": name, "schema": "manual", "type": "table"}
                for name in connector.list_sheets()
            ]
            if search_query:
                q = search_query.lower()
                tables = [t for t in tables if q in t["name"].lower()]
            logger.info(f"Manual datasource sheets listed: {len(tables)}")
            return tables
        except Exception as e:
            logger.error(f"Manual table list failed: {str(e)}")
            raise
    
    @staticmethod
    def _execute_google_sheets(
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Execute SQL query against Google Sheets using DuckDB.

        All sheets are registered as DuckDB in-memory tables so any SQL
        (WHERE, GROUP BY, ORDER BY, JOINs, CTEs) is fully supported.
        """
        try:
            # ── Collect all sheet data from the live workbook ─────────────────
            # spreadsheet_id is cheap (config); the connector (OAuth/SA + client
            # build) is only needed on a cache MISS, so build it lazily inside the
            # loader — a workbook/result cache HIT then pays nothing to build it.
            spreadsheet_id = str(config.get("spreadsheet_id") or "").strip()
            if not spreadsheet_id:
                raise ValueError("spreadsheet_id is required")

            # Whole-workbook read is cached per spreadsheet for a short TTL so a
            # burst of screen/lookup reads collapses into ONE Sheets fetch
            # instead of (list_sheets + N tabs) PER query — the root cause of
            # the 60-reads/min/user quota blow-ups. Writes invalidate this cache
            # (see google_sheets_connector append/update/delete).
            from app.services import google_sheets_cache

            def _load_workbook():
                _sid, connector = DataSourceConnectionService._get_google_sheets_connector(config)
                names = connector.list_sheets(spreadsheet_id)
                # ONE batchGet for the whole workbook (was N sequential get_sheet_data
                # → the Sheets quota + latency root cause). Parsing is byte-identical.
                return connector.get_sheets_data_batch(spreadsheet_id, names)

            all_sheets = google_sheets_cache.get_or_load(spreadsheet_id, _load_workbook)
            logger.info(f"Google Sheets data (cached workbook): {len(all_sheets)} sheets")

            # ── Perf (#3): serve a cached COMPUTED result if we already ran
            # this exact SQL over the current workbook. The generic query_cache
            # skips Sheets (externally mutable), so without this every dashboard
            # tile rebuilt a fresh DuckDB and re-ran its SQL. This cache shares
            # the workbook cache's TTL + invalidation, so it never serves data
            # older than the workbook the tile would have read anyway.
            _result_key = hashlib.sha256(
                f"{(sql_query or '').strip()}::limit={limit or 0}".encode("utf-8")
            ).hexdigest()
            _cached_result = google_sheets_cache.get_cached_result(spreadsheet_id, _result_key)
            if _cached_result is not None:
                _cols, _rows = _cached_result
                # [perf] Sheets result cache HIT — skipped the WHOLE DuckDB
                # rebuild (Arrow build + CREATE TABLE per tab + query). This is
                # the per-tile cost Fix #3 removes on a multi-tile Sheets dash.
                logger.info(
                    "[perf] sheets result cache=HIT ss=%s rows=%d sql_key=%s "
                    "(skipped: duckdb-rebuild)",
                    spreadsheet_id, len(_rows), _result_key[:12],
                )
                # Return copies so a caller mutating the list can't corrupt the
                # cached payload shared by the next tile.
                return list(_cols), [dict(r) for r in _rows]

            # ── Try DuckDB first (full SQL support) ───────────────────────────
            try:
                import duckdb
                import pyarrow as pa

                _duck_start = time.time()
                con = duckdb.connect(database=":memory:")

                # Perf (#4): only register the tabs the SQL actually references.
                # Loading the WHOLE workbook into DuckDB for every tile is the
                # dominant per-tile cost on multi-tab spreadsheets (Arrow build
                # + CREATE TABLE per tab). `_sheets_referenced_by_sql` matches
                # tab names against identifier tokens in the SQL; it falls back
                # to ALL tabs when detection is uncertain so a JOIN/CTE that
                # names a tab in a way we can't parse never silently loses data.
                _all_tab_count = len(all_sheets)
                tabs_to_load = _sheets_referenced_by_sql(sql_query, list(all_sheets.keys()))
                # [perf] result cache MISS → we rebuild DuckDB. The tab ratio
                # shows Fix #4 working: "loaded 1/8 tabs" means we skipped 7
                # tabs' Arrow build + CREATE TABLE. "loaded 8/8" = conservative
                # fallback (couldn't detect refs) — still correct, just no win.
                logger.info(
                    "[perf] sheets result cache=MISS ss=%s tabs_loaded=%d/%d "
                    "(rebuilding duckdb; loaded tabs=%s)",
                    spreadsheet_id, len(tabs_to_load), _all_tab_count,
                    ",".join(tabs_to_load[:8]) + ("…" if len(tabs_to_load) > 8 else ""),
                )

                for sheet_name in tabs_to_load:
                    sheet_data = all_sheets.get(sheet_name)
                    if sheet_data is None:
                        continue
                    rows = sheet_data.get('rows', [])
                    col_defs = sheet_data.get('columns', [])
                    col_names = [c['name'] for c in col_defs]
                    if not col_names:
                        logger.info(
                            "Skipping empty Google Sheet tab '%s' during DuckDB registration",
                            sheet_name,
                        )
                        continue

                    if rows:
                        table = _build_arrow_table_from_sheet(pa, col_defs, rows)
                    else:
                        table = pa.table({c: pa.array([], type=pa.string()) for c in col_names})

                    # Materialise the Arrow table into a NATIVE DuckDB table
                    # instead of querying the Arrow view directly. DuckDB's
                    # Arrow scan pushes predicates down to PyArrow compute
                    # kernels, which have gaps — e.g. BETWEEN + ORDER BY over a
                    # column containing NULLs raises
                    # "ArrowNotImplementedError: 'and_kleene' (bool, null)" and
                    # the whole read fails (date-range filters silently return
                    # zero rows). Copying into a native table makes DuckDB use
                    # its own complete execution engine. Null/value semantics
                    # are preserved; cost is negligible for Sheets-sized data.
                    safe_name = sheet_name.replace(" ", "_")
                    con.register("__arrow_src__", table)
                    for nm in dict.fromkeys([safe_name, sheet_name]):
                        con.execute(
                            f'CREATE TABLE {_duckdb_quote_ident(nm)} AS '
                            f'SELECT * FROM "__arrow_src__"'
                        )
                    con.unregister("__arrow_src__")

                final_sql = sql_query
                if limit:
                    final_sql = f"SELECT * FROM ({sql_query}) _lim LIMIT {limit}"

                result = con.execute(final_sql)
                columns = [desc[0] for desc in result.description]
                raw_rows = result.fetchall()
                con.close()

                rows = [dict(zip(columns, row)) for row in raw_rows]
                _duck_ms = (time.time() - _duck_start) * 1000
                # [perf] full cold cost of a Sheets tile: build N tabs into
                # DuckDB + run the SQL. Compare against the cache=HIT line to
                # see what Fix #3 saves on the next identical request.
                logger.info(
                    "[perf] sheets duckdb EXECUTED ss=%s tabs_loaded=%d/%d rows=%d "
                    "duckdb_build_exec_ms=%.0f",
                    spreadsheet_id, len(tabs_to_load), _all_tab_count, len(rows), _duck_ms,
                )
                # Perf (#3): cache the computed result under the workbook's TTL.
                google_sheets_cache.set_cached_result(
                    spreadsheet_id, _result_key, (list(columns), [dict(r) for r in rows])
                )
                return columns, rows

            except ImportError:
                logger.warning("DuckDB not available; falling back to raw sheet scan")

            # ── Fallback: raw sheet scan (simple SELECT * only) ───────────────
            from app.services.manual_table_connector import extract_sheet_name_from_sql

            parsed_name = extract_sheet_name_from_sql(sql_query)
            sheet_name = parsed_name if (parsed_name and parsed_name != 'manual_data') \
                else config.get('sheet_name')

            if sheet_name and sheet_name in all_sheets:
                sheet_data = all_sheets[sheet_name]
            elif sheet_name:
                raise ValueError(f"Sheet '{sheet_name}' not found in spreadsheet.")
            elif all_sheets:
                first = next(iter(all_sheets))
                logger.warning(f"Sheet '{sheet_name}' not found; using '{first}' instead")
                sheet_data = all_sheets[first]
            else:
                return [], []

            columns = [col['name'] for col in sheet_data.get('columns', [])]
            rows = sheet_data.get('rows', [])
            if limit:
                rows = rows[:limit]
            return columns, rows

        except Exception as e:
            logger.error(f"Google Sheets query failed: {str(e)}")
            raise
    
    @staticmethod
    def _execute_manual(
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Execute SQL query against an imported-file datasource using DuckDB.

        All sheets are registered as in-memory tables so any SQL statement
        (WHERE, GROUP BY, ORDER BY, CTEs, JOINs across sheets) is fully supported.
        Falls back to raw sheet scan if DuckDB is not available.
        """
        try:
            from app.services.manual_table_connector import create_manual_table_connector

            connector = create_manual_table_connector(config)

            # ── Try DuckDB first (full SQL support) ──────────────────────────
            try:
                import duckdb
                import pyarrow as pa

                con = duckdb.connect(database=":memory:")

                # Create a "manual" schema so queries like "manual"."table" work
                con.execute("CREATE SCHEMA IF NOT EXISTS manual")

                # Register every sheet as a DuckDB table via PyArrow
                for sheet_name in connector.list_sheets():
                    sheet_data = connector.get_sheet_data(sheet_name)
                    rows = sheet_data.get("rows", [])
                    col_defs = sheet_data.get("columns", [])
                    col_names = [c["name"] for c in col_defs]

                    if rows:
                        table = _build_arrow_table_from_sheet(pa, col_defs, rows)
                    else:
                        table = pa.table({c: pa.array([], type=pa.string()) for c in col_names})

                    safe_name = sheet_name.replace(" ", "_")
                    # Register in main schema (default)
                    con.register(safe_name, table)
                    if safe_name != sheet_name:
                        con.register(sheet_name, table)
                    # Also register in manual schema for "manual"."table" queries
                    con.execute(f'CREATE OR REPLACE VIEW manual."{safe_name}" AS SELECT * FROM "{safe_name}"')
                    if safe_name != sheet_name:
                        con.execute(f'CREATE OR REPLACE VIEW manual."{sheet_name}" AS SELECT * FROM "{safe_name}"')

                final_sql = sql_query
                if limit:
                    final_sql = f"SELECT * FROM ({sql_query}) _lim LIMIT {limit}"

                result = con.execute(final_sql)
                columns = [desc[0] for desc in result.description]
                raw_rows = result.fetchall()
                con.close()

                rows = [dict(zip(columns, row)) for row in raw_rows]
                logger.info(f"DuckDB executed manual query: {len(rows)} rows")
                return columns, rows

            except ImportError:
                # DuckDB / pandas not installed – fall back to raw sheet scan
                logger.warning("DuckDB not available; falling back to raw sheet scan")

            # ── Fallback: raw sheet scan (simple SELECT * only) ───────────────
            from app.services.manual_table_connector import extract_sheet_name_from_sql
            sheet_name = extract_sheet_name_from_sql(sql_query)
            data = connector.get_sheet_data(sheet_name)
            columns = [col["name"] for col in data["columns"]]
            rows = data["rows"]
            if limit:
                rows = rows[:limit]
            logger.info(f"Manual table '{sheet_name}' fallback fetch: {len(rows)} rows")
            return columns, rows

        except Exception as e:
            logger.error(f"Manual table query failed: {str(e)}")
            raise

    # ── Schema Browser ────────────────────────────────────────────────────────

    @staticmethod
    def get_schema_browser(ds_type: str, config: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Return a schema-browser tree: list of schemas, each with tables/views + row counts.
        Currently implemented for PostgreSQL; other types delegate to list_tables().
        """
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)
        if ds_type == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._pg_schema_browser(config)
        # Fallback: wrap list_tables() result into generic schema tree
        tables = DataSourceConnectionService.list_tables(ds_type, config)
        schema_map: Dict[str, List] = {}
        for t in tables:
            s = t.get("schema", "default")
            schema_map.setdefault(s, []).append({
                "name": t["name"].split(".")[-1],
                "type": t.get("type", "table"),
                "row_count": None,
            })
        return [{"schema": s, "tables": tbls} for s, tbls in schema_map.items()]

    @staticmethod
    def _pg_schema_browser(config: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Rich schema browser for PostgreSQL: uses pg_class for row estimates + size."""
        conn = None
        cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
            )
            cursor = conn.cursor()
            cursor.execute("""
                SELECT
                    n.nspname                        AS schema,
                    c.relname                        AS table_name,
                    CASE c.relkind
                        WHEN 'r' THEN 'table'
                        WHEN 'v' THEN 'view'
                        WHEN 'm' THEN 'materialized_view'
                        ELSE 'other'
                    END                              AS table_type,
                    GREATEST(c.reltuples::bigint, 0) AS row_count_estimate,
                    pg_total_relation_size(c.oid)    AS size_bytes
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'v', 'm')
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                ORDER BY n.nspname, c.relname
            """)
            rows = cursor.fetchall()
            schema_map: Dict[str, Dict] = {}
            for schema, name, ttype, row_count, size_bytes in rows:
                if schema not in schema_map:
                    schema_map[schema] = {"schema": schema, "tables": []}
                schema_map[schema]["tables"].append({
                    "name": name,
                    "type": ttype,
                    "row_count": row_count,
                    "size_bytes": size_bytes,
                })
            return list(schema_map.values())
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()

    @staticmethod
    def get_table_detail(
        ds_type: str,
        config: Dict[str, Any],
        schema_name: str,
        table_name: str,
        preview_rows: int = 5,
    ) -> Dict[str, Any]:
        """
        Return detailed metadata for a single table: columns with PK/FK/IDX flags
        and a small preview dataset.
        """
        if ds_type == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._pg_table_detail(
                config, schema_name, table_name, preview_rows
            )
        # Generic fallback using execute_query
        full_name = f'"{schema_name}"."{table_name}"'
        try:
            cols, data, _ = DataSourceConnectionService.execute_query(
                ds_type, config, f"SELECT * FROM {full_name}", limit=preview_rows
            )
            columns = [{"name": c, "type": "unknown", "nullable": True,
                        "is_primary_key": False, "is_foreign_key": False,
                        "has_index": False} for c in cols]
            return {"schema": schema_name, "name": table_name, "type": "table",
                    "row_count": None, "columns": columns, "preview": data}
        except Exception as e:
            raise ValueError(f"Cannot fetch table detail: {e}")

    @staticmethod
    def _pg_table_detail(
        config: Dict[str, Any],
        schema_name: str,
        table_name: str,
        preview_rows: int = 5,
    ) -> Dict[str, Any]:
        conn = None
        cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
            )
            cursor = conn.cursor()

            # 1. Column metadata with PK / FK / index flags
            cursor.execute("""
                SELECT
                    a.attname                                                    AS column_name,
                    pg_catalog.format_type(a.atttypid, a.atttypmod)             AS data_type,
                    NOT a.attnotnull                                             AS is_nullable,
                    COALESCE((
                        SELECT TRUE FROM pg_constraint c
                        WHERE c.conrelid = a.attrelid AND c.contype = 'p'
                          AND a.attnum = ANY(c.conkey)
                    ), FALSE)                                                    AS is_pk,
                    COALESCE((
                        SELECT TRUE FROM pg_constraint c
                        WHERE c.conrelid = a.attrelid AND c.contype = 'f'
                          AND a.attnum = ANY(c.conkey)
                    ), FALSE)                                                    AS is_fk,
                    COALESCE((
                        SELECT TRUE FROM pg_index i
                        WHERE i.indrelid = a.attrelid AND a.attnum = ANY(i.indkey)
                          AND NOT i.indisprimary
                    ), FALSE)                                                    AS has_idx
                FROM pg_attribute a
                JOIN pg_class     cl ON cl.oid = a.attrelid
                JOIN pg_namespace n  ON n.oid  = cl.relnamespace
                WHERE n.nspname = %s
                  AND cl.relname = %s
                  AND a.attnum > 0
                  AND NOT a.attisdropped
                ORDER BY a.attnum
            """, (schema_name, table_name))
            col_rows = cursor.fetchall()
            columns = [
                {
                    "name": cname,
                    "type": dtype,
                    "nullable": bool(nullable),
                    "is_primary_key": bool(is_pk),
                    "is_foreign_key": bool(is_fk),
                    "has_index": bool(has_idx),
                }
                for cname, dtype, nullable, is_pk, is_fk, has_idx in col_rows
            ]

            # 2. Row count estimate from pg_class
            cursor.execute("""
                SELECT GREATEST(c.reltuples::bigint, 0),
                       pg_total_relation_size(c.oid)
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = %s AND c.relname = %s
            """, (schema_name, table_name))
            meta_row = cursor.fetchone()
            row_count = meta_row[0] if meta_row else None
            size_bytes = meta_row[1] if meta_row else None

            # 3. Determine table type
            cursor.execute("""
                SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view'
                                      WHEN 'm' THEN 'materialized_view' ELSE 'other' END
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = %s AND c.relname = %s
            """, (schema_name, table_name))
            type_row = cursor.fetchone()
            table_type = type_row[0] if type_row else "table"

            # 4. Preview rows — safe identifier quoting
            import psycopg2.extensions as _ext
            safe_schema = _ext.quote_ident(schema_name, conn)
            safe_table = _ext.quote_ident(table_name, conn)
            cursor.execute(f"SELECT * FROM {safe_schema}.{safe_table} LIMIT %s", (preview_rows,))
            preview_cols = [desc[0] for desc in cursor.description]
            preview_data = []
            for row in cursor.fetchall():
                preview_data.append({
                    preview_cols[i]: (str(v) if not isinstance(v, (int, float, bool, type(None))) else v)
                    for i, v in enumerate(row)
                })

            return {
                "schema": schema_name,
                "name": table_name,
                "type": table_type,
                "row_count": row_count,
                "size_bytes": size_bytes,
                "columns": columns,
                "preview": preview_data,
            }
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()

    @staticmethod
    def get_watermark_candidates(
        ds_type: str,
        config: Dict[str, Any],
        schema_name: str,
        table_name: str,
    ) -> List[Dict[str, str]]:
        """Return columns suitable as watermark (timestamp/date/integer types)."""
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)

        # Google Sheets and Manual datasources have no typed columns — no watermark support
        if ds_type in (DataSourceType.GOOGLE_SHEETS.value, DataSourceType.MANUAL.value):
            return []

        watermark_types = {
            "timestamp", "timestamptz", "timestamp with time zone",
            "timestamp without time zone", "date", "datetime",
            "integer", "bigint", "int4", "int8", "int64",
        }

        if ds_type == DataSourceType.POSTGRESQL.value:
            detail = DataSourceConnectionService._pg_table_detail(config, schema_name, table_name, preview_rows=0)
            return [
                {"name": c["name"], "type": c["type"]}
                for c in detail["columns"]
                if any(wt in c["type"].lower() for wt in watermark_types)
            ]

        if ds_type == DataSourceType.BIGQUERY.value:
            full_table = f"{schema_name}.{table_name}"
            columns = DataSourceConnectionService._bq_list_columns(config, full_table)
            bq_watermark_types = {
                "timestamp", "datetime", "date", "integer", "int64", "numeric",
            }
            return [
                {"name": c["name"], "type": c["type"]}
                for c in columns
                if c["type"].lower() in bq_watermark_types
            ]

        if ds_type == DataSourceType.MYSQL.value:
            database = config.get("database", schema_name)
            columns = DataSourceConnectionService._mysql_list_columns(config, database, table_name)
            return [
                {"name": c["name"], "type": c["type"]}
                for c in columns
                if any(wt in c["type"].lower() for wt in watermark_types)
            ]

        return []

    @staticmethod
    def list_columns(
        ds_id: int,
        ds_type: str,
        config: Dict[str, Any],
        table_name: str,
    ) -> List[Dict[str, str]]:
        """
        Return columns for a specific table via live source query.
        Each item: {"name": str, "type": str}
        """
        from app.core.crypto import decrypt_config

        config = decrypt_config(config)

        # Parse schema.table
        if "." in table_name:
            parts = table_name.split(".", 1)
            schema = parts[0].strip('"').strip("'")
            tbl = parts[1].strip('"').strip("'")
        else:
            schema = None
            tbl = table_name.strip('"').strip("'")

        if ds_type == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._pg_list_columns(config, schema or "public", tbl)
        elif ds_type == DataSourceType.MYSQL.value:
            return DataSourceConnectionService._mysql_list_columns(config, schema or config.get("database", ""), tbl)
        elif ds_type == DataSourceType.BIGQUERY.value:
            return DataSourceConnectionService._bq_list_columns(config, table_name)
        elif ds_type == DataSourceType.GOOGLE_SHEETS.value:
            return DataSourceConnectionService._google_sheets_list_columns(config, tbl)
        elif ds_type == DataSourceType.MANUAL.value:
            return DataSourceConnectionService._sheets_list_columns(config, tbl)
        return []

    @staticmethod
    def list_foreign_keys(
        ds_type: str,
        config: Dict[str, Any],
        table_names: List[str],
    ) -> List[Dict[str, Any]]:
        """Phase-15.69 — pull FK constraints from the source DB's
        INFORMATION_SCHEMA (or equivalent) for a given set of tables.

        Returns a flat list:
          [
            {
              "from_schema": "public", "from_table": "orders",
              "from_column": "user_id",
              "to_schema": "public", "to_table": "users",
              "to_column": "id",
            },
            ...
          ]

        Only includes FKs where BOTH endpoints are in `table_names`
        (qualified `schema.table` strings) so we don't pollute the
        model with joins to tables the dataset doesn't import.

        Google Sheets / Manual / BigQuery (no real FK metadata)
        return []. BigQuery does have INFORMATION_SCHEMA but FKs are
        decorative only (not enforced) — still useful as hints when DA
        author keys them, so we read them too.
        """
        from app.core.crypto import decrypt_config

        if ds_type == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._pg_list_foreign_keys(
                decrypt_config(config), table_names
            )
        if ds_type == DataSourceType.MYSQL.value:
            return DataSourceConnectionService._mysql_list_foreign_keys(
                decrypt_config(config), table_names
            )
        if ds_type == DataSourceType.BIGQUERY.value:
            return DataSourceConnectionService._bq_list_foreign_keys(
                decrypt_config(config), table_names
            )
        return []

    @staticmethod
    def _pg_list_foreign_keys(
        config: Dict[str, Any], table_names: List[str]
    ) -> List[Dict[str, Any]]:
        """Postgres: read pg_constraint + pg_attribute for type='f' (FK)."""
        if not table_names:
            return []
        # Build the (schema, table) tuple list for IN clause.
        pairs: List[tuple[str, str]] = []
        for raw in table_names:
            if "." in raw:
                s, t = raw.split(".", 1)
            else:
                s, t = "public", raw
            pairs.append((s.strip('"').strip("'"), t.strip('"').strip("'")))
        if not pairs:
            return []
        sql = """
            SELECT
                src_ns.nspname  AS from_schema,
                src_tbl.relname AS from_table,
                src_col.attname AS from_column,
                dst_ns.nspname  AS to_schema,
                dst_tbl.relname AS to_table,
                dst_col.attname AS to_column
            FROM pg_constraint c
            JOIN pg_class    src_tbl ON src_tbl.oid = c.conrelid
            JOIN pg_namespace src_ns ON src_ns.oid = src_tbl.relnamespace
            JOIN pg_class    dst_tbl ON dst_tbl.oid = c.confrelid
            JOIN pg_namespace dst_ns ON dst_ns.oid = dst_tbl.relnamespace
            JOIN unnest(c.conkey)  WITH ORDINALITY AS src_attr(attnum, ord) ON TRUE
            JOIN unnest(c.confkey) WITH ORDINALITY AS dst_attr(attnum, ord)
                 ON src_attr.ord = dst_attr.ord
            JOIN pg_attribute src_col
                 ON src_col.attrelid = c.conrelid AND src_col.attnum = src_attr.attnum
            JOIN pg_attribute dst_col
                 ON dst_col.attrelid = c.confrelid AND dst_col.attnum = dst_attr.attnum
            WHERE c.contype = 'f'
        """
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
            )
            cur = conn.cursor()
            cur.execute(sql)
            allowed = {(s, t) for s, t in pairs}
            out: List[Dict[str, Any]] = []
            for row in cur.fetchall():
                fs, ft, fc, ts, tt, tc = row
                if (fs, ft) not in allowed or (ts, tt) not in allowed:
                    continue
                out.append({
                    "from_schema": fs, "from_table": ft, "from_column": fc,
                    "to_schema": ts, "to_table": tt, "to_column": tc,
                })
            cur.close()
            conn.close()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[fk_extract] Postgres FK query failed: {exc}")
            return []

    @staticmethod
    def _mysql_list_foreign_keys(
        config: Dict[str, Any], table_names: List[str]
    ) -> List[Dict[str, Any]]:
        """MySQL: KEY_COLUMN_USAGE filtered to FK rows."""
        if not table_names:
            return []
        # MySQL doesn't really use schema; use db name as the schema.
        db_name = config.get("database") or ""
        bare_tables = []
        for raw in table_names:
            if "." in raw:
                _, t = raw.split(".", 1)
            else:
                t = raw
            bare_tables.append(t.strip('"').strip("'").strip("`"))
        if not bare_tables:
            return []
        placeholders = ",".join(["%s"] * len(bare_tables))
        sql = f"""
            SELECT
                TABLE_SCHEMA            AS from_schema,
                TABLE_NAME              AS from_table,
                COLUMN_NAME             AS from_column,
                REFERENCED_TABLE_SCHEMA AS to_schema,
                REFERENCED_TABLE_NAME   AS to_table,
                REFERENCED_COLUMN_NAME  AS to_column
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE REFERENCED_TABLE_NAME IS NOT NULL
              AND TABLE_SCHEMA = %s
              AND TABLE_NAME IN ({placeholders})
        """
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=int(config.get("port", 3306)),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
                read_timeout=10,
            )
            cur = conn.cursor()
            cur.execute(sql, [db_name, *bare_tables])
            allowed = set(bare_tables)
            out: List[Dict[str, Any]] = []
            for row in cur.fetchall():
                fs, ft, fc, ts, tt, tc = row
                if ft not in allowed or tt not in allowed:
                    continue
                out.append({
                    "from_schema": fs, "from_table": ft, "from_column": fc,
                    "to_schema": ts, "to_table": tt, "to_column": tc,
                })
            cur.close()
            conn.close()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[fk_extract] MySQL FK query failed: {exc}")
            return []

    @staticmethod
    def _bq_list_foreign_keys(
        config: Dict[str, Any], table_names: List[str]
    ) -> List[Dict[str, Any]]:
        """BigQuery: INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE +
        TABLE_CONSTRAINTS. FKs decorative only (not enforced) but DAs
        who model them get free join suggestions.

        BigQuery requires querying per-dataset INFORMATION_SCHEMA; we
        group `table_names` by their dataset (the `schema` part).
        """
        if not table_names:
            return []
        by_dataset: Dict[str, List[str]] = {}
        for raw in table_names:
            if "." in raw:
                parts = raw.split(".")
                if len(parts) == 2:
                    ds, t = parts
                elif len(parts) >= 3:
                    # project.dataset.table
                    ds = parts[-2]
                    t = parts[-1]
                else:
                    continue
            else:
                continue
            by_dataset.setdefault(ds.strip("`"), []).append(t.strip("`"))
        if not by_dataset:
            return []
        try:
            client = _build_bigquery_client(config)
            project_id = config.get("project_id")
            out: List[Dict[str, Any]] = []
            for ds_name, tables in by_dataset.items():
                # BigQuery FKs: TABLE_CONSTRAINTS where CONSTRAINT_TYPE='FOREIGN KEY'
                # then join CONSTRAINT_COLUMN_USAGE for both sides.
                allowed = set(tables)
                sql = f"""
                    SELECT
                      kcu.table_schema      AS from_schema,
                      kcu.table_name        AS from_table,
                      kcu.column_name       AS from_column,
                      ccu.table_schema      AS to_schema,
                      ccu.table_name        AS to_table,
                      ccu.column_name       AS to_column
                    FROM `{project_id}.{ds_name}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS` tc
                    JOIN `{project_id}.{ds_name}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE` kcu
                      ON tc.constraint_name = kcu.constraint_name
                      AND tc.table_schema = kcu.table_schema
                    JOIN `{project_id}.{ds_name}.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE` ccu
                      ON tc.constraint_name = ccu.constraint_name
                      AND tc.table_schema = ccu.table_schema
                    WHERE tc.constraint_type = 'FOREIGN KEY'
                """
                job = client.query(sql)
                for row in job.result(timeout=30):
                    fs, ft, fc, ts, tt, tc = (
                        row["from_schema"], row["from_table"], row["from_column"],
                        row["to_schema"], row["to_table"], row["to_column"],
                    )
                    if ft not in allowed:
                        continue
                    out.append({
                        "from_schema": fs, "from_table": ft, "from_column": fc,
                        "to_schema": ts, "to_table": tt, "to_column": tc,
                    })
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[fk_extract] BigQuery FK query failed: {exc}")
            return []

    @staticmethod
    def list_primary_keys(
        ds_type: str,
        config: Dict[str, Any],
        table_names: List[str],
    ) -> Dict[str, List[str]]:
        """Phase-16 — fetch primary-key columns per table.

        Returns ``{"schema.table": ["pk_col1", ...], ...}``. Tables with
        composite PKs return the ordered list of columns. Tables with no
        declared PK are absent. The relationship review modal uses this
        to anchor pass 2 ("name match") on the real PK instead of
        assuming `.id`, and to set cardinality correctly in pass 3 (a
        column joining onto a PK is necessarily many_to_one).
        """
        from app.core.crypto import decrypt_config

        if ds_type == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._pg_list_primary_keys(
                decrypt_config(config), table_names
            )
        if ds_type == DataSourceType.MYSQL.value:
            return DataSourceConnectionService._mysql_list_primary_keys(
                decrypt_config(config), table_names
            )
        if ds_type == DataSourceType.BIGQUERY.value:
            return DataSourceConnectionService._bq_list_primary_keys(
                decrypt_config(config), table_names
            )
        return {}

    @staticmethod
    def list_source_column_types(
        ds_type: str,
        config: Dict[str, Any],
        table_names: List[str],
    ) -> Dict[str, Dict[str, str]]:
        """Phase-16 — fetch the source DB's declared column type per table.

        Returns ``{"schema.table": {"col_name": "raw_db_type", ...}, ...}``.
        The raw type is the value the DB returns in INFORMATION_SCHEMA
        (e.g. "uuid", "bigint", "character varying", "varchar(36)") —
        more discriminating than AppBI's normalised cache labels, which
        collapse every numeric into "number" and every text into "string".
        """
        from app.core.crypto import decrypt_config

        if ds_type == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._pg_list_source_column_types(
                decrypt_config(config), table_names
            )
        if ds_type == DataSourceType.MYSQL.value:
            return DataSourceConnectionService._mysql_list_source_column_types(
                decrypt_config(config), table_names
            )
        if ds_type == DataSourceType.BIGQUERY.value:
            return DataSourceConnectionService._bq_list_source_column_types(
                decrypt_config(config), table_names
            )
        return {}

    @staticmethod
    def _pg_list_primary_keys(
        config: Dict[str, Any], table_names: List[str]
    ) -> Dict[str, List[str]]:
        if not table_names:
            return {}
        pairs: List[tuple[str, str]] = []
        for raw in table_names:
            if "." in raw:
                s, t = raw.split(".", 1)
            else:
                s, t = "public", raw
            pairs.append((s.strip('"').strip("'"), t.strip('"').strip("'")))
        if not pairs:
            return {}
        sql = """
            SELECT
                ns.nspname  AS schema_name,
                tbl.relname AS table_name,
                att.attname AS column_name,
                src_attr.ord AS ord
            FROM pg_constraint c
            JOIN pg_class     tbl ON tbl.oid = c.conrelid
            JOIN pg_namespace ns  ON ns.oid = tbl.relnamespace
            JOIN unnest(c.conkey) WITH ORDINALITY AS src_attr(attnum, ord) ON TRUE
            JOIN pg_attribute att
                 ON att.attrelid = c.conrelid AND att.attnum = src_attr.attnum
            WHERE c.contype = 'p'
            ORDER BY ns.nspname, tbl.relname, src_attr.ord
        """
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
            )
            cur = conn.cursor()
            cur.execute(sql)
            allowed = {(s, t) for s, t in pairs}
            out: Dict[str, List[str]] = {}
            for schema_name, table_name, column_name, _ord in cur.fetchall():
                if (schema_name, table_name) not in allowed:
                    continue
                key = f"{schema_name}.{table_name}"
                out.setdefault(key, []).append(column_name)
            cur.close()
            conn.close()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[pk_extract] Postgres PK query failed: {exc}")
            return {}

    @staticmethod
    def _mysql_list_primary_keys(
        config: Dict[str, Any], table_names: List[str]
    ) -> Dict[str, List[str]]:
        if not table_names:
            return {}
        db_name = config.get("database") or ""
        bare_tables = []
        for raw in table_names:
            if "." in raw:
                _, t = raw.split(".", 1)
            else:
                t = raw
            bare_tables.append(t.strip('"').strip("'").strip("`"))
        if not bare_tables:
            return {}
        placeholders = ",".join(["%s"] * len(bare_tables))
        sql = f"""
            SELECT
                TABLE_SCHEMA,
                TABLE_NAME,
                COLUMN_NAME,
                ORDINAL_POSITION
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE CONSTRAINT_NAME = 'PRIMARY'
              AND TABLE_SCHEMA = %s
              AND TABLE_NAME IN ({placeholders})
            ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
        """
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=int(config.get("port", 3306)),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
                read_timeout=10,
            )
            cur = conn.cursor()
            cur.execute(sql, [db_name, *bare_tables])
            out: Dict[str, List[str]] = {}
            for schema_name, table_name, column_name, _ord in cur.fetchall():
                key = f"{schema_name}.{table_name}"
                out.setdefault(key, []).append(column_name)
            cur.close()
            conn.close()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[pk_extract] MySQL PK query failed: {exc}")
            return {}

    @staticmethod
    def _bq_list_primary_keys(
        config: Dict[str, Any], table_names: List[str]
    ) -> Dict[str, List[str]]:
        if not table_names:
            return {}
        by_dataset: Dict[str, List[str]] = {}
        for raw in table_names:
            if "." in raw:
                parts = raw.split(".")
                if len(parts) == 2:
                    ds, t = parts
                elif len(parts) >= 3:
                    ds = parts[-2]
                    t = parts[-1]
                else:
                    continue
            else:
                continue
            by_dataset.setdefault(ds.strip("`"), []).append(t.strip("`"))
        if not by_dataset:
            return {}
        out: Dict[str, List[str]] = {}
        try:
            client = _build_bigquery_client(config)
            project_id = config.get("project_id")
            for ds_name, tables in by_dataset.items():
                allowed = set(tables)
                sql = f"""
                    SELECT
                      kcu.table_schema, kcu.table_name, kcu.column_name, kcu.ordinal_position
                    FROM `{project_id}.{ds_name}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS` tc
                    JOIN `{project_id}.{ds_name}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE` kcu
                      ON tc.constraint_name = kcu.constraint_name
                     AND tc.table_schema = kcu.table_schema
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                    ORDER BY kcu.table_schema, kcu.table_name, kcu.ordinal_position
                """
                job = client.query(sql)
                for row in job.result(timeout=30):
                    schema_name = row["table_schema"]
                    table_name = row["table_name"]
                    if table_name not in allowed:
                        continue
                    key = f"{schema_name}.{table_name}"
                    out.setdefault(key, []).append(row["column_name"])
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[pk_extract] BigQuery PK query failed: {exc}")
            return {}

    @staticmethod
    def _pg_list_source_column_types(
        config: Dict[str, Any], table_names: List[str]
    ) -> Dict[str, Dict[str, str]]:
        if not table_names:
            return {}
        pairs: List[tuple[str, str]] = []
        for raw in table_names:
            if "." in raw:
                s, t = raw.split(".", 1)
            else:
                s, t = "public", raw
            pairs.append((s.strip('"').strip("'"), t.strip('"').strip("'")))
        if not pairs:
            return {}
        sql = """
            SELECT
                table_schema,
                table_name,
                column_name,
                data_type,
                udt_name,
                character_maximum_length
            FROM information_schema.columns
        """
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
            )
            cur = conn.cursor()
            cur.execute(sql)
            allowed = {(s, t) for s, t in pairs}
            out: Dict[str, Dict[str, str]] = {}
            for schema_name, table_name, column_name, data_type, udt_name, char_max in cur.fetchall():
                if (schema_name, table_name) not in allowed:
                    continue
                # Prefer udt_name for postgres-specific types (uuid, jsonb) —
                # data_type collapses uuid into "uuid" already but for arrays
                # it gives "ARRAY" which loses the element type.
                resolved_type = str(udt_name or data_type or "").lower()
                if char_max is not None and resolved_type in {"varchar", "character varying", "char", "character"}:
                    resolved_type = f"{resolved_type}({int(char_max)})"
                key = f"{schema_name}.{table_name}"
                out.setdefault(key, {})[column_name] = resolved_type
            cur.close()
            conn.close()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[type_extract] Postgres column types query failed: {exc}")
            return {}

    @staticmethod
    def _mysql_list_source_column_types(
        config: Dict[str, Any], table_names: List[str]
    ) -> Dict[str, Dict[str, str]]:
        if not table_names:
            return {}
        db_name = config.get("database") or ""
        bare_tables = []
        for raw in table_names:
            if "." in raw:
                _, t = raw.split(".", 1)
            else:
                t = raw
            bare_tables.append(t.strip('"').strip("'").strip("`"))
        if not bare_tables:
            return {}
        placeholders = ",".join(["%s"] * len(bare_tables))
        sql = f"""
            SELECT
                TABLE_SCHEMA,
                TABLE_NAME,
                COLUMN_NAME,
                COLUMN_TYPE
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = %s
              AND TABLE_NAME IN ({placeholders})
        """
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=int(config.get("port", 3306)),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
                read_timeout=10,
            )
            cur = conn.cursor()
            cur.execute(sql, [db_name, *bare_tables])
            out: Dict[str, Dict[str, str]] = {}
            for schema_name, table_name, column_name, column_type in cur.fetchall():
                key = f"{schema_name}.{table_name}"
                out.setdefault(key, {})[column_name] = str(column_type or "").lower()
            cur.close()
            conn.close()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[type_extract] MySQL column types query failed: {exc}")
            return {}

    @staticmethod
    def _bq_list_source_column_types(
        config: Dict[str, Any], table_names: List[str]
    ) -> Dict[str, Dict[str, str]]:
        if not table_names:
            return {}
        by_dataset: Dict[str, List[str]] = {}
        for raw in table_names:
            if "." in raw:
                parts = raw.split(".")
                if len(parts) == 2:
                    ds, t = parts
                elif len(parts) >= 3:
                    ds = parts[-2]
                    t = parts[-1]
                else:
                    continue
            else:
                continue
            by_dataset.setdefault(ds.strip("`"), []).append(t.strip("`"))
        if not by_dataset:
            return {}
        out: Dict[str, Dict[str, str]] = {}
        try:
            client = _build_bigquery_client(config)
            project_id = config.get("project_id")
            for ds_name, tables in by_dataset.items():
                allowed = set(tables)
                sql = f"""
                    SELECT table_schema, table_name, column_name, data_type
                    FROM `{project_id}.{ds_name}.INFORMATION_SCHEMA.COLUMNS`
                """
                job = client.query(sql)
                for row in job.result(timeout=30):
                    schema_name = row["table_schema"]
                    table_name = row["table_name"]
                    if table_name not in allowed:
                        continue
                    key = f"{schema_name}.{table_name}"
                    out.setdefault(key, {})[row["column_name"]] = str(row["data_type"] or "").lower()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[type_extract] BigQuery column types query failed: {exc}")
            return {}

    @staticmethod
    def _pg_list_columns(config: Dict[str, Any], schema: str, table: str) -> List[Dict[str, str]]:
        conn = cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"), port=config.get("port", 5432),
                database=config.get("database"), user=config.get("username"),
                password=config.get("password"),
            )
            cursor = conn.cursor()
            cursor.execute(
                """SELECT column_name, data_type
                   FROM information_schema.columns
                   WHERE table_schema = %s AND table_name = %s
                   ORDER BY ordinal_position""",
                (schema, table),
            )
            return [{"name": r[0], "type": r[1]} for r in cursor.fetchall()]
        finally:
            if cursor: cursor.close()
            if conn: conn.close()

    @staticmethod
    def _mysql_list_columns(config: Dict[str, Any], database: str, table: str) -> List[Dict[str, str]]:
        conn = cursor = None
        try:
            conn = pymysql.connect(
                host=config.get("host"), port=config.get("port", 3306),
                user=config.get("username"), password=config.get("password"),
            )
            cursor = conn.cursor()
            cursor.execute(
                """SELECT COLUMN_NAME, DATA_TYPE
                   FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
                   ORDER BY ORDINAL_POSITION""",
                (database, table),
            )
            return [{"name": r[0], "type": r[1]} for r in cursor.fetchall()]
        finally:
            if cursor: cursor.close()
            if conn: conn.close()

    @staticmethod
    def _bq_list_columns(config: Dict[str, Any], full_table: str) -> List[Dict[str, str]]:
        client = None
        try:
            project_id = config.get("project_id", "")
            client = _build_bigquery_client(config)
            parts = full_table.split(".")
            if len(parts) >= 3:
                # Already fully-qualified: project.dataset.table
                table_ref_str = full_table
            elif len(parts) == 2:
                # dataset.table — prefix with project so cross-project refs work
                table_ref_str = f"{project_id}.{parts[0]}.{parts[1]}"
            else:
                table_ref_str = full_table
            table_ref = client.get_table(table_ref_str)
            return [{"name": f.name, "type": f.field_type} for f in table_ref.schema]
        except Exception as e:
            logger.warning(f"_bq_list_columns failed for table '{full_table}': {e}")
            return []
        finally:
            if client:
                client.close()

    @staticmethod
    def _sheets_list_columns(config: Dict[str, Any], sheet_name: str) -> List[Dict[str, str]]:
        """Get column headers from a Manual (CSV/Excel) cached snapshot.
        Config format: {"sheets": {sheet_name: {"columns": [{name, type}], "rows": [...]}}}
        """
        try:
            cached_sheets = config.get("sheets", {})
            sheet_data = cached_sheets.get(sheet_name) or (list(cached_sheets.values())[0] if cached_sheets else None)
            if not sheet_data:
                return []
            # Format A: {"columns": [{name, type}, ...], "rows": [...]}
            if isinstance(sheet_data, dict) and "columns" in sheet_data:
                cols = sheet_data["columns"]
                return [
                    {"name": c["name"] if isinstance(c, dict) else str(c),
                     "type": c.get("type", "string") if isinstance(c, dict) else "string"}
                    for c in cols if c
                ]
            # Format B: [[header1, header2, ...], [row1...], ...]
            if isinstance(sheet_data, list) and len(sheet_data) > 0:
                headers = sheet_data[0]
                if isinstance(headers, list):
                    return [{"name": str(h), "type": "string"} for h in headers if h]
                if isinstance(headers, dict):
                    return [{"name": k, "type": "string"} for k in headers.keys()]
            return []
        except Exception:
            return []

    @staticmethod
    def _google_sheets_list_columns(config: Dict[str, Any], sheet_name: str) -> List[Dict[str, str]]:
        """Get column headers from the live Google Sheets workbook."""
        try:
            spreadsheet_id, connector = DataSourceConnectionService._get_google_sheets_connector(config)
            target_sheet = str(sheet_name or config.get("sheet_name") or "").strip()
            if not target_sheet:
                sheet_names = connector.list_sheets(spreadsheet_id)
                target_sheet = sheet_names[0] if sheet_names else ""
            if not target_sheet:
                return []
            data = connector.get_sheet_data(spreadsheet_id, sheet_name=target_sheet)
            return [
                {
                    "name": col["name"] if isinstance(col, dict) else str(col),
                    "type": col.get("type", "string") if isinstance(col, dict) else "string",
                }
                for col in data.get("columns", [])
                if col
            ]
        except Exception:
            return []
