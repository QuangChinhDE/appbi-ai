"""Knowledge tools: let an agent LOOK THINGS UP instead of being handed a paste.

Before these existed the module had 23 tools and every one of them read chart
data. The company's documents and its KPI definitions reached a model only by
being pre-assembled into a block and pasted in front of every question, whether
the question needed them or not — which meant an agent could never pull the one
document that would have answered a question the paste had summarised away.

    search_knowledge   keyword search over documents + managed KPI definitions.
                       Returns what matched and its id.
    read_document      the full body of one document, by id.

SCOPE IS A SECURITY BOUNDARY, NOT A RELEVANCE FILTER
----------------------------------------------------
A flow step on a public link runs as `actor_type='public_session'` — an
anonymous viewer of a shared report, with no User row. `get_knowledge_doc`
elsewhere in the codebase treats `current_user=None` as full access and performs
no permission check, so a tool built on it would let that viewer read every
document in the tenant, drafts included. These tools therefore do their own
scoping from first principles and never consult that helper:

  documents   Published only, AND attached to THIS dashboard or to one of its
              datasets. Attachment counts through either mechanism the product
              offers (`govern_doc_asset_links`, or the doc's own
              `related_dashboard_ids` / `related_dataset_ids`) — a document a
              person attached is in scope regardless of which screen they used.
              Long-form prose can contain anything, so there is no company-wide
              fallback here.

  KPIs        in scope when bound to this report's data, and ALSO when bound to
              nothing at all. An unbound managed KPI is by definition not
              report-specific: it is a dictionary entry — "GMV means …, computed
              as …" — and a central dictionary is the stated purpose of the
              knowledge modules. Definitions only; a KPI's target value is a
              declared number, never a measurement of this report's data.

The same rule applies to an authenticated user. One rule is easier to reason
about than two, and nobody has asked for a bot that answers about report A using
documents attached only to report B.

FIGURES FROM HERE ARE NOT EVIDENCE
----------------------------------
Both tools are listed in `evidence.NON_EVIDENTIAL_TOOLS`. A number that appears
in a sentence of prose — a target, an example, last quarter's figure quoted in a
memo — is not a measurement of the data on screen. Recording it as evidence
would let the verifier "confirm" a claim by matching it against a number the bot
read in a document, which is precisely the failure the verifier exists to catch.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from app.services.dashboard_ai_bot.tool_context import ToolContext, _err, _ok

logger = logging.getLogger(__name__)

#: One document's body, as handed to a model. Long enough for a real process
#: document, short enough that one call cannot consume the turn's whole budget.
MAX_BODY_CHARS = 6000
MAX_SNIPPET_CHARS = 320
MAX_HITS = 8


def _fold(text: str) -> str:
    """Lowercase and strip Vietnamese diacritics so "doanh thu" matches "Doanh Thu"."""
    import unicodedata

    normalised = unicodedata.normalize("NFD", str(text or "").lower())
    stripped = "".join(c for c in normalised if unicodedata.category(c) != "Mn")
    return stripped.replace("đ", "d")


def _tokens(text: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", _fold(text)) if len(t) > 1}


def _score(haystack: str, needles: set[str]) -> float:
    """Fraction of query tokens present. Simple on purpose: the store is small,
    and an author debugging "why did it not find my document" can predict this."""
    if not needles:
        return 0.0
    hay = _tokens(haystack)
    return len(needles & hay) / len(needles)


def _plain(text: str, limit: int) -> str:
    """Markdown → something a model reads as prose, truncated on a word."""
    cleaned = re.sub(r"\{\{[^}]+\}\}", "", str(text or ""))
    cleaned = re.sub(r"[#>*`_\[\]]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) <= limit:
        return cleaned
    cut = cleaned[:limit]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit * 0.6 else cut).rstrip() + "…"


def _scope(ctx: ToolContext) -> tuple[set[int], set[int]]:
    """(dataset_table_ids, dataset_ids) backing this dashboard."""
    from app.models.dataset import DatasetTable
    from app.services.dashboard_ai_bot.knowledge_context import dashboard_table_ids

    tids = set(dashboard_table_ids(ctx.db, ctx.dashboard.id))
    dsids: set[int] = set()
    if tids:
        for table in ctx.db.query(DatasetTable).filter(DatasetTable.id.in_(tids)).all():
            if table.dataset_id:
                dsids.add(table.dataset_id)
    return tids, dsids


def _authored_doc_ids(ctx: ToolContext) -> set[int] | None:
    """The step's own document narrowing, or None when it did not narrow."""
    raw = (getattr(ctx, "knowledge_scope", None) or {}).get("doc_ids") or []
    out: set[int] = set()
    for item in raw:
        try:
            out.add(int(item))
        except (TypeError, ValueError):
            continue
    return out or None


