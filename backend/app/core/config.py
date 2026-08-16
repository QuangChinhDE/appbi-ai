"""
Configuration management using Pydantic Settings.
"""
import pathlib
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List, Optional


def _find_project_root() -> pathlib.Path:
    """
    Walk up from this file to find the project root.
    The project root is the directory that contains BOTH a '.env' (or
    '.env.example') file AND a 'backend/' subdirectory.
    Falls back to the directory 4 levels above this file (legacy behaviour)
    if the walk reaches the filesystem root without finding a match.
    """
    candidate = pathlib.Path(__file__).resolve().parent
    for _ in range(10):  # Walk at most 10 levels up
        if (candidate / "backend").is_dir() and (
            (candidate / ".env").exists()
            or (candidate / ".env.example").exists()
            or (candidate / "docker-compose.yml").exists()
        ):
            return candidate
        parent = candidate.parent
        if parent == candidate:  # Reached filesystem root
            break
        candidate = parent
    # Fallback: 4 levels above config.py (works for local dev layout)
    # In Docker the DATA_DIR env var is always set to an absolute path,
    # so _resolve_data_dir never uses _PROJECT_ROOT.
    return pathlib.Path(__file__).resolve().parent.parent.parent.parent


_PROJECT_ROOT = _find_project_root()
_ROOT_ENV = str(_PROJECT_ROOT / ".env")

# Text generation keeps one application default. Knowledge documents may choose
# one of the configured embedding models, while every profile emits the same
# 768 dimensions required by the current pgvector columns.
OPENAI_TEXT_MODEL = "gpt-4o-mini"
OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"
OPENAI_EMBEDDING_DIMS = 768


def _first_non_empty(*values: str) -> str:
    for value in values:
        if value and value.strip():
            return value.strip()
    return ""


