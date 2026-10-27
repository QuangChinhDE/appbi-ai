"""Agent Flow as an OPTIONAL, bounded extension of an AI Chat turn (contract ext.v1).

The Data Core owns the turn and every business number in it. A conversation MAY
have one Agent Flow bound to it (`chat_conversations.extension_flow_key`); this
module decides whether to call it for a turn, runs it under a ceiling, and turns
what it returned into validated SUPPORTING evidence. Nothing a Flow returns is ever
merged into the Core's data answer.

WHEN (deterministic, `decide`) - never because a model guessed

  explicit         the person asked for it on this turn (`extension: "always"`)
  document_need    the question asks about policies, rules, procedures, documents
  core_unsupported the Core found no data question it could answer
  never            no flow bound, `extension: "never"`, the Core is asking a
                   clarification, or the turn already failed/was cancelled

At most ONE invocation per turn; a flow cannot start another chat turn.

UNDER WHAT CEILING (dispatch.run_as_extension, permissions.extension_scope)

  no data reads at all, documents the flow attached ∩ its owner may read ∩ the
  ASKER may read themselves (no delegation), the turn's caps on model calls, tool
  calls and seconds, the reader rollout policy and a usable key re-checked.

WHAT IS ACCEPTED (`accept`)

  documents  document citations inside the ceiling (anything else is dropped, with
             a warning naming what and why)
  findings   the flow's text, kept verbatim (dates and document numbers included),
             ONLY when at least one accepted document backs it; figures in it that
             the Core did not verify are listed as such, never presented as data
  dropped    metric/table/chart blocks: a flow does not publish business figures

A failure, timeout, refusal or cancel leaves the Core's answer exactly as it was,
with a notice saying the extension was not used (Case D).
"""
from __future__ import annotations

import asyncio
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from app.models.chat_conversation import ChatExtensionInvocation

VERSION = "ext.v1"
MODES = ("auto", "always", "never")

#: Folded (no tone marks, lower case) phrases that ask for documents, not data.
_DOCUMENT_NEED = (
    "chinh sach", "quy dinh", "quy trinh", "quy che", "noi quy", "tai lieu", "huong dan", "cam nang",
    "hop dong", "dieu khoan", "sop", "policy", "policies", "procedure", "guideline", "handbook",
    "document", "contract", "regulation", "terms and conditions",
)


def _fold(text: str) -> str:
    from app.services.data_core.grounding import fold

    return " " + " ".join(re.split(r"[^0-9a-z]+", fold(text or ""))) + " "


def needs_documents(question: str) -> bool:
    q = _fold(question)
    return any(f" {p} " in q for p in _DOCUMENT_NEED)


def decide(question: str, mode: str, flow_key: Optional[str], core_env: dict) -> Optional[str]:
    """Why to invoke the bound flow for this turn, or None."""
    if not flow_key or mode == "never":
        return None
    status = core_env.get("status")
    if status in ("cancelled", "clarification_required"):
        return None
    if mode == "always":
        return "explicit"
    if status == "failed":
        return None
    if needs_documents(question):
        return "document_need"
    if status == "refused" and core_env.get("code") == "unsupported":
        return "core_unsupported"
    return None


# ── what a flow returned, validated ───────────────────────────────────────────

_FIGURE = re.compile(r"(?<![\w.])(-?\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?\s?%|-?\d{4,}(?:[.,]\d+)?)(?![\w])")


def _as_number(token: str) -> Optional[float]:
    t = token.replace("%", "").replace(" ", "").strip()
    if "," in t and "." in t:
        t = t.replace(".", "").replace(",", ".") if t.rfind(",") > t.rfind(".") else t.replace(",", "")
    elif t.count(",") >= 1 and len(t.split(",")[-1]) == 3:
        t = t.replace(",", "")
    elif t.count(".") > 1 or (t.count(".") == 1 and len(t.split(".")[-1]) == 3 and len(t) > 4):
        t = t.replace(".", "")
    else:
        t = t.replace(",", ".")
    try:
        return float(t)
    except ValueError:
        return None


def unverified_figures(text: str, verified: set[float]) -> list[str]:
    """Figures in a flow's text that are not among the Core's verified numbers.
    Plain years (1900-2100) are not figures. Kept as written; the text is not edited."""
    out = []
    for m in _FIGURE.finditer(text or ""):
        token = m.group(0).strip()
        n = _as_number(token)
        if n is None or (float(n).is_integer() and 1900 <= n <= 2100 and "%" not in token and len(token) == 4):
            continue
        if any(abs(n - v) <= max(1e-9, abs(v) * 1e-6) for v in verified):
            continue
        if token not in out:
            out.append(token)
    return out[:10]


