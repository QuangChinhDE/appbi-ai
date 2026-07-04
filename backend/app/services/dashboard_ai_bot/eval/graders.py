"""Deterministic Tier-1 graders for the AI bot eval framework.

No LLM. These check the things a BI answer can be checked on objectively:
numbers, mentions, refusal, and citation scope. Robust to VN/US number
formats and abbreviated forms ("1.18M", "1,18 triệu", "9,26%").
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable

# ── Number extraction ───────────────────────────────────────────────────────
# Suffix multipliers (English + Vietnamese business shorthand).
_SUFFIX = [
    ("tỷ", 1e9), ("ty", 1e9), ("b", 1e9), ("bn", 1e9), ("tr", 1e6),
    ("triệu", 1e6), ("trieu", 1e6), ("m", 1e6), ("mn", 1e6),
    ("nghìn", 1e3), ("nghin", 1e3), ("ngàn", 1e3), ("ngan", 1e3), ("k", 1e3),
]
# A numeric token: digits with optional thousands/decimal separators, optional
# leading sign, optional trailing % and/or a scale suffix.
_NUM_RE = re.compile(
    r"(?<![A-Za-z0-9_])"
    r"(-?\d[\d.,]*)"                        # the numeric core
    r"\s*(%?)"                               # optional percent
    r"\s*(tỷ|ty|bn|tr(?:iệu|ieu)?|triệu|trieu|nghìn|nghin|ngàn|ngan|mn|bn?|k|m)?"  # suffix
    r"(?![A-Za-z0-9_])",
    re.IGNORECASE,
)


def _candidates(core: str) -> list[float]:
    """All plausible float interpretations of a numeric core string.

    We DON'T try to guess US vs EU formatting — we generate every reasonable
    interpretation and let the tolerant matcher accept if ANY fits the expected
    value. This makes matching format-agnostic and robust."""
    core = core.strip()
    if not core or core in ("-", ".", ","):
        return []
    out: set[float] = set()
    variants = {
        core.replace(",", ""),                       # US: comma=thousands
        core.replace(".", "").replace(",", "."),     # EU/VN: dot=thousands, comma=decimal
        re.sub(r"[.,]", "", core),                   # grouped digits, no decimal
    }
    for v in variants:
        if v in ("", "-", "+"):
            continue
        try:
            out.add(float(v))
        except ValueError:
            continue
    return list(out)


def extract_numbers(text: str) -> list[float]:
    """Every numeric value mentioned in `text`, scale-suffixes applied, as a
    flat list of candidate floats (one token may yield several candidates)."""
    vals: list[float] = []
    for m in _NUM_RE.finditer(text or ""):
        core, pct, suf = m.group(1), m.group(2), (m.group(3) or "").lower()
        cands = _candidates(core)
        mult = 1.0
        if suf:
            for s, f in _SUFFIX:
                if suf == s:
                    mult = f
                    break
        for c in cands:
            vals.append(c * mult)
            # A bare "%" doesn't change the value (9.26% → 9.26) but note it.
    return vals


def _matches(value: float, expected: float, tol: float) -> bool:
    if expected == 0:
        return abs(value) <= max(tol, 1e-9)
    return abs(value - expected) / abs(expected) <= tol


def numeric_match(text: str, expected: float, tol: float = 0.005) -> bool:
    """True if `expected` appears in `text` within relative tolerance `tol`,
    in ANY common format/abbreviation."""
    return any(_matches(v, expected, tol) for v in extract_numbers(text))


# ── Text normalisation + mention ────────────────────────────────────────────
def _fold(s: str) -> str:
    """Lowercase, strip diacritics, collapse whitespace — so 'São Paulo' and
    'sao paulo' match, 'Tháng' and 'thang' match."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    s = re.sub(r"\s+", " ", s).strip()
    return s


