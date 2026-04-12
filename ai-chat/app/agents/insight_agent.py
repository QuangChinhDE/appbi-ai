"""
InsightAgent — handles INSIGHT intent.

Optimized for deep analytical questions:
- "Why did X change?", "Explain the trend", "Root cause of Y"
- Multi-step reasoning: forms hypotheses, tests with multiple queries
- Narrative output format instead of bullet lists
- Budget: 3000 tokens, 15 tool calls (allows thorough investigation)

Key behaviors:
- Does NOT force a tool call on turn 0 (INSIGHT agents plan before querying)
- Always starts with list_dataset_tables to confirm column names
- Runs 3-12 query_table calls to build a complete multi-dimensional picture
- Synthesizes findings into a coherent narrative
"""
from app.agents.tools import TOOLS_INSIGHT

AGENT_TOOLS = list(TOOLS_INSIGHT)

# Recommended investigation sequence for root-cause questions
INVESTIGATION_SEQUENCE = [
    "list_dataset_tables",   # Step 1: confirm column names
    "query_table",            # Step 2: get overall metric trend
    "query_table",            # Step 3: break down by dimension 1
    "query_table",            # Step 4: break down by dimension 2
    "explain_insight",        # Step 5: period comparison if time column exists
    "explore_data",           # Step 6: distribution check for anomalies
    "query_table",            # Step 7: cross-check with another angle
]

AGENT_METADATA = {
    "agent": "insight",
    "strengths": ["root cause", "trend analysis", "narrative", "multi-dimensional breakdown"],
    "limitations": ["slower", "higher cost"],
}


def build_investigation_plan(user_question: str) -> str:
    """
    Return a structured investigation plan injected into the first system turn.
    Helps the model organize its approach before making tool calls.
    """
    return (
        f"INVESTIGATION PLAN for: {user_question}\n\n"
        "Before answering, execute this sequence:\n"
        "1. list_dataset_tables → confirm dataset_id, table_id, column names\n"
        "2. query_table → get the overall metric (e.g. monthly totals)\n"
        "3. query_table × 2-3 → break down by key dimensions (team, region, product, etc.)\n"
        "4. explain_insight (if time column exists) → period-over-period change\n"
        "5. explore_data (if uncertain about a column's values) → check distributions\n"
        "6. After all queries: synthesize into a narrative response\n\n"
        "Do NOT write a final answer until you have evidence from at least 3 different queries."
    )
