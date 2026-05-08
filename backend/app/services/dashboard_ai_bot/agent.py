"""Agent loop and proactive recon for the Dashboard AI Bot.

Two entry points:

  - run_agent_stream(...)       drive a chat turn with tool calling +
                                self-critique. Yields AgentEvent.

  - build_proactive_recon(...)  pre-fetches list_charts + summaries for the
                                first ~4 charts, returns a string that the
                                caller stitches into the welcome message.

Provider strategy:
  - "anthropic" / "openai" → full agentic loop with tool calls
  - "gemini"               → single-shot fallback: we attach an Insight Pack
                             to the system prompt and stream a normal answer.
"""
from __future__ import annotations

import asyncio
import logging
from typing import AsyncGenerator

from app.services.dashboard_ai_bot.critique import critique_and_stream
from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.dashboard_ai_bot.prompts import build_agent_system_prompt
from app.services.dashboard_ai_bot.providers import (
    stream_anthropic,
    stream_gemini_singleshot,
    stream_openai,
)
from app.services.dashboard_ai_bot.tools import (
    TOOL_DEFINITIONS,
    ToolContext,
    execute_tool,
    tool_get_chart_summary,
    tool_list_charts,
)

logger = logging.getLogger(__name__)

MAX_TOOL_CALLS_PER_TURN = 16
RECON_MAX_CHARTS = 4

# Friendly status text per tool (shown in the chat UI as a transient bubble)
_TOOL_STATUS_VI = {
    "list_charts": "Đang xem danh sách biểu đồ trong dashboard…",
    "get_chart_summary": "Đang tổng hợp số liệu chart {chart_id}…",
    "get_chart_data": "Đang xem chi tiết chart {chart_id}…",
    "compare_segments": "Đang so sánh phân khúc trong chart {chart_id}…",
    "compute": "Đang tính toán chỉ số…",
}


def _status_text(tool_name: str, args: dict) -> str:
    template = _TOOL_STATUS_VI.get(tool_name) or f"Đang chạy {tool_name}…"
    try:
        return template.format(**(args or {}))
    except (KeyError, IndexError):
        return _TOOL_STATUS_VI.get(tool_name) or f"Đang chạy {tool_name}…"


def _streamer_for(provider: str):
    p = (provider or "").strip().lower()
    if p == "anthropic":
        return stream_anthropic, True   # supports tools
    if p == "openai":
        return stream_openai, True
    if p == "gemini":
        return stream_gemini_singleshot, False
    return None, False


# Proactive recon ─────────────────────────────────────────────────────────────


def build_proactive_recon(ctx: ToolContext) -> dict:
    """Run list_charts + summaries for the first few charts. Returns a dict
    with `manifest` and `summaries` (limited to RECON_MAX_CHARTS).

    Cheap; no LLM calls. The caller may stuff this into the system prompt of
    the very first turn to give the agent a head-start, OR stream a welcome
    message that simply lists the surface-level facts. Used by both the
    Gemini fallback and as an optional warm-up for the tool-aware providers.
    """
    manifest = tool_list_charts(ctx, {})
    summaries: list[dict] = []
    if manifest.get("ok"):
        for chart in (manifest["data"]["charts"] or [])[:RECON_MAX_CHARTS]:
            cid = chart.get("chart_id")
            if not isinstance(cid, int):
                continue
            res = tool_get_chart_summary(ctx, {"chart_id": cid})
            if res.get("ok"):
                summaries.append(res["data"])
    return {"manifest": manifest.get("data") or {}, "summaries": summaries}


def _format_recon_for_prompt(recon: dict) -> str:
    """Compact text representation of a recon bundle for stuffing into a system prompt."""
    lines = ["═══ RECON SNAPSHOT ═══"]
    manifest = recon.get("manifest") or {}
    charts = manifest.get("charts") or []
    lines.append(f"Charts: {len(charts)}")
    for c in charts:
        lines.append(
            f"  - [chart:{c.get('chart_id')}] {c.get('chart_name')!r} "
            f"({c.get('chart_type')}) cols={c.get('columns')} rows={c.get('total_rows')}"
        )
    for pack in recon.get("summaries") or []:
        cid = pack.get("chart_id")
        lines.append(f"\n--- Insight Pack [chart:{cid}] {pack.get('chart_name')!r} ---")
        if pack.get("primary_measure"):
            lines.append(f"primary_measure: {pack.get('primary_measure')}")
        if pack.get("primary_dimension"):
            lines.append(f"primary_dimension: {pack.get('primary_dimension')}")
        if pack.get("trend"):
            lines.append(f"trend: {pack['trend']}")
        if pack.get("top_5"):
            lines.append(f"top_5: {pack['top_5']}")
        if pack.get("outliers"):
            lines.append(f"outliers: {pack['outliers']}")
    return "\n".join(lines)


