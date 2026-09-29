"""Question Intent Contract — what the question asks for, resolved once per turn.

Design: docs/features/agent-flow-v3-pilot/intent-contract.md.

AI CONTROLS LOCAL REASONING, RUNTIME CONTROLS THE RULES. One bounded model call
reads the question (and, for a follow-up, the previous one) against the report's OWN
vocabulary — its measures and breakdowns — and must choose from those lists, or say
the asked quantity is absent. The runtime validates every field against the lists;
an invalid or missing field is filled by the heuristic resolvers that existed before.
The contract states what was asked. It never grants, widens scope or selects data.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

#: One call per turn; beyond this the heuristics decide (a slow provider never
#: holds the run hostage to an interpretation step).
INTENT_TIMEOUT_SECONDS = 8.0


def empty_intent() -> dict:
    return {"measures": [], "absent": None, "dimension": None, "members": [], "periods": [],
            "baseline": None, "followup": False, "source": "heuristic", "notes": []}


# ── the report's own vocabulary ────────────────────────────────────────────────

def vocabulary(ctx: Any) -> dict:
    """{measures: {key: label}, dimensions: {key: [chart titles]},
    measures_by_dimension: {dim: [measure keys]}} from the charts in scope."""
    from app.services.agent_flows.tools.dimension_gate import field_key

    measures: dict[str, str] = {}
    dimensions: dict[str, list[str]] = {}
    by_dim: dict[str, list[str]] = {}
    for meta in (getattr(ctx, "chart_meta", None) or {}).values():
        fields = (meta or {}).get("fields") or {}
        labels = fields.get("label_by_field") or {}
        title = str((meta or {}).get("name") or "")
        chart_measures = []
        for m in fields.get("measures") or []:
            ref = m.get("field") if isinstance(m, dict) else m
            if ref:
                k = field_key(str(ref))
                chart_measures.append(k)
                measures.setdefault(k, str((m.get("label") if isinstance(m, dict) else "") or labels.get(ref) or k))
        for d in fields.get("dimensions") or []:
            ref = d.get("field") if isinstance(d, dict) else d
            if ref:
                k = field_key(str(ref))
                bucket = dimensions.setdefault(k, [])
                if title and title not in bucket and len(bucket) < 3:
                    bucket.append(title)
                pair = by_dim.setdefault(k, [])
                pair.extend(m for m in chart_measures if m not in pair)
    return {"measures": measures, "dimensions": dimensions, "measures_by_dimension": by_dim}


#: Bounds on reading the report's own member values: they are what lets "Rio de
#: Janeiro" be resolved to the RJ the rows carry, and they must never make the
#: turn slow. A read is the same cached read a tool would make.
MEMBER_VALUES_PER_DIMENSION = 80
MEMBER_READ_SECONDS = 3.0


def member_values(ctx: Any, dimensions: dict) -> dict[str, list[str]]:
    """{dimension key: [its values as the rows carry them]} for the non-time
    breakdowns in scope, read from one chart grouped by each alone. Never raises."""
    import time

    from app.services.agent_flows.tools.context import _fetch_chart_data
    from app.services.agent_flows.tools.dimension_gate import field_key
    from app.services.time_semantics import looks_like_time_name

    out: dict[str, list[str]] = {}
    started = time.monotonic()
    metas = getattr(ctx, "chart_meta", None) or {}
    for dim in dimensions:
        if looks_like_time_name(dim) or time.monotonic() - started > MEMBER_READ_SECONDS:
            continue
        for cid, meta in metas.items():
            dims = [field_key(str(d.get("field") if isinstance(d, dict) else d))
                    for d in (((meta or {}).get("fields") or {}).get("dimensions") or []) if d]
            if dims != [dim]:
                continue
            try:
                data = _fetch_chart_data(ctx, int(cid))
            except Exception:                                   # noqa: BLE001
                continue
            cols = [field_key(str(c)) for c in data.get("columns") or []]
            if dim not in cols:
                continue
            i = cols.index(dim)
            seen: list[str] = []
            for r in data.get("rows") or []:
                v = r[i] if i < len(r) else None
                if v is not None and str(v) not in seen:
                    seen.append(str(v))
            if len(seen) <= MEMBER_VALUES_PER_DIMENSION:
                out[dim] = seen
            break
    return out


# ── the constrained model call ────────────────────────────────────────────────

_SYSTEM = (
    "You resolve WHAT a BI question asks for, against ONE report's vocabulary. You never "
    "answer the question. Reply with ONE JSON object and nothing else:\n"
    '{"measures": [<keys from MEASURES>], "absent": <null or the asked quantity, in the '
    "user's words, when NO listed measure is it>, \"dimension\": <null or a key from "
    'DIMENSIONS>, "members": [{"said": <the entity only, as the user wrote it>, "code": <the '
    'matching value from MEMBERS, or null>}], "periods": [{"grain": "m"|"q"|"y", "year": <int>, '
    '"n": <month 1-12, quarter 1-4, or null for a year>}], "baseline": <null or a period '
    'object>, "followup": <true when the question only makes sense with the PREVIOUS '
    "question>}\n"
    "Rules: choose measures and dimension ONLY from the lists. A share, percentage of the "
    "total, ranking, top/bottom, change, growth or comparison OF a listed measure IS that "
    "measure, never absent. When the question asks by a breakdown, choose the measure "
    "MEASURES_BY_DIMENSION lists for that breakdown (money by payment type is the payment "
    "measure). A measure that merely shares a generic word (rate, total, số, tỷ lệ) with a "
    "different quantity is NOT the asked quantity: use \"absent\" instead. A member is one "
    "value of a breakdown (a state, a category, a payment type), never a measure, a period "
    "or a breakdown's own name; its code is the MEMBERS value it denotes (a state's name is "
    "its state code). For a follow-up, carry over the previous question's measure/member and "
    "resolve relative periods (\"tháng trước\", \"previous month\") to concrete ones. Do "
    "not invent periods."
)


def _prompt(question: str, previous: str, vocab: dict) -> str:
    return json.dumps({
        "MEASURES": vocab["measures"],
        "DIMENSIONS": vocab["dimensions"],
        "MEASURES_BY_DIMENSION": vocab.get("measures_by_dimension") or {},
        "MEMBERS": vocab.get("members") or {},
        "PREVIOUS_QUESTION": previous or None,
        "QUESTION": question,
    }, ensure_ascii=False)


async def _model_call(*, provider: str, api_key: str, model: str, system: str, user: str) -> str:
    """The one place the resolver talks to a model — through the same vendor adapter
    the answering step uses. Replaced in tests."""
    from app.services.agent_flows.runtime.handlers.agent import _stream

    out = ""
    async for ev in _stream(provider=provider, api_key=api_key, model=model,
                            system_prompt=system, messages=[{"role": "user", "content": user}],
                            tools=[]):
        if ev.type == "text":
            out += ev.text or ""
    return out


def _model_enabled() -> bool:
    """Off in the test environment unless a test replaces `_model_call` — a unit test
    must never reach a vendor; on in every deployed environment."""
    return os.environ.get("ENVIRONMENT", "").lower() != "test" or _model_call is not _DEFAULT_CALL


def _parse(raw: str) -> dict:
    m = re.search(r"\{.*\}", raw or "", re.S)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
    except Exception:                                           # noqa: BLE001
        return {}
    return data if isinstance(data, dict) else {}


def _valid_period(p: Any) -> tuple | None:
    if not isinstance(p, dict):
        return None
    g, y, n = p.get("grain"), p.get("year"), p.get("n")
    if not isinstance(y, int) or not 1900 <= y <= 2100:
        return None
    if g == "y":
        return ("y", y)
    if g == "m" and isinstance(n, int) and 1 <= n <= 12:
        return ("m", y, n)
    if g == "q" and isinstance(n, int) and 1 <= n <= 4:
        return ("q", y, n)
    return None


def _known_member(text: Any, known: dict[str, list[str]]) -> str | None:
    """The report value `text` names, matched accent- and case-insensitively, or None."""
    from app.core.text_fold import fold_text

    if not isinstance(text, str) or not text.strip():
        return None
    want = fold_text(text).replace("_", " ").strip()
    for values in known.values():
        for v in values:
            if fold_text(v).replace("_", " ").strip() == want:
                return v
    return None


def validate(data: dict, vocab: dict) -> dict:
    """Keep only what the report's vocabulary allows; the rest is left to heuristics."""
    out = empty_intent()
    out["source"] = "model"
    ms = [m for m in (data.get("measures") or []) if isinstance(m, str) and m in vocab["measures"]]
    out["measures"] = ms
    absent = data.get("absent")
    out["absent"] = absent.strip() if isinstance(absent, str) and absent.strip() and not ms else None
    dim = data.get("dimension")
    out["dimension"] = dim if isinstance(dim, str) and dim in vocab["dimensions"] else None
    members = []
    known = vocab.get("members") or {}
    for it in data.get("members") or []:
        if isinstance(it, dict) and isinstance(it.get("said"), str) and it["said"].strip():
            code = it.get("code")
            said = it["said"].strip()[:80]
            code = code.strip()[:40] if isinstance(code, str) and code.strip() else None
            if known:
                # The report's values decide: a member names one of them, or it is
                # not a member (a measure, a period or a breakdown's own name).
                hit = _known_member(code, known) or _known_member(said, known)
                if hit is None:
                    out["notes"].append(f"dropped member (no such value in the report): {said}")
                    continue
                code = hit
            members.append({"said": said, "code": code})
    out["members"] = members[:6]
    out["periods"] = [p for p in (_valid_period(x) for x in (data.get("periods") or [])) if p][:6]
    out["baseline"] = _valid_period(data.get("baseline"))
    out["followup"] = bool(data.get("followup"))
    dropped = [k for k in ("measures", "dimension") if data.get(k) and not out.get(k)]
    if dropped:
        out["notes"].append("dropped (not in the report's vocabulary): " + ", ".join(dropped))
    return out


