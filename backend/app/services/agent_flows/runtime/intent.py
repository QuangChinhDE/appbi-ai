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
    names: dict[str, list[str]] = {}
    carriers: dict[str, list[tuple[int, list[str], str]]] = {}
    for cid, meta in (getattr(ctx, "chart_meta", None) or {}).items():
        fields = (meta or {}).get("fields") or {}
        labels = fields.get("label_by_field") or {}
        title = str((meta or {}).get("name") or "")
        chart_measures = []
        chart_dims = [field_key(str(d.get("field") if isinstance(d, dict) else d))
                      for d in (fields.get("dimensions") or []) if d]
        for m in fields.get("measures") or []:
            ref = m.get("field") if isinstance(m, dict) else m
            if ref:
                k = field_key(str(ref))
                chart_measures.append(k)
                carriers.setdefault(k, []).append((int(cid), chart_dims, title))
                seen = names.setdefault(k, [])
                for n in (title, str(ref), str((m.get("label") if isinstance(m, dict) else "") or "")):
                    if n and n not in seen:
                        seen.append(n)
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
    return {"measures": measures, "dimensions": dimensions, "measures_by_dimension": by_dim,
            "measure_names": names, "carriers": carriers}


def charts_for(intent: dict, vocab: dict, limit: int = 3) -> list[dict]:
    """The in-scope charts that carry what the turn asks for — the chart ids the
    answering step should measure with, instead of guessing one.

    Live efaa3873 runs 7291/7260: the measure was resolved (distinct_sellers,
    late_orders) and the model still called total_measure on chart_id 2 and 1. A
    breakdown asked prefers a chart grouped by exactly that breakdown; a single
    figure asked prefers a chart with no breakdown. Only charts already in scope
    (`ctx.chart_meta`) are named, so nothing is widened."""
    from app.services.time_semantics import looks_like_time_name

    dim = intent.get("dimension")
    out: list[dict] = []
    for m in intent.get("measures") or []:
        rows = (vocab.get("carriers") or {}).get(m) or []

        def rank(r):
            cid, dims, _title = r
            if dim:
                return 0 if dims == [dim] else 1 if dim in dims else 3
            if intent.get("periods"):
                return 0 if any(looks_like_time_name(d) for d in dims) and len(dims) == 1 else 2
            return 0 if not dims else 2
        for cid, dims, title in sorted(rows, key=rank)[:limit]:
            if rank((cid, dims, title)) < 3:
                out.append({"chart_id": cid, "measure": m, "by": dims, "title": title})
    return out[: limit * 2]


#: Words that say HOW a quantity is counted, not WHICH quantity it is. Sharing
#: one of these ("tỷ lệ", "total") is exactly the false match the absent field
#: exists to reject; sharing anything else means the report measures it.
_GENERIC = {
    "ty", "le", "rate", "ratio", "tong", "total", "so", "luong", "count", "number", "of",
    "trung", "binh", "avg", "average", "mean", "gia", "tri", "value", "cua", "the", "a",
    "la", "bao", "nhieu", "what", "is", "how", "many", "much", "in", "by", "theo", "va",
    "and", "per", "pct", "percent", "phan", "tram", "share", "chiem", "olist", "page",
    "dataset", "table", "cac", "nhung", "mot", "sum", "tb", "luot", "cai", "khach", "hang",
}


def _words(text: str) -> list[str]:
    from app.core.text_fold import fold_text

    return [w for w in re.split(r"[^0-9a-z]+", fold_text(text or "").replace("_", " ")) if w]


def _stem(w: str) -> str:
    return w[:-1] if len(w) > 4 and w.endswith("s") and not w.endswith("ss") else w


def _terms(text: str, *, singles: bool) -> set:
    """Distinctive terms: consecutive word pairs (a Vietnamese concept is two
    syllables — "vận chuyển" is not "chuyển đổi"), and, when `singles`, single
    words of four letters or more (an English field name: "freight", "review")."""
    ws = _words(text)
    out: set = {(a, b) for a, b in zip(ws, ws[1:])
                if not (a in _GENERIC and b in _GENERIC) and not (a.isdigit() or b.isdigit())}
    if singles:
        out |= {_stem(w) for w in ws if len(w) >= 4 and w not in _GENERIC and not w.isdigit()}
    return out