def _authored_metric_names(ctx: ToolContext) -> set[str] | None:
    raw = (getattr(ctx, "knowledge_scope", None) or {}).get("metric_names") or []
    out = {str(x).strip() for x in raw if str(x).strip()}
    return out or None


def _visible_doc_ids(ctx: ToolContext) -> set[int]:
    """Documents this report is allowed to read, then narrowed to what this STEP
    was scoped to. See the module docstring for why the order matters: the
    entitlement is computed first and the author's list only cuts inside it."""
    chosen = _authored_doc_ids(ctx)
    if chosen:
        # An EXPLICIT grant is the ceiling. It may reach outside this report — that
        # is the point, and it is safe because the grant was made in the builder
        # against the author's own view rights. Published is still required: a
        # draft is not something anyone chose to publish to a viewer.
        return chosen & _published_doc_ids(ctx)
    return _entitled_doc_ids(ctx)


def _published_doc_ids(ctx: ToolContext) -> set[int]:
    from app.models.governance import GovernKnowledgeDoc

    rows = (
        ctx.db.query(GovernKnowledgeDoc.id)
        .filter(GovernKnowledgeDoc.status == "Published")
        .all()
    )
    return {r[0] for r in rows}


def _entitled_doc_ids(ctx: ToolContext) -> set[int]:
    """Documents this report is allowed to read. See the module docstring."""
    from app.models.governance import GovernDocAssetLink, GovernKnowledgeDoc

    tids, dsids = _scope(ctx)
    dash_ref = str(ctx.dashboard.id)

    linked: set[int] = set()
    refs = {("dashboard", dash_ref)} | {("dataset", str(d)) for d in dsids}
    for link in (
        ctx.db.query(GovernDocAssetLink)
        .filter(GovernDocAssetLink.asset_type.in_(["dashboard", "dataset"]))
        .all()
    ):
        if (link.asset_type, str(link.asset_ref)) in refs:
            linked.add(link.doc_id)

    # The doc's own arrays are the other way a person attaches a document. Both
    # are honoured because both exist in the product and neither is documented
    # as the winner.
    published = (
        ctx.db.query(GovernKnowledgeDoc)
        .filter(GovernKnowledgeDoc.status == "Published")
        .all()
    )
    visible: set[int] = set()
    for doc in published:
        if doc.id in linked:
            visible.add(doc.id)
            continue
        own_dash = {str(x) for x in (doc.related_dashboard_ids or [])}
        own_ds = {str(x) for x in (doc.related_dataset_ids or [])}
        if dash_ref in own_dash or own_ds & {str(d) for d in dsids}:
            visible.add(doc.id)
    return visible


def _metrics_in_scope(ctx: ToolContext) -> list[Any]:
    chosen = _authored_metric_names(ctx)
    from app.models.governance import GovernMetric

    tids, dsids = _scope(ctx)
    out: list[Any] = []
    for metric in (
        ctx.db.query(GovernMetric).filter(GovernMetric.status != "Deprecated").all()
    ):
        bound = metric.dataset_id is not None or metric.dataset_table_id is not None
        matched = (metric.dataset_id in dsids) or (metric.dataset_table_id in tids)
        if not matched and metric.measure_ref:
            # Field metrics commonly bind through a "dataset_table_<id>.<measure>"
            # string rather than the id columns, and in practice that id may be
            # either a dataset_table id or a dataset id. Honour both — the
            # sibling code path in knowledge_context does, and a definition that
            # reaches the rules block but not the dictionary is worse than
            # either outcome alone.
            ref = re.match(r"dataset_table_(\d+)\.", str(metric.measure_ref))
            if ref:
                bound = True
                ref_id = int(ref.group(1))
                if ref_id in tids or ref_id in dsids:
                    matched = True
        if not (matched or not bound):
            continue
        # The step's own narrowing, applied AFTER entitlement — same rule as
        # documents, so a name that is not in scope cannot be added by listing it.
        if chosen and metric.name not in chosen and (metric.display_name or "") not in chosen:
            continue
        out.append(metric)
    return out


def _metric_text(metric: Any) -> str:
    bits = [metric.display_name, metric.name, metric.definition, metric.formula,
            metric.category, metric.unit]
    return " ".join(str(b) for b in bits if b)


