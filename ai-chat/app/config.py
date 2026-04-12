"""
AI Service configuration.
All settings driven by environment variables — no hard-coded LLM provider.
"""
import pathlib
from pydantic_settings import BaseSettings
from pydantic import Field
from typing import List

# Root .env is 3 levels up from ai-service/app/config.py
_ROOT_ENV = str(pathlib.Path(__file__).resolve().parent.parent.parent / ".env")


class Settings(BaseSettings):
    # BI backend
    bi_api_url: str = Field("http://localhost:8000/api/v1", alias="BI_API_URL")

    # OpenRouter-backed chat runtime
    llm_model: str = Field("openai/gpt-4o-mini", alias="LLM_MODEL")
    ai_chat_model: str = Field("", alias="AI_CHAT_MODEL")

    # Fallback chain - accepts either plain models or legacy provider:model pairs
    llm_fallback_chain: str = Field("", alias="LLM_FALLBACK_CHAIN")
    ai_chat_fallback_models: str = Field("", alias="AI_CHAT_FALLBACK_MODELS")

    # OpenRouter config — primary + up to 5 numbered keys
    openrouter_api_key: str = Field("", alias="OPENROUTER_API_KEY")
    openrouter_api_key_1: str = Field("", alias="OPENROUTER_API_KEY_1")
    openrouter_api_key_2: str = Field("", alias="OPENROUTER_API_KEY_2")
    openrouter_api_key_3: str = Field("", alias="OPENROUTER_API_KEY_3")
    openrouter_api_key_4: str = Field("", alias="OPENROUTER_API_KEY_4")
    openrouter_api_key_5: str = Field("", alias="OPENROUTER_API_KEY_5")
    openrouter_site_url: str = Field("http://localhost:3000", alias="OPENROUTER_SITE_URL")
    openrouter_app_name: str = Field("AppBI AI Chat", alias="OPENROUTER_APP_NAME")
    openai_api_key: str = Field("", alias="OPENAI_API_KEY")
    anthropic_api_key: str = Field("", alias="ANTHROPIC_API_KEY")
    gemini_api_key: str = Field("", alias="GEMINI_API_KEY")

    @property
    def active_api_keys(self) -> List[str]:
        """All configured OpenRouter keys in priority order (KEY_1..5 first, then bare KEY)."""
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

    # Session
    ai_session_ttl_minutes: int = Field(30, alias="AI_SESSION_TTL_MINUTES")
    ai_max_tool_calls: int = Field(8, alias="AI_MAX_TOOL_CALLS")
    ai_dataset_table_limit: int = Field(50, alias="AI_DATASET_TABLE_LIMIT")

    # Auth — must match backend SECRET_KEY
    secret_key: str = Field("dev-secret-key-change-in-production", alias="SECRET_KEY")

    # CORS
    cors_origins: str = Field("http://localhost:3000", alias="CORS_ORIGINS")

    # Environment — set to 'dev' to skip secret validation
    environment: str = Field("production", alias="ENVIRONMENT")

    # Server
    log_level: str = Field("INFO", alias="LOG_LEVEL")

    @property
    def active_provider(self) -> str:
        return "openrouter"

    @property
    def active_model(self) -> str:
        return self.ai_chat_model.strip() or self.llm_model

    @property
    def fallback_chain(self) -> List[dict]:
        """Parse fallback config into a list of {provider, model} dicts."""
        raw_chain = self.ai_chat_fallback_models.strip() or self.llm_fallback_chain.strip()
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
