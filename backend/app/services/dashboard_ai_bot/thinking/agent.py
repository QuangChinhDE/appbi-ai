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
import uuid
from typing import AsyncGenerator

from app.core.config import settings

from app.services.dashboard_ai_bot.thinking.briefing import (
    Briefing,
    format_briefing_for_prompt,
)
from app.services.dashboard_ai_bot.thinking.conversation_state import (
    ConversationState,
    Hypothesis,
    collect_seen_chart_ids,
    detect_cross_turn_contradictions,
    extract_findings_from_answer,
    extract_hypotheses_from_user,
    format_state_for_prompt,
    update_hypothesis_status,
)
from app.services.dashboard_ai_bot.thinking.critique import critique_and_stream
from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.dashboard_ai_bot.thinking.prompts import build_agent_system_prompt
from app.services.dashboard_ai_bot.providers.guarded import guarded_stream
from app.services.dashboard_ai_bot.providers import (
    stream_anthropic,
    stream_gemini_singleshot,
    stream_openai,
)
from app.services.dashboard_ai_bot.thinking.tools import (
    EXTERNAL_TOOL_DEFS,
    TOOL_DEFINITIONS,
    ToolContext,
    execute_tool,
    tool_get_chart_summary,
    tool_list_charts,
)
from app.services.dashboard_ai_bot.cost import CostMeter

logger = logging.getLogger(__name__)

# Phase 16.1 — trimmed 16→10. gpt-4o over-calls tools (seen: 12-16 rounds for
# a "top 3 categories" question that needs 1). Each round on a tight-TPM org
# risks a 429 → the cap is also a latency/cost guard, not just a runaway
# backstop. 10 still allows read-several-charts + a couple compares; the
# force_no_tools finalize handles anything that wants more.
MAX_TOOL_CALLS_PER_TURN = 10
# Phase 15.76 — recon trimmed 10 → 3 to give gpt-4o "zoom để phát
# triển". The previous 10-chart pre-fetch packed ~5K tokens of inline
# data into the system prompt before the user's question even arrived,
# crowding out the model's attention budget. 3 charts is enough to
# give a feel for the dashboard's shape; the LLM can lazily fetch the
# rest via get_chart_summary when it actually needs them.
RECON_MAX_CHARTS = 3
# NOTE: claude-3-5-haiku-20241022 was RETIRED by Anthropic (2026-02-19) and
# now 404s — the anthropic default MUST stay on a live alias. Aliases (no
# date suffix) auto-track snapshot updates.
_DEFAULT_MODEL_BY_PROVIDER = {
    "anthropic": "claude-haiku-4-5",
    "openai": "gpt-4o-mini",
    "gemini": "gemini-2.5-flash",
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
    "smart_drilldown": "Đang lọc chart {chart_id} theo {column}={match}…",
    "explain_change": "Đang phân rã nguyên nhân thay đổi theo {breakdown}…",
    "forecast_measure": "Đang chiếu xu hướng cho chart {chart_id}…",
    "web_search": "Đang tra cứu thông tin thị trường/ngành trên web…",
    "fetch_url": "Đang đọc nội dung trang nguồn…",
    "benchmark_compare": "Đang đối chiếu số liệu báo cáo với chuẩn ngoài ngành…",
}


_WEB_INTENT_RE = re.compile(
    r"(nghiên cứu thị trường|nghien cuu thi truong|tra cứu|tra cuu|tìm hiểu thị trường|"
    r"tim hieu thi truong|trên web|tren web|trên mạng|tren mang|benchmark|chuẩn ngành|"
    r"chuan nganh|so với ngành|so voi nganh|toàn ngành|toan nganh|đối thủ|doi thu|"
    r"thị trường|thi truong|industry|market|competitor)",
    re.IGNORECASE,
)


def _has_web_intent(question: str) -> bool:
    """Does the question clearly want EXTERNAL market/industry context?"""
    return bool(_WEB_INTENT_RE.search(question or ""))


def _hash_public_filters(filters) -> str:
    from app.services.dashboard_ai_bot.evidence import hash_filters
    return hash_filters(filters)


def _verify_turn(run_ref: str, answer: str) -> dict | None:
    """Compare the answer's figures against this turn's evidence rows."""
    from app.core.database import SessionLocal
    from app.services.dashboard_ai_bot.evidence import load_run_numbers
    from app.services.dashboard_ai_bot.verifier import verify_answer

    db = SessionLocal()
    try:
        numbers = load_run_numbers(db, run_ref)
    finally:
        db.close()
    result = verify_answer(answer, numbers)
    return result.to_dict()


def _record_evidence(**kwargs) -> None:
    """Thin wrapper so the ledger import stays lazy and a missing/disabled
    evidence module can never break a turn."""
    try:
        from app.services.dashboard_ai_bot.evidence import record_tool_evidence
        record_tool_evidence(**kwargs)
    except Exception:  # noqa: BLE001
        logger.debug("evidence record failed", exc_info=True)


