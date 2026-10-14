# -*- coding: utf-8 -*-
"""Version pinning protects reproducibility; lifecycle protects runtime safety.

A published parent names an EXACT Skill version (pinned at publish) and keeps
running it after the Skill moves on. That must not mean "runs forever": an
operator who finds a security, data-access, compliance or logic defect in a
version has to be able to stop it — without rewriting every parent, and without
silently moving any of them to a newer version.

    active       invocable
    deprecated   existing pins keep running, with an author notice; nothing new
                 pins it; republishing onto it is acknowledged, not defaulted
    disabled     refused at EVERY invocation, pinned or not, with its reason
    unshared     refused at invocation for a caller whose owner may no longer
                 build on it — the attach rule, re-asked every run

All three invocation surfaces (Agent capability, Skill step, coordinator lane) go
through `skills.invoke_skill`, so these tests drive the capability and the step;
the lane is the same call with `invoked_as="coordinator_lane"`.
"""
from __future__ import annotations

import copy
import os
from types import SimpleNamespace

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import pytest  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from test_skills_run_as_governed_children import (  # noqa: E402,F401
    PARENT_GRANTING_SKILL,
    SKILL_BODY,
    SKILL_CALL,
    _children,
    _flow,
    _Model,
    _row,
    _run,
    skill_db,
)

from app.models.agent_brain import AgentBrainVersion  # noqa: E402
from app.services.agent_flows import registry as reg  # noqa: E402
from app.services.agent_flows import skills  # noqa: E402

SKILL_STEP_FLOW = {
    "answer_node": "tra_loi",
    "nodes": [
        {"key": "kiem", "name": "Kiểm chứng", "type": "skill", "skill_key": "so_sanh", "version": 2,
         "inputs": {"question": {"source": "literal", "value": "Doanh thu?"},
                    "chart_id": {"source": "literal", "value": 41}}},
        {"key": "tra_loi", "name": "Trả lời", "type": "agent", "prompt": "VAI_TRO_CHA trả lời"},
    ],
}


def _stop(db_fixture, version: int, state: str, reason: str = "lỗi rò rỉ dữ liệu") -> None:
    row = db_fixture.registry[("so_sanh", version)][0]
    row.lifecycle = None if state == skills.ACTIVE else state
    row.lifecycle_reason = None if state == skills.ACTIVE else reason


def _add_v3(db_fixture) -> None:
    db_fixture.registry[("so_sanh", 3)] = (_row("so_sanh", 3), _flow(SKILL_BODY, "so_sanh"))


def _calls(env) -> list[str]:
    return [c for s in (env.get("trace") or {}).get("steps") or [] for c in s.get("tool_calls") or []]


# ── disabled ────────────────────────────────────────────────────────────────
def test_a_disabled_version_is_not_offered_and_is_refused_even_when_pinned(monkeypatch, skill_db):
    _stop(skill_db, 2, skills.DISABLED)
    _add_v3(skill_db)                       # a newer, ACTIVE version exists …
    model = _Model(parent_script=[SKILL_CALL, ("text", "Không dùng được Skill.")], child_script=[])
    env, state, _ = _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model)
    assert "skill__so_sanh" not in model.offered["VAI_TRO_CHA"][0], "not shown what would be refused"
    assert _children(skill_db.db) == [], "… and nothing ran: not v2, and NOT silently v3"
    assert "skill__so_sanh(skill_disabled)" in state.tool_log
    step = env["trace"]["steps"][-1]
    assert step["capabilities"]["excluded"]["skill__so_sanh"] == "skill_disabled"
    assert env["status"] in ("ok", "partial"), "the parent still answers"


def test_the_refusal_names_the_reason_the_operator_gave(monkeypatch, skill_db):
    _stop(skill_db, 2, skills.DISABLED, reason="CVE-2026-1 trong truy vấn")
    outcome: dict = {}
    import asyncio

    from app.services.agent_flows.runtime.state import Budget, RunState

    rctx = SimpleNamespace(db=skill_db.db, flow=SimpleNamespace(key="cha"), skill_stack=())
    state = RunState(budget=Budget())

    async def go():
        async for _ in skills.invoke_skill(state, rctx, skill_key="so_sanh", version=2, inputs={},
                                           invoked_as="agent_capability", parent_step_key="x",
                                           outcome=outcome):
            pass

    asyncio.run(go())
    res = outcome["result"]
    assert res["ok"] is False and res["error_code"] == "skill_disabled" and res["retryable"] is False
    assert "CVE-2026-1" in res["error"]


