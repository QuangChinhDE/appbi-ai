"""Knowledge Context Assembler — the platform's GENERIC grounding engine.

Given ANY dashboard, it assembles whatever knowledge a business has AUTHORED for
that dashboard's datasets — with zero per-report / per-tenant code — and returns
a grounded context block for the AI bot to reason from instead of guessing from
column names. The more a business authors in Govern / the data dictionary, the
better the bot; author nothing and it degrades gracefully (empty block → the bot
falls back to heuristics, explicitly ungrounded).

Authored sources unified here (all optional, all read generically):
  • Dataset.dictionary            — business_name / description / examples per column, table notes
  • DatasetTable.column_descriptions / auto_description / common_questions / query_aliases (vi)
  • Govern glossary_terms          — definition + synonyms (domain vocabulary)
  • semantic measures/dimensions   — label + description (best-effort)
  • ai_bot_knowledge               — institutional memory (learned + user-taught)

This is DATA-driven: nothing about a specific business lives in this file.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

_MAX_TERMS = 24          # glossary terms injected
_MAX_COLS_PER_TABLE = 40
_MAX_ALIASES = 30
_MAX_QUESTIONS = 8
_WORD_RE = re.compile(r"[0-9A-Za-zÀ-ỹ]+", re.UNICODE)


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", s.lower()).strip()


def _tokens(s: str) -> set[str]:
    return {w for w in _WORD_RE.findall(_fold(s)) if len(w) > 2}


def _relevance(text: str, q_tokens: set[str]) -> float:
    if not q_tokens:
        return 0.0
    t = _tokens(text)
    return len(q_tokens & t) / len(q_tokens) if t else 0.0


# ── scope resolution ────────────────────────────────────────────────────────
def dashboard_table_ids(db: Session, dashboard_id: int) -> list[int]:
    """dataset_table_ids backing a dashboard's charts (deduped). Generic."""
    try:
        from app.models.models import Chart, DashboardChart
        rows = (
            db.query(Chart.dataset_table_id)
            .join(DashboardChart, DashboardChart.chart_id == Chart.id)
            .filter(DashboardChart.dashboard_id == dashboard_id)
            .distinct()
            .all()
        )
        return [r[0] for r in rows if r[0] is not None]
    except Exception:  # noqa: BLE001
        logger.warning("knowledge_context: table-id resolve failed", exc_info=True)
        return []


