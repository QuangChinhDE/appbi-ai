"""Briefing wizard — guess what this dashboard is about, then ask the user.

Flow:
  1. Frontend opens the bot, calls /ai/briefing/guess. Backend reads the
     recon (manifest + summaries) and produces a heuristic guess of:
       - domain        (sales / hr / task_management / finance / marketing / ops / generic)
       - role_audience (manager / analyst / executive / staff)  — default guess only
       - key_metrics   (the 2-4 chart_ids that look most "headline")
       - period_hint   (detected from time dim values)
       - confidence    (0..1)

  2. Frontend shows a 3-step wizard:
       - Step 1: confirm / correct the domain guess
       - Step 2: pick role + focus + timeframe
       - Step 3: backend builds an executive_brief (1 LLM call) using briefing

  3. Briefing is then injected into every chat turn's system prompt.

This module is pure (except `build_executive_brief` which calls the LLM).
All heuristics are best-effort and never fatal — if we can't guess, we
return ``domain="generic"`` and the wizard still works.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


# ── Domain dictionaries ──────────────────────────────────────────────────────
#
# Keyword → domain. Matched against chart names, dashboard name/description,
# and column names. Multi-language (VI + EN) because users mix both.

_DOMAIN_KEYWORDS: dict[str, tuple[str, ...]] = {
    "task_management": (
        "task", "công việc", "cong viec", "todo", "ticket", "deadline",
        "quá hạn", "qua han", "overdue", "hoàn thành", "hoan thanh",
        "completion", "assignee", "phân công", "phan cong", "sprint",
        "kanban", "workboard", "workflow", "subtask", "milestone",
    ),
    "sales": (
        "doanh thu", "doanh số", "doanh so", "revenue", "sale", "đơn hàng",
        "don hang", "order", "deal", "pipeline", "lead", "conversion",
        "khách hàng", "khach hang", "customer", "client", "quote",
        "opportunity", "win rate", "pipeline value",
    ),
    "hr": (
        "nhân sự", "nhan su", "employee", "staff", "headcount",
        "tuyển dụng", "tuyen dung", "recruit", "hiring", "onboarding",
        "lương", "luong", "salary", "payroll", "nghỉ", "nghi", "leave",
        "attendance", "chấm công", "cham cong", "performance review",
    ),
    "finance": (
        "chi phí", "chi phi", "expense", "cost", "ngân sách", "ngan sach",
        "budget", "forecast", "p&l", "profit", "lợi nhuận", "loi nhuan",
        "margin", "cashflow", "dòng tiền", "dong tien", "invoice",
        "thanh toán", "thanh toan", "payment", "ar", "ap", "balance",
        "ledger", "tax", "thuế", "thue",
    ),
    "marketing": (
        "campaign", "chiến dịch", "chien dich", "click", "impression",
        "ctr", "cpc", "cpm", "roas", "ad spend", "channel", "kênh",
        "kenh", "traffic", "conversion rate", "funnel marketing",
        "social", "engagement", "follower",
    ),
    "ops": (
        "production", "sản xuất", "san xuat", "inventory", "tồn kho",
        "ton kho", "warehouse", "kho", "supply chain", "shipment",
        "delivery", "giao hàng", "giao hang", "throughput", "uptime",
        "sla", "incident", "sự cố", "su co", "downtime",
    ),
    "support": (
        "ticket support", "csat", "nps", "response time", "phản hồi",
        "phan hoi", "first response", "resolution", "khiếu nại",
        "khieu nai", "complaint", "feedback khách",
    ),
    "education": (
        "học viên", "hoc vien", "student", "course", "khóa học",
        "khoa hoc", "lesson", "bài giảng", "bai giang", "enrollment",
        "completion rate học", "exam", "kiểm tra", "kiem tra",
    ),
}


_DOMAIN_LABELS_VI: dict[str, str] = {
    "task_management": "Quản lý công việc",
    "sales": "Kinh doanh / Bán hàng",
    "hr": "Nhân sự",
    "finance": "Tài chính",
    "marketing": "Marketing",
    "ops": "Vận hành / Sản xuất",
    "support": "Chăm sóc khách hàng",
    "education": "Đào tạo / Giáo dục",
    "generic": "Tổng hợp (đa lĩnh vực)",
}


# ── Role / focus / timeframe options exposed to the wizard ───────────────────

ROLE_OPTIONS: list[dict] = [
    {"value": "executive", "label_vi": "Lãnh đạo / Giám đốc",
     "hint_vi": "Cần bức tranh tổng thể, ưu tiên KPI và rủi ro lớn"},
    {"value": "manager", "label_vi": "Quản lý / Trưởng phòng",
     "hint_vi": "Cần điểm cần hành động, so sánh team / kỳ"},
    {"value": "analyst", "label_vi": "Phân tích / DA",
     "hint_vi": "Cần đào sâu, anomaly, correlation, distribution"},
    {"value": "staff", "label_vi": "Nhân viên / Vận hành",
     "hint_vi": "Cần biết task / chỉ tiêu cá nhân, top lỗi"},
]

FOCUS_OPTIONS: list[dict] = [
    {"value": "overview", "label_vi": "Hiệu suất tổng thể"},
    {"value": "issues", "label_vi": "Vấn đề cần xử lý"},
    {"value": "compare", "label_vi": "So sánh kỳ trước / phân khúc"},
    {"value": "deepdive", "label_vi": "Phân tích sâu một nhóm cụ thể"},
]

TIMEFRAME_OPTIONS: list[dict] = [
    {"value": "current_period", "label_vi": "Kỳ hiện tại (theo filter dashboard)"},
    {"value": "this_week", "label_vi": "Tuần này"},
    {"value": "this_month", "label_vi": "Tháng này"},
    {"value": "this_quarter", "label_vi": "Quý này"},
    {"value": "ytd", "label_vi": "Năm tới hiện tại (YTD)"},
]


# ── Briefing dataclass ──────────────────────────────────────────────────────


@dataclass
class Briefing:
    """User-confirmed briefing snapshot. Sent in every chat turn's payload."""
    domain: str = "generic"
    domain_label: str = ""
    role: str = "manager"        # executive | manager | analyst | staff
    focus: str = "overview"      # overview | issues | compare | deepdive
    timeframe: str = "current_period"
    custom_note: str = ""        # free-text the user added in step 2/3
    key_chart_ids: list[int] = field(default_factory=list)
    confirmed: bool = False

    def to_dict(self) -> dict:
        return {
            "domain": self.domain,
            "domain_label": self.domain_label,
            "role": self.role,
            "focus": self.focus,
            "timeframe": self.timeframe,
            "custom_note": self.custom_note,
            "key_chart_ids": list(self.key_chart_ids),
            "confirmed": bool(self.confirmed),
        }

    @classmethod
    def from_dict(cls, raw: Any) -> "Briefing":
        if not isinstance(raw, dict):
            return cls()
        return cls(
            domain=str(raw.get("domain") or "generic"),
            domain_label=str(raw.get("domain_label") or ""),
            role=str(raw.get("role") or "manager"),
            focus=str(raw.get("focus") or "overview"),
            timeframe=str(raw.get("timeframe") or "current_period"),
            custom_note=str(raw.get("custom_note") or "")[:600],
            key_chart_ids=[int(x) for x in (raw.get("key_chart_ids") or []) if isinstance(x, (int, float, str)) and str(x).isdigit()],
            confirmed=bool(raw.get("confirmed")),
        )


