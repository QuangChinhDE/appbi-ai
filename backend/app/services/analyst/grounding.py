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

import re
import unicodedata
from dataclasses import replace
from typing import Iterable

# Function words, question words and analysis verbs that carry no data meaning.
_STOP = set("""
a ai bao bi bieu bo cac cach chi cho chua co con cua cung da dang dau de den di do doi duoc gi gia giai
giup hay hien hoi hon khac khi khong kia la lam lai luon ma moi mot muon nao nay neu nhieu nhu nhung
nhat nua o phai qua ra roi sang sao se so sanh ta tai tat the theo thi thu thuc tinh to toan trong tu tung
va van ve vi voi xem xin tong cong hang tach them rieng bang danh sach liet ke the nao the hien bao nhieu
dang ky tu den gan day nhat cao thap lon nho manh yeu tang giam bien dong xu huong ket qua phan tich thay
""".split())
# Words that are explained by grouping on a time field.
_TIME = set("ngay tuan thang quy nam thoi gian gan day xu huong bien dong".split())


def fold(text: str) -> str:
    text = unicodedata.normalize("NFD", str(text or "").lower().replace("đ", "d"))
    return "".join(c for c in text if unicodedata.category(c) != "Mn")


def syllables(text: str) -> set[str]:
    return {w for w in re.split(r"[^0-9a-z]+", fold(text)) if w}


def _field_words(field) -> set[str]:
    words = syllables(field.label) | syllables(field.ref.rsplit(".", 1)[-1].replace("_", " "))
    for s in field.synonyms or ():
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


def _valid_phrases(covered: dict, question: str, q: set[str], fields: dict) -> dict[str, set[str]]:
    """ref -> the question words the model says that field answers. A phrase counts
    only if every word of it is in the question and it is not (nearly) the whole
    question — holdout: the model mapped the entire question to one field."""
    out: dict[str, set[str]] = {}
    content = q - _STOP
    for phrase, ref in (covered or {}).items():
        words = syllables(phrase)
        if not isinstance(ref, str) or not words or not words <= q:
            continue
        if content and len(words & content) >= max(3, 0.7 * len(content)):
            continue
        f = fields.get(ref)
        if f is not None and _vietnamese(f) and not ((words - {"so", "id", "ma"}) & _field_words(f)):
            # A field the owner named in Vietnamese can be compared word for word:
            # a phrase sharing nothing with it is the model's guess, not a mapping
            # (holdout: "lợi nhuận" -> "Doanh số"). Only a field named in another
            # language ("Revenue") needs the model's bridge.
            continue
        out.setdefault(ref, set()).update(words)
    return out


def _vietnamese(field) -> bool:
    texts = [field.label, *(field.synonyms or ())]
    return any(fold(t) != str(t or "").lower() for t in texts)


def ground(plan, question: str, *, carried: Iterable[str] = (), covered: dict | None = None):
    """Return (plan, None) when the plan answers the question, possibly with unasked
    fields removed, or (None, reason) when it cannot. `carried`: the refs of the
    previous plan a follow-up refines ("chỉ tính đơn hoàn tất" keeps its breakdown).
    `covered`: the model's question-phrase -> ref map; it bridges languages (a
    Vietnamese question over English labels) but is only believed where the phrase
    really is in the question."""
    q = syllables(question)
    qf = " ".join(re.split(r"[^0-9a-z]+", fold(question))).strip()
    carried = set(carried)
    by_ref = {f.ref: f for f in plan.explore.fields}
    phrases = _valid_phrases(covered or {}, question, q, by_ref)
    has_time_words = bool(q & _TIME)

    def mentioned(ref):
        f = by_ref.get(ref)
        return f is not None and (ref in carried or ref in phrases or _mentioned(f, q, qf))

    measures = [m for m in plan.measures if mentioned(m)]
    if not measures:
        asked = ", ".join(sorted(q - _STOP - _TIME)[:6])
        return None, (f"Dữ liệu bạn được dùng không có chỉ số cho “{asked}”, nên không trả lời "
                      "thay vì trả lời bằng một chỉ số khác.")
    filters = {}
    for ref, cond in plan.filters.items():
        f = by_ref.get(ref)
        vals = cond.get("value") if isinstance(cond.get("value"), list) else [cond.get("value")]
        if f is not None and all(syllables(v) <= _field_words(f) for v in vals if isinstance(v, str)):
            continue  # "Trạng thái đơn eq Trạng thái đơn": the label, not a value
        filters[ref] = cond

    def one_value(ref):
        cond = filters.get(ref) or {}
        v = cond.get("value")
        return cond.get("operator") == "eq" or (cond.get("operator") == "in" and isinstance(v, list) and len(v) == 1)

    dims = [d for d in plan.dimensions
            if (mentioned(d) or (d in plan.time_grains and has_time_words and d in by_ref))
            and not one_value(d)]  # grouping by a field filtered to one value is one group
    grains = {r: g for r, g in plan.time_grains.items() if r in dims}

    explained = set(_STOP)
    for ref in [*measures, *dims, *filters, *carried]:
        if ref in by_ref:
            explained |= _field_words(by_ref[ref])
        explained |= phrases.get(ref, set())
    for cond in filters.values():
        vals = cond.get("value") if isinstance(cond.get("value"), list) else [cond.get("value")]
        for v in vals:
            explained |= syllables(v)
    if grains:
        explained |= _TIME | {w for w in q if w.isdigit()}
    unexplained = q - explained
    if unexplained:
        shown = [w for w in re.findall(r"\w+", str(question)) if fold(w) in unexplained]
        shown = list(dict.fromkeys(shown))[:6] or sorted(unexplained)[:6]
        return None, ("Câu hỏi có phần chưa khớp với dữ liệu được dùng: “" + " ".join(shown) + "”. "
                      "Hệ thống không bỏ qua phần đó; hãy diễn đạt lại theo tên trường hoặc giá trị có trong dữ liệu.")
    from app.services.analyst.planner import describe_plan

    out = replace(plan, measures=measures, dimensions=dims, time_grains=grains, filters=filters,
                  sorts=[s for s in plan.sorts if s.get("field") in set(dims) | set(measures)])
    out.interpretation = describe_plan(out)
    return out, None
