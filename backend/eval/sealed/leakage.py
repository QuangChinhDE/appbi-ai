"""Holdout leakage: a holdout question that trusted knowledge already answers.

If a VerifiedQA trigger or a SQL example matches a holdout question, the system
can score on that case by retrieval rather than by analysis. The case then
measures recall of a pinned answer, not generalisation, and must not count
toward the holdout score.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable

from .case import EvalCase

#: Jaccard similarity of normalized tokens at or above which a holdout question
#: is treated as answered by trusted knowledge. Deliberately low: a false
#: exclusion costs one case, while a missed leak corrupts the whole score.
LEAK_THRESHOLD = 0.6

_WORD = re.compile(r"[a-z0-9]+")
_STOP = frozenset({
    "la", "bao", "nhieu", "cua", "va", "co", "cac", "mot", "trong", "cho", "theo", "the", "of",
    "in", "a", "an", "is", "what", "how", "many", "much", "by", "for", "to",
})


def normalize(text: str) -> frozenset[str]:
    """Casefolded, diacritic-free content tokens ('Doanh thu' == 'doanh thu' ==
    'doanh thú'). Vietnamese đ has no decomposition, so it is mapped explicitly."""
    s = unicodedata.normalize("NFD", (text or "").casefold().replace("đ", "d"))
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return frozenset(t for t in _WORD.findall(s) if t not in _STOP)


@dataclass(frozen=True)
class Leak:
    case_id: str
    trusted_text: str
    similarity: float


def find_leaks(cases: Iterable[EvalCase], trusted_texts: Iterable[str],
               threshold: float = LEAK_THRESHOLD) -> list[Leak]:
    """Every (holdout case, trusted text) pair at or above ``threshold``."""
    trusted = [(t, normalize(t)) for t in trusted_texts if (t or "").strip()]
    leaks: list[Leak] = []
    for case in cases:
        if case.split != "holdout":
            continue
        q = normalize(case.question)
        if not q:
            continue
        for text, tokens in trusted:
            if not tokens:
                continue
            sim = len(q & tokens) / len(q | tokens)
            if sim >= threshold or q <= tokens:
                leaks.append(Leak(case.id, text, round(sim, 3)))
    return leaks