# ── Heuristic guess from recon ───────────────────────────────────────────────


def guess_briefing_from_recon(recon: dict, dashboard_name: str, dashboard_description: str) -> dict:
    """Best-effort domain / role / key-metric guess from a recon snapshot.

    Returns a JSON-able dict with:
      - domain, domain_label, confidence (0..1)
      - alt_domains: top-3 alternatives with scores
      - key_chart_ids: 2-4 chart_ids that look most headline-worthy
      - timeframe_hint: a short string ("trong tháng 5/2026", "kỳ hiện tại")
      - headline_facts: 3 short facts the wizard can show in Step 1 to
        prove "we read the dashboard" — each is {text, chart_id}
      - role_options / focus_options / timeframe_options: passed through so
        the FE doesn't have to know the catalog
    """
    manifest = recon.get("manifest") or {}
    charts = manifest.get("charts") or []
    summaries = recon.get("summaries") or []

    blob_parts: list[str] = [dashboard_name or "", dashboard_description or ""]
    for c in charts:
        blob_parts.append(str(c.get("chart_name") or ""))
        blob_parts.append(str(c.get("description") or ""))
        for col in c.get("columns") or []:
            blob_parts.append(str(col))
    blob = " ".join(blob_parts).lower()

    scores: dict[str, int] = {}
    for domain, kws in _DOMAIN_KEYWORDS.items():
        s = 0
        for kw in kws:
            # Word-ish match; also count repeated occurrences
            s += blob.count(kw)
        if s > 0:
            scores[domain] = s

    if scores:
        ranked = sorted(scores.items(), key=lambda kv: -kv[1])
        top_domain, top_score = ranked[0]
        total = sum(s for _, s in ranked)
        confidence = min(1.0, top_score / max(total, 1) + 0.15)
        alt = [{"domain": d, "label": _DOMAIN_LABELS_VI.get(d, d), "score": s} for d, s in ranked[:3]]
    else:
        top_domain = "generic"
        confidence = 0.0
        alt = []

    domain_label = _DOMAIN_LABELS_VI.get(top_domain, top_domain)

    # Key chart identification: prefer KPI charts, then trends with strong
    # pct_change, then breakdowns with concentration_high.
    key_ids: list[int] = []
    kpis = [c for c in charts if c.get("role_hint") == "kpi"]
    for c in kpis[:3]:
        if isinstance(c.get("chart_id"), int):
            key_ids.append(c["chart_id"])

    # Add charts whose summary shows an actionable signal
    for pack in summaries:
        cid = pack.get("chart_id")
        if not isinstance(cid, int) or cid in key_ids:
            continue
        signals = pack.get("health_signals") or []
        trend = pack.get("trend") or {}
        is_strong_trend = (
            trend.get("direction") in ("up", "down")
            and trend.get("pct_change") is not None
            and abs(float(trend.get("pct_change") or 0)) >= 10
        )
        if "concentration_high" in signals or "completion_low" in signals \
                or "trend_up_strong" in signals or "trend_down_strong" in signals \
                or is_strong_trend:
            key_ids.append(cid)
        if len(key_ids) >= 4:
            break

    # If still empty, just take the first 3 charts
    if not key_ids:
        for c in charts[:3]:
            if isinstance(c.get("chart_id"), int):
                key_ids.append(c["chart_id"])

    # Headline facts — short, language matches dashboard description if VI
    headline_facts = _build_headline_facts(summaries, key_ids)

    timeframe_hint = _detect_timeframe_hint(summaries)

    return {
        "domain": top_domain,
        "domain_label": domain_label,
        "confidence": round(confidence, 2),
        "alt_domains": alt,
        "key_chart_ids": key_ids,
        "headline_facts": headline_facts,
        "timeframe_hint": timeframe_hint,
        "role_options": ROLE_OPTIONS,
        "focus_options": FOCUS_OPTIONS,
        "timeframe_options": TIMEFRAME_OPTIONS,
        "domain_catalog": [
            {"value": k, "label": v} for k, v in _DOMAIN_LABELS_VI.items()
        ],
    }


