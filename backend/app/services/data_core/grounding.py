"""Hold a validated plan to the QUESTION's own words (server-side, deterministic).

`planner.validate` proves the plan only uses fields this person may read. It cannot
prove the plan answers what was asked. The independent holdout (2026-10-21, 40 new
questions, gpt-4o-mini) showed exactly that gap: "lợi nhuận" answered with sales,
"tỷ lệ chuyển đổi của website" answered with an order count, a forecast answered
with history, the filter "khách hàng doanh nghiệp" silently dropped, and breakdowns
nobody asked for (month, a numeric column) added to the answer.

The rules here only compare the question's words with the catalog's own labels,
synonyms and the plan's filter values — no model is involved:

  * a measure or a breakdown the question never mentions is removed (a plan with
    no mentioned measure left is refused: the data has no such metric);
  * every meaningful word of the question must be explained by a field the plan
    uses, a filter value, or (when the plan groups by time) time vocabulary; a
    word nothing explains is a refusal naming it, never a silent drop;
  * a filter whose value is its own field's label is noise and is removed.

Matching is on syllables with case and Vietnamese tone marks folded, so
"huỷ"/"hủy"/"Huỷ" are one word.
"""
from __future__ import annotations

import contextvars
import re
import unicodedata
from dataclasses import replace
from typing import Iterable, Optional

# Function words, question words and analysis verbs that carry no data meaning.
_STOP = set("""
a ai bao bi bieu bo cac cach chi cho chua co con cua cung da dang dau de den di do doi duoc gi gia giai giup hay hien hoi hon khac khi khong kia la lam lai luon ma moi mot muon nao nay neu nhieu nhu nhung nhat nua o phai qua ra roi sang sao so sanh ta tai tat the theo thi thu thuc tinh to toan trong tu tung va van ve vi voi xem xin tong cong hang tach them rieng bang danh sach liet ke the nao the hien bao nhieu dang ky tu den gan day nhat cao thap lon nho manh yeu tang giam bien dong xu huong ket qua phan tich thay mang lai dem nhieu it minh toi chia ben thoi nhe vay oi a
cai chiec het du lieu lay gio
by per of in for each and total
""".split())  # last line: English connectives (the English UI's examples, mixed questions)
# Words that are explained by grouping on a time field.
_TIME = set("ngay tuan thang quy nam thoi gian gan day xu huong bien dong".split())


def fold(text: str) -> str:
    text = unicodedata.normalize("NFD", str(text or "").lower().replace("đ", "d"))
    return "".join(c for c in text if unicodedata.category(c) != "Mn")


def syllables(text: str) -> set[str]:
    return {w for w in re.split(r"[^0-9a-z]+", fold(text)) if w}


#: the folded question being grounded (set by `ground`): a synonym counts only when
#: its WHOLE phrase is in it. Dev regression 2026-10-22: the governed synonym
#: "loại sản phẩm" let the single syllable "loại" in "mỗi loại" name the category.
_ASKED: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("analyst_asked", default=None)


def _phrase_in(phrase: str, folded: str) -> bool:
    p = " ".join(w for w in re.split(r"[^0-9a-z]+", fold(phrase)) if w)
    return bool(p) and f" {p} " in f" {folded} "


def _field_words(field) -> set[str]:
    words = syllables(field.label) | syllables(field.ref.rsplit(".", 1)[-1].replace("_", " "))
    asked = _ASKED.get()
    for s in field.synonyms or ():
        if asked is None or _phrase_in(s, asked):
            words |= syllables(s)
    return words


_GENERIC = {"so", "id", "ma", "hang", "don"}


def _mentioned(field, q: set[str], question_folded: str = "") -> bool:
    """The question names this field: its whole label (or a synonym) appears in it,
    or it shares a word that is not generic — "số", "hàng", "đơn" are in half the
    labels of a commerce model ("Ngày đặt hàng" is not asked by "số đơn hàng")."""
    texts = [field.label, *(field.synonyms or ())]
    if question_folded and any(fold(t).strip() and f" {fold(t).strip()} " in f" {question_folded} " for t in texts):
        return True
    return bool((_field_words(field) - _GENERIC) & q)


def is_function_phrase(phrase: str, *, has_time: bool, source_words: set[str] | None = None) -> bool:
    """A question phrase that names no data: only function/analysis words, or only
    time words when the plan groups by time (holdout: the model mapped "biến động
    ra sao", "tổng cộng" and "theo tháng" to null and the turn was refused)."""
    from app.services.data_core.intent import extract

    # request framing, a ranking or a quantity question is a construction, not a field
    words = syllables(extract(phrase).content) - _STOP - (source_words or set())  # naming the dataset names no field
    return not words or (has_time and {w for w in words if not w.isdigit()} <= _TIME)


