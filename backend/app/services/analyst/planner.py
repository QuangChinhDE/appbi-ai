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
OPERATORS = ("eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "starts_with", "ends_with",
             "date_range")


@dataclass
class Plan:
    explore: CatalogExplore
    dimensions: list[str]
    measures: list[str]
    time_grains: dict[str, str] = field(default_factory=dict)
    filters: dict[str, dict] = field(default_factory=dict)
    sorts: list[dict] = field(default_factory=list)
    interpretation: str = ""
    #: question phrase -> plan ref, as the model mapped it (checked by grounding.py)
    covered: dict = field(default_factory=dict)

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
    "for (by X, per X, theo X, các X, từng X) must appear in dimensions. In \"covered\" map EACH short phrase "
    "of the question, copied exactly from it, to the ONE ref it names - the metric phrase, every breakdown "
    "phrase, every filter phrase - e.g. {\"doanh thu\": \"sales.revenue\", \"nhóm sản phẩm\": \"products.category\", "
    "\"khách hàng doanh nghiệp\": \"customers.segment\"} (values are refs from the catalog). "
    "Never map the whole question to one ref. A metric the catalog does not have (profit, conversion rate, a "
    "forecast) maps to null; never substitute a different metric. Filter values must be written exactly as the "
    "data writes them; a measure is never listed in dimensions. "
    "If a breakdown or filter the question asks for has no matching field, map that phrase to null in "
    "covered (or return unsupported); never answer a different question. "
    "When previous_plan is given, the question refines it: keep its measures, dimensions and filters and "
    "change only what the question changes. "
    "An explicit period in the question (năm 2025, quý 2/2026, tháng 3/2025, từ 05/01/2025 đến 20/01/2025) is a "
    "filter on the metric's date field: {ref:{\"operator\":\"date_range\",\"value\":{\"from\":\"2025-01-01\","
    "\"to\":\"2026-01-01\"}}} where from is the first day INCLUDED and to is the day AFTER the last one (excluded). "
    "Do not also group by that date unless the question asks for a breakdown over time. "
    "Do not invent date filters for words like 'recent'; return the trend and say so in interpretation."
)


def prompt_catalog(catalog: list[CatalogExplore]) -> list[CatalogExplore]:
    """ONE entry per dataset for the model. With multi-hop reach every explore of a
    dataset offers nearly the same fields; making the model pick among five
    look-alikes was a source of wrong picks (holdout). The server picks the
    explore afterwards (`retarget`)."""
    best: dict[int, CatalogExplore] = {}
    for c in catalog:
        cur = best.get(c.dataset_id)
        if cur is None or (len(c.fields), -c.explore_id) > (len(cur.fields), -cur.explore_id):
            best[c.dataset_id] = c
    return sorted(best.values(), key=lambda c: c.explore_id)


def retarget(p: "Plan", catalog: list[CatalogExplore]) -> "Plan":
    """Run the plan from the explore whose BASE is the fact that owns its measure,
    when that explore reaches every field the plan uses. From a dimension base
    (customers) the engine left-joins the facts and returns empty groups for
    customers without orders (holdout D03/D04); from the fact base it does not."""
    from dataclasses import replace as _replace

    if not p.measures:
        return p
    fact = p.measures[0].rsplit(".", 1)[0]
    used = {*p.dimensions, *p.measures, *p.filters}
    for c in sorted(catalog, key=lambda c: c.explore_id):
        if c.dataset_id == p.explore.dataset_id and c.base_view == fact and used <= {f.ref for f in c.fields}:
            return p if c.explore_id == p.explore.explore_id else _replace(p, explore=c)
    return p


def build_prompt(question: str, catalog: list[CatalogExplore], previous: Optional[dict]) -> str:
    body = {"question": question, "catalog": [c.as_prompt() for c in prompt_catalog(catalog)]}
    if previous:
        body["previous_plan"] = previous  # a follow-up refines the last answer
    return json.dumps(body, ensure_ascii=False)