_DATE_RE = re.compile(r"(20\d{2})[-/](\d{1,2})(?:[-/](\d{1,2}))?")


def _detect_timeframe_hint(summaries: list[dict]) -> str:
    """Look at trend.last.x across summaries — the latest date wins."""
    latest: tuple[int, int] | None = None
    for pack in summaries:
        trend = pack.get("trend") or {}
        last = trend.get("last") or {}
        x = str(last.get("x") or "")
        m = _DATE_RE.search(x)
        if m:
            year = int(m.group(1))
            month = int(m.group(2))
            if latest is None or (year, month) > latest:
                latest = (year, month)
    if latest:
        return f"kỳ gần nhất phát hiện được trong dữ liệu là {latest[1]:02d}/{latest[0]}"
    return "kỳ hiện tại theo filter của dashboard"


def _build_headline_facts(summaries: list[dict], key_ids: list[int]) -> list[dict]:
    """Pick ≤3 short fact strings to show in Step 1 of the wizard.

    Goal: demonstrate that the bot has actually READ the dashboard, not just
    listed chart names. Each fact must include a chart_id citation token
    `[chart:N]` the FE renders as a chip.
    """
    facts: list[dict] = []
    by_id: dict[int, dict] = {p["chart_id"]: p for p in summaries if isinstance(p.get("chart_id"), int)}

    # Pass 1: pick KPI-style headline numbers from key_ids
    for cid in key_ids:
        pack = by_id.get(cid)
        if not pack:
            continue
        if len(facts) >= 3:
            break
        if pack.get("chart_role") == "kpi" and pack.get("primary_measure"):
            cols = pack.get("columns") or []
            measure_col = next(
                (c for c in cols if c.get("name") == pack["primary_measure"]),
                None,
            )
            if measure_col and measure_col.get("total") is not None:
                facts.append({
                    "text": f"{pack.get('chart_name') or 'Chỉ số'}: {_format_num(measure_col['total'])} [chart:{cid}]",
                    "chart_id": cid,
                })
                continue
        # Trend headline
        trend = pack.get("trend") or {}
        if trend and trend.get("direction") in ("up", "down") and trend.get("pct_change") is not None:
            arrow = "↑" if trend["direction"] == "up" else "↓"
            pct = abs(float(trend["pct_change"]))
            facts.append({
                "text": f"{pack.get('chart_name') or 'Chỉ số'} {arrow} {pct:.1f}% ({trend.get('first', {}).get('x')}→{trend.get('last', {}).get('x')}) [chart:{cid}]",
                "chart_id": cid,
            })
            continue
        # Concentration headline
        if pack.get("top_share_pct") is not None and pack["top_share_pct"] > 50 and pack.get("top_5"):
            top = pack["top_5"][0]
            dim = pack.get("primary_dimension") or ""
            label = top.get(dim) if dim else None
            facts.append({
                "text": (
                    f"{pack.get('chart_name') or 'Chỉ số'}: {label or 'phân khúc đầu'} "
                    f"chiếm {pack['top_share_pct']:.0f}% tổng [chart:{cid}]"
                ),
                "chart_id": cid,
            })
            continue

    # Pass 2: fill up with anything from summaries
    for pack in summaries:
        if len(facts) >= 3:
            break
        cid = pack.get("chart_id")
        if any(f["chart_id"] == cid for f in facts):
            continue
        if pack.get("primary_measure") and pack.get("top_5"):
            top = pack["top_5"][0]
            dim = pack.get("primary_dimension") or ""
            measure = pack["primary_measure"]
            label = top.get(dim) if dim else None
            val = top.get(measure)
            if label and val is not None:
                facts.append({
                    "text": f"{pack.get('chart_name')}: dẫn đầu là {label} ({_format_num(val)}) [chart:{cid}]",
                    "chart_id": cid,
                })
    return facts