# ── the heuristic floor ───────────────────────────────────────────────────────

def heuristic(state: Any, ctx: Any, question: str) -> dict:
    from app.services.agent_flows.runtime import claim_check
    from app.services.time_semantics import named_periods

    out = empty_intent()
    try:
        t = claim_check.target_of(state, ctx)
        out["measures"] = sorted(t.get("measures") or [])
        out["dimension"] = t.get("dimension")
    except Exception:                                           # noqa: BLE001
        pass
    out["periods"] = sorted(named_periods(question))
    return out


def merge(model: dict, floor: dict, question: str) -> dict:
    """Model fields where valid, heuristic fields otherwise. Periods the question
    names explicitly always stand; the model's are used when it names none."""
    from app.services.time_semantics import named_periods

    out = dict(floor)
    if model:
        out["source"] = "model"
        out["notes"] = list(model.get("notes") or [])
        for k in ("measures", "dimension", "members", "baseline", "followup"):
            if model.get(k):
                out[k] = model[k]
        out["absent"] = model.get("absent") if not model.get("measures") else None
        explicit = sorted(named_periods(question))
        out["periods"] = explicit or list(model.get("periods") or [])
    return out


async def resolve(state: Any, ctx: Any, *, question: str, previous: str,
                  provider: str, api_key: str, model: str) -> dict:
    """The turn's intent. Never raises; a failed model call leaves the heuristics."""
    floor = heuristic(state, ctx, question)
    if not question or not api_key or not provider or not _model_enabled():
        return floor
    vocab = vocabulary(ctx)
    if not vocab["measures"]:
        return floor
    try:
        vocab["members"] = member_values(ctx, vocab["dimensions"])
    except Exception:                                           # noqa: BLE001
        vocab["members"] = {}
    try:
        raw = await asyncio.wait_for(
            _model_call(provider=provider, api_key=api_key, model=model, system=_SYSTEM,
                        user=_prompt(question, previous, vocab)),
            timeout=INTENT_TIMEOUT_SECONDS)
    except Exception:                                           # noqa: BLE001
        logger.info("[intent] model resolution unavailable; heuristics decide", exc_info=True)
        floor["notes"].append("model resolution unavailable")
        return floor
    return merge(validate(_parse(raw), vocab), floor, question)


