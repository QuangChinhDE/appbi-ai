"""
Intent Classifier — Phase 1 router.

Classifies user messages into one of 5 intents, then returns an AgentConfig
with the appropriate system prompt, max_tokens, and tool_call_limit.

Uses a hybrid approach:
  1. Keyword pre-filter for clear-cut cases (no LLM cost, instant)
  2. LLM fallback for ambiguous messages (cheap model, ~200 tokens)
"""
import logging
import re
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


class IntentType(str, Enum):
    LOOKUP  = "LOOKUP"   # Specific numbers, rankings, top-N, counts
    EXPLORE = "EXPLORE"  # Schema discovery, overviews, "what data do I have?"
    INSIGHT = "INSIGHT"  # Why/explain/root cause, trend analysis, narrative
    CREATE  = "CREATE"   # Build chart or dashboard
    VAGUE   = "VAGUE"    # Too vague — needs clarification before acting


@dataclass
class AgentConfig:
    intent: IntentType
    max_tokens: int
    tool_call_limit: int
    system_prompt: str
    force_first_tool: bool
    temperature: float = 0.2        # Per-intent: INSIGHT=0.5, LOOKUP=0.1, others=0.2
    max_history: int = 20           # Per-intent: INSIGHT=50 to survive long tool chains
    # Restricted tool set for this intent (None = use all tools)
    tool_names: Optional[List[str]] = None
    # Only set when intent == VAGUE
    clarification_question: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# Config presets per intent
# ─────────────────────────────────────────────────────────────────────────────

