"""
Configuration management using Pydantic Settings.
"""
import pathlib
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List


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
    AUTH_PASSWORD_LOGIN_ENABLED: bool = True
    AUTH_GOOGLE_ENABLED: bool = False
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
    # Primary key (backward-compat) + up to 5 numbered keys for rotation
    OPENROUTER_API_KEY: str = ""
    OPENROUTER_API_KEY_1: str = ""
    OPENROUTER_API_KEY_2: str = ""
    OPENROUTER_API_KEY_3: str = ""
    OPENROUTER_API_KEY_4: str = ""
    OPENROUTER_API_KEY_5: str = ""
    OPENROUTER_SITE_URL: str = "http://localhost:3000"
    OPENROUTER_APP_NAME: str = "AppBI"
    BACKEND_AI_DEFAULT_MODEL: str = ""
    BACKEND_AI_DATASET_DOCS_MODEL: str = ""
    BACKEND_AI_CHART_DOCS_MODEL: str = ""
    BACKEND_AI_QUALITY_RULE_GEMINI_MODEL: str = ""
    BACKEND_AI_QUALITY_RULE_OPENROUTER_MODEL: str = ""
    BACKEND_AI_TEMPLATE_IMPORT_GEMINI_MODEL: str = ""
    BACKEND_AI_TEMPLATE_IMPORT_OPENROUTER_MODEL: str = ""
    BACKEND_AI_EMBEDDING_MODEL: str = ""
    BACKEND_AI_REPORT_SUMMARY_MODEL: str = ""
    AI_DESCRIPTION_MODEL: str = "google/gemini-2.5-flash-lite"
    GEMINI_API_KEY: str = ""
    GEMINI_IMPORT_MODEL: str = "gemini-2.5-flash-lite"
    GEMINI_QUALITY_MODEL: str = ""
    OPENROUTER_GEMINI_IMPORT_MODEL: str = "google/gemini-2.5-flash-lite"
    OPENROUTER_EMBEDDING_MODEL: str = "openai/text-embedding-3-small"
    OPENROUTER_EMBEDDING_DIMENSIONS: int = 768

    # Large data thresholds — tables exceeding these are auto-set to query_mode="live"
    LARGE_TABLE_ROW_THRESHOLD: int = 50_000_000         # 50M rows
    LARGE_TABLE_SIZE_THRESHOLD_GB: float = 5.0          # 5 GB
    BQ_MAX_BYTES_SCANNED: int = 60 * 1024**3            # 60 GB dry-run guard
    BQ_PREVIEW_PARTITION_MAX_LOOKBACK_DAYS: int = 365   # fallback when partition metadata is unavailable
    LIVE_QUERY_CACHE_TTL: int = 300                     # 5 minutes
    LIVE_QUERY_CACHE_MAX_SIZE: int = 256                # max entries
    LIVE_QUERY_SHARED_CACHE_ENABLED: bool = True        # persistent cross-reload/process cache
    LIVE_QUERY_SHARED_CACHE_DB_PATH: str = ""           # defaults to DATA_DIR/live_query_cache.sqlite3
    LIVE_QUERY_SHARED_CACHE_MAX_SIZE: int = 4096        # global shared-cache row cap
    ENABLE_DATASOURCE_SYNC: bool = False                # live-query-first mode

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

    @property
    def active_description_model(self) -> str:
        return self.active_dataset_docs_model

    @property
    def active_dataset_docs_model(self) -> str:
        return _first_non_empty(
            self.BACKEND_AI_DATASET_DOCS_MODEL,
            self.AI_DESCRIPTION_MODEL,
            self.BACKEND_AI_DEFAULT_MODEL,
            "google/gemini-2.5-flash-lite",
        )

    @property
    def active_chart_docs_model(self) -> str:
        return _first_non_empty(
            self.BACKEND_AI_CHART_DOCS_MODEL,
            self.AI_DESCRIPTION_MODEL,
            self.BACKEND_AI_DATASET_DOCS_MODEL,
            self.BACKEND_AI_DEFAULT_MODEL,
            "google/gemini-2.5-flash-lite",
        )

    @property
    def quality_gemini_model(self) -> str:
        return _first_non_empty(
            self.BACKEND_AI_QUALITY_RULE_GEMINI_MODEL,
            self.GEMINI_QUALITY_MODEL,
            self.BACKEND_AI_TEMPLATE_IMPORT_GEMINI_MODEL,
            self.GEMINI_IMPORT_MODEL,
            "gemini-2.5-flash",
        )

    @property
    def quality_openrouter_model(self) -> str:
        return _first_non_empty(
            self.BACKEND_AI_QUALITY_RULE_OPENROUTER_MODEL,
            self.BACKEND_AI_DEFAULT_MODEL,
            self.AI_DESCRIPTION_MODEL,
            "google/gemini-2.5-flash",
        )

    @property
    def active_quality_model(self) -> str:
        """Model for quality rule suggestions."""
        if self.GEMINI_API_KEY.strip():
            return self.quality_gemini_model
        return self.quality_openrouter_model

    @property
    def template_import_gemini_model(self) -> str:
        return _first_non_empty(
            self.BACKEND_AI_TEMPLATE_IMPORT_GEMINI_MODEL,
            self.GEMINI_IMPORT_MODEL,
            "gemini-2.5-flash-lite",
        )

    @property
    def template_import_openrouter_model(self) -> str:
        return _first_non_empty(
            self.BACKEND_AI_TEMPLATE_IMPORT_OPENROUTER_MODEL,
            self.OPENROUTER_GEMINI_IMPORT_MODEL,
            self.BACKEND_AI_DEFAULT_MODEL,
            "google/gemini-2.5-flash-lite",
        )

    @property
    def template_import_ai_provider(self) -> str:
        if self.GEMINI_API_KEY.strip():
            return "gemini"
        if self.active_api_keys:
            return "openrouter-gemini"
        return "unavailable"

    @property
    def template_import_ai_available(self) -> bool:
        return self.template_import_ai_provider != "unavailable"

    @property
    def template_import_ai_model(self) -> str:
        if self.template_import_ai_provider == "gemini":
            return self.template_import_gemini_model
        return self.template_import_openrouter_model

    @property
    def active_embedding_model(self) -> str:
        return _first_non_empty(
            self.BACKEND_AI_EMBEDDING_MODEL,
            self.OPENROUTER_EMBEDDING_MODEL,
            "openai/text-embedding-3-small",
        )

    @property
    def active_api_keys(self) -> List[str]:
        """All configured OpenRouter keys in priority order."""
        numbered = [
            self.OPENROUTER_API_KEY_1,
            self.OPENROUTER_API_KEY_2,
            self.OPENROUTER_API_KEY_3,
            self.OPENROUTER_API_KEY_4,
            self.OPENROUTER_API_KEY_5,
        ]
        keys = [k.strip() for k in numbered if k.strip()]
        default_key = self.OPENROUTER_API_KEY.strip()
        if default_key and default_key not in keys:
            keys.append(default_key)
        return keys

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