def tool_search_knowledge(ctx: ToolContext, args: dict) -> dict:
    query = str((args or {}).get("query") or "").strip()
    if not query:
        return _err("cần 'query' — từ khoá hoặc câu hỏi cần tra")
    try:
        limit = int((args or {}).get("limit") or 6)
    except (TypeError, ValueError):
        limit = 6
    limit = max(1, min(limit, MAX_HITS))

    needles = _tokens(query)
    hits: list[dict] = []

    try:
        from app.models.governance import GovernKnowledgeDoc

        doc_ids = _visible_doc_ids(ctx)
        if doc_ids:
            for doc in (
                ctx.db.query(GovernKnowledgeDoc)
                .filter(GovernKnowledgeDoc.id.in_(doc_ids))
                .all()
            ):
                haystack = " ".join(
                    str(x) for x in (doc.title, doc.summary, doc.body, doc.tags) if x
                )
                score = _score(haystack, needles)
                if score <= 0:
                    continue
                hits.append({
                    "kind": "document",
                    "id": doc.id,
                    "title": doc.title,
                    "snippet": _plain(doc.summary or doc.body, MAX_SNIPPET_CHARS),
                    "score": round(score, 3),
                })
    except Exception:  # noqa: BLE001
        logger.warning("search_knowledge: document scan failed", exc_info=True)

    try:
        for metric in _metrics_in_scope(ctx):
            score = _score(_metric_text(metric), needles)
            if score <= 0:
                continue
            target = None
            if metric.target_operator and metric.target_value is not None:
                target = f"{metric.target_operator} {metric.target_value}"
            hits.append({
                "kind": "metric",
                "id": metric.name,
                "title": metric.display_name or metric.name,
                "definition": _plain(metric.definition, MAX_SNIPPET_CHARS),
                "formula": _plain(metric.formula, MAX_SNIPPET_CHARS),
                "unit": metric.unit or None,
                "target": target,
                "owner": metric.owner or None,
                "score": round(score, 3),
            })
    except Exception:  # noqa: BLE001
        logger.warning("search_knowledge: metric scan failed", exc_info=True)

    hits.sort(key=lambda h: h["score"], reverse=True)
    top = hits[:limit]
    return _ok({
        "query": query,
        "total_matches": len(hits),
        "returned": len(top),
        "results": top,
        # Said explicitly because the model must not treat a definition's target
        # or an example figure as a measurement of this report.
        "note": (
            "Đây là ĐỊNH NGHĨA/TÀI LIỆU do người viết, KHÔNG phải số đo từ dữ "
            "liệu báo cáo. Muốn con số thực tế thì phải đọc dữ liệu biểu đồ."
        ),
    })


def tool_read_document(ctx: ToolContext, args: dict) -> dict:
    raw_id = (args or {}).get("doc_id")
    try:
        doc_id = int(raw_id)
    except (TypeError, ValueError):
        return _err("cần 'doc_id' dạng số — lấy từ kết quả search_knowledge")

    if doc_id not in _visible_doc_ids(ctx):
        # Deliberately the same message for "does not exist", "is a draft" and
        # "belongs to another report": an anonymous viewer must not be able to
        # probe which document ids exist by reading the error.
        return _err(
            "không có tài liệu này trong phạm vi báo cáo (chỉ đọc được tài liệu "
            "đã Published và được gắn vào báo cáo/bộ dữ liệu của báo cáo)"
        )

    from app.models.governance import GovernKnowledgeDoc

    doc = ctx.db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
    if doc is None:
        return _err("không có tài liệu này trong phạm vi báo cáo")

    body = _plain(doc.body, MAX_BODY_CHARS)
    return _ok({
        "id": doc.id,
        "title": doc.title,
        "doc_type": doc.doc_type,
        "summary": _plain(doc.summary, MAX_SNIPPET_CHARS) or None,
        "body": body,
        "truncated": len(str(doc.body or "")) > MAX_BODY_CHARS,
        "owner": doc.owner or None,
        "note": (
            "Nội dung tài liệu do người viết. Số trong tài liệu KHÔNG phải số đo "
            "từ dữ liệu báo cáo."
        ),
    })


def _granted_dataset_ids(ctx: ToolContext) -> set[int] | None:
    raw = (getattr(ctx, "knowledge_scope", None) or {}).get("dataset_ids") or []
    out: set[int] = set()
    for item in raw:
        try:
            out.add(int(item))
        except (TypeError, ValueError):
            continue
    return out or None


