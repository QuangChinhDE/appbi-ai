"""
AI Service configuration.
All settings driven by environment variables — no hard-coded LLM provider.
"""
from pydantic_settings import BaseSettings
from pydantic import Field
from typing import List


class Settings(BaseSettings):
    # BI backend
    bi_api_url: str = Field("http://localhost:8000/api/v1", alias="BI_API_URL")

    # Primary LLM
    llm_provider: str = Field("openai", alias="LLM_PROVIDER")   # openai | anthropic
    llm_model: str = Field("gpt-4o-mini", alias="LLM_MODEL")

    # Fallback chain — comma-separated "provider:model" pairs
    # e.g. "openai:gpt-4o-mini,anthropic:claude-3-5-haiku-20241022"
    llm_fallback_chain: str = Field("", alias="LLM_FALLBACK_CHAIN")

    # API keys
    openai_api_key: str = Field("", alias="OPENAI_API_KEY")
    anthropic_api_key: str = Field("", alias="ANTHROPIC_API_KEY")

    # Session
    ai_session_ttl_minutes: int = Field(30, alias="AI_SESSION_TTL_MINUTES")
    ai_max_tool_calls: int = Field(8, alias="AI_MAX_TOOL_CALLS")
    ai_workspace_table_limit: int = Field(50, alias="AI_WORKSPACE_TABLE_LIMIT")

    # Server
    log_level: str = Field("INFO", alias="LOG_LEVEL")

    @property
    def fallback_chain(self) -> List[dict]:
        """Parse LLM_FALLBACK_CHAIN into a list of {provider, model} dicts."""
        if not self.llm_fallback_chain.strip():
            return []
        result = []
        for entry in self.llm_fallback_chain.split(","):
            entry = entry.strip()
            if ":" in entry:
                provider, model = entry.split(":", 1)
                result.append({"provider": provider.strip(), "model": model.strip()})
        return result

    class Config:
        env_file = ".env"
        populate_by_name = True


settings = Settings()
