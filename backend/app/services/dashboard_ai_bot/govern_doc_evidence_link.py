"""From a number that missed its target to the rule that explains it.

WHAT THE AUDIT FOUND
--------------------
Both halves already existed and nothing joined them.

`tools/packs/target.py` produces exactly the evidence object section 21 describes:
`{measure, actual, target, gap, status: "below_target", shortfall_pct, unit}`. The
knowledge pack exposes `search_knowledge`. No code path takes the first and asks the
second why — so a flow could report "on-time delivery 91.2% against a 92% target"
and never reach the document that says which orders are excluded from that rate.

Data says WHAT happened. Documents say what it MEANS, why it is measured that way,
and which rule applies. Joining them is the thing a BI product can do that a
document search cannot, and it was one function away.

WHY THE QUESTION IS BUILT, NOT ASKED
------------------------------------
The obvious design is to hand the measurement to a model and let it write a
question. That costs a round trip before any retrieval, to produce something the
measurement already determines: the metric's name, the direction it missed, and the
words the business uses for both. Those are lookups.

So the query is composed from what is known — the measure, the shortfall, and the
metric's own declared synonyms — and the LLM is left to do what only it can: read
the passages that come back.

THE GRAPH IS A RETRIEVAL CHANNEL, BOUNDED
-----------------------------------------
Section 20 asks for the knowledge graph to retrieve, not just to draw. A measured
metric has a `home_doc_id` — the document somebody DECLARED as its definition — and
that is a fact, not a similarity. It is added directly, and its passages are marked
`reached_by: metric_home` so a reader can tell a declared definition from a lucky
match.

Traversal stops there. One hop, from metric to its home document. Following
doc→doc links from there would pull in whatever anyone ever cross-referenced, and
"bounded" in section 20 is the whole instruction.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

#: Signals worth asking a document about. A metric that BEAT its target rarely
#: needs a policy explaining why; one that missed it always does.
_INTERESTING = ("below_target",)

#: Words that turn a measurement into a question a document might answer. Chosen
#: for what business documents actually contain: a target has exclusions, a
#: shortfall has causes, a metric has a definition that decides what counts.
_ASPECTS = ("định nghĩa", "cách tính", "trường hợp loại trừ", "nguyên nhân")

#: Never build a question longer than this. It is embedded, and a query stuffed
#: with every synonym retrieves the average of them rather than any of them.
_MAX_TERMS = 6


def from_measurement(payload: Any) -> dict | None:
    """The evidence object, if this tool result is one.

    Recognised by SHAPE rather than by tool name: `target.py` is one producer today
    and a second will not be renamed to match. A result carrying a measure, a
    status and a target is a measurement whoever wrote it.
    """
    if not isinstance(payload, dict):
        return None
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    status = data.get("status")
    measure = data.get("measure")
    if not status or not measure or "target" not in data:
        return None
    return {
        "measure": str(measure),
        "status": str(status),
        "actual": data.get("actual"),
        "target": data.get("target"),
        "gap": data.get("gap"),
        "shortfall_pct": data.get("shortfall_pct"),
        "unit": data.get("unit"),
        "chart_id": data.get("chart_id"),
    }


def is_interesting(evidence: dict | None) -> bool:
    """Is there a "why" worth asking about?"""
    return bool(evidence) and evidence.get("status") in _INTERESTING


def _metric_for(db: Any, measure: str) -> dict | None:
    """The governed KPI this measure names, with its aliases and home document.

    Matched on the FOLDED form against every recorded name and synonym, because a
    chart column is written however the modeller wrote it — "on_time_rate",
    "Tỷ lệ đúng hẹn" — and the metric record is where the business said which of
    those mean the same thing.
    """
    from sqlalchemy import text as _text

    from app.core.text_fold import fold_text

    folded_measure = fold_text(measure.replace("_", " "))
    if not folded_measure:
        return None
    try:
        rows = db.execute(_text(
            "SELECT name, display_name, synonyms, home_doc_id FROM govern_metrics"
        )).fetchall()
    except Exception:  # noqa: BLE001 — the link is an enhancement, never a gate
        logger.warning("evidence_link: metric lookup failed", exc_info=True)
        return None

    for name, display, synonyms, home_doc_id in rows:
        forms = [name, display, *_as_list(synonyms)]
        readable = [str(f or "").replace("_", " ").strip() for f in forms]
        folded = {fold_text(f): f for f in readable if f}
        if any(key and (key in folded_measure or folded_measure in key)
               for key in folded):
            return {
                "name": name,
                "display_name": display,
                "aliases": [f for f in readable if f],
                "home_doc_id": home_doc_id,
            }
    return None


def _as_list(value: Any) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        import json

        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except Exception:  # noqa: BLE001
            return []
    return []


def to_question(db: Any, evidence: dict) -> dict:
    """`{question, terms, home_doc_id, reason}` — what to ask the knowledge base.

    The question names the metric in the words the DOCUMENTS use, not the words the
    chart column uses. A column called `on_time_rate` retrieves nothing from a
    corpus that says "tỷ lệ giao đúng hẹn"; the metric record is the translation
    between them and it is already written down.
    """
    metric = _metric_for(db, evidence["measure"])
    if metric:
        terms = metric["aliases"][:_MAX_TERMS]
        subject = metric["display_name"] or metric["name"]
        home_doc_id = metric["home_doc_id"]
    else:
        # No governed metric under this name. The column itself is still a better
        # query than nothing — and saying WHY the link is weak matters more than
        # pretending it is not.
        terms = [evidence["measure"].replace("_", " ")]
        subject = terms[0]
        home_doc_id = None

    aspects = list(_ASPECTS)
    question = "%s — %s" % (subject, ", ".join(aspects))
    return {
        "question": question,
        "terms": terms,
        "home_doc_id": home_doc_id,
        "metric": metric["name"] if metric else None,
        # WHY this retrieval is happening at all, in words a reader of the trace
        # can follow. "The bot searched the documents" explains nothing; "it missed
        # its target by 0.8 points and went looking for the rule" explains it.
        "reason": _reason(evidence, subject),
        "grounded_in": {
            "measure": evidence["measure"],
            "actual": evidence.get("actual"),
            "target": evidence.get("target"),
            "status": evidence.get("status"),
        },
    }


def _reason(evidence: dict, subject: str) -> str:
    shortfall = evidence.get("shortfall_pct")
    unit = evidence.get("unit") or ""
    measured = "%s so với mục tiêu %s%s" % (
        evidence.get("actual"), evidence.get("target"), (" " + unit) if unit else "")
    if shortfall is not None:
        return ("%s đạt %s (thiếu %s%%) — tra tài liệu để biết định nghĩa, cách "
                "tính và các trường hợp loại trừ." % (subject, measured, shortfall))
    return "%s đạt %s — tra tài liệu để biết cách chỉ số này được định nghĩa." % (
        subject, measured)


def home_doc_passages(db: Any, home_doc_id: int | None, question: str, *,
                      scope: Any = None, k: int = 3) -> list[dict]:
    """Passages from the document DECLARED to define this metric.

    A deterministic channel, not a similarity one: somebody recorded that this
    document defines this KPI, and that is a stronger statement than a good cosine.
    Scope-constrained — naming a metric does not grant access to the document that
    defines it, and this can only surface what the caller could already reach.

    One hop. Section 20 asks for graph retrieval and asks for it BOUNDED; following
    doc→doc links from here would pull in whatever anyone once cross-referenced.
    """
    if not home_doc_id:
        return []
    allowed = set(scope or [])
    if allowed and int(home_doc_id) not in allowed:
        return []
    from app.services.dashboard_ai_bot.govern_doc_embeddings import search_doc_chunks

    rows = search_doc_chunks(db, question, k=k, doc_ids={int(home_doc_id)}) or []
    for row in rows:
        row["reached_by"] = "metric_home"
        row["reached_note"] = (
            "the document declared as this metric's definition, reached through "
            "the governance graph rather than by similarity"
        )
    return rows
