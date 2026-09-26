# -*- coding: utf-8 -*-
"""Does each figure in the answer MEAN what the question asks about?

Reads the claim ledger (`claim_scope`) and the question's TARGET, resolved by the
runtime's existing resolvers — never by the prose of the answer:

    measure   strong governed matches of the question (`search_business_assets`,
              the resolver's own threshold), widened through the governed
              vocabulary to the fields they are bound to
    dimension the dimension gate's resolution (`requested_dimension`), time excluded
    member    a word of the question that IS a member label the run read

A figure is judged by the evidence that could support it (same value; a percentage
only by a proportion a tool or `compute` produced):

    supported    at least one supporting figure does not contradict the target
    misattributed every supporting figure contradicts it — another breakdown the
                 question does not name, another measure it does not name, or
                 another member of the breakdown asked about
    unsupported  nothing supports it (a percentage no proportion produces; a
                 figure the model derived itself)

A figure that merely has no overlap with the target (a total stated beside a
refusal) is supported. Nothing here decides what the prose attributes a number
to; the check only ever fires on a POSITIVE contradiction or a missing source.
"""
from __future__ import annotations

import unicodedata
from typing import Any

_TOL = 0.005


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s or ""))
    return "".join(c for c in s if not unicodedata.combining(c)).lower().replace("đ", "d")


def _squash(s: str) -> str:
    return "".join(c for c in _fold(s) if c.isalnum())


def _close(a: float, b: float) -> bool:
    scale = max(abs(a), abs(b))
    return a == b or (scale and abs(a - b) / scale <= _TOL)


def _is_time(dim: str | None) -> bool:
    if not dim:
        return False
    if dim == "__time__":
        return True
    from app.services.time_semantics import looks_like_time_name

    return looks_like_time_name(dim)


#: ctx id -> the words of the measures the question named (see `_confirmed`).
_MEASURE_WORDS: dict[int, set[str]] = {}


def _question_measures(ctx: Any, question: str) -> set[str]:
    """Field keys of the measures the question names STRONGLY — the resolver's own
    threshold (two shared terms, or every term of a short question) over the
    governed search, widened through the governed vocabulary."""
    from app.services.agent_flows.tools.dimension_gate import field_key

    measures: set[str] = set()
    try:
        from app.services.agent_flows.tools.packs.discover import (
            _score, _terms_of, _vocabulary, tool_search_business_assets,
        )

        # The search itself, not through the registry: this is the runtime
        # reading the question, not a tool call the step made — it must not count
        # against the step's tool ceiling or appear in its log (found by the
        # golden batch-ceiling test).
        found = tool_search_business_assets(ctx, {"query": question})
        data = found.get("data") if isinstance(found, dict) and isinstance(found.get("data"), dict) else {}
        terms = _terms_of(question)
        for asset in data.get("results") or []:
            if not isinstance(asset, dict) or asset.get("type") not in ("metric", "field"):
                continue
            if str(asset.get("field_kind") or "").lower() == "dimension":
                continue
            ident = asset.get("id") or asset.get("name") or ""
            hay = " ".join(str(asset.get(k) or "") for k in ("id", "name", "detail"))
            strength = _score(hay, terms)
            if ident and (strength >= 2 or (strength and strength == len(terms))):
                for alias in _vocabulary(ctx, str(ident), "measure") or [ident]:
                    measures.add(field_key(str(alias)))
                _MEASURE_WORDS.setdefault(id(ctx), set()).update(
                    _terms_of(" ".join(str(asset.get(k) or "") for k in ("id", "name"))))
    except Exception:                                           # noqa: BLE001
        measures = set()
    return measures


def target_of(state: Any, ctx: Any) -> dict:
    """The question's measure keys, breakdown and member — cached on the state."""
    from app.services.agent_flows.tools.dimension_gate import field_key, requested_dimension

    question = str(getattr(ctx, "question", "") or "")
    # The question's measures cost a search: resolved once per run. Its member is
    # re-read each time — a member label read after the first check must count.
    cache = getattr(state, "_claim_measures", None)
    if cache is None or cache[0] != question:
        cache = (question, _question_measures(ctx, question))
        try:
            state._claim_measures = cache
        except Exception:                                       # noqa: BLE001
            pass
    measures = cache[1]
    try:
        dim = requested_dimension(ctx)
    except Exception:                                           # noqa: BLE001
        dim = None
    dim_key = field_key(dim) if dim and not _is_time(dim) else None
    words = {_squash(w) for w in question.replace("/", " ").split() if _squash(w)}
    member = None
    for e in getattr(state, "claim_ledger", None) or []:
        m = e.get("member")
        if not m or (dim_key and e.get("dimension") != dim_key):
            continue
        sm = _squash(m)
        if not sm:
            continue
        if (len(sm) <= 3 and sm in words) or (len(sm) > 3 and sm in _squash(question)):
            member = sm
            break
    return {"measures": {m for m in measures if m}, "dimension": dim_key, "member": member}


