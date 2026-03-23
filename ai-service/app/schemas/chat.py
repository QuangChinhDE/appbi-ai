"""
Pydantic schemas for the AI Chat service.
"""
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional, Literal
from datetime import datetime


# ── Inbound ────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    session_id: Optional[str] = None
    message: str = Field(..., min_length=1, max_length=4000)
    context: Optional[Dict[str, Any]] = None   # {workspace_id, chart_ids, ...}


# ── Outbound streaming events ──────────────────────────────────────────────────

class ThinkingEvent(BaseModel):
    type: Literal["thinking"] = "thinking"
    content: str


class ToolCallEvent(BaseModel):
    type: Literal["tool_call"] = "tool_call"
    tool: str
    args: Dict[str, Any] = {}


class ToolResultEvent(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    tool: str
    summary: str                  # short human-readable summary
    data: Optional[Any] = None    # full result (only if small)


class TextEvent(BaseModel):
    type: Literal["text"] = "text"
    content: str


class ChartEvent(BaseModel):
    type: Literal["chart"] = "chart"
    chart_id: int
    chart_name: str
    chart_type: str
    data: List[Dict[str, Any]]
    role_config: Optional[Dict[str, Any]] = None  # explore roleConfig for rendering


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    content: str


class DoneEvent(BaseModel):
    type: Literal["done"] = "done"
    session_id: str


class MetricsEvent(BaseModel):
    type: Literal["metrics"] = "metrics"
    message_id: str
    latency_ms: int
    model: str
    provider: str
    tool_calls: List[str] = []         # tool names called in order
    tool_call_count: int = 0
    tool_errors: int = 0
    has_chart: bool = False
    has_data_backing: bool = False      # answer backed by tool data
    data_rows_analyzed: int = 0         # total rows from tool results
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None


class SuggestionsEvent(BaseModel):
    type: Literal["suggestions"] = "suggestions"
    suggestions: List[str]             # 2-3 clickable follow-up questions


# ── User feedback ──────────────────────────────────────────────────────────────

class FeedbackRequest(BaseModel):
    rating: Literal["up", "down"]
    comment: Optional[str] = Field(None, max_length=500)


# ── Conversation memory ────────────────────────────────────────────────────────

class Message(BaseModel):
    role: str                     # "user" | "assistant" | "tool"
    content: Any
    message_id: Optional[str] = None  # unique ID for this message (assistant only)
    tool_call_id: Optional[str] = None
    name: Optional[str] = None   # tool name (for tool messages)
    tool_calls: Optional[List[Dict[str, Any]]] = None  # assistant tool_calls (OpenAI format)
    metrics: Optional[Dict[str, Any]] = None   # quality metrics (assistant only)
    feedback: Optional[Dict[str, Any]] = None  # user feedback {rating, comment}
    charts: Optional[List[Dict[str, Any]]] = None  # chart events emitted for this message
    extra: Optional[Dict[str, Any]] = None     # misc per-message metadata (e.g. user_query for correction)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ConversationSession(BaseModel):
    session_id: str
    owner_user_id: str = ""    # user sub from JWT — used for ownership checks
    title: str = "New Conversation"
    messages: List[Message] = []
    context: Dict[str, Any] = {}
    db_context: str = ""   # Schema injected once per session
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_active: datetime = Field(default_factory=datetime.utcnow)


class SessionSummary(BaseModel):
    session_id: str
    title: str
    created_at: datetime
    last_active: datetime
    message_count: int
    last_message: Optional[str] = None
