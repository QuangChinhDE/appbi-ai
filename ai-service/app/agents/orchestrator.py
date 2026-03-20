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
    TextEvent,
    ThinkingEvent,
    ToolCallEvent,
    ToolResultEvent,
)
from app.agents.tools import TOOL_SCHEMAS, execute_tool

logger = logging.getLogger(__name__)

_VIEWER_BLOCKED_TOOLS = {"execute_sql"}


async def _execute_tool_rbac(fn_name: str, fn_args: dict, user_role: str) -> dict:
    """Wrap execute_tool with role-based access control.

    Viewers may not call execute_sql directly — they can only consume
    pre-built charts / query_table results on resources shared with them.
    """
    if user_role == "viewer" and fn_name in _VIEWER_BLOCKED_TOOLS:
        return {"error": f"Permission denied: viewers cannot call '{fn_name}'."}
    return await execute_tool(fn_name, fn_args)

SYSTEM_PROMPT = """You are a BI data analyst inside AppBI. Your job: answer data questions using real numbers from tools. Be direct, precise, never waste words.

━━━ WHAT EACH TOOL RETURNS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

search_charts(query)
  → charts[]:       list of matching charts (id, name, type)
  → top_chart_data: { chart_id, chart_name, rows:[...], row_count }
                    ↑ THIS IS REAL DATA. Read rows[] to answer the question.
                    ↑ The chart is ALREADY rendered on the user's screen.

run_chart(chart_id)
  → rows:[...], row_count   ← real data rows. Chart auto-rendered on screen.

execute_sql(datasource_id, sql_query)
  → data:[...], columns, row_count   ← real data rows

query_table(workspace_id, table_id, dimensions, measures, ...)
  → rows:[...], row_count   ← pre-aggregated data

━━━ DECISION FLOW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Step 1 — Call search_charts(query).
  • top_chart_data.rows exists?
    YES → The chart is already displayed. READ top_chart_data.rows → go to Step 3.
         BUT if the user asks "most/highest/top/best" or "least/lowest/worst",
         the chart rows may be sorted by a DIFFERENT column (e.g. by year, not by value).
         In that case → also call execute_sql with ORDER BY to get correctly ranked data.
    NO  → go to Step 2.

Step 2 — No chart found. Query raw data.
  • Call execute_sql with a tight SELECT:
      SELECT <dim>, <agg>(<metric>) AS value
      FROM <table>
      GROUP BY <dim> ORDER BY value DESC LIMIT 15
  • Use exact table/column names from DATA SCHEMA below.
  • READ data[] rows → go to Step 3.

Step 3 — Write analysis using ONLY numbers from the rows you just read.
  ⚠ IMPORTANT: Chart rows may NOT be sorted by the metric the user asked about.
    For "most/highest/top" questions → scan ALL rows, find the actual MAX value.
    For "least/lowest/bottom" questions → scan ALL rows, find the actual MIN value.
    Do NOT assume the first or last row is the answer — VERIFY by comparing values.

━━━ RESPONSE FORMAT (always follow this structure) ━━━━━━━━━━

**[Direct answer — 1 sentence with the #1 result and its exact value]**

• [Row 1 label]: [exact value] — [short note]
• [Row 2 label]: [exact value] — [short note]
• [Row 3 label]: [exact value] — [short note]
(list top 3–7 items from data)

[Insight: 1–2 sentences on a pattern, gap, or contrast in the data]

━━━ ABSOLUTE RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✗ NEVER answer from memory — ALWAYS call a tool first (search_charts or execute_sql).
✗ NEVER ask "Do you want to see a chart?" — charts render automatically.
✗ NEVER say "I can show you..." or "Shall I display..." — just analyze.
✗ NEVER write [CHART:id] in text — the system handles chart display.
✗ NEVER fabricate numbers — every value MUST come from actual rows[].
✓ Always respond in the SAME LANGUAGE as the user.
✓ If a tool fails, say so and try execute_sql as fallback.
"""


def _make_openai_client():
    try:
        from openai import AsyncOpenAI
        return AsyncOpenAI(api_key=settings.openai_api_key)
    except ImportError:
        raise RuntimeError("openai package not installed")


def _make_openrouter_client():
    try:
        from openai import AsyncOpenAI
        return AsyncOpenAI(
            api_key=settings.openrouter_api_key,
            base_url="https://openrouter.ai/api/v1",
            default_headers={
                "HTTP-Referer": "http://localhost:3000",
                "X-Title": "AppBI AI Chat",
            },
        )
    except ImportError:
        raise RuntimeError("openai package not installed")


