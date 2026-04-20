"""
LLM Orchestrator — drives the tool-calling conversation loop.

Supports OpenAI and Anthropic through a unified interface.
Falls back through LLM_FALLBACK_CHAIN when a provider/model fails.
Streams events via an async generator.
"""
import asyncio
import json
import logging
import time
import uuid
from typing import Any, AsyncGenerator, Dict, List, Optional

from app.config import settings
from app.schemas.chat import (
    ChartEvent,
    ConversationSession,
    DoneEvent,
    ErrorEvent,
    Message,
    MetricsEvent,
    SuggestionsEvent,
    TextEvent,
    ThinkingEvent,
    ToolCallEvent,
    ToolResultEvent,
)
from app.agents.tools import TOOL_SCHEMAS, execute_tool

logger = logging.getLogger(__name__)

# BASE_SYSTEM_PROMPT is loaded from prompts/base.py.
# Intent-specific variants (LOOKUP, EXPLORE, INSIGHT, CREATE) extend it.
# Use _get_base_prompt() to access it at runtime to avoid circular imports.
def _get_base_prompt() -> str:
    from app.prompts import BASE_SYSTEM_PROMPT
    return BASE_SYSTEM_PROMPT


async def _execute_tool_rbac(
    fn_name: str,
    fn_args: dict,
    user_role: str,
    token: str = "",
    scope: Optional[Dict[str, Any]] = None,
) -> dict:
    """Wrap execute_tool with role-based access control.

    Data access is enforced at the backend level (dataset permission checks).
    Viewers can only query tables shared with them — the backend returns 403 otherwise.
    """
    return await execute_tool(fn_name, fn_args, token=token, scope=scope)


def _make_openai_client():
    try:
        from openai import AsyncOpenAI
        return AsyncOpenAI(api_key=settings.openai_api_key)
    except ImportError:
        raise RuntimeError("openai package not installed")


def _make_openrouter_client(api_key: str = ""):
    try:
        from openai import AsyncOpenAI
        key = api_key or settings.openrouter_api_key
        return AsyncOpenAI(
            api_key=key,
            base_url="https://openrouter.ai/api/v1",
            default_headers={
                "HTTP-Referer": settings.openrouter_site_url,
                "X-Title": settings.openrouter_app_name,
            },
        )
    except ImportError:
        raise RuntimeError("openai package not installed")


def _is_key_exhausted(exc: Exception) -> bool:
    """Return True when the error signals quota/auth failure for this key."""
    status = getattr(exc, "status_code", None) or getattr(getattr(exc, "response", None), "status_code", None)
    if status in {401, 402, 403, 429}:
        return True
    msg = str(exc).lower()
    return any(kw in msg for kw in ("401", "402", "403", "429", "rate limit", "quota", "insufficient credits", "invalid api key", "unauthorized"))


def _make_anthropic_client():
    try:
        from anthropic import AsyncAnthropic
        return AsyncAnthropic(api_key=settings.anthropic_api_key)
    except ImportError:
        raise RuntimeError("anthropic package not installed")


def _make_gemini_client():
    """Return a google-genai async Client configured with GEMINI_API_KEY."""
    try:
        import google.genai as genai
    except ImportError:
        raise RuntimeError("google-genai package not installed. Run: pip install google-genai")
    return genai.Client(api_key=settings.gemini_api_key)


def _make_gemini_config(model_name: str, agent_config=None, system_prompt_override: str = ""):
    """Build (model_name, GenerateContentConfig) for google-genai new SDK.

    Returns a tuple (model_name, config) used with:
        client.aio.models.generate_content(model=model_name, contents=..., config=config)
    """
    try:
        import google.genai.types as gtypes
    except ImportError:
        raise RuntimeError("google-genai package not installed. Run: pip install google-genai")

    def _strip_unsupported(schema):
        """Recursively remove fields the Gemini SDK does not accept (default, etc.)."""
        if isinstance(schema, dict):
            return {k: _strip_unsupported(v) for k, v in schema.items() if k not in ("default",)}
        if isinstance(schema, list):
            return [_strip_unsupported(item) for item in schema]
        return schema

    from app.agents.tools import get_tool_schemas
    tool_names = agent_config.tool_names if agent_config else None
    active_tool_schemas = get_tool_schemas(tool_names)

    declarations = []
    for t in active_tool_schemas:
        fn = t["function"]
        params_raw = _strip_unsupported(fn["parameters"])
        # Build Schema object from dict
        prop_schemas = {
            k: gtypes.Schema(**{
                "type": v.get("type", "STRING").upper(),
                **({"description": v["description"]} if "description" in v else {}),
                **({"enum": v["enum"]} if "enum" in v else {}),
                **({"items": gtypes.Schema(type=v["items"].get("type","STRING").upper())} if "items" in v and isinstance(v["items"], dict) else {}),
            })
            for k, v in params_raw.get("properties", {}).items()
            if isinstance(v, dict) and "type" in v
        }
        declarations.append(gtypes.FunctionDeclaration(
            name=fn["name"],
            description=fn["description"],
            parameters=gtypes.Schema(
                type="OBJECT",
                properties=prop_schemas,
                required=params_raw.get("required", []),
            ),
        ))

    gemini_tool = gtypes.Tool(function_declarations=declarations) if declarations else None

    temperature = agent_config.temperature if agent_config else 0.2
    max_output_tokens = agent_config.max_tokens if agent_config else 1024
    system_prompt = system_prompt_override or (agent_config.system_prompt if agent_config else _get_base_prompt())

    base_kwargs: Dict[str, Any] = {
        "temperature": temperature,
        "max_output_tokens": max_output_tokens,
        "system_instruction": system_prompt,
    }
    if gemini_tool:
        base_kwargs["tools"] = [gemini_tool]

    # config_force: first turn — ANY forces the model to call a tool
    # config_auto:  subsequent turns — AUTO lets the model choose text or tool
    config_force = gtypes.GenerateContentConfig(
        **base_kwargs,
        **({"tool_config": gtypes.ToolConfig(function_calling_config=gtypes.FunctionCallingConfig(mode="ANY"))} if gemini_tool else {}),
    )
    config_auto = gtypes.GenerateContentConfig(
        **base_kwargs,
        **({"tool_config": gtypes.ToolConfig(function_calling_config=gtypes.FunctionCallingConfig(mode="AUTO"))} if gemini_tool else {}),
    )

    return model_name, config_force, config_auto


# Keep legacy name as alias — returns (model_name, config_force, config_auto)
def _make_gemini_model(model_name: str, agent_config=None):
    """Legacy wrapper — returns (model_name, config_force, config_auto) tuple via new SDK."""
    return _make_gemini_config(model_name, agent_config)


def _build_provider_chain(primary_model: str | None = None) -> List[Dict[str, str]]:
    """Build ordered list of OpenRouter models to try, primary first."""
    chain = [{"provider": settings.active_provider, "model": primary_model or settings.active_model}]
    for entry in settings.fallback_chain:
        if entry not in chain:
            chain.append(entry)
    return chain


# _call_openai and _call_anthropic removed — unused legacy helpers.
# All LLM calls go through _openai_loop / _anthropic_loop / _gemini_loop.


# ─────────────────────────────────────────────────────────────────────────────
# In-memory session store
# ─────────────────────────────────────────────────────────────────────────────

_sessions: Dict[str, ConversationSession] = {}


def get_or_create_session(session_id: Optional[str], context: Dict) -> ConversationSession:
    import datetime
    if session_id and session_id in _sessions:
        s = _sessions[session_id]
        s.last_active = datetime.datetime.utcnow()
        if context:
            s.context.update(context)
        return s
    new_id = session_id or str(uuid.uuid4())
    session = ConversationSession(
        session_id=new_id,
        messages=[],
        context=context or {},
    )
    _sessions[new_id] = session
    return session


async def load_session_from_db(session_id: str, token: str) -> Optional[ConversationSession]:
    """
    Load a session from the backend DB into memory.
    Returns None if not found / not accessible.
    Called when a session is requested by REST endpoints but not in _sessions.
    """
    from app.clients.bi_client import bi_client
    data = await bi_client.load_chat_session(session_id, token=token)
    if not data:
        return None

    session = ConversationSession(
        session_id=session_id,
        messages=[],
        context={**(data.get("context") or {}), "auth_token": token},
    )
    # Seed title
    session.title = data.get("title", "New Conversation")

    # Reconstruct messages from persisted history.
    # DB only stores role=user and role=assistant (no tool or assistant+tool_calls rows).
    # Skip any other roles defensively — they would cause 400 errors from LLM providers.
    for m in data.get("messages", []):
        role = m.get("role", "user")
        content = m.get("content", "")

        # Only reconstruct user/assistant conversational messages.
        # tool messages and assistant-with-tool_calls messages are transient
        # (mid-turn state) and must never be restored into history — they would
        # break the OpenAI message sequence invariant.
        if role not in ("user", "assistant"):
            continue
        if not content and role == "assistant":
            continue
        # Assistant messages that carry tool_calls are mid-turn state — skip them.
        if role == "assistant" and m.get("tool_calls"):
            continue

        msg = Message(role=role, content=content)
        if role == "assistant":
            msg.message_id = m.get("message_id")
            msg.metrics = m.get("metrics")
            msg.feedback = m.get("feedback")
            msg.charts = m.get("charts")
            # user_query stored on assistant msg for correction button
            if m.get("user_query"):
                msg.extra = {"user_query": m["user_query"]}
        session.messages.append(msg)

    _sessions[session_id] = session
    return session


