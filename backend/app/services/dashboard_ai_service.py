"""
Dashboard AI Bot service — BYOK (Bring Your Own Key) LLM proxy.

Responsibilities:
  - Build a text context from a dashboard's chart data for the AI system prompt.
  - Stream LLM responses back to the caller (SSE-compatible async generator).

Design constraints:
  - User API keys are NEVER logged. They pass through in-memory only.
  - Chart data is capped at 50 rows per chart, 10 charts total.
  - All I/O with LLM providers uses httpx for async support.
"""
from __future__ import annotations

import json
import logging
from typing import AsyncGenerator

import httpx
from sqlalchemy.orm import Session

from app.models.models import Dashboard

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

MAX_CHARTS = 10
MAX_ROWS_PER_CHART = 50

PROVIDER_MODELS = {
    "anthropic": "claude-3-5-haiku-20241022",
    "openai": "gpt-4o-mini",
    "gemini": "gemini-1.5-flash",
}


# ── Context builder ──────────────────────────────────────────────────────────

def build_ai_context(db: Session, dash: Dashboard, public_filters: list[dict]) -> dict:
    """Execute up to MAX_CHARTS charts and return a structured context dict.

    Returns:
        {
          "dashboard_name": str,
          "dashboard_description": str | None,
          "charts": [{"id", "name", "chart_type", "columns", "rows", "description"}],
          "chart_count": int,
        }
    """
    from app.services.chart_service import ChartService

    dashboard_charts = [
        dc for dc in (dash.dashboard_charts or [])
        if dc.chart_id and dc.chart
    ][:MAX_CHARTS]

    combined_filters = [f for f in (public_filters or []) if isinstance(f, dict)]

    charts_context: list[dict] = []
    for dc in dashboard_charts:
        chart_id = dc.chart_id
        chart = dc.chart
        name = (dc.layout.get("custom_title") if isinstance(dc.layout, dict) else None) or getattr(chart, "name", "") or f"Chart {chart_id}"
        chart_type = str(getattr(chart, "chart_type", "") or "")

        try:
            result = ChartService.get_chart_data(
                db,
                chart_id,
                extra_filters=combined_filters or None,
                filter_context="dashboard",
            )
            data = result.get("data") or {}
            columns: list[str] = data.get("columns") or []
            rows: list[list] = (data.get("rows") or [])[:MAX_ROWS_PER_CHART]
        except Exception:
            columns = []
            rows = []

        charts_context.append({
            "id": chart_id,
            "name": name,
            "chart_type": chart_type,
            "columns": columns,
            "rows": rows,
            "description": getattr(chart, "description", None) or "",
        })

    return {
        "dashboard_name": dash.name or "Dashboard",
        "dashboard_description": getattr(dash, "description", None) or "",
        "charts": charts_context,
        "chart_count": len(charts_context),
    }


# ── System prompt builder ────────────────────────────────────────────────────

def build_system_prompt(context: dict) -> str:
    """Build the LLM system prompt from a context dict produced by build_ai_context."""
    dashboard_name = context.get("dashboard_name") or "Dashboard"
    description = context.get("dashboard_description") or ""
    charts: list[dict] = context.get("charts") or []

    lines = [
        f'You are an AI data analyst for the dashboard "{dashboard_name}".',
    ]
    if description:
        lines.append(f"Dashboard description: {description}")

    lines += [
        "",
        f"You have access to data from {len(charts)} chart(s) shown below.",
        "Answer questions by analysing ONLY the data provided here.",
        "Do not make up data. If asked about something not in the data, say so.",
        "Respond in the same language the user writes in.",
        "",
        "=== CHART DATA ===",
    ]

    for chart in charts:
        lines.append(f"\n--- Chart: {chart['name']} (type: {chart['chart_type']}) ---")
        if chart.get("description"):
            lines.append(f"Description: {chart['description']}")
        columns = chart.get("columns") or []
        rows = chart.get("rows") or []
        if not columns:
            lines.append("(no data)")
            continue
        lines.append(" | ".join(str(c) for c in columns))
        lines.append("-" * max(10, sum(len(str(c)) + 3 for c in columns)))
        for row in rows:
            lines.append(" | ".join(str(v) if v is not None else "" for v in row))
        if len(rows) == MAX_ROWS_PER_CHART:
            lines.append(f"(showing first {MAX_ROWS_PER_CHART} rows)")

    return "\n".join(lines)


# ── LLM streaming proxy ───────────────────────────────────────────────────────

