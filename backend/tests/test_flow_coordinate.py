"""One agent decides which specialists a question needs; they run; the answer combines.

WHAT THIS REPLACES
------------------
Routing was `If`/`Switch` on conditions the author wrote by hand, or a `choice`
classifier feeding a Switch. Both need the author to enumerate the questions in
advance, and a viewer's question is the one thing that cannot be enumerated. So in
practice either every specialist ran on every question, or one hand-written branch
matched and the rest of the flow sat idle — sub-agents each doing their own thing
with nothing joining them up.

Measured on the finished node, three questions against one roster of three:

    "Lợi nhuận tháng này thế nào?"   → doanh thu + chi phí   (both, combined)
    "Giao hàng có đúng hẹn không?"   → vận hành              (only that one)
    "Thời tiết Hà Nội hôm nay?"      → nobody, and it says so
"""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_coord.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services.agent_flows.contract import (
    ROUTING_NODE_TYPES,
    CoordinateNode,
    Specialist,
)
from app.services.agent_flows.runtime.executor import (
    _NO_SPECIALIST,
    _picked_specialists,
)


ROSTER = [
    Specialist(key="doanh_thu", name="CG doanh thu", when="câu hỏi về doanh thu, GMV"),
    Specialist(key="chi_phi", name="CG chi phí", when="câu hỏi về chi phí, phí ship"),
    Specialist(key="van_hanh", name="CG vận hành", when="câu hỏi về giao hàng, SLA"),
]


def keys(picked) -> list[str]:
    return [s.key for s in picked]


# ── a plan is a SUBSET, which is why this parses instead of enforcing a choice ──

def test_a_plan_may_name_more_than_one_specialist():
    """The planner started as a `choice` step, which refuses anything outside its
    list — and one thing too many. Measured: "Lợi nhuận tháng này thế nào?" needs
    both revenue and cost, the model answered "doanh_thu chi_phi", `choice`
    rejected it as invalid, and the coordinator ran nobody at all."""
    assert keys(_picked_specialists("doanh_thu chi_phi", ROSTER, 3)) == [
        "doanh_thu", "chi_phi"]


def test_a_plan_of_one_runs_only_that_one():
    assert keys(_picked_specialists("van_hanh", ROSTER, 3)) == ["van_hanh"]


def test_naming_nobody_is_a_legitimate_plan():
    assert _picked_specialists(_NO_SPECIALIST, ROSTER, 3) == []


def test_prose_around_the_keys_does_not_defeat_the_plan():
    """A model that apologises first has still named the specialists."""
    picked = _picked_specialists(
        "Tôi nghĩ nên hỏi doanh_thu và chi_phi.", ROSTER, 3)
    assert keys(picked) == ["doanh_thu", "chi_phi"]


def test_an_invented_specialist_is_dropped_not_raised():
    """A planner that invents a key has produced a worse plan, not a broken flow."""
    assert keys(_picked_specialists("doanh_thu chuyen_gia_ma", ROSTER, 3)) == [
        "doanh_thu"]


def test_prose_naming_nobody_plans_nobody():
    assert _picked_specialists("Tôi không chắc câu hỏi này về gì.", ROSTER, 3) == []


def test_a_key_inside_a_longer_word_is_not_a_pick():
    """`chi_phi` must not match `chi_phi_khac`, or a roster with related names
    routes to the wrong lane and the answer still reads fluently."""
    roster = [*ROSTER, Specialist(key="chi_phi_khac", name="Khác", when="chi phí khác")]
    assert keys(_picked_specialists("chi_phi_khac", roster, 3)) == ["chi_phi_khac"]


def test_the_plan_is_capped_at_the_authors_ceiling():
    """The limit exists so a planner that wants everything cannot turn one
    question into six."""
    assert len(_picked_specialists("doanh_thu chi_phi van_hanh", ROSTER, 2)) == 2


def test_the_plan_follows_roster_order_not_the_order_the_model_listed():
    """The author arranged the specialists on the canvas, and a run that reorders
    them for no reason is harder to read against the design."""
    assert keys(_picked_specialists("van_hanh doanh_thu", ROSTER, 3)) == [
        "doanh_thu", "van_hanh"]


def test_the_same_specialist_named_twice_runs_once():
    assert keys(_picked_specialists("chi_phi chi_phi", ROSTER, 3)) == ["chi_phi"]


# ── what the contract refuses at save time ────────────────────────────────────

def test_a_specialist_must_say_when_to_use_it():
    """A classifier handed bare keys — `tra_so`, `so_sanh`, `bat_thuong` — sent
    "GMV toàn kỳ là bao nhiêu?" down the FORECAST branch and never once fired the
    lookup case. Those are variable names, not descriptions."""
    with pytest.raises(ValueError, match="KHI NÀO"):
        Specialist(key="a", name="A", when="ngắn")


