"""MCP tools. Each module registers its tools with `runtime.tool`."""

from typing import Any

from ..context import AppContext
from .runtime import register_all


def register_tools(mcp: Any, ctx: AppContext) -> dict[str, str]:
    """Register every tool; return {tool name: required MCP scope} for the HTTP gate."""
    return register_all(mcp, ctx)
