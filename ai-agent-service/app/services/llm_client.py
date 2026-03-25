from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from app.config import settings

logger = logging.getLogger(__name__)


def _make_openai_client(base_url: str | None = None, api_key: str | None = None):
    from openai import AsyncOpenAI

    kwargs: Dict[str, Any] = {"api_key": api_key or settings.openai_api_key}
    if base_url:
        kwargs["base_url"] = base_url
    return AsyncOpenAI(**kwargs)


def _build_provider_chain() -> List[Dict[str, str]]:
    chain = [{"provider": settings.llm_provider, "model": settings.llm_model}]
    for entry in settings.fallback_chain:
        if entry not in chain:
            chain.append(entry)
    return chain


def _provider_available(provider: str) -> bool:
    if provider == "openai":
        return bool(settings.openai_api_key)
    if provider == "openrouter":
        return bool(settings.openrouter_api_key)
    if provider == "gemini":
        return bool(settings.gemini_api_key)
    if provider == "anthropic":
        return bool(settings.anthropic_api_key)
    return False


async def _call_openai_json(
    *,
    provider: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
) -> Optional[Dict[str, Any]]:
    if provider == "openrouter":
        client = _make_openai_client(
            base_url="https://openrouter.ai/api/v1",
            api_key=settings.openrouter_api_key,
        )
    else:
        client = _make_openai_client(api_key=settings.openai_api_key)

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
            timeout=settings.llm_timeout_seconds,
        )
        content = response.choices[0].message.content or "{}"
        return json.loads(content)
    finally:
        await client.close()


async def _call_anthropic_json(
    *,
    model: str,
    system_prompt: str,
    user_prompt: str,
) -> Optional[Dict[str, Any]]:
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    try:
        response = await client.messages.create(
            model=model,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
            max_tokens=1800,
        )
        text_blocks = [block.text for block in response.content if getattr(block, "type", "") == "text"]
        content = "".join(text_blocks).strip()
        start = content.find("{")
        end = content.rfind("}")
        if start >= 0 and end > start:
            content = content[start : end + 1]
        return json.loads(content)
    finally:
        await client.close()


async def _call_gemini_json(
    *,
    model: str,
    system_prompt: str,
    user_prompt: str,
) -> Optional[Dict[str, Any]]:
    import asyncio
    import google.generativeai as genai

    genai.configure(api_key=settings.gemini_api_key)
    prompt = f"{system_prompt}\n\n{user_prompt}"
    generator = genai.GenerativeModel(model, generation_config={"temperature": 0.2, "max_output_tokens": 1800})
    response = await asyncio.get_event_loop().run_in_executor(None, lambda: generator.generate_content(prompt))
    content = getattr(response, "text", "") or ""
    start = content.find("{")
    end = content.rfind("}")
    if start >= 0 and end > start:
        content = content[start : end + 1]
    return json.loads(content)


async def generate_json(
    *,
    system_prompt: str,
    user_prompt: str,
) -> Optional[Dict[str, Any]]:
    for entry in _build_provider_chain():
        provider = entry["provider"]
        model = entry["model"]
        if not _provider_available(provider):
            continue
        try:
            if provider in {"openai", "openrouter"}:
                return await _call_openai_json(
                    provider=provider,
                    model=model,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                )
            if provider == "anthropic":
                return await _call_anthropic_json(
                    model=model,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                )
            if provider == "gemini":
                return await _call_gemini_json(
                    model=model,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                )
        except Exception:
            logger.exception("Agent planner LLM call failed for provider=%s model=%s", provider, model)
            continue
    return None
