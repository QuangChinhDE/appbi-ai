"""AI Agent service configuration."""
import pathlib
from typing import Dict, List

from pydantic import Field
from pydantic_settings import BaseSettings

_ROOT_ENV = str(pathlib.Path(__file__).resolve().parent.parent.parent / ".env")


def _first_non_empty(*values: str) -> str:
    for value in values:
        if value and value.strip():
            return value.strip()
    return ""


class Settings(BaseSettings):
    bi_api_url: str = Field("http://localhost:8000/api/v1", alias="BI_API_URL")
    secret_key: str = Field("dev-secret-key-change-in-production", alias="SECRET_KEY")
    log_level: str = Field("INFO", alias="LOG_LEVEL")

    # CORS
    cors_origins: str = Field("http://localhost:3000", alias="CORS_ORIGINS")

    # Environment — set to 'dev' to skip secret validation
    environment: str = Field("production", alias="ENVIRONMENT")

    llm_model: str = Field("google/gemini-2.5-flash-lite", alias="LLM_MODEL")
    llm_fallback_chain: str = Field("", alias="LLM_FALLBACK_CHAIN")
    llm_timeout_seconds: int = Field(60, alias="LLM_TIMEOUT_SECONDS")

    ai_report_default_model: str = Field("", alias="AI_REPORT_DEFAULT_MODEL")
    ai_report_fallback_models: str = Field("", alias="AI_REPORT_FALLBACK_MODELS")
    ai_report_llm_fallback_chain: str = Field("", alias="AI_REPORT_LLM_FALLBACK_CHAIN")
    ai_report_timeout_seconds: int = Field(0, alias="AI_REPORT_TIMEOUT_SECONDS")
    ai_report_brief_enrichment_model: str = Field("", alias="AI_REPORT_BRIEF_ENRICHMENT_MODEL")
    ai_report_analysis_planning_model: str = Field("", alias="AI_REPORT_ANALYSIS_PLANNING_MODEL")
    ai_report_insight_generation_model: str = Field("", alias="AI_REPORT_INSIGHT_GENERATION_MODEL")
    ai_report_narrative_synthesis_model: str = Field("", alias="AI_REPORT_NARRATIVE_SYNTHESIS_MODEL")
    ai_report_summary_reader_model: str = Field("", alias="AI_REPORT_SUMMARY_READER_MODEL")

    ai_agent_model: str = Field("", alias="AI_AGENT_MODEL")
    ai_agent_llm_model: str = Field("", alias="AI_AGENT_LLM_MODEL")
    ai_agent_fallback_models: str = Field("", alias="AI_AGENT_FALLBACK_MODELS")
    ai_agent_llm_fallback_chain: str = Field("", alias="AI_AGENT_LLM_FALLBACK_CHAIN")
    ai_agent_llm_timeout_seconds: int = Field(0, alias="AI_AGENT_LLM_TIMEOUT_SECONDS")
    ai_agent_enrichment_model: str = Field("", alias="AI_AGENT_ENRICHMENT_MODEL")
    ai_agent_planning_model: str = Field("", alias="AI_AGENT_PLANNING_MODEL")
    ai_agent_insight_model: str = Field("", alias="AI_AGENT_INSIGHT_MODEL")
    ai_agent_narrative_model: str = Field("", alias="AI_AGENT_NARRATIVE_MODEL")

    # Primary key (backward-compat) + up to 5 numbered keys
    openrouter_api_key: str = Field("", alias="OPENROUTER_API_KEY")
    openrouter_api_key_1: str = Field("", alias="OPENROUTER_API_KEY_1")
    openrouter_api_key_2: str = Field("", alias="OPENROUTER_API_KEY_2")
    openrouter_api_key_3: str = Field("", alias="OPENROUTER_API_KEY_3")
    openrouter_api_key_4: str = Field("", alias="OPENROUTER_API_KEY_4")
    openrouter_api_key_5: str = Field("", alias="OPENROUTER_API_KEY_5")
    openrouter_site_url: str = Field("http://localhost:3000", alias="OPENROUTER_SITE_URL")
    openrouter_app_name: str = Field("AppBI AI Agent", alias="OPENROUTER_APP_NAME")

    @property
    def active_api_keys(self) -> List[str]:
        """Return all configured OpenRouter keys in priority order.

        Numbered keys (KEY_1..KEY_5) take precedence when set.
        Falls back to the bare OPENROUTER_API_KEY for backward-compat.
        """
        numbered = [
            self.openrouter_api_key_1,
            self.openrouter_api_key_2,
            self.openrouter_api_key_3,
            self.openrouter_api_key_4,
            self.openrouter_api_key_5,
        ]
        keys = [k.strip() for k in numbered if k.strip()]
        if not keys and self.openrouter_api_key.strip():
            keys = [self.openrouter_api_key.strip()]
        return keys

    @property
    def active_llm_provider(self) -> str:
        return "openrouter"

    @property
    def active_llm_model(self) -> str:
        return self.model_for_phase("planning")

    @property
    def active_llm_timeout_seconds(self) -> int:
        return (
            self.ai_report_timeout_seconds
            or self.ai_agent_llm_timeout_seconds
            or self.llm_timeout_seconds
        )

    @property
    def active_llm_fallback_chain(self) -> List[dict]:
        raw_chain = (
            self.ai_report_fallback_models.strip()
            or self.ai_report_llm_fallback_chain.strip()
            or self.ai_agent_fallback_models.strip()
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
            "enrichment": _first_non_empty(
                self.ai_report_brief_enrichment_model,
                self.ai_agent_enrichment_model,
                self.ai_report_default_model,
            ),
            "planning": _first_non_empty(
                self.ai_report_analysis_planning_model,
                self.ai_agent_planning_model,
                self.ai_report_default_model,
            ),
            "insight": _first_non_empty(
                self.ai_report_insight_generation_model,
                self.ai_agent_insight_model,
                self.ai_report_default_model,
            ),
            "narrative": _first_non_empty(
                self.ai_report_narrative_synthesis_model,
                self.ai_agent_narrative_model,
                self.ai_report_default_model,
            ),
        }
        return (
            overrides.get(phase_key)
            or self.ai_report_default_model.strip()
            or self.ai_agent_llm_model.strip()
            or self.ai_agent_model.strip()
            or self.llm_model
        )

    @property
    def ai_agent_phase_models(self) -> Dict[str, str]:
        return {
            "enrichment": self.model_for_phase("enrichment"),
            "planning": self.model_for_phase("planning"),
            "insight": self.model_for_phase("insight"),
            "narrative": self.model_for_phase("narrative"),
        }

    class Config:
        env_file = _ROOT_ENV
        populate_by_name = True
        extra = "ignore"


settings = Settings()

_INSECURE_DEFAULTS = {
    "dev-secret-key-change-in-production",
    "change-this-in-production",
}


def validate_security_settings() -> None:
    """Fail-fast if production is running with insecure defaults."""
    if settings.environment.lower() in ("dev", "development", "test"):
        return
    if settings.secret_key in _INSECURE_DEFAULTS:
        raise RuntimeError(
            "FATAL — SECRET_KEY is still set to a development default. "
            "Set SECRET_KEY in your .env file. Generate one with: "
            "python -c 'import secrets; print(secrets.token_urlsafe(64))'"
        )