# ── authored-knowledge assembly ─────────────────────────────────────────────
def assemble(db: Session, *, dataset_table_ids: list[int], question: str = "") -> dict:
    """Collect authored knowledge for the given tables. Pure reads; never raises
    (each source is best-effort so a missing/edge dataset can't break a turn)."""
    q_tokens = _tokens(question)
    out: dict[str, Any] = {
        "columns": [],       # [{name, business_name, description, examples, table}]
        "aliases": [],       # ["GMV","doanh thu",...]
        "common_questions": [],
        "glossary": [],      # [{term, definition, synonyms}]
        "measures": [],      # [{name, label, description}]
        "datasets": [],      # [{name, description}]
    }
    if not dataset_table_ids:
        return out

    try:
        from app.models.dataset import Dataset, DatasetTable
    except Exception:  # noqa: BLE001
        return out

    tables = (
        db.query(DatasetTable).filter(DatasetTable.id.in_(dataset_table_ids)).all()
    )
    dataset_ids = {t.dataset_id for t in tables if t.dataset_id}
    datasets = {
        d.id: d for d in db.query(Dataset).filter(Dataset.id.in_(dataset_ids)).all()
    } if dataset_ids else {}

    for d in datasets.values():
        if d.description:
            out["datasets"].append({"name": d.name, "description": str(d.description)[:400]})

    seen_cols: set[str] = set()
    for t in tables:
        # Current dictionary shape is table_notes[].column_notes[]. Keep the
        # legacy flat map as a read fallback for deployments mid-migration.
        dic = {}
        ds = datasets.get(t.dataset_id)
        if ds is not None and isinstance(getattr(ds, "dictionary", None), dict):
            legacy = ds.dictionary.get("columns") if isinstance(ds.dictionary.get("columns"), dict) else {}
            table_note = next(
                (
                    note for note in ds.dictionary.get("table_notes") or []
                    if isinstance(note, dict) and note.get("table_id") == t.id
                ),
                {},
            )
            current = {
                str(note.get("column_name")): note
                for note in table_note.get("column_notes") or []
                if isinstance(note, dict) and note.get("column_name")
            }
            dic = {**legacy, **current}
        col_desc = t.column_descriptions if isinstance(t.column_descriptions, dict) else {}

        # union of columns that have ANY authored meaning
        names = set(col_desc.keys()) | set(dic.keys() if isinstance(dic, dict) else [])
        for name in names:
            key = f"{t.id}:{name}"
            if key in seen_cols:
                continue
            seen_cols.add(key)
            dentry = dic.get(name) if isinstance(dic, dict) else None
            business_name = (dentry or {}).get("business_name") if isinstance(dentry, dict) else None
            desc = col_desc.get(name) or ((dentry or {}).get("description") if isinstance(dentry, dict) else None)
            examples = (dentry or {}).get("examples") if isinstance(dentry, dict) else None
            if not (business_name or desc):
                continue
            out["columns"].append({
                "table": t.display_name,
                "name": name,
                "business_name": business_name or "",
                "description": (desc or "")[:300],
                "examples": examples[:5] if isinstance(examples, list) else [],
            })

        if isinstance(t.query_aliases, list):
            out["aliases"].extend([str(a) for a in t.query_aliases if a])
        if isinstance(t.common_questions, list):
            out["common_questions"].extend([str(qq) for qq in t.common_questions if qq])
        if t.auto_description:
            out["datasets"].append({"name": t.display_name, "description": str(t.auto_description)[:300]})

    # Govern glossary (domain vocabulary) — approved terms, ranked by question.
    try:
        from app.models.governance import GlossaryTerm
        terms = db.query(GlossaryTerm).all()
        scored = []
        for term in terms:
            if (term.status or "").lower() == "deprecated":
                continue
            syn = term.synonyms if isinstance(term.synonyms, list) else []
            blob = f"{term.display_name} {term.description or ''} {' '.join(syn)}"
            scored.append((_relevance(blob, q_tokens), term, syn))
        # relevant first; if question empty, keep insertion order
        scored.sort(key=lambda x: -x[0])
        for rel, term, syn in scored[:_MAX_TERMS]:
            out["glossary"].append({
                "term": term.display_name,
                "definition": (term.description or "")[:300],
                "synonyms": [str(s) for s in syn][:8],
            })
    except Exception:  # noqa: BLE001
        pass

    # Semantic measures/dimensions label+description (best-effort; optional).
    try:
        out["measures"] = _semantic_fields(db, dataset_ids)
    except Exception:  # noqa: BLE001
        pass

    # AI data scope (Intelligence): drop columns/measures the business excluded.
    # No scope row = everything allowed, so existing dashboards are untouched.
    try:
        from app.services.governance_ai_service import GovernanceAIService
        ex_cols, ex_measures = GovernanceAIService.scope_exclusions(db, dataset_ids)
        if ex_cols:
            out["columns"] = [c for c in out["columns"] if _fold(c.get("name") or "") not in ex_cols]
        if ex_measures:
            out["measures"] = [m for m in out["measures"] if _fold(str(m.get("name") or "")) not in ex_measures]
    except Exception:  # noqa: BLE001
        logger.warning("knowledge_context: ai-scope filter failed", exc_info=True)

    # de-dup + cap aliases / questions
    out["aliases"] = list(dict.fromkeys(out["aliases"]))[:_MAX_ALIASES]
    out["common_questions"] = list(dict.fromkeys(out["common_questions"]))[:_MAX_QUESTIONS]
    out["columns"] = out["columns"][:_MAX_COLS_PER_TABLE]
    return out


def _semantic_fields(db: Session, dataset_ids: set[int]) -> list[dict]:
    """Measure/dimension label+description from the semantic model, if present.
    Best-effort — schema differences across versions must never break a turn."""
    if not dataset_ids:
        return []
    fields: list[dict] = []
    try:
        from app.models.semantic import SemanticView  # type: ignore
    except Exception:  # noqa: BLE001
        return []
    try:
        # SemanticView binds per dataset TABLE (no dataset_id column) — resolve
        # the dataset scope through DatasetTable. (Previously filtered on a
        # nonexistent column, so this source silently never injected.)
        from app.models.dataset import DatasetTable as _DT
        table_ids = [t.id for t in db.query(_DT.id).filter(_DT.dataset_id.in_(dataset_ids)).all()]
        views = db.query(SemanticView).filter(SemanticView.dataset_table_id.in_(table_ids or [-1])).all()
    except Exception:  # noqa: BLE001
        return []
    for v in views:
        for coll_attr in ("measures", "dimensions"):
            coll = getattr(v, coll_attr, None) or []
            if not isinstance(coll, list):
                continue
            for m in coll:
                if not isinstance(m, dict):
                    continue
                label = m.get("label") or m.get("name")
                desc = m.get("description")
                if label and desc:
                    fields.append({
                        "name": m.get("name"),
                        "label": label,
                        "description": str(desc)[:250],
                        "kind": coll_attr[:-1],
                    })
    return fields[:60]


