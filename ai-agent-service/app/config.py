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

    ai_agent_llm_provider: str = Field("", alias="AI_AGENT_LLM_PROVIDER")
    ai_agent_llm_model: str = Field("", alias="AI_AGENT_LLM_MODEL")
    ai_agent_llm_fallback_chain: str = Field("", alias="AI_AGENT_LLM_FALLBACK_CHAIN")
    ai_agent_llm_timeout_seconds: int = Field(0, alias="AI_AGENT_LLM_TIMEOUT_SECONDS")

    openai_api_key: str = Field("", alias="OPENAI_API_KEY")
    anthropic_api_key: str = Field("", alias="ANTHROPIC_API_KEY")
    gemini_api_key: str = Field("", alias="GEMINI_API_KEY")
    openrouter_api_key: str = Field("", alias="OPENROUTER_API_KEY")

    @property
    def active_llm_provider(self) -> str:
        return self.ai_agent_llm_provider.strip() or self.llm_provider

    @property
    def active_llm_model(self) -> str:
        return self.ai_agent_llm_model.strip() or self.llm_model

    @property
    def active_llm_timeout_seconds(self) -> int:
        return self.ai_agent_llm_timeout_seconds or self.llm_timeout_seconds

    @property
    def active_llm_fallback_chain(self) -> List[dict]:
        raw_chain = self.ai_agent_llm_fallback_chain.strip() or self.llm_fallback_chain.strip()
        if not raw_chain:
            return []
        result = []
        for entry in raw_chain.split(","):
            entry = entry.strip()
            if ":" not in entry:
                continue
            provider, model = entry.split(":", 1)
            result.append({"provider": provider.strip(), "model": model.strip()})
        return result

    @property
    def fallback_chain(self) -> List[dict]:
        # Backward-compatible alias for older callers.
        return self.active_llm_fallback_chain

    class Config:
        env_file = _ROOT_ENV
        populate_by_name = True
        extra = "ignore"


settings = Settings()
