"""Conversation-level state that persists across chat turns.

The frontend keeps the conversation history (user/assistant text) in its own
state. We let the FE also keep a STRUCTURED conversation state — briefing,
findings extracted from previous turns, hypotheses raised but not verified —
and pass it back to the backend on every chat turn.

This module provides:

  - ConversationState dataclass (briefing + findings + hypotheses)
  - extract_findings_from_answer(answer, tool_log) — scrape claims out of
    a finalized assistant turn so the next turn can avoid re-fetching them
  - format_state_for_prompt(state) — text block injected into system prompt
  - update_state_after_turn(state, answer, tool_log, ...) — mutate before
    sending state back to FE in the SSE `state` event

State design choice — STATELESS BACKEND. We do NOT persist this server-side.
Each turn:
  FE → BE: messages + briefing + previous_state
  BE → FE: SSE events including a final `state` event with the new state
  FE: stores state in component memory and reuses next turn

Pros: scales horizontally, no DB writes for what is effectively chat scratch.
Cons: ~2-4 KB of JSON travels each turn. Fine for our chat volume.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

from app.services.dashboard_ai_bot.briefing import Briefing

logger = logging.getLogger(__name__)


@dataclass
class Finding:
    """A single fact the bot has already established and cited."""
    claim: str                # short text, e.g. "completion rate là 47%"
    chart_ids: list[int]
    confidence: str           # HIGH | MED | LOW
    turn_index: int           # which turn produced this
    metric_value: float | None = None  # if a numeric value was extracted

    def to_dict(self) -> dict:
        return {
            "claim": self.claim,
            "chart_ids": list(self.chart_ids),
            "confidence": self.confidence,
            "turn_index": self.turn_index,
            "metric_value": self.metric_value,
        }

    @classmethod
    def from_dict(cls, raw: Any) -> "Finding | None":
        if not isinstance(raw, dict):
            return None
        try:
            return cls(
                claim=str(raw.get("claim") or "")[:280],
                chart_ids=[int(x) for x in (raw.get("chart_ids") or []) if isinstance(x, (int, float, str)) and str(x).lstrip("-").isdigit()],
                confidence=str(raw.get("confidence") or "MED").upper(),
                turn_index=int(raw.get("turn_index") or 0),
                metric_value=_to_float_or_none(raw.get("metric_value")),
            )
        except Exception:
            return None


@dataclass
class Hypothesis:
    """A claim raised in conversation but not yet proven against data."""
    text: str
    raised_in_turn: int
    status: str = "open"  # open | confirmed | rejected

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "raised_in_turn": self.raised_in_turn,
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, raw: Any) -> "Hypothesis | None":
        if not isinstance(raw, dict):
            return None
        try:
            return cls(
                text=str(raw.get("text") or "")[:280],
                raised_in_turn=int(raw.get("raised_in_turn") or 0),
                status=str(raw.get("status") or "open"),
            )
        except Exception:
            return None


@dataclass
class ConversationState:
    """All conversation-level state. JSON-roundtrippable."""
    briefing: Briefing = field(default_factory=Briefing)
    findings: list[Finding] = field(default_factory=list)
    hypotheses: list[Hypothesis] = field(default_factory=list)
    turn_index: int = 0          # incremented by the agent each turn

    # Charts the bot has already fully read in earlier turns (so it can
    # skip re-summarising them unless the user explicitly asks).
    seen_chart_ids: list[int] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "briefing": self.briefing.to_dict() if self.briefing else None,
            "findings": [f.to_dict() for f in self.findings],
            "hypotheses": [h.to_dict() for h in self.hypotheses],
            "turn_index": self.turn_index,
            "seen_chart_ids": list(self.seen_chart_ids),
        }

    @classmethod
    def from_dict(cls, raw: Any) -> "ConversationState":
        if not isinstance(raw, dict):
            return cls()
        briefing = Briefing.from_dict(raw.get("briefing") or {})
        findings_raw = raw.get("findings") or []
        hypotheses_raw = raw.get("hypotheses") or []
        findings = [Finding.from_dict(f) for f in findings_raw if isinstance(f, dict)]
        hypotheses = [Hypothesis.from_dict(h) for h in hypotheses_raw if isinstance(h, dict)]
        return cls(
            briefing=briefing,
            findings=[f for f in findings if f is not None][:30],   # hard cap
            hypotheses=[h for h in hypotheses if h is not None][:20],
            turn_index=int(raw.get("turn_index") or 0),
            seen_chart_ids=[int(x) for x in (raw.get("seen_chart_ids") or []) if isinstance(x, (int, float, str)) and str(x).lstrip("-").isdigit()][:50],
        )


def _to_float_or_none(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ── Extraction: parse assistant answer → findings ───────────────────────────

# Match a number followed by a [chart:N] tag in the same line.
# Captures the surrounding bullet text (~120 chars before the chart tag).
_FINDING_RE = re.compile(
    r"([^\n]{6,200}?)\s*(?:\[chart:(\d+)(?:\s*[—–-]\s*\"[^\"]+\")?\])"
    r"(?:\s*\[(HIGH|MED|LOW)\])?",
    re.IGNORECASE,
)
_NUMBER_RE = re.compile(r"(-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*(%|đồng|vnd|usd|k|tr|m|tỷ)?", re.IGNORECASE)


def extract_findings_from_answer(
    *,
    answer: str,
    turn_index: int,
    tool_log: list[dict],
) -> list[Finding]:
    """Scrape claim+citation pairs out of the finalized assistant text.

    A claim is the chunk of text PRECEDING a `[chart:N]` tag on the same line,
    optionally followed by a `[HIGH|MED|LOW]` confidence tag. Numbers in the
    claim are extracted as `metric_value`. Lines that are pure follow-ups
    (`[FOLLOWUP] ...`) are skipped.

    `tool_log` is currently unused but kept in signature so we can later cross-
    check claims against the actual tool results before saving them.
    """
    if not answer:
        return []
    findings: list[Finding] = []
    seen: set[tuple[str, tuple[int, ...]]] = set()
    for line in answer.split("\n"):
        clean = line.strip()
        if not clean or clean.lower().startswith("[followup]"):
            continue
        for match in _FINDING_RE.finditer(line):
            claim_text = match.group(1).strip(" -*•·:")
            try:
                chart_id = int(match.group(2))
            except (TypeError, ValueError):
                continue
            confidence = (match.group(3) or "MED").upper()
            if not claim_text:
                continue
            # Avoid pulling in markdown decoration only
            cleaned = _strip_decoration(claim_text)
            if len(cleaned) < 6:
                continue
            metric = _extract_first_number(cleaned)
            key = (cleaned[:120], (chart_id,))
            if key in seen:
                continue
            seen.add(key)
            findings.append(Finding(
                claim=cleaned[:240],
                chart_ids=[chart_id],
                confidence=confidence if confidence in ("HIGH", "MED", "LOW") else "MED",
                turn_index=turn_index,
                metric_value=metric,
            ))
            if len(findings) >= 12:
                return findings
    return findings


_DECORATION_RE = re.compile(r"\[(?:HIGH|MED|LOW)\]|\*\*|`|^[\s\-*•·]+", re.IGNORECASE | re.MULTILINE)


def _strip_decoration(text: str) -> str:
    out = re.sub(_DECORATION_RE, "", text)
    return re.sub(r"\s+", " ", out).strip()


def _extract_first_number(text: str) -> float | None:
    m = _NUMBER_RE.search(text)
    if not m:
        return None
    raw = m.group(1).replace(",", "")
    try:
        val = float(raw)
    except ValueError:
        return None
    suffix = (m.group(2) or "").lower()
    if suffix == "k":
        val *= 1_000
    elif suffix in ("tr", "m"):
        val *= 1_000_000
    elif suffix == "tỷ":
        val *= 1_000_000_000
    return val


# ── Tool log → seen_chart_ids update ────────────────────────────────────────


# ── Hypothesis extraction from user message ────────────────────────────────


_HYPOTHESIS_TRIGGERS = (
    "liệu", "có phải", "phải chăng", "tôi nghĩ", "tôi đoán",
    "tôi cho rằng", "có khi nào", "hình như",
    "is it true", "could it be", "i think", "maybe",
)


def extract_hypotheses_from_user(text: str, *, turn_index: int) -> list[Hypothesis]:
    """Detect hypothesis-flavored questions in the user's message.

    These are claims the user RAISES (not asserts) — the bot should later
    confirm/reject them with data.
    """
    if not text:
        return []
    out: list[Hypothesis] = []
    low = text.lower()
    for trig in _HYPOTHESIS_TRIGGERS:
        if trig in low:
            # Take the surrounding sentence (up to next period / question mark)
            for sentence in re.split(r"[.!?\n]+", text):
                if trig in sentence.lower():
                    cleaned = sentence.strip()[:240]
                    if cleaned and not any(h.text == cleaned for h in out):
                        out.append(Hypothesis(text=cleaned, raised_in_turn=turn_index, status="open"))
            break  # one extraction per turn is plenty
    return out[:3]


# ── Hypothesis status update from new findings ─────────────────────────────


def update_hypothesis_status(
    hypotheses: list[Hypothesis],
    findings: list[Finding],
) -> list[Hypothesis]:
    """If a finding's claim text shares ≥3 keywords with an open hypothesis,
    flip the hypothesis to "confirmed" (we don't currently distinguish
    rejected — the LLM will phrase the finding accordingly).
    """
    if not hypotheses or not findings:
        return hypotheses
    out: list[Hypothesis] = []
    for h in hypotheses:
        if h.status != "open":
            out.append(h)
            continue
        h_words = {w for w in re.findall(r"\w{4,}", h.text.lower()) if w}
        confirmed = False
        for f in findings:
            f_words = set(re.findall(r"\w{4,}", f.claim.lower()))
            if len(h_words & f_words) >= 3:
                confirmed = True
                break
        out.append(Hypothesis(
            text=h.text,
            raised_in_turn=h.raised_in_turn,
            status="confirmed" if confirmed else h.status,
        ))
    return out


def collect_seen_chart_ids(tool_log: list[dict]) -> list[int]:
    """Which chart_ids did the agent actually fetch this turn?"""
    seen: list[int] = []
    for entry in tool_log:
        if not isinstance(entry, dict):
            continue
        args = entry.get("args") or {}
        cid = args.get("chart_id")
        if isinstance(cid, int) and cid not in seen:
            seen.append(cid)
    return seen


# ── Prompt rendering ────────────────────────────────────────────────────────


def format_state_for_prompt(state: ConversationState) -> str:
    """Render conversation state as a compact text block.

    Excludes the briefing block — that one is rendered separately by
    ``briefing.format_briefing_for_prompt`` so it sits at the top of the
    system prompt.
    """
    if not state:
        return ""
    parts: list[str] = []
    if state.findings:
        parts.append("═══ ĐÃ BIẾT TỪ CÁC TURN TRƯỚC ═══")
        parts.append(
            "(Đây là các phát hiện đã có. KHÔNG fetch lại trừ khi user bảo "
            "kiểm tra lại. Có thể trích dẫn trực tiếp.)"
        )
        for f in state.findings[-12:]:  # last 12 only — keep token budget tight
            cites = " ".join(f"[chart:{c}]" for c in f.chart_ids)
            parts.append(f"  - {f.claim} {cites} [{f.confidence}]")
    if state.hypotheses:
        open_h = [h for h in state.hypotheses if h.status == "open"]
        if open_h:
            parts.append("")
            parts.append("═══ GIẢ THUYẾT ĐÃ NÊU, CHƯA XÁC NHẬN ═══")
            parts.append(
                "(Khi câu trả lời mới có dữ liệu liên quan tới một giả thuyết, "
                "hãy xác nhận hoặc bác bỏ rõ ràng.)"
            )
            for h in open_h[-6:]:
                parts.append(f"  - {h.text}")
    if state.seen_chart_ids:
        ids = ", ".join(f"chart:{c}" for c in state.seen_chart_ids[-15:])
        parts.append("")
        parts.append(f"Đã đọc summary: {ids}")
    return "\n".join(parts)


# ── Cross-turn contradiction detection ──────────────────────────────────────


def detect_cross_turn_contradictions(
    state: ConversationState,
    new_findings: list[Finding],
) -> list[tuple[Finding, Finding]]:
    """Return pairs (old, new) where new contradicts old on the same metric.

    Heuristic: same chart_id and metric_value differs by > 0.5%. Pure data
    check — used as a soft warning we surface in the next turn's prompt.
    """
    pairs: list[tuple[Finding, Finding]] = []
    by_chart: dict[int, Finding] = {}
    for f in state.findings:
        for cid in f.chart_ids:
            if f.metric_value is not None:
                by_chart[cid] = f
    for nf in new_findings:
        if nf.metric_value is None:
            continue
        for cid in nf.chart_ids:
            old = by_chart.get(cid)
            if old is None or old.metric_value is None:
                continue
            denom = abs(old.metric_value) or 1
            if abs(nf.metric_value - old.metric_value) / denom > 0.005:
                pairs.append((old, nf))
    return pairs
