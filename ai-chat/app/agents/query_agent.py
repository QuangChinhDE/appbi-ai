"""
QueryAgent — handles LOOKUP intent.

Optimized for fast, precise data retrieval:
- Specific numbers, rankings, top-N, counts, ratios
- Checks existing charts first (fast path)
- Falls back to query_table for exact figures
- Budget: 512 tokens, 6 tool calls
"""
from app.agents.tools import TOOLS_LOOKUP

# Tools available to this agent
AGENT_TOOLS = list(TOOLS_LOOKUP)

# Ordered tool preference for decision-making
PREFERRED_TOOL_ORDER = [
    "search_charts",      # 1st: reuse existing data, zero query cost
    "query_table",        # 2nd: precise aggregation
    "search_dashboards",  # 3rd: context from saved reports
    "list_dataset_tables",# prerequisite for query_table
    "run_chart",          # fetch data from a specific chart
    "inspect_dashboard",  # read saved report details
]

# Quality hints injected into metrics for this agent
AGENT_METADATA = {
    "agent": "query",
    "strengths": ["precise numbers", "rankings", "counts", "ratios"],
    "limitations": ["no deep narrative", "no root cause"],
}