def _entity_words(fields, used_refs) -> set[str]:
    """Words that name the ENTITY a used field belongs to: shared by the labels of at
    least two fields of that field's view ("khách" in "Số khách hàng" and "Phân khúc
    khách hàng" names the customer; set 9: "theo miền của khách"). Derived from the
    model's own labels, never a word list; generic words excluded."""
    views = {r.rsplit(".", 1)[0] for r in used_refs}
    out: set[str] = set()
    for v in views:
        counts: dict[str, int] = {}
        for f in fields:
            if f.ref.rsplit(".", 1)[0] == v:
                for w in syllables(f.label) - _GENERIC - _STOP:
                    counts[w] = counts.get(w, 0) + 1
        out |= {w for w, n in counts.items() if n >= 2 and not w.isdigit()}
    return out


def _valid_phrases(covered: dict, question: str, q: set[str], fields: dict) -> dict[str, set[str]]:
    """ref -> the question words the model says that field answers. A phrase counts
    only if every word of it is in the question and it is not (nearly) the whole
    question — holdout: the model mapped the entire question to one field."""
    out: dict[str, set[str]] = {}
    content = q - _STOP
    vocab: set[str] = set()
    for fld in fields.values():
        if fld.kind == "dimension":  # entities ("sản phẩm"), never another metric's words
            vocab |= _field_words(fld)
    vocab -= _GENERIC
    for phrase, ref in (covered or {}).items():
        words = syllables(phrase)
        if not isinstance(ref, str) or not words or not words <= q:
            continue
        if len(content) >= 3 and content <= words:
            continue  # the whole question mapped to one field is not a mapping
        f = fields.get(ref)
        if f is not None and _vietnamese(f):
            # A field the owner named in Vietnamese can be compared word for word:
            # a phrase sharing nothing with it is the model's guess, not a mapping
            # (holdout: "lợi nhuận" -> "Doanh số"), and only the SHARED words are
            # explained by it — "dự kiến" in "doanh số dự kiến" (holdout set 5: a
            # forecast answered with history) or "Online" in "kênh Online" stay to be
            # explained by a real value or refused. Only a field named in another
            # language ("Revenue") needs the model's whole phrase as the bridge.
            shared = words & _field_words(f)
            if not (shared - {"so", "id", "ma"}):
                continue
            extra = words - shared - _STOP
            # A phrase keeps only extra words that are themselves catalog vocabulary
            # ("số lượng SẢN PHẨM bán ra"). A word no field knows stays unexplained:
            # a modifier ("dự kiến"), another entity ("NGƯỜI bán" is not "Kênh bán")
            # or a synonym the model has not got governed metadata for ("vùng MIỀN").
            words = shared | (extra & vocab)
        out.setdefault(ref, set()).update(words)
    return out


def _phrase_words(covered: dict, ref: str, q: set[str]) -> set[str]:
    """All words of the question phrases the model mapped to `ref` (in the question)."""
    out: set[str] = set()
    for phrase, target in (covered or {}).items():
        words = syllables(phrase)
        if target == ref and words and words <= q:
            out |= words
    return out


def _capitalised(question: str) -> set[str]:
    return {fold(t) for t in re.findall(r"\w+", str(question))[1:] if t[:1].isupper() or t.isdigit()}


_YEAR = re.compile(r"\b(19|20)\d\d\b")
# a follow-up that ADDS a breakdown to the previous one ("chia tiếp", "thêm", "cả", "kèm")
_ADD_BREAKDOWN = re.compile(r"\b(chia tiep|tiep theo|them|ca|kem|cung voi|va)\b")
_GRAIN_ASKED = re.compile(r"\b(theo|moi|tung|hang|qua|cac)\s+(ngay|tuan|thang|quy|nam)\b")
_SUB_YEAR = re.compile(r"\b(quy|thang|ngay|tuan|nua|dau|cuoi|q[1-4]|tu|den|toi|truoc|sau)\b|\d{1,2}/\d{4}")


def whole_year(question: str) -> Optional[int]:
    """The year when the question's period is exactly one WHOLE calendar year
    ("năm 2025", "Năm 2025 ... mỗi quý"), else None. A breakdown ("mỗi quý",
    "theo tháng") is not a narrower period."""
    qf = _GRAIN_ASKED.sub(" ", fold(str(question or "")))
    years = {int(m.group(0)) for m in _YEAR.finditer(qf)}
    if len(years) != 1 or _SUB_YEAR.search(qf):
        return None
    return years.pop()


_QUARTER = re.compile(r"\b(?:quy|q)\s*([1-4])\s*(?:/|nam|-|\s)\s*((?:19|20)\d\d)\b")
_MONTH = re.compile(r"\bthang\s*(1[0-2]|0?[1-9])\s*(?:/|nam|-|\s)\s*((?:19|20)\d\d)\b")
_RANGE_WORDS = re.compile(r"\b(tu|den|toi|truoc|sau|nua|dau|cuoi|so voi)\b")


