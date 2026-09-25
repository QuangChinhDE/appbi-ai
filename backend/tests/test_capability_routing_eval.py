# -*- coding: utf-8 -*-
"""Capability routing QUALITY — measured on labelled intents, not asserted by design.

`test_capability_discovery.py` pins what the view may and may not do. This file
measures whether it does the job: for a question a report reader would actually
ask, is the capability that answers it loaded on round one — and if not, does
describing the need find it? And does that stay true, at a bounded context cost,
as the catalogue grows far past today's 36 tools?

WHY A DETERMINISTIC EVAL AND NOT ONLY A LIVE ONE
------------------------------------------------
Routing is a pure function of (grant, question, prompt). Its recall can be measured
exactly, on every commit, with no model — so a ranking change that quietly loses
the forecast tool for forecast questions fails CI instead of surfacing as a worse
answer weeks later. The live eval (`scripts/agent_flow_v3_eval.py`) measures the
part only a model can show: whether it USES what it is shown.

The intents (`fixtures/capability_routing/intents.json`) are written as readers
ask, in Vietnamese and English, NOT copied from any tool's `answers_vi` — a router
that only recognises its own examples is not a router.

THE BARS, AND WHERE THEY CAME FROM
----------------------------------
Measured when this landed (budget 10000): round-one recall 47/48, discovery 46/48
(then 50/52 and 49/52 once the KPI-value intents were added — the class the first
live eval showed the set was missing),
~10.5k schema characters per round against 24.2k shown in full; with 500
distractors 46/48 at ~11.7k against 321k. The bars below sit under those numbers
with room for one or two intents of noise — they exist to catch a regression, not
to demand perfection.
"""
from __future__ import annotations

import json
import os
import pathlib
import random
from types import SimpleNamespace

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import pytest  # noqa: E402

from app.services.agent_flows.runtime import capabilities as CAP  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
INTENTS = json.loads((HERE / "fixtures" / "capability_routing" / "intents.json")
                     .read_text(encoding="utf-8"))["intents"]
ALL = sorted(tool_registry.all_tools())
NON_WEB = [n for n in ALL if not tool_registry.all_tools()[n].reaches_outside]
#: A realistic author prompt: generic, the kind that used to outvote the question.
PROMPT = ("Bạn là chuyên viên phân tích BI. Trả lời câu hỏi của người xem bằng dữ liệu "
          "của báo cáo. Không có dữ liệu thì nói rõ.")


def _ctx(**kw):
    return SimpleNamespace(**{"web_search": True, "read_rows": True, **kw})


def _view(question: str, grant=None, extras=None, **kw):
    view = CAP.build_view(grant or NON_WEB, _ctx(), web_enabled=True, extras=extras,
                          question=question, context=PROMPT, **kw)
    view.refresh()
    return view


def _full_chars(extras=()) -> int:
    return CAP.schema_chars(tool_registry.definitions_for(set(NON_WEB), web_enabled=True)) + \
        sum(len(json.dumps(e.definition, ensure_ascii=False)) for e in extras)


# ── distractors: a catalogue that has grown ─────────────────────────────────
_FAR = ["bảng lương nhân viên", "tồn kho theo kho hàng", "lịch bảo trì thiết bị",
        "chiến dịch email marketing", "hợp đồng nhà cung cấp", "phiếu hỗ trợ khách hàng",
        "chấm công ca làm", "hạn mức tín dụng", "vận đơn giao nhận", "payroll export",
        "warehouse stock count", "ticket escalation", "campaign open rate",
        "supplier contract renewal", "equipment maintenance"]
#: Same business words as the real questions — "doanh thu", "khách hàng", "tháng",
#: "revenue" — so the ranker has to tell a capability from a mention.
_NEAR = ["doanh thu theo nhân viên bán hàng", "số đơn theo cửa hàng",
         "khách hàng mới theo tháng", "giá trị đơn trung bình theo kênh",
         "tỷ lệ hoàn hàng theo sản phẩm", "chi phí vận chuyển theo bang",
         "revenue by sales rep", "orders by store", "new customers per month",
         "return rate by product"]
