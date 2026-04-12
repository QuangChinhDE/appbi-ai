"""
FeedbackAnalyzer — Phase 4.

Processes thumbs-up/down feedback from ChatMessage records to:
1. Compute per-intent satisfaction rates
2. Surface the best-rated Q&A examples for few-shot injection
3. Enrich the InsightAgent system prompt with real high-quality examples

Data flow:
  Backend DB (chat_messages.feedback) → bi_client.list_chat_sessions()
  → FeedbackAnalyzer.load_feedback() → satisfaction stats + best examples
  → enrich_insight_prompt(base_prompt, examples) → improved system prompt

Usage:
  The /chat/admin/feedback-stats endpoint exposes aggregated results.
  The InsightAgent's run() can optionally call get_few_shot_examples() to
  inject high-quality examples before the turn.
"""
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Data models
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class RatedExample:
    """A high-quality Q&A pair that can be used as a few-shot example."""
    question: str
    answer: str
    rating: str          # "positive" | "negative"
    intent: str          # inferred from question keywords
    tool_calls: List[str] = field(default_factory=list)
    session_id: str = ""
    message_id: str = ""


@dataclass
class IntentSatisfaction:
    """Satisfaction stats for one intent type."""
    intent: str
    total: int = 0
    positive: int = 0
    negative: int = 0

    @property
    def satisfaction_rate(self) -> float:
        if self.total == 0:
            return 0.0
        return round(self.positive / self.total, 3)

    def to_dict(self) -> Dict:
        return {
            "intent": self.intent,
            "total_rated": self.total,
            "positive": self.positive,
            "negative": self.negative,
            "satisfaction_rate": self.satisfaction_rate,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Intent inference (lightweight, no LLM cost)
# ─────────────────────────────────────────────────────────────────────────────

def _infer_intent(question: str) -> str:
    """Infer intent from question text using keyword heuristics."""
    q = question.lower()
    if any(kw in q for kw in ("tại sao", "vì sao", "lý do", "giải thích", "why", "explain",
                               "nguyên nhân", "xu hướng", "trend", "root cause", "phân tích sâu")):
        return "INSIGHT"
    if any(kw in q for kw in ("tạo", "create", "build", "vẽ", "biểu đồ", "chart", "dashboard")):
        return "CREATE"
    if any(kw in q for kw in ("có gì", "gồm gì", "cấu trúc", "mô tả", "what data", "columns",
                               "describe", "overview", "tổng quan", "schema")):
        return "EXPLORE"
    return "LOOKUP"  # default


# ─────────────────────────────────────────────────────────────────────────────
# Core analyzer
# ─────────────────────────────────────────────────────────────────────────────

class FeedbackAnalyzer:
    """
    Loads rated messages from the backend and computes quality metrics.

    Requires bi_client for backend access — call load_feedback(token=...) first.
    """

    def __init__(self):
        self._examples: List[RatedExample] = []
        self._loaded = False

    async def load_feedback(self, token: str, max_sessions: int = 100) -> int:
        """
        Fetch recent sessions from the backend and extract rated messages.

        Returns the number of rated examples loaded.
        """
        from app.clients.bi_client import bi_client

        try:
            sessions = await bi_client.list_chat_sessions(token=token)
        except Exception as exc:
            logger.warning("feedback_analyzer: failed to list sessions — %s", exc)
            return 0

        examples: List[RatedExample] = []

        for sess_summary in sessions[:max_sessions]:
            sess_id = sess_summary.get("session_id", "")
            try:
                sess_data = await bi_client.load_chat_session(sess_id, token=token)
                if not sess_data:
                    continue
            except Exception:
                continue

            messages = sess_data.get("messages", [])
            # Pair user questions with assistant answers
            for i, msg in enumerate(messages):
                if msg.get("role") != "assistant":
                    continue
                feedback = msg.get("feedback")
                if not isinstance(feedback, dict) or not feedback.get("rating"):
                    continue

                # Find the preceding user message
                user_question = ""
                for j in range(i - 1, -1, -1):
                    if messages[j].get("role") == "user":
                        user_question = messages[j].get("content", "")
                        break
                if not user_question:
                    continue

                answer = msg.get("content", "")
                if not answer:
                    continue

                metrics = msg.get("metrics") or {}
                examples.append(RatedExample(
                    question=user_question[:500],
                    answer=answer[:1500],
                    rating=feedback["rating"],    # "positive" | "negative"
                    intent=_infer_intent(user_question),
                    tool_calls=metrics.get("tool_calls", []),
                    session_id=sess_id,
                    message_id=msg.get("message_id", ""),
                ))

        self._examples = examples
        self._loaded = True
        logger.info("feedback_analyzer: loaded %d rated examples from %d sessions",
                    len(examples), len(sessions[:max_sessions]))
        return len(examples)

    def get_satisfaction_stats(self) -> List[Dict]:
        """Return satisfaction rate per intent."""
        stats: Dict[str, IntentSatisfaction] = {}
        for ex in self._examples:
            if ex.intent not in stats:
                stats[ex.intent] = IntentSatisfaction(intent=ex.intent)
            s = stats[ex.intent]
            s.total += 1
            if ex.rating == "positive":
                s.positive += 1
            else:
                s.negative += 1
        return [s.to_dict() for s in sorted(stats.values(), key=lambda x: x.intent)]

    def get_best_examples(
        self,
        intent: str = "INSIGHT",
        limit: int = 3,
        min_answer_length: int = 200,
    ) -> List[RatedExample]:
        """
        Return the top-rated Q&A examples for a given intent.
        Used for few-shot injection into system prompts.
        """
        candidates = [
            ex for ex in self._examples
            if ex.rating == "positive"
            and ex.intent == intent
            and len(ex.answer) >= min_answer_length
        ]
        # Prefer longer, more detailed answers (proxy for quality)
        candidates.sort(key=lambda e: len(e.answer), reverse=True)
        return candidates[:limit]

    def get_failure_patterns(self, intent: str = "INSIGHT") -> List[Dict[str, Any]]:
        """
        Identify common patterns in negatively-rated responses.
        Useful for prompt improvement.
        """
        failures = [
            ex for ex in self._examples
            if ex.rating == "negative" and ex.intent == intent
        ]
        # Count which tools were called in failed responses
        tool_freq: Dict[str, int] = {}
        for ex in failures:
            for tool in ex.tool_calls:
                tool_freq[tool] = tool_freq.get(tool, 0) + 1

        return [
            {
                "question_preview": ex.question[:100],
                "answer_preview": ex.answer[:200],
                "tools_used": ex.tool_calls,
            }
            for ex in failures[:10]
        ]


# ─────────────────────────────────────────────────────────────────────────────
# Prompt enrichment
# ─────────────────────────────────────────────────────────────────────────────

def enrich_insight_prompt(base_prompt: str, examples: List[RatedExample]) -> str:
    """
    Inject high-quality few-shot examples into the INSIGHT system prompt.

    Called once per session (not per turn) to avoid re-loading examples repeatedly.
    Falls back to base_prompt unchanged if no examples are available.
    """
    if not examples:
        return base_prompt

    few_shot_block = "\n\nFEW-SHOT EXAMPLES (high-rated responses from real users)\n"
    few_shot_block += "Study these to understand the expected analysis depth and style:\n"

    for i, ex in enumerate(examples, 1):
        few_shot_block += f"\n--- Example {i} ---\n"
        few_shot_block += f"Question: {ex.question}\n"
        few_shot_block += f"Answer:\n{ex.answer}\n"

    few_shot_block += "\n--- End of examples ---\n"
    few_shot_block += "Apply the same depth, structure, and evidence-based approach in your responses.\n"

    return base_prompt + few_shot_block


# ─────────────────────────────────────────────────────────────────────────────
# Module-level singleton + lazy loader
# ─────────────────────────────────────────────────────────────────────────────

# Shared analyzer instance — loaded on first use
_analyzer = FeedbackAnalyzer()


async def get_enriched_insight_prompt(base_prompt: str, token: str) -> str:
    """
    Lazy-load feedback examples and return an enriched INSIGHT prompt.

    Called from run_agent() when intent == INSIGHT.
    Caches results — re-loads only when called explicitly or on process restart.
    """
    if not _analyzer._loaded:
        try:
            await _analyzer.load_feedback(token=token)
        except Exception as exc:
            logger.warning("feedback_analyzer: load failed — %s", exc)
            return base_prompt

    examples = _analyzer.get_best_examples(intent="INSIGHT", limit=2)
    return enrich_insight_prompt(base_prompt, examples)


def get_feedback_analyzer() -> FeedbackAnalyzer:
    """Return the module-level analyzer instance."""
    return _analyzer