def _strip_incomplete_tool_turns(messages: List[Message]) -> List[Message]:
    """
    Remove any trailing incomplete tool-call turns from session history.

    An incomplete turn is: an assistant message with tool_calls that is NOT
    followed by a matching tool result for every tool_call_id.  This happens
    when a provider fails mid-turn (after appending assistant+tool messages
    but before producing the final assistant text response).  Leaving these
    orphan messages in the history causes the next provider attempt to receive
    a 400 error: "messages with role 'tool' must be a response to a preceeding
    message with 'tool_calls'".

    Also removes any trailing role='tool' messages that have no preceding
    assistant message with tool_calls (safety net for other corruption paths).
    """
    if not messages:
        return messages

    result = list(messages)

    # Walk backwards and drop any trailing tool/assistant-tool_calls pairs
    # that form an incomplete turn.
    while result:
        last = result[-1]

        # Case 1: trailing role='tool' with no paired assistant tool_calls before it
        if last.role == "tool":
            # Find the assistant message that owns this tool_call_id
            tc_id = last.tool_call_id
            paired = any(
                m.role == "assistant" and m.tool_calls and
                any(tc.get("id") == tc_id for tc in (m.tool_calls or []))
                for m in result[:-1]
            )
            if not paired:
                result.pop()
                continue

        # Case 2: trailing assistant message with tool_calls but no following
        # tool result messages — the turn was started but never completed.
        if last.role == "assistant" and last.tool_calls:
            expected_ids = {tc.get("id") for tc in last.tool_calls if tc.get("id")}
            following_ids = {
                m.tool_call_id for m in result
                if m.role == "tool" and m.tool_call_id
            }
            if expected_ids and not expected_ids.issubset(following_ids):
                result.pop()
                continue

        break  # history looks clean

    return result


def _trim_history(messages: List[Message], max_messages: int = 20) -> List[Message]:
    """
    Keep last N messages to stay within context window.

    Crucially, the trimmed list must NOT start with a 'tool' or an
    'assistant-with-tool_calls' message, because OpenAI will reject a history
    where a tool-result message has no preceding tool_calls.  Walk forward
    from the naive cut point until we land on a clean 'user' message.

    Also strips any orphan tool messages anywhere in the sequence — these can
    appear if history was loaded from DB (which only stores user/assistant rows)
    and an earlier session mixed with in-memory incomplete turns.
    """
    if len(messages) <= max_messages:
        trimmed = messages
    else:
        trimmed = messages[-max_messages:]
        # Advance until we find a 'user' message as the first entry
        for i, m in enumerate(trimmed):
            if m.role == "user":
                trimmed = trimmed[i:]
                break

    # Remove any tool messages whose tool_call_id has no matching preceding
    # assistant tool_calls — these would cause 400 errors on the next LLM call.
    # Build index of all tool_call ids present in assistant messages.
    known_tc_ids: set = set()
    for m in trimmed:
        if m.role == "assistant" and m.tool_calls:
            for tc in m.tool_calls:
                if tc.get("id"):
                    known_tc_ids.add(tc["id"])

    cleaned = [
        m for m in trimmed
        if not (m.role == "tool" and m.tool_call_id not in known_tc_ids)
    ]

    # After removing orphan tool messages, also remove any assistant messages
    # with tool_calls that now have no following tool results.
    result: List[Message] = []
    for idx, m in enumerate(cleaned):
        if m.role == "assistant" and m.tool_calls:
            expected = {tc.get("id") for tc in m.tool_calls if tc.get("id")}
            following_ids = {
                fm.tool_call_id for fm in cleaned[idx + 1:]
                if fm.role == "tool" and fm.tool_call_id
            }
            if expected and not expected.issubset(following_ids):
                continue  # drop incomplete assistant tool_calls message
        result.append(m)

    return result


def _truncate_tool_result(result: dict, max_rows: int = 50) -> dict:
    """
    Truncate large row arrays before storing in message history.

    Without this, a query returning 200 rows × 20 columns (~6 KB) gets stored
    in every subsequent context window, bloating costs and degrading quality.
    The AI already read the full rows during tool execution; the truncated
    version is just for history reconstruction.
    """
    out = {k: v for k, v in result.items() if k != "auto_chart"}
    for key in ("rows", "data"):
        val = out.get(key)
        if isinstance(val, list) and len(val) > max_rows:
            out[key] = val[:max_rows]
            out["_truncated"] = f"{key} capped at {max_rows} of {len(val)} rows in history"
    return out


def _describe_active_resource(resource: Dict[str, Any]) -> str:
    resource_type = str(resource.get("type") or "resource")
    name = str(resource.get("name") or "").strip()
    resource_id = resource.get("id")
    dataset_id = resource.get("dataset_id")
    table_id = resource.get("table_id")

    details: List[str] = []
    if name:
        details.append(name)
    if resource_id not in (None, ""):
        details.append(f"id={resource_id}")
    if dataset_id not in (None, ""):
        details.append(f"dataset_id={dataset_id}")
    if table_id not in (None, ""):
        details.append(f"table_id={table_id}")

    if details:
        return f"{resource_type}: " + ", ".join(str(detail) for detail in details)
    return resource_type


def _build_session_scope_prompt(session: ConversationSession) -> str:
    context = session.context or {}
    dataset_id = context.get("dataset_id")
    if dataset_id in (None, ""):
        return ""

    dataset_name = str(context.get("dataset_name") or "").strip() or f"Dataset {dataset_id}"
    lines = [
        "## ACTIVE SESSION SCOPE",
        f"Active dataset: {dataset_name} (dataset_id={dataset_id}).",
        "Never query, search, or answer from any other dataset in this session.",
    ]

    active_resource = context.get("active_resource")
    if isinstance(active_resource, dict) and active_resource.get("type") not in (None, "", "dataset"):
        lines.append(
            "Current focus from earlier turns: "
            f"{_describe_active_resource(active_resource)}."
        )
        lines.append(
            "If the user says 'chart do', 'bao cao tren', or another follow-up reference, "
            "use this current focus first before searching again."
        )

    return "\n".join(lines)


def _track_active_resource(
    session: ConversationSession,
    tool_name: str,
    tool_result: Dict[str, Any],
) -> None:
    if not isinstance(tool_result, dict) or tool_result.get("error"):
        return

    context = session.context
    dataset_id = context.get("dataset_id")
    dataset_name = context.get("dataset_name")
    resource: Optional[Dict[str, Any]] = None

    if tool_name == "search_charts":
        top_chart = tool_result.get("top_chart_data") or ((tool_result.get("charts") or [None])[0] or {})
        chart_id = top_chart.get("chart_id") or top_chart.get("id")
        if chart_id is not None:
            resource = {
                "type": "chart",
                "id": chart_id,
                "name": top_chart.get("chart_name") or top_chart.get("name") or "",
                "chart_type": top_chart.get("chart_type"),
                "dataset_id": dataset_id,
                "dataset_name": dataset_name,
            }
    elif tool_name == "run_chart":
        chart_id = tool_result.get("chart_id")
        if chart_id is not None:
            resource = {
                "type": "chart",
                "id": chart_id,
                "name": tool_result.get("chart_name") or "",
                "chart_type": tool_result.get("chart_type"),
                "dataset_id": dataset_id,
                "dataset_name": dataset_name,
            }
    elif tool_name == "search_dashboards":
        dashboard = ((tool_result.get("dashboards") or [None])[0] or {})
        dashboard_id = dashboard.get("id")
        if dashboard_id is not None:
            resource = {
                "type": "dashboard",
                "id": dashboard_id,
                "name": dashboard.get("name") or "",
                "dataset_id": dataset_id,
                "dataset_name": dataset_name,
            }
    elif tool_name == "inspect_dashboard":
        dashboard_id = tool_result.get("dashboard_id")
        if dashboard_id is not None:
            resource = {
                "type": "dashboard",
                "id": dashboard_id,
                "name": tool_result.get("dashboard_name") or "",
                "chart_count": tool_result.get("chart_count"),
                "dataset_id": dataset_id,
                "dataset_name": dataset_name,
            }
    elif tool_name == "create_dashboard":
        dashboard_id = tool_result.get("dashboard_id")
        if dashboard_id is not None:
            resource = {
                "type": "dashboard",
                "id": dashboard_id,
                "name": tool_result.get("dashboard_name") or "",
                "chart_count": tool_result.get("chart_count"),
                "dataset_id": dataset_id,
                "dataset_name": dataset_name,
            }
    elif tool_name in {"query_table", "run_dataset_table", "explore_data", "explain_insight"}:
        table_id = tool_result.get("table_id")
        if table_id is not None:
            resource = {
                "type": "table",
                "id": table_id,
                "table_id": table_id,
                "dataset_id": tool_result.get("dataset_id", dataset_id),
                "dataset_name": dataset_name,
            }
    elif tool_name == "create_chart":
        chart_id = tool_result.get("chart_id")
        if chart_id is not None:
            resource = {
                "type": "chart",
                "id": chart_id,
                "name": tool_result.get("chart_name") or "",
                "chart_type": tool_result.get("chart_type"),
                "dataset_id": tool_result.get("dataset_id", dataset_id),
                "dataset_name": dataset_name,
                "table_id": tool_result.get("table_id"),
            }
        elif tool_result.get("table_id") is not None:
            resource = {
                "type": "table",
                "id": tool_result.get("table_id"),
                "table_id": tool_result.get("table_id"),
                "dataset_id": tool_result.get("dataset_id", dataset_id),
                "dataset_name": dataset_name,
            }

    if resource:
        context["active_resource"] = resource