def _make_anthropic_client():
    try:
        from anthropic import AsyncAnthropic
        return AsyncAnthropic(api_key=settings.anthropic_api_key)
    except ImportError:
        raise RuntimeError("anthropic package not installed")


def _make_gemini_model(model_name: str):
    """Create a Gemini GenerativeModel with tool schemas configured."""
    try:
        import google.generativeai as genai
        from google.generativeai.types import FunctionDeclaration, Tool as GeminiTool
    except ImportError:
        raise RuntimeError("google-generativeai package not installed")

    genai.configure(api_key=settings.gemini_api_key)

    declarations = []
    for t in TOOL_SCHEMAS:
        fn = t["function"]
        declarations.append(FunctionDeclaration(
            name=fn["name"],
            description=fn["description"],
            parameters=fn["parameters"],
        ))
    gemini_tools = [GeminiTool(function_declarations=declarations)]

    return genai.GenerativeModel(
        model_name=model_name,
        tools=gemini_tools,
        system_instruction=SYSTEM_PROMPT,
        generation_config={"temperature": 0.2, "max_output_tokens": 2048},
    )


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
    """Convert session messages to OpenAI API format, injecting schema context."""
    # Merge schema context into system prompt (once loaded it stays in session)
    system = SYSTEM_PROMPT
    if session.db_context:
        system += "\n\n" + session.db_context
    result = [{"role": "system", "content": system}]
    for m in _trim_history(session.messages):
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
# Schema loader — builds DB context string injected into system prompt
# ─────────────────────────────────────────────────────────────────────────────

