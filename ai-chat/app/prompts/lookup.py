"""
PROMPT_LOOKUP — delta for precise data retrieval.
Composed as: CORE + QUALITY + this delta.
Max tokens: 512 | Tool limit: 6 | Temperature: 0.1
"""
from .core import CORE_SYSTEM_PROMPT
from .quality_rules import DATA_QUALITY_RULES

_LOOKUP_DELTA = """
LOOKUP MODE

Step 1 — search_charts(query). If top_chart_data.rows has the EXACT columns asked → use it.
         If chart data is about different dimensions → IGNORE, go to Step 2.
Step 2 — list_dataset_tables → query_table with correct dimensions + measures + order_by + limit.
         For dashboards/reports → search_dashboards → inspect_dashboard.
         For ratios → GROUP BY category column → compute %.
Step 3 — For "top/highest/most": scan ALL rows, find actual MAX — do NOT assume first row = answer.

RESPONSE FORMAT
**[Direct answer — 1 sentence: top result + exact value]**
• Item: value
(3–7 items from actual data)
[1 pattern observation]
"""

PROMPT_LOOKUP = CORE_SYSTEM_PROMPT + DATA_QUALITY_RULES + _LOOKUP_DELTA
