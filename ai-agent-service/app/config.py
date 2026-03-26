"""AI Agent service configuration."""
import pathlib
from typing import Dict, List

from pydantic import Field
from pydantic_settings import BaseSettings

_ROOT_ENV = str(pathlib.Path(__file__).resolve().parent.parent.parent / ".env")


class Settings(BaseSettings):
    bi_api_url: str = Field("http://localhost:8000/api/v1", alias="BI_API_URL")
    secret_key: str = Field("dev-secret-key-change-in-production", alias="SECRET_KEY")
    log_level: str = Field("INFO", alias="LOG_LEVEL")

    llm_model: str = Field("openai/gpt-4o-mini", alias="LLM_MODEL")
    llm_fallback_chain: str = Field("", alias="LLM_FALLBACK_CHAIN")
    llm_timeout_seconds: int = Field(60, alias="LLM_TIMEOUT_SECONDS")

    ai_agent_model: str = Field("", alias="AI_AGENT_MODEL")
    ai_agent_llm_model: str = Field("", alias="AI_AGENT_LLM_MODEL")
    ai_agent_fallback_models: str = Field("", alias="AI_AGENT_FALLBACK_MODELS")
    ai_agent_llm_fallback_chain: str = Field("", alias="AI_AGENT_LLM_FALLBACK_CHAIN")
    ai_agent_llm_timeout_seconds: int = Field(0, alias="AI_AGENT_LLM_TIMEOUT_SECONDS")
    ai_agent_planning_model: str = Field("", alias="AI_AGENT_PLANNING_MODEL")
    ai_agent_insight_model: str = Field("", alias="AI_AGENT_INSIGHT_MODEL")
    ai_agent_narrative_model: str = Field("", alias="AI_AGENT_NARRATIVE_MODEL")

    openrouter_api_key: str = Field("", alias="OPENROUTER_API_KEY")
    openrouter_site_url: str = Field("http://localhost:3000", alias="OPENROUTER_SITE_URL")
    openrouter_app_name: str = Field("AppBI AI Agent", alias="OPENROUTER_APP_NAME")

    @property
    def active_llm_provider(self) -> str:
        return "openrouter"

    @property
    def active_llm_model(self) -> str:
        return self.model_for_phase("planning")

    @property
    def active_llm_timeout_seconds(self) -> int:
        return self.ai_agent_llm_timeout_seconds or self.llm_timeout_seconds

    @property
    def active_llm_fallback_chain(self) -> List[dict]:
        raw_chain = (
            self.ai_agent_fallback_models.strip()
            or self.ai_agent_llm_fallback_chain.strip()
            or self.llm_fallback_chain.strip()
        )
        if not raw_chain:
            return []
        result = []
        for entry in raw_chain.split(","):
            entry = entry.strip()
            if not entry:
                continue
            if ":" in entry:
                _, model = entry.split(":", 1)
            else:
                model = entry
            result.append({"provider": "openrouter", "model": model.strip()})
        return result

    @property
    def fallback_chain(self) -> List[dict]:
        # Backward-compatible alias for older callers.
        return self.active_llm_fallback_chain

    def model_for_phase(self, phase: str) -> str:
        phase_key = (phase or "").strip().lower()
        overrides = {
            "planning": self.ai_agent_planning_model.strip() or self.ai_agent_model.strip(),
            "insight": self.ai_agent_insight_model.strip(),
            "narrative": self.ai_agent_narrative_model.strip(),
        }
        return (
            overrides.get(phase_key)
            or self.ai_agent_llm_model.strip()
            or self.ai_agent_model.strip()
            or self.llm_model
        )

    @property
    def ai_agent_phase_models(self) -> Dict[str, str]:
        return {
            "planning": self.model_for_phase("planning"),
            "insight": self.model_for_phase("insight"),
            "narrative": self.model_for_phase("narrative"),
        }

    class Config:
        env_file = _ROOT_ENV
        populate_by_name = True
        extra = "ignore"


settings = Settings()