def has_authored_knowledge(assembled: dict) -> bool:
    return any(assembled.get(k) for k in ("columns", "glossary", "measures", "aliases"))


def format_block(assembled: dict) -> str:
    """Render the assembled authored knowledge as a system-prompt block. Empty
    string when nothing is authored (bot then falls back, explicitly ungrounded)."""
    if not has_authored_knowledge(assembled):
        return ""
    lines = [
        "═══ 📚 TRI THỨC NGHIỆP VỤ ĐÃ ĐƯỢC KHAI BÁO (Govern / Data Dictionary) ═══",
        "Đây là ĐỊNH NGHĨA CHÍNH THỐNG cho báo cáo này. HÃY DÙNG chúng để hiểu đúng "
        "ý nghĩa cột/chỉ số/thuật ngữ. TUYỆT ĐỐI không suy đoán ý nghĩa từ tên cột thô "
        "khi đã có định nghĩa; nếu người dùng hỏi một chỉ số/khái niệm KHÔNG có ở đây và "
        "không suy ra được từ dữ liệu, hãy NÓI RÕ là chưa được định nghĩa thay vì đoán.",
    ]
    if assembled.get("glossary"):
        lines.append("• Thuật ngữ nghiệp vụ:")
        for g in assembled["glossary"]:
            syn = f" (đồng nghĩa: {', '.join(g['synonyms'])})" if g.get("synonyms") else ""
            lines.append(f"   - {g['term']}: {g['definition']}{syn}")
    if assembled.get("measures"):
        lines.append("• Chỉ số/chiều đã định nghĩa (semantic layer):")
        for m in assembled["measures"]:
            lines.append(f"   - [{m.get('kind')}] {m.get('label')}: {m.get('description')}")
    if assembled.get("columns"):
        lines.append("• Ý nghĩa cột (data dictionary):")
        for c in assembled["columns"]:
            bn = f" (tên nghiệp vụ: {c['business_name']})" if c.get("business_name") else ""
            ex = f" ví dụ: {', '.join(map(str, c['examples']))}" if c.get("examples") else ""
            lines.append(f"   - {c['name']}{bn}: {c['description']}{ex}")
    if assembled.get("aliases"):
        lines.append("• Cách người dùng thường gọi (alias → khớp về đúng cột/chỉ số): "
                     + ", ".join(assembled["aliases"]))
    if assembled.get("datasets"):
        for dd in assembled["datasets"][:4]:
            if dd.get("description"):
                lines.append(f"• {dd['name']}: {dd['description']}")
    return "\n".join(lines)