_VERBS = ["xuất báo cáo", "gửi tổng hợp", "đồng bộ", "tải file", "lập bảng",
          "export", "sync", "upload"]


_DEPTS = ["kế toán", "vận hành", "kinh doanh", "nhân sự"]


def distractors(n: int, seed: int = 7) -> list:
    """`n` DISTINCT capabilities — every (verb, topic, department) combination at
    most once, near- and far-domain alternating. Twenty identical copies of one
    label is not a catalogue anyone has; twenty similar ones is."""
    rnd = random.Random(seed)
    combos = {"near": [(v, t, d) for v in _VERBS for t in _NEAR for d in _DEPTS],
              "far": [(v, t, d) for v in _VERBS for t in _FAR for d in _DEPTS]}
    for pool in combos.values():
        rnd.shuffle(pool)
    out = []
    for i in range(n):
        verb, topic, dept = combos["near" if i % 2 else "far"].pop()
        label = f"{verb.capitalize()} {topic} ({dept})"
        desc = (f"{label} — {rnd.choice(['hằng ngày', 'theo tuần', 'theo yêu cầu'])}, dùng cho "
                f"bộ phận {dept}.")
        name = f"ext{i}_{'_'.join(topic.split()[:2])}"
        definition = {"name": name,
                      "description": desc + " Parameters describe the export target and format." * 6,
                      "input_schema": {"type": "object", "properties": {
                          "target": {"type": "string"}, "format": {"type": "string"}}}}
        out.append(CAP.ExtraCapability(
            name=name, definition=definition, label=label, does=desc,
            search=SimpleNamespace(name=name, label_vi=label, label_en=label, description_vi=desc,
                                   answers_vi=(), returns={}, definition=definition)))
    return out


def _measure(extras=None) -> dict:
    served = discovered = 0
    chars: list[int] = []
    irrelevant: list[float] = []
    misses = []
    for it in INTENTS:
        view = _view(it["q"], extras=extras)
        expect = set(it["expect"])
        ok = bool(expect & set(view.visible))
        served += ok
        if not ok:
            misses.append(it["q"])
        defs = view.schemas(web_enabled=True)
        chars.append(CAP.schema_chars(defs))
        # How much of round one's schema is spent on neither the core, the
        # capability the question needs, nor discovery itself.
        wanted = set(CAP.CORE) | expect | {CAP.FIND_CAPABILITY}
        spent = sum(len(json.dumps(d, ensure_ascii=False)) for d in defs if d.get("name") not in wanted)
        irrelevant.append(spent / max(1, chars[-1]))
        data = view.discover(it["need"])["data"]
        discovered += bool(expect & {r["name"] for r in data["loaded"] + data["already_loaded"]})
    return {"served": served, "discovered": discovered, "avg_chars": sum(chars) / len(chars),
            "max_chars": max(chars), "irrelevant": sum(irrelevant) / len(irrelevant),
            "misses": misses}


def test_there_are_enough_intents_to_mean_something():
    assert len(INTENTS) >= 50
    vi = sum(1 for it in INTENTS if any(ch in it["q"] for ch in "ăâđêôơưàáảãạ"))
    assert vi >= 15 and len(INTENTS) - vi >= 15, "both languages are measured"
    names = set(tool_registry.all_tools())
    for it in INTENTS:
        assert set(it["expect"]) <= names, it


def test_the_capability_a_question_needs_is_loaded_on_round_one():
    m = _measure()
    assert m["served"] >= 0.9 * len(INTENTS), (m["served"], m["misses"])


def test_describing_the_need_finds_what_the_question_needs():
    m = _measure()
    assert m["discovered"] >= 0.88 * len(INTENTS), m["discovered"]


def test_a_routed_round_costs_about_half_of_showing_everything():
    m = _measure()
    full = _full_chars()
    assert m["avg_chars"] <= full * 0.55, (m["avg_chars"], full)


def test_irrelevant_capabilities_are_not_most_of_the_context():
    m = _measure()
    assert m["irrelevant"] <= 0.45, m["irrelevant"]


