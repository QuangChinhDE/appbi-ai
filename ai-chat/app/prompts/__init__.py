"""
Prompt variants for AI Chat agents.
Each intent type gets its own tailored system prompt composed from:
  CORE_SYSTEM_PROMPT + DATA_QUALITY_RULES + <intent delta>
"""
from .core import CORE_SYSTEM_PROMPT
from .quality_rules import DATA_QUALITY_RULES
from .base import BASE_SYSTEM_PROMPT
from .lookup import PROMPT_LOOKUP
from .explore import PROMPT_EXPLORE
from .insight import PROMPT_INSIGHT
from .insight_planning import INSIGHT_PLANNING_PROMPT
from .viz import PROMPT_VIZ

__all__ = [
    "CORE_SYSTEM_PROMPT",
    "DATA_QUALITY_RULES",
    "BASE_SYSTEM_PROMPT",
    "PROMPT_LOOKUP",
    "PROMPT_EXPLORE",
    "PROMPT_INSIGHT",
    "INSIGHT_PLANNING_PROMPT",
    "PROMPT_VIZ",
]
