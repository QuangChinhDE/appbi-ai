"""AI summary for Govern knowledge docs — generated on save, hash-gated.

Mirrors the embed_doc pattern: sha256(model + body) is stored in
doc.ai_summary_hash; re-saving an unchanged body costs ZERO LLM calls. The
summary/keywords are user-editable (editing them does NOT retrigger anything);
regenerate is explicit via the API endpoint. Best-effort: never blocks a save.
"""
from __future__ import annotations

import hashlib
import logging

logger = logging.getLogger(__name__)

_MAX_BODY = 9000  # chars fed to the LLM (summaries don't need the long tail)


def _hash(model: str, body: str) -> str:
    return hashlib.sha256(f"{model}\n{body}".encode("utf-8")).hexdigest()


def summarize_change(prev_body: str, new_body: str, *, prev_label: str = "trước") -> str:
    """Draft a 1-2 sentence Vietnamese 'what changed' note. Feeds the LLM ONLY a
    unified DIFF of the two versions (capped) — never the full documents — so it
    stays cheap even for very large docs. Falls back to a size-based blurb when
    no AI key is configured."""
    import difflib

    prev = (prev_body or "").splitlines()
    new = (new_body or "").splitlines()
    diff = [l for l in difflib.unified_diff(prev, new, lineterm="", n=1)
            if l and l[0] in "+-" and not l.startswith(("+++", "---"))]
    if not diff:
        return "Không có thay đổi nội dung so với bản trước."
    added = sum(1 for l in diff if l[0] == "+")
    removed = sum(1 for l in diff if l[0] == "-")
    diff_text = "\n".join(diff)[:4000]  # cap — token-safe for huge docs

    try:
        from app.services.llm_client import LLMClient, _providers  # type: ignore
        if not _providers():
            return f"Cập nhật nội dung: thêm {added} dòng, bớt {removed} dòng so với bản {prev_label}."
        result = LLMClient.complete_json(
            (
                "Đây là DIFF (unified; dòng '+' là thêm, '-' là bớt) giữa bản mới và bản "
                f"{prev_label} của một tài liệu nghiệp vụ:\n\n{diff_text}\n\n"
                "Tóm tắt NGẮN GỌN (1-2 câu tiếng Việt) những gì đã thay đổi, tập trung vào ý nghĩa "
                "nghiệp vụ (không liệt kê từng dòng). Trả JSON: {\"note\": string}."
            ),
            system="Bạn tóm tắt thay đổi tài liệu ngắn gọn, đúng trọng tâm. Luôn trả JSON hợp lệ.",
            max_tokens=200,
        )
        note = (result or {}).get("note") if isinstance(result, dict) else None
        if note:
            return str(note)[:400]
    except Exception:  # noqa: BLE001
        logger.warning("summarize_change failed", exc_info=True)
    return f"Cập nhật nội dung: thêm {added} dòng, bớt {removed} dòng so với bản {prev_label}."


def generate_summary(db, doc, *, force: bool = False) -> str:
    """(Re)generate doc.ai_summary + ai_keywords. Returns a short status string.
    `doc` is a GovernKnowledgeDoc ORM instance already persisted."""
    from app.services.llm_client import LLMClient, _providers  # type: ignore

    try:
        body = (doc.body or "").strip()
        if not body:
            return "empty"
        marker = _hash("ai-summary-v1", body)
        if not force and doc.ai_summary_hash == marker:
            return "unchanged"  # HASH-GATE — no LLM call
        if not _providers():
            return "unavailable"  # no AI key configured; retry on a later save

        result = LLMClient.complete_json(
            (
                "Đây là một tài liệu nghiệp vụ nội bộ (Markdown, có thể chứa thẻ {{...}} — bỏ qua thẻ):\n\n"
                f"{body[:_MAX_BODY]}\n\n"
                "Hãy trả về JSON đúng khoá: {\"summary\": string (3-4 câu tiếng Việt, cô đọng, "
                "nêu tài liệu nói về mảng gì, các chỉ số/quy tắc chính, dùng khi nào), "
                "\"keywords\": [5-8 cụm từ khoá tiếng Việt ngắn]}."
            ),
            system="Bạn là chuyên gia quản trị tri thức doanh nghiệp. Luôn trả về JSON hợp lệ.",
            max_tokens=450,
        )
        if not isinstance(result, dict) or not result.get("summary"):
            return "failed"
        doc.ai_summary = str(result.get("summary"))[:2000]
        kws = result.get("keywords")
        doc.ai_keywords = [str(k)[:60] for k in kws][:10] if isinstance(kws, list) else []
        doc.ai_summary_hash = marker
        db.commit()
        return "generated"
    except Exception:  # noqa: BLE001 — never block a save on AI summary
        logger.warning("govern_ai_summary failed (doc %s)", getattr(doc, "id", None), exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return "error"
