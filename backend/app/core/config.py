"""
Configuration management using Pydantic Settings.
"""
import pathlib
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List

# Root .env is 4 levels up from backend/app/core/config.py
_ROOT_ENV = str(pathlib.Path(__file__).resolve().parent.parent.parent.parent / ".env")


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Server
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8000
    API_RELOAD: bool = True
    
    # Database (Metadata Store)
    DATABASE_URL: str
    
    # CORS
    CORS_ORIGINS: str = "http://localhost:3000,http://localhost:3001,http://localhost:3002"
    
    # Logging
    LOG_LEVEL: str = "INFO"
    
    # Security
    SECRET_KEY: str = "dev-secret-key-change-in-production"
    
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
