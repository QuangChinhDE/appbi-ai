"""Describing a picture, when — and only when — the document permits it.

WHY THIS IS GATED HARDER THAN EMBEDDING
---------------------------------------
Embedding sends a passage of text. Describing a figure sends the PICTURE, and a
picture in a BI document is very often the most sensitive artifact in it: a
revenue chart with the axis labelled, a screenshot of a customer record, an org
chart with names. Text can be reviewed by the author before publishing; an image
carries whatever was in frame.

So this requires `external_processing = 'full'`, the same level as cloud OCR, and
never runs on the default policy. A document whose owner has not made that choice
keeps its figures as structure with no description — which is a worse index and
an honest one.

WHY IT LIVES IN THE AST BUILD
-----------------------------
A description is an extraction result, not a chunking decision. Putting it in the
AST means:

  * it runs once per source change, not once per re-chunk — the same reason OCR
    moved there, and the whole point of the two-gate design
  * changing the chunk size does not re-pay for vision
  * the description is stored on the BLOCK, so a citation points at the figure
    rather than at a chunk that may not exist after the next re-index

The document's POLICY is part of the AST fingerprint (see govern_doc_ast). That
is not incidental: the tree genuinely differs depending on whether describing was
allowed, so flipping the policy to 'full' rebuilds and describes, and flipping it
back rebuilds without descriptions. A permission change that leaves stale derived
data behind is a permission change that did not take effect.

WHAT IT REFUSES TO GUESS
------------------------
The prompt asks for what the figure SHOWS, in the document's language, and
explicitly forbids inventing numbers that are not legible. A hallucinated axis
value indexed as document content is worse than no description at all — it is a
false fact with a citation attached.
"""
from __future__ import annotations

import base64
import io
import json
import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings

logger = logging.getLogger(__name__)

#: The vision model. Small on purpose: this is a caption, not an analysis, and a
#: corpus can hold hundreds of figures.
VISION_MODEL = "gpt-4o-mini"

#: Never describe more than this many figures in one AST build. A 200-image deck
#: would otherwise turn one save into a several-minute, several-dollar operation
#: with no way to see it coming. The remainder are described on the next build,
#: and the count is reported.
MAX_FIGURES_PER_RUN = 24

#: Cap on the description. A caption's job is to make the figure findable, and a
#: paragraph of prose about one chart out-weighs the real prose around it.
MAX_DESCRIPTION_CHARS = 400

#: Rendering resolution for a PDF figure region, in DPI-equivalent scale. 2.0 is
#: enough to read an axis label without sending a megabyte per image.
_RENDER_SCALE = 2.0

_PROMPT = (
    "Mô tả NGẮN GỌN nội dung của hình này để người khác tìm lại được nó, bằng "
    "ngôn ngữ của tài liệu (tiếng Việt nếu tài liệu là tiếng Việt).\n"
    "- Nếu là biểu đồ: nói rõ loại biểu đồ, trục/chiều, và chỉ số được thể hiện.\n"
    "- Nếu là ảnh chụp giao diện: nói rõ đang ở màn hình nào, thao tác gì.\n"
    "- Nếu là sơ đồ: nói rõ các bước hoặc các thành phần và quan hệ.\n"
    "TUYỆT ĐỐI KHÔNG suy đoán con số không đọc được rõ trong hình. "
    "Nếu không đọc được nội dung, trả về đúng chữ: KHÔNG RÕ.\n"
    "Trả về 1-3 câu, không mở đầu, không markdown."
)


def vision_available() -> bool:
    """Is there a provider to call at all?

    Checked separately from the policy so a report can distinguish "not allowed"
    from "not configured" — they need different fixes.
    """
    return bool((getattr(settings, "OPENAI_API_KEY", "") or "").strip())


def _describe_image(*, url: str | None = None, data_url: str | None = None) -> str | None:
    """One vision call. Returns None on any failure, never raises."""
    api_key = (getattr(settings, "OPENAI_API_KEY", "") or "").strip()
    if not api_key or not (url or data_url):
        return None
    try:
        import httpx

        response = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": "Bearer %s" % api_key,
                     "Content-Type": "application/json"},
            json={
                "model": VISION_MODEL,
                "max_tokens": 300,
                "temperature": 0,
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _PROMPT},
                        {"type": "image_url",
                         "image_url": {"url": data_url or url, "detail": "low"}},
                    ],
                }],
            },
            timeout=60.0,
        )
        if response.status_code != 200:
            logger.warning("figure_vision: provider returned %s", response.status_code)
            return None
        content = (response.json()["choices"][0]["message"]["content"] or "").strip()
    except Exception:  # noqa: BLE001 — a description is an enhancement
        logger.warning("figure_vision: vision call failed", exc_info=True)
        return None

    if not content or content.upper().startswith("KHÔNG RÕ"):
        # The model saying it cannot read the image is a RESULT, not a failure:
        # recording it as a description would index the words "không rõ".
        return None
    return content[:MAX_DESCRIPTION_CHARS]