def _make_config(intent: IntentType, clarification: Optional[str] = None) -> AgentConfig:
    from app.prompts import PROMPT_LOOKUP, PROMPT_EXPLORE, PROMPT_INSIGHT, PROMPT_VIZ, BASE_SYSTEM_PROMPT
    from app.agents.tools import TOOLS_LOOKUP, TOOLS_EXPLORE, TOOLS_INSIGHT, TOOLS_VIZ

    presets: Dict[IntentType, dict] = {
        IntentType.LOOKUP: {
            "max_tokens": 512,
            "tool_call_limit": 6,
            "system_prompt": PROMPT_LOOKUP,
            "force_first_tool": True,
            "temperature": 0.1,   # factual, deterministic
            "max_history": 20,
            "tool_names": list(TOOLS_LOOKUP),
        },
        IntentType.EXPLORE: {
            "max_tokens": 1024,
            "tool_call_limit": 5,
            "system_prompt": PROMPT_EXPLORE,
            "force_first_tool": True,
            "temperature": 0.2,
            "max_history": 20,
            "tool_names": list(TOOLS_EXPLORE),
        },
        IntentType.INSIGHT: {
            "max_tokens": 2500,   # execution phase; planning adds ~600 extra
            "tool_call_limit": 12,
            "system_prompt": PROMPT_INSIGHT,
            "force_first_tool": False,  # planning phase first, then tool loop
            "temperature": 0.5,   # narrative synthesis needs creativity
            "max_history": 50,    # survive 12 tool calls + prior turns
            "tool_names": list(TOOLS_INSIGHT),
        },
        IntentType.CREATE: {
            "max_tokens": 1024,
            "tool_call_limit": 8,
            "system_prompt": PROMPT_VIZ,
            "force_first_tool": True,
            "temperature": 0.2,
            "max_history": 20,
            "tool_names": list(TOOLS_VIZ),
        },
        IntentType.VAGUE: {
            "max_tokens": 256,
            "tool_call_limit": 0,
            "system_prompt": BASE_SYSTEM_PROMPT,
            "force_first_tool": False,
            "temperature": 0.0,   # deterministic clarification
            "max_history": 10,
            "tool_names": None,
        },
    }

    p = presets[intent]
    return AgentConfig(
        intent=intent,
        max_tokens=p["max_tokens"],
        tool_call_limit=p["tool_call_limit"],
        system_prompt=p["system_prompt"],
        force_first_tool=p["force_first_tool"],
        temperature=p["temperature"],
        max_history=p["max_history"],
        tool_names=p["tool_names"],
        clarification_question=clarification,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Keyword pre-filter (fast path, no LLM cost)
# ─────────────────────────────────────────────────────────────────────────────

_VAGUE_PATTERNS = [
    r"^(phân tích|analyze|phân tích đi|xem đi|show me|xem data|look at|thông tin|info)\.?$",
    r"^(xem|show|look|check)\.?$",
    r"^(phân tích|analyze)\s+(thôi|đi|nào|nhé)\.?$",
]

_INSIGHT_KEYWORDS = [
    "tại sao", "vì sao", "lý do", "nguyên nhân", "giải thích", "explain",
    "why", "how come", "what caused", "root cause", "xu hướng", "trend",
    "so sánh", "compare", "so với", "biến động", "thay đổi đột ngột",
    "tăng mạnh", "giảm mạnh", "drop", "spike", "anomaly", "bất thường",
    "phân tích sâu", "deep dive", "insight",
]

_EXPLORE_KEYWORDS = [
    "có gì", "có những gì", "gồm gì", "bao gồm gì", "cấu trúc",
    "dữ liệu gì", "what data", "what columns", "what tables", "what is in",
    "describe", "mô tả", "tổng quan", "overview", "schema", "cột nào",
    "what fields", "tell me about", "cho tôi biết về", "thông tin về dataset",
    "datasets nào", "bảng nào có",
]

_CREATE_KEYWORDS = [
    "tạo", "create", "build", "vẽ", "draw", "make", "generate",
    "biểu đồ", "chart", "dashboard", "báo cáo mới", "new report",
    "thêm chart", "add chart", "thiết kế", "visualize",
]

_LOOKUP_KEYWORDS = [
    "top", "bao nhiêu", "how many", "count", "tổng", "sum", "trung bình",
    "average", "max", "min", "cao nhất", "thấp nhất", "nhiều nhất", "ít nhất",
    "xếp hạng", "ranking", "danh sách", "list", "tỷ lệ", "percentage", "%",
    "số lượng", "doanh thu", "revenue", "profit", "lợi nhuận",
]


def _keyword_classify(message: str) -> Optional[IntentType]:
    """Fast keyword-based classification. Returns None if ambiguous."""
    msg = message.strip().lower()

    # Check strong signal keywords FIRST — before any vague checks
    for kw in _INSIGHT_KEYWORDS:
        if kw in msg:
            return IntentType.INSIGHT

    for kw in _CREATE_KEYWORDS:
        if kw in msg:
            return IntentType.CREATE

    for kw in _EXPLORE_KEYWORDS:
        if kw in msg:
            return IntentType.EXPLORE

    for kw in _LOOKUP_KEYWORDS:
        if kw in msg:
            return IntentType.LOOKUP

    # No strong keyword signal — check vague patterns
    for pattern in _VAGUE_PATTERNS:
        if re.match(pattern, msg):
            return IntentType.VAGUE

    # Very short messages (≤ 2 words) with no keyword signal → vague
    word_count = len(msg.split())
    if word_count <= 2:
        return IntentType.VAGUE

    return None  # Ambiguous — fall through to LLM


# ─────────────────────────────────────────────────────────────────────────────
# LLM fallback classifier
# ─────────────────────────────────────────────────────────────────────────────

_CLASSIFY_SYSTEM = """You classify BI data questions into exactly one category.

LOOKUP   - Specific numbers, rankings, top-N, counts, filtering, date range values
           Examples: "top 5 projects with delays", "revenue in March", "count tasks by team"
EXPLORE  - Understanding data structure, schema, overview, "what data is there?"
           Examples: "what data do I have?", "describe this dataset", "what columns?"
INSIGHT  - Why/how/explain questions, root cause, trends, patterns, narrative analysis
           Examples: "why did revenue drop?", "explain Q3 performance", "what's causing delays?"
CREATE   - Explicitly building a new chart or dashboard
           Examples: "create a revenue chart", "build a dashboard", "make a bar chart"
VAGUE    - Too vague to act on; needs clarification about topic or intent
           Examples: "analyze this", "show me data", "phân tích đi", "xem thử"

Respond with ONLY the category name on the first line.
If VAGUE, add a clarification question in Vietnamese on the second line (under 20 words)."""

_CLASSIFY_USER_TMPL = "User message: {message}"


async def _llm_classify(
    message: str,
    provider: str,
    model: str,
) -> tuple[IntentType, Optional[str]]:
    """Call a cheap LLM to classify. Returns (intent, clarification_or_None)."""
    from app.config import settings

    prompt = _CLASSIFY_USER_TMPL.format(message=message[:500])

    try:
        if provider in ("openai", "openrouter"):
            from openai import AsyncOpenAI
            if provider == "openai":
                client = AsyncOpenAI(api_key=settings.openai_api_key)
            else:
                keys = settings.active_api_keys
                client = AsyncOpenAI(
                    api_key=keys[0] if keys else "",
                    base_url="https://openrouter.ai/api/v1",
                    default_headers={
                        "HTTP-Referer": settings.openrouter_site_url,
                        "X-Title": settings.openrouter_app_name,
                    },
                )
            resp = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": _CLASSIFY_SYSTEM},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.0,
                max_tokens=60,
                stream=False,
            )
            raw = (resp.choices[0].message.content or "").strip()

        elif provider == "anthropic":
            from anthropic import AsyncAnthropic
            client = AsyncAnthropic(api_key=settings.anthropic_api_key)
            resp = await client.messages.create(
                model=model,
                system=_CLASSIFY_SYSTEM,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=60,
            )
            raw = (resp.content[0].text if resp.content else "").strip()

        elif provider == "gemini":
            import google.genai as genai
            import google.genai.types as gtypes
            from app.config import settings as _s
            _clf_client = genai.Client(api_key=_s.gemini_api_key)
            _clf_model_name = model or _s.gemini_fast_model
            _resp = await _clf_client.aio.models.generate_content(
                model=_clf_model_name,
                contents=prompt,
                config=gtypes.GenerateContentConfig(
                    system_instruction=_CLASSIFY_SYSTEM,
                    temperature=0.0,
                    max_output_tokens=60,
                ),
            )
            raw = (_resp.text or "").strip()

        else:
            # Unknown provider — safe default
            return IntentType.LOOKUP, None

    except Exception as exc:
        logger.warning("intent_classifier: LLM call failed (%s) — defaulting to LOOKUP", exc)
        return IntentType.LOOKUP, None

    # Parse response: first line = intent, second line (optional) = clarification
    lines = [l.strip() for l in raw.splitlines() if l.strip()]
    intent_str = lines[0].upper() if lines else "LOOKUP"
    clarification = lines[1] if len(lines) > 1 else None

    try:
        intent = IntentType(intent_str)
    except ValueError:
        logger.warning("intent_classifier: unrecognised intent '%s' — defaulting to LOOKUP", intent_str)
        intent = IntentType.LOOKUP

    return intent, clarification


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