def _format_num(v: Any) -> str:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    if abs(f) >= 1_000_000:
        return f"{f/1_000_000:.2f}M"
    if abs(f) >= 1_000:
        return f"{f/1_000:.1f}K"
    if abs(f - round(f)) < 1e-6:
        return f"{int(round(f))}"
    return f"{f:.2f}"


# ── Briefing formatter for system prompts ──────────────────────────────────


def format_briefing_for_prompt(briefing: Briefing | None) -> str:
    """Render a briefing as a short text block for the system prompt.

    Empty string when no briefing is set — the agent then falls back to
    domain-agnostic behavior.
    """
    if not briefing or not briefing.confirmed:
        return ""
    lines = ["═══ USER BRIEFING (đã confirm) ═══"]
    lines.append(f"Lĩnh vực dashboard: {briefing.domain_label or briefing.domain}")
    lines.append(f"Vai trò người hỏi: {_role_label(briefing.role)}")
    lines.append(f"Trọng tâm phiên này: {_focus_label(briefing.focus)}")
    lines.append(f"Khung thời gian: {_timeframe_label(briefing.timeframe)}")
    if briefing.key_chart_ids:
        ids_str = ", ".join(f"chart:{i}" for i in briefing.key_chart_ids)
        lines.append(f"Các biểu đồ quan trọng (KPI / signal): {ids_str}")
    if briefing.custom_note:
        lines.append(f"Ghi chú thêm của user: {briefing.custom_note}")
    lines.append(
        "Treat this briefing as a dynamic lens, not a fixed conclusion. "
        "If the report data or the user's latest question points elsewhere, "
        "follow the report and cite the relevant charts."
    )
    lines.append("")
    lines.append("→ Khi triage và viết câu trả lời, ƯU TIÊN góc nhìn phù hợp với vai trò và trọng tâm trên.")
    lines.append(_role_priority_block(briefing.role))
    return "\n".join(lines)


