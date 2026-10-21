"""Question -> semantic plan (M2). The model proposes; the server disposes.

The model sees only the permission-filtered catalog and returns JSON naming
catalog refs. Nothing it returns is trusted:
  * the explore must be one the catalog listed for THIS person;
  * every ref must be a field of that explore, of the right kind;
  * a grain is one of five words; a filter operator is on the allow-list;
  * it cannot send SQL, calculated fields, window functions or a consent to
    drop a filter — those are not in the plan's shape at all.
An invalid plan is an `unsupported` outcome, not a repaired guess.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from app.services.analyst.catalog import CatalogExplore, is_time

GRAINS = ("day", "week", "month", "quarter", "year")
OPERATORS = ("eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "starts_with", "ends_with")


@dataclass
class Plan:
    explore: CatalogExplore
    dimensions: list[str]
    measures: list[str]
    time_grains: dict[str, str] = field(default_factory=dict)
    filters: dict[str, dict] = field(default_factory=dict)
    sorts: list[dict] = field(default_factory=list)
    interpretation: str = ""

    def as_dict(self) -> dict:
        return {"explore_id": self.explore.explore_id, "dimensions": self.dimensions, "measures": self.measures,
                "time_grains": self.time_grains, "filters": self.filters, "sorts": self.sorts,
                "interpretation": self.interpretation}


@dataclass
class Clarify:
    question: str
    options: list[str]


@dataclass
class Unsupported:
    reason: str


SYSTEM = (
    "You plan governed BI queries. Answer ONLY with JSON. You never write SQL. "
    "You may use ONLY explores and field refs listed in the catalog, copied exactly. "
    "Return one of:\n"
    '{"status":"plan","explore_id":<int>,"dimensions":[ref],"measures":[ref],'
    '"time_grains":{ref:"day|week|month|quarter|year"},"filters":{ref:{"operator":op,"value":v}},'
    '"sorts":[{"field":ref,"direction":"asc|desc"}],"covered":{"<question phrase>":ref|null},'
    '"interpretation":"<one sentence, user language>"}\n'
    '{"status":"clarify","question":"<user language>","options":["..."]}  when two catalog meanings fit equally\n'
    '{"status":"unsupported","reason":"<user language>"}  when the catalog cannot answer.\n'
    "Allowed filter operators: " + ", ".join(OPERATORS) + ". "
    "For a trend over time include the time dimension in dimensions and give it a grain. "
    "Pick the dimension whose label matches the user's words (a group/category/type means a category field). "
    "Do not group by a dimension marked identifier unless the question asks about individual items. "
    "Match the question's words against each field's label AND synonyms. Every breakdown the question asks "
    "for (by X, per X, theo X, các X, từng X) must appear in dimensions; list them in a \"covered\" object "
    "mapping the question's phrase to the ref you used. "
    "If a breakdown or filter the question asks for has no matching field, map that phrase to null in "
    "covered (or return unsupported); never answer a different question. "
    "When previous_plan is given, the question refines it: keep its measures, dimensions and filters and "
    "change only what the question changes. "
    "An explicit period in the question (năm 2025, quý 1/2026, tháng 3/2025) is answered by grouping: include the "
    "time dimension in dimensions with that grain (year, quarter or month); the answer then names that period. "
    "Do not filter dates: a date range is not available in governed queries yet. "
    "Do not invent date filters for words like 'recent'; return the trend and say so in interpretation."
)


def build_prompt(question: str, catalog: list[CatalogExplore], previous: Optional[dict]) -> str:
    body = {"question": question, "catalog": [c.as_prompt() for c in catalog]}
    if previous:
        body["previous_plan"] = previous  # a follow-up refines the last answer
    return json.dumps(body, ensure_ascii=False)


def plan(question: str, catalog: list[CatalogExplore], *, previous: Optional[dict] = None,
         complete: Optional[Callable[..., Optional[dict]]] = None):
    if not catalog:
        return Unsupported("Bạn chưa có quyền khai thác dữ liệu nào phù hợp để trả lời câu hỏi này.")
    if complete is None:
        from app.services.llm_client import LLMClient

        complete = LLMClient.complete_json
    raw = complete(build_prompt(question, catalog, previous), system=SYSTEM, max_tokens=900)
    if raw is None:
        return Unsupported("Chưa kết nối được mô hình AI để hiểu câu hỏi.")
    return validate(raw, catalog)


def validate(raw: Any, catalog: list[CatalogExplore]):
    if not isinstance(raw, dict):
        return Unsupported("Không hiểu được kế hoạch truy vấn.")
    status = raw.get("status")
    if status == "clarify":
        opts = [str(o)[:200] for o in (raw.get("options") or []) if str(o).strip()][:6]
        return Clarify(str(raw.get("question") or "Bạn muốn hỏi theo nghĩa nào?")[:400], opts)
    if status == "unsupported":
        return Unsupported(str(raw.get("reason") or "Dữ liệu được phép không trả lời được câu hỏi này.")[:400])
    if status != "plan":
        return Unsupported("Không hiểu được kế hoạch truy vấn.")
    by_id = {c.explore_id: c for c in catalog}
    try:
        explore = by_id.get(int(raw.get("explore_id")))
    except (TypeError, ValueError):
        explore = None
    if explore is None:
        return Unsupported("Kế hoạch dùng nguồn dữ liệu ngoài phạm vi được phép.")
    dims = {f.ref: f for f in explore.fields if f.kind == "dimension"}
    meas = {f.ref: f for f in explore.fields if f.kind == "measure"}

    def resolve(ref, allowed):
        """A catalog ref as written, or the ONE catalog field of that name when the
        model qualified it with the wrong view. Ambiguous or unknown: None."""
        if not isinstance(ref, str):
            return None
        if ref in allowed:
            return ref
        name = ref.rsplit(".", 1)[-1]
        hits = [r for r in allowed if r.rsplit(".", 1)[-1] == name]
        return hits[0] if len(hits) == 1 else None

    def refs(key, allowed):
        vals = raw.get(key) or []
        if not isinstance(vals, list):
            return None
        out = [resolve(v, allowed) for v in vals]
        return None if any(o is None for o in out) else list(dict.fromkeys(out))

    d, m = refs("dimensions", dims), refs("measures", meas)
    if d is None or m is None or not m:
        return Unsupported("Kế hoạch dùng trường không có trong mô hình dữ liệu được phép.")
    grains = {}
    for raw_ref, g in (raw.get("time_grains") or {}).items():
        ref = resolve(raw_ref, dims)
        if ref is not None and g in GRAINS and ref not in d:
            continue  # a grain on a field only used as a filter (holdout: "năm 2025") groups nothing
        if ref is None or g not in GRAINS:
            return Unsupported("Độ chi tiết thời gian của kế hoạch không hợp lệ.")
        if not is_time(dims[ref]):
            return Unsupported(f"Trường “{dims[ref].label}” chưa được khai báo kiểu ngày/giờ trong mô hình ngữ nghĩa, "
                               "nên chưa nhóm theo thời gian được. Cần chủ sở hữu mô hình khai báo đúng kiểu.")
        grains[ref] = g
    filters = {}
    for raw_ref, cond in (raw.get("filters") or {}).items():
        ref = resolve(raw_ref, dims)
        if ref is None or not isinstance(cond, dict) or cond.get("operator") not in OPERATORS:
            return Unsupported("Bộ lọc của kế hoạch không hợp lệ.")
        filters[ref] = {"operator": cond["operator"], "value": cond.get("value")}
    sorts = []
    for s in raw.get("sorts") or []:
        field_ref = resolve(s.get("field"), {**dims, **meas}) if isinstance(s, dict) else None
        if field_ref is None or field_ref not in set(d) | set(m) \
                or str(s.get("direction") or "asc").lower() not in ("asc", "desc"):
            return Unsupported("Cách sắp xếp của kế hoạch không hợp lệ.")
        sorts.append({"field": field_ref, "direction": str(s.get("direction") or "asc").lower()})
    # What the model says it covered must be in the plan: a phrase it could not
    # map (None) or mapped outside the plan is a breakdown/filter the answer would
    # silently not have (real-model run: "channel and province" answered by month).
    covered = raw.get("covered") if isinstance(raw.get("covered"), dict) else {}
    in_plan = set(d) | set(m) | set(filters)
    for phrase, target in covered.items():
        ref = resolve(target, {**dims, **meas}) if isinstance(target, str) else None
        if ref is None or ref not in in_plan:
            return Unsupported(f"Dữ liệu bạn được dùng không có trường cho “{str(phrase)[:80]}”, "
                               "nên không trả lời phần đó thay vì trả lời sai.")
    plan_ = Plan(explore=explore, dimensions=d, measures=m, time_grains=grains, filters=filters, sorts=sorts)
    # The interpretation shown to the person is the SERVER's reading of the
    # validated plan, never the model's prose (which can claim what was not done).
    plan_.interpretation = describe_plan(plan_)
    return plan_


def describe_plan(p: Plan) -> str:
    labels = {f.ref: f.label for f in p.explore.fields}
    text = ", ".join(labels.get(r, r) for r in p.measures)
    parts = []
    for r in p.dimensions:
        grain = p.time_grains.get(r)
        parts.append(f"{labels.get(r, r)} ({grain})" if grain else labels.get(r, r))
    if parts:
        text += " theo " + ", ".join(parts)
    if p.filters:
        text += "; lọc " + "; ".join(f"{labels.get(r, r)} {c.get('operator')} {c.get('value')}"
                                     for r, c in p.filters.items())
    return f"{text} — nguồn {p.explore.dataset_name}"