def test_one_specialist_is_not_a_coordination_problem():
    with pytest.raises(ValueError, match="ít nhất 2 chuyên gia"):
        CoordinateNode(key="dp", specialists=[ROSTER[0]])


def test_two_specialists_with_the_same_key_are_refused():
    dupe = Specialist(key="doanh_thu", name="Khác", when="câu hỏi về thứ khác")
    with pytest.raises(ValueError, match="trùng key"):
        CoordinateNode(key="dp", specialists=[ROSTER[0], dupe])


def test_the_ceiling_cannot_be_set_to_something_unaffordable():
    with pytest.raises(ValueError):
        CoordinateNode(key="dp", specialists=ROSTER, max_specialists=99)


# ── routing bookkeeping is not evidence ───────────────────────────────────────

def test_a_coordinator_is_a_routing_node():
    assert "coordinate" in ROUTING_NODE_TYPES


def test_a_routing_result_is_not_carried_as_the_previous_step(monkeypatch):
    """`previous` is what the next step is shown as "the result of the previous
    step". Observed on a plan that chose nobody: the answering step was handed
    `{"picked": [], "considered": ["doanh_thu", ...]}` — a list of internal node
    keys, and nothing else."""
    from app.services.agent_flows.runtime import executor

    class _State:
        def __init__(self):
            self.outputs = {"dp": {"picked": [], "considered": ["doanh_thu"]}}
            self.vars: dict = {"previous": "kết quả thật"}
            self.memory_set: dict = {}

        def set_var(self, k, v):
            self.vars[k] = v

    class _Node:
        key = "dp"
        type = "coordinate"
        output_var = ""
        run_policy = "every_turn"

    state = _State()
    executor._publish(_Node(), state)
    assert state.vars["previous"] == "kết quả thật"


def test_an_ordinary_step_still_publishes_itself_as_previous():
    from app.services.agent_flows.runtime import executor

    class _State:
        def __init__(self):
            self.outputs = {"a": "tìm được 4,2 tỷ"}
            self.vars: dict = {"previous": "cũ"}
            self.memory_set: dict = {}

        def set_var(self, k, v):
            self.vars[k] = v

    class _Node:
        key = "a"
        type = "agent"
        output_var = ""
        run_policy = "every_turn"

    state = _State()
    executor._publish(_Node(), state)
    assert state.vars["previous"] == "tìm được 4,2 tỷ"


def test_the_builder_offers_it():
    """A node type nobody can add is a node type nobody uses — the same silent gap
    as a handler with no palette entry."""
    from app.services.agent_flows.runtime import nodes as node_registry

    raw = node_registry.catalogue()
    items = raw.get("nodes") if isinstance(raw, dict) else raw
    offered = {(i["type"] if isinstance(i, dict) else getattr(i, "type", ""))
               for i in items}
    assert "coordinate" in offered


def test_it_is_declared_as_costing_a_model_call():
    """An author comparing this against four hand-wired branches deserves to see
    that the routing itself is not free."""
    from app.services.agent_flows.runtime import nodes as node_registry

    assert node_registry.spec_for("coordinate").costs_llm is True


def test_a_specialist_lane_with_no_steps_is_warned_about():
    """Choosing it spends the planning call, records the pick, runs nothing, and
    leaves the answering step with less than a flow with no coordinator at all.
    The canvas draws the lane whether or not anything is in it."""
    from app.services.agent_flows.contract import Flow, upgrade_body

    body = {
        "name": "t",
        "nodes": [
            {"key": "dp", "type": "coordinate", "name": "Điều phối", "specialists": [
                {"key": "a", "name": "A", "when": "câu hỏi về doanh thu",
                 "body": [{"key": "a1", "type": "agent", "prompt": "x"}]},
                {"key": "b", "name": "B", "when": "câu hỏi về chi phí", "body": []},
            ]},
            {"key": "ans", "type": "agent", "prompt": "trả lời"},
        ],
    }
    flow = Flow.model_validate(
        {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"})
    assert any("chưa có bước nào bên trong" in w for w in flow.warnings())


def test_a_validation_message_reaches_the_author_without_pydantic_noise():
    """The prefix was stripped and the suffix was not, so an author saving a flow
    read their own sentence with `[type=value_error, input_value='',
    input_type=str]` welded to the end of it, in the title bar."""
    from app.services.agent_flows.registry import _first_message

    try:
        Specialist(key="a", name="A", when="")
    except Exception as exc:  # noqa: BLE001
        message = _first_message(exc)
    assert "KHI NÀO" in message
    assert "[type=" not in message and "input_value" not in message
