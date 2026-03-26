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
    '.env.docker.example') file AND a 'backend/' subdirectory.
    Falls back to the directory 4 levels above this file (legacy behaviour)
    if the walk reaches the filesystem root without finding a match.
    """
    candidate = pathlib.Path(__file__).resolve().parent
    for _ in range(10):  # Walk at most 10 levels up
        if (candidate / "backend").is_dir() and (
            (candidate / ".env").exists()
            or (candidate / ".env.docker.example").exists()
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
    
    # Storage (Parquet + DuckDB)
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

    # AI / Embedding (OpenRouter-only runtime)
    OPENROUTER_API_KEY: str = ""
    OPENROUTER_SITE_URL: str = "http://localhost:3000"
    OPENROUTER_APP_NAME: str = "AppBI"
    AI_DESCRIPTION_MODEL: str = "openai/gpt-4o-mini"
    OPENROUTER_EMBEDDING_MODEL: str = "openai/text-embedding-3-small"
    OPENROUTER_EMBEDDING_DIMENSIONS: int = 768

    @property
    def active_description_model(self) -> str:
        return self.AI_DESCRIPTION_MODEL.strip() or "openai/gpt-4o-mini"
    
    model_config = SettingsConfigDict(
        env_file=_ROOT_ENV,
        case_sensitive=True,
        extra="ignore"
    )
    
    @property
    def cors_origins_list(self) -> List[str]:
        """Parse CORS origins from comma-separated string."""
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",")]


# Global settings instance
settings = Settings()
