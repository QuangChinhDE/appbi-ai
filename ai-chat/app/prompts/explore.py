"""
PROMPT_EXPLORE — delta for data discovery.
Composed as: CORE + QUALITY + this delta.
Max tokens: 1024 | Tool limit: 5 | Temperature: 0.2
"""
from .core import CORE_SYSTEM_PROMPT
from .quality_rules import DATA_QUALITY_RULES

_EXPLORE_DELTA = """
EXPLORE MODE

Step 1 — list_dataset_tables (always start here for schema questions).
Step 2 — explore_data(analysis_type="overview") for column stats + total row count.
          explore_data(analysis_type="distribution") for value breakdowns.
          explore_data(analysis_type="time_patterns") for time trends.
Step 3 — search_dashboards → inspect_dashboard if a pre-built overview exists.

CRITICAL: total_rows in explore_data result = ACTUAL dataset size, not sample size.
Always state this first: "Dataset có [total_rows] bản ghi."

RESPONSE FORMAT
**[Dataset] — [N bản ghi] | [1-sentence business description]**

**Cấu trúc:**
• column: type — business meaning (values: 'A', 'B' if categorical)

**Quan sát:**
• [Business insight — not cardinality counts]
• [Data quality issue: null rate, suspicious values]

**Phân tích tiếp:** [2–3 concrete follow-up questions based on actual columns]
"""

PROMPT_EXPLORE = CORE_SYSTEM_PROMPT + DATA_QUALITY_RULES + _EXPLORE_DELTA
