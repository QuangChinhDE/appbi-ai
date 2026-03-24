"""AI Agent service configuration."""
import pathlib

from pydantic import Field
from pydantic_settings import BaseSettings

_ROOT_ENV = str(pathlib.Path(__file__).resolve().parent.parent.parent / ".env")


class Settings(BaseSettings):
    bi_api_url: str = Field("http://localhost:8000/api/v1", alias="BI_API_URL")
    secret_key: str = Field("dev-secret-key-change-in-production", alias="SECRET_KEY")
    log_level: str = Field("INFO", alias="LOG_LEVEL")
    openai_api_key: str = Field("", alias="OPENAI_API_KEY")

    class Config:
        env_file = _ROOT_ENV
        populate_by_name = True
        extra = "ignore"


settings = Settings()