def verified_numbers(core_env: dict) -> set[float]:
    data = core_env.get("data") if isinstance(core_env.get("data"), dict) else {}
    out: set[float] = set()
    for r in data.get("rows") or []:
        if isinstance(r, dict):
            out.update(float(v) for v in r.values() if isinstance(v, (int, float)) and not isinstance(v, bool))
    return out


def accept(out: dict, *, allowed_doc_ids: set[int], verified: set[float]) -> tuple[list, list, list]:
    """(documents, findings, warnings) from a FlowOutput reader dict."""
    warnings: list[dict] = []
    documents: list[dict] = []
    seen: set[int] = set()
    for c in out.get("citations") or []:
        if not isinstance(c, dict):
            continue
        kind, ref = c.get("kind"), str(c.get("ref") or "")
        if kind != "document":
            warnings.append({"code": "citation_not_a_document", "kind": kind})
            continue
        if not ref.isdigit() or int(ref) not in allowed_doc_ids:
            warnings.append({"code": "citation_out_of_scope"})
            continue
        if int(ref) in seen:
            continue
        seen.add(int(ref))
        documents.append({"doc_id": int(ref), "title": str(c.get("label") or "")[:300],
                          "quote": str(c.get("quote") or "")[:1200], "version": c.get("version"),
                          "used": [str(u)[:200] for u in (c.get("used") or [])][:5]})
    texts: list[str] = []
    dropped = 0
    for b in ((out.get("answer") or {}).get("blocks") or []):
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text" and str(b.get("markdown") or "").strip():
            texts.append(str(b["markdown"]).strip())
        elif b.get("type") == "callout" and str(b.get("text") or "").strip():
            texts.append(str(b["text"]).strip())
        elif b.get("type") in ("metric", "table", "chart_ref"):
            dropped += 1
    if dropped:
        warnings.append({"code": "flow_figures_dropped", "count": dropped})
    findings: list[dict] = []
    text = "\n\n".join(texts).strip()[:6000]
    if text:
        if documents:
            findings.append({"text": text, "unverified_figures": unverified_figures(text, verified)})
        else:
            warnings.append({"code": "finding_without_source"})
    return documents, findings, warnings


_NOTICE_TEXT = {
    "extension_unavailable": ("Không dùng được luồng hỗ trợ “{name}” cho câu hỏi này ({why}). Câu trả lời chỉ dựa "
                              "trên dữ liệu bạn được phép khai thác."),
    "sources_separate": ("Số liệu và tài liệu được trình bày riêng. Hệ thống không tự suy ra quan hệ nhân quả giữa "
                         "chúng; nếu hai nguồn khác nhau, hãy đối chiếu cả hai."),
}

_WHY = {
    "timeout": "quá thời gian cho phép", "cancelled": "đã dừng", "failed": "luồng gặp lỗi",
    "not_published": "luồng không còn được chia sẻ hoặc chưa phát hành",
    "direct_chat_disabled": "luồng không dùng được trong AI Chat",
    "direct_chat_ineligible": "phiên bản mới của luồng cần một báo cáo",
    "missing_credential": "luồng chưa có AI key", "reader_mode_off": "luồng đang tạm tắt",
    "pilot_not_enrolled": "luồng chưa mở cho tài khoản này", "no_evidence": "luồng không tìm được tài liệu phù hợp",
    "invalid_output": "luồng trả kết quả không hợp lệ",
}


def _notice(code: str, **kw) -> dict:
    return {"code": code, "text": _NOTICE_TEXT[code].format(**kw)}


# ── the invocation ───────────────────────────────────────────────────────────

