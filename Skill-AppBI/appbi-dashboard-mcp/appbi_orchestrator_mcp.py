"""Entry point for the AppBI Orchestrator MCP.

Importing each stage module registers its `@mcp.tool()` functions on the
shared FastMCP instance defined in `appbi_core`. Order does not matter
for correctness, but we keep it aligned with the canonical workflow:

  Source  →  Dataset  →  Semantic Model  →  Blueprint  →  Dashboard

The **blueprint** stage (`appbi_blueprint`) is the load-bearing addition
that forces a design pass before any chart is written. Without it,
Claude tends to call `create_chart` directly with ad-hoc metrics that
render in the dashboard but disappear from Explore / dataset model UI —
the recurring defect users report. `appbi_blueprint` exposes:

  - propose_semantic_model      (Stage 3 plan)
  - commit_semantic_model       (Stage 3 execute, with hard validation)
  - propose_dashboard_blueprint (Stage 4 plan)
  - commit_dashboard_blueprint  (Stage 4 execute, hard-gated by Stage 3)
  - audit_chart_semantic_health (legacy data triage, read-only)
  - repair_chart_semantic_binding (per-chart fix)

This MCP is the successor to `appbi-import-source-mcp`. Distinguishing
properties:

  * Claude is the only LLM. No tool delegates description/suggestion
    work to AppBI's internal LLM.
  * Every write tool follows preview-then-confirm via `user_confirmed`.
  * Chart writes are hard-gated against the live semantic model.
"""
from __future__ import annotations

# Core must come first — it owns the FastMCP instance and shared helpers.
from appbi_core import mcp  # noqa: F401

# Stage 1 — Source
import appbi_source  # noqa: F401

# Stage 2 — Dataset
import appbi_dataset  # noqa: F401

# Stage 3 — Semantic Model
import appbi_semantic  # noqa: F401

# Stage 4 — Charts (single-chart CRUD; prefer blueprint flow for dashboards)
import appbi_chart  # noqa: F401

# Stage 5 — Dashboard (granular placement / filter / public-link tools)
import appbi_dashboard  # noqa: F401

# Pattern libraries — one tool per measure kind / chart type. Claude picks
# by user intent ("tổng" / "tỷ lệ" / "xu hướng…") and the tool has the
# exact config baked in, removing the trial-and-error config errors that
# burn the most tokens.
import appbi_measure_library  # noqa: F401
import appbi_chart_library  # noqa: F401

# Blueprint — the canonical design-then-commit flow (Stages 3 + 4)
import appbi_blueprint  # noqa: F401

# Cross-cutting
import appbi_quality  # noqa: F401
import appbi_sharing  # noqa: F401


if __name__ == "__main__":
    mcp.run(transport="stdio")
