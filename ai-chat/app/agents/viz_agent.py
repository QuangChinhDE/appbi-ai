"""
VizAgent — handles CREATE intent.

Optimized for chart and dashboard creation:
- "Create a chart for X", "Build a dashboard", "Make a bar chart"
- Always calls list_dataset_tables first for correct IDs
- Selects appropriate chart type based on data nature
- Budget: 1024 tokens, 8 tool calls
"""
from app.agents.tools import TOOLS_VIZ

AGENT_TOOLS = list(TOOLS_VIZ)

# Chart type selection heuristics
CHART_TYPE_GUIDE = {
    "BAR":          "Categorical comparison (team vs team, product vs product)",
    "LINE":         "Trend over continuous values (not necessarily time)",
    "TIME_SERIES":  "Trend over time (when x-axis is a date column)",
    "PIE":          "Proportions / shares (max 7 categories, or it looks bad)",
    "STACKED_BAR":  "Part-to-whole comparisons across categories",
    "GROUPED_BAR":  "Side-by-side comparison of multiple metrics per category",
    "KPI":          "Single headline number (total, average, count)",
    "SCATTER":      "Correlation between two numeric columns",
    "TABLE":        "Tabular data with many columns or text values",
    "AREA":         "Cumulative trend or volume over time",
}

AGENT_METADATA = {
    "agent": "viz",
    "strengths": ["chart creation", "dashboard generation", "visualization"],
    "limitations": ["no analysis", "no root cause"],
}
