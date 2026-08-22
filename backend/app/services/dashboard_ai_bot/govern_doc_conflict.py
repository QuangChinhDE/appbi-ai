"""Two authoritative documents saying different things about the same thing.

THE FAILURE THIS PREVENTS
-------------------------
One document says the on-time delivery threshold is 95%; another says 88%. Both are
Published, both are in scope, and retrieval returns both — correctly. What must not
happen next is a reranker putting one on top and an answer stating that number as
the company's threshold. The reader has no way to know they were shown one side of
a disagreement, and the disagreement is the most useful thing in the result.

WHAT IS DETECTED, AND WHAT IS NOT
---------------------------------
NUMBERS. Two passages from different documents that state different values for the
same quantity, in the same unit, under comparable wording.

Not prose contradiction. "Refunds are processed promptly" versus "refunds require
manager approval" may or may not conflict, and deciding that reliably needs a model
reading both with the business context in hand — which is a different mechanism
with a different cost, and pretending a regex does it would produce confident
nonsense on exactly the cases that matter. A numeric disagreement is narrow, common
in policy documents, and checkable; this does that and says so.

WHY IT COMPARES WITHIN A UNIT
-----------------------------
"95%" and "88%" conflict. "95%" and "95 đơn" do not — they are different quantities
that happen to share a number, and treating them as a contradiction would fire on
every document that mentions two things. So a claim is `(value, unit)` and only
same-unit claims are compared.

RESOLUTION IS SEPARATE FROM DETECTION
-------------------------------------
Finding the disagreement is deterministic. Deciding WHICH source is current is a
governance question, answered from `last_verified_at`, `review_date`,
`published_version` and `importance` — and when a deployment has not filled those
in, the honest output is UNRESOLVED, not a guess dressed as an answer. On the
fixtures in this repo those columns are empty, and the resolver says so.
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

RESOLVED = "RESOLVED"
UNRESOLVED = "UNRESOLVED_CONFLICT"

#: A number with a unit attached. Vietnamese decimal commas and thousand dots are
#: both in this corpus, so the value is normalised before comparison.
#:
#: The trailing boundary is a NEGATIVE LOOKAHEAD, not `\b`. `\b` after `%` asserts
#: that the NEXT character is a word character, so "95%" at the end of a sentence
#: — or "**95%**", which is how every figure in this corpus is written — matched
#: nothing at all. The unit list mixes symbols and words and `\b` means opposite
#: things after each. Found by running the pattern against the real passages
#: rather than reading it.
_CLAIM_RE = re.compile(
    r"(?<![\w.,])(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*"
    r"(%|phần trăm|phan tram|tỷ|ty|triệu|trieu|nghìn|nghin|ngày|ngay|giờ|gio|"
    r"đơn|don|USD|VND|đ)(?!\w)",
    re.IGNORECASE,
)

#: Unit spellings that mean the same quantity. Comparing "95%" with "95 phần trăm"
#: as different units would hide a real conflict behind a spelling difference.
_UNIT_CANON = {
    "%": "percent", "phần trăm": "percent", "phan tram": "percent",
    "tỷ": "billion", "ty": "billion",
    "triệu": "million", "trieu": "million",
    "nghìn": "thousand", "nghin": "thousand",
    "ngày": "day", "ngay": "day",
    "giờ": "hour", "gio": "hour",
    "đơn": "order", "don": "order",
    "usd": "usd", "vnd": "vnd", "đ": "vnd",
}

#: How much of the question's own wording a passage must share before its numbers
#: are compared with another document's. Without it, two documents mentioning any
#: two percentages would "conflict".
_MIN_SHARED_TERMS = 2

#: Never compare more than this many passages. Conflict detection reads text that
#: is already in memory, but it is quadratic in claims and a pathological document
#: should not be able to make a search slow.
_MAX_PASSAGES = 12


def _normalise(raw: str) -> float | None:
    """`"1.258.681,34"` and `"92.5"` and `"92,5"` → a float.

    Vietnamese writes thousands with dots and decimals with commas; English does
    the reverse. Guessing wrong turns 1.234 into 1234 and invents a conflict.
    """
    text = raw.strip()
    if "," in text and "." in text:
        # Whichever comes last is the decimal separator.
        text = (text.replace(".", "").replace(",", ".")
                if text.rfind(",") > text.rfind(".")
                else text.replace(",", ""))
    elif "," in text:
        parts = text.split(",")
        text = text.replace(",", ".") if len(parts[-1]) != 3 else text.replace(",", "")
    elif text.count(".") == 1 and len(text.split(".")[-1]) == 3:
        text = text.replace(".", "")        # 1.234 is one thousand two hundred
    try:
        return float(text)
    except ValueError:
        return None


def claims(text: str) -> list[tuple[float, str]]:
    """Every `(value, canonical_unit)` a passage states."""
    out: list[tuple[float, str]] = []
    for raw, unit in _CLAIM_RE.findall(text or ""):
        value = _normalise(raw)
        canon = _UNIT_CANON.get(unit.strip().lower())
        if value is not None and canon:
            out.append((value, canon))
    return out


def detect(question: str, rows: list[dict]) -> dict:
    """Do two documents state different values for the same quantity?

    Only passages the semantic gate judged RELEVANT are compared. A passage that is
    not about the question can hold any number without disagreeing with anything,
    and including them made every multi-document result look contradictory.
    """
    from app.core.text_fold import fold_tokens

    relevant = [r for r in rows if r.get("ce_relevant")][:_MAX_PASSAGES]
    if len({r.get("doc_id") for r in relevant}) < 2:
        return {"conflict": False, "reason": "fewer than two documents are relevant"}

    question_terms = fold_tokens(question)

    # doc_id → unit → {value: passage}
    by_doc: dict[int, dict[str, dict[float, dict]]] = {}
    for row in relevant:
        text = "%s\n%s" % (row.get("heading_path") or "", row.get("content") or "")
        # The passage has to be talking about what was ASKED, not merely be in a
        # document that is.
        if len(fold_tokens(text) & question_terms) < _MIN_SHARED_TERMS:
            continue
        for value, unit in claims(text):
            by_doc.setdefault(int(row["doc_id"]), {}).setdefault(unit, {})[value] = row

    if len(by_doc) < 2:
        return {"conflict": False, "reason": "only one document states a figure"}

    for unit in {u for units in by_doc.values() for u in units}:
        stating = {doc_id: units[unit] for doc_id, units in by_doc.items() if unit in units}
        if len(stating) < 2:
            continue
        values = {doc_id: sorted(vals) for doc_id, vals in stating.items()}
        distinct = {v for vals in values.values() for v in vals}
        if len(distinct) < 2:
            continue          # they agree
        # Two documents, different numbers, same unit, both on-topic.
        sides = [
            {
                "doc_id": doc_id,
                "title": next(iter(stating[doc_id].values())).get("title"),
                "document_version": next(iter(stating[doc_id].values())).get("source_version"),
                "values": vals,
                "chunk_id": next(iter(stating[doc_id].values())).get("chunk_id"),
                "heading_path": next(iter(stating[doc_id].values())).get("heading_path"),
                "last_verified_at": next(iter(stating[doc_id].values())).get("last_verified_at"),
                "review_date": next(iter(stating[doc_id].values())).get("review_date"),
                "importance": next(iter(stating[doc_id].values())).get("importance"),
                "trust": next(iter(stating[doc_id].values())).get("trust"),
                "updated_at": next(iter(stating[doc_id].values())).get("updated_at"),
            }
            for doc_id, vals in values.items()
        ]
        return {"conflict": True, "unit": unit, "sides": sides, **resolve(sides)}

    return {"conflict": False, "reason": "the figures agree"}


#: The order governance signals are consulted in, strongest first. Each is a fact
#: somebody RECORDED, not an inference: an owner pressing "verified" is a stronger
#: statement about currency than a row's `updated_at`, which moves when anyone
#: edits anything.
_RESOLUTION_ORDER = (
    ("last_verified_at", "an owner verified it more recently"),
    ("review_date", "its scheduled review is later"),
    ("importance", "it is marked more important"),
)

#: `updated_at` IS NOT IN THAT LIST, deliberately.
#:
#: It was, and the first real run resolved a conflict in favour of the document
#: titled "Sổ tay vận hành kho (BẢN CŨ)" — because its row happened to be written
#: last. `updated_at` moves when anybody edits anything, including a fixture
#: seeder; it records that a row changed, not that a person stands behind what it
#: now says. Only a signal somebody DELIBERATELY set may decide which of two
#: policies is in force, and when nobody has set one the answer is UNRESOLVED.
#:
#: This is the module's own warning — "a resolver that always produces a winner is
#: a resolver that guesses" — which was written and then contradicted three
#: constants later.

_IMPORTANCE_RANK = {"high": 3, "normal": 2, "low": 1}


def resolve(sides: list[dict]) -> dict:
    """Which side is current — or an explicit refusal to decide.

    A resolver that always produces a winner is a resolver that guesses. On the
    fixtures in this repo every governance column is empty, so there is genuinely
    nothing to decide with, and the answer is UNRESOLVED — which is the output that
    makes an agent say "two sources disagree" instead of quietly picking one.
    """
    for field, why in _RESOLUTION_ORDER:
        values = {}
        for side in sides:
            raw = side.get(field)
            if raw in (None, ""):
                continue
            values[side["doc_id"]] = (
                _IMPORTANCE_RANK.get(str(raw).lower(), 0) if field == "importance"
                else str(raw)
            )
        if len(values) < len(sides) or len(set(values.values())) < 2:
            continue          # not every side has it, or they tie
        winner = max(values, key=lambda doc_id: values[doc_id])
        return {
            "resolution": RESOLVED,
            "current_doc_id": winner,
            "resolved_by": field,
            "summary": _summary(sides, winner, why),
        }

    return {
        "resolution": UNRESOLVED,
        "current_doc_id": None,
        "resolved_by": None,
        "summary": _summary(sides, None, None),
    }


def _summary(sides: list[dict], winner: int | None, why: str | None) -> str:
    """What a reader is told. Both numbers, always — including when one side won,
    because "the current figure is 95%" without "an older handbook says 88%" leaves
    the reader unable to recognise the other number when they meet it."""
    parts = [
        "%s: %s" % (side.get("title") or "doc %s" % side["doc_id"],
                    ", ".join(_pretty(v) for v in side["values"]))
        for side in sides
    ]
    disagreement = "Hai nguồn nêu số khác nhau — " + " | ".join(parts)
    if winner is None:
        return (disagreement + ". Không đủ dữ liệu quản trị (ngày xác minh, "
                "kỳ rà soát, mức quan trọng) để xác định nguồn nào là hiện hành.")
    current = next(s for s in sides if s["doc_id"] == winner)
    return "%s. Nguồn hiện hành: %s (%s)." % (
        disagreement, current.get("title") or "doc %s" % winner, why)


def _pretty(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)
