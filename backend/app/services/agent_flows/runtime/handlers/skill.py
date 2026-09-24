"""The Skill step: run a published Skill with inputs the author bound.

Deterministic — no model decides whether it runs. It goes through the same
`skills.invoke_skill` an Agent capability does, so a Skill step and an Agent
reaching for the Skill are governed by one set of rules.
"""
from __future__ import annotations

from typing import Any, AsyncGenerator

from app.services.agent_flows.contract import SkillNode
from app.services.agent_flows.runtime.nodes import NodeSpec
from app.services.agent_flows.runtime.state import RunState
from app.services.dashboard_ai_bot.events import AgentEvent


async def run_skill(node: SkillNode, state: RunState, rctx: Any) -> AsyncGenerator[AgentEvent, None]:
    from app.services.agent_flows import skills
    from app.services.agent_flows.runtime.handlers.data import _resolve_inputs

    inputs = _resolve_inputs(node, state)
    outcome: dict = {}
    async for ev in skills.invoke_skill(
        state, rctx,
        skill_key=node.skill_key, version=node.version, inputs=inputs,
        # Inside a coordinator lane the Skill IS the specialist's work, and the
        # trace says so; anywhere else it is an ordinary deterministic step.
        invoked_as="coordinator_lane" if state.lane_depth else "skill_node",
        parent_step_key=node.key,
        outcome=outcome,
    ):
        yield ev
    result = outcome.get("result") or {"ok": False, "error": "Skill không chạy"}
    state.record_evidence(result, tool=f"skill:{node.skill_key}")
    if not result.get("ok"):
        # Raised, like a failed Tool step: `on_error` decides what happens next,
        # and a failed Skill must not publish a value the next step reads as data.
        raise RuntimeError(f"Skill {node.skill_key}: {result.get('error') or 'lỗi'}")
    state.outputs[node.key] = result.get("data")


SPECS = [
    NodeSpec(
        type="skill",
        label_vi="Skill",
        label_en="Skill",
        description_vi="Chạy một Skill đã phát hành — một flow tái sử dụng, có đầu vào "
                       "rõ ràng và chạy trong đúng quyền của flow này.",
        category="ai",
        icon="◈",
        handler=run_skill,
    ),
]