def _to_llm_messages(
    session: ConversationSession,
    turn_context: str = "",
    system_prompt: str = "",
    max_history: int = 20,
) -> List[Dict]:
    """Convert session messages to OpenAI API format, injecting per-turn context.

    system_prompt: override from AgentConfig (intent-specific variant).
    max_history:   per-intent message limit (INSIGHT=50, others=20).
    """
    system = system_prompt or _get_base_prompt()
    if turn_context:
        system += "\n\n" + turn_context
    elif session.db_context:
        system += "\n\n" + session.db_context
    result = [{"role": "system", "content": system}]
    for m in _trim_history(session.messages, max_messages=max_history):
        msg: Dict[str, Any] = {"role": m.role, "content": m.content}
        if m.tool_call_id:
            msg["tool_call_id"] = m.tool_call_id
        if m.name:
            msg["name"] = m.name
        if m.tool_calls:
            msg["tool_calls"] = m.tool_calls
        result.append(msg)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Main streaming orchestrator
# ─────────────────────────────────────────────────────────────────────────────

async def run_agent(
    user_message: str,
    session: ConversationSession,
) -> AsyncGenerator[Dict, None]:
    """
    Drive one conversation turn.
    Yields serialised event dicts ready to be sent over WebSocket.

    Phase 1 additions:
    - classify_intent() routes to the right AgentConfig (prompt + token budget)
    - VAGUE intent returns a clarification question without calling any tools
    """
    token: str = session.context.get("auth_token", "")

    # ── Step 0: Classify intent to select the right agent config ──
    primary_provider = settings.active_provider
    primary_model = settings.intent_classifier_model

    from app.agents.intent_classifier import classify_intent, IntentType
    agent_config = await classify_intent(user_message, primary_provider, primary_model)
    logger.debug("intent_classifier → %s (max_tokens=%d, tool_limit=%d)",
                 agent_config.intent, agent_config.max_tokens, agent_config.tool_call_limit)

    # Phase 3: store intent in session context for governance/usage tracking
    session.context["_last_intent"] = agent_config.intent.value

    # ── VAGUE: return clarification question without any tool calls ──
    if agent_config.intent == IntentType.VAGUE:
        clarification = agent_config.clarification_question or (
            "Bạn muốn phân tích khía cạnh nào? "
            "Ví dụ: tra cứu số liệu, khám phá dữ liệu, tìm nguyên nhân, hay tạo biểu đồ?"
        )
        session.messages.append(Message(role="user", content=user_message))
        session.messages.append(Message(role="assistant", content=clarification))
        yield TextEvent(content=clarification).model_dump()
        yield DoneEvent(session_id=session.session_id).model_dump()

        # Persist clarification exchange
        try:
            from app.clients.bi_client import bi_client
            await bi_client.append_chat_messages(
                session.session_id,
                [
                    {"role": "user", "content": user_message},
                    {"role": "assistant", "content": clarification},
                ],
                token=token,
            )
        except Exception:
            pass
        return

    # ── A3: Rate limit check using actual classified intent ──
    from app.agents.governance import rate_limiter as _rate_limiter
    from app.agents.intent_classifier import IntentType as _IntentType
    _user_id = session.context.get("user_id", "")
    if _user_id and agent_config.intent != _IntentType.VAGUE:
        _intent_str = agent_config.intent.value
        _allowed, _remaining = _rate_limiter.check(_user_id, _intent_str)
        if not _allowed:
            from app.agents.governance import _RATE_LIMITS as _RL
            _limit_n = _RL.get(_intent_str, (100, 3600))[0]
            yield ErrorEvent(
                content=f"Bạn đã đạt giới hạn {_limit_n} yêu cầu/giờ cho loại câu hỏi này. Vui lòng thử lại sau."
            ).model_dump()
            yield DoneEvent(session_id=session.session_id).model_dump()
            return
        _rate_limiter.record(_user_id, _intent_str)

    # ── Step 0b: Enrich INSIGHT execution prompt with few-shot examples ──
    # Wire is now for execution prompt only (planning prompt stays compact)
    if agent_config.intent == _IntentType.INSIGHT:
        try:
            from app.agents.feedback_analyzer import get_feedback_analyzer
            _fa = get_feedback_analyzer()
            if _fa._loaded:  # Only enrich if feedback has been loaded (don't trigger load per turn)
                from app.agents.feedback_analyzer import enrich_insight_prompt
                _examples = _fa.get_best_examples(intent="INSIGHT", limit=2)
                if _examples:
                    agent_config.system_prompt = enrich_insight_prompt(agent_config.system_prompt, _examples)
        except Exception:
            pass  # enrichment failure never breaks the chat

    # ── Step 1: Build per-turn context ──
    from app.agents.context_builder import build_context
    ctx_pkg = await build_context(
        user_message,
        token=token,
        dataset_id=session.context.get("dataset_id"),
    )
    scope_prompt = _build_session_scope_prompt(session)
    turn_context = "\n\n".join(
        section for section in [scope_prompt, ctx_pkg.to_prompt_section()] if section
    )
    # Cache first turn's context as fallback for tool calls that need session.db_context
    if turn_context and not session.db_context:
        session.db_context = turn_context

    # Append user message
    session.messages.append(Message(role="user", content=user_message))

    # Auto-title: use the first user message (truncated)
    if session.title == "New Conversation":
        session.title = user_message[:60] + ("…" if len(user_message) > 60 else "")

    # Track chart data collected during this turn so we can embed charts
    chart_data_cache: Dict[int, Dict] = {}

    # ── Metrics collector for this turn ──
    message_id = str(uuid.uuid4())[:12]
    t_start = time.monotonic()
    metrics_ctx: Dict[str, Any] = {
        "tool_calls": [],      # tool names in call order
        "tool_errors": 0,
        "has_chart": False,
        "has_data_backing": False,
        "data_rows_analyzed": 0,
        "input_tokens": None,
        "output_tokens": None,
        "provider": "",
        "model": "",
    }

    provider_chain = _build_provider_chain(settings.model_for_intent(agent_config.intent.value))

    for attempt, provider_info in enumerate(provider_chain):
        provider = provider_info["provider"]
        model = provider_info["model"]
        metrics_ctx["provider"] = provider
        metrics_ctx["model"] = model
        is_last = attempt == len(provider_chain) - 1
        try:
            turn_charts: list = []  # collect chart events emitted this turn
            async for event in _run_with_provider(
                provider=provider,
                model=model,
                session=session,
                tool_calls_made=0,
                chart_data_cache=chart_data_cache,
                metrics_ctx=metrics_ctx,
                message_id=message_id,
                token=token,
                turn_context=turn_context,
                agent_config=agent_config,
            ):
                if isinstance(event, dict) and event.get("type") == "chart":
                    turn_charts.append(event)
                yield event

            # ── Emit metrics event before done ──
            latency_ms = int((time.monotonic() - t_start) * 1000)
            metrics_event = MetricsEvent(
                message_id=message_id,
                latency_ms=latency_ms,
                model=metrics_ctx["model"],
                provider=metrics_ctx["provider"],
                tool_calls=metrics_ctx["tool_calls"],
                tool_call_count=len(metrics_ctx["tool_calls"]),
                tool_errors=metrics_ctx["tool_errors"],
                has_chart=metrics_ctx["has_chart"],
                has_data_backing=metrics_ctx["has_data_backing"],
                data_rows_analyzed=metrics_ctx["data_rows_analyzed"],
                input_tokens=metrics_ctx["input_tokens"],
                output_tokens=metrics_ctx["output_tokens"],
                intent=agent_config.intent.value if agent_config else None,
            )
            yield metrics_event.model_dump()

            # Store metrics + charts on the last assistant message
            assistant_msg_content = ""
            for m in reversed(session.messages):
                if m.role == "assistant" and m.content:
                    m.message_id = message_id
                    m.metrics = metrics_event.model_dump(exclude={"type"})
                    if turn_charts:
                        m.charts = turn_charts
                    assistant_msg_content = m.content if isinstance(m.content, str) else ""
                    break

            # ── Persist new messages to backend DB (best-effort, non-blocking) ──
            try:
                from app.clients.bi_client import bi_client
                msgs_to_save = [
                    {"role": "user", "content": user_message},
                    {
                        "role": "assistant",
                        "content": assistant_msg_content,
                        "message_id": message_id,
                        "user_query": user_message,
                        "charts": turn_charts or None,
                        "metrics": metrics_event.model_dump(exclude={"type"}),
                    },
                ]
                await bi_client.append_chat_messages(session.session_id, msgs_to_save, token=token)
                # Also sync the title in case it was just set this turn
                await bi_client.upsert_chat_session(
                    session.session_id, session.title,
                    session.owner_user_id or "", token=token,
                    context={k: v for k, v in session.context.items() if k != "auth_token"},
                )
            except Exception:
                pass  # persistence failure never breaks the chat response

            # ── Suggest follow-up questions ──
            try:
                suggestions = await _generate_suggestions(provider, model, session)
                if suggestions:
                    yield SuggestionsEvent(suggestions=suggestions).model_dump()
            except Exception:
                pass  # suggestions are optional — never fail the response

            return

        except asyncio.TimeoutError:
            logger.warning(
                f"Provider {provider}:{model} timed out "
                f"(attempt {attempt + 1}/{len(provider_chain)})"
            )
            # Strip any incomplete tool turns appended during the failed attempt
            # so the next provider receives a clean, valid message sequence.
            session.messages = _strip_incomplete_tool_turns(session.messages)
            if not is_last:
                next_p = provider_chain[attempt + 1]
                yield ThinkingEvent(
                    content=f"{provider.capitalize()} không phản hồi, "
                            f"đang chuyển sang {next_p['provider'].capitalize()} ({next_p['model']})…"
                ).model_dump()
            else:
                yield ErrorEvent(
                    content="Tất cả model đều không phản hồi. Vui lòng thử lại sau."
                ).model_dump()
                return

        except Exception as e:
            logger.warning(f"Provider {provider}:{model} failed (attempt {attempt + 1}): {e}")
            # Strip any incomplete tool turns appended during the failed attempt
            # so the next provider receives a clean, valid message sequence.
            session.messages = _strip_incomplete_tool_turns(session.messages)
            if not is_last:
                next_p = provider_chain[attempt + 1]
                yield ThinkingEvent(
                    content=f"{provider.capitalize()} gặp lỗi, đang chuyển sang "
                            f"{next_p['provider'].capitalize()} ({next_p['model']})…"
                ).model_dump()
            else:
                yield ErrorEvent(
                    content=f"Tất cả LLM provider đều thất bại. Lỗi cuối: {str(e)}"
                ).model_dump()
                return