def asked_period(question: str) -> Optional[tuple[str, str]]:
    """[from, to) when the question names exactly ONE whole calendar period - a year
    ("năm 2025"), a quarter ("quý 4 năm 2025", "Q2/2026") or a month ("tháng 3/2025") -
    else None. A breakdown ("mỗi quý") is not a period; ranges, comparisons and parts
    of a period ("từ … đến", "nửa đầu", "so với") are left as planned."""
    from datetime import date

    year = whole_year(question)
    if year is not None:
        return f"{year}-01-01", f"{year + 1}-01-01"
    qf = _GRAIN_ASKED.sub(" ", fold(str(question or "")))
    if _RANGE_WORDS.search(qf):
        return None
    quarters = {(int(m.group(1)), int(m.group(2))) for m in _QUARTER.finditer(qf)}
    months = {(int(m.group(1)), int(m.group(2))) for m in _MONTH.finditer(qf)}
    # every quarter / month the question MENTIONS, with or without a year: "quý 1 và quý 2
    # năm 2025" names two quarters and is left as planned, never narrowed to one
    if len(set(re.findall(r"\b(?:quy|q)\s*([1-4])\b", qf))) > 1 or len(set(re.findall(r"\bthang\s*(\d{1,2})\b", qf))) > 1:
        return None
    if len(quarters) == 1 and not months:
        q, y = quarters.pop()
        start = date(y, 3 * (q - 1) + 1, 1)
        end = date(y + 1, 1, 1) if q == 4 else date(y, 3 * q + 1, 1)
        return start.isoformat(), end.isoformat()
    if len(months) == 1 and not quarters:
        mo, y = months.pop()
        end = date(y + 1, 1, 1) if mo == 12 else date(y, mo + 1, 1)
        return date(y, mo, 1).isoformat(), end.isoformat()
    return None


def _vietnamese(field) -> bool:
    texts = [field.label, *(field.synonyms or ())]
    return any(fold(t) != str(t or "").lower() for t in texts)


_YEARLESS_QUARTER = re.compile(r"\b(?:quy|q)\s*([1-4])\b")
_YEARLESS_MONTH = re.compile(r"\bthang\s*(1[0-2]|0?[1-9])\b")


def yearless_period(question: str) -> Optional[tuple[str, int]]:
    """("quarter", n) or ("month", n) when the question names exactly ONE quarter or
    month and no year ("còn quý 3 thì sao", "thế còn tháng 11?"), else None."""
    if _YEAR.search(str(question or "")):
        return None
    qf = _GRAIN_ASKED.sub(" ", fold(str(question or "")))
    if _RANGE_WORDS.search(qf):
        return None
    quarters = set(_YEARLESS_QUARTER.findall(qf))
    months = set(_YEARLESS_MONTH.findall(qf))
    if len(quarters) == 1 and not months:
        return "quarter", int(quarters.pop())
    if len(months) == 1 and not quarters:
        return "month", int(months.pop())
    return None


def _period_in_year_of(cond: dict, period: tuple[str, int]) -> Optional[tuple[str, str]]:
    """The named quarter/month in the ONE calendar year a previous date_range lies in,
    or None when that range spans more than one year (the year is then unknown)."""
    from datetime import date, timedelta

    v = cond.get("value") if isinstance(cond, dict) else None
    try:
        start = date.fromisoformat(str(v["from"])[:10])
        last = date.fromisoformat(str(v["to"])[:10]) - timedelta(days=1)  # [from, to)
    except (KeyError, TypeError, ValueError):
        return None
    if start.year != last.year:
        return None
    y, (kind, n) = start.year, period
    if kind == "quarter":
        begin, end = date(y, 3 * (n - 1) + 1, 1), (date(y + 1, 1, 1) if n == 4 else date(y, 3 * n + 1, 1))
    else:
        begin, end = date(y, n, 1), (date(y + 1, 1, 1) if n == 12 else date(y, n + 1, 1))
    return begin.isoformat(), end.isoformat()


def _lexical(field, q: set[str], qf: str) -> bool:
    return _mentioned(field, q, qf)


