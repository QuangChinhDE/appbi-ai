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

import logging
import re
import time


from app.services.dashboard_ai_bot.providers.guarded import guarded_stream
from app.services.dashboard_ai_bot.providers import (
    stream_anthropic,
    stream_gemini_singleshot,
    stream_openai,
)
from app.services.dashboard_ai_bot.thinking.tools import ToolContext, tool_get_chart_summary, tool_list_charts

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






# Main loop ───────────────────────────────────────────────────────────────────










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






