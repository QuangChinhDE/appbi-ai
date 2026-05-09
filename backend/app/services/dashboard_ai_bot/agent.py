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
import re
import time
from typing import AsyncGenerator

from app.services.dashboard_ai_bot.briefing import (
    Briefing,
    format_briefing_for_prompt,
)
from app.services.dashboard_ai_bot.conversation_state import (
    ConversationState,
    Hypothesis,
    collect_seen_chart_ids,
    detect_cross_turn_contradictions,
    extract_findings_from_answer,
    extract_hypotheses_from_user,
    format_state_for_prompt,
    update_hypothesis_status,
)
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
from app.services.dashboard_ai_bot.cost import CostMeter

logger = logging.getLogger(__name__)

MAX_TOOL_CALLS_PER_TURN = 16
RECON_MAX_CHARTS = 10
DEFAULT_COST_CAP_USD = 0.10
_DEFAULT_MODEL_BY_PROVIDER = {
    "anthropic": "claude-3-5-haiku-20241022",
    "openai": "gpt-4o-mini",
    "gemini": "gemini-1.5-flash",
}

# Friendly status text per tool (shown in the chat UI as a transient bubble)
_TOOL_STATUS_VI = {
    "list_charts": "Đang xem danh sách biểu đồ trong dashboard…",
    "get_chart_summary": "Đang tổng hợp số liệu chart {chart_id}…",
    "get_chart_data": "Đang xem chi tiết chart {chart_id}…",
    "compare_segments": "Đang so sánh phân khúc trong chart {chart_id}…",
    "compute": "Đang tính toán chỉ số…",
    "compare_periods": "Đang so sánh các kỳ trong chart {chart_id}…",
    "describe_distribution": "Đang phân tích phân phối chart {chart_id}…",
    "correlate_charts": "Đang đối chiếu chart {chart_a} với chart {chart_b}…",
    "detect_anomaly": "Đang dò bất thường trong chart {chart_id}…",
    "get_dashboard_overview_image": "Đang dựng ảnh tổng quan dashboard để đọc bằng AI…",
    "get_chart_image": "Đang đọc dáng biểu đồ chart {chart_id}…",
    "smart_drilldown": "Đang lọc chart {chart_id} theo {column}={match}…",
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
    """Run list_charts (light) + summaries for the first few charts in parallel.

    Returns a dict with ``manifest`` and ``summaries`` (limited to
    ``RECON_MAX_CHARTS``). Cheap; no LLM calls.

    The manifest call uses ``light=True`` to skip per-chart data fetches —
    on big dashboards (10+ charts × ~1.5s live SQL each), counting rows
    eagerly was the dominant latency source. The agent still gets full
    manifest metadata, and can call ``get_chart_summary`` on demand.

    The first ``RECON_MAX_CHARTS`` summaries are fetched concurrently via
    a thread pool so total wall time ≈ slowest single chart, not the sum.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    manifest = tool_list_charts(ctx, {"light": True})
    summaries: list[dict] = []
    if not manifest.get("ok"):
        return {"manifest": manifest.get("data") or {}, "summaries": []}

    # Prioritise non-KPI charts (breakdown / trend / distribution) so the
    # pre-loaded summaries contain richer analytical context.  KPI charts
    # are appended last — their single aggregated value is cheap to read
    # and less likely to hit the RECON_MAX_CHARTS cap.
    all_charts = manifest["data"].get("charts") or []
    non_kpi = [c for c in all_charts if c.get("role_hint") != "kpi"]
    kpi_only = [c for c in all_charts if c.get("role_hint") == "kpi"]
    ordered = (non_kpi + kpi_only)[:RECON_MAX_CHARTS]

    chart_ids: list[int] = []
    for chart in ordered:
        cid = chart.get("chart_id")
        if isinstance(cid, int):
            chart_ids.append(cid)

    if not chart_ids:
        return {"manifest": manifest.get("data") or {}, "summaries": []}

    # Parallel fan-out. Workers share the same SQLAlchemy session bound to
    # ``ctx.db``; SQLite/Postgres sessions are not thread-safe, so we keep
    # the pool small and serialize via a lock if we ever observe issues.
    # In practice each summary call hits LiveQueryService which opens its
    # own source DB connection per call, so the bottleneck is the source
    # DB latency, which parallelizes fine.
    results: dict[int, dict] = {}
    with ThreadPoolExecutor(max_workers=min(6, len(chart_ids))) as pool:
        futures = {
            pool.submit(tool_get_chart_summary, ctx, {"chart_id": cid}): cid
            for cid in chart_ids
        }
        for fut in as_completed(futures):
            cid = futures[fut]
            try:
                results[cid] = fut.result(timeout=12)
            except Exception as exc:
                logger.warning(
                    "recon summary failed chart_id=%s err=%s",
                    cid,
                    type(exc).__name__,
                )

    # Preserve manifest order
    for cid in chart_ids:
        res = results.get(cid)
        if res and res.get("ok"):
            summaries.append(res["data"])

    # Auto cross-chart heuristics: if two summaries share a common keyword
    # (e.g. one chart's name says "tổng / total" and another says "quá hạn /
    # overdue"), pre-compute a ratio so the LLM doesn't need an extra
    # `compute` call. Best-effort, never fatal.
    cross_compute = _auto_cross_compute(summaries)

    return {
        "manifest": manifest.get("data") or {},
        "summaries": summaries,
        "cross_compute": cross_compute,
    }


_TOTAL_TOKENS = ("tổng", "total", "all tasks", "all task", "tất cả", "công việc")
_OVERDUE_TOKENS = ("quá hạn", "overdue", "trễ", "delayed", "late")
_COMPLETION_TOKENS = ("hoàn thành", "completion", "completed", "completion %", "complete rate")


def _auto_cross_compute(summaries: list[dict]) -> list[dict]:
    """Look for a pair (total chart, overdue chart) and pre-compute the rate.

    Returns a list of derived facts the agent can consume directly. Each
    fact has shape::

        {"label": str, "value": float, "unit": str,
         "citations": [chart_id, ...], "expression": str}

    No-op when no pair found.
    """
    facts: list[dict] = []
    if not summaries:
        return facts

    def _score(name: str, hints: tuple[str, ...]) -> int:
        low = (name or "").lower()
        return sum(1 for h in hints if h in low)

    def _measure_total(pack: dict) -> float | None:
        col_name = pack.get("primary_measure")
        if not col_name:
            return None
        for c in pack.get("columns") or []:
            if c.get("name") == col_name and isinstance(c.get("total"), (int, float)):
                return float(c["total"])
        return None

    total_pack = max(
        summaries, key=lambda p: _score(p.get("chart_name", ""), _TOTAL_TOKENS), default=None
    )
    overdue_pack = max(
        summaries, key=lambda p: _score(p.get("chart_name", ""), _OVERDUE_TOKENS), default=None
    )
    if total_pack and overdue_pack and total_pack is not overdue_pack:
        if _score(total_pack.get("chart_name", ""), _TOTAL_TOKENS) > 0 and _score(
            overdue_pack.get("chart_name", ""), _OVERDUE_TOKENS
        ) > 0:
            t_val = _measure_total(total_pack)
            o_val = _measure_total(overdue_pack)
            if t_val and t_val > 0 and o_val is not None:
                rate = (o_val / t_val) * 100.0
                facts.append({
                    "label": "overdue_rate_pct",
                    "value": round(rate, 2),
                    "unit": "%",
                    "expression": "overdue / total * 100",
                    "citations": [
                        overdue_pack.get("chart_id"),
                        total_pack.get("chart_id"),
                    ],
                })
    return facts


def _format_recon_for_prompt(recon: dict) -> str:
    """Compact text representation of a recon bundle for stuffing into a system prompt."""
    lines = ["═══ RECON SNAPSHOT ═══"]
    lines.append(
        "Use this as the current report context available before any tool call. "
        "It is a starting map, not a fixed conclusion; tool results remain authoritative."
    )
    manifest = recon.get("manifest") or {}
    charts = manifest.get("charts") or []
    lines.append(f"Charts: {len(charts)}")
    for c in charts:
        role = c.get("role_hint") or "?"
        lines.append(
            f"  - [chart:{c.get('chart_id')}] {c.get('chart_name')!r} "
            f"role={role} type={c.get('chart_type')} cols={c.get('columns')} rows={c.get('total_rows')}"
        )
    for pack in recon.get("summaries") or []:
        cid = pack.get("chart_id")
        lines.append(f"\n--- Insight Pack [chart:{cid}] {pack.get('chart_name')!r} ---")
        if pack.get("chart_role"):
            lines.append(f"role: {pack.get('chart_role')}")
        if pack.get("primary_measure"):
            lines.append(f"primary_measure: {pack.get('primary_measure')}")
        if pack.get("primary_dimension"):
            lines.append(f"primary_dimension: {pack.get('primary_dimension')}")
        if pack.get("empty_state"):
            lines.append(f"empty_state: {pack.get('empty_state')}")
        if pack.get("trend"):
            lines.append(f"trend: {pack['trend']}")
        if pack.get("top_5"):
            lines.append(f"top_5: {pack['top_5']}")
        if pack.get("top_share_pct") is not None:
            lines.append(f"top_share_pct: {pack['top_share_pct']:.2f}%")
        if pack.get("health_signals"):
            lines.append(f"health_signals: {', '.join(pack['health_signals'])}")
        if pack.get("outliers"):
            lines.append(f"outliers: {pack['outliers']}")
    cross = recon.get("cross_compute") or []
    if cross:
        lines.append("\n--- Pre-computed cross-chart facts ---")
        for fact in cross:
            cites = ", ".join(f"chart:{c}" for c in (fact.get("citations") or []))
            lines.append(
                f"  - {fact.get('label')} = {fact.get('value')}{fact.get('unit', '')} "
                f"(via {fact.get('expression')}; {cites})"
            )
    return "\n".join(lines)


def _should_include_recon_context(state: ConversationState | None) -> bool:
    """Attach a compact report map when the chat has not established context yet."""
    if state is None:
        return True
    if state.turn_index <= 0:
        return True
    return not bool(state.seen_chart_ids)


def _safe_recon_prompt_block(ctx: ToolContext) -> str:
    try:
        recon = build_proactive_recon(ctx)
    except Exception as exc:
        logger.warning(
            "dashboard_ai_bot recon_context_failed err=%s",
            type(exc).__name__,
            exc_info=True,
        )
        return ""
    return _format_recon_for_prompt(recon)


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
    briefing: Briefing | None = None,
    state: ConversationState | None = None,
    cost_cap_usd: float = DEFAULT_COST_CAP_USD,
    report_context_note: str = "",
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

    turn_started_at = time.monotonic()

    streamer, supports_tools = _streamer_for(provider)
    if streamer is None:
        yield AgentEvent(type="error", text=f"Unknown provider: {provider!r}")
        yield AgentEvent(type="done")
        return
    selected_model = (model or "").strip() or _DEFAULT_MODEL_BY_PROVIDER.get(
        (provider or "").strip().lower(),
    )

    # Per-turn cost meter — tallied from provider usage events. The loop uses
    # this to short-circuit further tool rounds once we cross the cap.
    meter = CostMeter(
        model=selected_model or "",
        cap_usd=max(0.0, float(cost_cap_usd or 0.0)) or DEFAULT_COST_CAP_USD,
    )

    # Phase A + B: pour briefing + conversation state into the system prompt
    briefing_block = format_briefing_for_prompt(briefing) if briefing else ""
    state_block = format_state_for_prompt(state) if state else ""

    base_system = build_agent_system_prompt(
        dashboard_name=ctx.dashboard.name or "Dashboard",
        dashboard_description=getattr(ctx.dashboard, "description", "") or "",
        chart_count=len(ctx.allowed_chart_ids),
        filters_applied=ctx.public_filters,
        max_tool_calls=max_tool_calls,
        report_context_note=report_context_note,
        briefing_block=briefing_block,
        conversation_state_block=state_block,
    )

    # The opening chat turn should feel like a DA has already skimmed the
    # report, not like the model is starting blind and hoping to pick the
    # right tools. Keep this compact and let later tool calls verify details.
    system_with_context = base_system
    if (not supports_tools) or _should_include_recon_context(state):
        recon_block = _safe_recon_prompt_block(ctx)
        if recon_block:
            system_with_context = base_system + "\n\n" + recon_block

    # ── Gemini fallback path: single-shot with stuffed Insight Packs ─────────
    if not supports_tools:
        # Buffer text so we can extract findings for the next turn
        buffered: list[str] = []
        async for ev in streamer(
            api_key=api_key,
            system_prompt=system_with_context,
            messages=user_messages,
            tools=None,
            model=selected_model or None,
        ):
            if ev.type == "text" and ev.text:
                buffered.append(ev.text)
            if ev.type == "usage":
                meter.add_usage(ev.extra or {})
                yield AgentEvent(type="cost", extra={"cost": meter.to_dict()})
                continue
            yield ev
        # Update state from this turn even on the gemini single-shot path
        if state is not None:
            last_user = ""
            for m in reversed(user_messages):
                if m.get("role") == "user":
                    last_user = str(m.get("content") or "")
                    break
            new_state = _evolve_state(
                state=state,
                draft_answer="".join(buffered),
                tool_log=[],
                briefing=briefing,
                user_question=last_user,
            )
            yield AgentEvent(
                type="state",
                extra={"state": new_state.to_dict()},
            )
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
    # Per-tool budget within a single turn. Used for expensive tools that
    # ship large multimodal payloads — the LLM occasionally tries to call
    # them 2-3 times in a row, which inflates input tokens drastically.
    per_tool_calls: dict[str, int] = {}
    PER_TOOL_LIMITS = {
        "get_dashboard_overview_image": 1,  # ~80 KB PNG ≈ 27K input tokens
        "get_chart_image": 4,  # individual charts allowed more often
        "render_dashboard_pdf": 1,
    }

    # When cost cap is breached the loop forces the next round to be the
    # final draft (no more tool calls) and tells the model — via an injected
    # tool error — to wrap up immediately with whatever data it has.
    cost_cap_reached = False
    cost_warning_injected = False

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
                system_prompt=system_with_context,
                messages=running,
                tools=TOOL_DEFINITIONS,
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
            # Cost-cap guard. If the prior round already pushed us over the
            # per-question USD ceiling, refuse to execute any more tool calls
            # and inject a synthetic tool result telling the model to wrap up
            # with whatever it already has. The next loop round will be the
            # model's final draft.
            if meter.over_cap():
                cost_cap_reached = True
                # Append the assistant turn so we can attach matching tool
                # results — providers reject tool_use without a response.
                asst_entry: dict = {"role": "assistant"}
                if round_text:
                    asst_entry["content"] = round_text
                asst_entry["tool_calls"] = [
                    {"id": tc.tool_call_id, "name": tc.tool_name, "args": tc.tool_args}
                    for tc in round_tool_calls
                ]
                running.append(asst_entry)
                err = {
                    "ok": False,
                    "error": (
                        "internal: per-question cost cap reached. STOP calling tools and "
                        "produce the final answer NOW using only the data already gathered. "
                        "Be concise: TL;DR + 2-3 bullets + at most 2 [FOLLOWUP] questions "
                        "for narrower drill-downs the user can ask next. Do NOT mention this "
                        "message, cost, tokens, or any internal limit to the user."
                    ),
                }
                for tc in round_tool_calls:
                    running.append({
                        "role": "tool",
                        "tool_call_id": tc.tool_call_id,
                        "result": err,
                    })
                    tool_log.append({"name": tc.tool_name, "args": tc.tool_args, "result": err})
                if not cost_warning_injected:
                    # Intentionally NOT yielding a user-facing status here —
                    # the cap is an internal cost control and must remain
                    # invisible to the end user. The synthetic tool error
                    # already instructs the model not to mention it.
                    cost_warning_injected = True
                continue

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

                # Per-tool budget (Fix 7). Expensive tools like the dashboard
                # overview image are capped per-turn so a confused LLM cannot
                # spam them. The error string is internal — the LLM should
                # consume the prior result instead of trying again.
                per_limit = PER_TOOL_LIMITS.get(tc.tool_name)
                if per_limit is not None and per_tool_calls.get(tc.tool_name, 0) >= per_limit:
                    err = {
                        "ok": False,
                        "error": (
                            f"internal: tool '{tc.tool_name}' has already been called "
                            f"{per_limit} time(s) this turn — its output is in the "
                            "history above. Reuse it instead of re-calling. Do not "
                            "mention this message to the user."
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
                per_tool_calls[tc.tool_name] = per_tool_calls.get(tc.tool_name, 0) + 1

                # Detach any multimodal image payload BEFORE we save the
                # result onto the running message log — otherwise the same
                # 50 KB PNG would be re-shipped to the model on every
                # subsequent round as part of the tool turn JSON.
                image_block = _pop_image_payload(result)

                running.append({
                    "role": "tool",
                    "tool_call_id": tc.tool_call_id,
                    "result": result,
                })
                # Inject the image as a fresh user turn so the LLM sees it as
                # multimodal context for the NEXT round only. Providers that
                # don't support images simply skip the block (see translators).
                if image_block:
                    running.append({
                        "role": "user",
                        "content": (
                            f"(Hình minh hoạ chart {tc.tool_args.get('chart_id')} "
                            f"từ tool get_chart_image — kind={image_block['kind']})"
                        ),
                        "image_blocks": [image_block],
                    })

                # Sanitised copy for the tool log (no PNG, no fluff)
                tool_log.append({
                    "name": tc.tool_name,
                    "args": tc.tool_args,
                    "result": _scrub_for_log(result),
                })

                # Optional: emit tool_result event for FE debug; we keep it light.
                yield AgentEvent(
                    type="tool_result",
                    tool_call_id=tc.tool_call_id,
                    tool_name=tc.tool_name,
                    tool_result=_scrub_for_log(result),
                )

            # Loop again so the LLM can react to the tool results
            continue

        # No tool calls in this round → this is the model's draft final answer.
        draft_answer_parts.append(round_text)
        break

    draft_answer = "".join(draft_answer_parts).strip()
    cost_cap_reached = cost_cap_reached or meter.over_cap()
    if not draft_answer:
        # The model produced nothing — emit a graceful fallback
        yield AgentEvent(
            type="text",
            text="Tôi chưa đủ dữ liệu để đưa ra câu trả lời. Vui lòng thử câu hỏi cụ thể hơn.",
        )
        yield AgentEvent(type="done")
        return

    # ── Self-critique pass ──────────────────────────────────────────────────
    buffered_text = ""
    # Skip the critique LLM call if we already blew through the cost cap —
    # the draft itself is the user-visible answer in that mode.
    run_critique = enable_critique and last_user_question and not cost_cap_reached
    if run_critique:
        yield AgentEvent(
            type="status",
            text="Đang viết câu trả lời…",
            tool_name="_thinking",
        )
        # Buffer the critique output so we can run a deterministic post-filter
        # before showing it to the user. We forward all non-text events live.
        async for ev in critique_and_stream(
            streamer=streamer,
            api_key=api_key,
            user_question=last_user_question,
            tool_log=tool_log,
            draft_answer=draft_answer,
            model=selected_model,
            state_block=state_block,
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
        cleaned = _sanitize_answer(buffered_text)
        if cleaned:
            yield AgentEvent(type="text", text=cleaned)
    else:
        yield AgentEvent(type="text", text=_sanitize_answer(draft_answer))

    elapsed_ms = int((time.monotonic() - turn_started_at) * 1000)
    final_answer_text = (
        _sanitize_answer(buffered_text) if run_critique else draft_answer
    )
    try:
        telemetry = _telemetry_summary(
            answer=final_answer_text,
            tool_log=tool_log,
            elapsed_ms=elapsed_ms,
        )
        logger.info(
            "dashboard_ai_bot turn complete provider=%s model=%s telemetry=%s question=%r",
            provider,
            selected_model or "(default)",
            telemetry,
            last_user_question[:120],
        )
    except Exception:
        logger.debug("dashboard_ai_bot telemetry compute failed", exc_info=True)

    # Emit updated conversation state so the FE can pass it back next turn.
    if state is not None:
        try:
            new_state = _evolve_state(
                state=state,
                draft_answer=final_answer_text,
                tool_log=tool_log,
                briefing=briefing,
                user_question=last_user_question,
            )
            yield AgentEvent(
                type="state",
                extra={"state": new_state.to_dict()},
            )
        except Exception:
            logger.exception("dashboard_ai_bot state evolve failed")

    yield AgentEvent(type="done")


def _evolve_state(
    *,
    state: ConversationState,
    draft_answer: str,
    tool_log: list[dict],
    briefing: Briefing | None,
    user_question: str = "",
) -> ConversationState:
    """Apply this turn's results to the state, return the new snapshot.

    Mutates a copy — never the caller's instance — so we can safely send
    the result over SSE without aliasing.
    """
    next_turn = state.turn_index + 1
    new_findings_full = extract_findings_from_answer(
        answer=draft_answer,
        turn_index=next_turn,
        tool_log=tool_log,
    )
    seen = list(state.seen_chart_ids)
    for cid in collect_seen_chart_ids(tool_log):
        if cid not in seen:
            seen.append(cid)

    # De-duplicate findings: keep the latest version when claim text is similar
    merged: list = list(state.findings)
    for nf in new_findings_full:
        # Drop any old finding that targets the same chart_id and looks similar
        merged = [
            f for f in merged
            if not (
                set(f.chart_ids) == set(nf.chart_ids)
                and _claim_similarity(f.claim, nf.claim) > 0.8
            )
        ]
        merged.append(nf)
    # Cap
    merged = merged[-30:]

    # Cross-turn contradiction telemetry (logged only — critique handles user-facing)
    pairs = detect_cross_turn_contradictions(state, new_findings_full)
    if pairs:
        logger.info(
            "dashboard_ai_bot cross-turn contradictions=%d turn=%d",
            len(pairs), next_turn,
        )

    # Hypothesis lifecycle: extract from current user msg + flip status of
    # existing open hypotheses against the new findings.
    hypotheses = list(state.hypotheses)
    if user_question:
        new_hyp = extract_hypotheses_from_user(user_question, turn_index=next_turn)
        existing_texts = {h.text for h in hypotheses}
        for h in new_hyp:
            if h.text not in existing_texts:
                hypotheses.append(h)
    hypotheses = update_hypothesis_status(hypotheses, new_findings_full)
    hypotheses = hypotheses[-20:]

    return ConversationState(
        briefing=briefing if briefing else state.briefing,
        findings=merged,
        hypotheses=hypotheses,
        turn_index=next_turn,
        seen_chart_ids=seen[-50:],
    )


def _pop_image_payload(result: dict) -> dict | None:
    """Extract & remove any multimodal image payload from a tool result.

    Returns ``{"png_base64": "...", "kind": "...", "media_type": "image/png"}``
    when the tool flagged itself as multimodal. The caller can then attach
    that as a real provider image block in the next user message.
    """
    if not isinstance(result, dict) or not result.get("ok"):
        return None
    data = result.get("data")
    if not isinstance(data, dict) or not data.get("_multimodal"):
        return None
    png = data.pop("png_base64", None)
    kind = data.pop("png_kind", "image")
    data.pop("_multimodal", None)
    if not png:
        return None
    # Replace with a small marker so the LLM still knows an image accompanied
    # the result without us shipping the PNG twice.
    data["image_attached"] = True
    data["image_kind"] = kind
    return {
        "png_base64": png,
        "kind": kind,
        "media_type": "image/png",
    }


def _scrub_for_log(result: dict) -> dict:
    """Make a shallow copy of a tool result safe to log/echo, with any base64
    PNG payload elided. Idempotent — safe to call after _pop_image_payload."""
    if not isinstance(result, dict):
        return result
    out = dict(result)
    data = out.get("data")
    if isinstance(data, dict) and "png_base64" in data:
        d = dict(data)
        d.pop("png_base64", None)
        d["png_omitted"] = True
        out["data"] = d
    return out


def _claim_similarity(a: str, b: str) -> float:
    """Cheap Jaccard-on-words similarity in [0, 1]."""
    if not a or not b:
        return 0.0
    sa = set(a.lower().split())
    sb = set(b.lower().split())
    if not sa or not sb:
        return 0.0
    inter = len(sa & sb)
    union = len(sa | sb)
    return inter / union if union else 0.0


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


# ── Telemetry & QA ──────────────────────────────────────────────────────────
#
# We compute a small quality score per answer for offline tuning. Logged at
# INFO level only — never sent to the user. Fields:
#   - bullet_count         (top-level bullets in body, follow-ups excluded)
#   - has_drilldown        (was get_chart_data called?)
#   - confidence_dist      ({HIGH, MED, LOW} counts in body)
#   - tool_calls           (total tools used this turn)
#   - contradiction_pairs  (bullets making opposite claims about same entity)
#   - elapsed_ms

_BULLET_RE = re.compile(r"^\s*(?:[-*•]|\d+\.)\s+")
_CONFIDENCE_RE = re.compile(r"\[(HIGH|MED|LOW)\]", re.IGNORECASE)
# Heuristic: "no <entity>" vs "<number> <entity>" within the same answer.
# Common Vietnamese patterns: "không có ... nào", "chưa có ...".
_NEGATIVE_RE = re.compile(
    r"(không\s+có|chưa\s+có|no\s+|zero\s+|0\s+\w+)\s+([\w\s\u00C0-\u1EF9]{3,40}?)\s+(nào|đang|active|hoạt động)?",
    re.IGNORECASE,
)


def _split_bullets(text: str) -> list[str]:
    out = []
    for line in text.split("\n"):
        if _BULLET_RE.match(line):
            out.append(line.strip())
    return out


def _detect_contradictions(bullets: list[str]) -> int:
    """Crude check: bullet says "no X" while another bullet quotes a positive count of X.

    Returns the number of contradicting pairs. Only used for telemetry —
    real correction is the model's job per prompt rule 3a + critique rule 4.
    """
    pairs = 0
    negatives = []
    positives = []
    for b in bullets:
        low = b.lower()
        if any(neg in low for neg in ("không có", "chưa có", "no active", "zero ", "0 dự án", "0 project")):
            negatives.append(low)
        m = re.search(r"\b(\d{1,4})\s+(dự án|project|task|công việc|đơn|item)", low)
        if m and int(m.group(1)) > 0:
            positives.append((m.group(2), low))
    for neg in negatives:
        for entity, pos in positives:
            if entity in neg:
                pairs += 1
    return pairs


def _telemetry_summary(
    *,
    answer: str,
    tool_log: list[dict],
    elapsed_ms: int,
) -> dict:
    bullets = _split_bullets(answer)
    body_only = "\n".join(bullets)
    conf_counts = {"HIGH": 0, "MED": 0, "LOW": 0}
    for m in _CONFIDENCE_RE.findall(body_only):
        conf_counts[m.upper()] = conf_counts.get(m.upper(), 0) + 1
    tool_names = [t.get("name") for t in tool_log]

    # Multimodal cost accounting (Fix 8). Each PNG byte ≈ 1.33 base64 chars,
    # and Anthropic charges roughly 4 chars per token, so PNG kb ≈ 250
    # input tokens per kb (rough but in the right order of magnitude).
    image_kb_total = 0.0
    image_count = 0
    for entry in tool_log:
        result = entry.get("result") or {}
        data = result.get("data") if isinstance(result, dict) else None
        if isinstance(data, dict) and (data.get("png_kb") or data.get("png_omitted")):
            kb = data.get("png_kb") or 0
            try:
                image_kb_total += float(kb)
                image_count += 1
            except (TypeError, ValueError):
                pass
    estimated_image_tokens = int(image_kb_total * 256)  # ~256 input tokens per KB

    return {
        "bullet_count": len(bullets),
        "has_drilldown": "get_chart_data" in tool_names,
        "confidence_dist": conf_counts,
        "tool_calls": len(tool_log),
        "tool_names": tool_names,
        "contradiction_pairs": _detect_contradictions(bullets),
        "elapsed_ms": elapsed_ms,
        # Cost-tracking for multimodal payloads
        "image_count": image_count,
        "image_kb_total": round(image_kb_total, 1),
        "estimated_image_tokens": estimated_image_tokens,
    }