def _resolve_data_dir(raw: str) -> pathlib.Path:
    """Resolve DATA_DIR to an absolute path relative to project root."""
    p = pathlib.Path(raw)
    if not p.is_absolute():
        p = _PROJECT_ROOT / p
    p.mkdir(parents=True, exist_ok=True)
    return p


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Server
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8000
    API_RELOAD: bool = True
    
    # Database (Metadata Store)
    DATABASE_URL: str
    
    # Local application storage
    DATA_DIR: str = ".data"

    @property
    def data_dir_path(self) -> pathlib.Path:
        """Resolved absolute path for data storage."""
        return _resolve_data_dir(self.DATA_DIR)

    # CORS
    CORS_ORIGINS: str = "http://localhost:3000,http://localhost:3001,http://localhost:3002"
    
    # Logging
    LOG_LEVEL: str = "INFO"
    
    # Security
    SECRET_KEY: str = "dev-secret-key-change-in-production"
    DATASOURCE_ENCRYPTION_KEY: str = ""
    COOKIE_SECURE: bool = True
    ENVIRONMENT: str = "production"

    # Public base URL of THIS AppBI deployment (scheme + host, no trailing slash),
    # e.g. "https://report.base-datateam.com". Used to build absolute embed URLs
    # returned by the integration API so they are correct regardless of how the
    # API was reached (direct vs reverse-proxy). Empty = derive from the request.
    PUBLIC_BASE_URL: str = ""

    AUTH_PASSWORD_LOGIN_ENABLED: bool = True
    AUTH_GOOGLE_ENABLED: bool = False

    # Workboard mini-app builder module — bundled with the core stack.
    WORKBOARDS_ENABLED: bool = True

    # ── Metadata Catalog / Governance (DB-backed) ───────────────────────
    # Default OFF — the catalog module is fully INERT until enabled (not even
    # imported while off; see app/api/__init__.py). When True, /api/v1/catalog/*
    # is served by the AppBI DB-backed GovernanceService (no external OM server).
    METADATA_CATALOG_ENABLED: bool = False
    # Per-module flags for the catalog surfaces (each its own toggle, like
    # WORKBOARDS_ENABLED). Effective only when METADATA_CATALOG_ENABLED is on
    # (the modules need the /catalog backend) — see permissions._OPTIONAL_MODULES.
    # Govern = Metrics/Glossary/Classification; Observability = Data Quality/Incidents/Alerts.
    GOVERN_ENABLED: bool = True
    OBSERVABILITY_ENABLED: bool = True

    # ── AI Intelligence (docs/Intelligence/appbi_intelligence_backend_redesign_v2.md) ──
    # Every switch below defaults to the pre-v2 behaviour, so a deployment that
    # sets none of them behaves exactly as it does today. Turn them on one at a
    # time and compare against the baseline captured before rollout.
    #
    # Input guardrail on the public chat. "log" measures the false-positive rate
    # on real traffic without ever rejecting a viewer; flip to "block" once the
    # log is clean. "off" disables it entirely.
    INTELLIGENCE_GUARD_MODE: str = "log"          # off | log | block
    # Spend ceilings for the PUBLIC chat, enforced per shared link per rolling
    # 24h / 1h. Only bind when the ORG's key pays (appearance_config.ai_bot_key);
    # a viewer using their own key is metered but never blocked on cost.
    # 0 = unlimited (the pre-v2 behaviour).
    AI_DEFAULT_BUDGET_USD_PER_DAY: float = 5.0
    AI_DEFAULT_TURNS_PER_HOUR: int = 120
    # Evidence ledger: persist one row per tool call so every number in an
    # answer can be traced back to the call that produced it.
    # ON by default. Verification is fail-closed, so an empty ledger would mean
    # every figure is unverifiable — the ledger is no longer optional telemetry,
    # it is the thing answers are checked against.
    INTELLIGENCE_EVIDENCE_ENABLED: bool = True
    INTELLIGENCE_EVIDENCE_TTL_DAYS: int = 30
    # Deterministic answer verification. "log" records coverage only; "repair"
    # additionally asks the model to fix unsupported numbers. Needs the
    # evidence ledger to be on to do anything.
    INTELLIGENCE_VERIFIER_MODE: str = "off"       # off | log | repair

    # ── Filter-system migration toggles (PBI-parity migration) ──────────
    # Default OFF — legacy code path unchanged. Phase 0/1 ship the foundations;
    # callers begin opting-in once golden-harness + production smoke-tests pass.
    # Documented in docs/filter-migration-pbi-parity.md and per-phase files
    # under docs/phases/.
    #
    # ── DECISION (2026-06-02): these three flags STAY OFF permanently. ──
    # The always-on **measure-isolation engine** (base-invariance: each measure
    # is evaluated at its OWN fact grain — re-anchor / scalar subquery / stitch,
    # see semantic_query_engine.generate_sql) is the SINGLE propagation engine.
    # It is verified correct on star (ds64/ds65), galaxy/multi-fact (ds65
    # RC02_SDR: deal/activity/meeting/revenue + conformed owner/Date), and
    # snowflake (ds66) topologies, on BigQuery + Postgres.
    #   • PROPAGATION_ENGINE_V2 OVERLAPS isolation and CONFLICTS with it — an
    #     A/B test on real BQ (ds65) showed turning it ON regressed a verified
    #     chart (3,915 → 7,595, breaking base-invariance) because the per-filter
    #     router and the isolation re-anchor both try to own propagation. There
    #     is no scenario where v2 is needed AND isolation is present.
    #   • SYMMETRIC_AGGREGATES is BQ-only-gated anyway (53× slower than EXISTS on
    #     Postgres — see memory/symmetric_postgres_pessimization.md) and is only
    #     reachable via v2; with v2 off it never fires.
    #   • PER_MEASURE_ISOLATION is the OLDER N-queries-merged approach, fully
    #     superseded by the in-SQL isolation engine.
    # Do NOT enable any of these without first re-running the cross-fact
    # base-invariance matrix on a galaxy fixture — they will silently diverge
    # from isolation.

    # Phase 2 — replaces ad-hoc reachability checks with explicit propagation
    # rules (cardinality + cross_filter aware). SUPERSEDED by isolation — see
    # DECISION above. Keep OFF.
    FEATURE_PROPAGATION_ENGINE_V2: bool = False

    # Phase 3 — multi-fact charts emit one SQL query per fact (parallel),
    # results merged in Python. SUPERSEDED by the in-SQL isolation/stitch
    # engine (see DECISION above). Keep OFF.
    FEATURE_PER_MEASURE_ISOLATION: bool = False

    # Phase 4 — Looker-style MD5/FARM_FINGERPRINT symmetric aggregates when
    # the engine must JOIN through a 1:N hop AND a view declares primary_key.
    # When primary_key is absent, the Phase-B' EXISTS rewrite stays as fallback.
    FEATURE_SYMMETRIC_AGGREGATES: bool = False

    # Phase 4.3 — empirical bench (see memory/symmetric_postgres_pessimization.md)
    # showed Looker symmetric is 53× SLOWER than EXISTS on Postgres at 1M rows.
    # This list is the allow-list of dialects where the symmetric form is
    # emitted; on any other dialect the renderer falls through to the legacy
    # aggregate (correctness then depends on Phase-2 having routed the filter
    # through EXISTS instead of SYMMETRIC). Comma-separated; matched
    # case-insensitively against ``SemanticQueryEngine.database_type``.
    FEATURE_SYMMETRIC_AGGREGATES_DIALECTS: str = "bigquery"
    AUTH_GOOGLE_CLIENT_ID: str = ""
    AUTH_GOOGLE_CLIENT_SECRET: str = ""
    AUTH_GOOGLE_DATA_REDIRECT_URI: str = ""
    AUTH_GOOGLE_ALLOWED_DOMAINS: str = ""
    AUTH_GOOGLE_AUTO_CREATE_USERS: bool = False
    AUTH_GOOGLE_BOOTSTRAP_ADMIN_EMAIL: str = ""

    # Platform-level Google / GCP service account
    # When set, users do NOT need to paste a credentials JSON when connecting
    # Google Sheets or BigQuery — they only need to share their resource with
    # the service-account email shown in the UI.
    GCP_SERVICE_ACCOUNT_JSON: str = ""
    GCP_SERVICE_ACCOUNT_EMAIL: str = ""

    # AI / Embedding
    # Provider API keys (backend AI tasks + report AI bot).
    OPENAI_API_KEY: str = ""
    GEMINI_API_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""
    # Comma-separated allowlist shown when a knowledge document is created.
    # Only OpenAI text-embedding-3 models are compatible with the configurable
    # `dimensions` request used by this deployment.
    OPENAI_EMBEDDING_MODELS: str = (
        "text-embedding-3-small,text-embedding-3-large"
    )

    # May a PUBLIC link's assistant spend the deployment's own API key?
    #
    # Default on, because an operator who configures a key expects the assistant to
    # work without every viewer pasting one. It is still not implicit: the bot must
    # be enabled on that link, a flow must be bound to it with a data contract, and
    # every turn is bounded by that binding's budget. Set false to require a
    # per-link or per-viewer key instead.
    PUBLIC_BOT_USE_DEPLOYMENT_KEY: bool = True

    # Large data thresholds — tables exceeding these are auto-set to query_mode="live"
    LARGE_TABLE_ROW_THRESHOLD: int = 50_000_000         # 50M rows
    LARGE_TABLE_SIZE_THRESHOLD_GB: float = 5.0          # 5 GB
    BQ_MAX_BYTES_SCANNED: int = 60 * 1024**3            # 60 GB dry-run guard
    BQ_PREVIEW_PARTITION_MAX_LOOKBACK_DAYS: int = 365   # fallback when partition metadata is unavailable
    # Dashboard perf #5 — snapshot materialization. Global default dataset where
    # flat snapshot tables are written; a per-datasource `materialization_dataset`
    # config value overrides it, this is the .env-configurable fallback.
    MATERIALIZATION_DATASET: str = "appbi_snapshots"
    MATERIALIZATION_DEFAULT_TTL_MINUTES: int = 30       # freshness TTL fallback (public links / builder)
    # Global AppBI write service account for snapshot CREATE+LOAD (never reads
    # source). KEY_FILE (path to SA JSON) takes priority over inline JSON; blank
    # → fall back to the datasource's own credential. Per-datasource
    # `materialization_write_credentials_json` overrides both.
    MATERIALIZATION_SA_KEY_FILE: str = ""
    MATERIALIZATION_SA_CREDENTIALS_JSON: str = ""
    # Platform default BigQuery snapshot host. A dataset with NO BigQuery source
    # of its own (e.g. Sheets-only, Postgres-only) still needs a BQ host to
    # materialize its published snapshot into — "snapshot store = BigQuery" is
    # the serving invariant. Set this to the datasource id of the BQ project that
    # should host such snapshots; blank → snapshot_service falls back to the
    # lowest-id materialization-enabled BQ datasource in the system.
    MATERIALIZATION_HOST_DATASOURCE_ID: Optional[int] = None
    # ── DB connection pool (SQLAlchemy) ─────────────────────────────────────
    # Sized for concurrent report views. get_db holds a connection for the whole
    # request, and on a COLD burst the public-meta coalescing waiters keep holding
    # theirs while polling for the leader's result — so peak concurrent requests
    # per worker is bounded by (pool_size + max_overflow). 40/worker absorbs a
    # realistic burst; the connection is still released during the slow BigQuery
    # call itself (chart_service). HARD RULE: (pool_size + max_overflow) ×
    # WEB_CONCURRENCY (+ the pdf-worker's own pool) MUST stay below Postgres
    # max_connections. Defaults: 4 workers × 40 = 160 + pdf ≈ 40 → set Postgres
    # max_connections ≥ 250 (docker-compose local-db does this).
    DB_POOL_SIZE: int = 20
    DB_MAX_OVERFLOW: int = 20
    DB_POOL_TIMEOUT: int = 10                            # fail fast on exhaustion
    DB_POOL_RECYCLE: int = 1800                          # drop conns after 30 min
    LIVE_QUERY_CACHE_TTL: int = 300                     # 5 minutes
    LIVE_QUERY_CACHE_MAX_SIZE: int = 256                # max entries
    LIVE_QUERY_SHARED_CACHE_ENABLED: bool = True        # persistent cross-reload/process cache
    LIVE_QUERY_SHARED_CACHE_DB_PATH: str = ""           # defaults to DATA_DIR/live_query_cache.sqlite3
    LIVE_QUERY_SHARED_CACHE_MAX_SIZE: int = 4096        # global shared-cache row cap

    # ── Embed M2M resolve rate limit ────────────────────────────────────────
    # POST /integrations/embed/resolve is PAT-authenticated and cheap (DB only,
    # never touches the warehouse) — a trusted host app mints a scoped link per
    # viewer. It is keyed by the CALLER'S PAT (not IP) so one integrating server
    # minting links for thousands of viewers isn't throttled as a single IP.
    # Generous by default; still blocks a runaway mint loop.
    EMBED_RESOLVE_RATE_LIMIT: str = "6000/minute"

    # ── Server-side PDF export (pdf-worker container) ───────────────────
    # The API accepts export jobs only when a worker can actually pick them up;
    # otherwise the frontend falls back to the in-browser exporter, so a stack
    # deployed WITHOUT the worker keeps working exactly as before.
    PDF_EXPORT_ENABLED: bool = False
    # Base URL the WORKER uses to reach the frontend (container-to-container).
    PDF_RENDER_BASE_URL: str = "http://frontend:3000"
    # Seconds the worker waits for one dashboard page to become render-ready.
    PDF_RENDER_PAGE_TIMEOUT: int = 120
    # Hard ceiling for one job (all pages) — protects the worker from a hung tile.
    PDF_RENDER_JOB_TIMEOUT: int = 900
    # A running job whose heartbeat is older than this is considered dead and is
    # requeued (worker crash / container restart).
    PDF_JOB_LEASE_SECONDS: int = 180
    PDF_JOB_MAX_ATTEMPTS: int = 3
    # Retention for rendered files + their job rows' download links.
    PDF_FILE_TTL_HOURS: int = 48
    # Quota: exports started per rolling hour, per public link and per user.
    PDF_QUOTA_PER_LINK_HOUR: int = 20
    PDF_QUOTA_PER_USER_HOUR: int = 60
    # Global cap on jobs a single worker runs at once.
    PDF_WORKER_CONCURRENCY: int = 1

    # ── SMTP / Email Notifications ──────────────────────────────────────
    # Used by: dataset quality scheduled runs -> email PDF report.
    # When SMTP_HOST is empty, the email delivery is skipped gracefully and
    # an informational log entry is written (no error is raised).
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_USE_TLS: bool = True              # STARTTLS
    SMTP_USE_SSL: bool = False             # Implicit SSL (port 465)
    SMTP_FROM_EMAIL: str = ""              # Falls back to SMTP_USERNAME when empty
    SMTP_FROM_NAME: str = "AppBI"
    SMTP_TIMEOUT_SECONDS: int = 20

    @property
    def smtp_enabled(self) -> bool:
        return bool(self.SMTP_HOST.strip())

    @property
    def smtp_from_email(self) -> str:
        return (self.SMTP_FROM_EMAIL or self.SMTP_USERNAME or "").strip()

    # ── Backend AI models — all fixed to OpenAI in code ─────────────────
    # These properties keep their historical names (other modules call them)
    # but now return the hardcoded OpenAI model regardless of provider.
    @property
    def active_description_model(self) -> str:
        return OPENAI_TEXT_MODEL

    @property
    def active_dataset_docs_model(self) -> str:
        return OPENAI_TEXT_MODEL

    @property
    def active_chart_docs_model(self) -> str:
        return OPENAI_TEXT_MODEL

    @property
    def quality_gemini_model(self) -> str:
        return OPENAI_TEXT_MODEL

    @property
    def quality_openrouter_model(self) -> str:
        return OPENAI_TEXT_MODEL

    @property
    def active_quality_model(self) -> str:
        """Model for quality rule suggestions."""
        return OPENAI_TEXT_MODEL

    @property
    def html_import_gemini_model(self) -> str:
        return OPENAI_TEXT_MODEL

    @property
    def html_import_openrouter_model(self) -> str:
        return OPENAI_TEXT_MODEL

    @property
    def html_import_ai_provider(self) -> str:
        return "openai" if self.OPENAI_API_KEY.strip() else "unavailable"

    @property
    def html_import_ai_available(self) -> bool:
        return self.html_import_ai_provider != "unavailable"

    @property
    def html_import_ai_model(self) -> str:
        return OPENAI_TEXT_MODEL

    @property
    def active_embedding_model(self) -> str:
        return OPENAI_EMBEDDING_MODEL

    @property
    def openai_embedding_dimensions(self) -> int:
        return OPENAI_EMBEDDING_DIMS

    @property
    def embedding_models(self) -> List[str]:
        models = [
            item.strip()
            for item in self.OPENAI_EMBEDDING_MODELS.split(",")
            if item.strip()
        ]
        if OPENAI_EMBEDDING_MODEL not in models:
            models.insert(0, OPENAI_EMBEDDING_MODEL)
        return list(dict.fromkeys(models))

    @property
    def active_api_keys(self) -> List[str]:
        """The configured OpenAI key (single-element list), or empty."""
        return [self.OPENAI_API_KEY.strip()] if self.OPENAI_API_KEY.strip() else []

    @property
    def live_query_shared_cache_db_path(self) -> pathlib.Path:
        """Resolved absolute path for the shared live-query cache database."""
        raw = self.LIVE_QUERY_SHARED_CACHE_DB_PATH.strip()
        if raw:
            path = pathlib.Path(raw)
            if not path.is_absolute():
                path = _PROJECT_ROOT / path
        else:
            path = self.data_dir_path / "live_query_cache.sqlite3"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path
    
    model_config = SettingsConfigDict(
        env_file=_ROOT_ENV,
        case_sensitive=True,
        extra="ignore"
    )
    
    @property
    def cors_origins_list(self) -> List[str]:
        """Parse CORS origins from comma-separated string."""
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",")]

    @property
    def auth_google_allowed_domains_list(self) -> List[str]:
        """Parse allowed Google email domains from comma-separated string."""
        return [
            domain.strip().lower()
            for domain in self.AUTH_GOOGLE_ALLOWED_DOMAINS.split(",")
            if domain.strip()
        ]