def test_a_skill_step_pinned_to_a_disabled_version_fails_loudly_and_is_not_upgraded(monkeypatch, skill_db):
    _stop(skill_db, 2, skills.DISABLED)
    _add_v3(skill_db)
    model = _Model(parent_script=[("text", "Trả lời mà không có kiểm chứng.")], child_script=[])
    env, _, _ = _run(monkeypatch, skill_db.db, SKILL_STEP_FLOW, model)
    kiem = next(s for s in env["trace"]["steps"] if s["key"] == "kiem")
    assert kiem["status"] == "error" and "vô hiệu hoá" in kiem["error"]
    assert _children(skill_db.db) == []


def test_re_activating_a_version_restores_it(monkeypatch, skill_db):
    _stop(skill_db, 2, skills.DISABLED)
    _stop(skill_db, 2, skills.ACTIVE)
    model = _Model(parent_script=[SKILL_CALL, ("text", "Xong.")], child_script=[("text", "Kết quả")])
    _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model)
    [child] = _children(skill_db.db)
    assert child.version == 2


# ── deprecated ──────────────────────────────────────────────────────────────
def test_a_deprecated_pin_keeps_running_with_an_author_notice(monkeypatch, skill_db):
    _stop(skill_db, 2, skills.DEPRECATED, reason="thay bằng so_sanh_v3")
    model = _Model(parent_script=[SKILL_CALL, ("text", "Xong.")], child_script=[("text", "Kết quả Skill")])
    env, _, _ = _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model)
    [child] = _children(skill_db.db)
    assert child.version == 2
    notice = next(n for n in env["notices"] if n["code"] == "skill_deprecated")
    assert notice["audience"] == "author" and "thay bằng so_sanh_v3" in notice["text"]


def test_nothing_new_pins_a_deprecated_or_disabled_release(skill_db):
    for state in (skills.DEPRECATED, skills.DISABLED):
        latest = max(v for k, v in skill_db.registry if k == "so_sanh")
        _stop(skill_db, latest, state)
        body = {"answer_node": "a", "nodes": [{"key": "a", "type": "agent", "prompt": "x",
                                               "tools": [{"tool": "skill:so_sanh"}]}]}
        pinned = skills.pin_skill_versions(skill_db.db, body)
        assert "version" not in pinned["nodes"][0]["tools"][0], state
        problems = skills.publish_problems(skill_db.db, SimpleNamespace(brain_key="cha", flow_type="bot"),
                                           _flow(body, "cha"))
        assert any("không ghim được" in p for p in problems), (state, problems)
        _stop(skill_db, latest, skills.ACTIVE)


def test_republishing_onto_a_deprecated_pin_is_acknowledged_not_defaulted(skill_db):
    _stop(skill_db, 2, skills.DEPRECATED)
    flow = _flow(PARENT_GRANTING_SKILL, "cha")
    assert skills.deprecated_pins(skill_db.db, flow), "listed as a problem to acknowledge"
    _stop(skill_db, 2, skills.DISABLED)
    hard = skills.skill_graph_problems(skill_db.db, flow, self_key="cha")
    assert any("vô hiệu hoá" in p for p in hard), "disabled is not acknowledgeable"


# ── sharing, re-asked at invocation ─────────────────────────────────────────
def test_an_unshare_after_publish_stops_the_next_run(monkeypatch, skill_db):
    skill_db.shared.discard("so_sanh")
    model = _Model(parent_script=[SKILL_CALL, ("text", "Không dùng được.")], child_script=[])
    env, state, _ = _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model)
    assert _children(skill_db.db) == []
    assert "skill__so_sanh(skill_access_revoked)" in state.tool_log
    assert env["trace"]["steps"][-1]["capabilities"]["excluded"]["skill__so_sanh"] == "skill_access_revoked"