def plan(question: str, catalog: list[CatalogExplore], *, previous: Optional[dict] = None,
         complete: Optional[Callable[..., Optional[dict]]] = None):
    if not catalog:
        return Unsupported("Bạn chưa có quyền khai thác dữ liệu nào phù hợp để trả lời câu hỏi này.")
    if complete is None:
        from app.core.config import settings
        from app.services.llm_client import LLMClient

        strong = str(getattr(settings, "ANALYST_PLANNER_MODEL", "default")).strip().lower() == "strong"
        complete = (lambda prompt, system=None, max_tokens=900:
                    LLMClient.complete_json(prompt, system=system, max_tokens=max_tokens, strong=strong))
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

    # Holdout: the model listed the measure among the dimensions too ("segment,
    # customer_count"); a measure is never a breakdown, so it is taken out first.
    if isinstance(raw.get("dimensions"), list) and not raw.get("measures"):
        # Holdout A09: the measure was listed ONLY among the dimensions.
        raw = {**raw, "measures": [x for x in raw["dimensions"] if isinstance(x, str)
                                   and resolve(x, meas) is not None and resolve(x, dims) is None]}
    raw = {**raw, "dimensions": [x for x in (raw.get("dimensions") or []) if not (
        isinstance(x, str) and resolve(x, meas) is not None and resolve(x, dims) is None)]} \
        if isinstance(raw.get("dimensions"), list) else raw
    d, m = refs("dimensions", dims), refs("measures", meas)
    if d is None or m is None or not m:
        return Unsupported("Kế hoạch dùng trường không có trong mô hình dữ liệu được phép.")
    grains = {}
    for raw_ref, g in (raw.get("time_grains") or {}).items():
        ref = resolve(raw_ref, dims)
        if ref is None or ref not in d:
            # A grain on a field the plan does not group by groups nothing (holdout:
            # a filter-only date; the literal placeholder "ref"): ignored, not refused.
            continue
        if g not in GRAINS:
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
        if cond["operator"] == "date_range" and not is_time(dims[ref]):
            return Unsupported(f"Trường “{dims[ref].label}” không phải trường ngày nên không lọc theo khoảng thời gian được.")
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
        if isinstance(target, str):
            ref = resolve(target, {**dims, **meas})
            if ref is None:
                continue  # not a catalog ref (a label, a placeholder): no claim either way
        else:
            ref = None
            from app.services.analyst.grounding import is_function_phrase

            from app.services.analyst.grounding import syllables as _syl

            if is_function_phrase(phrase, has_time=bool(grains),
                                  source_words=_syl(explore.dataset_name) | _syl(explore.label)):
                continue  # "biến động ra sao", "tổng cộng", "theo tháng" name no field
        if ref is None or ref not in in_plan:
            return Unsupported(f"Dữ liệu bạn được dùng không có trường cho “{str(phrase)[:80]}”, "
                               "nên không trả lời phần đó thay vì trả lời sai.")
    plan_ = Plan(explore=explore, dimensions=d, measures=m, time_grains=grains, filters=filters, sorts=sorts,
                 covered={str(k): resolve(v, {**dims, **meas}) for k, v in covered.items() if isinstance(v, str)})
    # The interpretation shown to the person is the SERVER's reading of the
    # validated plan, never the model's prose (which can claim what was not done).
    plan_.interpretation = describe_plan(plan_)
    return plan_


def _describe_filter(label: str, cond: dict) -> str:
    v = cond.get("value")
    if cond.get("operator") == "date_range" and isinstance(v, dict):
        from datetime import date, timedelta

        try:
            last = (date.fromisoformat(str(v.get("to"))) - timedelta(days=1)).isoformat()
        except ValueError:
            last = str(v.get("to"))
        return f"{label} từ {v.get('from')} đến {last} (gồm cả hai ngày)"
    return f"{label} {cond.get('operator')} {v}"


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
        text += "; lọc " + "; ".join(_describe_filter(labels.get(r, r), c) for r, c in p.filters.items())
    return f"{text} — nguồn {p.explore.dataset_name}"