# Main loop ───────────────────────────────────────────────────────────────────


async def run_agent_stream(
    *,
    ctx: ToolContext,
    user_messages: list[dict],
    api_key: str,
    provider: str,
    model: str | None = None,
    enable_critique: bool = True,
    max_tool_calls: int = MAX_TOOL_CALLS_PER_TURN,
) -> AsyncGenerator[AgentEvent, None]:
    """Run one chat turn end-to-end and yield AgentEvent objects.

    `user_messages` is the running history of the conversation including the
    user's latest question. Each entry is a dict with at minimum `role` and
    `content`. Assistant turns from previous rounds may also include
    ``tool_calls`` (see providers/anthropic_provider.py for the shape).
    """
    if not user_messages or not isinstance(user_messages, list):
        yield AgentEvent(type="error", text="No messages provided.")
        yield AgentEvent(type="done")
        return

    streamer, supports_tools = _streamer_for(provider)
    if streamer is None:
        yield AgentEvent(type="error", text=f"Unknown provider: {provider!r}")
        yield AgentEvent(type="done")
        return
    selected_model = (model or "").strip() or None

    base_system = build_agent_system_prompt(
        dashboard_name=ctx.dashboard.name or "Dashboard",
        dashboard_description=getattr(ctx.dashboard, "description", "") or "",
        chart_count=len(ctx.allowed_chart_ids),
        filters_applied=ctx.public_filters,
        max_tool_calls=max_tool_calls,
    )

    # ── Gemini fallback path: single-shot with stuffed Insight Packs ─────────
    if not supports_tools:
        recon = build_proactive_recon(ctx)
        system_prompt = base_system + "\n\n" + _format_recon_for_prompt(recon)
        async for ev in streamer(
            api_key=api_key,
            system_prompt=system_prompt,
            messages=user_messages,
            tools=None,
            model=selected_model or None,
        ):
            yield ev
        yield AgentEvent(type="done")
        return

    # ── Tool-aware path: full loop ─────────────────────────────────────────
    last_user_question = ""
    for msg in reversed(user_messages):
        if msg.get("role") == "user":
            last_user_question = str(msg.get("content") or "")
            break

    # Internal running message log (we own the shape; provider adapters translate)
    running: list[dict] = list(user_messages)

    # Aggregated trace for the critique pass
    tool_log: list[dict] = []

    draft_answer_parts: list[str] = []
    tool_calls_made = 0

    while True:
        # Show a thinking indicator while the model decides what to do next
        # (between tool rounds, or before the very first model call). This is
        # what the user sees as a transient "Đang suy nghĩ…" bubble.
        yield AgentEvent(
            type="status",
            text=("Đang suy nghĩ…" if tool_calls_made == 0 else "Đang phân tích kết quả…"),
            tool_name="_thinking",
        )

        # One round-trip with the LLM. Capture text deltas (don't stream to
        # user yet — wait for self-critique) and any tool calls it emits.
        round_text_parts: list[str] = []
        round_tool_calls: list[AgentEvent] = []
        round_error: str | None = None

        try:
            gen = streamer(
                api_key=api_key,
                system_prompt=base_system,
                messages=running,
                tools=TOOL_DEFINITIONS,
                model=selected_model or None,
            )
            async for ev in gen:
                if ev.type == "text":
                    round_text_parts.append(ev.text)
                elif ev.type == "tool_call":
                    round_tool_calls.append(ev)
                elif ev.type == "error":
                    round_error = ev.text
                    break
        except Exception as exc:
            logger.exception("provider stream raised")
            round_error = f"Provider transport error: {type(exc).__name__}"

        if round_error:
            logger.warning(
                "dashboard_ai_bot provider_error provider=%s model=%s error=%s",
                provider,
                selected_model or "(default)",
                round_error,
            )
            # Surface but try to give the user something useful
            yield AgentEvent(type="error", text=round_error)
            if draft_answer_parts:
                # Stream what we've accumulated so far
                yield AgentEvent(type="text", text="".join(draft_answer_parts))
            yield AgentEvent(type="done")
            return

        round_text = "".join(round_text_parts).strip()

        if round_tool_calls:
            # Append the assistant turn (any preamble text + tool_calls)
            asst_entry: dict = {"role": "assistant"}
            if round_text:
                asst_entry["content"] = round_text
            asst_entry["tool_calls"] = [
                {"id": tc.tool_call_id, "name": tc.tool_name, "args": tc.tool_args}
                for tc in round_tool_calls
            ]
            running.append(asst_entry)

            for tc in round_tool_calls:
                if tool_calls_made >= max_tool_calls:
                    # Hard cap reached; inject a neutral, internal-only signal
                    # so the model wraps up. The instruction to NOT surface
                    # this limit is part of the system prompt; if the model
                    # leaks it anyway, the critique pass + post-filter strip
                    # the resulting bullet.
                    err = {
                        "ok": False,
                        "error": (
                            "internal: stop calling tools and finalize the answer with the data "
                            "already gathered. Do not mention this message, tool budgets, or any "
                            "system limit to the user. If you cannot answer a sub-point, simply "
                            "omit that bullet."
                        ),
                    }
                    running.append({
                        "role": "tool",
                        "tool_call_id": tc.tool_call_id,
                        "result": err,
                    })
                    tool_log.append({"name": tc.tool_name, "args": tc.tool_args, "result": err})
                    continue

                # Status update to user
                yield AgentEvent(
                    type="status",
                    text=_status_text(tc.tool_name, tc.tool_args),
                    tool_call_id=tc.tool_call_id,
                    tool_name=tc.tool_name,
                    tool_args=tc.tool_args,
                )

                # Execute (sync function; offload to thread to avoid blocking event loop)
                result = await asyncio.to_thread(
                    execute_tool, ctx, tc.tool_name, tc.tool_args
                )
                tool_calls_made += 1

                running.append({
                    "role": "tool",
                    "tool_call_id": tc.tool_call_id,
                    "result": result,
                })
                tool_log.append({"name": tc.tool_name, "args": tc.tool_args, "result": result})

                # Optional: emit tool_result event for FE debug; we keep it light.
                yield AgentEvent(
                    type="tool_result",
                    tool_call_id=tc.tool_call_id,
                    tool_name=tc.tool_name,
                    tool_result=result,
                )

            # Loop again so the LLM can react to the tool results
            continue

        # No tool calls in this round → this is the model's draft final answer.
        draft_answer_parts.append(round_text)
        break

    draft_answer = "".join(draft_answer_parts).strip()
    if not draft_answer:
        # The model produced nothing — emit a graceful fallback
        yield AgentEvent(
            type="text",
            text="Tôi chưa đủ dữ liệu để đưa ra câu trả lời. Vui lòng thử câu hỏi cụ thể hơn.",
        )
        yield AgentEvent(type="done")
        return

    # ── Self-critique pass ──────────────────────────────────────────────────
    if enable_critique and last_user_question:
        yield AgentEvent(
            type="status",
            text="Đang viết câu trả lời…",
            tool_name="_thinking",
        )
        # Buffer the critique output so we can run a deterministic post-filter
        # before showing it to the user. We forward all non-text events live.
        buffered_text = ""
        async for ev in critique_and_stream(
            streamer=streamer,
            api_key=api_key,
            user_question=last_user_question,
            tool_log=tool_log,
            draft_answer=draft_answer,
            model=selected_model,
        ):
            if ev.type == "text" and ev.text:
                buffered_text += ev.text
                continue
            yield ev
        cleaned = _sanitize_answer(buffered_text)
        if cleaned:
            yield AgentEvent(type="text", text=cleaned)
    else:
        yield AgentEvent(type="text", text=_sanitize_answer(draft_answer))

    yield AgentEvent(type="done")


