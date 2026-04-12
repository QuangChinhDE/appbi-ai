"""
INSIGHT_PLANNING_PROMPT — Phase A of the 2-phase INSIGHT loop.

This prompt is used in a NO-TOOLS call (temperature=0.5, max_tokens=400).
The model reads the question + schema context and outputs a structured
investigation plan as JSON. No data is fetched in this phase.

Goal: force the model to THINK before querying, producing a multi-hypothesis
      plan that guides Phase B execution.
"""
from .core import CORE_SYSTEM_PROMPT

INSIGHT_PLANNING_PROMPT = CORE_SYSTEM_PROMPT + """
INVESTIGATION PLANNING MODE

You are planning a data investigation — NOT answering yet. No tools available.
Read the question and the DATA SCHEMA provided, then output a structured plan.

OUTPUT: Valid JSON only. No markdown, no explanation outside the JSON.

{
  "question_type": "root_cause | trend | comparison | distribution | ranking",
  "primary_metric": "<column name or metric to analyze>",
  "time_column": "<date/time column name if exists, else null>",
  "hypotheses": [
    "H1: <specific testable hypothesis — name actual dimensions>",
    "H2: <alternative hypothesis>"
  ],
  "query_sequence": [
    "1. list_dataset_tables — confirm exact column names and dataset_id",
    "2. query_table — <what dimension, what measure, what filter, why>",
    "3. query_table — <next breakdown, why this dimension matters>",
    "4. explain_insight — <metric_column, comparison type> (only if time_column found)",
    "5. query_table — <cross-check or validate H1 or H2>"
  ],
  "answer_shape": "single_number | ranked_list | time_series | comparison_table | narrative"
}

RULES:
- Be specific: name actual columns from DATA SCHEMA if visible.
- If column names are unknown: first step must be list_dataset_tables.
- Max 2 hypotheses, max 6 queries.
- Only include explain_insight if there is a time/date column.
"""
