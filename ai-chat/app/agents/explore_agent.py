"""
ExploreAgent — handles EXPLORE intent.

Optimized for data discovery and schema exploration:
- "What data do I have?", "Describe this dataset", "What columns?"
- Shows structure, types, sample values, distributions
- Identifies data quality issues (nulls, cardinality)
- Budget: 1024 tokens, 5 tool calls
"""
from app.agents.tools import TOOLS_EXPLORE

AGENT_TOOLS = list(TOOLS_EXPLORE)

# Tool preference for exploration
PREFERRED_TOOL_ORDER = [
    "list_dataset_tables",  # Always start here to see what's available
    "explore_data",          # Then profile the relevant table
    "search_dashboards",     # Check if there's a pre-built overview
    "search_charts",         # Any pre-existing visualizations?
    "run_dataset_table",     # Last resort: look at raw samples
]

AGENT_METADATA = {
    "agent": "explore",
    "strengths": ["schema discovery", "data profiling", "sample values", "column stats"],
    "limitations": ["no aggregation", "no root cause"],
}
