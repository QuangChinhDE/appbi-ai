"""Shared event/dataclass types for the agent loop.

Providers yield these; the agent loop and SSE serialiser consume them.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


EventType = Literal[
    "text",         # streaming token of the assistant's text answer
    "tool_call",    # provider asked to call a tool (after the loop emits this we execute)
    "tool_result",  # tool finished — emitted by the loop, not the provider
    "status",       # human-readable progress line (e.g. "Đang xem chart X...")
    "state",        # updated ConversationState (sent at end of turn)
    "usage",        # provider-reported token usage for the just-completed round
    "cost",         # running USD spend for this turn (emitted by the loop)
    "error",        # non-fatal error message to surface
    "done",         # final marker
    # Phase-15.71 — reading plan emitted by the agent before it starts
    # answering. FE renders this as a collapsible "AI đang đọc" panel so
    # the user sees the analyst-style flow (which charts → why → in what
    # order) instead of just the final answer.
    "reading_plan",
    # Phase 15.72 — per-step progress for the reading plan. Emitted whenever
    # the agent starts/finishes a tool call that maps onto a plan step. FE
    # uses it to update the badge next to each step from
    # pending → running → done.
    "plan_step",
]


@dataclass
class AgentEvent:
    type: EventType
    text: str = ""
    # tool_call / tool_result fields
    tool_call_id: str = ""
    tool_name: str = ""
    tool_args: dict = field(default_factory=dict)
    tool_result: dict = field(default_factory=dict)
    # provider-attached free-form payload (debug)
    extra: dict = field(default_factory=dict)