# Global settings instance
settings = Settings()

_INSECURE_DEFAULTS = {
    "dev-secret-key-change-in-production",
    "change-this-in-production",
}


def validate_security_settings() -> None:
    """Fail-fast if production is running with insecure defaults."""
    if settings.ENVIRONMENT.lower() in ("dev", "development", "test"):
        return  # skip validation in dev/test

    errors: list[str] = []
    if settings.AUTH_GOOGLE_ENABLED and not settings.AUTH_GOOGLE_CLIENT_ID.strip():
        errors.append(
            "AUTH_GOOGLE_ENABLED is true but AUTH_GOOGLE_CLIENT_ID is empty. "
            "Create a Google OAuth Web client and set its client ID."
        )
    if settings.SECRET_KEY in _INSECURE_DEFAULTS:
        errors.append(
            "SECRET_KEY is still set to a development default. "
            "Generate a secure key: python -c 'import secrets; print(secrets.token_urlsafe(64))'"
        )
    if not settings.DATASOURCE_ENCRYPTION_KEY:
        errors.append(
            "DATASOURCE_ENCRYPTION_KEY is empty — datasource credentials will be stored in plaintext. "
            "Generate a key: python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'"
        )
    if errors:
        msg = "FATAL — Insecure configuration detected:\n" + "\n".join(f"  • {e}" for e in errors)
        raise RuntimeError(msg)