@pytest.mark.parametrize("n", [100, 300])
def test_routing_holds_and_context_stays_flat_as_the_catalogue_grows(n):
    """The scaling claim, measured: recall does not collapse and the per-round
    schema does not follow the catalogue. Half the distractors share the real
    questions' business words."""
    base = _measure()
    grown = _measure(distractors(n))
    assert grown["served"] >= base["served"] - 3, (grown["served"], grown["misses"])
    assert grown["discovered"] >= base["discovered"] - 2
    assert grown["max_chars"] <= base["max_chars"] * 1.25, (grown["max_chars"], base["max_chars"])
    assert grown["max_chars"] <= _full_chars(distractors(n)) * 0.2


def test_distractors_rarely_reach_the_loaded_set_and_never_displace_the_answer():
    """Near-domain distractors ("revenue by sales rep") do sometimes clear the
    relative cutoff — measured 5 of 48 intents at 200. Tolerated because they only
    fill budget left over; what is not tolerated is one pushing out the capability
    the question needs, which the recall bar above already covers."""
    extras = distractors(200)
    hit = 0
    for it in INTENTS:
        view = _view(it["q"], extras=extras)
        loaded = [n for n in view.visible if n.startswith("ext")]
        hit += bool(loaded)
        assert len(loaded) <= 5, (it["q"], loaded)
    assert hit <= len(INTENTS) // 5, hit


# ── authority is not a ranking question ─────────────────────────────────────
def test_no_intent_can_route_or_discover_outside_the_grant():
    """Whatever is asked, whatever is searched: only eligible capabilities are
    loaded, listed or returned."""
    grant = [n for n in NON_WEB if n not in ("forecast_measure", "detect_anomaly")]
    for it in INTENTS:
        view = CAP.build_view(grant, _ctx(), web_enabled=True, question=it["q"], context=PROMPT)
        view.refresh()
        data = view.discover(it["need"], ["forecast_measure"])["data"]
        seen = set(view.visible) | {r["name"] for r in data["loaded"] + data["already_loaded"]}
        assert seen <= set(grant), (it["q"], seen - set(grant))
        text = view.find_definition()["description"]
        assert "forecast_measure" not in text and "detect_anomaly" not in text


def test_web_capabilities_are_neither_routed_nor_listed_when_web_is_off():
    web = [n for n in ALL if tool_registry.all_tools()[n].reaches_outside]
    for q in ("GDP của Brazil năm 2023?", "Tìm trên internet benchmark ngành", "search the web"):
        view = CAP.build_view(ALL, _ctx(web_search=False), web_enabled=False, question=q)
        view.refresh()
        data = view.discover(q, web)["data"]
        assert not set(view.visible) & set(web)
        assert not {r["name"] for r in data["loaded"]} & set(web)
        assert not any(w in view.find_definition()["description"] for w in web)


def test_a_cluster_of_near_identical_capabilities_loads_two_not_all():
    """A catalogue grows in clusters; copies of one idea do not get to fill the
    budget. The real registry has no such pair (most alike: 0.16 overlap)."""
    # Likeness is not transitive (A~B, A~C, B!~C), so the bound is on a CLIQUE:
    # a candidate alike to MAX_ALIKE already-loaded ones is skipped, so no
    # MAX_ALIKE+1 loaded capabilities are all alike to each other.
    from itertools import combinations

    extras = distractors(200)
    for it in INTENTS:
        view = _view(it["q"], extras=extras)
        loaded = [n for n in view.visible if n.startswith("ext")]
        for group in combinations(loaded, CAP.MAX_ALIKE + 1):
            assert not all(view._similar(a, b) for a, b in combinations(group, 2)), (it["q"], group)
    real = CAP.build_view(NON_WEB, _ctx(), web_enabled=True, question="x")
    names = list(real.eligible)
    assert not any(real._similar(a, b) for i, a in enumerate(names) for b in names[i + 1:]), \
        "the threshold must never treat two distinct real tools as copies"