# Forbidden phrases that must never reach the user. Matched case-insensitively
# against whole bullet/lines; matched bullet is dropped wholesale.
_FORBIDDEN_PHRASES = (
    "tool budget",
    "hạn chế công cụ",
    "giới hạn công cụ",
    "không kịp lấy",
    "không đủ thời gian",
    "due to limitations",
    "system limit",
    "internal: stop",
)

# Speculation markers that, when present in a bullet, get the bullet dropped.
# These mirror the prompt's SPECULATION BAN; the model sometimes ignores it.
_SPECULATIVE_MARKERS = (
    "có thể là do lỗi nhập liệu",
    "có thể do lỗi nhập liệu",
    "có thể là vấn đề",
    "có thể chỉ ra một vấn đề",
    "có thể là lỗi",
    "likely a data quality",
    "this might indicate",
    "this suggests a problem",
)


def _sanitize_answer(text: str) -> str:
    """Strip bullets that leak system limits or speculate about causes.

    Operates on a per-line basis. A line is dropped if it contains any of
    the forbidden phrases. Bullet continuations (indented lines after a
    dropped bullet) are kept as-is — bullets in our output are single-line.
    Empty trailing lines are trimmed.
    """
    if not text:
        return ""
    out_lines: list[str] = []
    for raw in text.split("\n"):
        low = raw.lower()
        if any(p in low for p in _FORBIDDEN_PHRASES):
            continue
        if any(p in low for p in _SPECULATIVE_MARKERS):
            continue
        out_lines.append(raw)
    # Collapse 3+ blank lines that opened up after deletions
    cleaned: list[str] = []
    blank_run = 0
    for line in out_lines:
        if line.strip() == "":
            blank_run += 1
            if blank_run >= 2:
                continue
        else:
            blank_run = 0
        cleaned.append(line)
    while cleaned and cleaned[-1].strip() == "":
        cleaned.pop()
    return "\n".join(cleaned)