def _status_text(tool_name: str, args: dict) -> str:
    template = _TOOL_STATUS_VI.get(tool_name) or f"Đang chạy {tool_name}…"
    try:
        return template.format(**(args or {}))
    except (KeyError, IndexError):
        return _TOOL_STATUS_VI.get(tool_name) or f"Đang chạy {tool_name}…"


def _streamer_for(provider: str):
    """Resolve the provider adapter, wrapped in the breaker/retry guard.

    The guard is applied HERE rather than inside each adapter so all three
    vendors share one retry policy, and so a rate-limited customer key cuts out
    only that key (see providers/breaker.py) instead of the whole process.
    """
    p = (provider or "").strip().lower()
    if p == "anthropic":
        return guarded_stream(stream_anthropic, provider="anthropic"), True
    if p == "openai":
        return guarded_stream(stream_openai, provider="openai"), True
    if p == "gemini":
        return guarded_stream(stream_gemini_singleshot, provider="gemini"), False
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

    # Parallel fan-out. Phase-15.70 fix: SQLAlchemy sessions are NOT
    # thread-safe — sharing ctx.db across workers triggered
    # `InvalidRequestError: This session is provisioning a new
    # connection; concurrent operations are not permitted` when 2+
    # tools queried metadata in parallel. Each worker now opens its
    # own short-lived session via SessionLocal and clones the
    # ToolContext to use it; the cloned context still sees the same
    # dashboard / allowed_chart_ids / public_filters so allowlist + cache
    # semantics are preserved.
    from app.core.database import SessionLocal
    from dataclasses import replace as _dc_replace

    def _run_one(cid: int) -> dict:
        worker_db = SessionLocal()
        try:
            worker_ctx = _dc_replace(ctx, db=worker_db, _chart_data_cache={})
            return tool_get_chart_summary(worker_ctx, {"chart_id": cid})
        finally:
            worker_db.close()

    # Phase 15.74 — bumped per-chart timeout from 12s → 30s. Production
    # data sources (BigQuery, slow PostgreSQL) routinely exceed 12s on
    # a cold parallel fan-out; the silent drop was causing every chart
    # summary to vanish from the recon snapshot, leaving the LLM
    # convinced the dashboard had no data when in fact the dashboard
    # rendered fine (just slower than the bot's old timeout allowed).
    results: dict[int, dict] = {}
    failures: dict[int, str] = {}
    with ThreadPoolExecutor(max_workers=min(6, len(chart_ids))) as pool:
        futures = {pool.submit(_run_one, cid): cid for cid in chart_ids}
        for fut in as_completed(futures):
            cid = futures[fut]
            try:
                results[cid] = fut.result(timeout=30)
            except Exception as exc:
                failures[cid] = type(exc).__name__
                logger.warning(
                    "recon summary failed chart_id=%s err=%s",
                    cid,
                    type(exc).__name__,
                )

    # Preserve manifest order + populate the cross-turn LRU so the LLM's
    # later `get_chart_summary` calls hit cache instead of refetching
    # (Phase 15.72 Option A). The recon ran with the same dashboard +
    # filters, so the key set is identical.
    #
    # Phase 15.74 — also backfill the manifest's total_rows from each
    # successful summary. The manifest came back from list_charts
    # light=True with total_rows=None; the summary pack has the real
    # count. Otherwise the snapshot printed "rows=None" for every chart
    # even when we had the data sitting right here.
    from app.services.dashboard_ai_bot.summary_cache import put_cached_pack
    dashboard_id_for_cache = getattr(ctx.dashboard, "id", None)
    manifest_data = manifest.get("data") or {}
    manifest_charts = manifest_data.get("charts") or []
    rows_by_chart: dict[int, int] = {}
    for cid in chart_ids:
        res = results.get(cid)
        if res and res.get("ok"):
            pack_data = res["data"]
            summaries.append(pack_data)
            if isinstance(pack_data, dict):
                tr = pack_data.get("total_rows")
                if isinstance(tr, int):
                    rows_by_chart[cid] = tr
            if isinstance(dashboard_id_for_cache, int) and isinstance(pack_data, dict):
                put_cached_pack(
                    dashboard_id_for_cache,
                    ctx.public_filters,
                    cid,
                    pack_data,
                )
    if rows_by_chart:
        for chart_entry in manifest_charts:
            cid = chart_entry.get("chart_id")
            if isinstance(cid, int) and cid in rows_by_chart:
                chart_entry["total_rows"] = rows_by_chart[cid]

    # Auto cross-chart heuristics: if two summaries share a common keyword
    # (e.g. one chart's name says "tổng / total" and another says "quá hạn /
    # overdue"), pre-compute a ratio so the LLM doesn't need an extra
    # `compute` call. Best-effort, never fatal.
    cross_compute = _auto_cross_compute(summaries)

    return {
        "manifest": manifest.get("data") or {},
        "summaries": summaries,
        "cross_compute": cross_compute,
        # Phase 15.74 — surface which chart fetches died so we can warn
        # the LLM in the snapshot. Silent drops here were the root cause
        # of "Tôi chưa đủ dữ liệu" on prod even with no filters applied.
        "failures": failures,
        "requested_chart_ids": list(chart_ids),
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
    # Report page flow (the DA's narrative). For an overview, walk pages in
    # THIS order and cover every page — not just page 1.
    _pages = manifest.get("pages") or []
    if _pages:
        _name_by_id = {c.get("chart_id"): c.get("chart_name") for c in charts}
        lines.append("\n─── REPORT FLOW (pages, in order) ───")
        for _i, _p in enumerate(_pages, 1):
            _cnames = [
                str(_name_by_id.get(cid) or f"chart {cid}")
                for cid in (_p.get("chart_ids") or [])
            ]
            lines.append(f"  {_i}. {_p.get('name')}: " + (", ".join(_cnames) or "(no charts)"))
        lines.append(
            "For a full overview, present findings page by page in this order; "
            "the same chart may recur across pages."
        )
    packs_for_snapshot = recon.get("summaries") or []
    failures = recon.get("failures") or {}
    requested_ids = recon.get("requested_chart_ids") or []
    # Phase 15.74 — surface failed pre-fetch loudly. The previous code
    # silently dropped charts that exceeded the 12s timeout, leaving the
    # LLM with the impression the dashboard was empty. We now keep
    # failures in the recon bundle and warn the LLM about which charts
    # we couldn't pre-load so it can either retry them lazily via
    # get_chart_summary or explain the partial coverage to the user.
    if failures:
        successful = len(packs_for_snapshot)
        total_requested = len(requested_ids) or (successful + len(failures))
        lines.append(
            f"\n⚠️ RECON PARTIAL — {successful}/{total_requested} chart "
            f"summaries pre-loaded successfully; "
            f"{len(failures)} failed/timed out. "
            f"Failed chart_ids: {sorted(failures.keys())}. "
            "If the user asks about one of these charts, call "
            "`get_chart_summary` directly (the source data may just be "
            "slow). DO NOT conclude the dashboard is empty just because "
            "those packs are missing from this snapshot."
        )
    # Phase 15.73 — detect the "all empty" condition that previously
    # caused the bot to bail with generic "không có dữ liệu". Surface it
    # Phase 15.75 — removed the all-empty / partial-empty banners.
    # They pressured the LLM into a fixed playbook ("you MUST name the
    # mismatch …") that backfired on healthy dashboards where some
    # packs were genuinely small. The recon partial warning above (when
    # fetches FAIL) is still useful and stays.
    # Phase 16.1 — cap the per-chart manifest listing. On a 70-chart
    # dashboard this block was ~70 lines re-sent on EVERY round of every
    # turn, a major driver of the per-org TPM 429s that aborted analytical
    # turns. The page-flow section above already names every chart grouped
    # by page; the detailed role/type/rows lines only need to cover a
    # working set — the model can `list_charts` for the rest.
    _MANIFEST_CAP = 18
    lines.append(f"\nCharts: {len(charts)} (details for first {min(_MANIFEST_CAP, len(charts))})")
    for c in charts[:_MANIFEST_CAP]:
        role = c.get("role_hint") or "?"
        rows_val = c.get("total_rows")
        # Phase 15.74 — distinguish "we haven't checked yet" (None) from
        # "the chart genuinely has 0 rows" (0). Both look like falsy to a
        # casual reader but mean very different things to the LLM.
        rows_disp = "?" if rows_val is None else str(rows_val)
        lines.append(
            f"  - [chart:{c.get('chart_id')}] {c.get('chart_name')!r} "
            f"role={role} type={c.get('chart_type')} rows={rows_disp}"
        )
    if len(charts) > _MANIFEST_CAP:
        lines.append(
            f"  … +{len(charts) - _MANIFEST_CAP} more charts — call `list_charts` "
            "for the full manifest when you need one not listed above."
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
            # Top-3 is enough context in the snapshot; the model calls
            # get_chart_summary for the full top-5 when it drills in.
            lines.append(f"top_3: {pack['top_5'][:3]}")
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


def build_proactive_recon_cached(ctx: ToolContext) -> dict:
    """Recon with the cross-surface TTL cache (Phase 16.1 latency fix).

    /ai/recon (bot open) → briefing guess → executive brief → first chat
    turn all need the same snapshot for the same (dashboard, filters); the
    first caller builds, the rest hit cache. Chat turns stop paying 3 live
    chart queries in their critical path.
    """
    from app.services.dashboard_ai_bot.summary_cache import (
        get_cached_recon,
        put_cached_recon,
    )
    dashboard_id = getattr(ctx.dashboard, "id", None)
    if isinstance(dashboard_id, int):
        cached = get_cached_recon(dashboard_id, ctx.public_filters)
        if cached is not None:
            logger.debug("[perf] recon cache=HIT dashboard_id=%s", dashboard_id)
            return cached
    started = time.monotonic()
    recon = build_proactive_recon(ctx)
    logger.info(
        "[perf] recon cache=MISS dashboard_id=%s built_ms=%d summaries=%d",
        dashboard_id, int((time.monotonic() - started) * 1000),
        len(recon.get("summaries") or []),
    )
    if isinstance(dashboard_id, int):
        put_cached_recon(dashboard_id, ctx.public_filters, recon)
    return recon


def _should_include_recon_context(state: ConversationState | None) -> bool:
    """Attach a compact report map when the chat has not established context yet."""
    if state is None:
        return True
    if state.turn_index <= 0:
        return True
    return not bool(state.seen_chart_ids)


def _safe_recon_prompt_block(ctx: ToolContext) -> str:
    try:
        recon = build_proactive_recon_cached(ctx)
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
    enable_critique: bool = False,
    max_tool_calls: int = MAX_TOOL_CALLS_PER_TURN,
    briefing: Briefing | None = None,
    state: ConversationState | None = None,
    web_search_enabled: bool = False,
    guide_mode: bool = False,
    report_context_note: str = "",
    learned_knowledge_block: str = "",
    run_ref: str | None = None,
    role_prompt: str = "",
    tool_allowlist: set[str] | None = None,
    owns_verification: bool = True,
) -> AsyncGenerator[AgentEvent, None]:
    """Run one chat turn end-to-end and yield AgentEvent objects.

    `user_messages` is the running history of the conversation including the
    user's latest question. Each entry is a dict with at minimum `role` and
    `content`. Assistant turns from previous rounds may also include
    ``tool_calls`` (see providers/anthropic_provider.py for the shape).

    ``role_prompt`` and ``tool_allowlist`` are how a FLOW STEP narrows this same
    loop into one specialist, instead of the flow forking its own copy.

    `role_prompt` is APPENDED to the engine's system prompt, never a
    replacement. That is deliberate: the base prompt carries the analysis
    guardrails, the insight ladder, the citation/confidence contract and the
    "answer in the language of the question" rule. A flow author writes what
    this STEP is for; they do not get to delete the rules that keep answers
    honest — and a pipeline built from replacement prompts would silently lose
    every one of them.

    `tool_allowlist` restricts which tools this step may call. A composer given
    no tools cannot invent a number, because it has no way to fetch one; that
    property is the point of splitting analysis from writing.
    """
    if not user_messages or not isinstance(user_messages, list):
        yield AgentEvent(type="error", text="No messages provided.")
        yield AgentEvent(type="done")
        return

    turn_started_at = time.monotonic()
    # Evidence correlation id for this turn. Callers that already own a run id
    # (the flow runtime) pass theirs; otherwise we mint one so the ledger works
    # on the legacy path too.
    if run_ref is None and settings.INTELLIGENCE_EVIDENCE_ENABLED:
        run_ref = uuid.uuid4().hex
    _filter_hash = _hash_public_filters(ctx.public_filters)

    streamer, supports_tools = _streamer_for(provider)
    if streamer is None:
        yield AgentEvent(type="error", text=f"Unknown provider: {provider!r}")
        yield AgentEvent(type="done")
        return
    selected_model = (model or "").strip() or _DEFAULT_MODEL_BY_PROVIDER.get(
        (provider or "").strip().lower(),
    )

    # Per-turn cost meter — tallied from provider usage events for server-side
    # telemetry only. The per-question cost ceiling was removed (2026-06-23);
    # max_tool_calls bounds runaway tool loops.
    meter = CostMeter(model=selected_model or "")

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
    #
    # Phase 16.1 latency fix: the recon build runs live chart queries — it
    # MUST NOT run inline in this async generator (it blocked the whole
    # event loop for 25s+ on big dashboards and the user saw dead air).
    # Offload to a worker thread, show a status line meanwhile, and let the
    # cross-surface TTL cache (warmed by /ai/recon on bot open) make the
    # common case instant.
    system_with_context = base_system
    # A flow step's authored role, appended so the engine's rules stay above it.
    if role_prompt.strip():
        system_with_context += (
            "\n\n═══ VAI TRÒ CỦA BƯỚC NÀY (do người dựng luồng viết) ═══\n"
            + role_prompt.strip()
            + "\n\nCác quy tắc phía trên vẫn có hiệu lực và không được bỏ qua."
        )
    # Institutional memory: what the bot has LEARNED about this company across
    # prior sessions (validated concepts/facts/insights). Injected before recon
    # so domain understanding frames the fresh data read.
    if learned_knowledge_block:
        system_with_context += "\n\n" + learned_knowledge_block
    if (not supports_tools) or _should_include_recon_context(state):
        yield AgentEvent(
            type="status",
            text="Đang đọc cấu trúc báo cáo…",
            tool_name="_thinking",
        )
        recon_block = await asyncio.to_thread(_safe_recon_prompt_block, ctx)
        if recon_block:
            system_with_context += "\n\n" + recon_block

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
    # Offer the web-search tool only when the admin enabled it for this link
    # (domain know-how beyond the report's own data).
    active_tools = (
        [*TOOL_DEFINITIONS, *EXTERNAL_TOOL_DEFS] if web_search_enabled else TOOL_DEFINITIONS
    )
    if tool_allowlist is not None:
        # A flow step declares its own toolset. An EMPTY allowlist is a real
        # instruction — "this step may not fetch anything" — so it must yield an
        # empty list, not fall back to everything. `is not None` rather than a
        # truthiness test is doing that work.
        active_tools = [t for t in active_tools if t.get("name") in tool_allowlist]
        logger.info(
            "[flow] step toolset narrowed to %d of %d tools",
            len(active_tools), len(TOOL_DEFINITIONS),
        )

    last_user_question = ""
    for msg in reversed(user_messages):
        if msg.get("role") == "user":
            last_user_question = str(msg.get("content") or "")
            break

    # Market-research intent: the model (esp. gpt-4o-mini) is reluctant to call
    # web_search even when asked — it answers from memory. If the question
    # clearly wants external/market/industry context AND web_search is enabled,
    # we REQUIRE a web_search before the final answer (nudge-and-loop, like the
    # reading-plan gate) so it cites real sources instead of inventing them.
    web_intent = web_search_enabled and _has_web_intent(last_user_question)
    web_search_called = False
    web_nudge_sent = False
    # Guide mode: track which charts got summarized so we can deterministically
    # append "related chart" chips (the model emits them unreliably).
    summarized_chart_ids: list[int] = []

    # Internal running message log (we own the shape; provider adapters translate)
    running: list[dict] = list(user_messages)

    # Aggregated trace for the critique pass
    tool_log: list[dict] = []

    draft_answer_parts: list[str] = []
    tool_calls_made = 0
    reading_plan_emitted = False
    # Phase 15.72 — remember the latest plan items + which step is "next"
    # so we can emit plan_step events that update the FE badge as the
    # agent works through the plan.
    reading_plan_items: list[dict] = []
    plan_step_status: list[str] = []  # pending/running/done, by step index
    # Per-tool budget within a single turn. Used for expensive tools that
    # ship large multimodal payloads — the LLM occasionally tries to call
    # them 2-3 times in a row, which inflates input tokens drastically.
    per_tool_calls: dict[str, int] = {}
    PER_TOOL_LIMITS = {
        "render_dashboard_pdf": 1,
    }
    # Repeated-failure circuit breaker. A tool that keeps returning ok=False
    # (e.g. compare_periods on a categorical axis, where the LLM blindly
    # guesses period strings) can otherwise burn the entire per-turn tool
    # budget retrying. After MAX_TOOL_FAILURES failures of the SAME tool we
    # refuse further calls to it and tell the model to use what it has.
    per_tool_failures: dict[str, int] = {}
    MAX_TOOL_FAILURES = 2

    # Runaway-loop guard. Injecting a "stop calling tools" tool-result and
    # continuing relied on the model CHOOSING to stop — a stubborn model
    # (seen on ds67: 50 rounds, 398K tokens, no answer) ignores it and loops
    # until the hard timeout, burning the org's whole TPM budget. Two hard
    # stops: (1) once the tool budget is spent, force the NEXT LLM call with
    # tools DISABLED so the model physically cannot call another tool and
    # must emit prose; (2) an absolute round ceiling as a final backstop.
    force_no_tools = False
    rounds = 0
    HARD_ROUND_CAP = max_tool_calls + 4

    while True:
        rounds += 1
        if rounds > HARD_ROUND_CAP:
            logger.warning(
                "dashboard_ai_bot hard round cap hit (%d) — forcing finalize",
                HARD_ROUND_CAP,
            )
            force_no_tools = True
        # Show a thinking indicator while the model decides what to do next
        # (between tool rounds, or before the very first model call). This is
        # what the user sees as a transient "Đang suy nghĩ…" bubble.
        yield AgentEvent(
            type="status",
            text=(
                "Đang đọc báo cáo & lập kế hoạch phân tích…" if tool_calls_made == 0
                else "Đang tổng hợp câu trả lời…" if force_no_tools
                else "Đang phân tích kết quả…"
            ),
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
                # Disable tools once the budget is spent → the model must
                # answer with what it has instead of looping on tool calls.
                # `or None` covers a step whose allowlist filtered everything
                # out: providers reject an empty tools array, and "no tools" is
                # exactly what an empty allowlist means anyway.
                tools=None if force_no_tools else (active_tools or None),
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
                yield AgentEvent(type="text", text="".join(draft_answer_parts))
            yield AgentEvent(type="done")
            return

        round_text = "".join(round_text_parts).strip()

        if round_tool_calls:
            # Phase 16.1 — the 15.71c "PHASE 0 missing" nudge (synthetic tool
            # error forcing emit_reading_plan before any data tool) was a full
            # extra LLM round-trip on nearly every Thinking turn: models
            # usually go straight for data, ate the nudge, replanned, and the
            # user paid ~2-6s + one prompt re-send for a panel they may not
            # even look at. The plan tool stays offered + recommended in the
            # prompt; when the model emits it we render it — we just no
            # longer tax every turn to force it.

            # Append the assistant turn (any preamble text + tool_calls)
            asst_entry: dict = {"role": "assistant"}
            if round_text:
                asst_entry["content"] = round_text
            asst_entry["tool_calls"] = [
                {"id": tc.tool_call_id, "name": tc.tool_name, "args": tc.tool_args}
                for tc in round_tool_calls
            ]
            running.append(asst_entry)

            if tool_calls_made >= max_tool_calls:
                # Budget spent. Answer every outstanding tool call with a
                # neutral "wrap up" result AND flip force_no_tools so the NEXT
                # round is a tools-disabled call — the model then physically
                # cannot loop on more tool calls and must emit the final prose.
                # (Previously we injected this error and `continue`d without
                # disabling tools, so a stubborn model looped to the timeout.)
                force_no_tools = True
                err = {
                    "ok": False,
                    "error": (
                        "internal: tool budget spent — do NOT call more tools. "
                        "Write the final answer now from the data already gathered. "
                        "Do not mention this message, tool budgets, or any system "
                        "limit to the user; omit any sub-point you cannot support."
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

                # Repeated-failure circuit breaker. If this tool has already
                # failed MAX_TOOL_FAILURES times this turn, stop letting the
                # model retry it — it is almost certainly inapplicable to this
                # data (e.g. period comparison on a categorical chart).
                if per_tool_failures.get(tc.tool_name, 0) >= MAX_TOOL_FAILURES:
                    err = {
                        "ok": False,
                        "error": (
                            f"internal: tool '{tc.tool_name}' has already failed "
                            f"{MAX_TOOL_FAILURES} times this turn — it does not apply to "
                            "this chart/data. Stop calling it and answer with the data you "
                            "already have, or tell the user this analysis isn't applicable "
                            "here. Do not mention this message to the user."
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

                # Phase 15.72 Option C — find a matching plan step for
                # this tool call. Match by chart_id when the tool carries
                # one; otherwise pick the next still-pending step. Emit
                # plan_step(running) before exec.
                step_idx = _match_plan_step(
                    reading_plan_items,
                    plan_step_status,
                    tc.tool_args,
                    tc.tool_name,
                )
                if step_idx is not None and plan_step_status[step_idx] != "running":
                    plan_step_status[step_idx] = "running"
                    yield AgentEvent(
                        type="plan_step",
                        extra={
                            "step_index": step_idx,
                            "chart_id": reading_plan_items[step_idx].get("chart_id"),
                            "status": "running",
                        },
                    )

                # Execute (sync function; offload to thread to avoid blocking event loop)
                result = await asyncio.to_thread(
                    execute_tool, ctx, tc.tool_name, tc.tool_args
                )
                tool_calls_made += 1
                per_tool_calls[tc.tool_name] = per_tool_calls.get(tc.tool_name, 0) + 1
                if isinstance(result, dict) and result.get("ok") is False:
                    per_tool_failures[tc.tool_name] = per_tool_failures.get(tc.tool_name, 0) + 1
                if tc.tool_name == "web_search":
                    web_search_called = True
                if tc.tool_name == "get_chart_summary":
                    _cid = tc.tool_args.get("chart_id")
                    if isinstance(_cid, int) and _cid not in summarized_chart_ids:
                        summarized_chart_ids.append(_cid)

                if step_idx is not None and isinstance(result, dict) and result.get("ok"):
                    plan_step_status[step_idx] = "done"
                    yield AgentEvent(
                        type="plan_step",
                        extra={
                            "step_index": step_idx,
                            "chart_id": reading_plan_items[step_idx].get("chart_id"),
                            "status": "done",
                        },
                    )

                running.append({
                    "role": "tool",
                    "tool_call_id": tc.tool_call_id,
                    "result": result,
                })

                # Evidence ledger (P1-01): one row per executed tool, so every
                # figure in the final answer can be traced back to the call that
                # produced it. Own session, best-effort, off by default.
                if run_ref:
                    await asyncio.to_thread(
                        _record_evidence,
                        run_ref=run_ref,
                        dashboard_id=getattr(ctx.dashboard, "id", 0) or 0,
                        tool_name=tc.tool_name,
                        args=tc.tool_args,
                        result=result,
                        filter_hash=_filter_hash,
                    )

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

                # Surface web-search SOURCES (title+url) so the FE can show the
                # links the answer drew on — the user can open them to verify.
                if (
                    tc.tool_name == "web_search"
                    and isinstance(result, dict)
                    and result.get("ok")
                    and isinstance(result.get("data"), dict)
                ):
                    srcs = [
                        {"title": r.get("title") or r.get("url"), "url": r.get("url")}
                        for r in (result["data"].get("results") or [])
                        if isinstance(r, dict) and r.get("url")
                    ][:6]
                    if srcs:
                        yield AgentEvent(type="sources", extra={"sources": srcs})

                # Phase-15.71 — surface the reading plan to the FE as a
                # first-class event so the UI can render an "AI đang đọc"
                # collapsible panel BEFORE the prose answer streams in.
                # The tool itself ack'd the LLM with a short string; the
                # rich plan payload only goes to the FE channel.
                if tc.tool_name == "emit_reading_plan" and isinstance(result, dict):
                    data = result.get("data") if result.get("ok") else None
                    if isinstance(data, dict) and data.get("items"):
                        reading_plan_emitted = True
                        # Capture the items so subsequent tool calls can
                        # be matched against them and emit plan_step
                        # progress events.
                        reading_plan_items = list(data.get("items") or [])
                        plan_step_status = ["pending"] * len(reading_plan_items)
                        yield AgentEvent(
                            type="reading_plan",
                            extra={
                                "items": reading_plan_items,
                                "overall_goal": data.get("overall_goal"),
                            },
                        )

            # Loop again so the LLM can react to the tool results
            continue

        # Market-research gate: the question wants external/industry context but
        # the model is about to answer WITHOUT having searched. Force one
        # web_search (don't let it invent benchmarks from memory), then re-loop.
        if (
            web_intent
            and not web_search_called
            and not web_nudge_sent
            and tool_calls_made < max_tool_calls
        ):
            asst_entry = {"role": "assistant"}
            if round_text:
                asst_entry["content"] = round_text
            running.append(asst_entry)
            running.append({
                "role": "user",
                "content": (
                    "internal: Câu hỏi này cần dữ liệu THỊ TRƯỜNG/NGÀNH thực tế. "
                    "BẮT BUỘC gọi tool `web_search` với truy vấn phù hợp để lấy số "
                    "liệu/nguồn thật, KHÔNG được bịa benchmark từ trí nhớ. Sau khi "
                    "có kết quả web, trả lời và gắn nhãn [WEB] cho dữ kiện ngoài. "
                    "Đừng nhắc tới tin nhắn nội bộ này."
                ),
            })
            web_nudge_sent = True
            yield AgentEvent(
                type="status",
                text="Đang tra cứu thông tin thị trường trên web…",
                tool_name="_thinking",
            )
            continue

        # No tool calls in this round → this is the model's draft final answer.
        # Phase 15.71c — if the LLM produced a final answer on the first
        # round without ever emitting a reading plan (typically because the
        # RECON snapshot already contained enough context), synthesize a
        # minimal one so the FE still has the "AI đang đọc" panel to show.
        # This keeps the analyst-style UX consistent even for trivial Qs.
        if not reading_plan_emitted and tool_calls_made == 0:
            synth_items = [
                {
                    "phase": "triage",
                    "question": (
                        "Đọc manifest dashboard từ RECON snapshot để xác định "
                        "phạm vi câu hỏi."
                    ),
                },
                {
                    "phase": "synthesize",
                    "question": "Trả lời trực tiếp từ context đã có.",
                },
            ]
            yield AgentEvent(
                type="reading_plan",
                extra={
                    "items": synth_items,
                    "overall_goal": (
                        "Trả lời câu hỏi đơn giản dựa trên context có sẵn, "
                        "không cần fetch dữ liệu chi tiết."
                    ),
                },
            )
            reading_plan_emitted = True
            # Register the synthetic steps so the end-of-turn completion loop
            # marks them done (otherwise the badge stays stuck at "0/N").
            reading_plan_items = synth_items
            plan_step_status = ["pending"] * len(synth_items)
        draft_answer_parts.append(round_text)
        break

    # The plan-step badge must not be left stranded at "0/N". Any step still
    # pending/running once the answer is ready is marked done so the FE panel
    # reads complete instead of looking stuck.
    for _i, _st in enumerate(plan_step_status):
        if _st != "done":
            plan_step_status[_i] = "done"
            yield AgentEvent(
                type="plan_step",
                extra={
                    "step_index": _i,
                    "chart_id": (reading_plan_items[_i] or {}).get("chart_id")
                    if _i < len(reading_plan_items) else None,
                    "status": "done",
                },
            )

    draft_answer = "".join(draft_answer_parts).strip()
    if not draft_answer:
        # Phase 15.75 — back to a simple, non-prescriptive fallback.
        # The 15.73 retry-loop + filter-mismatch-blaming fallback put
        # too much pressure on the LLM and was making it bail more
        # often, not less. If the model still produced nothing after
        # the tool round, surface a clear, neutral message and let the
        # user re-ask.
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

    # Guide mode: deterministically append "related chart" chips for the charts
    # we summarized this turn (the model emits them unreliably). Rendered as
    # clickable [FOLLOWUP] chips on the FE so the user jumps between linked
    # charts without losing the thread.
    guide_suffix = ""
    if guide_mode and summarized_chart_ids:
        from app.services.dashboard_ai_bot.tool_context import compute_related_charts
        rel = compute_related_charts(ctx.chart_meta)
        seen: set[str] = set()
        lines: list[str] = []
        for _cid in summarized_chart_ids:
            for r in rel.get(_cid, []):
                nm = str(r.get("chart_name") or "").strip()
                if nm and nm not in seen and nm not in draft_answer:
                    seen.add(nm)
                    lines.append(f"[FOLLOWUP] Xem biểu đồ liên quan: {nm}")
        if lines:
            guide_suffix = "\n" + "\n".join(lines[:5])

    # ── Self-critique pass ──────────────────────────────────────────────────
    buffered_text = ""
    run_critique = enable_critique and last_user_question
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
            yield AgentEvent(type="text", text=cleaned + guide_suffix)
    else:
        yield AgentEvent(type="text", text=_sanitize_answer(draft_answer) + guide_suffix)

    elapsed_ms = int((time.monotonic() - turn_started_at) * 1000)
    final_answer_text = (
        _sanitize_answer(buffered_text) if run_critique else draft_answer
    )

    # ── Deterministic verification (P1-02) ─────────────────────────────────
    # Runs AFTER the answer has been streamed. In "log" mode that is the whole
    # point: measure how often the assistant states a figure the evidence does
    # not support, on real traffic, before anything is allowed to act on it.
    # The event is emitted for the FE/telemetry; it does not alter the answer.
    # A flow step must NOT verify: it produced part of a pipeline, not the
    # answer. Each step running this block emitted its own verification event
    # for a partial text, so a three-step flow reported three verdicts and the
    # viewer's client kept the last one. The flow's Verify node is the single
    # authority, and it is the only one that can still change the answer.
    if owns_verification and run_ref and settings.INTELLIGENCE_VERIFIER_MODE != "off":
        try:
            verification = await asyncio.to_thread(
                _verify_turn, run_ref, final_answer_text,
            )
            if verification is not None:
                yield AgentEvent(
                    type="verification", extra={"verification": verification},
                )
                if verification.get("unmatched"):
                    logger.warning(
                        "dashboard_ai_bot unsupported figures run=%s coverage=%s "
                        "unmatched=%s question=%r",
                        run_ref, verification.get("coverage"),
                        verification.get("unmatched"), last_user_question[:120],
                    )
        except Exception:
            logger.debug("verification failed", exc_info=True)

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


def _match_plan_step(
    items: list[dict],
    statuses: list[str],
    tool_args: dict,
    tool_name: str,
) -> int | None:
    """Pick a reading_plan step to flip into the "running" badge.

    Strategy:
      1. If `tool_args.chart_id` matches an item with the same chart_id
         that isn't already done, return its index.
      2. Otherwise pick the next item whose status is still "pending"
         and has no chart_id (synthesis / triage steps).
      3. Otherwise None — silent miss is fine; FE just keeps the prior
         status for that step.
    Skips emit_reading_plan itself (we don't badge the planning step).
    """
    if not items or tool_name == "emit_reading_plan":
        return None
    cid_arg = tool_args.get("chart_id") if isinstance(tool_args, dict) else None
    if isinstance(cid_arg, int):
        for idx, item in enumerate(items):
            if (
                item.get("chart_id") == cid_arg
                and idx < len(statuses)
                and statuses[idx] != "done"
            ):
                return idx
    # Fallback: next pending step that doesn't bind to a chart
    for idx, item in enumerate(items):
        if (
            item.get("chart_id") is None
            and idx < len(statuses)
            and statuses[idx] == "pending"
        ):
            return idx
    return None


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
    """Phase 15.72 — log-only sanitizer. Does NOT drop bullets.

    Earlier revisions deleted any bullet containing a "forbidden" phrase
    ("có thể là", "tool budget", "due to limitations"). In practice the
    LLM frequently emitted valid bullets with hedge words ("có thể tăng
    nhẹ trong tháng tới") and the sanitizer silently nuked them, leaving
    the user with shorter, choppier answers than the bot actually
    produced — a key driver of the quality regression flagged on 2026-05-21.

    The system prompt already bans these patterns; if the model still
    leaks one we log it for offline tuning instead of mutating the
    user-visible answer. The TWO truly user-hostile phrases (tool budget
    / system limit hallucinations) stay loud in logs so we notice if
    they sneak past the prompt.
    """
    if not text:
        return ""
    low = text.lower()
    limit_leaks = [p for p in _FORBIDDEN_PHRASES if p in low]
    speculation_leaks = [p for p in _SPECULATIVE_MARKERS if p in low]
    if limit_leaks:
        logger.warning(
            "dashboard_ai_bot answer leaked system-limit phrase(s)=%s "
            "(left in user output — prompt should have suppressed)",
            limit_leaks,
        )
    if speculation_leaks:
        logger.info(
            "dashboard_ai_bot answer contains hedged phrase(s)=%s",
            speculation_leaks,
        )
    return text


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