def _swap_bridged(plan, q, qf, phrases, carried):
    """A field reached only through the model's bridge yields to the ONE field of the
    same kind the question names word for word (holdout: "sản phẩm" bridged to the
    identifier `product id` while the explore has "Tên sản phẩm")."""
    from dataclasses import replace as _replace

    by_ref = {f.ref: f for f in plan.explore.fields}
    used = {*plan.dimensions, *plan.measures, *plan.filters}

    def swap(refs, kind):
        out = []
        for ref in refs:
            f = by_ref.get(ref)
            if f is None or ref in carried or _lexical(f, q, qf) or ref not in phrases:
                out.append(ref)
                continue
            cands = [c for c in plan.explore.fields if c.kind == kind and c.ref not in used and c.ref != ref
                     and _lexical(c, q, qf) and (_field_words(c) - _GENERIC) & phrases[ref]]
            if kind == "dimension":
                from app.services.data_core.catalog import is_identifier

                cands = [c for c in cands if not is_identifier(c)]
            out.append(cands[0].ref if len(cands) == 1 else ref)
        return out

    dims, meas = swap(plan.dimensions, "dimension"), swap(plan.measures, "measure")
    if dims == plan.dimensions and meas == plan.measures:
        return plan
    grains = {(dims[plan.dimensions.index(r)] if r in plan.dimensions else r): g for r, g in plan.time_grains.items()}
    return _replace(plan, dimensions=dims, measures=meas, time_grains=grains)


def other_source_named(plan, question: str, others) -> list[str]:
    """When the plan's metric is reached only through the model's bridge and ANOTHER
    dataset has a metric the question names word for word, the question fits both:
    the person chooses (holdout set 2: "doanh số" answered from "Revenue" of one
    dataset while another dataset has "Doanh số")."""
    q = syllables(question)
    qf = " ".join(re.split(r"[^0-9a-z]+", fold(question))).strip()
    by_ref = {f.ref: f for f in plan.explore.fields}
    if any(m in by_ref and _lexical(by_ref[m], q, qf) for m in plan.measures):
        return []
    named = []
    for ex in others:
        if ex.dataset_id == plan.explore.dataset_id:
            continue
        for f in ex.fields:
            label = " ".join(w for w in re.split(r"[^0-9a-z]+", fold(f.label)) if w)
            # the WHOLE label, as written, is in the question ("doanh số" in "xu hướng
            # doanh số"; not "doanh thu", which only shares a word)
            if f.kind == "measure" and label and f" {label} " in f" {qf} ":
                named.append({"label": f"{f.label} — {ex.dataset_name}", "dataset_id": ex.dataset_id,
                              "verbatim": True})
    if not named:
        # PO 2026-10-22: the metric was reached ONLY through the model's bridge
        # ("doanh thu" -> another source's "Revenue") and the person can read other
        # Datasets with a metric of the same kind: the model must not pick the
        # source silently - the person chooses.
        kinds = {by_ref[m].type for m in plan.measures if m in by_ref}
        if any(m in by_ref and syllables(by_ref[m].label) & q for m in plan.measures):
            # the question shares words with the metric's own label ("bao nhiêu ĐƠN HÀNG"
            # for "Số đơn hàng", all of them generic): it names it; nothing was bridged
            kinds = set()
        for ex in others:
            if ex.dataset_id == plan.explore.dataset_id:
                continue
            for f in ex.fields:
                if f.kind == "measure" and f.type in kinds:
                    named.append({"label": f"{f.label} — {ex.dataset_name}", "dataset_id": ex.dataset_id,
                                  "verbatim": False})
    if not named:
        return []
    mine = [{"label": f"{by_ref[m].label} — {plan.explore.dataset_name}", "dataset_id": plan.explore.dataset_id,
             "verbatim": False} for m in plan.measures if m in by_ref]
    seen, out = set(), []
    for o in mine + named:
        if o["label"] not in seen:
            seen.add(o["label"])
            out.append(o)
    return out


# A question about the future is a forecast; the Analyst only reads what happened
# (sealed holdout 7: "Tháng sau chi phí marketing sẽ là bao nhiêu?" was answered
# with history).
_FUTURE = re.compile(r"\b(se|du bao|du doan|du kien|sap toi|ky toi|(ngay|tuan|thang|quy|nam|ky) (sau|toi))\b")


def is_forecast(question: str) -> bool:
    return bool(_FUTURE.search(" ".join(w for w in re.split(r"[^0-9a-z]+", fold(question)) if w)))


# ── Intent obligations ──────────────────────────────────────────────────────
# Words that CHANGE the meaning (negation, comparison, a time boundary, "only")
# are matched on the question as written - lower-cased, tone marks kept - because
# folded they collide with ordinary words ("chỉ" / "chi phí", "tối đa" / "tôi",
# "không" as a yes/no particle). Each one obliges the plan to carry the matching
# operator; a plan that does not is refused, never answered with the opposite.
_NEG = re.compile(r"(?<!\w)(không|chưa|ngoại trừ|loại trừ|loại bỏ|bỏ qua|bỏ|trừ|khác|ngoài)(?=\s+\w)")
_YES_NO = re.compile(r"(?<!\w)có(?:\s+\w+){1,6}\s+không\s*[?.!]*\s*$")
_CMP = re.compile(r"(?<!\w)(lớn hơn|nhỏ hơn|cao hơn|thấp hơn|nhiều hơn|ít hơn|ít nhất|tối thiểu|tối đa|trên|dưới|vượt|hơn)"
                  r"\s+(?:\w+\s+){0,2}\d")