def _skill_extra(key, label, when, output):
    """A Skill exactly as `agent_runtime._skill_capabilities` builds one."""
    from app.services.agent_flows import skills
    from app.services.agent_flows.contract import SkillContract, SkillInput, skill_function_name

    contract = SkillContract(inputs=[SkillInput(name="question", type="text", description="câu hỏi")],
                             output=output, when_to_use=when)
    name = skill_function_name(key)
    definition = skills.capability_definition(key, label, contract)
    return CAP.ExtraCapability(
        name=name, definition=definition, label=label, does=when,
        search=SimpleNamespace(name=name, label_vi=label, label_en=label,
                               description_vi=f"{when} {output}", answers_vi=(), returns={},
                               definition=definition))


_DISTINCT_SKILLS = [
    _skill_extra("so_sanh_ky", "So sánh kỳ", "Khi cần so sánh doanh thu giữa hai kỳ liên tiếp",
                 "Mức thay đổi giữa hai kỳ"),
    _skill_extra("du_bao_ton_kho", "Dự báo tồn kho", "Khi cần dự báo tồn kho tháng tới theo kho hàng",
                 "Số tồn kho dự kiến"),
    _skill_extra("kiem_chung_so", "Kiểm chứng số liệu", "Khi cần kiểm chứng một con số trước khi trả lời",
                 "Kết luận đúng hay sai kèm nguồn"),
    _skill_extra("phan_tich_churn", "Phân tích rời bỏ", "Khi cần giải thích vì sao khách hàng rời bỏ",
                 "Các nguyên nhân chính kèm tỷ trọng"),
    _skill_extra("so_sanh", "So sánh kỳ", "So sánh doanh thu hai kỳ", "Mức thay đổi"),
    _skill_extra("du_bao", "Dự báo", "Dự báo doanh thu tháng tới", "Số dự báo"),
    _skill_extra("kiem_chung", "Kiểm chứng", "Kiểm chứng một con số", "Đúng hay sai"),
]


def test_distinct_skills_and_a_note_on_every_grant_are_never_copies():
    """Found by review: every Skill definition carries one wrapper sentence, so
    four unrelated Skills scored 0.34–0.55 and a compare/forecast/verify trio was
    a clique of "copies"; one note repeated on every grant made 339 real tool
    pairs alike. Likeness reads what a capability IS, not how it runs or why the
    author granted it."""
    note = ("Chỉ dùng cho báo cáo tổng quan của ban giám đốc, đọc kỹ phạm vi dữ liệu "
            "trước khi trả lời và luôn nêu nguồn biểu đồ. ") * 6
    four = _DISTINCT_SKILLS[:4]
    view = CAP.build_view(NON_WEB, _ctx(), web_enabled=True, extras=four,
                          notes={n: note for n in NON_WEB}, question="x")
    names = list(view.eligible)
    alike = [(a, b) for i, a in enumerate(names) for b in names[i + 1:] if view._similar(a, b)]
    assert alike == [], alike
    # …and a real copy is still one: the same Skill published twice under two keys.
    twice = CAP.build_view(NON_WEB, _ctx(), web_enabled=True,
                           extras=[_DISTINCT_SKILLS[0], _DISTINCT_SKILLS[4]], question="x")
    assert twice._similar("skill__so_sanh_ky", "skill__so_sanh")


def test_a_question_naming_three_different_skills_loads_all_three():
    q = "So sánh doanh thu hai kỳ, dự báo tháng tới và kiểm chứng con số giúp tôi"
    trio = [e for e in _DISTINCT_SKILLS if e.name in ("skill__so_sanh", "skill__du_bao", "skill__kiem_chung")]

    def loaded(cap):
        saved = CAP.MAX_ALIKE
        CAP.MAX_ALIKE = cap
        try:
            v = CAP.build_view(NON_WEB, _ctx(), web_enabled=True, extras=trio, question=q, context=PROMPT)
            return v.refresh()
        finally:
            CAP.MAX_ALIKE = saved

    with_cap, without = loaded(CAP.MAX_ALIKE), loaded(10_000)
    assert set(without) - set(with_cap) == set(), "the cap dropped a capability that is no copy"
    assert {e.name for e in trio} <= set(with_cap)