def _govern_managed_block(db: Session, dashboard_id: int, question: str = "") -> tuple[str, list[dict]]:
    """Authoritative Govern knowledge for the AI to REUSE: managed KPIs (defined
    by the business) bound to this dashboard's data, + knowledge docs that
    describe this report. This is the payoff of the Knowledge Foundation — the
    bot answers from human-authored definitions, not guesses. Best-effort.

    Returns (rendered block, provenance refs) so each answer can record WHICH
    knowledge grounded it (the "AI đang dùng gì" store)."""
    lines: list[str] = []
    refs: list[dict] = []
    try:
        from app.models.governance import GovernMetric, GovernDocAssetLink, GovernKnowledgeDoc
        from app.models.dataset import DatasetTable
        from app.services.governance_service import GovernanceService

        tids = set(dashboard_table_ids(db, dashboard_id))
        dsids: set[int] = set()
        if tids:
            for t in db.query(DatasetTable).filter(DatasetTable.id.in_(tids)).all():
                if t.dataset_id:
                    dsids.add(t.dataset_id)

        # Managed KPIs bound to this dashboard's datasets/tables (authoritative).
        metrics = [
            m for m in db.query(GovernMetric).filter(GovernMetric.status != "Deprecated").all()
            if GovernanceService.metric_dataset_ids(db, m, resolved_only=True) & dsids
        ]
        if metrics:
            lines.append(
                "• Chỉ số quản trị (KPI — ĐỊNH NGHĨA CHÍNH THỐNG do doanh nghiệp khai báo; "
                "ưu tiên dùng đúng định nghĩa/công thức này):"
            )
            for m in metrics[:15]:
                unit = f" ({m.unit})" if m.unit else ""
                how = f" · Cách tính: {m.formula}" if m.formula else ""
                tgt = (
                    f" · Mục tiêu {m.target_operator} {m.target_value}"
                    if m.target_operator and m.target_value is not None else ""
                )
                owner = f" · Chủ sở hữu: {m.owner}" if m.owner else ""
                lines.append(f"   - {m.display_name}{unit}: {m.definition or ''}{how}{tgt}{owner}")
                refs.append({"kind": "metric", "ref": m.name, "name": m.display_name})

        # Knowledge docs describing this report. PREFER embedding retrieval (RAG):
        # pull the passages most relevant to the question from the full doc bodies.
        # Fall back to summary blurbs when embeddings are unavailable/not built.
        rag_chunks: list[dict] = []
        try:
            from app.services.dashboard_ai_bot.govern_doc_embeddings import retrieve_doc_chunks
            rag_chunks = retrieve_doc_chunks(db, dashboard_id, question, k=6)
        except Exception:  # noqa: BLE001
            rag_chunks = []

        if rag_chunks:
            lines.append("• Trích đoạn tài liệu nghiệp vụ liên quan nhất tới câu hỏi (Cẩm nang tri thức):")
            seen_docs: set[str] = set()
            for c in rag_chunks:
                passage = re.sub(r"\s+", " ", c.get("content") or "").strip()[:420]
                lines.append(f"   - [{c.get('title')}] {passage}")
                title = str(c.get("title") or "")
                if title and title not in seen_docs:
                    seen_docs.add(title)
                    refs.append({"kind": "doc", "ref": str(c.get("doc_id") or title), "name": title})
        else:
            links = (
                db.query(GovernDocAssetLink)
                .filter(GovernDocAssetLink.asset_type == "dashboard", GovernDocAssetLink.asset_ref == str(dashboard_id))
                .all()
            )
            doc_ids = [l.doc_id for l in links]
            if doc_ids:
                docs = (
                    db.query(GovernKnowledgeDoc)
                    .filter(GovernKnowledgeDoc.id.in_(doc_ids), GovernKnowledgeDoc.status == "Published")
                    .all()
                )
                if docs:
                    lines.append("• Tài liệu nghiệp vụ mô tả báo cáo này (Cẩm nang tri thức):")
                    for d in docs[:8]:
                        # blurb preference: human summary → AI summary → stripped body
                        raw = d.summary or getattr(d, "ai_summary", None) or re.sub(r"\{\{[^}]+\}\}", "", d.body or "")
                        blurb = re.sub(r"[#>*`\n]+", " ", raw).strip()[:220]
                        lines.append(f"   - {d.title}: {blurb}")
                        refs.append({"kind": "doc", "ref": str(d.id), "name": d.title})
    except Exception:  # noqa: BLE001
        logger.warning("knowledge_context: govern managed block failed", exc_info=True)
    if not lines:
        return "", refs
    return (
        "═══ 🏛 TRI THỨC QUẢN TRỊ DOANH NGHIỆP (Govern — nguồn chính thống) ═══\n"
        + "\n".join(lines)
    ), refs