_TIME_BOUND = re.compile(r"(?<!\w)(trước|sau|từ|đến|tới)\s+(?:(?:ngày|tháng|quý|năm)\s+)?\d")
_ONLY = re.compile(r"(?<!\w)chỉ(?!\s+số)(?=\s+\w)")


def _lower(question: str) -> str:
    return unicodedata.normalize("NFC", str(question or "")).lower()


def intent_obligations(question: str) -> dict:
    """What the question's own words oblige a plan to contain."""
    text = _lower(question)
    neg = [m.group(1) for m in _NEG.finditer(text)]
    if neg and _YES_NO.search(text) and set(neg) == {"không"}:
        neg = []  # "có tăng không?" asks yes/no; it does not negate
    return {"negation": neg, "comparison": [m.group(1) for m in _CMP.finditer(text)],
            "time_bound": [m.group(1) for m in _TIME_BOUND.finditer(text)],
            "only": bool(_ONLY.search(text))}


def check_obligations(question: str, filters: dict, carried_filters: Iterable[str] = (), *,
                      top_n: bool = False) -> Optional[str]:
    """None when the plan's filters honour the question's meaning-changing words,
    else the refusal naming them."""
    ob = intent_obligations(question)
    ops = {ref: str(c.get("operator")) for ref, c in filters.items()}
    values = " ".join(_lower(" ".join(c["value"] if isinstance(c.get("value"), list) else [str(c.get("value"))]))
                      for c in filters.values() if c.get("operator") in ("eq", "in"))
    if ob["negation"]:
        negated_value = any(w in values for w in ("chưa", "không"))
        if not (set(ops.values()) & {"ne", "not_in"}) and not negated_value:
            return (f"Câu hỏi có phủ định (“{ob['negation'][0]}”) nhưng kế hoạch truy vấn không thể hiện nó, "
                    "nên không trả lời thay vì trả lời ngược nghĩa.")
    elif set(ops.values()) & {"ne", "not_in"}:
        return "Kế hoạch truy vấn có phép loại trừ mà câu hỏi không yêu cầu, nên không chạy."
    if ob["comparison"] and not (set(ops.values()) & {"gt", "gte", "lt", "lte"}):
        return (f"Câu hỏi có điều kiện so sánh (“{ob['comparison'][0]}”) mà dữ liệu được phép chưa áp được, "
                "nên không trả lời phần đó thay vì trả lời sai.")
    if ob["time_bound"] and "date_range" not in ops.values():
        return (f"Câu hỏi có mốc thời gian (“{ob['time_bound'][0]} …”) nhưng kế hoạch không lọc theo thời gian, "
                "nên không trả lời.")
    if ob["only"] and not filters and not list(carried_filters) and not top_n:  # "chỉ lấy top 2": the cut is the limit
        return "Câu hỏi giới hạn phạm vi (“chỉ …”) nhưng kế hoạch không có bộ lọc nào, nên không trả lời."
    return None


def ground(plan, question: str, **kw):
    token = _ASKED.set(" ".join(w for w in re.split(r"[^0-9a-z]+", fold(question)) if w))
    try:
        return _ground(plan, question, **kw)
    finally:
        _ASKED.reset(token)