async def _load_db_context() -> str:
    """
    Fetch datasource info + tables + sample rows and build a schema reference
    string that is injected into every system prompt for the session.
    This eliminates the need for the AI to call list_workspace_tables.
    """
    from app.clients.bi_client import bi_client as _client
    lines = ["## DATA SCHEMA\n"]
    try:
        datasources = await _client.list_datasources()
        for ds in datasources:
            lines.append(f"Datasource: **{ds['name']}** (id={ds['id']}, type={ds['type']})")
            try:
                tables = await _client.list_datasource_tables(ds["id"])
                for tbl in tables:
                    tname = tbl["name"]
                    try:
                        result = await _client.execute_datasource_sql(
                            ds["id"], f'SELECT * FROM "{tname}" LIMIT 2', limit=2
                        )
                        cols = result.get("columns", [])
                        sample = result.get("data", [])
                        lines.append(f"\nTable: `{tname}`")
                        lines.append(f"  Columns: {', '.join(cols)}")
                        if sample:
                            # One compact sample row as key-value
                            row0 = {k: v for k, v in list(sample[0].items())[:6]}
                            lines.append(f"  Sample: {row0}")
                    except Exception:
                        lines.append(f"\nTable: `{tname}` (schema unavailable)")
            except Exception:
                lines.append("  (tables unavailable)")
    except Exception:
        return ""
    return "\n".join(lines)


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
    # Load DB schema once per session (injected into every system prompt)
    if not session.db_context:
        session.db_context = await _load_db_context()

    # Append user message
    session.messages.append(Message(role="user", content=user_message))

    # Auto-title: use the first user message (truncated)
    if session.title == "New Conversation":
        session.title = user_message[:60] + ("…" if len(user_message) > 60 else "")

    provider_chain = _build_provider_chain()

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

    for attempt, provider_info in enumerate(provider_chain):
        provider = provider_info["provider"]
        model = provider_info["model"]
        metrics_ctx["provider"] = provider
        metrics_ctx["model"] = model
        is_last = attempt == len(provider_chain) - 1
        try:
            async for event in _run_with_provider(
                provider=provider,
                model=model,
                session=session,
                tool_calls_made=0,
                chart_data_cache=chart_data_cache,
                metrics_ctx=metrics_ctx,
                message_id=message_id,
            ):
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
            )
            yield metrics_event.model_dump()

            # Store metrics on the last assistant message
            for m in reversed(session.messages):
                if m.role == "assistant" and m.content:
                    m.message_id = message_id
                    m.metrics = metrics_event.model_dump(exclude={"type"})
                    break

            return

        except asyncio.TimeoutError:
            logger.warning(
                f"Provider {provider}:{model} timed out "
                f"(attempt {attempt + 1}/{len(provider_chain)})"
            )
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
) -> AsyncGenerator[Dict, None]:
    """Run the tool-calling loop for a single provider."""

    if provider == "openai":
        client = _make_openai_client()
        yield ThinkingEvent(content="Đang phân tích câu hỏi...").model_dump()
        async for event in _openai_loop(client, model, session, tool_calls_made, chart_data_cache, metrics_ctx):
            yield event
    elif provider == "anthropic":
        client = _make_anthropic_client()
        yield ThinkingEvent(content="Đang phân tích câu hỏi...").model_dump()
        async for event in _anthropic_loop(client, model, session, tool_calls_made, chart_data_cache, metrics_ctx):
            yield event
    elif provider == "gemini":
        gemini_model = _make_gemini_model(model)
        yield ThinkingEvent(content="Đang phân tích câu hỏi...").model_dump()
        async for event in _gemini_loop(gemini_model, session, tool_calls_made, chart_data_cache, metrics_ctx):
            yield event
    elif provider == "openrouter":
        client = _make_openrouter_client()
        yield ThinkingEvent(content="Đang phân tích câu hỏi...").model_dump()
        async for event in _openai_loop(client, model, session, tool_calls_made, chart_data_cache, metrics_ctx):
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
    metrics_ctx: Dict[str, Any],
) -> AsyncGenerator[Dict, None]:
    from openai import AsyncOpenAI

    LLM_TIMEOUT = 45  # seconds per LLM call

    while tool_calls_made <= settings.ai_max_tool_calls:
        llm_messages = _to_llm_messages(session)

        # Accumulate streamed response
        collected_content = ""
        collected_tool_calls: List[Dict] = []

        # Force a tool call on the first turn so model doesn't answer from memory
        force_tool = "auto"
        if tool_calls_made == 0:
            force_tool = "required"

        response = await asyncio.wait_for(
            client.chat.completions.create(
                model=model,
                messages=llm_messages,
                tools=TOOL_SCHEMAS,
                tool_choice=force_tool,
                stream=True,
                temperature=0.2,
                max_tokens=2048,
            ),
            timeout=LLM_TIMEOUT,
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

            tool_result = await _execute_tool_rbac(fn_name, fn_args, session.context.get("user_role", "viewer"))
            tool_calls_made += 1

            # ── Metrics: track tool usage ──
            metrics_ctx["tool_calls"].append(fn_name)
            metrics_ctx["has_data_backing"] = True
            if "error" in tool_result:
                metrics_ctx["tool_errors"] += 1
            # Count data rows from tool results
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

            # Build summary for stream event
            summary = _tool_summary(fn_name, tool_result)
            yield ToolResultEvent(tool=fn_name, summary=summary).model_dump()

            # Append tool result to session (strip auto_chart from stored message to save tokens)
            stored = {k: v for k, v in tool_result.items() if k != "auto_chart"}
            result_str = json.dumps(stored, ensure_ascii=False, default=str)
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
    metrics_ctx: Dict[str, Any],
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

        LLM_TIMEOUT = 45  # seconds per LLM call

        # Non-streaming call for Anthropic (simpler for tool-call handling)
        response = await asyncio.wait_for(
            client.messages.create(
                model=model,
                max_tokens=2048,
                system=SYSTEM_PROMPT,
                messages=anthropic_messages,
                tools=anthropic_tools,
                temperature=0.2,
            ),
            timeout=LLM_TIMEOUT,
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

        if text_content and not tool_uses:
            session.messages.append(Message(role="assistant", content=text_content))
            async for chart_event in _emit_chart_events(text_content, chart_data_cache):
                yield chart_event

        if not tool_uses or response.stop_reason == "end_turn":
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

            tool_result = await _execute_tool_rbac(fn_name, fn_args, session.context.get("user_role", "viewer"))
            tool_calls_made += 1

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

            stored = {k: v for k, v in tool_result.items() if k != "auto_chart"}
            result_str = json.dumps(stored, ensure_ascii=False, default=str)
            session.messages.append(Message(
                role="tool",
                content=result_str,
                tool_call_id=tu.id,
                name=fn_name,
            ))

        if tool_calls_made >= settings.ai_max_tool_calls:
            break

# ── Gemini loop ────────────────────────────────────────────────────────────────

async def _gemini_loop(
    model,
    session: ConversationSession,
    tool_calls_made: int,
    chart_data_cache: Dict[int, Dict],
    metrics_ctx: Dict[str, Any],
) -> AsyncGenerator[Dict, None]:
    try:
        import google.generativeai.protos as protos
    except ImportError:
        raise RuntimeError("google-generativeai package not installed")

    # Build simplified history (text-only user/model messages).
    # Gemini can't reconstruct interleaved function_call/response pairs from
    # prior turns, so we feed only conversational text into the history.
    all_msgs = list(_trim_history(session.messages))
    history_msgs = all_msgs[:-1]     # all but the last (current user message)
    current_user_msg = all_msgs[-1].content if all_msgs else ""

    gemini_history = []
    for m in history_msgs:
        if m.role == "user" and m.content and not m.content.startswith("[System:"):
            gemini_history.append({"role": "user", "parts": [m.content]})
        elif m.role == "assistant" and m.content:
            gemini_history.append({"role": "model", "parts": [m.content]})
        # skip tool messages — Gemini needs special proto interleaving for those

    chat = model.start_chat(history=gemini_history)

    # current_msg is either the initial user text or a list of FunctionResponse Parts
    current_msg: Any = current_user_msg

    LLM_TIMEOUT = 45  # seconds per LLM call

    while tool_calls_made <= settings.ai_max_tool_calls:
        response = await asyncio.wait_for(
            chat.send_message_async(current_msg),
            timeout=LLM_TIMEOUT,
        )

        text_content = ""
        function_calls_found = []

        for part in response.parts:
            if hasattr(part, "text") and part.text:
                text_content += part.text
            if hasattr(part, "function_call") and part.function_call.name:
                function_calls_found.append(part.function_call)

        if text_content:
            for word in text_content.split():
                yield TextEvent(content=word + " ").model_dump()

        if not function_calls_found:
            if text_content:
                session.messages.append(Message(role="assistant", content=text_content))
            async for chart_event in _emit_chart_events(text_content, chart_data_cache):
                yield chart_event
            break  # No more tool calls — conversation turn complete

        # Save assistant message with tool_calls for history consistency
        tc_records = [
            {"id": fc.name, "type": "function", "function": {"name": fc.name, "arguments": json.dumps({k: v for k, v in fc.args.items()} if fc.args else {})}}
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
            fn_args = {k: v for k, v in fc.args.items()} if fc.args else {}

            yield ToolCallEvent(tool=fn_name, args=fn_args).model_dump()

            tool_result = await _execute_tool_rbac(fn_name, fn_args, session.context.get("user_role", "viewer"))
            tool_calls_made += 1

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

            stored = {k: v for k, v in tool_result.items() if k != "auto_chart"}
            result_str = json.dumps(stored, ensure_ascii=False, default=str)
            session.messages.append(Message(
                role="tool",
                content=result_str,
                tool_call_id=fn_name,
                name=fn_name,
            ))

            response_parts.append(
                protos.Part(function_response=protos.FunctionResponse(
                    name=fn_name,
                    response={"content": result_str},
                ))
            )

        if tool_calls_made >= settings.ai_max_tool_calls:
            # Send all function responses then force a final answer
            try:
                await asyncio.wait_for(chat.send_message_async(response_parts), timeout=LLM_TIMEOUT)
                final_resp = await asyncio.wait_for(
                    chat.send_message_async(
                        "You have reached the tool call limit. Please provide your final analysis based on the data collected so far."
                    ),
                    timeout=LLM_TIMEOUT,
                )
                final_text = "".join(
                    p.text for p in final_resp.parts if hasattr(p, "text") and p.text
                )
                if final_text:
                    for word in final_text.split():
                        yield TextEvent(content=word + " ").model_dump()
                    session.messages.append(Message(role="assistant", content=final_text))
                    async for ev in _emit_chart_events(final_text, chart_data_cache):
                        yield ev
            except Exception:
                pass
            break

        # Feed function responses back — loop continues for more tool calls / final answer
        current_msg = response_parts

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
    elif tool_name == "list_workspace_tables":
        ws_count = len(result.get("workspaces", []))
        table_count = sum(len(ws["tables"]) for ws in result.get("workspaces", []))
        return f"{ws_count} workspace(s), {table_count} table(s)"
    elif tool_name == "query_table":
        return f"{result.get('row_count', 0)} rows (aggregated)"
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
