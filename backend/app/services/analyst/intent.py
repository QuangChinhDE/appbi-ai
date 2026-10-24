"""Question intent extraction (deterministic, before grounding).

Grounding asks "is every meaningful word of the question explained by the plan?".
Some words are not data at all but CONSTRUCTIONS of the request, and each closed
construction is recognised here as a whole - never word by word in a stopword
list (sealed set 8: "Anh chị cho em hỏi ...", "Top 3 ...", "Xếp hạng ... từ cao
xuống thấp", "... bán được bao nhiêu tiền / mấy cái"):

  * request framing - who asks whom, and sentence-final politeness particles:
    removed, it carries no meaning for the query;
  * ranking - "top N", "N ... cao nhất", "xếp hạng", "từ cao xuống thấp",
    "nhiều/ít nhất": NOT removed silently, it becomes an obligation the plan
    must satisfy (order by the metric, at most N groups) - see grounding;
  * a quantity question - "bao nhiêu tiền", "mấy cái": asks for a measure, and
    is explained by the plan's measure.

Matching is on the folded text (case and tone marks removed). A ranking word that
is really a comparison ("ít nhất 5 đơn") is left to the comparison obligation.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from app.services.analyst.grounding import fold

_PRON = r"(?:anh|chi|em|minh|toi|ban|to|cau|sep|ad|admin|moi nguoi|team|ca nha)"
# "(anh chị) cho (em) hỏi", "giúp mình xem", "làm ơn cho tôi biết", "xin cho hỏi"
_HEAD = re.compile(
    rf"^(?:{_PRON}\s+){{0,3}}(?:(?:oi|a)\s+)?(?:(?:xin|lam on|vui long|nho|giup|cho)\s+)+(?:{_PRON}\s+){{0,2}}"
    r"(?:(?:hoi|xem|biet|lay|tim|tra|kiem tra|thong ke|tinh|tong hop)\s+)?")
# an interjection opening a request ("Ê cho xem ...", "Alo ...", "Nè ..."): framing
_INTERJ = re.compile(r"^(?:e|ey|alo|ne|nay)\s+(?=\w)")
# sentence-final particles and polite tails
_TAIL = re.compile(rf"(?:\s+(?:a|nhe|nha|nhi|voi|di|oi|vay|the|giup {_PRON}|duoc khong|nhe {_PRON}|{_PRON} nhe))+\s*$")
_TOP = re.compile(r"\btop\s*(\d{1,3})\b")
# the metric may sit between the adjective and "nhất" ("2 miền ... NHIỀU đơn hàng NHẤT",
# sealed set 9 S9-023): only the number, the adjective and "nhất" are the construction
_N_SUPER = re.compile(r"\b(\d{1,3})\s+(?:\w+\s+){0,4}?(cao|lon|nhieu|chay|thap|nho|it)\s+(?:\w+\s+){0,3}?nhat\b(?!\s+\d)")
_SUPER = re.compile(r"\b(?:ban\s+)?(cao|lon|nhieu|chay|thap|nho|it)\s+(?:\w+\s+){0,3}?nhat\b(?!\s+\d)")
_RANK = re.compile(r"\bxep hang\b")
_ORDER_DESC = re.compile(r"\btu (?:cao|lon|nhieu) (?:xuong|den|toi) (?:thap|nho|it)\b")
_ORDER_ASC = re.compile(r"\btu (?:thap|nho|it) (?:len|den|toi) (?:cao|lon|nhieu)\b")
# "từ trước tới nay", "từ đầu đến giờ", "toàn thời gian": the whole history, i.e. no period
_ALL_TIME = re.compile(r"\b(?:tu (?:truoc|dau|xua) (?:toi|den) (?:nay|gio)|toan (?:thoi gian|bo thoi gian)|tat ca cac nam)\b")
# who the figures are about: the company itself ("của công ty", "bên mình") - not a field
_SUBJECT = re.compile(r"\b(?:cua )?(?:cong ty|ben minh|chung ta|doanh nghiep minh)\b(?! \w+ (?:nghiep|hang))")
# exclusion markers: the negation obligation (grounding) checks the plan carries them
_EXCLUDE = re.compile(r"\b(?:ngoai tru|loai tru|loai bo)\b")
# follow-up continuation: "chia tiếp", "thêm ... vào (nữa)", "còn ... thì sao"
_CONTINUE = re.compile(r"\b(?:tiep|them|vao|nua|thi sao|con lai|con)\b")
_QUANTITY = re.compile(r"\b(?:bao nhieu|may|so)\s+(?:tien|cai|chiec|lan|luot)\b")
_DESC_WORDS = {"cao", "lon", "nhieu", "chay"}
# An evaluative superlative ("tốt nhất", "kém nhất") has no meaning of its own: only
# once the person CHOSE the metric it is measured by does it become a ranking.
_EVAL_SUPER = re.compile(r"\b(tot|hieu qua|manh|kem|te|xau|yeu)\s+nhat\b")
_EVAL_ASC = {"kem", "te", "xau", "yeu"}


@dataclass
class Intent:
    #: the folded question with framing and recognised constructions removed:
    #: what grounding must still explain
    content: str
    #: {"direction": "desc"|"asc", "n": Optional[int]} when the question asks for a ranking
    ranking: Optional[dict] = None
    quantity: bool = False
    consumed: list[str] = field(default_factory=list)


def m_kind_superlative(consumed: list[str]) -> bool:
    return any("nhat" in c for c in consumed)


def _norm(question: str) -> str:
    return " ".join(w for w in re.split(r"[^0-9a-z]+", fold(question)) if w)


def extract(question: str, *, chosen_metric: bool = False, followup: bool = False) -> Intent:
    text = _norm(question)
    which_one = bool(re.search(r"\bnao\b", text))  # "kênh NÀO ... nhiều nhất": one winner asked
    consumed: list[str] = []

    def cut(rx, s):
        m = rx.search(s)
        if not m or not m.group(0).strip():
            return s, None
        consumed.append(m.group(0).strip())
        return (s[:m.start()] + " " + s[m.end():]).strip(), m

    text, _ = cut(_INTERJ, text)
    text, _ = cut(_HEAD, text)
    text, _ = cut(_TAIL, text)
    ranking = None
    n = None
    direction = None
    text, m = cut(_TOP, text)
    if m:
        n, direction = int(m.group(1)), "desc"
    m = _N_SUPER.search(text)
    if m:
        # only the number and the superlative are the construction; the words
        # between them ("vùng có doanh số") are what is ranked and stay
        n = n or int(m.group(1))
        direction = "desc" if m.group(2) in _DESC_WORDS else "asc"
        consumed.append(f"{m.group(1)} … {m.group(2)} … nhat")
        span = text[m.start():m.end()]
        rel = m.start(2) - m.start()
        middle = span[rel + len(m.group(2)):]
        middle = middle[:middle.rfind("nhat")]
        # keep what is ranked and the metric; drop the number, the adjective, "nhất"
        text = " ".join((text[:m.start()] + span[len(m.group(1)):rel] + middle + text[m.end():]).split())
    else:
        m = _SUPER.search(text)
        if m:
            direction = direction or ("desc" if m.group(1) in _DESC_WORDS else "asc")
            consumed.append(f"{m.group(1)} … nhat")
            span = text[m.start():m.end()]
            middle = span[span.find(m.group(1)) + len(m.group(1)):]
            middle = middle[:middle.rfind("nhat")]
            text = " ".join((text[:m.start()] + middle + text[m.end():]).split())
    if chosen_metric and direction is None:
        text, m = cut(_EVAL_SUPER, text)
        if m:
            direction = "asc" if m.group(1) in _EVAL_ASC else "desc"
    text, m = cut(_ORDER_DESC, text)
    if m:
        direction = "desc"
    text, m = cut(_ORDER_ASC, text)
    if m:
        direction = "asc"
    text, m = cut(_RANK, text)
    if m:
        direction = direction or "desc"
    if direction:
        if not n and which_one and m_kind_superlative(consumed):
            n = 1  # "which X ... most": the top one (ties kept by the server)
        ranking = {"direction": direction, "n": n if n and n > 0 else None}
    for rx in (_ALL_TIME, _SUBJECT, _EXCLUDE):
        while True:
            text, m = cut(rx, text)
            if not m:
                break
    if followup:
        text = " ".join(w for w in text.split() if not _CONTINUE.fullmatch(w) and w != "sao")
    quantity = False
    while True:
        text, m = cut(_QUANTITY, text)
        if not m:
            break
        quantity = True
    return Intent(content=" ".join(text.split()), ranking=ranking, quantity=quantity, consumed=consumed)