def _intelligence_blocks(db: Session, dashboard_id: int, question: str = "") -> tuple[list[str], list[dict]]:
    """Teach-the-AI knowledge (Intelligence modules): scoped AI instructions,
    verified Q&A pinning, business rules, playbooks and always-inject data
    caveats. Everything Approved-only, everything best-effort — a failure here
    must NEVER break a bot turn."""
    parts: list[str] = []
    refs: list[dict] = []
    try:
        from app.models.dataset import DatasetTable
        from app.models.governance import GovernMetric
        from app.services.governance_ai_service import GovernanceAIService as AIS

        tids = set(dashboard_table_ids(db, dashboard_id))
        dsids: set[int] = set()
        if tids:
            for t in db.query(DatasetTable).filter(DatasetTable.id.in_(tids)).all():
                if t.dataset_id:
                    dsids.add(t.dataset_id)

        # 1) AI instructions — Global → Dataset → Dashboard (steering, first).
        try:
            instr = AIS.active_instructions(db, dsids, dashboard_id)
            if instr:
                scope_label = {"global": "Toàn hệ thống", "dataset": "Bộ dữ liệu", "dashboard": "Dashboard"}
                lines = ["═══ 🧭 CHỈ DẪN AI (quản trị cấu hình — TUÂN THỦ khi phân tích) ═══"]
                for i in instr:
                    body = re.sub(r"\s+\n", "\n", (i.content_md or "").strip())[:1500]
                    lines.append(f"• [{scope_label.get(i.scope, i.scope)} · v{i.version}]\n{body}")
                    refs.append({"kind": "instruction", "ref": f"{i.scope}:{i.scope_id or 0}", "name": f"Chỉ dẫn AI {i.scope} v{i.version}"})
                parts.append("\n".join(lines))
        except Exception:  # noqa: BLE001
            logger.warning("knowledge_context: instructions block failed", exc_info=True)

        # 2) Verified Q&A — trigger match pins the approved answer.
        try:
            qa = AIS.qa_match(db, dashboard_id, question)
            if qa is not None:
                lines = [
                    "═══ ✅ HỎI-ĐÁP ĐÃ CHỨNG THỰC (khớp câu hỏi này — PHẢI neo câu trả lời vào đây) ═══",
                    f"• Câu hỏi chuẩn: {qa.question}",
                    f"• Đáp án đã duyệt: {qa.answer_md[:1200]}",
                ]
                if qa.chart_id:
                    lines.append(f"• Visual đã ghim: chart:{qa.chart_id} — TRÍCH DẪN chart này trong câu trả lời.")
                lines.append("Trình bày lại theo ngữ cảnh nếu cần, nhưng KHÔNG mâu thuẫn với đáp án đã duyệt.")
                parts.append("\n".join(lines))
                refs.append({"kind": "qa", "ref": str(qa.id), "name": qa.question[:120]})
                AIS.bump_qa_use(qa.id)
        except Exception:  # noqa: BLE001
            logger.warning("knowledge_context: verified-qa block failed", exc_info=True)

        # 3) Rules + playbooks bound to this dashboard's metrics.
        try:
            metric_names: set[str] = set()
            from app.services.governance_service import GovernanceService
            for m in db.query(GovernMetric).filter(GovernMetric.status == "Approved").all():
                matched = bool(GovernanceService.metric_dataset_ids(db, m, resolved_only=True) & dsids)
                if matched:
                    metric_names.add(m.name)
                    if m.display_name:
                        metric_names.add(m.display_name)
            rules, playbooks = AIS.guidance_for(db, dsids, metric_names)
            if rules:
                lines = ["═══ 📏 QUY TẮC NGHIỆP VỤ (đã chứng thực — áp dụng khi kết luận) ═══"]
                for r in rules:
                    exc = f" · Ngoại lệ: {r.exceptions_text}" if r.exceptions_text else ""
                    lines.append(f"• {r.name}: NẾU {r.condition_text} THÌ {r.conclusion_text}{exc}")
                    refs.append({"kind": "rule", "ref": str(r.id), "name": r.name})
                parts.append("\n".join(lines))
            if playbooks:
                lines = ["═══ 📋 PLAYBOOK PHÂN TÍCH (cách doanh nghiệp muốn AI phân tích) ═══"]
                for p in playbooks:
                    steps = " → ".join(str(s) for s in (p.steps or [])[:6])
                    dims = f" · Ưu tiên chiều: {', '.join(p.dim_priority)}" if p.dim_priority else ""
                    outp = f" · Output mong đợi: {p.expected_output}" if p.expected_output else ""
                    lines.append(f"• {p.name} (khi {p.trigger_text}): {steps}{dims}{outp}")
                    refs.append({"kind": "playbook", "ref": str(p.id), "name": p.name})
                parts.append("\n".join(lines))
        except Exception:  # noqa: BLE001
            logger.warning("knowledge_context: guidance block failed", exc_info=True)

        # 4) Data caveats — ALWAYS injected (RAG similarity would miss these).
        try:
            caveats = AIS.caveats_for(db, dsids)
            if caveats:
                lines = ["═══ ⚠ LƯU Ý DỮ LIỆU (luôn áp dụng cho dữ liệu này) ═══"]
                for c in caveats:
                    lines.append(f"• {c.title}: {c.content[:400]}")
                    refs.append({"kind": "caveat", "ref": str(c.id), "name": c.title})
                parts.append("\n".join(lines))
        except Exception:  # noqa: BLE001
            logger.warning("knowledge_context: caveats block failed", exc_info=True)
    except Exception:  # noqa: BLE001
        logger.warning("knowledge_context: intelligence blocks failed", exc_info=True)
    return parts, refs


