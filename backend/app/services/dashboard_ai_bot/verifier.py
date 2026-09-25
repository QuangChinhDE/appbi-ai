"""Deterministic answer verification — does every figure trace to evidence?

The assistant writes Vietnamese business prose, so the numbers in an answer look
like ``1.234.567,89``, ``12,5%``, ``1,2 tỷ``, ``3 triệu``, ``2.4M``. The evidence
ledger holds plain floats. Bridging those two reliably is the entire job, and it
is where this module earns its keep — a parser that reads ``1.234`` as 1.234
instead of 1234 does not merely miss a check, it silently reports a correct
answer as fabricated.

Decimal-separator rule (the crux):
  * both ``.`` and ``,`` present  → the LAST one is the decimal separator
  * only ``,``  → decimal if it is followed by exactly 1-2 digits and appears
    once ("12,5"), otherwise a thousands separator ("1,234,567")
  * only ``.``  → mirror image ("1.234.567" is thousands; "12.5" is decimal)

Not everything numeric is a claim. Years, ordinals in a list, chart citations
and percentages that restate a share are excluded, because a false "unsupported
number" is as damaging as a missed one: it would train reviewers to ignore the
signal.

Output is a coverage ratio plus the unmatched figures. What the caller DOES with
that is staged deliberately (see INTELLIGENCE_VERIFIER_MODE): log first, repair
later, strip last. Enforcing on day one, before the false-positive rate is
known, is the fastest way to break a working assistant with its own QA tool.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Relative tolerance for a match. Mirrors the eval graders so "verified" and
# "passes the gold suite" mean the same thing numerically.
DEFAULT_TOLERANCE = 0.005

# Scale words, Vietnamese and English. "1,2 tỷ" → 1_200_000_000.
_SCALE_WORDS: dict[str, float] = {
    "nghìn": 1e3, "nghin": 1e3, "ngàn": 1e3, "ngan": 1e3,
    "triệu": 1e6, "trieu": 1e6,
    "tỷ": 1e9, "ty": 1e9, "tỉ": 1e9, "ti": 1e9,
    "nghìn tỷ": 1e12, "nghin ty": 1e12,
    "k": 1e3, "m": 1e6, "b": 1e9,
    "thousand": 1e3, "million": 1e6, "billion": 1e9,
}

_SCALE_ALTERNATION = "|".join(
    sorted((re.escape(w) for w in _SCALE_WORDS), key=len, reverse=True)
)

# A number, optionally followed by a scale word and/or a percent sign.
_NUMBER_RE = re.compile(
    r"(?<![\w.,])"                       # not glued to a word/number
    # A leading minus counts only at a token boundary, so "12-15" stays a range
    # rather than becoming 12 and -15.
    r"(?P<sign>-)?"
    r"(?P<num>\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)"
    r"\s*(?P<scale>" + _SCALE_ALTERNATION + r")?"
    r"\s*(?P<pct>%)?"
    r"(?![\w])",
    re.IGNORECASE,
)

# Spans removed before scanning: chart citations and ladder tags carry ids and
# labels, never claims.
_STRIP_SPANS = [
    re.compile(r"\[chart:\d+\]", re.IGNORECASE),
    re.compile(r"\[(?:DESC|DIAG|PRED|PRESC|HIGH|MED|LOW|WEB)\]", re.IGNORECASE),
    re.compile(r"https?://\S+"),
    re.compile(r"`[^`]*`"),               # inline code / ids
    # A QUOTED NAME IS A LABEL — which is what this list already says about
    # citations. Answers cite their source by name, and report names carry digits:
    # `"Olist · Điểm đánh giá TB · page-1"` yielded a claim of 1, that matched no
    # evidence, and a CORRECT answer shipped under "1 con số không khớp".
    #
    # A false alarm is not the small half of this trade. The warning's whole value
    # is that it means something, and it stops meaning anything the moment it fires
    # on right answers — people learn to scroll past it, including the time it is
    # catching a figure that really was invented.
    #
    # A letter is required inside, so a quoted FIGURE is still checked. Models
    # quote names; they do not quote numbers.
    re.compile(r"[\"“][^\"”]*[A-Za-zÀ-ỹ][^\"”]*[\"”]"),
]

# Bare integers in this range read as years far more often than as figures.
_YEAR_MIN, _YEAR_MAX = 1900, 2100

# Markdown list ordinals ("1. ", "2) ") — enumeration, not data.
_ORDINAL_RE = re.compile(r"(?m)^\s{0,3}(\d{1,2})[.)]\s")


@dataclass
class VerificationResult:
    coverage: float | None            # None = nothing to check
    total_numbers: int = 0
    matched: int = 0
    unmatched: list[float] = field(default_factory=list)
    checked: bool = False

    def to_dict(self) -> dict:
        return {
            "coverage": None if self.coverage is None else round(self.coverage, 4),
            "total_numbers": self.total_numbers,
            "matched": self.matched,
            "unmatched": [round(u, 4) for u in self.unmatched[:20]],
            "checked": self.checked,
        }


def parse_number(raw: str) -> float | None:
    """Parse one Vietnamese/English formatted numeric literal.

    Returns None when the token is ambiguous enough that guessing would be
    worse than skipping it.
    """
    s = (raw or "").strip().replace(" ", "").replace(" ", "")
    if not s:
        return None
    neg = s.startswith("-")
    s = s.lstrip("+-")
    if not s or not re.fullmatch(r"[\d.,]+", s):
        return None

    has_dot, has_comma = "." in s, "," in s

    def _groups_ok(parts: list[str]) -> bool:
        """Is this valid thousands grouping? A grouped number never starts with
        a zero — "0,125" and "0.125" are decimals, not 0125."""
        head = parts[0]
        if not head or (len(head) > 1 and head[0] == "0") or head == "0":
            return False
        return len(head) <= 3 and all(len(p) == 3 for p in parts[1:])

    if has_dot and has_comma:
        # Whichever appears last is the decimal separator.
        dec = "." if s.rfind(".") > s.rfind(",") else ","
        thou = "," if dec == "." else "."
        s = s.replace(thou, "")
        s = s.replace(dec, ".")
    elif has_comma:
        parts = s.split(",")
        if len(parts) == 2 and 1 <= len(parts[1]) <= 2:
            s = s.replace(",", ".")            # 12,5 → 12.5
        elif _groups_ok(parts):
            s = s.replace(",", "")             # 1,234,567
        elif len(parts) == 2:
            s = s.replace(",", ".")            # 0,125 → 0.125
        else:
            return None                        # ambiguous → skip, don't guess
    elif has_dot:
        parts = s.split(".")
        if len(parts) > 2 and _groups_ok(parts):
            s = s.replace(".", "")             # 1.234.567
        elif len(parts) == 2 and len(parts[1]) == 3 and _groups_ok(parts):
            # "1.234" — thousands in vi-VN, decimal in en-US. Vietnamese prose
            # is the house style, and reading it as 1.234 would understate the
            # figure by 1000×, so the thousands reading wins. "0.125" is
            # excluded by _groups_ok and stays a decimal.
            s = s.replace(".", "")
        # else: plain decimal like 12.5 / 0.125 — leave as is

    try:
        val = float(s)
    except ValueError:
        return None
    return -val if neg else val


def _alternate_reading(raw: str) -> float | None:
    """The OTHER defensible reading of an ambiguous token, or None.

    `4.086` is four-point-oh-eight-six in English and four thousand and eighty-six
    in Vietnamese. `parse_number` picks the Vietnamese one deliberately — reading a
    thousands-grouped figure as a decimal understates it by 1000×, and that is the
    worse mistake when the job is to READ a number.

    Verification is a different job with a different asymmetry: the two errors here
    are "warn about a correct answer" and "miss a wrong one", and a token that is
    genuinely ambiguous is evidence of neither. Observed live — a model wrote 4.086
    for a measured 4.0864 and the run shipped a correct answer labelled unverified.
    So the verifier tries both readings and accepts the figure if EITHER is what was
    measured; the parser keeps its single, stricter answer.

    Only the one shape that is actually ambiguous: a single dot with exactly three
    digits after it. Everything else has one reading and gets one.
    """
    s = (raw or "").strip().lstrip("+-")
    if s.count(".") != 1 or "," in s:
        return None
    head, tail = s.split(".")
    if not (head.isdigit() and tail.isdigit() and len(tail) == 3):
        return None
    if not head or (len(head) > 1 and head[0] == "0"):
        return None
    try:
        return float(s)          # the en-US decimal reading
    except ValueError:
        return None


def _claim_alternates(answer: str) -> dict[float, tuple[float, ...]]:
    """value -> the other readings of the tokens that produced it.

    Scans the same text `extract_answer_numbers` scans, through the same strip and
    ordinal rules, so the two cannot disagree about which tokens are claims.
    """
    text = answer or ""
    for pattern in _STRIP_SPANS:
        text = pattern.sub(" ", text)
    text = _ORDINAL_RE.sub(" ", text)
    out: dict[float, list[float]] = {}
    for m in _NUMBER_RE.finditer(text):
        raw = m.group("num")
        value = parse_number(raw)
        other = _alternate_reading(raw)
        if value is None or other is None:
            continue
        if m.group("sign"):
            value, other = -value, -other
        scale = (m.group("scale") or "").strip().lower()
        if scale:
            other *= _SCALE_WORDS.get(scale, 1.0)
        out.setdefault(value, []).append(other)
    return {k: tuple(v) for k, v in out.items()}


def extract_answer_numbers(answer: str) -> list[float]:
    """Every figure the answer actually CLAIMS, in order of appearance."""
    text = answer or ""
    for pattern in _STRIP_SPANS:
        text = pattern.sub(" ", text)

    ordinals = {m.group(1) for m in _ORDINAL_RE.finditer(text)}
    text = _ORDINAL_RE.sub(" ", text)

    out: list[float] = []
    for m in _NUMBER_RE.finditer(text):
        raw = m.group("num")
        value = parse_number(raw)
        if value is None:
            continue

        if m.group("sign"):
            value = -value

        scale = (m.group("scale") or "").strip().lower()
        is_pct = bool(m.group("pct"))

        if scale:
            value *= _SCALE_WORDS.get(scale, 1.0)
        elif not is_pct:
            # Bare integer that reads as a year, and no scale/percent to say
            # otherwise → calendar reference, not a claim.
            if (
                value == int(value)
                and _YEAR_MIN <= value <= _YEAR_MAX
                and "." not in raw and "," not in raw
            ):
                continue
            if raw in ordinals and value <= 20:
                continue
        out.append(value)
    return out


def _matches(value: float, evidence: list[float], tolerance: float) -> bool:
    for ev in evidence:
        if ev == value:
            return True
        scale = max(abs(ev), abs(value))
        if scale == 0:
            continue
        if abs(ev - value) / scale <= tolerance:
            return True
        # A percentage may be written as 12,5 while evidence holds 0.125 (or
        # the reverse). Accept both readings rather than flagging a formatting
        # difference as a fabricated number.
        if abs(ev * 100 - value) / max(abs(ev * 100), abs(value), 1e-9) <= tolerance:
            return True
        if abs(ev / 100 - value) / max(abs(ev / 100), abs(value), 1e-9) <= tolerance:
            return True
    return False


def verify_answer(
    answer: str,
    evidence_numbers: list[float],
    *,
    tolerance: float = DEFAULT_TOLERANCE,
) -> VerificationResult:
    """Compare the answer's figures against the turn's evidence.

    ``coverage`` is None — not 0.0 — when there is nothing to compare (no
    figures, or no evidence because the turn called no tools). Zero would read
    as "everything was fabricated" in the dashboards.
    """
    claimed = extract_answer_numbers(answer)
    if not claimed:
        return VerificationResult(coverage=None, checked=False)
    if not evidence_numbers:
        return VerificationResult(
            coverage=None, total_numbers=len(claimed), checked=False,
        )

    # A figure counts as supported if EITHER reading of its token is what was
    # measured — see `_alternate_reading` for why the verifier is more permissive
    # about `4.086` than the parser is.
    alternates = _claim_alternates(answer)
    unmatched = [
        v for v in claimed
        if not _matches(v, evidence_numbers, tolerance)
        and not any(_matches(a, evidence_numbers, tolerance)
                    for a in alternates.get(v, ()))
    ]
    matched = len(claimed) - len(unmatched)
    return VerificationResult(
        coverage=matched / len(claimed),
        total_numbers=len(claimed),
        matched=matched,
        unmatched=unmatched,
        checked=True,
    )
