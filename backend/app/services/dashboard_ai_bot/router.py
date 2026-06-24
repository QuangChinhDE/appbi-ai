"""Auto-router — decide Normal (lookup) vs Thinking (analysis) per question.

The Normal/Thinking split is a *unit-of-work* distinction, not a cost knob:
Normal answers "what is X / show me X" (retrieval); Thinking answers
"why / compare / what should I do" (investigation). Forcing the viewer to
pick is the wrong UX, so this heuristic picks the starting depth from the
question text alone — cheap, deterministic, ZERO extra LLM call.

It is intentionally imperfect: the band between the two thresholds defaults
to Normal (cheap/fast) and is flagged ``escalatable`` so a later layer (a
mid-flight promotion or a post-answer "đào sâu hơn?" affordance) can deepen
without the classifier needing to be perfect.

Bilingual (Vietnamese-first + English). Vietnamese is matched both with and
without diacritics since DAs frequently type unaccented.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class RouteDecision:
    mode: str                       # "normal" | "thinking"
    score: float
    reasons: list[str] = field(default_factory=list)
    escalatable: bool = False

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "score": round(self.score, 2),
            "reasons": list(self.reasons),
            "escalatable": self.escalatable,
        }


# Default to Normal in the ambiguous middle band — Normal is cheap/fast and
# the escalation hooks cover under-scoping. Tune on real traffic (see the
# `route` telemetry event) before tightening.
T_HIGH = 3.0   # score ≥ → Thinking
T_LOW = 0.0    # score ≤ → Normal


def _rx(pattern: str) -> re.Pattern:
    return re.compile(pattern, re.IGNORECASE)


# (compiled pattern, weight, tag). Positive → analysis (Thinking),
# negative → lookup (Normal).
_RULES: list[tuple[re.Pattern, float, str]] = [
    # ── Strong analysis cues (+3) ──────────────────────────────────────────
    (_rx(r"\b(tại sao|tai sao|vì sao|vi sao|nguyên nhân|nguyen nhan|do đâu|do dau)\b"), 3, "why"),
    (_rx(r"(so sánh|so sanh|so với|so voi|đối chiếu|doi chieu|compare|versus|\bvs\b)"), 3, "compare"),
    (_rx(r"\b(xu hướng|xu huong|trend|tăng trưởng|tang truong|đà tăng|da tang)\b"), 3, "trend"),
    (_rx(r"\b(dự báo|du bao|dự đoán|du doan|forecast|predict|projection)\b"), 3, "forecast"),
    (_rx(r"\b(bất thường|bat thuong|đột biến|dot bien|anomaly|outlier|spike|sụt|sut giảm|sut giam)\b"), 3, "anomaly"),
    (_rx(r"\b(phân tích|phan tich|đánh giá|danh gia|analyze|analyse|assess|evaluate)\b"), 3, "analyze"),
    (_rx(r"\b(nên làm gì|nen lam gi|nên|recommend|đề xuất|de xuat|what should|action)\b"), 3, "recommend"),
    (_rx(r"\b(tương quan|tuong quan|correlat|liên hệ|lien he|mối quan hệ|moi quan he|relationship)\b"), 3, "correlate"),
    (_rx(r"\b(driver|yếu tố|yeu to|đóng góp|dong gop|bóc tách|boc tach|ảnh hưởng|anh huong|root cause)\b"), 3, "drivers"),
    # External/market research — needs the Thinking-only web_search tool, so
    # these must route to Thinking (Normal has no web access).
    (_rx(r"(tra cứu|tra cuu|tìm kiếm|tim kiem|search|trên web|tren web|chuẩn ngành|chuan nganh|benchmark|đối thủ|doi thu|thị trường|thi truong|toàn ngành|toan nganh|competitor|market)"), 3, "web_research"),
    (_rx(r"\b(giải thích|giai thich|explain|insight|đáng chú ý|dang chu y|đáng lo|dang lo)\b"), 3, "explain"),
    # ── Medium analysis cues (+2) ──────────────────────────────────────────
    (_rx(r"\b(giữa .{1,30} và|between .{1,30} and)\b"), 2, "between"),
    # Weak temporal-context cue (+1): only nudges — bare "tháng trước" is a
    # lookup; pair it with "so với" (compare, +3) to mean real comparison.
    (_rx(r"\b(kỳ trước|ky truoc|tháng trước|thang truoc|năm trước|nam truoc|quý trước|quy truoc|cùng kỳ|cung ky|kể từ|ke tu|mom|yoy|qoq)\b"), 1, "temporal"),
    (_rx(r"\b(nếu|neu|khi nào|khi nao|what if|giả sử|gia su)\b"), 1, "conditional"),
    # ── Lookup cues (negative) ─────────────────────────────────────────────
    (_rx(r"\b(bao nhiêu|bao nhieu|là bao nhiêu|how many|how much|what is|là gì|la gi)\b"), -2, "lookup_value"),
    (_rx(r"\b(cho xem|cho tôi xem|cho toi xem|hiển thị|hien thi|hiện|show|display|liệt kê|liet ke|list)\b"), -2, "show"),
    (_rx(r"\b(tổng|tong|total|sum|đếm|dem|count|số lượng|so luong)\b"), -1, "aggregate_simple"),
    (_rx(r"\b(mới nhất|moi nhat|hôm nay|hom nay|hiện tại|hien tai|latest|current|today)\b"), -1, "current"),
    (_rx(r"\btop ?\d+\b|\btop\b"), -1, "topn"),
]

# Short follow-up cues that mean "go deeper on the previous answer".
_FOLLOWUP_RX = _rx(
    r"\b(vậy còn|vay con|còn .{0,20} thì sao|con .{0,20} thi sao|thế còn|the con|"
    r"tại sao lại|tai sao lai|chi tiết hơn|chi tiet hon|đào sâu|dao sau|cụ thể hơn|cu the hon)\b"
)


def last_user_text(messages) -> str:
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user":
            return str(m.get("content") or "")
    return ""


def classify_question_mode(
    question: str,
    *,
    recent_messages=(),
) -> RouteDecision:
    q = (question or "").strip().lower()
    if not q:
        # No question text → nothing to investigate; cheapest path.
        return RouteDecision("normal", 0.0, ["empty"], escalatable=True)

    score = 0.0
    reasons: list[str] = []
    for pattern, weight, tag in _RULES:
        if pattern.search(q):
            score += weight
            reasons.append(tag)

    # Open-ended phrasing: long, multi-clause questions skew analytical.
    word_count = len(q.split())
    if word_count >= 18:
        score += 1
        reasons.append("long_question")

    # Conversation context: a short drill-down follow-up after an existing
    # exchange should inherit/raise depth even if the words look thin.
    has_history = any(
        isinstance(m, dict) and m.get("role") == "assistant" for m in (recent_messages or [])
    )
    if has_history and _FOLLOWUP_RX.search(q):
        # A drill-down follow-up after an exchange is where Thinking's
        # cross-turn comparison pays off — tip it over on its own.
        score += 3
        reasons.append("followup_drill")

    if score >= T_HIGH:
        return RouteDecision("thinking", score, reasons, escalatable=False)
    if score <= T_LOW:
        return RouteDecision("normal", score, reasons, escalatable=False)
    # Ambiguous middle → default Normal, but allow later deepening.
    return RouteDecision("normal", score, reasons, escalatable=True)