#: Which builder each context source key comes from. A flow's Context step picks
#: keys; this is the map that makes the picking mean something.
#:
#: `caveat` and `verified_qa` are deliberately absent from the optional set —
#: they are force-added by the caller. A data caveat that a link can switch off
#: is not a caveat.
_SOURCE_GROUPS: dict[str, str] = {
    "instruction": "intelligence",
    "verified_qa": "intelligence",
    "rule": "intelligence",
    "playbook": "intelligence",
    "caveat": "intelligence",
    "metric": "govern",
    "doc": "govern",
    "term": "semantic",
    "chart_fields": "semantic",
    "memory": "memory",
    "recon": "recon",
}


def build_knowledge_context_block(
    db: Session,
    *,
    dashboard_id: int,
    question: str = "",
    sources: set[str] | None = None,
) -> str:
    """The full grounding block injected each turn = AUTHORED knowledge (Govern +
    dictionary + semantic) + INSTITUTIONAL MEMORY (learned/taught). Generic;
    graceful. This unifies the platform's knowledge sources for the bot.

    ``sources`` narrows it to the keys a flow's Context step selected. None means
    "everything", which is the pre-flow behaviour and stays the default so the
    legacy path is untouched.

    This parameter is the whole point of the Context step. Before it existed the
    step computed a source list and then called this function without it, so
    every bot on every link read exactly the same everything — and "each public
    link is a different bot" could not be true no matter what anyone ticked.
    """
    want = None if sources is None else set(sources)

    def enabled(group: str) -> bool:
        if want is None:
            return True
        return any(_SOURCE_GROUPS.get(k) == group for k in want)

    parts: list[str] = []
    prov_refs: list[dict] = []
    # Intelligence steering (instructions / verified Q&A / rules / playbooks /
    # caveats) FIRST — configuration + certified answers outrank everything.
    if enabled("intelligence"):
        try:
            intel_parts, intel_refs = _intelligence_blocks(db, dashboard_id, question)
            parts.extend(intel_parts)
            prov_refs.extend(intel_refs)
        except Exception:  # noqa: BLE001
            logger.warning("knowledge_context: intelligence blocks failed", exc_info=True)
    # Govern-authored knowledge (managed KPIs + knowledge docs) — the
    # authoritative, human-curated layer the AI should reuse before anything.
    if enabled("govern"):
        try:
            govern, govern_refs = _govern_managed_block(db, dashboard_id, question)
            if govern:
                parts.append(govern)
            prov_refs.extend(govern_refs)
        except Exception:  # noqa: BLE001
            logger.warning("knowledge_context: govern block failed", exc_info=True)
    if enabled("semantic"):
        try:
            tids = dashboard_table_ids(db, dashboard_id)
            assembled = assemble(db, dataset_table_ids=tids, question=question)
            authored = format_block(assembled)
            if authored:
                parts.append(authored)
        except Exception:  # noqa: BLE001
            logger.warning("knowledge_context: authored assembly failed", exc_info=True)
    # Institutional memory (Phase-17) — learned + user-taught, dashboard-scoped.
    if enabled("memory"):
        try:
            from app.services.dashboard_ai_bot import knowledge as _kb
            mem = _kb.build_knowledge_prompt_block(
                db, dashboard_id=dashboard_id, question=question,
            )
            if mem:
                parts.append(mem)
        except Exception:  # noqa: BLE001
            logger.warning("knowledge_context: memory block failed", exc_info=True)
    # Provenance — record what grounded this turn (best-effort, own session).
    try:
        if question:
            from app.services.governance_ai_service import GovernanceAIService
            GovernanceAIService.record_provenance(
                dashboard_id, question, prov_refs, grounded=bool(prov_refs),
            )
    except Exception:  # noqa: BLE001
        logger.warning("knowledge_context: provenance record failed", exc_info=True)
    return "\n\n".join(parts)
