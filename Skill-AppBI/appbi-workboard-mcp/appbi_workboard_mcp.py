"""AppBI Workboard MCP — entry point.

Usage:
    python appbi_workboard_mcp.py

All tools are registered by importing the stage modules. The FastMCP
instance lives in appbi_wb_core.mcp.
"""
from __future__ import annotations

# Stage imports register their @mcp.tool() decorators onto the shared
# FastMCP instance in appbi_wb_core.
import appbi_wb_discovery   # noqa: F401  — Stage 1: read-only discovery
import appbi_wb_gsheets     # noqa: F401  — Stage 1b: Google Sheets tab + row management
import appbi_wb_dataset     # noqa: F401  — Stage 2: dataset + table setup
import appbi_wb_build       # noqa: F401  — Stage 3+4: blueprint + commit
import appbi_wb_users       # noqa: F401  — Stage 5: app users
import appbi_wb_workspace   # noqa: F401  — Stage 6: workspace linking

from appbi_wb_core import mcp

if __name__ == "__main__":
    mcp.run(transport="stdio")