async def stream_llm_byok(
    messages: list[dict],
    user_key: str,
    provider: str,
    system_prompt: str,
) -> AsyncGenerator[str, None]:
    """Stream LLM response chunks as plain text strings.

    Supports providers: "anthropic", "openai", "gemini".
    NEVER logs user_key.
    """
    provider = (provider or "").strip().lower()
    if provider == "anthropic":
        async for chunk in _stream_anthropic(messages, user_key, system_prompt):
            yield chunk
    elif provider == "openai":
        async for chunk in _stream_openai(messages, user_key, system_prompt):
            yield chunk
    elif provider == "gemini":
        async for chunk in _stream_gemini(messages, user_key, system_prompt):
            yield chunk
    else:
        yield f"[Error: Unknown provider '{provider}'. Use anthropic, openai, or gemini.]"


async def _stream_anthropic(
    messages: list[dict],
    api_key: str,
    system_prompt: str,
) -> AsyncGenerator[str, None]:
    model = PROVIDER_MODELS["anthropic"]
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": model,
        "max_tokens": 2048,
        "system": system_prompt,
        "messages": _normalize_messages(messages),
        "stream": True,
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    try:
                        detail = json.loads(body).get("error", {}).get("message", body.decode())
                    except Exception:
                        detail = body.decode(errors="replace")[:300]
                    yield f"[Anthropic error {resp.status_code}: {detail}]"
                    return
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        event = json.loads(raw)
                    except Exception:
                        continue
                    event_type = event.get("type")
                    if event_type == "content_block_delta":
                        delta = event.get("delta") or {}
                        text = delta.get("text") or ""
                        if text:
                            yield text
                    elif event_type == "message_delta":
                        # stop_reason etc — nothing to yield
                        pass
    except httpx.TimeoutException:
        yield "\n[Error: Request timed out. Try a shorter question.]"
    except Exception as exc:
        logger.error("Anthropic stream error: %s", type(exc).__name__)
        yield f"\n[Error communicating with Anthropic: {type(exc).__name__}]"


async def _stream_openai(
    messages: list[dict],
    api_key: str,
    system_prompt: str,
) -> AsyncGenerator[str, None]:
    model = PROVIDER_MODELS["openai"]
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    all_messages = [{"role": "system", "content": system_prompt}] + _normalize_messages(messages)
    payload = {
        "model": model,
        "messages": all_messages,
        "stream": True,
        "max_tokens": 2048,
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    try:
                        detail = json.loads(body).get("error", {}).get("message", body.decode())
                    except Exception:
                        detail = body.decode(errors="replace")[:300]
                    yield f"[OpenAI error {resp.status_code}: {detail}]"
                    return
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        event = json.loads(raw)
                    except Exception:
                        continue
                    delta = (event.get("choices") or [{}])[0].get("delta") or {}
                    text = delta.get("content") or ""
                    if text:
                        yield text
    except httpx.TimeoutException:
        yield "\n[Error: Request timed out. Try a shorter question.]"
    except Exception as exc:
        logger.error("OpenAI stream error: %s", type(exc).__name__)
        yield f"\n[Error communicating with OpenAI: {type(exc).__name__}]"


async def _stream_gemini(
    messages: list[dict],
    api_key: str,
    system_prompt: str,
) -> AsyncGenerator[str, None]:
    model = PROVIDER_MODELS["gemini"]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent"
    headers = {"Content-Type": "application/json"}
    params = {"key": api_key, "alt": "sse"}

    normalized = _normalize_messages(messages)
    contents = []
    for msg in normalized:
        role = "user" if msg["role"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": msg["content"]}]})

    payload: dict = {
        "contents": contents,
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {"maxOutputTokens": 2048},
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", url, headers=headers, params=params, json=payload) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    try:
                        detail = json.loads(body).get("error", {}).get("message", body.decode())
                    except Exception:
                        detail = body.decode(errors="replace")[:300]
                    yield f"[Gemini error {resp.status_code}: {detail}]"
                    return
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        event = json.loads(raw)
                    except Exception:
                        continue
                    candidates = event.get("candidates") or []
                    for candidate in candidates:
                        parts = (candidate.get("content") or {}).get("parts") or []
                        for part in parts:
                            text = part.get("text") or ""
                            if text:
                                yield text
    except httpx.TimeoutException:
        yield "\n[Error: Request timed out. Try a shorter question.]"
    except Exception as exc:
        logger.error("Gemini stream error: %s", type(exc).__name__)
        yield f"\n[Error communicating with Gemini: {type(exc).__name__}]"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _normalize_messages(messages: list[dict]) -> list[dict]:
    """Keep only role/content fields and ensure alternating user/assistant."""
    result: list[dict] = []
    for msg in messages or []:
        role = str(msg.get("role") or "").strip().lower()
        content = str(msg.get("content") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        result.append({"role": role, "content": content})
    return result
