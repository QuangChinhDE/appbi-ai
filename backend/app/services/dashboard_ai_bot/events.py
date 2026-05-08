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
    "error",        # non-fatal error message to surface
    "done",         # final marker
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
