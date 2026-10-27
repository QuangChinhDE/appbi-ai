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

from app.services.data_core.catalog import CatalogExplore, is_time

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
    #: at most this many groups, ordered by `sorts` (a "top N" the QUESTION asked for;
    #: set by grounding from intent, never taken from the model)
    limit: Optional[int] = None

    def as_dict(self) -> dict:
        out = {"explore_id": self.explore.explore_id, "dimensions": self.dimensions, "measures": self.measures,
               "time_grains": self.time_grains, "filters": self.filters, "sorts": self.sorts,
               "interpretation": self.interpretation}
        if self.limit:
            out["limit"] = self.limit
        return out


@dataclass
class Clarify:
    question: str
    options: list[str]
    #: options that name a catalog metric: [{"label", "explore_id", "measure"}] (validated)
    choices: list[dict] = field(default_factory=list)


@dataclass
class Unsupported:
    reason: str
    #: `model_unavailable` when no model answered (a failure, not a refusal)
    code: str = "unsupported"


SYSTEM = (
    "You plan governed BI queries. Answer ONLY with JSON. You never write SQL. "
    "You may use ONLY explores and field refs listed in the catalog, copied exactly. "
    "Return one of:\n"
    '{"status":"plan","explore_id":<int>,"dimensions":[ref],"measures":[ref],'
    '"time_grains":{ref:"day|week|month|quarter|year"},"filters":{ref:{"operator":op,"value":v}},'
    '"sorts":[{"field":ref,"direction":"asc|desc"}],"covered":{"<question phrase>":ref|null},'
    '"interpretation":"<one sentence, user language>"}\n'
    '{"status":"clarify","question":"<user language>","options":[{"label":"<user language>","explore_id":<int>,'
    '"measure":ref}]}  when two catalog metrics or sources fit equally (each option is one catalog metric)\n'
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
    "When chosen_metric is given, the person already chose that metric for this question: plan with exactly "
    "that explore_id and measure and do not ask again. "
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


def build_prompt(question: str, catalog: list[CatalogExplore], previous: Optional[dict],
                 chosen: Optional[dict] = None) -> str:
    body = {"question": question, "catalog": [c.as_prompt() for c in prompt_catalog(catalog)]}
    if previous:
        body["previous_plan"] = previous  # a follow-up refines the last answer
    if chosen:
        body["chosen_metric"] = {"explore_id": chosen["explore_id"], "measure": chosen["measure"]}
    return json.dumps(body, ensure_ascii=False)


def _hold_to_choice(outcome, chosen: Optional[dict]):
    """After the person chose a metric, the plan uses exactly it; asking again is not
    an answer (a loop), and another metric is refused rather than shown."""
    if not chosen:
        return outcome
    if isinstance(outcome, Clarify):
        return Unsupported("Vẫn chưa xác định được câu hỏi sau lựa chọn của bạn; hãy diễn đạt lại cụ thể hơn.")
    if isinstance(outcome, Plan) and outcome.measures != [chosen["measure"]]:
        if chosen["measure"] not in {f.ref for f in outcome.explore.fields if f.kind == "measure"}:
            return Unsupported("Kế hoạch truy vấn không dùng chỉ số bạn đã chọn, nên không trả lời.")
        outcome.measures = [chosen["measure"]]
        outcome.interpretation = describe_plan(outcome)
    return outcome


def plan(question: str, catalog: list[CatalogExplore], *, previous: Optional[dict] = None,
         complete: Optional[Callable[..., Optional[dict]]] = None, chosen: Optional[dict] = None):
    """`chosen`: a metric the person picked from a clarification, already verified by
    the server ({explore_id, measure}); the catalog passed is that Dataset only."""
    if not catalog:
        return Unsupported("Bạn chưa có quyền khai thác dữ liệu nào phù hợp để trả lời câu hỏi này.")
    from app.core.config import settings as _settings
    from app.services import llm_test_budget as _budget

    if str(getattr(_settings, "ANALYST_PLANNER_REPLAY_PATH", "") or ""):
        raw = _budget.replay_lookup(question, bool(previous), choice=(chosen or {}).get("measure"))
        if raw is None:
            return Unsupported("Không có kết quả mô hình đã ghi cho câu hỏi này (chế độ phát lại).")
        return _hold_to_choice(validate(raw, catalog), chosen)
    _budget.QUESTION.set(question)
    _budget.FOLLOWUP.set(bool(previous))
    if complete is None:
        from app.core.config import settings
        from app.services.llm_client import LLMClient

        strong = str(getattr(settings, "ANALYST_PLANNER_MODEL", "default")).strip().lower() == "strong"
        complete = (lambda prompt, system=None, max_tokens=900:
                    LLMClient.complete_json(prompt, system=system, max_tokens=max_tokens, strong=strong))
    raw = complete(build_prompt(question, catalog, previous, chosen), system=SYSTEM, max_tokens=900)
    if raw is None:
        return Unsupported("Chưa kết nối được mô hình AI để hiểu câu hỏi.", code="model_unavailable")
    return _hold_to_choice(validate(raw, catalog), chosen)


def validate(raw: Any, catalog: list[CatalogExplore]):
    if not isinstance(raw, dict):
        return Unsupported("Không hiểu được kế hoạch truy vấn.")
    status = raw.get("status")
    if status == "clarify":
        by_explore = {c.explore_id: c for c in catalog}
        opts, choices = [], []
        for o in (raw.get("options") or [])[:6]:
            if isinstance(o, dict):
                label = str(o.get("label") or "").strip()[:200]
                try:
                    ex = by_explore.get(int(o.get("explore_id")))
                except (TypeError, ValueError):
                    ex = None
                meas = {f.ref: f for f in ex.fields if f.kind == "measure"} if ex else {}
                want = str(o.get("measure") or "")
                bare = [r for r in meas if r.rsplit(".", 1)[-1] == want.rsplit(".", 1)[-1]]
                ref = want if want in meas else (bare[0] if len(bare) == 1 else None)
                if ex is not None and ref in meas:
                    # only an option naming a metric THIS person's catalog has is pickable
                    label = label or f"{meas[ref].label} — {ex.dataset_name}"
                    choices.append({"label": label, "explore_id": ex.explore_id, "measure": ref})
                if label:
                    opts.append(label)
            elif str(o).strip():
                label = str(o).strip()[:200]
                opts.append(label)
                # Internal-preview live smoke: options came back as plain strings ("Doanh
                # số"), a pick re-asked the question and the model asked again. A plain
                # option that names exactly ONE metric of this catalog (one Dataset) is
                # made pickable like a structured one; ambiguous text stays plain.
                from app.services.data_core.grounding import fold  # local: grounding imports this module

                hits = [(c, f) for c in sorted(catalog, key=lambda c: c.explore_id) for f in c.fields
                        if f.kind == "measure" and fold(f.label) == fold(label)]
                if hits and len({c.dataset_id for c, _ in hits}) == 1 and len({f.ref for _, f in hits}) == 1:
                    choices.append({"label": label, "explore_id": hits[0][0].explore_id, "measure": hits[0][1].ref})
        return Clarify(str(raw.get("question") or "Bạn muốn hỏi theo nghĩa nào?")[:400], opts, choices)
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

    # Dev regression 2026-10-22: refs written as objects ({"ref": "v.f"}) are the
    # same refs; nothing else about them is believed.
    def _flat(vals):
        if not isinstance(vals, list):
            return vals
        return [v.get("ref") or v.get("field") if isinstance(v, dict) else v for v in vals]

    raw = {**raw, "dimensions": _flat(raw.get("dimensions") or []), "measures": _flat(raw.get("measures") or [])}
    # Holdout: the model listed a measure among the dimensions ("segment,
    # customer_count"; dev regression: "doanh số và SỐ LƯỢNG BÁN" with units as a
    # dimension). A measure is never a breakdown: it MOVES to the measures - it is
    # never silently dropped (its phrase would then be refused as unanswered).
    if isinstance(raw.get("dimensions"), list):
        moved = [x for x in raw["dimensions"] if isinstance(x, str)
                 and resolve(x, meas) is not None and resolve(x, dims) is None]
        if moved:
            raw = {**raw, "measures": list(dict.fromkeys([*(raw.get("measures") or []), *moved])),
                   "dimensions": [x for x in raw["dimensions"] if x not in moved]}
    # Dev regression: "Tiền hoàn trả theo từng tháng" was grouped by ANOTHER Dataset's
    # "Tháng" field. A time breakdown on a date this explore does not have is the
    # date of the metric's own fact, when that fact has exactly one date.
    grains_raw = dict(raw.get("time_grains") or {})
    if isinstance(raw.get("dimensions"), list) and raw.get("measures"):
        first = resolve(raw["measures"][0], meas) if isinstance(raw["measures"][0], str) else None
        fact = first.rsplit(".", 1)[0] if first else None
        own = [r for r, f in dims.items() if fact and r.rsplit(".", 1)[0] == fact and is_time(f)]
        fixed = []
        for x in raw["dimensions"]:
            if isinstance(x, str) and resolve(x, dims) is None and x in grains_raw and len(own) == 1 \
                    and own[0] not in raw["dimensions"]:
                grains_raw[own[0]] = grains_raw.pop(x)
                fixed.append(own[0])
            else:
                fixed.append(x)
        raw = {**raw, "dimensions": fixed, "time_grains": grains_raw}
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
            from app.services.data_core.grounding import is_function_phrase

            from app.services.data_core.grounding import syllables as _syl

            if is_function_phrase(phrase, has_time=bool(grains) or any(
                    c.get("operator") == "date_range" for c in filters.values()),
                                  source_words=_syl(explore.dataset_name) | _syl(explore.label)):
                continue  # "biến động ra sao", "tổng cộng", "theo tháng" name no field
            if any(t[:1].isupper() for t in str(phrase).split()[1:]) or (
                    str(phrase)[:1].isupper() and len(str(phrase).split()) > 1 and
                    any(t[:1].isupper() for t in str(phrase).split()[1:])):
                # "khách Doanh nghiệp": a Capitalised value the model could not place.
                # Grounding looks it up among real values or refuses naming it.
                continue
        if ref is None or ref not in in_plan:
            return Unsupported(f"Dữ liệu bạn được dùng không có trường cho “{str(phrase)[:80]}”, "
                               "nên không trả lời phần đó thay vì trả lời sai.")
    plan_ = Plan(explore=explore, dimensions=d, measures=m, time_grains=grains, filters=filters, sorts=sorts,
                 covered={str(k): resolve(v, {**dims, **meas}) for k, v in covered.items() if isinstance(v, str)})
    lim = raw.get("limit")
    if isinstance(lim, int) and not isinstance(lim, bool) and 1 <= lim <= 100 and len(d) == 1 and sorts:
        plan_.limit = lim  # an echoed plan (a pick, a consent) keeps the ranking it was shown with
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
    op = cond.get("operator")
    words = {"eq": "là", "ne": "không phải", "in": "thuộc", "not_in": "không thuộc", "gt": ">", "gte": "≥",
             "lt": "<", "lte": "≤", "contains": "chứa", "starts_with": "bắt đầu bằng", "ends_with": "kết thúc bằng"}
    shown = ", ".join(str(x) for x in v) if isinstance(v, list) else v
    return f"{label} {words.get(str(op), op)} {shown}"


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
    if p.sorts and p.dimensions and any(s.get("field") in p.measures for s in p.sorts):
        s = next(s for s in p.sorts if s.get("field") in p.measures)
        order = "giảm dần" if s.get("direction") == "desc" else "tăng dần"
        text += f"; xếp {order} theo {labels.get(s['field'], s['field'])}" + (f", lấy {p.limit} nhóm đầu" if p.limit else "")
    return f"{text} — nguồn {p.explore.dataset_name}"