async def invoke(db: Session, *, user: Any, conversation_id: int, turn_id: str, flow_key: str, reason: str,
                 question: str, core_env: dict, is_cancelled: Callable[[], bool]) -> tuple[dict, list[dict]]:
    """Run the bound flow once, under the ceiling; return (supporting, notices)."""
    from app.core.config import settings
    from app.services.agent_flows import direct_chat
    from app.services.agent_flows.dispatch import run_as_extension
    from app.services.agent_flows.permissions import extension_scope

    invocation_id = uuid.uuid4().hex
    row, flow, problem = direct_chat.resolve_for_chat(db, user, flow_key)
    name = (getattr(row, "name", None) or flow_key) if row is not None else flow_key
    ceiling = extension_scope(db, row, flow, user) if (row is not None and flow is not None) else \
        {"doc_ids": [], "dataset_ids": [], "metric_names": []}
    rec = ChatExtensionInvocation(invocation_id=invocation_id, turn_id=turn_id, conversation_id=conversation_id,
                                  flow_key=flow_key, flow_version=getattr(row, "version", None), reason=reason,
                                  status="running", ceiling={"doc_ids": ceiling["doc_ids"], "dataset_ids": [],
                                                             "data_reads": "forbidden"})
    db.add(rec)
    db.commit()

    timeout = max(1, int(settings.AI_CHAT_EXTENSION_TIMEOUT_SECONDS))
    status, code, out = "failed", None, None
    started = time.monotonic()
    data = core_env.get("data") if isinstance(core_env.get("data"), dict) else {}
    note = str(((data.get("answer") or {}).get("headline")) or core_env.get("message") or "")[:600]
    gen = run_as_extension(db, user=user, flow_key=flow_key, question=question,
                           context_note=("Lõi dữ liệu đã trả lời: " + note) if note else "",
                           run_id=f"ext_{invocation_id}",
                           max_llm_calls=int(settings.AI_CHAT_EXTENSION_MAX_LLM_CALLS),
                           max_tool_calls=int(settings.AI_CHAT_EXTENSION_MAX_TOOL_CALLS),
                           max_seconds=timeout)
    pending: Optional[asyncio.Future] = None
    try:
        while True:
            if is_cancelled():
                status = code = "cancelled"
                break
            if time.monotonic() - started > timeout:
                status = code = "timeout"
                break
            if pending is None:
                pending = asyncio.ensure_future(gen.__anext__())
            finished, _ = await asyncio.wait({pending}, timeout=1.0)
            if not finished:
                continue
            try:
                ev = pending.result()
            except StopAsyncIteration:
                pending = None
                break
            pending = None
            if getattr(ev, "type", None) == "result":
                out = (ev.extra or {}).get("envelope") or {}
    except Exception:  # noqa: BLE001 - the Core's answer stands; the reason is recorded
        status, code = "failed", "failed"
        out = None
    finally:
        if pending is not None:
            pending.cancel()
        try:
            await gen.aclose()
        except Exception:  # noqa: BLE001
            pass

    documents: list = []
    findings: list = []
    warnings: list = []
    if out is not None and not isinstance(out, dict) and status not in ("cancelled", "timeout"):
        status, code, warnings, out = "failed", "invalid_output", [{"code": "invalid_output"}], None
    if out is not None and status not in ("cancelled", "timeout"):
        run_status = out.get("status")
        if run_status == "blocked":
            status = "unavailable"
            code = next((n.get("code") for n in out.get("notices") or [] if isinstance(n, dict)), None) or \
                (problem or "not_published")
        else:
            try:
                documents, findings, warnings = accept(out, allowed_doc_ids=set(ceiling["doc_ids"]),
                                                      verified=verified_numbers(core_env))
                status = "ok" if run_status in ("ok", "partial") else "failed"
                code = None if status == "ok" else "failed"
            except Exception:  # noqa: BLE001 - a malformed result is the flow's failure, not the turn's
                documents, findings, warnings = [], [], [{"code": "invalid_output"}]
                status, code = "failed", "invalid_output"
            if status == "ok" and not (documents or findings):
                code = "no_evidence"
    usage = (out or {}).get("usage") or {}
    rec.status, rec.code = status, code
    rec.run_key = f"ext_{invocation_id}"
    rec.results = {"documents": documents, "findings": findings}
    rec.warnings = warnings
    rec.usage = usage if isinstance(usage, dict) else {}
    rec.completed_at = datetime.now(timezone.utc)
    db.commit()

    supporting = {"v": VERSION, "invocation_id": invocation_id, "flow_key": flow_key, "flow_name": name,
                  "reason": reason, "status": status, "code": code, "documents": documents, "findings": findings,
                  "warnings": warnings}
    notices: list[dict] = []
    if status != "ok" or code == "no_evidence":
        notices.append(_notice("extension_unavailable", name=name, why=_WHY.get(code or status, code or status)))
    elif documents and core_env.get("status") == "answered":
        notices.append(_notice("sources_separate"))
    return supporting, notices