def titled_measure(question: str, chosen: list[str], vocab: dict) -> str | None:
    """The one measure the QUESTION names in the report's own words, when the model
    chose a measure the question does not name at all.

    Live a2d2e68b run 6675: "Bang nào có lệch hẹn giao trung bình thấp nhất?" was
    resolved to avg_delivery_days; the report titles avg_delay_days "Lệch hẹn giao TB
    theo bang". Only a word pair that belongs to exactly ONE measure's names counts —
    "theo bang" is in a dozen titles and names nothing.
    """
    names = vocab.get("measure_names") or {}
    terms = {k: _terms(" | ".join([k, str(lbl), *names.get(k, [])]), singles=False)
             for k, lbl in (vocab.get("measures") or {}).items()}
    owners: dict = {}
    for k, ts in terms.items():
        for t in ts:
            owners.setdefault(t, set()).add(k)
    asked = _terms(question, singles=False)
    hits = {k for t in asked for k in owners.get(t, ()) if len(owners[t]) == 1}
    if len(hits) == 1:
        best = next(iter(hits))
        if best not in chosen and not any(asked & terms.get(c, set()) for c in chosen):
            return best
    # THE AGGREGATION THE QUESTION ASKS FOR. Live efaa3873 run 7329: "Trung bình mỗi
    # lần thanh toán trả góp bao nhiêu kỳ?" resolved to payment_count; "trả góp" is
    # in both installment titles, so no word pair decided. Of the measures the
    # question's words DO reach, exactly one is an average — that one is asked.
    kind = _asked_aggregation(question)
    if not kind:
        return None
    reached = {k for t in asked for k in owners.get(t, ())}
    fitting = [k for k in reached if _aggregation_of(k) == kind]
    if len(fitting) == 1 and fitting[0] not in chosen \
            and not any(_aggregation_of(c) == kind for c in chosen):
        return fitting[0]
    return None


_AGG_WORDS = {"avg": ("trung binh", "average", "avg", "mean", "binh quan"),
              "rate": ("ty le", "rate", "phan tram", "percent", "percentage")}


def _asked_aggregation(question: str) -> str | None:
    folded = " ".join(_words(question))
    kinds = [k for k, ws in _AGG_WORDS.items() if any(f" {w} " in f" {folded} " for w in ws)]
    return kinds[0] if len(kinds) == 1 else None


def _aggregation_of(measure_key: str) -> str | None:
    k = f"_{str(measure_key).lower()}_"
    if any(f"_{w}_" in k for w in ("avg", "average", "mean")):
        return "avg"
    if any(f"_{w}_" in k for w in ("rate", "pct", "ratio", "share")):
        return "rate"
    return None


def absent_is_real(absent: str, vocab: dict) -> bool:
    """Whether the quantity called absent is really outside the report.

    Holdout run at 422b8fd2: "Tổng phí vận chuyển" (the report's own
    total_freight), "total reviews" and "lượt đánh giá 1 sao" were resolved absent
    and answered "not in the report" with no tool call. A quantity sharing a
    distinctive term with a measure's key, label or chart title is measured here;
    "tỷ lệ chuyển đổi của website" shares only "tỷ lệ" with the on-time rate.
    """
    want = _terms(absent, singles=True)
    if not want:
        return False
    names = vocab.get("measure_names") or {}
    for key, label in (vocab.get("measures") or {}).items():
        have = _terms(f"{key} {label}", singles=True) | _terms(" | ".join(names.get(key, [])), singles=False)
        if want & have:
            return False
    return True


#: Bounds on reading the report's own member values: they are what lets "Rio de
#: Janeiro" be resolved to the RJ the rows carry, and they must never make the
#: turn slow. A read is the same cached read a tool would make.
MEMBER_VALUES_PER_DIMENSION = 80
MEMBER_READ_SECONDS = 3.0


def member_values(ctx: Any, dimensions: dict, coverage: dict | None = None) -> dict[str, list[str]]:
    """{dimension key: [its values as the rows carry them]} for the non-time
    breakdowns in scope, read from one chart grouped by each alone. Never raises.

    When `coverage` is given, a TIME breakdown's first and last period (as the rows
    label them) is recorded in it — what "tháng gần nhất" / "latest month" means in
    THIS report. Live efaa3873 (g4_mom, g6): the model resolved "the latest month" to
    2023-10 from its own clock; the report ends in 2018."""
    import time

    from app.services.agent_flows.tools.context import _fetch_chart_data
    from app.services.agent_flows.tools.dimension_gate import field_key
    from app.services.time_semantics import looks_like_time_name

    out: dict[str, list[str]] = {}
    started = time.monotonic()
    metas = getattr(ctx, "chart_meta", None) or {}
    for dim in dimensions:
        timed = looks_like_time_name(dim)
        if (timed and coverage is None) or time.monotonic() - started > MEMBER_READ_SECONDS:
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
            if timed:
                labels = sorted(v for v in seen if v)
                if labels:
                    coverage[dim] = (labels[0], labels[-1])
            elif len(seen) <= MEMBER_VALUES_PER_DIMENSION:
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
    "its state code). Relative periods (\"gần nhất\", \"latest\", \"this month\", \"last month\") are relative "
    "to DATA_PERIODS.last — the report's own last period — never to today's date. "
    "For a follow-up, carry over the previous question's measure/member and "
    "resolve relative periods (\"tháng trước\", \"previous month\") to concrete ones. Do "
    "not invent periods."
)