def tool_describe_semantic_model(ctx: ToolContext, args: dict) -> dict:
    """The business meaning of the fields behind this report's data.

    The semantic layer already carried this — measure and dimension descriptions,
    aliases, units — and `knowledge_context._semantic_fields` already read it, but
    only to paste into the steering block. Nothing let an agent ASK. So a step
    that needed to know what `payment_value` means had to infer it from the column
    name, which is the guess a later tool call cannot repair.

    Datasets come from the step's grant when it has one, and from the report
    otherwise. Same rule as documents: an explicit grant is the ceiling, and it
    was checked against the author's own rights when it was made.
    """
    from app.services.dashboard_ai_bot.knowledge_context import _semantic_fields

    tids, dsids = _scope(ctx)
    granted = _granted_dataset_ids(ctx)
    if granted:
        dsids = granted

    if not dsids:
        return _ok({
            "datasets": [],
            "fields": [],
            "note": "Báo cáo này chưa gắn bộ dữ liệu nào có mô tả nghiệp vụ.",
        })

    try:
        fields = _semantic_fields(ctx.db, set(dsids))
    except Exception:  # noqa: BLE001
        logger.warning("describe_semantic_model failed", exc_info=True)
        fields = []

    query = str((args or {}).get("query") or "").strip()
    if query:
        needles = _tokens(query)
        fields = [
            f for f in fields
            if _score(" ".join(str(v) for v in f.values() if v), needles) > 0
        ]

    return _ok({
        "datasets": sorted(dsids),
        "total": len(fields),
        "fields": fields[:60],
        "note": (
            "Đây là ĐỊNH NGHĨA trường dữ liệu do người khai báo trong Semantic "
            "Layer, KHÔNG phải số đo. Muốn số thì phải đọc dữ liệu biểu đồ."
        ),
    })


DESCRIBE_SEMANTIC_TOOL_DEF: dict = {
    "name": "describe_semantic_model",
    "description": (
        "Xem ý nghĩa nghiệp vụ của các trường dữ liệu (measure/dimension) đằng sau "
        "báo cáo: tên hiển thị, mô tả, đơn vị, bút danh. Dùng khi cần biết một "
        "trường THỰC SỰ là gì trước khi kết luận, thay vì suy từ tên cột. Không "
        "trả về số đo."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Từ khoá để lọc trường (để trống = liệt kê tất cả).",
            },
        },
    },
}


SEARCH_KNOWLEDGE_TOOL_DEF: dict = {
    "name": "search_knowledge",
    "description": (
        "Tìm trong tri thức doanh nghiệp: tài liệu nghiệp vụ (Cẩm nang tri thức) và "
        "định nghĩa/công thức các chỉ số quản trị (KPI). Dùng khi câu hỏi liên quan "
        "tới một khái niệm, quy trình, hoặc cần biết một chỉ số được ĐỊNH NGHĨA và "
        "TÍNH thế nào. Trả về danh sách kết quả kèm id; muốn đọc trọn tài liệu thì "
        "gọi tiếp read_document với id đó. KHÔNG trả về số đo thực tế của báo cáo."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Từ khoá hoặc câu hỏi cần tra, ví dụ 'GMV tính thế nào'.",
            },
            "limit": {
                "type": "integer",
                "description": f"Số kết quả tối đa (1-{MAX_HITS}, mặc định 6).",
            },
        },
        "required": ["query"],
    },
}

READ_DOCUMENT_TOOL_DEF: dict = {
    "name": "read_document",
    "description": (
        "Đọc trọn nội dung một tài liệu nghiệp vụ theo id lấy từ search_knowledge. "
        "Chỉ đọc được tài liệu đã Published và được gắn vào báo cáo này hoặc bộ dữ "
        "liệu của nó. Dùng khi đoạn tóm tắt trong kết quả tìm kiếm chưa đủ để trả lời."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "doc_id": {"type": "integer", "description": "id tài liệu từ search_knowledge."},
        },
        "required": ["doc_id"],
    },
}

GOVERN_TOOL_DEFS: list[dict] = [
    SEARCH_KNOWLEDGE_TOOL_DEF,
    READ_DOCUMENT_TOOL_DEF,
    DESCRIBE_SEMANTIC_TOOL_DEF,
]
GOVERN_TOOLS = {
    "search_knowledge": tool_search_knowledge,
    "read_document": tool_read_document,
    "describe_semantic_model": tool_describe_semantic_model,
}
