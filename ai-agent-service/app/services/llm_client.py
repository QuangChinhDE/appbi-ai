from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from app.config import settings

logger = logging.getLogger(__name__)


def _make_openrouter_client():
    from openai import AsyncOpenAI

    return AsyncOpenAI(
        api_key=settings.openrouter_api_key,
        base_url="https://openrouter.ai/api/v1",
        default_headers={
            "HTTP-Referer": settings.openrouter_site_url,
            "X-Title": settings.openrouter_app_name,
        },
    )


def _build_provider_chain(model_override: Optional[str] = None) -> List[Dict[str, str]]:
    primary_model = (model_override or settings.active_llm_model).strip()
    chain = [{"provider": "openrouter", "model": primary_model}]
    for entry in settings.active_llm_fallback_chain:
        if entry not in chain:
            chain.append(entry)
    return chain


def _provider_available(provider: str) -> bool:
    return provider == "openrouter" and bool(settings.openrouter_api_key)


async def _call_openrouter_json(
    *,
    model: str,
    system_prompt: str,
    user_prompt: str,
    timeout_seconds: int,
) -> Optional[Dict[str, Any]]:
    client = _make_openrouter_client()

    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=1800,
            timeout=timeout_seconds,
        )
        content = response.choices[0].message.content or "{}"
        return json.loads(content)
    finally:
        await client.close()


async def generate_json(
    *,
    system_prompt: str,
    user_prompt: str,
    model_override: Optional[str] = None,
    timeout_seconds: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    effective_timeout = timeout_seconds or settings.active_llm_timeout_seconds
    for entry in _build_provider_chain(model_override):
        provider = entry["provider"]
        model = entry["model"]
        if not _provider_available(provider):
            continue
        try:
            return await _call_openrouter_json(
                model=model,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                timeout_seconds=effective_timeout,
            )
        except Exception:
            logger.exception("Agent planner LLM call failed for provider=%s model=%s", provider, model)
            continue
    return None
