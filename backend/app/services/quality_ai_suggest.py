"""
AI-powered quality rule suggestion service.

Takes a natural-language description of what the user wants to check,
plus the table schema, and returns a structured rule config.
"""
from __future__ import annotations

import ast
import json
import logging
import re
from typing import Any, Dict, List, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)

MAX_GEMINI_RETRIES = 3

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

QUALITY_RULE_RESPONSE_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": [
        "rule_type",
        "dimension",
        "column_name",
        "config",
        "severity",
        "name",
        "explanation",
    ],
    "properties": {
        "rule_type": {
            "type": "string",
            "enum": sorted(VALID_RULE_TYPES),
        },
        "dimension": {
            "type": "string",
            "enum": sorted(VALID_DIMENSIONS),
        },
        "column_name": {
            "type": "string",
        },
        "config": {
            "type": "object",
        },
        "severity": {
            "type": "string",
            "enum": ["info", "warning", "error"],
        },
        "name": {
            "type": "string",
        },
        "explanation": {
            "type": "string",
        },
    },
}

QUALITY_RULE_EXPRESSION_RESPONSE_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": [
        "rule_type",
        "dimension",
        "column_name",
        "config",
        "severity",
        "name",
        "explanation",
    ],
    "properties": {
        "rule_type": {
            "type": "string",
            "enum": ["cross_column"],
        },
        "dimension": {
            "type": "string",
            "enum": sorted(VALID_DIMENSIONS),
        },
        "column_name": {
            "type": "string",
        },
        "config": {
            "type": "object",
            "required": ["expression"],
            "properties": {
                "expression": {
                    "type": "string",
                },
            },
        },
        "severity": {
            "type": "string",
            "enum": ["info", "warning", "error"],
        },
        "name": {
            "type": "string",
        },
        "explanation": {
            "type": "string",
        },
    },
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

If the user provides a boolean SQL expression such as "amount IS NULL OR amount >= 0",
prefer rule_type "cross_column" with config {"expression": "..."} rather than custom_sql.

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