def _ground(plan, question: str, *, carried: Iterable[str] = (), covered: dict | None = None,
            value_lookup=None, previous: dict | None = None, chosen_measure: str | None = None):
    """Return (plan, None) when the plan answers the question, possibly with unasked
    fields removed, or (None, reason) when it cannot. `carried`: the refs of the
    previous plan a follow-up refines ("chỉ tính đơn hoàn tất" keeps its breakdown).
    `covered`: the model's question-phrase -> ref map; it bridges languages (a
    Vietnamese question over English labels) but is only believed where the phrase
    really is in the question."""
    if is_forecast(question):
        return None, ("Câu hỏi hỏi về tương lai (dự báo). Phân tích AI chỉ trả lời từ dữ liệu đã có, "
                      "không dự báo.")
    from app.services.data_core.intent import extract

    # Constructions of the request (framing, ranking, quantity) are recognised as a
    # whole; what grounding must explain is the rest. A ranking is an obligation.
    intent = extract(question, chosen_metric=bool(chosen_measure), followup=isinstance(previous, dict))
    q = syllables(intent.content)
    qf = intent.content
    carried = set(carried)
    by_ref = {f.ref: f for f in plan.explore.fields}
    phrases = _valid_phrases(covered or {}, question, q, by_ref)
    plan = _swap_bridged(plan, q, qf, phrases, carried)
    has_time_words = bool(q & _TIME)

    def mentioned(ref):
        f = by_ref.get(ref)
        return f is not None and (ref in carried or ref in phrases or _mentioned(f, q, qf))

    # Measures are named more loosely than breakdowns: "đơn" names "Số đơn hàng" in
    # "số đơn bị huỷ", while it must not make "Ngày đặt hàng" a breakdown.
    measures = [m for m in plan.measures
                if m == chosen_measure or mentioned(m) or (m in by_ref and (_field_words(by_ref[m]) - {"so", "id", "ma"}) & q)]
    if not measures:
        asked = ", ".join(sorted(q - _STOP - _TIME)[:6])
        return None, (f"Dữ liệu bạn được dùng không có chỉ số cho “{asked}”, nên không trả lời "
                      "thay vì trả lời bằng một chỉ số khác.")
    label_words: set[str] = set()
    for ref in [*plan.dimensions, *plan.measures, *plan.filters]:
        if ref in by_ref:
            label_words |= _field_words(by_ref[ref])
    filters = {}
    asked_words = syllables(question)
    #: ref -> operator of a filter whose VALUE the question never says: the value is
    #: re-resolved from the question's own words (value lookup) with that operator
    ungrounded: dict[str, str] = {}
    for ref, cond in plan.filters.items():
        vals = cond.get("value") if isinstance(cond.get("value"), list) else [cond.get("value")]
        texts = [v for v in vals if isinstance(v, str)]
        if (texts and cond.get("operator") in ("eq", "in", "ne", "not_in") and ref not in carried
                and any(not (syllables(v) - _GENERIC <= asked_words) for v in texts)):
            # Sealed set 8: "Màn hình 27" was planned as product_id = "p027", a value
            # the question never says (and another product). A value must come from
            # the question's words; the model's own (a code, a translation such as
            # "Cancelled" for "huỷ") is looked up again below or the turn is refused.
            ungrounded[ref] = str(cond.get("operator"))
            continue
        if ref in by_ref and texts and all(syllables(v) - _GENERIC <= label_words for v in texts):
            # The value is made of field LABELS, not data: "Trạng thái đơn eq Trạng thái
            # đơn"; holdout set 3: "đơn hoàn trả" from "Tiền hoàn trả" + "Trạng thái đơn".
            continue
        if cond.get("operator") == "date_range" and not _YEAR.search(str(question)):
            # holdout set 6: "khách hàng MỚI đăng ký" became a 2023 range nobody asked for
            continue
        period = asked_period(question) if cond.get("operator") == "date_range" else None
        if period is not None:
            # Holdout set 6 S6-041: "Năm 2025 ... mỗi quý" was filtered to Q1 2025 only;
            # set 8 dev (S8-008): "quý 4 năm 2025" became [2025-10-01, 2025-12-31) - the
            # 31st silently dropped, a wrong number. A question that names ONE whole
            # calendar period gets exactly that period, whatever range the model wrote.
            cond = {"operator": "date_range", "value": {"from": period[0], "to": period[1]}}
        filters[ref] = cond

    def one_value(ref):
        cond = filters.get(ref) or {}
        v = cond.get("value")
        return cond.get("operator") == "eq" or (cond.get("operator") == "in" and isinstance(v, list) and len(v) == 1)

    from app.services.data_core.catalog import is_identifier

    def breakdown_ok(d):
        """An identifier or a numeric column lists rows, it does not summarise them:
        only a breakdown the question names word for word (holdout: "bao nhiêu
        khách" grouped by customer_id -> "Doanh nghiệp (1)"; "bao nhiêu cái" grouped
        by the quantity column)."""
        f = by_ref.get(d)
        if f is None:
            return False
        if is_identifier(f) or str(f.type).lower() in ("number", "numeric", "integer", "float", "decimal"):
            return d in carried or _mentioned(f, q, qf)
        return True

    dims = [d for d in plan.dimensions
            if (mentioned(d) or (d in plan.time_grains and has_time_words and d in by_ref))
            and not one_value(d) and breakdown_ok(d)]  # grouping by a field filtered to one value is one group
    # "Tiền hoàn trả theo tháng" is by the RETURN's date, not the order's (holdout
    # sets 4-5): when the question does not name the time field, the time breakdown
    # is the date of the fact that owns the metric, if that fact has exactly one.
    if measures:
        fact = measures[0].rsplit(".", 1)[0]
        own_dates = [f.ref for f in plan.explore.fields
                     if f.kind == "dimension" and f.ref.rsplit(".", 1)[0] == fact
                     and str(f.type).lower() in ("date", "datetime", "timestamp")]
        for d in list(dims):
            if (d in plan.time_grains and d.rsplit(".", 1)[0] != fact and len(own_dates) == 1
                    and d not in carried and not _mentioned(by_ref[d], q, qf) and own_dates[0] not in dims):
                dims[dims.index(d)] = own_dates[0]
                plan = replace(plan, time_grains={(own_dates[0] if r == d else r): g
                                                  for r, g in plan.time_grains.items()})
        # Same for a PERIOD filter (sealed set 8: "Số lượt trả hàng ... năm 2025"
        # was filtered on the ORDER date, counting returns of 2025 orders).
        for ref, cond in list(filters.items()):
            if (cond.get("operator") == "date_range" and ref.rsplit(".", 1)[0] != fact and len(own_dates) == 1
                    and ref not in carried and ref in by_ref and not _mentioned(by_ref[ref], q, qf)
                    and own_dates[0] not in filters):
                filters = {(own_dates[0] if r == ref else r): c for r, c in filters.items()}
    if value_lookup is not None:
        # "kênh Online" is a FILTER on the channel, not a breakdown by channel
        # (holdout set 3): words of a breakdown's phrase beyond its label are looked
        # up as that field's real value; one match turns the breakdown into a filter.
        for d in list(dims):
            extra = _phrase_words(covered or {}, d, q) - _field_words(by_ref[d]) - _STOP - _TIME if d in by_ref else set()
            extra &= _capitalised(question)  # only value-like words are looked up (each lookup is a governed read)
            if not extra or d in plan.time_grains or not _vietnamese(by_ref[d]):
                continue  # an English label is bridged by the phrase: no "extra" words to read
            if d in filters:
                continue  # already filtered (e.g. "ne Miền Nam"): its value is not re-read as eq
            found = value_lookup(question, extra, [r for r in [*dims, *filters] if r != d])
            if found and found[0] == d:
                dims.remove(d)
                filters[d] = {"operator": "eq", "value": found[1]}
    asked_grain = bool(_GRAIN_ASKED.search(qf))
    dims = [d for d in dims if not (d in plan.time_grains and (filters.get(d) or {}).get("operator") == "date_range"
                                    and not asked_grain)]  # "năm 2025" filters the year; it is not a breakdown
    grains = {r: g for r, g in plan.time_grains.items() if r in dims}

    if isinstance(previous, dict):
        # A follow-up REFINES the previous answer (holdout set 3: "Chỉ khách hàng cá
        # nhân" after "doanh số theo ngành hàng" came back as a customer count with no
        # breakdown). The previous metric stays unless the question names a new one
        # in words that are not the new filter's; the previous breakdowns stay.
        filter_words = set()
        for ref, cond in filters.items():
            filter_words |= _field_words(by_ref[ref]) if ref in by_ref else set()
            for v in (cond.get("value") if isinstance(cond.get("value"), list) else [cond.get("value")]):
                filter_words |= syllables(v)
        prev_meas = [m for m in previous.get("measures") or [] if m in by_ref]
        new_metric = any(m not in prev_meas and (_field_words(by_ref[m]) - _GENERIC - filter_words) & q
                         for m in measures)
        if prev_meas and not new_metric:
            measures = prev_meas
        # ...unless it names a breakdown of its own: "theo ngành hàng thì sao" after
        # "Doanh số Miền Bắc theo kênh bán" swaps channel for category (browser D, 9
        # groups instead of 3). Only "chia tiếp / thêm / cả" ADDS to the old breakdown.
        prev_dims = previous.get("dimensions") or []
        swaps = any(d not in prev_dims for d in dims) and not _ADD_BREAKDOWN.search(fold(question))
        if swaps:
            # the planner is told to keep the previous breakdowns, so the model carries
            # them itself (live browser smoke: category x channel again) - drop the ones
            # the question does not name
            dims = [d for d in dims if d not in prev_dims or (d in by_ref and _mentioned(by_ref[d], q, qf))]
            grains = {r: g for r, g in grains.items() if r in dims}
        for d in [] if swaps else prev_dims:
            if d in by_ref and d not in dims and d not in filters:
                dims.append(d)
                g = (previous.get("time_grains") or {}).get(d)
                if g and d not in grains:
                    grains[d] = g
        # Sealed set 9 (S9-031): "Còn riêng miền Trung thì sao?" after "Doanh số năm 2025
        # chia theo từng kênh" dropped the YEAR - all-time numbers presented as 2025's.
        # A follow-up keeps every previous filter on a field it does not name; a filter
        # on the same field is replaced by the new one.
        # Internal-preview live smoke: "còn quý 3 thì sao" after a Q2 2025 question was
        # answered with the Q2 numbers again - the model's yearless range was dropped
        # above and the previous Q2 filter carried. A follow-up that names another
        # quarter/month gets THAT period in the previous period's year; when that year is
        # not one year, ask rather than guess.
        yearless = yearless_period(question)
        for ref, cond in (previous.get("filters") or {}).items():
            if ref in by_ref and isinstance(cond, dict) and cond.get("operator") == "date_range" and yearless:
                rng = _period_in_year_of(cond, yearless)
                if rng is None:
                    what = "quý" if yearless[0] == "quarter" else "tháng"
                    return None, (f"Câu hỏi nêu {what} {yearless[1]} nhưng chưa rõ của năm nào. "
                                  f"Hãy nói rõ năm, ví dụ “{what} {yearless[1]} năm 2025”.")
                filters[ref] = {"operator": "date_range", "value": {"from": rng[0], "to": rng[1]}}
                continue
            if ref in by_ref and ref not in filters and isinstance(cond, dict) \
                    and not _mentioned(by_ref[ref], q, qf):
                filters[ref] = cond

    carried_filters = list(((previous or {}).get("filters") or {}).keys()) if isinstance(previous, dict) else []

    explained = set(_STOP) | syllables(plan.explore.dataset_name) | syllables(plan.explore.label)
    explained |= _entity_words(plan.explore.fields, [*measures, *dims, *filters, *carried])
    for ref in [*measures, *dims, *filters, *carried]:
        if ref in by_ref:
            explained |= _field_words(by_ref[ref])
        explained |= phrases.get(ref, set())
    for cond in filters.values():
        vals = cond.get("value") if isinstance(cond.get("value"), list) else [cond.get("value")]
        for v in vals:
            explained |= syllables(v)
    if grains or any(c.get("operator") == "date_range" for c in filters.values()):
        # a period the plan groups by or filters to explains the time words and numbers
        explained |= _TIME | {w for w in q if w.isdigit()} | {"den", "tu"}
    unexplained = q - explained
    if unexplained and value_lookup is not None:
        # The model may have left a value out ("doanh số theo tên sản phẩm của ngành
        # Nội thất" without the filter). Look the explore's text fields' real values
        # up (through GQS); a phrase of the question equal to exactly ONE field's
        # value becomes that filter, and the interpretation says so.
        found = value_lookup(question, unexplained, [*dims, *filters])
        if found:
            ref, value = found
            prior = (filters.get(ref) or {}).get("operator") or ungrounded.pop(ref, None)
            if prior is None and len(ungrounded) == 1:
                prior = ungrounded.popitem()[1]  # the written value was on another field ("p027" on the id)
            if prior in ("ne", "not_in"):
                # Sealed set 8: "không tính các đơn bị huỷ" was planned "status ne
                # Cancelled" and this lookup rewrote it to "status eq Huỷ" - the
                # opposite answer. The real value replaces the written one; the
                # plan's exclusion stays, and so does any breakdown on the field.
                filters = {**filters, ref: {"operator": prior, "value": [value] if prior == "not_in" else value}}
            else:
                filters = {**filters, ref: {"operator": "eq", "value": value}}
                dims = [d for d in dims if d != ref]
            explained |= syllables(value) | phrases.get(ref, set())
            if ref in by_ref:
                explained |= _field_words(by_ref[ref])
            grains = {r: g for r, g in grains.items() if r in dims}
            unexplained = q - explained
    if ungrounded:
        names = ", ".join(by_ref[r].label if r in by_ref else r for r in ungrounded)
        return None, (f"Giá trị lọc cho “{names}” không có trong câu hỏi và không tìm được giá trị thật khớp với "
                      "lời bạn hỏi, nên không trả lời thay vì lọc theo một giá trị khác.")
    broken = check_obligations(question, filters, carried_filters,  # the FINAL filters honour the words
                               top_n=bool(intent.ranking and intent.ranking.get("n")))
    if broken:
        return None, broken
    if unexplained:
        shown = [w for w in re.findall(r"\w+", str(question)) if fold(w) in unexplained]
        shown = list(dict.fromkeys(shown))[:6] or sorted(unexplained)[:6]
        return None, ("Câu hỏi có phần chưa khớp với dữ liệu được dùng: “" + " ".join(shown) + "”. "
                      "Hệ thống không bỏ qua phần đó; hãy diễn đạt lại theo tên trường hoặc giá trị có trong dữ liệu.")
    from app.services.data_core.planner import describe_plan

    sorts = [s for s in plan.sorts if s.get("field") in set(dims) | set(measures)]
    limit = None
    if intent.ranking:
        # "Top 3 ...", "xếp hạng ... từ cao xuống thấp", "... nhiều nhất": ordered by
        # the metric over ONE breakdown, at most N groups. A ranking with nothing
        # to rank, or within several breakdowns ("top 3 sản phẩm mỗi tháng"), is not
        # in the approved contract: refused, never answered as an unordered list.
        if not measures or len(dims) != 1:
            return None, ("Câu hỏi yêu cầu xếp hạng (top/cao nhất) theo đúng một nhóm; kế hoạch truy vấn không "
                          "có đúng một nhóm để xếp hạng, nên không trả lời.")
        sorts = [{"field": measures[0], "direction": intent.ranking["direction"]}]
        limit = intent.ranking["n"]
    out = replace(plan, measures=measures, dimensions=dims, time_grains=grains, filters=filters,
                  sorts=sorts, limit=limit)
    out.interpretation = describe_plan(out)
    return out, None