def describe_for_prompt(intent: dict, locale: str = "vi") -> str:
    """What the answering step is told the question asks for."""
    if not intent or intent.get("source") != "model":
        return ""
    parts = []
    if intent.get("measures"):
        parts.append("đại lượng: " + ", ".join(intent["measures"]))
    if intent.get("absent"):
        parts.append(f"đại lượng được hỏi \"{intent['absent']}\" có thể KHÔNG có trong báo cáo — "
                     "kiểm tra bằng công cụ trước khi kết luận; nếu đúng là không có thì nói rõ, "
                     "không thay bằng một đại lượng khác")
    if intent.get("dimension"):
        parts.append("chiều: " + intent["dimension"])
    if intent.get("members"):
        parts.append("đối tượng: " + ", ".join(
            m["said"] + (f" ({m['code']})" if m.get("code") else "") for m in intent["members"]))
    if intent.get("periods"):
        parts.append("kỳ: " + ", ".join(_label(p) for p in intent["periods"]))
    if intent.get("baseline"):
        parts.append("so với: " + _label(intent["baseline"]))
    if not parts:
        return ""
    return "CÂU HỎI ĐANG HỎI (runtime đã xác định): " + "; ".join(parts) + "."


def _label(p: Any) -> str:
    p = tuple(p)
    return f"{p[1]}-{p[2]:02d}" if p[0] == "m" else f"{p[1]}-Q{p[2]}" if p[0] == "q" else str(p[1])


_DEFAULT_CALL = _model_call