def _confirmed(ctx: Any, dim: str | None) -> bool:
    """Did the question name this breakdown with words that are NOT the words of
    a measure it names? "Bang SP chiếm … doanh thu" names state by "bang"; "Tỷ lệ
    khách hàng quay lại" reaches customer_state only through "khách", a word of
    the measure — that is not a question about states."""
    if not dim:
        return False
    from app.services.agent_flows.tools.dimension_gate import (
        _chart_dimension_vocabulary, _dimension_terms, field_key, title_hits,
    )

    wanted, raw = _dimension_terms(ctx, str(getattr(ctx, "question", "") or ""))
    measure_words = _MEASURE_WORDS.get(id(ctx), set())
    hits: set[str] = set()
    for ref, field_words, title_words in _chart_dimension_vocabulary(ctx):
        if field_key(ref) == dim:
            hits |= (wanted & field_words) | set(title_hits(ctx, raw, title_words))
    from app.services.agent_flows.tools.packs.discover import _terms_of

    folded = {t for h in hits for t in _terms_of(h)} or hits
    return bool(folded - measure_words)


def _names_dimension(ctx: Any, dim: str) -> bool:
    from app.services.agent_flows.tools.dimension_gate import (
        _chart_dimension_vocabulary, _dimension_terms, field_key, title_hits,
    )

    wanted, raw = _dimension_terms(ctx, str(getattr(ctx, "question", "") or ""))
    for ref, field_words, title_words in _chart_dimension_vocabulary(ctx):
        if field_key(ref) == dim and (wanted & field_words or title_hits(ctx, raw, title_words)):
            return True
    return False


def _names_measure(ctx: Any, measure: str) -> bool:
    from app.services.agent_flows.tools.packs.discover import _score, _terms_of

    terms = _terms_of(str(getattr(ctx, "question", "") or ""))
    s = _score(measure.replace("_", " "), terms)
    return s >= 2 or bool(s and s == len(_terms_of(measure.replace("_", " "))))


def _contradiction(e: dict, t: dict, ctx: Any) -> str | None:
    dim = e.get("dimension")
    if dim and not _is_time(dim) and t["dimension"] and dim != t["dimension"] \
            and not _names_dimension(ctx, dim):
        return "other_dimension"
    meas = e.get("measure")
    if meas and t["measures"] and meas not in t["measures"] and not _names_measure(ctx, meas):
        return "other_measure"
    if t["member"] and e.get("member") and (not t["dimension"] or dim == t["dimension"]) \
            and _squash(e["member"]) != t["member"]:
        return "other_member"
    return None


def check(state: Any, ctx: Any, text: str) -> dict:
    """{target, flagged: [{value, pct, why, of}]} for one answer text."""
    from app.services.dashboard_ai_bot.verifier import (
        DEFAULT_TOLERANCE, _claim_alternates, _matches, extract_answer_claims,
    )

    ledger = getattr(state, "claim_ledger", None) or []
    evidence = list(getattr(state, "evidence", None) or [])
    alternates = _claim_alternates(text)

    def in_evidence(v: float) -> bool:
        """The figure verifier's own test: this number WAS read (any reading)."""
        return bool(evidence) and (_matches(v, evidence, DEFAULT_TOLERANCE) or any(
            _matches(a, evidence, DEFAULT_TOLERANCE) for a in alternates.get(v, ())))
    if not ledger or ctx is None:
        return {}
    t = target_of(state, ctx)
    flagged: list[dict] = []
    # WAS THE BREAKDOWN DELIVERED FOR THE MEASURE ASKED? Orders by state do not
    # deliver revenue by state (found by review: measure-blind "delivered").
    wants_member = bool(t["dimension"] and t["measures"] and _confirmed(ctx, t["dimension"]))
    delivered = any(e.get("dimension") == t["dimension"] and
                    (e.get("measure") in t["measures"] or not e.get("measure"))
                    for e in ledger) if wants_member else True
    for value, pct in extract_answer_claims(text):
        if pct:
            support = [e for e in ledger if e.get("ratio") and
                       (_close(value, float(e["value"])) or _close(value, float(e["value"]) * 100))]
        else:
            support = [e for e in ledger if _close(value, float(e["value"]))]
        if not support:
            # NOT DESCRIBED IS NOT INVENTED. The claim ledger describes the tools
            # it has adapters for; the evidence ledger holds everything read. A
            # plain figure the evidence holds is supported (its meaning unknown,
            # so never contradicted). Only a percentage no proportion produced,
            # or a figure nothing read at all, is unsupported.
            if pct:
                if not any(_close(value, float(e["value"])) for e in ledger if e.get("ratio")):
                    flagged.append({"value": value, "pct": pct, "why": "unsupported"})
            elif not in_evidence(value) and (abs(value) >= 1000 or value != int(value)):
                flagged.append({"value": value, "pct": pct, "why": "unsupported"})
            continue
        reasons = [_contradiction(e, t, ctx) for e in support]
        if not all(reasons) and not delivered and all(
                not e.get("dimension") and (not e.get("measure") or e.get("measure") in t["measures"])
                for e, r in zip(support, reasons) if not r):
            # The only support is a WHOLE-REPORT figure of the measure asked, and
            # the report never gave that measure by the breakdown asked: stated
            # as a member's figure it is wrong, stated as the total it is true —
            # the reader is told which it is (never rewritten).
            flagged.append({"value": value, "pct": pct, "why": "whole_as_member",
                            "of": {"measure": next(iter(sorted(t["measures"])), None),
                                   "dimension": None, "member": None}})
            continue
        if all(reasons):
            e = support[0]
            flagged.append({"value": value, "pct": pct, "why": reasons[0],
                            "of": {k: e.get(k) for k in ("measure", "dimension", "member")}})
    return {"target": {**t, "measures": sorted(t["measures"])}, "flagged": flagged}


