"""The SSE wire format for a flow run. ONE implementation, two surfaces.

Moved out of `api/public.py` when Direct Chat needed the same stream from an
authenticated route. Copying it would have been quicker and would have produced two
formats that agree until the day one of them gains an event — and the client is a
single parser, so the day they disagree is the day the other surface breaks.

The rules this encodes are unchanged from the public bot:

* An unknown type returns None and the frame is SUPPRESSED rather than forwarded.
  `tool_call` is filtered this way on purpose — arguments a model invented are not
  something to show a viewer mid-flight.
* `tool_result` carries ok/error only. The payload can be enormous and is already
  reflected in the answer.
* The tool NAME and the error TEXT are the reader's, not the model's. Both
  surfaces below stream to a person - one of them an anonymous viewer on a public
  link - so `reader_diagnostics` builds them from the registry label and the
  structured `error_code`/`detail`. The technical message that names the tool id,
  the chart id and the raw field keeps going to the author's trace untouched.
* `verification` publishes coverage and unknown LABELS, never the unmatched VALUES:
  echoing an invented figure would show it to the reader a second time.
"""
from __future__ import annotations

from typing import Any

from app.services.agent_flows.reader_diagnostics import (
    reader_error,
    reader_outcome,
    tool_label,
)


def event_to_envelope(ev: Any) -> dict | None:
    """Convert an AgentEvent into the wire envelope.

    Hides internal fields and trims tool_result payloads to keep SSE small.
    """
    et = ev.type
    if et == "text":
        return {"type": "text", "text": ev.text}
    if et == "sources":
        # Web-search sources the answer drew on (title+url) → FE shows links.
        return {"type": "sources", "sources": (ev.extra or {}).get("sources") or []}
    if et == "route":
        # Auto-router decision (which depth was chosen + why). Lets the FE
        # show a read-only "đã chọn chế độ" chip instead of a toggle.
        info = (ev.extra or {}).get("route") or {}
        return {
            "type": "route",
            "mode": info.get("mode"),
            "auto": bool(info.get("auto")),
            "reasons": info.get("reasons") or [],
        }
    if et == "status":
        return {"type": "status", "text": ev.text, "tool": tool_label(ev.tool_name)}
    if et == "tool_result":
        # Send only ok/error so the FE can flag failures without leaking the
        # full payload (which can be large).
        #
        # `outcome` IS THE CLASSIFICATION, and `ok` is only the transport fact.
        # Every reader surface used to count `ok == False` as an error, so a link
        # correctly withholding an out-of-scope chart was reported to a viewer as
        # a failure — "3 errors" printed above a correct answer. The distinction
        # was already made upstream in `error_code`; it died here, one layer
        # before the only consumer that needed it. `ok` stays exactly as it was
        # so nothing that reads it breaks.
        result = ev.tool_result or {}
        return {
            "type": "tool_result",
            "tool": tool_label(ev.tool_name),
            "ok": bool(result.get("ok")),
            "outcome": reader_outcome(result),
            "error": reader_error(result) or None,
        }
    if et == "reading_plan":
        # Phase-15.71 — forward the analyst-style reading plan to the
        # FE. The structured items are safe to send (already validated
        # in tool_emit_reading_plan: chart_id ∈ allowed set, phase
        # whitelisted, question is plain text).
        extra = ev.extra or {}
        return {
            "type": "reading_plan",
            "items": extra.get("items") or [],
            "overall_goal": extra.get("overall_goal"),
        }
    if et == "plan_step":
        # Phase 15.72 — per-step progress badge update. Lets the FE flip
        # each plan step from pending → running → done as the agent
        # works through it.
        extra = ev.extra or {}
        return {
            "type": "plan_step",
            "step_index": extra.get("step_index"),
            "chart_id": extra.get("chart_id"),
            "status": extra.get("status"),
        }
    if et == "insight":
        # Phase 16 — one typed Insight extracted by the exploration engine
        # (rung + statement + evidence chart ids + justification + action).
        # Already sanitized in explorer._parse_insight (chart ids validated
        # against the dashboard, strings capped).
        return {"type": "insight", "insight": (ev.extra or {}).get("insight") or {}}
    if et == "exploration_step":
        # Phase 16 — exploration progress tick (stage + question metadata).
        return {"type": "exploration_step", **(ev.extra or {})}
    if et == "verification":
        # P1-02 — how many of the answer's figures trace back to evidence.
        # Coverage only; the unmatched VALUES stay server-side (they are the
        # model's own invention, and echoing them to the viewer would present
        # unsupported numbers a second time).
        v = (ev.extra or {}).get("verification") or {}
        return {
            "type": "verification",
            "coverage": v.get("coverage"),
            "total_numbers": v.get("total_numbers"),
            "matched": v.get("matched"),
            "checked": bool(v.get("checked")),
            # Entity names the answer used that the run never read. Unlike the
            # unmatched VALUES (which stay server-side — echoing an invented figure
            # shows it to the viewer twice), a name the evidence lacks is safe to
            # surface and is the part a reader can act on.
            "unknown_labels": v.get("unknown_labels") or [],
        }
    if et == "error":
        return {"type": "error", "text": ev.text}
    if et == "state":
        return {"type": "state", "state": (ev.extra or {}).get("state") or {}}
    if et == "cost":
        # Running USD spend for the current question. Sent every round.
        info = (ev.extra or {}).get("cost") or {}
        return {"type": "cost", **info}
    if et == "usage":
        # Per-round token counts (informational; FE may ignore).
        return {"type": "usage", **(ev.extra or {})}
    if et in ("node_started", "node_completed", "branch_taken", "loop_iteration"):
        # Agent Flow lifecycle. The builder's canvas lights up the path a run is
        # actually taking, and the chat shows "đang chạy bước X" instead of a spinner
        # with nothing behind it.
        #
        # `type` is written AFTER the spread on purpose: the payload carries the
        # NODE's type, and spreading it last overwrote the EVENT's type — the wire
        # then announced events called "report_read" and "if", which no client
        # handles.
        return {**(ev.extra or {}), "type": et}
    if et == "result":
        # THE TERMINATOR: the complete `FlowOutput` envelope.
        #
        # Without this branch the whole structured answer — typed blocks, citations,
        # notices, execution path — was built, recorded, and then dropped on the way
        # out, because this function only forwards types it knows and silently
        # returns None for the rest. The bot would have kept rendering the streamed
        # prose and nobody would have seen a block.
        return {"type": "result", "envelope": (ev.extra or {}).get("envelope") or {}}
    if et == "done":
        return {"type": "done"}
    # tool_call (and the explorer-internal _answer) never reach the FE
    return None