def test_access_is_decided_by_the_callers_owner_now_and_fails_closed(monkeypatch):
    """`caller_may_use` wiring: caller flow → its owner → `usable_brains` → this key.
    (Against the real sharing tables: the live check in the V3 eval script.)"""
    from app.services.agent_flows import permissions

    owner = SimpleNamespace(email="a@x.io")
    seen = {}

    class _Q:
        def __init__(self, rows):
            self.rows = rows

        def filter(self, *conds):
            key = seen.get("key")
            return _Q([r for r in self.rows if r.brain_key == key])

        def order_by(self, *a):
            return self

        def first(self):
            return self.rows[0] if self.rows else None

    caller_row = SimpleNamespace(brain_key="cha", owner_email="a@x.io", version=4)
    usable = {"so_sanh"}

    class _DB:
        def query(self, model):
            seen["key"] = "cha"
            return _Q([caller_row])

    def fake_usable(db, user):
        assert user is owner, "the CALLER's owner — never the viewer, never the Skill's owner"
        seen["key"] = "so_sanh"
        return _Q([SimpleNamespace(brain_key=k) for k in usable])

    monkeypatch.setattr(permissions, "_resolve_owner", lambda db, row: owner if row is caller_row else None)
    monkeypatch.setattr(permissions, "usable_brains", fake_usable)
    assert skills.caller_may_use(_DB(), "cha", "so_sanh") is True
    usable.clear()
    assert skills.caller_may_use(_DB(), "cha", "so_sanh") is False
    monkeypatch.setattr(permissions, "_resolve_owner", lambda db, row: None)
    assert skills.caller_may_use(_DB(), "cha", "so_sanh") is False, "an unresolvable owner uses nothing"


def test_an_access_check_that_errors_refuses(monkeypatch, skill_db):
    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(skills, "caller_may_use", boom)
    refused = skills.invocation_refusal(skill_db.db, SimpleNamespace(flow=SimpleNamespace(key="cha")),
                                        skill_db.registry[("so_sanh", 2)][0], "so_sanh")
    assert refused and refused["error_code"] == "skill_access_revoked"


# ── the operator's switch, and history that stays explainable ───────────────
@pytest.fixture()
def brains():
    engine = create_engine("sqlite://")
    AgentBrainVersion.__table__.create(engine)
    db = sessionmaker(bind=engine)()
    for v, status in ((1, "archived"), (2, "published"), (3, "draft")):
        db.add(AgentBrainVersion(brain_key="so_sanh", version=v, status=status, name="So sánh",
                                 body=copy.deepcopy(SKILL_BODY), flow_type="skill", owner_email="o@x.io"))
    parent = copy.deepcopy(PARENT_GRANTING_SKILL)
    db.add(AgentBrainVersion(brain_key="cha", version=1, status="published", name="Cha",
                             body=parent, flow_type="bot", owner_email="a@x.io"))
    db.commit()
    yield db
    db.close()


def test_set_lifecycle_needs_a_reason_skips_drafts_and_is_audited(monkeypatch, brains):
    audits = []
    monkeypatch.setattr(reg, "_audit", lambda db, action, key, actor, details: audits.append((action, details)))
    with pytest.raises(reg.BrainError, match="lý do"):
        skills.set_lifecycle(brains, key="so_sanh", versions=[2], state=skills.DISABLED,
                             reason="x", actor_email="op@x.io")
    with pytest.raises(reg.BrainError):
        skills.set_lifecycle(brains, key="so_sanh", versions=[3], state=skills.DISABLED,
                             reason="bản nháp không có gì để dừng", actor_email="op@x.io")
    out = skills.set_lifecycle(brains, key="so_sanh", versions=None, state=skills.DISABLED,
                               reason="sự cố vận hành #42", actor_email="op@x.io")
    assert [o["version"] for o in out] == [1, 2] and all(o["lifecycle"] == "disabled" for o in out)
    assert audits == [("AGENT_FLOW_SKILL_LIFECYCLE",
                       {"versions": [1, 2], "state": "disabled", "reason": "sự cố vận hành #42"})]
    row = brains.query(AgentBrainVersion).filter_by(brain_key="so_sanh", version=2).one()
    assert row.body == SKILL_BODY, "the body is never touched: history stays explainable"
    with pytest.raises(reg.BrainError, match="Skill"):
        skills.set_lifecycle(brains, key="cha", versions=None, state=skills.DISABLED,
                             reason="không phải Skill", actor_email="op@x.io")


