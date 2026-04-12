"""
BASE_SYSTEM_PROMPT — composed from CORE + DATA_QUALITY_RULES.

This is the fallback used when no intent-specific prompt is selected.
Intent prompts (lookup, explore, insight, viz) each compose:
    CORE_SYSTEM_PROMPT + DATA_QUALITY_RULES + <intent delta>
"""
from .core import CORE_SYSTEM_PROMPT
from .quality_rules import DATA_QUALITY_RULES

BASE_SYSTEM_PROMPT = CORE_SYSTEM_PROMPT + "\n" + DATA_QUALITY_RULES
