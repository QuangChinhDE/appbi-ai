"""
LLM Orchestrator — drives the tool-calling conversation loop.

Supports OpenAI and Anthropic through a unified interface.
Falls back through LLM_FALLBACK_CHAIN when a provider/model fails.
Streams events via an async generator.
"""
import json
import logging
import uuid
from typing import Any, AsyncGenerator, Dict, List, Optional

from app.config import settings
from app.schemas.chat import (
    ChartEvent,
    ConversationSession,
    DoneEvent,
    ErrorEvent,
    Message,
    TextEvent,
    ThinkingEvent,
    ToolCallEvent,
    ToolResultEvent,
)
from app.agents.tools import TOOL_SCHEMAS, execute_tool

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are an AI data analyst assistant for AppBI, a Business Intelligence platform.
The system contains charts, workspace tables, and dashboards built from real business data.

When the user asks a data question:
1. Use search_charts to find relevant charts (search by keywords from the user question)
2. Use run_chart to execute charts and get actual data
3. Analyze the data and answer with specific numbers and facts
4. Always include the chart_id in your final analysis so the frontend can display it visually

Guidelines:
- Respond in the SAME LANGUAGE as the user (Vietnamese if they write in Vietnamese, English if English)
- Always cite specific numbers from the data (e.g., "Argentina has 1947 points")
- If no chart matches, try list_workspace_tables then run_workspace_table
- After getting data, provide a clear insightful analysis — not just a list
- Keep tool calls efficient: prefer run_chart over run_workspace_table when a chart exists

Format for embedding a chart in your response: [CHART:chart_id]
Example: The top performers are shown below. [CHART:5]
"""


def _make_openai_client():
    try:
        from openai import AsyncOpenAI
        return AsyncOpenAI(api_key=settings.openai_api_key)
    except ImportError:
        raise RuntimeError("openai package not installed")


def _make_anthropic_client():
    try:
        from anthropic import AsyncAnthropic
        return AsyncAnthropic(api_key=settings.anthropic_api_key)
    except ImportError:
        raise RuntimeError("anthropic package not installed")


def _build_provider_chain() -> List[Dict[str, str]]:
    """Build ordered list of {provider, model} to try, primary first."""
    chain = [{"provider": settings.llm_provider, "model": settings.llm_model}]
    for entry in settings.fallback_chain:
        # avoid duplicate
        if entry not in chain:
            chain.append(entry)
    return chain


async def _call_openai(
    client,
    model: str,
    messages: List[Dict],
    tools: List[Dict],
    stream: bool = True,
) -> AsyncGenerator:
    """Yield raw OpenAI streaming chunks."""
    response = await client.chat.completions.create(
        model=model,
        messages=messages,
        tools=tools,
        tool_choice="auto",
        stream=stream,
        temperature=0.2,
        max_tokens=2048,
    )
    if stream:
        async for chunk in response:
            yield chunk
    else:
        yield response


async def _call_anthropic(
    client,
    model: str,
    messages: List[Dict],
    stream: bool = True,
) -> AsyncGenerator:
    """Yield raw Anthropic streaming events (tool_use via streaming)."""
    # Convert OpenAI tool schemas → Anthropic format
    anthropic_tools = []
    for t in TOOL_SCHEMAS:
        fn = t["function"]
        anthropic_tools.append({
            "name": fn["name"],
            "description": fn["description"],
            "input_schema": fn["parameters"],
        })

    # Separate system prompt from messages
    system = SYSTEM_PROMPT
    anthropic_messages = []
    for m in messages:
        if m["role"] == "system":
            system = m["content"]
        elif m["role"] == "tool":
            anthropic_messages.append({
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": m.get("tool_call_id", ""), "content": m["content"]}],
            })
        else:
            anthropic_messages.append({"role": m["role"], "content": m["content"]})

    response = await client.messages.create(
        model=model,
        max_tokens=2048,
        system=system,
        messages=anthropic_messages,
        tools=anthropic_tools,
        stream=stream,
    )
    if stream:
        async with response as stream_mgr:
            async for event in stream_mgr:
                yield event
    else:
        yield response


# ─────────────────────────────────────────────────────────────────────────────
# In-memory session store
# ─────────────────────────────────────────────────────────────────────────────

_sessions: Dict[str, ConversationSession] = {}


def get_or_create_session(session_id: Optional[str], context: Dict) -> ConversationSession:
    import datetime
    if session_id and session_id in _sessions:
        s = _sessions[session_id]
        s.last_active = datetime.datetime.utcnow()
        return s
    new_id = session_id or str(uuid.uuid4())
    session = ConversationSession(
        session_id=new_id,
        messages=[],
        context=context or {},
    )
    _sessions[new_id] = session
    return session


def _trim_history(messages: List[Message], max_messages: int = 20) -> List[Message]:
    """Keep last N messages to stay within context window."""
    if len(messages) <= max_messages:
        return messages
    return messages[-max_messages:]


def _to_llm_messages(session: ConversationSession) -> List[Dict]:
    """Convert session messages to OpenAI API format."""
    result = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in _trim_history(session.messages):
        msg: Dict[str, Any] = {"role": m.role, "content": m.content}
        if m.tool_call_id:
            msg["tool_call_id"] = m.tool_call_id
        if m.name:
            msg["name"] = m.name
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
    """
    # Append user message
    session.messages.append(Message(role="user", content=user_message))

    provider_chain = _build_provider_chain()
    tool_calls_made = 0
    
    # Track chart data collected during this turn so we can embed charts
    chart_data_cache: Dict[int, Dict] = {}

    for attempt, provider_info in enumerate(provider_chain):
        provider = provider_info["provider"]
        model = provider_info["model"]
        try:
            async for event in _run_with_provider(
                provider=provider,
                model=model,
                session=session,
                tool_calls_made=tool_calls_made,
                chart_data_cache=chart_data_cache,
            ):
                yield event
            # If we reach here without exception, we're done
            return
        except Exception as e:
            logger.warning(f"Provider {provider}:{model} failed (attempt {attempt+1}): {e}")
            if attempt < len(provider_chain) - 1:
                yield ThinkingEvent(content=f"Switching to fallback model...").model_dump()
                continue
            else:
                yield ErrorEvent(content=f"All LLM providers failed. Last error: {str(e)}").model_dump()
                return


