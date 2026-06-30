"""Entry point for the AppBI Workboard MCP."""
from __future__ import annotations

# Core owns the shared FastMCP instance. Stage imports register tools.
from appbi_wb_core import mcp  # noqa: F401

# Stage 0-2: source -> dataset -> data model (the full upstream journey).
import appbi_wb_source  # noqa: F401
import appbi_wb_dataset  # noqa: F401
import appbi_wb_model  # noqa: F401
# Stage 3+: discovery, workboard authoring, delivery.
import appbi_wb_discovery  # noqa: F401
import appbi_wb_build  # noqa: F401
import appbi_wb_authoring  # noqa: F401
import appbi_wb_users  # noqa: F401
import appbi_wb_webhooks  # noqa: F401
import appbi_wb_workspace  # noqa: F401


if __name__ == "__main__":
    mcp.run(transport="stdio")