_VAGUE_FALLBACK_QUESTION = (
    "Bạn muốn phân tích khía cạnh nào của dữ liệu? "
    "Ví dụ: tra cứu số liệu cụ thể, khám phá dữ liệu, tìm hiểu nguyên nhân, hay tạo biểu đồ?"
)


async def classify_intent(
    user_message: str,
    provider: str,
    model: str,
) -> AgentConfig:
    """
    Classify user message and return an AgentConfig with the right
    system prompt, token budget, and tool call limit.

    Flow:
      1. Keyword pre-filter (instant, no cost)
      2. LLM fallback for ambiguous messages
      3. Return AgentConfig with defaults for LOOKUP if all else fails
    """
    # Step 1: keyword fast path
    intent = _keyword_classify(user_message)

    if intent is not None:
        logger.debug("intent_classifier: keyword → %s", intent)
        if intent == IntentType.VAGUE:
            return _make_config(IntentType.VAGUE, clarification=_VAGUE_FALLBACK_QUESTION)
        return _make_config(intent)

    # Step 2: LLM fallback for ambiguous messages
    logger.debug("intent_classifier: ambiguous, calling LLM")
    intent, clarification = await _llm_classify(user_message, provider, model)

    if intent == IntentType.VAGUE:
        return _make_config(
            IntentType.VAGUE,
            clarification=clarification or _VAGUE_FALLBACK_QUESTION,
        )

    return _make_config(intent)