def _role_label(role: str) -> str:
    for r in ROLE_OPTIONS:
        if r["value"] == role:
            return r["label_vi"]
    return role


def _focus_label(focus: str) -> str:
    for f in FOCUS_OPTIONS:
        if f["value"] == focus:
            return f["label_vi"]
    return focus


def _timeframe_label(tf: str) -> str:
    for t in TIMEFRAME_OPTIONS:
        if t["value"] == tf:
            return t["label_vi"]
    return tf


def _role_priority_block(role: str) -> str:
    """Role-aware re-ordering of the Phase-4 priority rules in the main prompt."""
    if role == "executive":
        return (
            "Ưu tiên cho LÃNH ĐẠO: 1 KPI quan trọng nhất + 1 rủi ro lớn nhất + 1 hành động đề xuất. "
            "Ngắn gọn, không thuật ngữ kỹ thuật. Dùng ngôn ngữ kết luận."
        )
    if role == "analyst":
        return (
            "Ưu tiên cho ANALYST: anomaly / outlier / correlation / distribution skew. "
            "Đưa số P50, P90, gap so với median, và đề xuất tool tiếp theo cần chạy."
        )
    if role == "staff":
        return (
            "Ưu tiên cho NHÂN VIÊN VẬN HÀNH: top 5 mục cần xử lý ngay (overdue, lỗi, KPI cá nhân). "
            "Tránh tổng hợp tổng thể; tập trung vào hành động cụ thể."
        )
    # manager (default)
    return (
        "Ưu tiên cho QUẢN LÝ: 1-2 health signal (completion thấp / overdue cao / trend xấu) + "
        "1 so sánh kỳ/segment + 1 đề xuất hành động."
    )


# ── Executive brief generation (LLM) ─────────────────────────────────────────


