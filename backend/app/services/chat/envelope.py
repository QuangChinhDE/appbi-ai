"""The ONE answer envelope of an AI Chat turn (`chat.v1`).

Every turn ends in exactly one of five terminal states, and the reader is sent this
envelope and nothing else, whatever ran:

  answered               the Data Core answered from governed data, and/or a Flow
                         extension supplied document evidence for a question that
                         is not a data question
  clarification_required the Core needs a choice (metric, source, filter value)
  refused                the question cannot be answered within the asker's rights,
                         budget or the data (`code` says which)
  failed                 something broke (`code`: model_unavailable, internal_error,
                         interrupted, verification_failed)
  cancelled              the asker stopped it

SECTIONS, NOT A FREE-FORM BLOCK LIST

  data        the Data Core's response, unchanged (answer, columns, rows, evidence,
              chart draft, plan, clarification options). The ONLY place business
              numbers come from.
  supporting  what an Agent Flow extension returned, validated (services/chat/
              extension.py): documents it cited, findings in its own words, and the
              figures it mentioned that the Core did not verify. Never merged into
              `data`, and a conflict between the two is shown, not resolved.
  legacy      an imported pre-unification turn, as it was (read-only).

`stored()` is what is persisted and shown to other readers: no capability tokens,
rows capped. `live()` is the asker's own copy (their tokens are bound to them).
"""
from __future__ import annotations

import copy
from typing import Any, Optional

VERSION = "chat.v1"

_CORE_TO_CHAT = {"answered": "answered", "clarify": "clarification_required", "refused": "refused",
                 "unsupported": "refused"}


def from_core(core: dict) -> dict:
    """The envelope for a Data Core response (before any extension)."""
    status = str(core.get("status") or "unsupported")
    code = core.get("code")
    if status == "unsupported":
        code = core.get("code") or "unsupported"
    out_status = _CORE_TO_CHAT.get(status, "failed")
    if code == "model_unavailable":
        out_status = "failed"
    return {"v": VERSION, "status": out_status, "code": code if out_status != "answered" else None,
            "message": core.get("message") if out_status != "answered" else None,
            "data": core, "supporting": None, "notices": []}


def failed(code: str, message: str) -> dict:
    return {"v": VERSION, "status": "failed", "code": code, "message": message, "data": None, "supporting": None,
            "notices": []}


def cancelled() -> dict:
    return {"v": VERSION, "status": "cancelled", "code": "cancelled_by_user",
            "message": "Bạn đã dừng câu hỏi này.", "data": None, "supporting": None, "notices": []}


def refused(code: str, message: str) -> dict:
    return {"v": VERSION, "status": "refused", "code": code, "message": message, "data": None, "supporting": None,
            "notices": []}


def with_supporting(env: dict, supporting: Optional[dict], notices: list[dict]) -> dict:
    """Attach an extension's validated result. A Core that could not answer a
    question that is not about data, plus document evidence, is an answer FROM
    DOCUMENTS (no numbers): the status becomes `answered` with `data` left as the
    Core's refusal so the reader sees both."""
    out = {**env, "supporting": supporting, "notices": [*env.get("notices", []), *notices]}
    has_docs = bool(supporting and (supporting.get("documents") or supporting.get("findings")))
    if has_docs and env["status"] == "refused" and env.get("code") in ("unsupported", None):
        out["status"] = "answered"
        out["code"] = "documents_only"
    return out


def with_analysis(env: dict, analysis: dict) -> dict:
    """A Core that could not plan the question, answered by the public bot's guided
    analysis of the PUBLISHED charts (answer_core/guided_analysis.py): `answered`
    with code `ai_analysis`, the analysis beside the Core's own data - never in place
    of a Core figure, and labelled as AI analysis by every reader. Beside an answered
    Core (an evaluation of its figure) the Core's status and code stay as they are."""
    data = dict(env.get("data") or {})
    data["analysis"] = analysis
    if env.get("status") == "answered":
        return {**env, "data": data}
    return {**env, "status": "answered", "code": "ai_analysis", "message": None, "data": data}


def with_definition(definition: dict) -> dict:
    """A term the publisher's guide defines, answered with that definition verbatim
    (public bot, `answer_core/publisher_guide.py`): no data read, no model call."""
    return {"v": VERSION, "status": "answered", "code": "guide_definition", "message": None,
            "data": {"definition": definition}, "supporting": None, "notices": []}


def with_target(env: dict, target: dict) -> dict:
    """The publisher's target beside the Core's one total, computed by code."""
    data = dict(env.get("data") or {})
    data["target"] = target
    return {**env, "data": data}


def stored(env: dict, max_rows: int) -> dict:
    """What is persisted: the envelope minus capabilities, rows capped."""
    e = copy.deepcopy(env)
    data = e.get("data")
    if isinstance(data, dict):
        for k in ("choices", "sources"):
            for o in data.get(k) or []:
                if isinstance(o, dict):
                    o.pop("token", None)
        data.pop("consent_available", None)
        if isinstance(data.get("rows"), list) and len(data["rows"]) > max_rows:
            data["rows"] = data["rows"][:max_rows]
            data["truncated"] = True
    return e


def normalize(raw: Any, status: str) -> dict:
    """Any stored envelope, imported ones included, as `chat.v1`."""
    raw = raw if isinstance(raw, dict) else {}
    v = raw.get("v")
    if v == VERSION:
        return raw
    if v == "analyst_v1":
        core = raw.get("response") if isinstance(raw.get("response"), dict) else {}
        env = from_core(core) if core else failed("legacy_empty", "")
        env["status"] = status
        env["legacy"] = {"origin": "analyst_v1"}
        return env
    if v == "flow_v0":
        from app.services.agent_flows.envelope import reader_notice_dict

        pruned = bool(raw.get("content_pruned"))
        return {"v": VERSION, "status": status, "code": raw.get("blocked_reason") if status != "answered" else None,
                "message": None, "data": None, "supporting": None, "notices": [],
                "legacy": {"origin": "flow_v0", "answer": raw.get("answer") or "",
                           "citations": [c for c in raw.get("citations") or [] if isinstance(c, dict)],
                           # replayed to a READER, including turns recorded before the
                           # audience boundary existed: filtered and scrubbed here
                           "notices": [reader_notice_dict(n) for n in raw.get("notices") or []
                                       if isinstance(n, dict) and n.get("audience", "reader") != "author"],
                           "content_pruned": pruned}}
    return {"v": VERSION, "status": status, "code": None, "message": None, "data": None, "supporting": None,
            "notices": []}
