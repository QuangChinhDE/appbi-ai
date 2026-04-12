"""
Prompt variants for AI Chat agents.
Each intent type gets its own tailored system prompt.
"""
from .lookup import PROMPT_LOOKUP
from .explore import PROMPT_EXPLORE
from .insight import PROMPT_INSIGHT
from .viz import PROMPT_VIZ
from .base import BASE_SYSTEM_PROMPT

__all__ = [
    "BASE_SYSTEM_PROMPT",
    "PROMPT_LOOKUP",
    "PROMPT_EXPLORE",
    "PROMPT_INSIGHT",
    "PROMPT_VIZ",
]