async def _run_with_provider(
    provider: str,
    model: str,
    session: ConversationSession,
    tool_calls_made: int,
    chart_data_cache: Dict[int, Dict],
    metrics_ctx: Dict[str, Any],
    message_id: str,
    token: str = "",
    turn_context: str = "",
    agent_config=None,
) -> AsyncGenerator[Dict, None]:
    """
    Run the tool-calling loop for a single provider.
    INSIGHT intent uses the dedicated 2-phase _insight_loop.
    All other intents use the standard single-phase _openai_loop / _anthropic_loop.
    """
    from app.agents.intent_classifier import IntentType as _IT
    _use_insight_loop = (
        agent_config is not None
        and agent_config.intent == _IT.INSIGHT
        and provider in ("openai", "openrouter")  # insight loop is OpenAI-compatible only
    )

    if provider == "openai":
        client = _make_openai_client()
        if _use_insight_loop:
            async for event in _insight_loop(
                client,
                settings.insight_planning_model,
                settings.insight_execution_model,
                session,
                chart_data_cache,
                metrics_ctx,
                token=token,
                turn_context=turn_context,
                agent_config=agent_config,
            ):
                yield event
        else:
            yield ThinkingEvent(content="Đang phân tích câu hỏi...").model_dump()
            async for event in _openai_loop(client, model, session, tool_calls_made, chart_data_cache, metrics_ctx, token=token, turn_context=turn_context, agent_config=agent_config):
                yield event
    elif provider == "anthropic":
        client = _make_anthropic_client()
        yield ThinkingEvent(content="Đang phân tích câu hỏi...").model_dump()
        async for event in _anthropic_loop(client, model, session, tool_calls_made, chart_data_cache, metrics_ctx, token=token, turn_context=turn_context, agent_config=agent_config):
            yield event
    elif provider == "gemini":
        from app.agents.intent_classifier import IntentType as _IT2
        _intent_val = agent_config.intent.value if agent_config else "LOOKUP"
        _gemini_model_name = settings.model_for_intent(_intent_val)
        metrics_ctx["model"] = _gemini_model_name

        if agent_config is not None and agent_config.intent == _IT2.INSIGHT:
            async for event in _gemini_insight_loop(
                settings.insight_planning_model,
                _gemini_model_name,
                session,
                chart_data_cache,
                metrics_ctx,
                token=token, turn_context=turn_context, agent_config=agent_config,
            ):
                yield event
        else:
            gemini_model_config = _make_gemini_config(_gemini_model_name, agent_config=agent_config)  # returns 3-tuple
            yield ThinkingEvent(content="Đang phân tích câu hỏi...").model_dump()
            async for event in _gemini_loop(gemini_model_config, session, tool_calls_made, chart_data_cache, metrics_ctx, token=token, turn_context=turn_context, agent_config=agent_config):
                yield event
    elif provider == "openrouter":
        api_keys = settings.active_api_keys
        if not api_keys:
            raise RuntimeError(
                "No OpenRouter API keys configured. "
                "Set OPENROUTER_API_KEY or OPENROUTER_API_KEY_1..5 in .env"
            )
        last_key_exc: Exception | None = None
        for key_index, api_key in enumerate(api_keys, start=1):
            try:
                client = _make_openrouter_client(api_key=api_key)
                if _use_insight_loop:
                    async for event in _insight_loop(
                        client,
                        settings.insight_planning_model,
                        settings.insight_execution_model,
                        session,
                        chart_data_cache,
                        metrics_ctx,
                        token=token,
                        turn_context=turn_context,
                        agent_config=agent_config,
                    ):
                        yield event
                else:
                    if key_index == 1:
                        yield ThinkingEvent(content="Đang phân tích câu hỏi...").model_dump()
                    async for event in _openai_loop(client, model, session, tool_calls_made, chart_data_cache, metrics_ctx, token=token, turn_context=turn_context, agent_config=agent_config):
                        yield event
                return  # success — stop key rotation
            except Exception as exc:
                if _is_key_exhausted(exc):
                    logger.warning("OpenRouter key #%d exhausted (model=%s): %s — trying next key", key_index, model, exc)
                    last_key_exc = exc
                    continue
                raise  # non-quota error — bubble up to provider loop
        # All keys exhausted
        raise RuntimeError(
            f"All {len(api_keys)} OpenRouter API key(s) exhausted for model={model}. "
            "Check credits on OPENROUTER_API_KEY_1..5."
        ) from last_key_exc
    else:
        raise ValueError(f"Unknown provider: {provider}")


# ── OpenAI loop ────────────────────────────────────────────────────────────────

