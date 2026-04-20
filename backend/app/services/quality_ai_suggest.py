"""
AI-powered quality rule suggestion service.

Takes a natural-language description of what the user wants to check,
plus the table schema, and returns a structured rule config.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)

VALID_RULE_TYPES = {
    "not_null", "not_blank", "completeness_pct",
    "accepted_values", "pattern_match", "range_check", "format_check",
    "unique_column", "unique_combo",
    "cross_column", "cross_table",
    "freshness_days",
    "row_count_range", "statistical_range", "custom_sql",
}

VALID_DIMENSIONS = {
    "completeness", "validity", "uniqueness",
    "consistency", "timeliness", "accuracy",
}

SYSTEM_PROMPT = """You are a data-quality expert assistant for the AppBI platform.

Given a natural-language description of what the user wants to validate in their data,
suggest the best quality rule configuration.

Available rule types:
- not_null: Column must not contain NULL values. Config: none.
- not_blank: Column must not be empty string after trim. Config: none.
- completeness_pct: Column non-null % must be ≥ threshold. Config: {"threshold": <number 0-100>}.
- accepted_values: Column values must be in an allowed list. Config: {"values": ["val1","val2",...]}.
- pattern_match: Column values must match a regex. Config: {"pattern": "<regex>", "flags": "<optional>"}.
- range_check: Column numeric values must be within [min, max]. Config: {"min": <number>, "max": <number>}. Either can be omitted.
- format_check: Column must match a built-in format. Config: {"format": "email"|"url"|"date"|"datetime"|"phone"}.
- unique_column: Column must have no duplicate values. Config: none.
- unique_combo: Combination of columns must be unique (table grain). Config: {"columns": ["col1","col2",...]}.
- cross_column: A SQL boolean expression that must be TRUE for every row. Config: {"expression": "<sql>"}.
- cross_table: Join two tables and evaluate a SQL expression. Config: {"secondary_table_id": <int>, "join_condition": "<sql>", "expression": "<sql>"}.
- freshness_days: Date column must be within N days of now. Config: {"column": "<col>", "max_days": <int>}.
- row_count_range: Total row count must be within [min, max]. Config: {"min": <int>, "max": <int>}.
- statistical_range: Column values must be within z-score bounds. Config: {"min_z": <float>, "max_z": <float>}.
- custom_sql: Arbitrary SQL returning rows_checked and rows_failed. Config: {"sql": "<sql with {{ table }} placeholder>"}.

Available dimensions: completeness, validity, uniqueness, consistency, timeliness, accuracy.

Respond ONLY with a JSON object (no markdown, no explanation outside JSON):
{
  "rule_type": "<one of the rule types above>",
  "dimension": "<best matching dimension>",
  "column_name": "<column name if rule is column-level, null if table-level>",
  "config": {<rule-specific config>},
  "severity": "info" | "warning" | "error",
  "name": "<short business-readable rule name>",
  "explanation": "<1-2 sentence explanation of what this rule does and why>"
}
"""


def _build_user_prompt(
    description: str,
    table_name: str,
    columns: List[Dict[str, str]],
) -> str:
    col_list = "\n".join(
        f"  - {c['name']}" + (f" ({c['type']})" if c.get("type") else "")
        for c in columns
    )
    return f"""Table: {table_name}
Columns:
{col_list}

User request: {description}"""


def _parse_json_response(text: str) -> Optional[Dict[str, Any]]:
    """Extract JSON from LLM response, tolerating markdown fences."""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m2 = re.search(r"\{.*\}", text, re.DOTALL)
        if m2:
            try:
                return json.loads(m2.group(0))
            except json.JSONDecodeError:
                pass
    return None


async def _call_gemini(user_prompt: str) -> Optional[Dict[str, Any]]:
    """Call Gemini directly using google-generativeai SDK."""
    import google.generativeai as genai

    genai.configure(api_key=settings.GEMINI_API_KEY)
    model = genai.GenerativeModel(
        model_name=settings.active_quality_model,
        system_instruction=SYSTEM_PROMPT,
        generation_config={
            "temperature": 0.15,
            "max_output_tokens": 800,
            "response_mime_type": "application/json",
        },
    )
    response = model.generate_content(user_prompt)
    text = getattr(response, "text", "") or ""
    if not text:
        return None
    return _parse_json_response(text)


async def _call_openrouter(user_prompt: str) -> Optional[Dict[str, Any]]:
    """Call OpenRouter API using httpx."""
    import httpx

    keys = settings.active_api_keys
    if not keys:
        return None

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {keys[0]}",
                "HTTP-Referer": settings.OPENROUTER_SITE_URL,
                "X-Title": settings.OPENROUTER_APP_NAME,
            },
            json={
                "model": settings.active_quality_model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.15,
                "max_tokens": 800,
                "response_format": {"type": "json_object"},
            },
        )
        resp.raise_for_status()
        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        if not content:
            return None
        return _parse_json_response(content)


def _sanitize_result(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure the AI output conforms to expected schema."""
    rule_type = raw.get("rule_type", "cross_column")
    if rule_type not in VALID_RULE_TYPES:
        rule_type = "cross_column"

    dimension = raw.get("dimension", "consistency")
    if dimension not in VALID_DIMENSIONS:
        dimension = "consistency"

    severity = raw.get("severity", "warning")
    if severity not in {"info", "warning", "error"}:
        severity = "warning"

    return {
        "rule_type": rule_type,
        "dimension": dimension,
        "column_name": raw.get("column_name"),
        "config": raw.get("config") or {},
        "severity": severity,
        "name": str(raw.get("name", ""))[:255],
        "explanation": str(raw.get("explanation", ""))[:1000],
    }


async def suggest_quality_rule(
    description: str,
    table_name: str,
    columns: List[Dict[str, str]],
) -> Dict[str, Any]:
    """Main entry point: generate a quality rule suggestion from natural language."""
    user_prompt = _build_user_prompt(description, table_name, columns)

    result = None

    # Try Gemini first (faster, cheaper)
    if settings.GEMINI_API_KEY.strip():
        try:
            result = await _call_gemini(user_prompt)
        except Exception as exc:
            logger.warning("Gemini AI suggest failed: %s", exc)

    # Fallback to OpenRouter
    if result is None and settings.active_api_keys:
        try:
            result = await _call_openrouter(user_prompt)
        except Exception as exc:
            logger.warning("OpenRouter AI suggest failed: %s", exc)

    if result is None:
        from fastapi import HTTPException
        raise HTTPException(
            status_code=503,
            detail="AI suggestion service is not available. Configure GEMINI_API_KEY or OPENROUTER_API_KEY.",
        )

    return _sanitize_result(result)