Hard output rules:
- Return exactly one object and nothing else.
- Use double-quoted JSON keys and string values.
- Use lowercase values for rule_type, dimension, and severity.
- config must always be an object.
- Never wrap the JSON in markdown fences.
"""


class GeminiQuotaFallbackError(RuntimeError):
    """Gemini exhausted quota/token budget and may fall back to OpenRouter."""


class GeminiOutputFormatError(RuntimeError):
    """Gemini returned content that could not be normalized into the required JSON."""


def _load_object_text(text: str) -> Optional[Dict[str, Any]]:
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    try:
        parsed = ast.literal_eval(text)
        if isinstance(parsed, dict):
            return parsed
    except (SyntaxError, ValueError):
        pass

    return None


def _extract_gemini_text(response: Any) -> str:
    direct_text = (getattr(response, "text", "") or "").strip()

    fragments: List[str] = []
    for candidate in getattr(response, "candidates", []) or []:
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", []) or []:
            part_text = getattr(part, "text", "") or ""
            if part_text.strip():
                fragments.append(part_text.strip())
    parts_text = "\n".join(fragments).strip()
    if parts_text and len(parts_text) > len(direct_text):
        return parts_text
    return direct_text or parts_text


def _log_text_preview(text: Optional[str], *, limit: int = 400) -> str:
    if not text:
        return "<empty>"
    compact = re.sub(r"\s+", " ", text).strip()
    if len(compact) <= limit:
        return compact
    return f"{compact[:limit]}..."


def _is_gemini_quota_error(exc: Exception) -> bool:
    status_code = getattr(exc, "status_code", None)
    if status_code == 429:
        return True

    text = f"{type(exc).__name__}: {exc}".lower()
    quota_markers = (
        "429",
        "quota",
        "resource exhausted",
        "resourceexhausted",
        "rate limit",
        "too many requests",
        "token limit",
        "tokens per",
        "maximum number of tokens",
    )
    return any(marker in text for marker in quota_markers)


def _looks_like_boolean_expression(text: str) -> bool:
    normalized = text.strip()
    if not normalized:
        return False
    has_comparison = re.search(r"(=|<>|!=|>=|<=|>|<|\bis\s+null\b|\bis\s+not\s+null\b)", normalized, re.IGNORECASE)
    has_boolean_join = re.search(r"\b(and|or)\b", normalized, re.IGNORECASE)
    return bool(has_comparison and (has_boolean_join or re.search(r"\bis\s+null\b|\bis\s+not\s+null\b", normalized, re.IGNORECASE)))


def _quality_response_schema_for_description(description: str) -> Dict[str, Any]:
    if _looks_like_boolean_expression(description):
        return QUALITY_RULE_EXPRESSION_RESPONSE_SCHEMA
    return QUALITY_RULE_RESPONSE_SCHEMA


def _build_gemini_attempt_prompt(
    user_prompt: str,
    *,
    attempt: int,
    previous_invalid_response: Optional[str] = None,
    validation_error: Optional[str] = None,
    expression_like: bool = False,
) -> str:
    prompt = (
        f"{user_prompt}\n\n"
        "Output contract:\n"
        "- Return exactly one valid JSON object.\n"
        "- Use only these keys: rule_type, dimension, column_name, config, severity, name, explanation.\n"
        "- Use lowercase enum values.\n"
        "- column_name must be null or one of the provided columns exactly as named.\n"
        "- config must be an object.\n"
        "- If the request is a row-level boolean condition, use rule_type \"cross_column\" and config {\"expression\": \"<sql boolean expression>\"}.\n"
        "- Return no markdown, no prose, and no surrounding text."
    )
    if expression_like:
        prompt += (
            "\n- This request already describes a row-level boolean condition. "
            "You must return rule_type \"cross_column\" and set config.expression to the SQL boolean expression."
        )
    if attempt > 1:
        prompt += (
            "\n\nThe previous reply was not usable. Regenerate the answer as strict JSON only."
        )
        if validation_error:
            prompt += f"\nValidation error to fix: {validation_error}."
        if previous_invalid_response:
            prompt += (
                "\nPrevious invalid reply to correct:\n"
                f"{previous_invalid_response[:1200]}"
            )
    return prompt


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
    parsed = _load_object_text(text)
    if parsed is not None:
        return parsed

    m2 = re.search(r"\{.*\}", text, re.DOTALL)
    if m2:
        return _load_object_text(m2.group(0))
    return None


async def _call_gemini(description: str, user_prompt: str) -> Optional[Dict[str, Any]]:
    """Call Gemini directly using google-generativeai SDK."""
    import google.generativeai as genai

    genai.configure(api_key=settings.GEMINI_API_KEY)
    model_name = settings.quality_gemini_model
    expression_like = _looks_like_boolean_expression(description)
    model = genai.GenerativeModel(
        model_name=model_name,
        system_instruction=SYSTEM_PROMPT,
        generation_config={
            "temperature": 0,
            "max_output_tokens": 800,
            "response_mime_type": "application/json",
            "response_schema": _quality_response_schema_for_description(description),
        },
    )

    last_error: Optional[Exception] = None
    last_invalid_response: Optional[str] = None
    last_validation_error: Optional[str] = None
    quota_failures = 0

    for attempt in range(1, MAX_GEMINI_RETRIES + 1):
        try:
            response = model.generate_content(
                _build_gemini_attempt_prompt(
                    user_prompt,
                    attempt=attempt,
                    previous_invalid_response=last_invalid_response,
                    validation_error=last_validation_error,
                    expression_like=expression_like,
                )
            )
            text = _extract_gemini_text(response)
            if not text:
                last_error = GeminiOutputFormatError("Gemini returned empty content")
                last_invalid_response = None
                last_validation_error = "empty response"
                logger.warning(
                    "Gemini AI suggest returned empty content on attempt %s/%s using model %s",
                    attempt,
                    MAX_GEMINI_RETRIES,
                    model_name,
                )
                continue

            parsed = _parse_json_response(text)
            if parsed is not None:
                sanitized = _sanitize_result(parsed)
                validation_error = _validate_sanitized_result(sanitized)
                if validation_error is None:
                    if attempt > 1:
                        logger.info(
                            "Gemini AI suggest succeeded on retry %s/%s using model %s",
                            attempt,
                            MAX_GEMINI_RETRIES,
                            model_name,
                        )
                    return parsed

                last_error = GeminiOutputFormatError(validation_error)
                last_invalid_response = json.dumps(parsed, ensure_ascii=True)
                last_validation_error = validation_error
                logger.warning(
                    "Gemini AI suggest returned incomplete structured content on attempt %s/%s using model %s: %s. Preview: %s",
                    attempt,
                    MAX_GEMINI_RETRIES,
                    model_name,
                    validation_error,
                    _log_text_preview(text),
                )
                continue

            last_error = GeminiOutputFormatError("Gemini returned non-JSON content")
            last_invalid_response = text
            last_validation_error = "response was not valid JSON"
            logger.warning(
                "Gemini AI suggest returned non-JSON content on attempt %s/%s using model %s. Preview: %s",
                attempt,
                MAX_GEMINI_RETRIES,
                model_name,
                _log_text_preview(text),
            )
        except Exception as exc:
            last_error = exc
            if _is_gemini_quota_error(exc):
                quota_failures += 1
                logger.warning(
                    "Gemini AI suggest hit quota/token limit on attempt %s/%s using model %s: %s",
                    attempt,
                    MAX_GEMINI_RETRIES,
                    model_name,
                    exc,
                )
                continue

            logger.warning(
                "Gemini AI suggest failed on attempt %s/%s using model %s: %s",
                attempt,
                MAX_GEMINI_RETRIES,
                model_name,
                exc,
            )

    if quota_failures == MAX_GEMINI_RETRIES:
        raise GeminiQuotaFallbackError(
            f"Gemini exhausted quota/token budget after {MAX_GEMINI_RETRIES} attempts"
        ) from last_error

    if last_error is not None:
        raise last_error
    return None


async def _call_openai(user_prompt: str) -> Optional[Dict[str, Any]]:
    """Call the OpenAI chat-completions API using httpx."""
    import httpx

    api_key = settings.OPENAI_API_KEY.strip()
    if not api_key:
        return None

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
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
            logger.warning("OpenAI AI suggest returned empty content")
            return None
        parsed = _parse_json_response(content)
        if parsed is not None:
            return parsed
        logger.warning("OpenAI AI suggest returned non-JSON content")
        return None


async def _call_gemini_json(user_prompt: str) -> Optional[Dict[str, Any]]:
    """Gemini fallback (direct API) — same JSON contract as _call_openai."""
    import httpx

    key = settings.GEMINI_API_KEY.strip()
    if not key:
        return None
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
            params={"key": key},
            json={
                "contents": [{"role": "user", "parts": [{"text": f"{SYSTEM_PROMPT}\n\n{user_prompt}"}]}],
                "generationConfig": {"temperature": 0.15, "maxOutputTokens": 800, "responseMimeType": "application/json"},
            },
        )
        resp.raise_for_status()
        data = resp.json()
        text = "".join(
            p.get("text", "")
            for p in (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
        )
        return _parse_json_response(text) if text else None


async def _call_anthropic_json(user_prompt: str) -> Optional[Dict[str, Any]]:
    """Claude fallback (direct API) — same JSON contract as _call_openai."""
    import httpx

    key = settings.ANTHROPIC_API_KEY.strip()
    if not key:
        return None
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
            json={
                "model": "claude-3-5-haiku-latest",
                "max_tokens": 800,
                "temperature": 0.15,
                "system": f"{SYSTEM_PROMPT}\n\nRespond with ONLY a valid JSON object, no prose.",
                "messages": [{"role": "user", "content": user_prompt}],
            },
        )
        resp.raise_for_status()
        data = resp.json()
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        return _parse_json_response(text) if text else None


def _sanitize_result(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure the AI output conforms to expected schema."""
    rule_type = str(raw.get("rule_type", "cross_column") or "cross_column").strip().lower()
    if rule_type == "custom_sql" and isinstance(raw.get("config"), dict) and raw.get("config", {}).get("sql_expression"):
        rule_type = "cross_column"
    rule_type_aliases = {
        "sql_expression": "cross_column",
        "boolean_expression": "cross_column",
        "expression": "cross_column",
    }
    rule_type = rule_type_aliases.get(rule_type, rule_type)
    if rule_type not in VALID_RULE_TYPES:
        rule_type = "cross_column"

    dimension = str(raw.get("dimension", "consistency") or "consistency").strip().lower()
    if dimension not in VALID_DIMENSIONS:
        dimension = "consistency"

    severity = str(raw.get("severity", "warning") or "warning").strip().lower()
    if severity not in {"info", "warning", "error"}:
        severity = "warning"

    raw_config = raw.get("config")
    config = raw_config if isinstance(raw_config, dict) else {}
    if rule_type == "cross_column":
        expression = config.get("expression") or config.get("sql_expression") or config.get("condition")
        config = {"expression": str(expression).strip()} if expression else {}
    elif rule_type == "accepted_values":
        values = config.get("values")
        config = {"values": values} if isinstance(values, list) else {}
    elif rule_type == "range_check":
        normalized_config: Dict[str, Any] = {}
        if config.get("min") is not None:
            normalized_config["min"] = config.get("min")
        if config.get("max") is not None:
            normalized_config["max"] = config.get("max")
        config = normalized_config

    return {
        "rule_type": rule_type,
        "dimension": dimension,
        "column_name": raw.get("column_name"),
        "config": config,
        "severity": severity,
        "name": str(raw.get("name", ""))[:255],
        "explanation": str(raw.get("explanation", ""))[:1000],
    }