async def _openai_loop(
    client,
    model: str,
    session: ConversationSession,
    tool_calls_made: int,
    chart_data_cache: Dict[int, Dict],
    metrics_ctx: Dict[str, Any],
    token: str = "",
    turn_context: str = "",
    agent_config=None,
) -> AsyncGenerator[Dict, None]:
    from openai import AsyncOpenAI
    from app.agents.tools import get_tool_schemas

    LLM_TIMEOUT = 45  # seconds per LLM call

    # Resolve config values — fall back to safe defaults when no config provided
    max_tokens = agent_config.max_tokens if agent_config else 1024
    tool_call_limit = agent_config.tool_call_limit if agent_config else settings.ai_max_tool_calls
    system_prompt = agent_config.system_prompt if agent_config else ""
    force_first_tool = agent_config.force_first_tool if agent_config else True
    temperature = agent_config.temperature if agent_config else 0.2
    max_history = agent_config.max_history if agent_config else 20
    # Phase 2: intent-specific tool set reduces noise and wrong tool choices
    active_tools = get_tool_schemas(agent_config.tool_names if agent_config else None)

    while tool_calls_made <= tool_call_limit:
        llm_messages = _to_llm_messages(
            session, turn_context=turn_context, system_prompt=system_prompt, max_history=max_history
        )

        # Accumulate streamed response
        collected_content = ""
        collected_tool_calls: List[Dict] = []

        # Force a tool call on the first turn so model doesn't answer from memory
        force_tool = "auto"
        if tool_calls_made == 0 and force_first_tool:
            force_tool = "required"

        response = await asyncio.wait_for(
            client.chat.completions.create(
                model=model,
                messages=llm_messages,
                tools=active_tools,
                tool_choice=force_tool,
                stream=True,
                temperature=temperature,
                max_tokens=max_tokens,
                stream_options={"include_usage": True},
            ),
            timeout=LLM_TIMEOUT,
        )

        # current tool_call being streamed
        current_tc: Dict[str, Any] = {}

        async for chunk in response:
            # B4 fix: extract token usage from final streaming chunk (stream_options=include_usage)
            if hasattr(chunk, "usage") and chunk.usage is not None:
                metrics_ctx["input_tokens"] = (metrics_ctx["input_tokens"] or 0) + (chunk.usage.prompt_tokens or 0)
                metrics_ctx["output_tokens"] = (metrics_ctx["output_tokens"] or 0) + (chunk.usage.completion_tokens or 0)

            delta = chunk.choices[0].delta if chunk.choices else None
            if delta is None:
                continue
            finish = chunk.choices[0].finish_reason

            # Text content
            if delta.content:
                collected_content += delta.content
                yield TextEvent(content=delta.content).model_dump()

            # Tool call deltas
            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    idx = tc_delta.index
                    if idx >= len(collected_tool_calls):
                        collected_tool_calls.append({"id": "", "function": {"name": "", "arguments": ""}})
                    if tc_delta.id:
                        collected_tool_calls[idx]["id"] = tc_delta.id
                    if tc_delta.function:
                        if tc_delta.function.name:
                            collected_tool_calls[idx]["function"]["name"] += tc_delta.function.name
                        if tc_delta.function.arguments:
                            collected_tool_calls[idx]["function"]["arguments"] += tc_delta.function.arguments

        # --- After streaming ---
        if collected_content and not collected_tool_calls:
            # Pure text response — append and finish
            session.messages.append(Message(role="assistant", content=collected_content))
            async for chart_event in _emit_chart_events(collected_content, chart_data_cache):
                yield chart_event

        if not collected_tool_calls:
            # No tool calls → done
            break

        # Append assistant message with tool calls (must include tool_calls for valid history)
        tc_records = [
            {"id": tc["id"], "type": "function", "function": {"name": tc["function"]["name"], "arguments": tc["function"]["arguments"]}}
            for tc in collected_tool_calls
        ]
        session.messages.append(Message(
            role="assistant",
            content=collected_content or None,
            tool_calls=tc_records,
        ))

        # Execute each tool call
        for tc in collected_tool_calls:
            fn_name = tc["function"]["name"]
            try:
                fn_args = json.loads(tc["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                fn_args = {}

            yield ToolCallEvent(tool=fn_name, args=fn_args).model_dump()

            tool_result: dict
            try:
                tool_result = await _execute_tool_rbac(
                    fn_name,
                    fn_args,
                    session.context.get("user_role", "viewer"),
                    token=token,
                    scope=session.context,
                )
            except Exception as tool_exc:
                err_str = str(tool_exc)
                logger.warning("Tool %s raised exception: %s", fn_name, tool_exc)
                # Detect expired / invalid auth token — bail out immediately so the
                # user gets a clear message rather than an empty or garbled response.
                if "401" in err_str or "unauthorized" in err_str.lower():
                    yield ErrorEvent(
                        content=(
                            "Phiên đăng nhập hết hạn trong khi AI đang xử lý. "
                            "Vui lòng tải lại trang và thử lại."
                        )
                    ).model_dump()
                    return
                tool_result = {"error": f"Tool '{fn_name}' thất bại: {err_str[:300]}"}
            tool_calls_made += 1
            _track_active_resource(session, fn_name, tool_result)

            # ── Metrics: track tool usage ──
            metrics_ctx["tool_calls"].append(fn_name)
            metrics_ctx["has_data_backing"] = True
            if "error" in tool_result:
                metrics_ctx["tool_errors"] += 1
            # Count data points from tool results — covers all tool return shapes
            for key in ("rows", "data"):
                val = tool_result.get(key)
                if isinstance(val, list):
                    metrics_ctx["data_rows_analyzed"] += len(val)
                    break
            top_data = tool_result.get("top_chart_data")
            if isinstance(top_data, dict):
                td_rows = top_data.get("rows")
                if isinstance(td_rows, list):
                    metrics_ctx["data_rows_analyzed"] += len(td_rows)
            # explore_data returns columns/distributions, not rows — count columns analyzed
            if fn_name == "explore_data":
                cols = tool_result.get("columns") or tool_result.get("distributions") or {}
                metrics_ctx["data_rows_analyzed"] += len(cols) if isinstance(cols, (dict, list)) else 0

            # Auto-emit chart when search_charts found one (model reliability fix)
            if fn_name == "search_charts":
                async for ev in _emit_auto_chart(tool_result, chart_data_cache):
                    metrics_ctx["has_chart"] = True
                    yield ev

            # Cache chart data for embedding
            if fn_name == "run_chart" and "chart_id" in tool_result:
                chart_data_cache[tool_result["chart_id"]] = tool_result
                metrics_ctx["has_chart"] = True
                # Emit chart immediately so frontend renders it right away
                yield ChartEvent(
                    chart_id=tool_result["chart_id"],
                    chart_name=tool_result.get("chart_name", ""),
                    chart_type=tool_result.get("chart_type", ""),
                    data=tool_result.get("rows", []),
                    role_config=tool_result.get("role_config"),
                ).model_dump()

            # Emit chart for create_chart preview results
            if fn_name == "create_chart" and tool_result.get("chart_preview"):
                metrics_ctx["has_chart"] = True
                yield ChartEvent(
                    chart_id=tool_result.get("chart_id", 0) or 0,
                    chart_name=tool_result.get("chart_name", "AI Chart"),
                    chart_type=tool_result.get("chart_type", "BAR"),
                    data=tool_result.get("data", []),
                    role_config=None,
                ).model_dump()

            # Build summary for stream event
            summary = _tool_summary(fn_name, tool_result)
            yield ToolResultEvent(tool=fn_name, summary=summary).model_dump()

            # Append tool result to session (B5: truncate rows + strip auto_chart to save tokens)
            stored = _truncate_tool_result(tool_result)
            result_str = json.dumps(stored, ensure_ascii=False, default=str)
            session.messages.append(Message(
                role="tool",
                content=result_str,
                tool_call_id=tc["id"],
                name=fn_name,
            ))

        if tool_calls_made >= tool_call_limit:
            session.messages.append(Message(
                role="user",
                content="[System: max tool calls reached. Please provide your final answer now.]",
            ))
            break


# ── Anthropic loop ─────────────────────────────────────────────────────────────

async def _anthropic_loop(
    client,
    model: str,
    session: ConversationSession,
    tool_calls_made: int,
    chart_data_cache: Dict[int, Dict],
    metrics_ctx: Dict[str, Any],
    token: str = "",
    turn_context: str = "",
    agent_config=None,
) -> AsyncGenerator[Dict, None]:

    from app.agents.tools import get_tool_schemas

    # Resolve config values
    max_tokens = agent_config.max_tokens if agent_config else 1024
    tool_call_limit = agent_config.tool_call_limit if agent_config else settings.ai_max_tool_calls
    system_prompt = agent_config.system_prompt if agent_config else _get_base_prompt()
    temperature = agent_config.temperature if agent_config else 0.2
    max_history = agent_config.max_history if agent_config else 20
    active_tools = get_tool_schemas(agent_config.tool_names if agent_config else None)

    # Convert schemas for Anthropic
    anthropic_tools = [
        {
            "name": t["function"]["name"],
            "description": t["function"]["description"],
            "input_schema": t["function"]["parameters"],
        }
        for t in active_tools
    ]

    while tool_calls_made <= tool_call_limit:
        # Build Anthropic message list
        anthropic_messages = []
        for m in _trim_history(session.messages, max_messages=max_history):
            if m.role == "user":
                anthropic_messages.append({"role": "user", "content": m.content})
            elif m.role == "assistant":
                # Rebuild content blocks for Anthropic format
                blocks = []
                if m.content:
                    blocks.append({"type": "text", "text": m.content})
                if m.tool_calls:
                    for tc in m.tool_calls:
                        fn = tc.get("function", {})
                        try:
                            inp = json.loads(fn.get("arguments", "{}"))
                        except (json.JSONDecodeError, TypeError):
                            inp = {}
                        blocks.append({"type": "tool_use", "id": tc.get("id", ""), "name": fn.get("name", ""), "input": inp})
                if not blocks:
                    blocks.append({"type": "text", "text": ""})
                anthropic_messages.append({"role": "assistant", "content": blocks})
            elif m.role == "tool":
                anthropic_messages.append({
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": m.tool_call_id or "", "content": m.content}],
                })

        LLM_TIMEOUT = 60  # longer timeout for streaming Anthropic

        # A4 fix: use streaming API for word-by-word UX (no more blank screen)
        text_content = ""
        tool_uses = []
        final_response = None

        try:
            async with await asyncio.wait_for(
                client.messages.stream(
                    model=model,
                    max_tokens=max_tokens,
                    system=system_prompt + ("\n\n" + turn_context if turn_context else ""),
                    messages=anthropic_messages,
                    tools=anthropic_tools,
                    temperature=temperature,
                ),
                timeout=LLM_TIMEOUT,
            ) as stream:
                async for text in stream.text_stream:
                    text_content += text
                    yield TextEvent(content=text).model_dump()
                final_response = await stream.get_final_message()
        except Exception as stream_exc:
            # Fallback to non-streaming if stream fails (provider may not support it)
            logger.warning("Anthropic stream failed (%s) — falling back to non-streaming", stream_exc)
            final_response = await asyncio.wait_for(
                client.messages.create(
                    model=model,
                    max_tokens=max_tokens,
                    system=system_prompt + ("\n\n" + turn_context if turn_context else ""),
                    messages=anthropic_messages,
                    tools=anthropic_tools,
                    temperature=temperature,
                ),
                timeout=LLM_TIMEOUT,
            )
            for block in final_response.content:
                if block.type == "text":
                    text_content += block.text
                    for word in block.text.split():
                        yield TextEvent(content=word + " ").model_dump()

        if final_response is None:
            break

        # Extract token usage
        if hasattr(final_response, "usage") and final_response.usage is not None:
            metrics_ctx["input_tokens"] = (metrics_ctx["input_tokens"] or 0) + (final_response.usage.input_tokens or 0)
            metrics_ctx["output_tokens"] = (metrics_ctx["output_tokens"] or 0) + (final_response.usage.output_tokens or 0)

        # Extract tool uses from final message
        for block in final_response.content:
            if block.type == "tool_use":
                tool_uses.append(block)

        if text_content and not tool_uses:
            session.messages.append(Message(role="assistant", content=text_content))
            async for chart_event in _emit_chart_events(text_content, chart_data_cache):
                yield chart_event

        if not tool_uses or final_response.stop_reason == "end_turn":
            break

        # Append assistant message with tool uses (store tool_calls for history)
        tc_records = [
            {"id": tu.id, "type": "function", "function": {"name": tu.name, "arguments": json.dumps(tu.input or {})}}
            for tu in tool_uses
        ]
        session.messages.append(Message(
            role="assistant",
            content=text_content or None,
            tool_calls=tc_records,
        ))

        # Execute each tool use
        for tu in tool_uses:
            fn_name = tu.name
            fn_args = tu.input or {}

            yield ToolCallEvent(tool=fn_name, args=fn_args).model_dump()

            tool_result: dict
            try:
                tool_result = await _execute_tool_rbac(
                    fn_name,
                    fn_args,
                    session.context.get("user_role", "viewer"),
                    token=token,
                    scope=session.context,
                )
            except Exception as tool_exc:
                err_str = str(tool_exc)
                logger.warning("Tool %s raised exception: %s", fn_name, tool_exc)
                if "401" in err_str or "unauthorized" in err_str.lower():
                    yield ErrorEvent(
                        content=(
                            "Phiên đăng nhập hết hạn trong khi AI đang xử lý. "
                            "Vui lòng tải lại trang và thử lại."
                        )
                    ).model_dump()
                    return
                tool_result = {"error": f"Tool '{fn_name}' thất bại: {err_str[:300]}"}
            tool_calls_made += 1
            _track_active_resource(session, fn_name, tool_result)

            # ── Metrics: track tool usage ──
            metrics_ctx["tool_calls"].append(fn_name)
            metrics_ctx["has_data_backing"] = True
            if "error" in tool_result:
                metrics_ctx["tool_errors"] += 1
            for key in ("rows", "data"):
                rows = tool_result.get(key)
                if isinstance(rows, list):
                    metrics_ctx["data_rows_analyzed"] += len(rows)
                    break
            top_data = tool_result.get("top_chart_data")
            if isinstance(top_data, dict):
                td_rows = top_data.get("rows")
                if isinstance(td_rows, list):
                    metrics_ctx["data_rows_analyzed"] += len(td_rows)

            if fn_name == "search_charts":
                async for ev in _emit_auto_chart(tool_result, chart_data_cache):
                    metrics_ctx["has_chart"] = True
                    yield ev

            if fn_name == "run_chart" and "chart_id" in tool_result:
                chart_data_cache[tool_result["chart_id"]] = tool_result
                metrics_ctx["has_chart"] = True
                # Emit chart immediately so frontend renders it right away
                yield ChartEvent(
                    chart_id=tool_result["chart_id"],
                    chart_name=tool_result.get("chart_name", ""),
                    chart_type=tool_result.get("chart_type", ""),
                    data=tool_result.get("rows", []),
                    role_config=tool_result.get("role_config"),
                ).model_dump()

            summary = _tool_summary(fn_name, tool_result)
            yield ToolResultEvent(tool=fn_name, summary=summary).model_dump()

            # B5 fix: truncate rows + strip auto_chart before storing in history
            stored = _truncate_tool_result(tool_result)
            result_str = json.dumps(stored, ensure_ascii=False, default=str)
            session.messages.append(Message(
                role="tool",
                content=result_str,
                tool_call_id=tu.id,
                name=fn_name,
            ))

        if tool_calls_made >= tool_call_limit:
            break

# ── Insight loop (2-phase: plan → execute) ────────────────────────────────────

async def _insight_loop(
    client,
    planning_model: str,
    execution_model: str,
    session: ConversationSession,
    chart_data_cache: Dict[int, Dict],
    metrics_ctx: Dict[str, Any],
    token: str = "",
    turn_context: str = "",
    agent_config=None,
) -> AsyncGenerator[Dict, None]:
    """
    Two-phase reasoning loop for INSIGHT intent.

    Phase A — Planning call (no tools, temp=0.5, max=400 tokens):
      Reads question + schema context → outputs JSON investigation plan.

    Phase B — Execution loop (tools enabled, temp from agent_config):
      Executes each query in the plan. Plan injected as context.
      Enforces: do NOT answer until >= 3 tool calls made.
    """
    from app.agents.tools import get_tool_schemas
    from app.prompts import INSIGHT_PLANNING_PROMPT

    LLM_TIMEOUT = 45
    max_tokens = (agent_config.max_tokens if agent_config else 2500)
    tool_call_limit = (agent_config.tool_call_limit if agent_config else 12)
    execution_prompt = (agent_config.system_prompt if agent_config else _get_base_prompt())
    temperature = (agent_config.temperature if agent_config else 0.5)
    max_history = (agent_config.max_history if agent_config else 50)
    active_tools = get_tool_schemas(agent_config.tool_names if agent_config else None)

    # ── Phase A: Planning ─────────────────────────────────────────────────────
    yield ThinkingEvent(content="Đang lên kế hoạch phân tích...").model_dump()

    plan_json: str = ""
    plan_messages = _to_llm_messages(
        session,
        turn_context=turn_context,
        system_prompt=INSIGHT_PLANNING_PROMPT,
        max_history=10,  # Planning only needs recent context
    )

    try:
        plan_resp = await asyncio.wait_for(
            client.chat.completions.create(
                model=planning_model,
                messages=plan_messages,
                stream=False,
                temperature=0.5,
                max_tokens=400,
                # No tools — pure reasoning
            ),
            timeout=30,
        )
        plan_json = (plan_resp.choices[0].message.content or "").strip()

        # Track planning tokens
        if plan_resp.usage:
            metrics_ctx["input_tokens"] = (metrics_ctx["input_tokens"] or 0) + (plan_resp.usage.prompt_tokens or 0)
            metrics_ctx["output_tokens"] = (metrics_ctx["output_tokens"] or 0) + (plan_resp.usage.completion_tokens or 0)

        # Parse and log plan (for debugging / metrics)
        try:
            import json as _json
            _plan = _json.loads(plan_json)
            plan_summary = f"[{_plan.get('question_type','?')}] {len(_plan.get('query_sequence',[]))} queries planned"
            yield ThinkingEvent(content=f"Kế hoạch: {plan_summary}").model_dump()
            logger.debug("insight_plan: %s", plan_summary)
        except Exception:
            pass  # plan_json may not be valid JSON — still useful as context

    except Exception as plan_exc:
        logger.warning("insight_loop: planning phase failed (%s) — proceeding without plan", plan_exc)
        plan_json = ""

    # ── Phase B: Execution with plan injected ─────────────────────────────────
    yield ThinkingEvent(content="Đang thực hiện phân tích...").model_dump()

    # Inject plan as additional execution context
    exec_system = execution_prompt
    if plan_json:
        exec_system += (
            "\n\n## INVESTIGATION PLAN (follow this sequence)\n"
            + plan_json
            + "\n\nExecute each step in query_sequence before writing the final answer. "
            "Do NOT answer after fewer than 3 tool calls unless data is definitively complete."
        )

    tool_calls_made = 0
    while tool_calls_made <= tool_call_limit:
        exec_messages = _to_llm_messages(
            session,
            turn_context=turn_context,
            system_prompt=exec_system,
            max_history=max_history,
        )

        collected_content = ""
        collected_tool_calls: List[Dict] = []

        # Force first tool call (must call list_dataset_tables or search_charts first)
        force_tool = "required" if tool_calls_made == 0 else "auto"

        try:
            response = await asyncio.wait_for(
                client.chat.completions.create(
                    model=execution_model,
                    messages=exec_messages,
                    tools=active_tools,
                    tool_choice=force_tool,
                    stream=True,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    stream_options={"include_usage": True},
                ),
                timeout=LLM_TIMEOUT,
            )
        except Exception as exc:
            logger.warning("insight_loop execution call failed: %s", exc)
            break

        async for chunk in response:
            if hasattr(chunk, "usage") and chunk.usage is not None:
                metrics_ctx["input_tokens"] = (metrics_ctx["input_tokens"] or 0) + (chunk.usage.prompt_tokens or 0)
                metrics_ctx["output_tokens"] = (metrics_ctx["output_tokens"] or 0) + (chunk.usage.completion_tokens or 0)

            delta = chunk.choices[0].delta if chunk.choices else None
            if delta is None:
                continue

            if delta.content:
                collected_content += delta.content
                yield TextEvent(content=delta.content).model_dump()

            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    idx = tc_delta.index
                    if idx >= len(collected_tool_calls):
                        collected_tool_calls.append({"id": "", "function": {"name": "", "arguments": ""}})
                    if tc_delta.id:
                        collected_tool_calls[idx]["id"] = tc_delta.id
                    if tc_delta.function:
                        if tc_delta.function.name:
                            collected_tool_calls[idx]["function"]["name"] += tc_delta.function.name
                        if tc_delta.function.arguments:
                            collected_tool_calls[idx]["function"]["arguments"] += tc_delta.function.arguments

        if collected_content and not collected_tool_calls:
            session.messages.append(Message(role="assistant", content=collected_content))
            async for chart_event in _emit_chart_events(collected_content, chart_data_cache):
                yield chart_event

        if not collected_tool_calls:
            break

        # Append assistant message with tool calls
        tc_records = [
            {"id": tc["id"], "type": "function", "function": {"name": tc["function"]["name"], "arguments": tc["function"]["arguments"]}}
            for tc in collected_tool_calls
        ]
        session.messages.append(Message(role="assistant", content=collected_content or None, tool_calls=tc_records))

        # Execute tools
        for tc in collected_tool_calls:
            fn_name = tc["function"]["name"]
            try:
                fn_args = json.loads(tc["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                fn_args = {}

            yield ToolCallEvent(tool=fn_name, args=fn_args).model_dump()

            try:
                tool_result = await _execute_tool_rbac(
                    fn_name, fn_args,
                    session.context.get("user_role", "viewer"),
                    token=token, scope=session.context,
                )
            except Exception as tool_exc:
                tool_result = {"error": f"Tool '{fn_name}' failed: {str(tool_exc)[:300]}"}
                metrics_ctx["tool_errors"] += 1

            tool_calls_made += 1
            _track_active_resource(session, fn_name, tool_result)

            metrics_ctx["tool_calls"].append(fn_name)
            metrics_ctx["has_data_backing"] = True
            if "error" in tool_result:
                metrics_ctx["tool_errors"] += 1
            for key in ("rows", "data"):
                val = tool_result.get(key)
                if isinstance(val, list):
                    metrics_ctx["data_rows_analyzed"] += len(val)
                    break
            if fn_name == "explore_data":
                cols = tool_result.get("columns") or tool_result.get("distributions") or {}
                metrics_ctx["data_rows_analyzed"] += len(cols) if isinstance(cols, (dict, list)) else 0

            if fn_name == "search_charts":
                async for ev in _emit_auto_chart(tool_result, chart_data_cache):
                    metrics_ctx["has_chart"] = True
                    yield ev

            if fn_name == "run_chart" and "chart_id" in tool_result:
                chart_data_cache[tool_result["chart_id"]] = tool_result
                metrics_ctx["has_chart"] = True
                yield ChartEvent(
                    chart_id=tool_result["chart_id"],
                    chart_name=tool_result.get("chart_name", ""),
                    chart_type=tool_result.get("chart_type", ""),
                    data=tool_result.get("rows", []),
                    role_config=tool_result.get("role_config"),
                ).model_dump()

            yield ToolResultEvent(tool=fn_name, summary=_tool_summary(fn_name, tool_result)).model_dump()

            stored = _truncate_tool_result(tool_result)
            session.messages.append(Message(
                role="tool", content=json.dumps(stored, ensure_ascii=False, default=str),
                tool_call_id=tc["id"], name=fn_name,
            ))

        if tool_calls_made >= tool_call_limit:
            session.messages.append(Message(
                role="user",
                content="[System: max tool calls reached. Synthesize findings into your final answer now.]",
            ))
            break


# ── Gemini insight loop (2-phase: plan → execute) ─────────────────────────────

async def _gemini_insight_loop(
    planning_model_name: str,
    execution_model_name: str,
    session: ConversationSession,
    chart_data_cache: Dict[int, Dict],
    metrics_ctx: Dict[str, Any],
    token: str = "",
    turn_context: str = "",
    agent_config=None,
) -> AsyncGenerator[Dict, None]:
    """
    Two-phase INSIGHT loop for Gemini provider (uses google-genai new SDK).

    Phase A — Planning (no tools, temp=0.5, max=400):
      Uses gemini-2.5-flash to produce a JSON investigation plan.

    Phase B — Execution (tools, full agent_config settings):
      Uses the same gemini-2.5-flash model with per-turn context injected.
      Plan is prepended to the system instruction.
    """

    from app.prompts import INSIGHT_PLANNING_PROMPT

    LLM_TIMEOUT = 45

    max_tokens = agent_config.max_tokens if agent_config else 2500
    tool_call_limit = agent_config.tool_call_limit if agent_config else 12
    execution_prompt = agent_config.system_prompt if agent_config else _get_base_prompt()
    temperature = agent_config.temperature if agent_config else 0.5
    max_history = agent_config.max_history if agent_config else 50

    # ── Phase A: Planning ─────────────────────────────────────────────────────
    yield ThinkingEvent(content="Đang lên kế hoạch phân tích...").model_dump()

    plan_json: str = ""
    try:
        import google.genai.types as gtypes
        plan_client = _make_gemini_client()
        plan_user_msg = session.messages[-1].content if session.messages else ""
        if turn_context:
            plan_user_msg = f"{turn_context}\n\n---\n\n{plan_user_msg}"

        plan_resp = await asyncio.wait_for(
            plan_client.aio.models.generate_content(
                model=planning_model_name,
                contents=plan_user_msg,
                config=gtypes.GenerateContentConfig(
                    system_instruction=INSIGHT_PLANNING_PROMPT,
                    temperature=0.5,
                    max_output_tokens=400,
                ),
            ),
            timeout=30,
        )
        plan_json = (plan_resp.text or "").strip()

        # Track planning tokens
        if hasattr(plan_resp, "usage_metadata") and plan_resp.usage_metadata:
            metrics_ctx["input_tokens"] = (metrics_ctx["input_tokens"] or 0) + (plan_resp.usage_metadata.prompt_token_count or 0)
            metrics_ctx["output_tokens"] = (metrics_ctx["output_tokens"] or 0) + (plan_resp.usage_metadata.candidates_token_count or 0)

        try:
            import json as _json
            _plan = _json.loads(plan_json)
            plan_summary = f"[{_plan.get('question_type','?')}] {len(_plan.get('query_sequence',[]))} queries planned"
            yield ThinkingEvent(content=f"Kế hoạch: {plan_summary}").model_dump()
            logger.debug("gemini_insight_plan: %s", plan_summary)
        except Exception:
            pass

    except Exception as plan_exc:
        logger.warning("gemini_insight_loop: planning phase failed (%s) — proceeding without plan", plan_exc)
        plan_json = ""

    # ── Phase B: Execution with plan injected ─────────────────────────────────
    yield ThinkingEvent(content="Đang thực hiện phân tích...").model_dump()

    exec_system = execution_prompt
    if plan_json:
        exec_system += (
            "\n\n## INVESTIGATION PLAN (follow this sequence)\n"
            + plan_json
            + "\n\nExecute each step in query_sequence before writing the final answer. "
            "Do NOT answer after fewer than 3 tool calls unless data is definitively complete."
        )

    # Build execution config (3-tuple) with plan-enriched system instruction via new SDK
    exec_model_config = _make_gemini_config(execution_model_name, agent_config=agent_config, system_prompt_override=exec_system)

    # Delegate to standard _gemini_loop with the enriched config
    async for event in _gemini_loop(
        exec_model_config, session, 0, chart_data_cache, metrics_ctx,
        token=token, turn_context=turn_context, agent_config=agent_config,
    ):
        yield event


# ── Gemini loop ────────────────────────────────────────────────────────────────

async def _gemini_loop(
    model_config,   # (model_name, GenerateContentConfig) tuple from _make_gemini_config
    session: ConversationSession,
    tool_calls_made: int,
    chart_data_cache: Dict[int, Dict],
    metrics_ctx: Dict[str, Any],
    token: str = "",
    turn_context: str = "",
    agent_config=None,
) -> AsyncGenerator[Dict, None]:
    """Tool-calling loop using the google-genai (new) SDK.

    Uses stateless client.aio.models.generate_content() — no chat session object.
    Conversation history is rebuilt each iteration as a Contents list.
    """
    try:
        import google.genai.types as gtypes
    except ImportError:
        raise RuntimeError("google-genai package not installed. Run: pip install google-genai")

    # Accept (model_name, config_force, config_auto) tuple from _make_gemini_config
    if isinstance(model_config, tuple) and len(model_config) == 3:
        model_name, config_force, config_auto = model_config
    elif isinstance(model_config, tuple) and len(model_config) == 2:
        # Legacy 2-tuple: use same config for both
        model_name, config_force = model_config
        config_auto = config_force
    else:
        model_name, config_force, config_auto = _make_gemini_config(
            getattr(model_config, "model_name", settings.active_model), agent_config
        )

    gemini_client = _make_gemini_client()

    tool_call_limit = agent_config.tool_call_limit if agent_config else settings.ai_max_tool_calls
    LLM_TIMEOUT = 45

    # Build simplified text-only history from prior session messages.
    # Tool call/response pairs from previous turns are not replayed — only
    # the final assistant text answers are included, which is sufficient for
    # conversational continuity and avoids proto-interleaving complexity.
    all_msgs = list(_trim_history(session.messages))
    history_msgs = all_msgs[:-1]
    current_user_text = all_msgs[-1].content if all_msgs else ""
    if turn_context:
        current_user_text = f"{turn_context}\n\n---\n\n{current_user_text}"

    # Gemini Contents list: starts with prior text turns, grows with tool rounds
    contents: List[Any] = []
    for m in history_msgs:
        if m.role == "user" and m.content and not m.content.startswith("[System:"):
            contents.append(gtypes.Content(role="user", parts=[gtypes.Part(text=m.content)]))
        elif m.role == "assistant" and m.content and not m.tool_calls:
            contents.append(gtypes.Content(role="model", parts=[gtypes.Part(text=m.content)]))
        # skip tool messages — they are replayed within the current turn below

    # Append current user message
    contents.append(gtypes.Content(role="user", parts=[gtypes.Part(text=current_user_text)]))

    while tool_calls_made <= tool_call_limit:
        # First call: force a tool call (ANY). Subsequent calls: let model decide (AUTO).
        active_config = config_force if tool_calls_made == 0 else config_auto
        response = await asyncio.wait_for(
            gemini_client.aio.models.generate_content(
                model=model_name,
                contents=contents,
                config=active_config,
            ),
            timeout=LLM_TIMEOUT,
        )

        # Track token usage
        if hasattr(response, "usage_metadata") and response.usage_metadata:
            um = response.usage_metadata
            metrics_ctx["input_tokens"] = (metrics_ctx["input_tokens"] or 0) + (um.prompt_token_count or 0)
            metrics_ctx["output_tokens"] = (metrics_ctx["output_tokens"] or 0) + (um.candidates_token_count or 0)

        text_content = ""
        function_calls_found = []

        candidate = response.candidates[0] if response.candidates else None
        if candidate:
            for part in (candidate.content.parts or []):
                if getattr(part, "text", None):
                    text_content += part.text
                fc = getattr(part, "function_call", None)
                if fc and getattr(fc, "name", None):
                    function_calls_found.append(fc)

        if text_content:
            for word in text_content.split():
                yield TextEvent(content=word + " ").model_dump()

        if not function_calls_found:
            if text_content:
                session.messages.append(Message(role="assistant", content=text_content))
            async for chart_event in _emit_chart_events(text_content, chart_data_cache):
                yield chart_event
            break

        # Append assistant model turn (with function_calls) to contents
        model_parts = []
        if text_content:
            model_parts.append(gtypes.Part(text=text_content))
        for fc in function_calls_found:
            model_parts.append(gtypes.Part(function_call=fc))
        contents.append(gtypes.Content(role="model", parts=model_parts))

        # Save assistant message to session history for OpenAI-style history consistency
        tc_records = [
            {"id": fc.name, "type": "function", "function": {"name": fc.name, "arguments": json.dumps(dict(fc.args) if fc.args else {})}}
            for fc in function_calls_found
        ]
        session.messages.append(Message(
            role="assistant",
            content=text_content or None,
            tool_calls=tc_records,
        ))

        # Execute all tool calls and collect FunctionResponse parts
        response_parts = []
        for fc in function_calls_found:
            fn_name = fc.name
            fn_args = dict(fc.args) if fc.args else {}

            yield ToolCallEvent(tool=fn_name, args=fn_args).model_dump()

            try:
                tool_result = await _execute_tool_rbac(
                    fn_name, fn_args,
                    session.context.get("user_role", "viewer"),
                    token=token,
                    scope=session.context,
                )
            except Exception as tool_exc:
                logger.warning("Tool %s raised exception: %s", fn_name, tool_exc)
                tool_result = {"error": f"Tool '{fn_name}' failed: {str(tool_exc)[:300]}"}

            tool_calls_made += 1
            _track_active_resource(session, fn_name, tool_result)

            metrics_ctx["tool_calls"].append(fn_name)
            metrics_ctx["has_data_backing"] = True
            if "error" in tool_result:
                metrics_ctx["tool_errors"] += 1
            for key in ("rows", "data"):
                rows = tool_result.get(key)
                if isinstance(rows, list):
                    metrics_ctx["data_rows_analyzed"] += len(rows)
                    break
            top_data = tool_result.get("top_chart_data")
            if isinstance(top_data, dict):
                td_rows = top_data.get("rows")
                if isinstance(td_rows, list):
                    metrics_ctx["data_rows_analyzed"] += len(td_rows)

            if fn_name == "search_charts":
                async for ev in _emit_auto_chart(tool_result, chart_data_cache):
                    metrics_ctx["has_chart"] = True
                    yield ev

            if fn_name == "run_chart" and "chart_id" in tool_result:
                chart_data_cache[tool_result["chart_id"]] = tool_result
                metrics_ctx["has_chart"] = True
                yield ChartEvent(
                    chart_id=tool_result["chart_id"],
                    chart_name=tool_result.get("chart_name", ""),
                    chart_type=tool_result.get("chart_type", ""),
                    data=tool_result.get("rows", []),
                    role_config=tool_result.get("role_config"),
                ).model_dump()

            summary = _tool_summary(fn_name, tool_result)
            yield ToolResultEvent(tool=fn_name, summary=summary).model_dump()

            stored = _truncate_tool_result(tool_result)
            result_str = json.dumps(stored, ensure_ascii=False, default=str)
            session.messages.append(Message(
                role="tool",
                content=result_str,
                tool_call_id=fn_name,
                name=fn_name,
            ))

            response_parts.append(gtypes.Part(
                function_response=gtypes.FunctionResponse(
                    name=fn_name,
                    response={"result": result_str},
                )
            ))

        if tool_calls_made >= tool_call_limit:
            # Force final answer: send all function responses then ask to conclude
            contents.append(gtypes.Content(role="user", parts=response_parts))
            try:
                final_resp = await asyncio.wait_for(
                    gemini_client.aio.models.generate_content(
                        model=model_name,
                        contents=contents + [gtypes.Content(role="user", parts=[gtypes.Part(
                            text="You have reached the tool call limit. Please provide your final analysis based on the data collected so far."
                        )])],
                        config=gen_config,
                    ),
                    timeout=LLM_TIMEOUT,
                )
                final_text = final_resp.text or ""
                if final_text:
                    for word in final_text.split():
                        yield TextEvent(content=word + " ").model_dump()
                    session.messages.append(Message(role="assistant", content=final_text))
                    async for ev in _emit_chart_events(final_text, chart_data_cache):
                        yield ev
            except Exception:
                pass
            break

        # Append function responses to contents for next iteration
        contents.append(gtypes.Content(role="user", parts=response_parts))

# ── Helpers ────────────────────────────────────────────────────────────────────

async def _emit_auto_chart(
    search_result: Dict, chart_data_cache: Dict[int, Dict]
):
    """Emit a ChartEvent for the auto-executed top chart returned by search_charts.

    This ensures a chart renders immediately even when the LLM forgets to call
    run_chart after search_charts.
    """
    auto = search_result.get("auto_chart")
    if not auto:
        return
    chart_id = auto.get("chart_id")
    if not chart_id:
        return
    chart_data_cache[chart_id] = auto
    yield ChartEvent(
        chart_id=chart_id,
        chart_name=auto.get("chart_name", ""),
        chart_type=auto.get("chart_type", ""),
        data=auto.get("rows", []),
        role_config=auto.get("role_config"),
    ).model_dump()


def _tool_summary(tool_name: str, result: Dict) -> str:
    """Build a short human-readable summary of a tool result."""
    if tool_name == "search_charts":
        return f"Found {result.get('count', 0)} chart(s)"
    elif tool_name == "run_chart":
        return f"Chart '{result.get('chart_name', '')}': {result.get('row_count', 0)} rows"
    elif tool_name == "execute_sql":
        return f"{result.get('row_count', 0)} rows ({result.get('execution_time_ms', 0):.0f}ms)"
    elif tool_name == "search_dashboards":
        return f"Found {result.get('count', 0)} dashboard(s)"
    elif tool_name == "inspect_dashboard":
        return (
            f"Dashboard '{result.get('dashboard_name', '')}': "
            f"{result.get('chart_count', 0)} charts"
        )
    elif tool_name == "list_dataset_tables":
        ws_count = len(result.get("datasets", []))
        table_count = sum(len(ws["tables"]) for ws in result.get("datasets", []))
        return f"{ws_count} dataset(s), {table_count} table(s)"
    elif tool_name == "query_table":
        return f"{result.get('row_count', 0)} rows (aggregated)"
    elif tool_name == "run_dataset_table":
        return f"{result.get('row_count', 0)} rows loaded"
    elif tool_name == "create_chart":
        saved = "(saved)" if result.get("saved") else "(preview)"
        return f"Chart '{result.get('chart_name', '')}' {saved} — {result.get('row_count', 0)} rows"
    elif tool_name == "explore_data":
        atype = result.get("analysis_type", "")
        return f"Data profile ({atype}): {len(result.get('columns', result.get('distributions', {})))} columns analyzed"
    elif tool_name == "explain_insight":
        ch = result.get("periods", {}).get("change_pct", "?")
        return f"Metric change: {ch}% | {len(result.get('drill_downs', []))} dimensions analyzed"
    elif tool_name == "create_dashboard":
        return f"Dashboard '{result.get('dashboard_name', '')}' created with {result.get('chart_count', 0)} charts"
    return "Done"


async def _emit_chart_events(text: str, chart_data_cache: Dict[int, Dict]):
    """
    Find [CHART:id] markers in text and emit ChartEvent for each.
    """
    import re
    for match in re.finditer(r"\[CHART:(\d+)\]", text):
        chart_id = int(match.group(1))
        if chart_id in chart_data_cache:
            cached = chart_data_cache[chart_id]
            yield ChartEvent(
                chart_id=chart_id,
                chart_name=cached.get("chart_name", ""),
                chart_type=cached.get("chart_type", ""),
                data=cached.get("rows", []),
                role_config=cached.get("role_config"),
            ).model_dump()
        else:
            # Fetch on demand
            try:
                from app.clients.bi_client import bi_client
                result = await bi_client.get_chart_data(chart_id)
                chart_meta = result.get("chart", {})
                data = result.get("data", [])
                config = chart_meta.get("config", {}) or {}
                role_config = config.get("roleConfig")
                yield ChartEvent(
                    chart_id=chart_id,
                    chart_name=chart_meta.get("name", ""),
                    chart_type=chart_meta.get("chart_type", ""),
                    data=data,
                    role_config=role_config,
                ).model_dump()
            except Exception:
                pass


async def _generate_suggestions(provider: str, model: str, session: ConversationSession) -> List[str]:
    """
    Generate 2-3 follow-up question suggestions using a lightweight LLM call.
    Returns empty list on any error to avoid blocking the response.
    """
    # Collect last assistant response
    last_response = ""
    for m in reversed(session.messages):
        if m.role == "assistant" and isinstance(m.content, str) and m.content.strip():
            last_response = m.content[:600]
            break
    if not last_response:
        return []

    # Collect recent user messages for context
    user_msgs = [m.content for m in session.messages if m.role == "user"]
    last_user_msg = user_msgs[-1][:200] if user_msgs else ""

    suggest_prompt = (
        f"Người dùng hỏi: {last_user_msg}\n"
        f"Trợ lý trả lời: {last_response[:400]}\n\n"
        "Tạo đúng 3 câu hỏi tiếp theo mà người dùng có thể hỏi, bằng TIẾNG VIỆT. "
        "Câu hỏi phải liên quan đến dữ liệu, ngắn gọn (dưới 12 từ). "
        "Trả lời DƯỚI DẠNG JSON array gồm 3 chuỗi, không có markdown:\n"
        '["câu hỏi 1", "câu hỏi 2", "câu hỏi 3"]'
    )

    try:
        if provider in ("openai", "openrouter"):
            _suggestion_model = settings.suggestion_model
            if provider == "openai":
                client = _make_openai_client()
            else:
                keys = settings.active_api_keys
                client = _make_openrouter_client(api_key=keys[0] if keys else "")
            resp = await client.chat.completions.create(
                model=_suggestion_model,
                messages=[{"role": "user", "content": suggest_prompt}],
                temperature=0.7,
                max_tokens=150,
                stream=False,
            )
            raw = resp.choices[0].message.content or ""
        elif provider == "anthropic":
            client = _make_anthropic_client()
            resp = await client.messages.create(
                model=model,
                messages=[{"role": "user", "content": suggest_prompt}],
                max_tokens=150,
            )
            raw = resp.content[0].text if resp.content else ""
        elif provider == "gemini":
            import google.generativeai as genai
            genai.configure(api_key=settings.gemini_api_key)
            _sugg_model = settings.suggestion_model
            m = genai.GenerativeModel(_sugg_model, generation_config={"temperature": 0.7, "max_output_tokens": 150})
            r = await m.generate_content_async(suggest_prompt)
            raw = r.text if r.text else ""
        else:
            return []

        # Parse JSON array
        import re
        raw = raw.strip()
        arr_match = re.search(r'\[.*\]', raw, re.DOTALL)
        if arr_match:
            suggestions = json.loads(arr_match.group(0))
            if isinstance(suggestions, list):
                return [str(s) for s in suggestions[:3] if s]
    except Exception:
        pass
    return []


# ── Session cleanup ────────────────────────────────────────────────────────────

def cleanup_expired_sessions():
    import datetime
    ttl = settings.ai_session_ttl_minutes
    now = datetime.datetime.utcnow()
    expired = [
        sid for sid, s in _sessions.items()
        if (now - s.last_active).total_seconds() > ttl * 60
    ]
    for sid in expired:
        del _sessions[sid]
    return len(expired)
