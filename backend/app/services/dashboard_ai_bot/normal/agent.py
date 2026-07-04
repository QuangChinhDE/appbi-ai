"""Agent loop + proactive recon for the Normal AI bot.

Adapted from the May-8 baseline (commit e38c0bc), reusing the shared
``tool_context`` chart-fetch primitives so the data boundary stays
aligned with the Thinking variant.

What this implementation deliberately omits (compared to thinking/):
  - emit_reading_plan / PHASE 0 / reading_plan SSE events
  - briefing wizard, conversation state extraction
  - advanced analytics tools (correlate_charts, detect_anomaly, etc.)
  - dashboard overview image / chart image
  - cross-turn summary cache, multi-thread recon
  - plan_step progress events

What it keeps from the baseline:
  - parallel recon at chat-open (3 chart summaries, single-threaded
    is enough for 5 tools)
  - per-turn tool loop
  - per-tool status events
  - optional self-critique (default OFF — keeps Normal cheap and fast)
  - log-only sanitizer (Phase 15.75 lesson — never silently drop
    bullets the model wrote correctly)
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import AsyncGenerator

from app.services.dashboard_ai_bot.cost import CostMeter
from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.dashboard_ai_bot.normal.critique import critique_and_stream
from app.services.dashboard_ai_bot.normal.prompts import build_agent_system_prompt
from app.services.dashboard_ai_bot.normal.tools import (
    TOOL_DEFINITIONS,
    execute_tool,
    tool_get_chart_summary,
    tool_list_charts,
)
from app.services.dashboard_ai_bot.providers import (
    stream_anthropic,
    stream_gemini_singleshot,
    stream_openai,
)
from app.services.dashboard_ai_bot.tool_context import ToolContext

logger = logging.getLogger(__name__)

MAX_TOOL_CALLS_PER_TURN = 8  # Phase 16.1 — trimmed 12→8 (latency/quota guard)
RECON_MAX_CHARTS = 3
# Keep in sync with thinking/agent.py — claude-3-5-haiku was retired
# (2026-02-19); gemini-1.5-flash is EOL. Aliases track live snapshots.
_DEFAULT_MODEL_BY_PROVIDER = {
    "anthropic": "claude-haiku-4-5",
    "openai": "gpt-4o-mini",
    "gemini": "gemini-2.5-flash",
}

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
        return stream_anthropic, True
    if p == "openai":
        return stream_openai, True
    if p == "gemini":
        return stream_gemini_singleshot, False
    return None, False


# ── Proactive recon ─────────────────────────────────────────────────────────


def build_proactive_recon(ctx: ToolContext) -> dict:
    """Run list_charts + summaries for the first few charts. No LLM calls."""
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
    lines = ["═══ RECON SNAPSHOT ═══"]
    manifest = recon.get("manifest") or {}
    charts = manifest.get("charts") or []
    _pages = manifest.get("pages") or []
    if _pages:
        _name_by_id = {c.get("chart_id"): c.get("chart_name") for c in charts}
        lines.append("Report flow (pages): " + " | ".join(
            f"{p.get('name')}: " + ", ".join(
                str(_name_by_id.get(cid) or cid) for cid in (p.get("chart_ids") or [])
            )
            for p in _pages
        ))
    lines.append(f"Charts: {len(charts)}")
    for c in charts:
        lines.append(
            f"  - [chart:{c.get('chart_id')}] {c.get('chart_name')!r} "
            f"({c.get('chart_type')}) rows={c.get('total_rows')}"
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


# ── Main loop ───────────────────────────────────────────────────────────────


async def run_agent_stream(
    *,
    ctx: ToolContext,
    user_messages: list[dict],
    api_key: str,
    provider: str,
    model: str | None = None,
    enable_critique: bool = False,
    max_tool_calls: int = MAX_TOOL_CALLS_PER_TURN,
    report_context_note: str = "",
    learned_knowledge_block: str = "",
) -> AsyncGenerator[AgentEvent, None]:
    """Run one chat turn end-to-end and yield AgentEvent objects."""
    if not user_messages or not isinstance(user_messages, list):
        yield AgentEvent(type="error", text="No messages provided.")
        yield AgentEvent(type="done")
        return

    turn_started_at = time.monotonic()

    streamer, supports_tools = _streamer_for(provider)
    if streamer is None:
        yield AgentEvent(type="error", text=f"Unknown provider: {provider!r}")
        yield AgentEvent(type="done")
        return
    selected_model = (model or "").strip() or _DEFAULT_MODEL_BY_PROVIDER.get(
        (provider or "").strip().lower(),
    )

    # Telemetry only — no per-question ceiling (max_tool_calls bounds runaway).
    meter = CostMeter(model=selected_model or "")

    base_system = build_agent_system_prompt(
        dashboard_name=ctx.dashboard.name or "Dashboard",
        dashboard_description=getattr(ctx.dashboard, "description", "") or "",
        chart_count=len(ctx.allowed_chart_ids),
        filters_applied=ctx.public_filters,
        max_tool_calls=max_tool_calls,
    )
    # report_context_note is the admin-configured "Report Mindset" string.
    # Append as a small block at the end of the system prompt when present.
    if report_context_note.strip():
        base_system = (
            base_system
            + "\n═══ REPORT SYSTEM PROMPT (admin-configured — follow this to read "
            "the report with the right flow & logic) ═══\n"
            + report_context_note.strip()
            + "\n"
        )

    # Recon snapshot — small, stays out of the LLM's way otherwise.
    #
    # Phase 16.1 latency fix: this used to call the module's SEQUENTIAL
    # builder inline in the async generator — 3 chart queries one-by-one,
    # blocking the event loop (measured 25s+ dead air on dashboard 67
    # before the first LLM byte, for EVERY normal turn). Use the shared
    # cached+parallel builder off-thread; /ai/recon on bot open warms it.
    from app.services.dashboard_ai_bot.thinking.agent import (
        build_proactive_recon_cached as _recon_cached,
    )
    yield AgentEvent(
        type="status",
        text="Đang đọc cấu trúc báo cáo…",
        tool_name="_thinking",
    )
    try:
        recon = await asyncio.to_thread(_recon_cached, ctx)
    except Exception:
        logger.warning("normal recon build failed", exc_info=True)
        recon = {"manifest": {}, "summaries": []}
    recon_block = _format_recon_for_prompt(recon)
    system_with_context = base_system
    # Institutional memory (validated learnings about this company).
    if learned_knowledge_block:
        system_with_context += "\n\n" + learned_knowledge_block
    system_with_context += "\n\n" + recon_block

    # ── Gemini fallback path: single-shot (no tools) ────────────────────────
    if not supports_tools:
        async for ev in streamer(
            api_key=api_key,
            system_prompt=system_with_context,
            messages=user_messages,
            tools=None,
            model=selected_model or None,
        ):
            if ev.type == "usage":
                meter.add_usage(ev.extra or {})
                yield AgentEvent(type="cost", extra={"cost": meter.to_dict()})
                continue
            yield ev
        yield AgentEvent(type="done")
        return

    # ── Tool-aware path ─────────────────────────────────────────────────────
    last_user_question = ""
    for msg in reversed(user_messages):
        if msg.get("role") == "user":
            last_user_question = str(msg.get("content") or "")
            break

    running: list[dict] = list(user_messages)
    tool_log: list[dict] = []
    draft_answer_parts: list[str] = []
    tool_calls_made = 0
    # Runaway-loop guard (see thinking/agent.py for the ds67 50-round case).
    force_no_tools = False
    rounds = 0
    HARD_ROUND_CAP = max_tool_calls + 4

    while True:
        rounds += 1
        if rounds > HARD_ROUND_CAP:
            force_no_tools = True
        yield AgentEvent(
            type="status",
            text=(
                "Đang suy nghĩ…" if tool_calls_made == 0
                else "Đang tổng hợp câu trả lời…" if force_no_tools
                else "Đang phân tích kết quả…"
            ),
            tool_name="_thinking",
        )

        round_text_parts: list[str] = []
        round_tool_calls: list[AgentEvent] = []
        round_error: str | None = None

        try:
            gen = streamer(
                api_key=api_key,
                system_prompt=system_with_context,
                messages=running,
                tools=None if force_no_tools else TOOL_DEFINITIONS,
                model=selected_model or None,
            )
            async for ev in gen:
                if ev.type == "text":
                    round_text_parts.append(ev.text)
                elif ev.type == "tool_call":
                    round_tool_calls.append(ev)
                elif ev.type == "usage":
                    meter.add_usage(ev.extra or {})
                    yield AgentEvent(type="cost", extra={"cost": meter.to_dict()})
                elif ev.type == "error":
                    round_error = ev.text
                    break
        except Exception as exc:
            logger.exception("normal provider stream raised")
            round_error = f"Provider transport error: {type(exc).__name__}"

        if round_error:
            yield AgentEvent(type="error", text=round_error)
            if draft_answer_parts:
                yield AgentEvent(type="text", text="".join(draft_answer_parts))
            yield AgentEvent(type="done")
            return

        round_text = "".join(round_text_parts).strip()

        if round_tool_calls:
            asst_entry: dict = {"role": "assistant"}
            if round_text:
                asst_entry["content"] = round_text
            asst_entry["tool_calls"] = [
                {"id": tc.tool_call_id, "name": tc.tool_name, "args": tc.tool_args}
                for tc in round_tool_calls
            ]
            running.append(asst_entry)

            if tool_calls_made >= max_tool_calls:
                # Budget spent — disable tools next round so the model must
                # answer (not loop). See thinking/agent.py runaway guard.
                force_no_tools = True
                err = {
                    "ok": False,
                    "error": (
                        "internal: tool budget spent — do NOT call more tools. Write the "
                        "final answer now from the data already gathered. Do not mention "
                        "this message to the user."
                    ),
                }
                for tc in round_tool_calls:
                    running.append({
                        "role": "tool",
                        "tool_call_id": tc.tool_call_id,
                        "result": err,
                    })
                    tool_log.append({"name": tc.tool_name, "args": tc.tool_args, "result": err})
                continue

            for tc in round_tool_calls:

                yield AgentEvent(
                    type="status",
                    text=_status_text(tc.tool_name, tc.tool_args),
                    tool_call_id=tc.tool_call_id,
                    tool_name=tc.tool_name,
                    tool_args=tc.tool_args,
                )

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

                yield AgentEvent(
                    type="tool_result",
                    tool_call_id=tc.tool_call_id,
                    tool_name=tc.tool_name,
                    tool_result=result,
                )

            continue

        # No tool calls in this round → draft final answer.
        draft_answer_parts.append(round_text)
        break

    draft_answer = "".join(draft_answer_parts).strip()
    if not draft_answer:
        yield AgentEvent(
            type="text",
            text=(
                "Tôi chưa đưa ra được câu trả lời cho câu này. "
                "Bạn thử hỏi lại theo cách khác (ví dụ: chỉ tên một chart "
                "cụ thể, hoặc nêu rõ chỉ số / phân khúc bạn muốn xem)."
            ),
        )
        yield AgentEvent(type="done")
        return

    # ── Self-critique pass (opt-in) ─────────────────────────────────────────
    run_critique = enable_critique and last_user_question
    if run_critique:
        yield AgentEvent(
            type="status",
            text="Đang viết câu trả lời…",
            tool_name="_thinking",
        )
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
            if ev.type == "usage":
                meter.add(
                    prompt_tokens=int((ev.extra or {}).get("prompt_tokens") or 0),
                    completion_tokens=int((ev.extra or {}).get("completion_tokens") or 0),
                )
                yield AgentEvent(type="cost", extra={"cost": meter.to_dict()})
                continue
            yield ev
        yield AgentEvent(type="text", text=_sanitize_answer(buffered_text))
    else:
        yield AgentEvent(type="text", text=_sanitize_answer(draft_answer))

    elapsed_ms = int((time.monotonic() - turn_started_at) * 1000)
    logger.info(
        "normal_ai_bot turn complete provider=%s model=%s tool_calls=%d elapsed_ms=%d question=%r",
        provider,
        selected_model or "(default)",
        len(tool_log),
        elapsed_ms,
        last_user_question[:120],
    )

    yield AgentEvent(type="done")


# ── Answer post-filter (log-only, doesn't drop bullets) ─────────────────────
#
# Phase 15.75 lesson: dropping bullets the model wrote silently produced
# choppier answers and quietly degraded quality. We log forbidden phrases
# for telemetry but return the text intact.

_FORBIDDEN_PHRASES = (
    "tool budget",
    "hạn chế công cụ",
    "giới hạn công cụ",
    "không kịp lấy",
    "due to limitations",
    "system limit",
    "internal: stop",
)

_SPECULATIVE_MARKERS = (
    "có thể là do lỗi nhập liệu",
    "có thể do lỗi nhập liệu",
    "có thể chỉ ra một vấn đề",
    "likely a data quality",
    "this might indicate",
    "this suggests a problem",
)


def _sanitize_answer(text: str) -> str:
    if not text:
        return ""
    low = text.lower()
    leaks = [p for p in _FORBIDDEN_PHRASES if p in low]
    spec = [p for p in _SPECULATIVE_MARKERS if p in low]
    if leaks:
        logger.warning("normal answer leaked system-limit phrase(s)=%s", leaks)
    if spec:
        logger.info("normal answer contains hedged phrase(s)=%s", spec)
    return text