def test_a_pinned_skill_version_cannot_be_deleted(monkeypatch, brains):
    monkeypatch.setattr(reg, "_audit", lambda *a, **k: None)
    assert skills.pinned_by(brains, "so_sanh", 2) == ["cha v1"]
    brains.query(AgentBrainVersion).filter_by(brain_key="so_sanh", version=2).one().status = "archived"
    brains.commit()
    with pytest.raises(reg.BrainError, match="vô hiệu hoá thay vì xoá"):
        reg.delete_version(brains, "so_sanh", 2, "op@x.io")


# ── bounded multi-agent, through a Skill ────────────────────────────────────
COORDINATOR_SKILL = {
    "answer_node": "tl",
    "skill": {"inputs": [{"name": "question", "type": "text"}], "output": "x",
              "when_to_use": "Khi cần một nhóm chuyên gia phân tích"},
    "nodes": [
        {"key": "dp", "name": "dp", "type": "coordinate", "prompt": "Chọn", "specialists": [
            {"key": "a", "name": "a", "when": "doanh thu", "body": [
                {"key": "a1", "type": "agent", "prompt": "x"}]},
            {"key": "b", "name": "b", "when": "đánh giá", "body": [
                {"key": "b1", "type": "agent", "prompt": "y"}]}]},
        {"key": "tl", "type": "agent", "prompt": "tl"}],
}


def test_a_skill_that_runs_a_coordinator_is_refused_inside_a_lane(monkeypatch, skill_db):
    import asyncio

    from app.services.agent_flows.runtime.state import Budget, RunState

    skill_db.registry[("nhom", 1)] = (_row("nhom", 1), _flow(COORDINATOR_SKILL, "nhom"))
    skill_db.shared.add("nhom")
    rctx = SimpleNamespace(db=skill_db.db, flow=SimpleNamespace(key="cha"), skill_stack=())
    state = RunState(budget=Budget())
    state.lane_depth = 1
    outcome: dict = {}

    async def go():
        async for _ in skills.invoke_skill(state, rctx, skill_key="nhom", version=1,
                                           inputs={"question": "?"}, invoked_as="coordinator_lane",
                                           parent_step_key="a1", outcome=outcome):
            pass

    asyncio.run(go())
    assert outcome["result"]["error_code"] == "nested_coordinator"


def test_a_coordinator_is_found_through_a_chain_of_skills(skill_db):
    """S1 has no coordinator; S1 pins S2, which does. Inside a lane, S1 is refused."""
    skill_db.registry[("nhom", 1)] = (_row("nhom", 1), _flow(COORDINATOR_SKILL, "nhom"))
    relay = {"answer_node": "r", "skill": {"inputs": [], "output": "x",
                                           "when_to_use": "Khi cần chuyển tiếp cho nhóm"},
             "nodes": [{"key": "r", "type": "agent", "prompt": "r",
                        "tools": [{"tool": "skill:nhom", "version": 1}]}]}
    assert skills._reaches_coordinator(skill_db.db, _flow(relay, "relay")) is True
    parent = {"answer_node": "tl", "nodes": [
        {"key": "dp", "name": "dp", "type": "coordinate", "prompt": "Chọn", "specialists": [
            {"key": "a", "name": "a", "when": "doanh thu", "body": [
                {"key": "a1", "type": "agent", "prompt": "x", "tools": [{"tool": "skill:nhom", "version": 1}]}]},
            {"key": "b", "name": "b", "when": "đánh giá", "body": [{"key": "b1", "type": "agent", "prompt": "y"}]}]},
        {"key": "tl", "type": "agent", "prompt": "tl"}]}
    problems = skills.coordinator_through_skill_problems(skill_db.db, _flow(parent, "cha"))
    assert problems and "không lồng điều phối" in problems[0]
