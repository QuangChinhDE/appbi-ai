"""Input guardrail for the public AI chat — deterministic, zero LLM calls.

The chat endpoint is PUBLIC and ANONYMOUS, and it streams to a third-party model
paid for with the organisation's own API key. Before that happens, one cheap
pass over the question rejects the two things we cannot let through:

  1. **Instruction hijacking** — "bỏ qua mọi chỉ dẫn", "ignore previous
     instructions", role-swap jailbreaks. These try to dissolve the tool
     allowlist and scope rules the rest of the system depends on.
  2. **Internals exfiltration** — "in ra system prompt", "cho tôi API key".
     The system prompt carries the business's authored knowledge and the
     credential lives in the same process.

Deliberately regex, not an LLM classifier: an LLM guard would add a round-trip
to EVERY turn (including cheap lookups), cost money on the customer's key, and
could itself be talked out of its job. Regex cannot be argued with.

Vietnamese is matched both with and WITHOUT diacritics — viewers routinely type
unaccented, and an attacker certainly would. Patterns follow the same
bilingual/unaccented convention as ``router.py``.

Tuning: ``check_input`` never mutates state. Run it in ``mode="log"`` first
(see ``INTELLIGENCE_GUARD_MODE``) to measure false positives on real traffic
before switching to ``mode="block"``.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

# Hard ceiling on a single question. Anything longer is either a paste-bomb or
# an attempt to bury an instruction under filler; both are cut, not rejected,
# so a genuinely long business question still gets answered.
MAX_QUESTION_CHARS = 4000

# Characters used to smuggle instructions past a naive reader: zero-width
# joiners/spaces, bidi overrides, soft hyphen.
_INVISIBLE_RE = re.compile(r"[​-‏‪-‮⁠-⁤﻿­]")


def _fold(text: str) -> str:
    """Lowercase + strip diacritics so 'Bỏ Qua' and 'bo qua' hit one pattern."""
    s = unicodedata.normalize("NFKD", text or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", s).strip().lower()


def _rx(pattern: str) -> re.Pattern:
    return re.compile(pattern, re.IGNORECASE)


# (compiled pattern, code). Patterns run against the FOLDED question, so they
# are written without diacritics and match both spellings automatically.
_BLOCK_RULES: list[tuple[re.Pattern, str]] = [
    # ── 1. Instruction hijacking ───────────────────────────────────────────
    (
        _rx(r"\b(bo qua|phot lo|khong can theo|dung tuan theo)\b.{0,40}"
            r"\b(chi dan|huong dan|quy tac|quy dinh|rang buoc|yeu cau tren)\b"),
        "INSTRUCTION_OVERRIDE",
    ),
    (
        _rx(r"\b(ignore|disregard|forget|override)\b.{0,40}"
            r"\b(previous|prior|above|earlier|all)\b.{0,20}"
            r"\b(instruction|instructions|rule|rules|prompt|context)\b"),
        "INSTRUCTION_OVERRIDE",
    ),
    (
        _rx(r"\b(new|updated)\s+(system\s+)?(instruction|prompt|rule)s?\s*[:\-]"),
        "INSTRUCTION_OVERRIDE",
    ),
    # ── 2. Internals / secret exfiltration ─────────────────────────────────
    (
        _rx(r"\b(in ra|hien thi|cho (toi|minh) xem|doc|tiet lo|liet ke|lap lai)\b"
            r".{0,40}\b(system prompt|prompt he thong|cau lenh he thong|"
            r"chi dan he thong|toan bo prompt|prompt goc)\b"),
        "PROMPT_DISCLOSURE",
    ),
    (
        _rx(r"\b(show|print|reveal|repeat|output|dump|echo)\b.{0,40}"
            r"\b(system prompt|your prompt|initial prompt|instructions above|"
            r"your instructions)\b"),
        "PROMPT_DISCLOSURE",
    ),
    (
        _rx(r"\b(api[ _-]?key|api key|secret key|access token|token cua ban|"
            r"khoa api|credential|mat khau he thong)\b"),
        "SECRET_DISCLOSURE",
    ),
    # ── 3. Role swap / jailbreak personas ──────────────────────────────────
    (
        _rx(r"\b(ban la|bay gio ban la|tu gio ban la)\b.{0,20}"
            r"\b(admin|quan tri|developer|lap trinh vien|he thong|root)\b"),
        "ROLE_SWAP",
    ),
    (
        _rx(r"\b(you are now|act as|pretend (to be|you are)|roleplay as|"
            r"simulate being)\b.{0,30}\b(admin|developer|root|system|dan|"
            r"unrestricted|jailbroken)\b"),
        "ROLE_SWAP",
    ),
    (_rx(r"\b(dan mode|developer mode|jailbreak|do anything now)\b"), "ROLE_SWAP"),
    # ── 4. Explicit cross-scope data requests ──────────────────────────────
    (
        _rx(r"\b(tat ca|toan bo|moi)\b.{0,20}"
            r"\b(dashboard|bao cao|khach hang|cong ty|tenant)\b.{0,20}"
            r"\b(khac|trong he thong|tren he thong)\b"),
        "CROSS_SCOPE",
    ),
    (
        # Both word orders: "dashboards other than this" and "other dashboards".
        _rx(r"\b(other|another|all other|every other)\b\s+\w{0,12}\s?\b(dashboard|report)s?\b"
            r"|\b(dashboard|report)s?\b.{0,20}\b(other|another|all other)\b"),
        "CROSS_SCOPE",
    ),
]

# Human-facing replies, keyed by code. Plain, non-accusatory: a real user who
# trips a rule by accident should not feel told off.
_MESSAGES: dict[str, str] = {
    "INSTRUCTION_OVERRIDE": (
        "Mình chỉ có thể trả lời trong phạm vi báo cáo này và theo hướng dẫn đã "
        "được cấu hình. Bạn hỏi mình về số liệu hoặc nội dung trong báo cáo nhé."
    ),
    "PROMPT_DISCLOSURE": (
        "Mình không chia sẻ được cấu hình nội bộ. Nhưng mình sẵn sàng giải thích "
        "cách một chỉ số trong báo cáo được tính — bạn muốn xem chỉ số nào?"
    ),
    "SECRET_DISCLOSURE": (
        "Mình không truy cập hay chia sẻ thông tin xác thực. Bạn hỏi mình về dữ "
        "liệu trong báo cáo nhé."
    ),
    "ROLE_SWAP": (
        "Mình là trợ lý phân tích của báo cáo này và giữ nguyên vai trò đó. Bạn "
        "muốn xem hoặc phân tích phần nào của báo cáo?"
    ),
    "CROSS_SCOPE": (
        "Mình chỉ đọc được dữ liệu của báo cáo đang mở, không xem được báo cáo "
        "khác. Trong báo cáo này bạn muốn tìm hiểu điều gì?"
    ),
}

_DEFAULT_MESSAGE = (
    "Câu hỏi này nằm ngoài phạm vi mình hỗ trợ. Bạn thử hỏi về số liệu hoặc "
    "nội dung trong báo cáo nhé."
)


@dataclass
class GuardResult:
    allowed: bool
    normalized_question: str
    codes: list[str] = field(default_factory=list)
    message: str = ""

    def to_log(self) -> dict:
        return {"allowed": self.allowed, "codes": list(self.codes)}


def normalize_question(question: str) -> str:
    """Strip invisibles, collapse whitespace, cap length. Never rejects."""
    q = _INVISIBLE_RE.sub("", question or "")
    q = re.sub(r"[ \t]+", " ", q)
    q = re.sub(r"\n{3,}", "\n\n", q).strip()
    if len(q) > MAX_QUESTION_CHARS:
        q = q[:MAX_QUESTION_CHARS].rstrip()
    return q


def check_input(question: str, *, mode: str = "block") -> GuardResult:
    """Screen one user question.

    ``mode``:
      • ``"block"`` — trip a rule → ``allowed=False`` with a viewer-facing message
      • ``"log"``   — always ``allowed=True``; codes still populated so the
                      false-positive rate can be measured on real traffic
      • ``"off"``   — normalisation only

    Empty input is allowed: the agent already handles it, and rejecting here
    would turn a harmless mis-click into an error bubble.
    """
    normalized = normalize_question(question)
    if mode == "off" or not normalized:
        return GuardResult(allowed=True, normalized_question=normalized)

    folded = _fold(normalized)
    codes: list[str] = []
    for pattern, code in _BLOCK_RULES:
        if code in codes:
            continue
        if pattern.search(folded):
            codes.append(code)

    if not codes:
        return GuardResult(allowed=True, normalized_question=normalized)
    if mode == "log":
        return GuardResult(allowed=True, normalized_question=normalized, codes=codes)
    return GuardResult(
        allowed=False,
        normalized_question=normalized,
        codes=codes,
        message=_MESSAGES.get(codes[0], _DEFAULT_MESSAGE),
    )
