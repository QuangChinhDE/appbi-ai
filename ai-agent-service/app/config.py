"""AI Agent service configuration."""
import pathlib
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings

_ROOT_ENV = str(pathlib.Path(__file__).resolve().parent.parent.parent / ".env")


class Settings(BaseSettings):
    bi_api_url: str = Field("http://localhost:8000/api/v1", alias="BI_API_URL")
    secret_key: str = Field("dev-secret-key-change-in-production", alias="SECRET_KEY")
    log_level: str = Field("INFO", alias="LOG_LEVEL")

    llm_provider: str = Field("openai", alias="LLM_PROVIDER")
    llm_model: str = Field("gpt-4o-mini", alias="LLM_MODEL")
    llm_fallback_chain: str = Field("", alias="LLM_FALLBACK_CHAIN")
    llm_timeout_seconds: int = Field(60, alias="LLM_TIMEOUT_SECONDS")

    openai_api_key: str = Field("", alias="OPENAI_API_KEY")
    anthropic_api_key: str = Field("", alias="ANTHROPIC_API_KEY")
    gemini_api_key: str = Field("", alias="GEMINI_API_KEY")
    openrouter_api_key: str = Field("", alias="OPENROUTER_API_KEY")

    @property
    def fallback_chain(self) -> List[dict]:
        if not self.llm_fallback_chain.strip():
            return []
        result = []
        for entry in self.llm_fallback_chain.split(","):
            entry = entry.strip()
            if ":" not in entry:
                continue
            provider, model = entry.split(":", 1)
            result.append({"provider": provider.strip(), "model": model.strip()})
        return result

    class Config:
        env_file = _ROOT_ENV
        populate_by_name = True
        extra = "ignore"


settings = Settings()