def _prompt(question: str, previous: str, vocab: dict) -> str:
    return json.dumps({
        "MEASURES": vocab["measures"],
        "DIMENSIONS": vocab["dimensions"],
        "MEASURES_BY_DIMENSION": vocab.get("measures_by_dimension") or {},
        "MEMBERS": vocab.get("members") or {},
        "DATA_PERIODS": {k: {"first": a, "last": b} for k, (a, b) in (vocab.get("coverage") or {}).items()},
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


def _is_vocabulary(text: str, vocab: dict) -> bool:
    """`text` names a measure, a breakdown or a period — never a member."""
    from app.services.time_semantics import named_periods

    if named_periods(text) or _terms(text, singles=False) and not absent_is_real(text, vocab):
        return True
    words = set(_words(text))
    keys = {w for k in (*(vocab.get("measures") or {}), *(vocab.get("dimensions") or {}),
                        *(vocab.get("members") or {}))
            for w in _words(k) if len(w) >= 3 and w not in _GENERIC}
    return bool(words & keys) or bool(words & _PERIOD_WORDS)


_PERIOD_WORDS = {"thang", "quy", "month", "quarter", "year", "week", "tuan", "ngay", "day"}


def validate(data: dict, vocab: dict) -> dict:
    """Keep only what the report's vocabulary allows; the rest is left to heuristics."""
    out = empty_intent()
    out["source"] = "model"
    ms = [m for m in (data.get("measures") or []) if isinstance(m, str) and m in vocab["measures"]]
    out["measures"] = ms
    absent = data.get("absent")
    out["absent"] = absent.strip() if isinstance(absent, str) and absent.strip() and not ms else None
    if out["absent"] and not absent_is_real(out["absent"], vocab):
        out["notes"].append(f"not absent (the report measures it): {out['absent']}")
        out["absent"] = None
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
                # The report's values decide the code: a member naming one of them
                # carries it. One naming none is kept without a code (a state's full
                # name is not in rows that say "RJ") — unless it is the report's own
                # vocabulary (a measure, a breakdown) or a period, which are never
                # members.
                hit = _known_member(code, known) or _known_member(said, known)
                if hit is None and _is_vocabulary(said, vocab):
                    out["notes"].append(f"dropped member (a measure, breakdown or period): {said}")
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
        vocab["coverage"] = {}
        vocab["members"] = member_values(ctx, vocab["dimensions"], vocab["coverage"])
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
    model = validate(_parse(raw), vocab)
    better = titled_measure(question, model.get("measures") or [], vocab)
    if better:
        model["notes"].append(f"measure by the question's own words: {better} "
                              f"(model chose {model.get('measures')})")
        model["measures"], model["absent"] = [better], None
    out = merge(model, floor, question)
    try:
        out["charts"] = charts_for(out, vocab)
    except Exception:                                           # noqa: BLE001
        out["charts"] = []
    if vocab.get("coverage"):
        out["coverage"] = {k: list(v) for k, v in vocab["coverage"].items()}
    return out


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
    if intent.get("charts"):
        parts.append("biểu đồ đo đúng điều này (dùng chart_id này, không đoán): " + "; ".join(
            f"{c['chart_id']} = {c['title'] or c['measure']}" for c in intent["charts"][:4]))
    for dim, (first, last) in (intent.get("coverage") or {}).items():
        # "Gần nhất" is the REPORT's last period, not today's (live efaa3873: the
        # answering step compared 2023-10 with 2023-09 on a report that ends in 2018).
        parts.append(f"dữ liệu theo {dim} có từ {first} đến {last} — \"gần nhất\"/\"latest\" "
                     f"là {last}, không phải theo ngày hôm nay")
    if not parts:
        return ""
    return "CÂU HỎI ĐANG HỎI (runtime đã xác định): " + "; ".join(parts) + "."


def _label(p: Any) -> str:
    p = tuple(p)
    return f"{p[1]}-{p[2]:02d}" if p[0] == "m" else f"{p[1]}-Q{p[2]}" if p[0] == "q" else str(p[1])


_DEFAULT_CALL = _model_call
