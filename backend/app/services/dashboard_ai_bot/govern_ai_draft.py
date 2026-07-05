"""AI-drafted Govern documents.

Given a dataset, gather its real model (tables + column types), a small data
sample, defined measures and existing governed metrics, then ask the LLM (via
the OpenAI→Gemini→Anthropic fallback client) to WRITE a structured business
knowledge document in Vietnamese. The draft is returned unsaved — the user
reviews/edits/notes before saving. Grounded (reads real schema+data), best-effort.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def _columns(columns_cache: Any) -> list[dict]:
    if not columns_cache:
        return []
    cols = columns_cache.get("columns", []) if isinstance(columns_cache, dict) else columns_cache
    out = []
    for c in cols or []:
        if isinstance(c, dict):
            out.append({"name": c.get("name"), "type": c.get("type") or c.get("dtype") or ""})
        elif c:
            out.append({"name": str(c), "type": ""})
    return out


def _gather_context(db: Session, dataset_id: int, dashboard_id: Optional[int]) -> tuple[str, Any]:
    from app.models.dataset import Dataset, DatasetTable

    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if ds is None:
        return "", None
    tables = db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all()

    lines: list[str] = [f"DATASET: {ds.name} (id={ds.id})"]
    if getattr(ds, "description", None):
        lines.append(f"Mô tả dataset: {str(ds.description)[:400]}")
    lines.append(f"Số bảng: {len(tables)}")

    for t in tables[:12]:
        cols = _columns(t.columns_cache)
        col_str = ", ".join(f"{c['name']}:{c['type']}" for c in cols[:30] if c.get("name"))
        lines.append(f"\n▸ Bảng '{t.display_name}' [{t.source_table_name or t.source_kind or ''}] — cột: {col_str}")
        if t.auto_description:
            lines.append(f"  (mô tả: {str(t.auto_description)[:200]})")
        if isinstance(t.column_descriptions, dict) and t.column_descriptions:
            for col, desc in list(t.column_descriptions.items())[:6]:
                lines.append(f"  · {col}: {str(desc)[:120]}")
        rows = t.sample_cache if isinstance(t.sample_cache, list) else []
        for r in rows[:2]:
            try:
                lines.append(f"  mẫu: {json.dumps(r, ensure_ascii=False)[:280]}")
            except Exception:  # noqa: BLE001
                pass

    # Defined measures (semantic layer)
    try:
        from app.services.dashboard_ai_bot.knowledge_context import _semantic_fields
        measures = _semantic_fields(db, {dataset_id})
        if measures:
            lines.append("\nĐO LƯỜNG (measures) đã định nghĩa:")
            for m in measures[:25]:
                lines.append(f"  - [{m.get('kind')}] {m.get('label')}: {m.get('description') or ''}")
    except Exception:  # noqa: BLE001
        pass

    # Existing governed metrics bound to this dataset
    try:
        from app.models.governance import GovernMetric
        gms = db.query(GovernMetric).filter(GovernMetric.dataset_id == dataset_id).all()
        if gms:
            lines.append("\nCHỈ SỐ QUẢN TRỊ đã khai báo (đừng định nghĩa lại, có thể tham chiếu):")
            for m in gms[:20]:
                lines.append(f"  - {m.display_name}: {m.definition or ''}")
    except Exception:  # noqa: BLE001
        pass

    return "\n".join(lines)[:8000], ds


_SYSTEM = (
    "Bạn là chuyên gia Phân tích Kinh doanh (BA) kiêm Data Analyst. Bạn viết tài liệu nghiệp vụ "
    "TIẾNG VIỆT, rõ ràng, có cấu trúc, dựa TRÊN dữ liệu thật được cung cấp — KHÔNG bịa số liệu. "
    "Luôn trả về JSON hợp lệ."
)


def draft_document(db: Session, dataset_id: int, dashboard_id: Optional[int] = None) -> Optional[dict]:
    """Return {title, summary, body, tags} drafted by the LLM, or None if AI unavailable."""
    from app.services.llm_client import LLMClient

    context, ds = _gather_context(db, dataset_id, dashboard_id)
    if ds is None:
        return None

    dash_hint = f" và báo cáo {{{{dashboard:{dashboard_id}}}}}" if dashboard_id else ""
    prompt = (
        "Dưới đây là MÔ HÌNH DỮ LIỆU THẬT của một dataset (các bảng, kiểu cột, vài dòng mẫu, "
        "đo lường và chỉ số đã khai báo). Hãy PHÂN TÍCH và VIẾT một tài liệu nghiệp vụ hoàn chỉnh "
        "mô tả mảng kinh doanh mà dataset này phản ánh.\n\n"
        f"{context}\n\n"
        "YÊU CẦU tài liệu (body dạng Markdown, DÀI, có tiêu đề ##):\n"
        "1. Bối cảnh kinh doanh (dataset này nói về hoạt động gì, suy luận từ tên bảng/cột).\n"
        "2. Mô hình dữ liệu (các bảng chính & vai trò, quan hệ suy ra được).\n"
        "3. Các chỉ số nên theo dõi — mỗi chỉ số kèm ý nghĩa + gợi ý cách tính (dựa trên cột thật).\n"
        "4. Cách đọc / phân tích.\n"
        "5. Lưu ý & cảnh báo khi dùng số liệu.\n"
        f"Chèn thẻ {{{{dataset:{dataset_id}}}}}{dash_hint} vào chỗ phù hợp trong body.\n\n"
        "Trả về JSON đúng khoá: {\"title\": string, \"summary\": string (1 câu), "
        "\"body\": string (Markdown), \"tags\": [string,...]}."
    )
    result = LLMClient.complete_json(prompt, system=_SYSTEM, max_tokens=2800)
    if not isinstance(result, dict) or not result.get("body"):
        return None

    body = str(result.get("body") or "")
    # ensure the dataset token is present so the doc links to its source
    if f"{{{{dataset:{dataset_id}}}}}" not in body:
        body += f"\n\n---\nNguồn dữ liệu: {{{{dataset:{dataset_id}}}}}"
    tags = result.get("tags")
    if not isinstance(tags, list):
        tags = []
    return {
        "title": str(result.get("title") or f"Tài liệu: {ds.name}")[:255],
        "summary": str(result.get("summary") or "")[:500],
        "body": body,
        "tags": [str(t)[:40] for t in tags][:8],
        "space": ds.name[:120],
        "related_dataset_ids": [dataset_id],
        "related_dashboard_ids": [dashboard_id] if dashboard_id else [],
    }