async def _run_with_provider(
    provider: str,
    model: str,
    session: ConversationSession,
    tool_calls_made: int,
    chart_data_cache: Dict[int, Dict],
) -> AsyncGenerator[Dict, None]:
    """Run the tool-calling loop for a single provider."""

    if provider == "openai":
        client = _make_openai_client()
        yield ThinkingEvent(content="Đang phân tích câu hỏi...").model_dump()
        async for event in _openai_loop(client, model, session, tool_calls_made, chart_data_cache):
            yield event
    elif provider == "anthropic":
        client = _make_anthropic_client()
        yield ThinkingEvent(content="Đang phân tích câu hỏi...").model_dump()
        async for event in _anthropic_loop(client, model, session, tool_calls_made, chart_data_cache):
            yield event
    else:
        raise ValueError(f"Unknown provider: {provider}")


# ── OpenAI loop ────────────────────────────────────────────────────────────────

async def _openai_loop(
    client,
    model: str,
    session: ConversationSession,
    tool_calls_made: int,
    chart_data_cache: Dict[int, Dict],
) -> AsyncGenerator[Dict, None]:
    from openai import AsyncOpenAI

    while tool_calls_made <= settings.ai_max_tool_calls:
        llm_messages = _to_llm_messages(session)

        # Accumulate streamed response
        collected_content = ""
        collected_tool_calls: List[Dict] = []

        response = await client.chat.completions.create(
            model=model,
            messages=llm_messages,
            tools=TOOL_SCHEMAS,
            tool_choice="auto",
            stream=True,
            temperature=0.2,
            max_tokens=2048,
        )

        # current tool_call being streamed
        current_tc: Dict[str, Any] = {}

        async for chunk in response:
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
        if collected_content:
            # Append assistant message to session
            session.messages.append(Message(role="assistant", content=collected_content))
            # Process [CHART:id] markers in the final text
            async for chart_event in _emit_chart_events(collected_content, chart_data_cache):
                yield chart_event

        if not collected_tool_calls:
            # No tool calls → done
            break

        # Append assistant message with tool calls
        session.messages.append(Message(
            role="assistant",
            content=None,
        ))

        # Execute each tool call
        for tc in collected_tool_calls:
            fn_name = tc["function"]["name"]
            try:
                fn_args = json.loads(tc["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                fn_args = {}

            yield ToolCallEvent(tool=fn_name, args=fn_args).model_dump()

            tool_result = await execute_tool(fn_name, fn_args)
            tool_calls_made += 1

            # Cache chart data for embedding
            if fn_name == "run_chart" and "chart_id" in tool_result:
                chart_data_cache[tool_result["chart_id"]] = tool_result

            # Build summary for stream event
            summary = _tool_summary(fn_name, tool_result)
            yield ToolResultEvent(tool=fn_name, summary=summary).model_dump()

            # Append tool result to session
            result_str = json.dumps(tool_result, ensure_ascii=False, default=str)
            session.messages.append(Message(
                role="tool",
                content=result_str,
                tool_call_id=tc["id"],
                name=fn_name,
            ))

        if tool_calls_made >= settings.ai_max_tool_calls:
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
) -> AsyncGenerator[Dict, None]:

    # Convert schemas for Anthropic
    anthropic_tools = [
        {
            "name": t["function"]["name"],
            "description": t["function"]["description"],
            "input_schema": t["function"]["parameters"],
        }
        for t in TOOL_SCHEMAS
    ]

    while tool_calls_made <= settings.ai_max_tool_calls:
        # Build Anthropic message list
        anthropic_messages = []
        for m in _trim_history(session.messages):
            if m.role == "user":
                anthropic_messages.append({"role": "user", "content": m.content})
            elif m.role == "assistant":
                anthropic_messages.append({"role": "assistant", "content": m.content or ""})
            elif m.role == "tool":
                anthropic_messages.append({
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": m.tool_call_id or "", "content": m.content}],
                })

        # Non-streaming call for Anthropic (simpler for tool-call handling)
        response = await client.messages.create(
            model=model,
            max_tokens=2048,
            system=SYSTEM_PROMPT,
            messages=anthropic_messages,
            tools=anthropic_tools,
            temperature=0.2,
        )

        text_content = ""
        tool_uses = []

        for block in response.content:
            if block.type == "text":
                text_content += block.text
                # Stream text word by word for UX
                for word in block.text.split():
                    yield TextEvent(content=word + " ").model_dump()
            elif block.type == "tool_use":
                tool_uses.append(block)

        if text_content:
            session.messages.append(Message(role="assistant", content=text_content))
            async for chart_event in _emit_chart_events(text_content, chart_data_cache):
                yield chart_event

        if not tool_uses or response.stop_reason == "end_turn":
            break

        # Append assistant message with tool uses
        session.messages.append(Message(role="assistant", content=text_content or "[tool calls]"))

        # Execute each tool use
        for tu in tool_uses:
            fn_name = tu.name
            fn_args = tu.input or {}

            yield ToolCallEvent(tool=fn_name, args=fn_args).model_dump()

            tool_result = await execute_tool(fn_name, fn_args)
            tool_calls_made += 1

            if fn_name == "run_chart" and "chart_id" in tool_result:
                chart_data_cache[tool_result["chart_id"]] = tool_result

            summary = _tool_summary(fn_name, tool_result)
            yield ToolResultEvent(tool=fn_name, summary=summary).model_dump()

            result_str = json.dumps(tool_result, ensure_ascii=False, default=str)
            session.messages.append(Message(
                role="tool",
                content=result_str,
                tool_call_id=tu.id,
                name=fn_name,
            ))

        if tool_calls_made >= settings.ai_max_tool_calls:
            break


# ── Helpers ────────────────────────────────────────────────────────────────────

def _tool_summary(tool_name: str, result: Dict) -> str:
    """Build a short human-readable summary of a tool result."""
    if tool_name == "search_charts":
        return f"Found {result.get('count', 0)} chart(s)"
    elif tool_name == "run_chart":
        return f"Chart '{result.get('chart_name', '')}': {result.get('row_count', 0)} rows"
    elif tool_name == "search_dashboards":
        return f"Found {result.get('count', 0)} dashboard(s)"
    elif tool_name == "list_workspace_tables":
        ws_count = len(result.get("workspaces", []))
        table_count = sum(len(ws["tables"]) for ws in result.get("workspaces", []))
        return f"{ws_count} workspace(s), {table_count} table(s)"
    elif tool_name == "run_workspace_table":
        return f"{result.get('row_count', 0)} rows loaded"
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