def _validate_sanitized_result(result: Dict[str, Any]) -> Optional[str]:
    rule_type = result.get("rule_type")
    config = result.get("config") if isinstance(result.get("config"), dict) else {}

    if rule_type == "cross_column" and not str(config.get("expression") or "").strip():
        return "cross_column requires config.expression"
    if rule_type == "accepted_values":
        values = config.get("values")
        if not isinstance(values, list) or not values:
            return "accepted_values requires a non-empty config.values list"
    if rule_type == "pattern_match" and not str(config.get("pattern") or "").strip():
        return "pattern_match requires config.pattern"
    if rule_type == "format_check" and not str(config.get("format") or "").strip():
        return "format_check requires config.format"
    if rule_type == "range_check" and config.get("min") is None and config.get("max") is None:
        return "range_check requires config.min or config.max"
    if rule_type == "unique_combo":
        columns = config.get("columns")
        if not isinstance(columns, list) or not columns:
            return "unique_combo requires a non-empty config.columns list"
    if rule_type == "freshness_days" and config.get("max_days") is None:
        return "freshness_days requires config.max_days"
    if rule_type == "row_count_range" and config.get("min") is None and config.get("max") is None:
        return "row_count_range requires config.min or config.max"
    if rule_type == "statistical_range" and config.get("min_z") is None and config.get("max_z") is None:
        return "statistical_range requires config.min_z or config.max_z"
    if rule_type == "cross_table":
        if not str(config.get("join_condition") or "").strip() or not str(config.get("expression") or "").strip():
            return "cross_table requires config.join_condition and config.expression"
    if rule_type == "custom_sql" and not str(config.get("sql") or "").strip():
        return "custom_sql requires config.sql"
    return None


async def suggest_quality_rule(
    description: str,
    table_name: str,
    columns: List[Dict[str, str]],
) -> Dict[str, Any]:
    """Main entry point: generate a quality rule suggestion from natural language."""
    user_prompt = _build_user_prompt(description, table_name, columns)

    result = None
    provider_used: Optional[str] = None
    last_error: Optional[Exception] = None

    # Fallback chain: OpenAI → Gemini → Claude. Each is skipped if its key is
    # missing (returns None) and rolled over on any error/quota.
    for name, fn in (("openai", _call_openai), ("gemini", _call_gemini_json), ("anthropic", _call_anthropic_json)):
        try:
            r = await fn(user_prompt)
            if r is not None:
                result = r
                provider_used = name
                break
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            logger.warning("Quality AI suggest via %s failed: %s — trying next provider", name, exc)

    if result is None:
        from fastapi import HTTPException

        detail = "AI suggestion service is not available. Configure OPENAI_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY."
        if last_error is not None:
            detail = f"All AI providers failed; last error: {last_error}"
        raise HTTPException(status_code=503, detail=detail)

    logger.info("Quality AI suggest resolved via %s", provider_used or "unknown")
    return _sanitize_result(result)