EXEC_BRIEF_SYSTEM_PROMPT = """\
Bạn là Senior Data Analyst. Đầu vào là một bản recon dashboard (manifest +
insight pack tự động) cùng briefing từ user. Hãy viết MỘT đoạn tóm tắt
"Executive Brief" tối đa 180 từ theo đúng template:

  TL;DR: <1 câu kết luận cao nhất, có số liệu, có [chart:N]>

  Điểm cần chú ý:
  - <bullet 1, có số liệu, [chart:N], [HIGH|MED|LOW]>
  - <bullet 2, có số liệu, [chart:N], [HIGH|MED|LOW]>
  - <bullet 3 — chỉ thêm nếu thực sự đáng>

  [FOLLOWUP] <câu hỏi gợi ý 1>
  [FOLLOWUP] <câu hỏi gợi ý 2>
  [FOLLOWUP] <câu hỏi gợi ý 3>

QUY TẮC:
  - VIẾT 100% bằng tiếng Việt (briefing user có thể có chữ EN, KỆ).
  - MỌI số liệu phải có [chart:N] đi kèm — N chính xác từ recon.
  - Ưu tiên insight thật (concentration, trend mạnh, completion thấp,
    cross-chart link) — KHÔNG liệt kê thuần các con số tổng.
  - Tuân thủ vai trò user (executive / manager / analyst / staff): chọn
    bullet phù hợp.
  - KHÔNG bịa, KHÔNG suy diễn nguyên nhân ("có thể do..."), KHÔNG nhắc
    tới giới hạn hệ thống.
  - TÊN THỰC TỪ DỮ LIỆU: dùng đúng chuỗi label từ recon (ví dụ
    "Department Chi tạo", "Phòng QA"). KHÔNG đổi thành "khối ngành không
    xác định" / "một phòng ban" khi label đã có — chỉ dùng mô tả mờ khi
    label thực sự NULL/rỗng.
  - 3 dòng [FOLLOWUP] là 3 câu hỏi MÀ user CẦN hỏi tiếp để hành động —
    không phải câu hỏi rộng kiểu "kể thêm đi".
"""


def build_executive_brief_user_prompt(
    *,
    briefing: Briefing,
    recon: dict,
    report_context_note: str = "",
) -> str:
    """Compact text representation of recon + briefing for the brief LLM call."""
    lines: list[str] = []
    lines.append("## Briefing user đã confirm")
    lines.append(f"- Lĩnh vực: {briefing.domain_label or briefing.domain}")
    lines.append(f"- Vai trò: {_role_label(briefing.role)}")
    lines.append(f"- Trọng tâm: {_focus_label(briefing.focus)}")
    lines.append(f"- Khung thời gian: {_timeframe_label(briefing.timeframe)}")
    if briefing.custom_note:
        lines.append(f"- Ghi chú: {briefing.custom_note}")
    if briefing.key_chart_ids:
        lines.append(f"- Chart quan trọng theo briefing: {briefing.key_chart_ids}")
    if report_context_note.strip():
        lines.append(f"- Report mindset note: {report_context_note.strip()[:1200]}")
    lines.append("")
    lines.append("## Recon snapshot")
    manifest = recon.get("manifest") or {}
    charts = manifest.get("charts") or []
    lines.append(f"Tên dashboard: {manifest.get('dashboard_name')}")
    lines.append(f"Số chart: {len(charts)}")
    for c in charts:
        lines.append(
            f"  - [chart:{c.get('chart_id')}] {c.get('chart_name')!r} "
            f"role={c.get('role_hint')} type={c.get('chart_type')}"
        )
    for pack in recon.get("summaries") or []:
        cid = pack.get("chart_id")
        lines.append(f"\n### Insight pack [chart:{cid}] {pack.get('chart_name')!r}")
        for k in (
            "chart_role", "primary_measure", "primary_dimension",
            "empty_state", "top_share_pct", "trend",
            "outliers", "health_signals", "top_5",
        ):
            if pack.get(k):
                lines.append(f"{k}: {pack[k]}")
    cross = recon.get("cross_compute") or []
    if cross:
        lines.append("\n### Pre-computed cross-chart facts")
        for fact in cross:
            lines.append(f"- {fact}")
    lines.append("")
    lines.append("→ Viết Executive Brief đúng template trong system prompt.")
    return "\n".join(lines)
