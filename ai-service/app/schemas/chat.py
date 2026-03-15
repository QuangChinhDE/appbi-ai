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


# ── Conversation memory ────────────────────────────────────────────────────────

class Message(BaseModel):
    role: str                     # "user" | "assistant" | "tool"
    content: Any
    tool_call_id: Optional[str] = None
    name: Optional[str] = None   # tool name (for tool messages)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ConversationSession(BaseModel):
    session_id: str
    messages: List[Message] = []
    context: Dict[str, Any] = {}
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_active: datetime = Field(default_factory=datetime.utcnow)