def _fmt(v: float, pct: bool) -> str:
    s = f"{v:,.2f}".rstrip("0").rstrip(".") if v != int(v) else f"{int(v):,}"
    return s + ("%" if pct else "")


def _what(of: dict | None) -> str:
    of = of or {}
    parts = [p for p in (of.get("member"), (of.get("dimension") or "").replace("_", " "),
                         (of.get("measure") or "").replace("_", " ")) if p and p != "__time__"]
    return " / ".join(parts) or "một đối tượng khác"


_WHY = {
    "other_dimension": "là số của {what} — một chiều khác với chiều câu hỏi hỏi",
    "other_measure": "đo {what} — không phải đại lượng câu hỏi hỏi",
    "other_member": "là số của {what} — không phải đối tượng câu hỏi hỏi",
    "unsupported": "không công cụ nào trong lượt này tạo ra con số này",
    "whole_as_member": ("là số của TOÀN BỘ báo cáo — báo cáo không có số liệu này theo chiều "
                        "được hỏi; nếu giữ, phải nói rõ đó là tổng toàn bộ"),
}


def review_message(flagged: list[dict], target: dict) -> str:
    """What the runtime sends back with a draft whose figures do not stand."""
    lines = [f"- {_fmt(f['value'], f.get('pct'))}: " + _WHY.get(f["why"], f["why"]).format(what=_what(f.get("of")))
             for f in flagged[:8]]
    return (
        "Kiểm tra số liệu trước khi trả lời — những con số sau trong bản nháp không có "
        "nguồn phù hợp với câu hỏi:\n" + "\n".join(lines) + "\n"
        "Nếu còn lượt, hãy lấy đúng số bằng công cụ (compare_periods cho thay đổi giữa hai kỳ, "
        "share_of cho tỷ trọng, compute với tham chiếu {ref, path} cho số suy ra) — không tự "
        "tính. Nếu báo cáo không có dữ liệu phù hợp, bỏ các số đó và nói thẳng là không có. "
        "Giữ nguyên các số khác đã đúng. Trả lời bằng ngôn ngữ của câu hỏi."
    )


def reader_note(flagged: list[dict], locale: str = "vi") -> str:
    """The line a READER sees under an answer whose figures could not be backed."""
    whole = [f for f in flagged if f.get("why") == "whole_as_member"]
    flagged = [f for f in flagged if f.get("why") != "whole_as_member"]
    lines = []
    if whole:
        shown_w = ", ".join(_fmt(f["value"], f.get("pct")) for f in whole[:6])
        lines.append(
            f"⚠️ Report totals: {shown_w} — figures for the whole report; this report does not "
            "give them for the breakdown asked about." if str(locale or "").lower().startswith("en")
            else f"⚠️ Số của toàn bộ báo cáo: {shown_w} — báo cáo không có số liệu này theo chiều "
                 "được hỏi, nên đây không phải số của một đối tượng cụ thể.")
    if not flagged:
        return "\n".join(lines)
    shown = ", ".join(_fmt(f["value"], f.get("pct")) for f in flagged[:6])
    if str(locale or "").lower().startswith("en"):
        lines.append(f"⚠️ Not verified: {shown} — the data this answer read does not produce "
                     "these figures for what was asked. Do not rely on them.")
    else:
        lines.append(f"⚠️ Chưa kiểm chứng: {shown} — dữ liệu mà câu trả lời đã đọc không cho ra các "
                     "con số này cho đúng điều được hỏi. Đừng dùng chúng khi chưa đối chiếu.")
    return "\n".join(lines)
