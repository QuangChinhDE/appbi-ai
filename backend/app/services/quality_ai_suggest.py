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


def _clean_identifier(value: str) -> str:
    text = value.strip()
    if text[:1] in {'"', "'", '`', '['} and text[-1:] in {'"', "'", '`', ']'}:
        text = text[1:-1].strip()
    return text


def _resolve_column_name(candidate: str, columns: List[Dict[str, str]]) -> str:
    cleaned = _clean_identifier(candidate)
    if not columns:
        return cleaned

    lowered = cleaned.lower()
    for column in columns:
        name = str(column.get("name") or "").strip()
        if name.lower() == lowered:
            return name
    return cleaned


def _parse_numeric_literal(value: str) -> int | float:
    number = float(value)
    return int(number) if number.is_integer() else number


def _build_heuristic_result(
    *,
    rule_type: str,
    dimension: str,
    column_name: Optional[str],
    config: Dict[str, Any],
    severity: str,
    name: str,
    explanation: str,
) -> Dict[str, Any]:
    return {
        "rule_type": rule_type,
        "dimension": dimension,
        "column_name": column_name,
        "config": config,
        "severity": severity,
        "name": name,
        "explanation": explanation,
    }


def _heuristic_rule_from_description(
    description: str,
    columns: List[Dict[str, str]],
) -> Optional[Dict[str, Any]]:
    """Handle compact expression-like prompts without needing an LLM roundtrip."""
    text = description.strip()
    if not text:
        return None

    not_null = re.fullmatch(
        r"(?i)([\[\]`\"'A-Za-z_][\w.\[\]`\"']*)\s+(?:is\s+)?not\s+null",
        text,
    )
    if not_null:
        column_name = _resolve_column_name(not_null.group(1), columns)
        return _build_heuristic_result(
            rule_type="not_null",
            dimension="completeness",
            column_name=column_name,
            config={},
            severity="error",
            name=f"{column_name} Not Null",
            explanation=f"Ensures that {column_name} always has a value and never contains NULL.",
        )

    nullable_min = re.fullmatch(
        r"(?i)([\[\]`\"'A-Za-z_][\w.\[\]`\"']*)\s+(?:is\s+)?null\s+or\s+([\[\]`\"'A-Za-z_][\w.\[\]`\"']*)\s*>=\s*(-?\d+(?:\.\d+)?)",
        text,
    )
    if nullable_min and _clean_identifier(nullable_min.group(1)).lower() == _clean_identifier(nullable_min.group(2)).lower():
        column_name = _resolve_column_name(nullable_min.group(1), columns)
        min_value = _parse_numeric_literal(nullable_min.group(3))
        return _build_heuristic_result(
            rule_type="range_check",
            dimension="validity",
            column_name=column_name,
            config={"min": min_value},
            severity="warning",
            name=f"{column_name} >= {min_value} (NULL allowed)",
            explanation=f"Allows NULL values, but requires every non-null value in {column_name} to be at least {min_value}.",
        )

    min_only = re.fullmatch(
        r"(?i)([\[\]`\"'A-Za-z_][\w.\[\]`\"']*)\s*>=\s*(-?\d+(?:\.\d+)?)",
        text,
    )
    if min_only:
        column_name = _resolve_column_name(min_only.group(1), columns)
        min_value = _parse_numeric_literal(min_only.group(2))
        return _build_heuristic_result(
            rule_type="range_check",
            dimension="validity",
            column_name=column_name,
            config={"min": min_value},
            severity="warning",
            name=f"{column_name} >= {min_value}",
            explanation=f"Requires every non-null value in {column_name} to be at least {min_value}.",
        )

    max_only = re.fullmatch(
        r"(?i)([\[\]`\"'A-Za-z_][\w.\[\]`\"']*)\s*<=\s*(-?\d+(?:\.\d+)?)",
        text,
    )
    if max_only:
        column_name = _resolve_column_name(max_only.group(1), columns)
        max_value = _parse_numeric_literal(max_only.group(2))
        return _build_heuristic_result(
            rule_type="range_check",
            dimension="validity",
            column_name=column_name,
            config={"max": max_value},
            severity="warning",
            name=f"{column_name} <= {max_value}",
            explanation=f"Requires every non-null value in {column_name} to be at most {max_value}.",
        )

    between = re.fullmatch(
        r"(?i)([\[\]`\"'A-Za-z_][\w.\[\]`\"']*)\s+between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)",
        text,
    )
    if between:
        column_name = _resolve_column_name(between.group(1), columns)
        min_value = _parse_numeric_literal(between.group(2))
        max_value = _parse_numeric_literal(between.group(3))
        return _build_heuristic_result(
            rule_type="range_check",
            dimension="validity",
            column_name=column_name,
            config={"min": min_value, "max": max_value},
            severity="warning",
            name=f"{column_name} between {min_value} and {max_value}",
            explanation=f"Requires every non-null value in {column_name} to stay between {min_value} and {max_value}.",
        )

    accepted_values = re.fullmatch(
        r"(?i)([\[\]`\"'A-Za-z_][\w.\[\]`\"']*)\s+in\s*\(([^)]*)\)",
        text,
    )
    if accepted_values:
        column_name = _resolve_column_name(accepted_values.group(1), columns)
        raw_values = [item.strip().strip("\"'") for item in accepted_values.group(2).split(",")]
        values = [item for item in raw_values if item]
        if values:
            return _build_heuristic_result(
                rule_type="accepted_values",
                dimension="validity",
                column_name=column_name,
                config={"values": values},
                severity="warning",
                name=f"{column_name} accepted values",
                explanation=f"Allows only the configured value list for non-null values in {column_name}.",
            )

    return None


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
    heuristic = _heuristic_rule_from_description(description, columns)
    if heuristic is not None:
        return heuristic

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