def mention_present(text: str, needle: str) -> bool:
    """Substring check, diacritic/case-insensitive. A needle may express
    equivalent phrasings as ``a|b|c`` (OR) — matches if ANY alternative is
    present (e.g. "2017-11|11/2017|thang 11 2017"), so grading isn't brittle to
    a model's date/format phrasing."""
    folded = _fold(text)
    alts = [a for a in (needle or "").split("|") if a.strip()]
    return any(_fold(a) in folded for a in alts)


# ── Refusal detection ───────────────────────────────────────────────────────
_REFUSAL_PATTERNS = [
    "khong co du lieu", "khong tim thay", "khong du thong tin", "khong the tra loi",
    "khong co thong tin", "ngoai pham vi", "khong nam trong", "chua co thong tin",
    "khong tra loi duoc", "khong xac dinh duoc",
    # scope-limit declines (data-driven grounding makes the bot decline like this)
    "khong the cung cap", "khong cung cap duoc", "chi co the phan tich",
    "khong ho tro", "khong the giup", "khong co trong bao cao", "khong nam trong bao cao",
    "chi phan tich duoc", "vuot ngoai", "nam ngoai",
    "no data", "cannot answer", "can't answer", "i don't have", "i do not have",
    "not available", "unable to", "out of scope", "insufficient information",
]


def refusal_detected(text: str) -> bool:
    f = _fold(text)
    return any(p in f for p in _REFUSAL_PATTERNS)


# ── Citation scope (deterministic grounding guard) ──────────────────────────
_CHART_CITE_RE = re.compile(r"\[chart:(\d+)\]", re.IGNORECASE)


def cited_chart_ids(text: str) -> list[int]:
    return [int(m.group(1)) for m in _CHART_CITE_RE.finditer(text or "")]


def citations_in_scope(text: str, allowed: Iterable[int]) -> tuple[bool, list[int]]:
    """Every [chart:N] cited must be within `allowed`. Returns (ok, offending)."""
    allow = set(int(a) for a in allowed)
    offending = sorted({c for c in cited_chart_ids(text) if c not in allow})
    return (len(offending) == 0, offending)


# ── Case grading ────────────────────────────────────────────────────────────
@dataclass
class CaseResult:
    id: str
    tier: str
    passed: bool
    checks: dict[str, bool] = field(default_factory=dict)
    detail: dict = field(default_factory=dict)


def grade_case(case, answer: str, *, allowed_chart_ids=None) -> CaseResult:
    """Grade one GoldCase against a bot answer string. All applicable checks
    must pass. Pure + deterministic — no LLM, no network."""
    checks: dict[str, bool] = {}
    detail: dict = {}
    answer = answer or ""

    if case.must_refuse:
        checks["refusal"] = refusal_detected(answer)
    else:
        # Correctness: every required number present.
        if case.expect_numbers:
            missing = [n for n in case.expect_numbers if not numeric_match(answer, n, case.tolerance)]
            checks["numbers"] = not missing
            if missing:
                detail["missing_numbers"] = missing
        if case.expect_any_numbers:
            hit = any(numeric_match(answer, n, case.tolerance) for n in case.expect_any_numbers)
            checks["any_number"] = hit
        if case.must_mention:
            miss = [m for m in case.must_mention if not mention_present(answer, m)]
            checks["mention"] = not miss
            if miss:
                detail["missing_mentions"] = miss
        # A non-refusal case should NOT accidentally refuse.
        checks["not_refused"] = not refusal_detected(answer)

    if case.must_not_mention:
        bad = [m for m in case.must_not_mention if mention_present(answer, m)]
        checks["no_forbidden"] = not bad
        if bad:
            detail["forbidden_present"] = bad

    scope = case.allowed_chart_ids if case.allowed_chart_ids is not None else allowed_chart_ids
    if scope is not None:
        ok, offending = citations_in_scope(answer, scope)
        checks["citation_scope"] = ok
        if offending:
            detail["offending_citations"] = offending

    passed = all(checks.values()) if checks else False
    return CaseResult(id=case.id, tier=case.tier, passed=passed, checks=checks, detail=detail)
