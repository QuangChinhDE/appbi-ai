from __future__ import annotations

from app.config import settings
from app.schemas.agent import AgentRuntimeMetadata


def llm_runtime_metadata(phase: str) -> AgentRuntimeMetadata:
    return AgentRuntimeMetadata(
        provider=settings.active_llm_provider,
        model=settings.model_for_phase(phase),
        fallback_chain=settings.active_llm_fallback_chain,
        timeout_seconds=settings.active_llm_timeout_seconds,
    )


def rule_runtime_metadata() -> AgentRuntimeMetadata:
    return AgentRuntimeMetadata(
        provider="rule-based",
        model="deterministic",
        fallback_chain=[],
        timeout_seconds=0,
    )