def _pdf_region_data_url(pdf_bytes: bytes, page_number: int, bbox) -> str | None:
    """A figure's rectangle from the stored PDF, as a base64 PNG.

    The layout pass recorded WHERE the picture is; the bytes are still in
    `govern_doc_source_files`. Cropping locally means the provider receives the
    figure and not the whole page — less egress, and a description about the right
    thing.
    """
    try:
        import pypdfium2 as pdfium

        document = pdfium.PdfDocument(pdf_bytes)
        page = document[int(page_number) - 1]
        image = page.render(scale=_RENDER_SCALE).to_pil()
        width, height = image.size
        x0, y0, x1, y1 = (float(v) for v in bbox)
        # PDF coordinates are bottom-left origin; PIL is top-left.
        page_height = page.get_height() or 1.0
        page_width = page.get_width() or 1.0
        left = max(0, int(x0 / page_width * width))
        right = min(width, int(x1 / page_width * width))
        top = max(0, int((page_height - y1) / page_height * height))
        bottom = min(height, int((page_height - y0) / page_height * height))
        if right - left < 24 or bottom - top < 24:
            return None
        crop = image.crop((left, top, right, bottom))
        buffer = io.BytesIO()
        crop.save(buffer, format="PNG", optimize=True)
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    except Exception:  # noqa: BLE001
        logger.warning("figure_vision: PDF region render failed", exc_info=True)
        return None


def describe_figures(db: Session, doc, blocks: list[dict]) -> dict:
    """Fill in `text` for figures that have none, in place.

    Called from the AST build with the blocks about to be persisted, so the
    descriptions are stored as part of the tree rather than bolted on afterwards.

    Returns `{eligible, described, skipped, reason}`. `reason` is always populated
    when nothing was described, because "0 figures described" has four completely
    different causes — no figures, policy, no provider, provider failure — and a
    report that cannot tell them apart sends someone to read this file.
    """
    from app.services.dashboard_ai_bot.govern_doc_embeddings import (
        egress_allowed, log_egress, processing_policy,
    )

    pending = [b for b in blocks
               if b.get("kind") == "figure" and not str(b.get("text") or "").strip()]
    if not pending:
        return {"eligible": 0, "described": 0, "skipped": 0, "reason": "no_figures_without_text"}

    if not egress_allowed(doc, "vision"):
        return {"eligible": len(pending), "described": 0, "skipped": len(pending),
                "reason": "policy_%s" % processing_policy(doc)}
    if not vision_available():
        return {"eligible": len(pending), "described": 0, "skipped": len(pending),
                "reason": "no_provider"}

    pdf_bytes: bytes | None = None
    if any(b.get("bbox") and b.get("page") for b in pending):
        try:
            row = db.execute(
                text("SELECT data FROM govern_doc_source_files WHERE doc_id = :d"),
                {"d": doc.id},
            ).first()
            pdf_bytes = bytes(row[0]) if row and row[0] else None
        except Exception:  # noqa: BLE001
            pdf_bytes = None

    described = 0
    chars = 0
    for block in pending[:MAX_FIGURES_PER_RUN]:
        meta = dict(block.get("meta") or {})
        bbox = block.get("bbox") or meta.get("bbox")
        description = None

        if pdf_bytes and bbox and block.get("page"):
            data_url = _pdf_region_data_url(pdf_bytes, block["page"], _as_bbox(bbox))
            if data_url:
                description = _describe_image(data_url=data_url)
        if description is None:
            src = str(meta.get("src") or "")
            if src.startswith("http"):
                description = _describe_image(url=src)

        if not description:
            continue
        meta["vision_description"] = description
        meta["vision_model"] = VISION_MODEL
        block["meta"] = meta
        block["text"] = description
        described += 1
        chars += len(description)

    skipped = len(pending) - described
    if described:
        log_egress(db, doc, outcome="ok", model=VISION_MODEL, purpose="vision",
                   chunks=described, chars=chars)
    return {
        "eligible": len(pending), "described": described, "skipped": skipped,
        "reason": ("ok" if described else "provider_returned_nothing"),
        "capped": len(pending) > MAX_FIGURES_PER_RUN,
    }


def _as_bbox(value):
    """A bbox from JSONB, a tuple, or a JSON string — as four floats."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:  # noqa: BLE001
            return (0.0, 0.0, 0.0, 0.0)
    if isinstance(value, dict):
        value = [value.get("x0"), value.get("y0"), value.get("x1"), value.get("y1")]
    try:
        return tuple(float(v or 0.0) for v in list(value)[:4])
    except Exception:  # noqa: BLE001
        return (0.0, 0.0, 0.0, 0.0)
