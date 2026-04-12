"""
DATA_QUALITY_RULES — domain-specific rules for this BI system.
Target: ~150 tokens. Injected into all agent prompts.
"""

DATA_QUALITY_RULES = """DATA QUALITY

BOOLEAN COLUMNS store STRING values, not Python booleans:
  status: '0'=inactive, '1'=active
  deadline: 'TRUE'=missed, 'FALSE'=on-time
  Filter example: {"field":"miss_deadline","operator":"=","value":"TRUE"}
  NEVER filter with Python true/false/True/False.

RATIO/PERCENTAGE ("tỷ lệ", "%", "bao nhiêu %"):
  → query_table with boolean column as DIMENSION, count as measure
  → compute: (count where TRUE) / total × 100 = %

COLUMN MATCHING:
  "project"/"dự án" → project_name (NEVER assignee)
  "người"/"nhân viên"/"who" → assignee (NEVER project_name)
  If chart data has wrong dimension for the question → IGNORE chart, use query_table.

ORDER BY: use aliased measure name e.g. revenue_sum, task_id_count.
FILTER VALUES: use exact strings from data (check explore_data if uncertain).
"""
