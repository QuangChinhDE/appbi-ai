"""AI-drafted Govern documents.

Given ONE OR MORE datasets (a knowledge document usually spans several data
sources, not 1:1), gather each one's real model (tables + column types), a
small data sample, defined measures and existing governed metrics — plus any
linked dashboards and an optional user "focus" — then ask the LLM (via the
OpenAI→Gemini→Anthropic fallback client) to WRITE a structured business
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


def _gather_one(db: Session, dataset_id: int) -> tuple[str, Any]:
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
        from app.services.governance_service import GovernanceService

        gms = [
            metric for metric in db.query(GovernMetric).filter(GovernMetric.status != "Deprecated").all()
            if dataset_id in GovernanceService.metric_dataset_ids(db, metric)
        ]
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


def _dashboards_block(db: Session, dashboard_ids: list[int]) -> tuple[str, list[str]]:
    """Short grounding block for linked dashboards (name + a few chart titles)."""
    if not dashboard_ids:
        return "", []
    names: list[str] = []
    lines: list[str] = []
    try:
        from app.models.models import Dashboard, Chart
        for dash in db.query(Dashboard).filter(Dashboard.id.in_(dashboard_ids)).all():
            names.append(dash.name)
            titles = [c.name for c in db.query(Chart).filter(Chart.dashboard_id == dash.id).limit(8).all() if c.name]
            lines.append(f"▸ Báo cáo '{dash.name}' (id={dash.id}) — biểu đồ: {', '.join(titles) or '(chưa rõ)'}")
    except Exception:  # noqa: BLE001
        pass
    return ("\nBÁO CÁO LIÊN QUAN:\n" + "\n".join(lines) if lines else ""), names


def draft_document(
    db: Session,
    dataset_ids: list[int],
    dashboard_ids: Optional[list[int]] = None,
    focus: Optional[str] = None,
) -> Optional[dict]:
    """Draft a business doc spanning one OR MORE datasets (+ optional dashboards
    and a user focus). Returns {title, summary, body, tags, space, related_*}."""
    from app.services.llm_client import LLMClient

    dataset_ids = [int(x) for x in (dataset_ids or [])][:6]
    dashboard_ids = [int(x) for x in (dashboard_ids or [])][:6]

    blocks: list[str] = []
    names: list[str] = []
    for did in dataset_ids:
        text, ds = _gather_one(db, did)
        if ds is not None:
            blocks.append(text)
            names.append(ds.name)
    if not blocks:
        return None

    dash_block, dash_names = _dashboards_block(db, dashboard_ids)
    context = ("\n\n══════════════════\n\n".join(blocks) + ("\n\n" + dash_block if dash_block else ""))[:14000]

    ds_tokens = " ".join(f"{{{{dataset:{d}}}}}" for d in dataset_ids)
    dash_tokens = " ".join(f"{{{{dashboard:{d}}}}}" for d in dashboard_ids)
    multi = len(dataset_ids) > 1
    focus_line = f"\nTRỌNG TÂM người dùng yêu cầu tài liệu tập trung vào: {focus}\n" if (focus or "").strip() else ""
    scope = (
        f"{len(dataset_ids)} dataset (tài liệu này bao trùm NHIỀU nguồn dữ liệu — hãy tổng hợp, "
        "liên hệ chúng với nhau, KHÔNG mô tả rời rạc từng cái)"
        if multi else "1 dataset"
    )
    prompt = (
        f"Dưới đây là MÔ HÌNH DỮ LIỆU THẬT của {scope} (các bảng, kiểu cột, vài dòng mẫu, đo lường, "
        "chỉ số đã khai báo, và báo cáo liên quan nếu có). Hãy PHÂN TÍCH và VIẾT một tài liệu nghiệp "
        "vụ hoàn chỉnh mô tả mảng kinh doanh mà các nguồn dữ liệu này cùng phản ánh."
        f"{focus_line}\n"
        f"{context}\n\n"
        "YÊU CẦU tài liệu (body dạng Markdown, DÀI, có tiêu đề ##):\n"
        "1. Bối cảnh kinh doanh (suy luận từ tên bảng/cột; nếu nhiều dataset, nêu vai trò mỗi nguồn).\n"
        "2. Mô hình dữ liệu (các bảng chính & vai trò, quan hệ suy ra được, cách các dataset bổ trợ nhau).\n"
        "3. Các chỉ số nên theo dõi — mỗi chỉ số kèm ý nghĩa + gợi ý cách tính (dựa trên cột thật).\n"
        "4. Cách đọc / phân tích.\n"
        "5. Lưu ý & cảnh báo khi dùng số liệu.\n"
        f"Chèn các thẻ nguồn {ds_tokens}{(' ' + dash_tokens) if dash_tokens else ''} vào chỗ phù hợp trong body.\n\n"
        "Trả về JSON đúng khoá: {\"title\": string, \"summary\": string (1 câu), "
        "\"body\": string (Markdown), \"tags\": [string,...]}."
    )
    result = LLMClient.complete_json(prompt, system=_SYSTEM, max_tokens=3200)
    if not isinstance(result, dict) or not result.get("body"):
        return None

    body = str(result.get("body") or "")
    # Ensure every source token is present so the doc links back to all sources.
    missing = [f"{{{{dataset:{d}}}}}" for d in dataset_ids if f"{{{{dataset:{d}}}}}" not in body]
    missing += [f"{{{{dashboard:{d}}}}}" for d in dashboard_ids if f"{{{{dashboard:{d}}}}}" not in body]
    if missing:
        body += "\n\n---\nNguồn: " + " ".join(missing)
    tags = result.get("tags")
    if not isinstance(tags, list):
        tags = []
    return {
        "title": str(result.get("title") or f"Tài liệu: {', '.join(names)[:80]}")[:255],
        "summary": str(result.get("summary") or "")[:500],
        "body": body,
        "tags": [str(t)[:40] for t in tags][:8],
        "space": (names[0][:120] if len(names) == 1 else "Chung"),
        "related_dataset_ids": dataset_ids,
        "related_dashboard_ids": dashboard_ids,
    }
