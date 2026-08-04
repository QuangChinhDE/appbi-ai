"""Intelligence services — the teach-the-AI knowledge types + governance spine.

Everything here follows the same shape as GovernanceService (static methods on
a stateless class, GovernanceError for API-friendly failures) and the same
philosophy as knowledge_context.py: AUTHORED data in, generic reads out, and
the AI only ever consumes Approved rows.

Governance invariant (the "single ledger"): every approval-shaped action —
an AI suggestion approved in the inbox, an in-context "Chứng thực" on an
entity page, a re-certify after binding drift, a flagged answer resolved —
writes/updates a govern_review_items row, so "what is pending and who
approved what" always has exactly one answer.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.governance import (
    GovernAIInstruction,
    GovernAIScope,
    GovernAnswerProvenance,
    GovernChangeLog,
    GovernDataCaveat,
    GovernMetric,
    GovernPlaybook,
    GovernReviewItem,
    GovernRule,
    GovernVerifiedQA,
)
from app.services.governance_service import GovernanceError

logger = logging.getLogger(__name__)

_LIFECYCLE = ("Draft", "Approved", "Deprecated")


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", s.lower()).strip()


def _iso(dt) -> str | None:
    return dt.isoformat() if dt else None


def _require(value: str | None, field: str) -> str:
    v = (value or "").strip()
    if not v:
        raise GovernanceError(422, f"Thiếu trường bắt buộc: {field}")
    return v


def _check_status(status: str | None) -> str:
    s = (status or "Draft").strip()
    if s not in _LIFECYCLE:
        raise GovernanceError(422, f"Trạng thái không hợp lệ: {s}")
    return s


class GovernanceAIService:
    # ═══ serializers ════════════════════════════════════════════════════════
    @staticmethod
    def _rule(r: GovernRule) -> dict[str, Any]:
        return {
            "id": r.id, "name": r.name,
            "condition_text": r.condition_text, "conclusion_text": r.conclusion_text,
            "exceptions_text": r.exceptions_text,
            "applies_to": r.applies_to or [], "status": r.status, "version": r.version,
            "owner": r.owner, "updated_at": _iso(r.updated_at),
        }

    @staticmethod
    def _playbook(p: GovernPlaybook) -> dict[str, Any]:
        return {
            "id": p.id, "name": p.name, "trigger_text": p.trigger_text,
            "steps": p.steps or [], "dim_priority": p.dim_priority or [],
            "expected_output": p.expected_output, "linked_metrics": p.linked_metrics or [],
            "status": p.status, "version": p.version, "owner": p.owner,
            "run_count": p.run_count, "last_run_at": _iso(p.last_run_at),
            "updated_at": _iso(p.updated_at),
        }

    @staticmethod
    def _qa(q: GovernVerifiedQA) -> dict[str, Any]:
        return {
            "id": q.id, "question": q.question, "trigger_phrases": q.trigger_phrases or [],
            "answer_md": q.answer_md, "chart_id": q.chart_id, "dashboard_id": q.dashboard_id,
            "playbook_id": q.playbook_id, "status": q.status, "as_test": bool(q.as_test),
            "owner": q.owner, "use_count": q.use_count, "last_used_at": _iso(q.last_used_at),
            "version": q.version, "updated_at": _iso(q.updated_at),
        }

    @staticmethod
    def _instruction(i: GovernAIInstruction) -> dict[str, Any]:
        return {
            "id": i.id, "scope": i.scope, "scope_id": i.scope_id,
            "content_md": i.content_md, "version": i.version, "status": i.status,
            "eval_pass_rate": i.eval_pass_rate, "created_by": i.created_by,
            "created_at": _iso(i.created_at),
        }

    @staticmethod
    def _review(r: GovernReviewItem) -> dict[str, Any]:
        return {
            "id": r.id, "entity_type": r.entity_type, "entity_id": r.entity_id,
            "action": r.action, "title": r.title, "payload": r.payload,
            "evidence": r.evidence, "confidence": r.confidence, "source": r.source,
            "status": r.status, "note": r.note, "created_by": r.created_by,
            "resolved_by": r.resolved_by, "created_at": _iso(r.created_at),
            "resolved_at": _iso(r.resolved_at),
        }

    @staticmethod
    def _caveat(c: GovernDataCaveat) -> dict[str, Any]:
        return {
            "id": c.id, "dataset_id": c.dataset_id, "title": c.title, "content": c.content,
            "always_inject": bool(c.always_inject), "status": c.status, "owner": c.owner,
            "updated_at": _iso(c.updated_at),
        }

    # ═══ change log + ledger helpers ════════════════════════════════════════
    @staticmethod
    def _log(db: Session, entity_type: str, fqn: str, action: str, summary: str,
             changed_by: str | None, snapshot: dict | None = None) -> None:
        db.add(GovernChangeLog(
            entity_type=entity_type, entity_fqn=fqn, action=action,
            summary=summary[:512], changed_by=changed_by, snapshot=snapshot,
        ))

    @staticmethod
    def _ledger(db: Session, *, entity_type: str, entity_id: int | None, action: str,
                title: str, by: str | None, status: str = "approved",
                payload: dict | None = None, evidence: str | None = None,
                source: str = "user") -> GovernReviewItem:
        """Write a review-ledger row. In-context approvals land as already-resolved
        rows (audit trail); AI suggestions land as pending."""
        item = GovernReviewItem(
            entity_type=entity_type, entity_id=entity_id, action=action,
            title=title[:512], payload=payload, evidence=evidence, source=source,
            status=status, created_by=by,
            resolved_by=by if status != "pending" else None,
            resolved_at=datetime.utcnow() if status != "pending" else None,
        )
        db.add(item)
        return item

    # ═══ Rules ═══════════════════════════════════════════════════════════════
    @staticmethod
    def list_rules(db: Session) -> list[dict[str, Any]]:
        rows = db.query(GovernRule).order_by(GovernRule.updated_at.desc()).all()
        return [GovernanceAIService._rule(r) for r in rows]

    @staticmethod
    def upsert_rule(db: Session, payload: dict[str, Any], *, changed_by: str | None = None) -> dict[str, Any]:
        rid = payload.get("id")
        row = db.query(GovernRule).filter(GovernRule.id == rid).first() if rid else None
        creating = row is None
        if creating:
            row = GovernRule()
            db.add(row)
        row.name = _require(payload.get("name"), "name")[:255]
        row.condition_text = _require(payload.get("condition_text"), "condition_text")
        row.conclusion_text = _require(payload.get("conclusion_text"), "conclusion_text")
        row.exceptions_text = payload.get("exceptions_text")
        row.applies_to = payload.get("applies_to") or []
        row.owner = payload.get("owner")
        if not creating:
            row.version = (row.version or 1) + 1
        if payload.get("status"):
            row.status = _check_status(payload.get("status"))
        db.flush()
        GovernanceAIService._log(db, "rule", f"rule.{row.id}", "create" if creating else "update",
                                 f"{'Tạo' if creating else 'Sửa'} quy tắc: {row.name}", changed_by)
        db.commit()
        db.refresh(row)
        return GovernanceAIService._rule(row)

    @staticmethod
    def delete_rule(db: Session, rule_id: int, *, changed_by: str | None = None) -> None:
        row = db.query(GovernRule).filter(GovernRule.id == rule_id).first()
        if not row:
            raise GovernanceError(404, "Không tìm thấy quy tắc")
        GovernanceAIService._log(db, "rule", f"rule.{row.id}", "delete", f"Xoá quy tắc: {row.name}", changed_by)
        db.delete(row)
        db.commit()

    # ═══ Playbooks ═══════════════════════════════════════════════════════════
    @staticmethod
    def list_playbooks(db: Session) -> list[dict[str, Any]]:
        rows = db.query(GovernPlaybook).order_by(GovernPlaybook.updated_at.desc()).all()
        return [GovernanceAIService._playbook(p) for p in rows]

    @staticmethod
    def upsert_playbook(db: Session, payload: dict[str, Any], *, changed_by: str | None = None) -> dict[str, Any]:
        pid = payload.get("id")
        row = db.query(GovernPlaybook).filter(GovernPlaybook.id == pid).first() if pid else None
        creating = row is None
        if creating:
            row = GovernPlaybook()
            db.add(row)
        row.name = _require(payload.get("name"), "name")[:255]
        row.trigger_text = _require(payload.get("trigger_text"), "trigger_text")
        steps = payload.get("steps") or []
        if not isinstance(steps, list) or not steps:
            raise GovernanceError(422, "Playbook cần ít nhất 1 bước phân tích")
        row.steps = [str(s) for s in steps if str(s).strip()]
        row.dim_priority = [str(s) for s in (payload.get("dim_priority") or []) if str(s).strip()]
        row.expected_output = payload.get("expected_output")
        row.linked_metrics = [str(s) for s in (payload.get("linked_metrics") or []) if str(s).strip()]
        row.owner = payload.get("owner")
        if not creating:
            row.version = (row.version or 1) + 1
        if payload.get("status"):
            row.status = _check_status(payload.get("status"))
        db.flush()
        GovernanceAIService._log(db, "playbook", f"playbook.{row.id}", "create" if creating else "update",
                                 f"{'Tạo' if creating else 'Sửa'} playbook: {row.name}", changed_by)
        db.commit()
        db.refresh(row)
        return GovernanceAIService._playbook(row)

    @staticmethod
    def delete_playbook(db: Session, playbook_id: int, *, changed_by: str | None = None) -> None:
        row = db.query(GovernPlaybook).filter(GovernPlaybook.id == playbook_id).first()
        if not row:
            raise GovernanceError(404, "Không tìm thấy playbook")
        GovernanceAIService._log(db, "playbook", f"playbook.{row.id}", "delete", f"Xoá playbook: {row.name}", changed_by)
        db.delete(row)
        db.commit()

    # ═══ Verified Q&A ════════════════════════════════════════════════════════
    @staticmethod
    def list_qa(db: Session) -> list[dict[str, Any]]:
        rows = db.query(GovernVerifiedQA).order_by(GovernVerifiedQA.updated_at.desc()).all()
        return [GovernanceAIService._qa(q) for q in rows]

    @staticmethod
    def upsert_qa(db: Session, payload: dict[str, Any], *, changed_by: str | None = None) -> dict[str, Any]:
        qid = payload.get("id")
        row = db.query(GovernVerifiedQA).filter(GovernVerifiedQA.id == qid).first() if qid else None
        creating = row is None
        if creating:
            row = GovernVerifiedQA()
            db.add(row)
        row.question = _require(payload.get("question"), "question")[:512]
        phrases = payload.get("trigger_phrases") or []
        row.trigger_phrases = [_fold(str(p)) for p in phrases if str(p).strip()]
        if not row.trigger_phrases:
            # question itself is always a trigger
            row.trigger_phrases = [_fold(row.question)]
        row.answer_md = _require(payload.get("answer_md"), "answer_md")
        row.chart_id = payload.get("chart_id")
        row.dashboard_id = payload.get("dashboard_id")
        row.playbook_id = payload.get("playbook_id")
        row.as_test = bool(payload.get("as_test", True))
        row.owner = payload.get("owner")
        if not creating:
            row.version = (row.version or 1) + 1
        if payload.get("status"):
            row.status = _check_status(payload.get("status"))
        db.flush()
        GovernanceAIService._log(db, "verified_qa", f"qa.{row.id}", "create" if creating else "update",
                                 f"{'Tạo' if creating else 'Sửa'} hỏi-đáp chuẩn: {row.question[:120]}", changed_by)
        db.commit()
        db.refresh(row)
        return GovernanceAIService._qa(row)

    @staticmethod
    def delete_qa(db: Session, qa_id: int, *, changed_by: str | None = None) -> None:
        row = db.query(GovernVerifiedQA).filter(GovernVerifiedQA.id == qa_id).first()
        if not row:
            raise GovernanceError(404, "Không tìm thấy hỏi-đáp chuẩn")
        GovernanceAIService._log(db, "verified_qa", f"qa.{row.id}", "delete", f"Xoá hỏi-đáp: {row.question[:120]}", changed_by)
        db.delete(row)
        db.commit()

    # ═══ certify (in-context, but ALWAYS writes the single ledger) ═══════════
    _CERT_MODELS = {"rule": GovernRule, "playbook": GovernPlaybook, "qa": GovernVerifiedQA}

    @staticmethod
    def certify(db: Session, entity_type: str, entity_id: int, *, changed_by: str | None = None) -> dict[str, Any]:
        if entity_type == "metric":
            return GovernanceAIService.certify_metric(db, entity_id, changed_by=changed_by)
        model = GovernanceAIService._CERT_MODELS.get(entity_type)
        if model is None:
            raise GovernanceError(422, f"Không chứng thực được loại: {entity_type}")
        row = db.query(model).filter(model.id == entity_id).first()
        if not row:
            raise GovernanceError(404, "Không tìm thấy đối tượng")
        row.status = "Approved"
        name = getattr(row, "name", None) or getattr(row, "question", str(entity_id))
        GovernanceAIService._ledger(db, entity_type=entity_type, entity_id=entity_id, action="certify",
                                    title=f"Chứng thực {entity_type}: {name}", by=changed_by)
        GovernanceAIService._log(db, entity_type, f"{entity_type}.{entity_id}", "status",
                                 f"Chứng thực (Approved): {name}", changed_by)
        db.commit()
        serializer = {"rule": GovernanceAIService._rule, "playbook": GovernanceAIService._playbook,
                      "qa": GovernanceAIService._qa}[entity_type]
        return serializer(row)

    @staticmethod
    def certify_metric(db: Session, metric_id: int, *, changed_by: str | None = None) -> dict[str, Any]:
        """Certify a governed metric. GATE: the physical binding must resolve —
        no certify without a valid measure binding (trust pillar)."""
        m = db.query(GovernMetric).filter(GovernMetric.id == metric_id).first()
        if not m:
            raise GovernanceError(404, "Không tìm thấy chỉ số")
        binding = GovernanceAIService.metric_binding_status(db, m)
        if binding != "ok":
            raise GovernanceError(422, "Chứng thực yêu cầu binding trỏ tới measure hợp lệ — hãy gắn measure trước.")
        m.status = "Approved"
        m.version = (m.version or 1) + 1
        GovernanceAIService._ledger(db, entity_type="metric", entity_id=m.id, action="certify",
                                    title=f"Chứng thực chỉ số: {m.display_name}", by=changed_by)
        GovernanceAIService._log(db, "metric", m.name, "status", f"Chứng thực (Approved): {m.display_name}", changed_by)
        db.commit()
        return {"id": m.id, "name": m.name, "status": m.status, "version": m.version}

    @staticmethod
    def certify_metric_by_name(db: Session, machine_name: str, *, changed_by: str | None = None) -> dict[str, Any]:
        m = db.query(GovernMetric).filter(GovernMetric.name == machine_name).first()
        if not m:
            raise GovernanceError(404, "Không tìm thấy chỉ số")
        return GovernanceAIService.certify_metric(db, m.id, changed_by=changed_by)

    @staticmethod
    def metric_binding_status(db: Session, m: GovernMetric) -> str:
        """'ok' | 'unbound' | 'unresolved' — does measure_ref resolve against the
        live semantic model? Refs come as "<view>.<measure>" (view = the
        SemanticView name / sql_table_name, e.g. "dataset_table_111.gmv") or as
        a bare measure name. String ref today; this validator prevents silent rot."""
        if not m.measure_ref:
            return "unbound"
        try:
            from app.models.semantic import SemanticView
            ref = (m.measure_ref or "").strip().lower()
            tbl_token, _, mname = ref.rpartition(".")
            mname = mname or ref

            def field_names(view) -> set[str]:
                out: set[str] = set()
                for coll in (view.measures or []), (view.dimensions or []):
                    for f in coll:
                        if isinstance(f, dict) and f.get("name"):
                            out.add(str(f["name"]).strip().lower())
                return out

            views = db.query(SemanticView).all()
            if tbl_token:
                scoped = [v for v in views
                          if (v.sql_table_name or "").strip().lower() == tbl_token
                          or (v.name or "").strip().lower() == tbl_token]
                if scoped:
                    views = scoped
            for v in views:
                if mname in field_names(v):
                    return "ok"
            return "unresolved"
        except Exception:  # noqa: BLE001
            logger.warning("metric_binding_status failed", exc_info=True)
            return "ok"  # fail-open: never block on validator errors

    # ═══ AI Instructions (versioned, scoped) ═════════════════════════════════
    @staticmethod
    def list_instructions(db: Session) -> list[dict[str, Any]]:
        rows = (
            db.query(GovernAIInstruction)
            .order_by(GovernAIInstruction.scope, GovernAIInstruction.scope_id,
                      GovernAIInstruction.version.desc())
            .all()
        )
        return [GovernanceAIService._instruction(i) for i in rows]

    @staticmethod
    def create_instruction_version(db: Session, payload: dict[str, Any], *, changed_by: str | None = None) -> dict[str, Any]:
        scope = (payload.get("scope") or "global").strip()
        if scope not in ("global", "dataset", "dashboard"):
            raise GovernanceError(422, f"Scope không hợp lệ: {scope}")
        scope_id = payload.get("scope_id")
        if scope != "global" and not scope_id:
            raise GovernanceError(422, "Scope dataset/dashboard cần scope_id")
        content = _require(payload.get("content_md"), "content_md")
        prev = (
            db.query(GovernAIInstruction)
            .filter(GovernAIInstruction.scope == scope,
                    GovernAIInstruction.scope_id == (scope_id if scope != "global" else None),
                    GovernAIInstruction.status == "active")
            .order_by(GovernAIInstruction.version.desc())
            .first()
        )
        version = (prev.version + 1) if prev else 1
        if prev:
            prev.status = "archived"
        row = GovernAIInstruction(
            scope=scope, scope_id=(scope_id if scope != "global" else None),
            content_md=content, version=version, status="active", created_by=changed_by,
        )
        db.add(row)
        GovernanceAIService._ledger(db, entity_type="instruction", entity_id=None, action="certify",
                                    title=f"Chỉ dẫn AI {scope} → v{version}", by=changed_by)
        GovernanceAIService._log(db, "instruction", f"instruction.{scope}.{scope_id or 0}", "update",
                                 f"Chỉ dẫn AI ({scope}) phiên bản v{version}", changed_by)
        db.commit()
        db.refresh(row)
        return GovernanceAIService._instruction(row)

    # ═══ Caveats ═════════════════════════════════════════════════════════════
    @staticmethod
    def list_caveats(db: Session) -> list[dict[str, Any]]:
        rows = db.query(GovernDataCaveat).order_by(GovernDataCaveat.updated_at.desc()).all()
        return [GovernanceAIService._caveat(c) for c in rows]

    @staticmethod
    def upsert_caveat(db: Session, payload: dict[str, Any], *, changed_by: str | None = None) -> dict[str, Any]:
        cid = payload.get("id")
        row = db.query(GovernDataCaveat).filter(GovernDataCaveat.id == cid).first() if cid else None
        creating = row is None
        if creating:
            row = GovernDataCaveat()
            db.add(row)
        row.title = _require(payload.get("title"), "title")[:255]
        row.content = _require(payload.get("content"), "content")
        row.dataset_id = payload.get("dataset_id")
        row.always_inject = bool(payload.get("always_inject", True))
        row.owner = payload.get("owner")
        db.flush()
        GovernanceAIService._log(db, "caveat", f"caveat.{row.id}", "create" if creating else "update",
                                 f"{'Tạo' if creating else 'Sửa'} lưu ý dữ liệu: {row.title}", changed_by)
        db.commit()
        db.refresh(row)
        return GovernanceAIService._caveat(row)

    @staticmethod
    def delete_caveat(db: Session, caveat_id: int, *, changed_by: str | None = None) -> None:
        row = db.query(GovernDataCaveat).filter(GovernDataCaveat.id == caveat_id).first()
        if not row:
            raise GovernanceError(404, "Không tìm thấy lưu ý dữ liệu")
        db.delete(row)
        db.commit()

    # ═══ AI data scope ═══════════════════════════════════════════════════════
    @staticmethod
    def get_scope(db: Session, dataset_id: int) -> dict[str, Any]:
        row = db.query(GovernAIScope).filter(GovernAIScope.dataset_id == dataset_id).first()
        return {
            "dataset_id": dataset_id,
            "excluded_columns": (row.excluded_columns if row else []) or [],
            "excluded_measures": (row.excluded_measures if row else []) or [],
        }

    @staticmethod
    def put_scope(db: Session, dataset_id: int, payload: dict[str, Any], *, changed_by: str | None = None) -> dict[str, Any]:
        row = db.query(GovernAIScope).filter(GovernAIScope.dataset_id == dataset_id).first()
        if row is None:
            row = GovernAIScope(dataset_id=dataset_id)
            db.add(row)
        row.excluded_columns = [str(c) for c in (payload.get("excluded_columns") or [])]
        row.excluded_measures = [str(m) for m in (payload.get("excluded_measures") or [])]
        row.updated_by = changed_by
        GovernanceAIService._log(db, "ai_scope", f"scope.{dataset_id}", "update",
                                 f"Phạm vi dữ liệu AI: ẩn {len(row.excluded_columns)} cột, {len(row.excluded_measures)} measure",
                                 changed_by)
        db.commit()
        return GovernanceAIService.get_scope(db, dataset_id)

    @staticmethod
    def scope_fields(db: Session, dataset_id: int) -> dict[str, Any]:
        """Available knowledge fields of a dataset for the scope editor:
        semantic measures/dimensions + dictionary-described columns."""
        measures: list[dict[str, Any]] = []
        columns: list[dict[str, Any]] = []
        try:
            from app.models.dataset import DatasetTable as _DT
            from app.models.semantic import SemanticView
            table_ids = [t.id for t in db.query(_DT).filter(_DT.dataset_id == dataset_id).all()]
            for v in db.query(SemanticView).filter(SemanticView.dataset_table_id.in_(table_ids or [-1])).all():
                for kind, coll in (("measure", v.measures or []), ("dimension", v.dimensions or [])):
                    for f in coll:
                        if isinstance(f, dict) and f.get("name"):
                            measures.append({"name": f.get("name"), "label": f.get("label") or f.get("name"), "kind": kind})
        except Exception:  # noqa: BLE001
            pass
        try:
            from app.models.dataset import Dataset, DatasetTable
            ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
            dic = (ds.dictionary or {}).get("columns") if ds and isinstance(ds.dictionary, dict) else {}
            names: set[str] = set(dic.keys()) if isinstance(dic, dict) else set()
            for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all():
                if isinstance(t.column_descriptions, dict):
                    names |= set(t.column_descriptions.keys())
            columns = [{"name": n} for n in sorted(names)]
        except Exception:  # noqa: BLE001
            pass
        return {"measures": measures, "columns": columns}

    # ═══ Review inbox (single ledger) ════════════════════════════════════════
    @staticmethod
    def list_review_items(db: Session, status: str = "pending", entity_type: str | None = None) -> list[dict[str, Any]]:
        q = db.query(GovernReviewItem)
        if status:
            q = q.filter(GovernReviewItem.status == status)
        if entity_type:
            q = q.filter(GovernReviewItem.entity_type == entity_type)
        rows = q.order_by(GovernReviewItem.created_at.desc()).limit(200).all()
        return [GovernanceAIService._review(r) for r in rows]

    @staticmethod
    def review_count(db: Session) -> int:
        return int(db.query(func.count(GovernReviewItem.id)).filter(GovernReviewItem.status == "pending").scalar() or 0)

    @staticmethod
    def create_review_item(db: Session, payload: dict[str, Any], *, created_by: str | None = None,
                           source: str = "user") -> dict[str, Any]:
        entity_type = _require(payload.get("entity_type"), "entity_type")
        item = GovernReviewItem(
            entity_type=entity_type, entity_id=payload.get("entity_id"),
            action=(payload.get("action") or "suggest"),
            title=_require(payload.get("title"), "title")[:512],
            payload=payload.get("payload"), evidence=payload.get("evidence"),
            confidence=payload.get("confidence"), source=source,
            status="pending", created_by=created_by,
        )
        db.add(item)
        db.commit()
        db.refresh(item)
        return GovernanceAIService._review(item)

    @staticmethod
    def resolve_review_item(db: Session, item_id: int, *, approve: bool,
                            resolved_by: str | None = None, note: str | None = None) -> dict[str, Any]:
        item = db.query(GovernReviewItem).filter(GovernReviewItem.id == item_id).first()
        if not item:
            raise GovernanceError(404, "Không tìm thấy mục duyệt")
        if item.status != "pending":
            raise GovernanceError(409, "Mục này đã được xử lý")
        created: dict[str, Any] | None = None
        if approve:
            created = GovernanceAIService._dispatch_approval(db, item, resolved_by)
        elif item.entity_type == "memory":
            GovernanceAIService.reject_memory(db, item)
        item.status = "approved" if approve else "rejected"
        item.resolved_by = resolved_by
        item.resolved_at = datetime.utcnow()
        if note:
            item.note = note[:512]
        db.commit()
        db.refresh(item)
        out = GovernanceAIService._review(item)
        if created:
            out["created_entity"] = created
        return out

    @staticmethod
    def _approve_memory(db: Session, item: GovernReviewItem, by: str | None) -> dict[str, Any] | None:
        """Promote a candidate AI memory to validated (P0-01).

        The bot's institutional memory lives in ai_bot_knowledge, not in a
        govern_* table, so approval here flips that row's status and applies the
        supersede the anonymous author asked for — which we deliberately did NOT
        apply at capture time (retiring an existing belief on an unverified
        claim is the most damaging thing an anonymous viewer could do).
        """
        from app.models.ai_bot_knowledge import AiBotKnowledge

        if not item.entity_id:
            raise GovernanceError(400, "Mục ghi nhớ thiếu tham chiếu tri thức")
        row = (
            db.query(AiBotKnowledge).filter(AiBotKnowledge.id == item.entity_id).first()
        )
        if row is None:
            raise GovernanceError(404, "Tri thức đã bị xoá, không thể duyệt")
        row.status = "validated"
        row.confidence = max(float(row.confidence or 0.0), 0.9)
        row.source = "user_taught"

        payload = item.payload if isinstance(item.payload, dict) else {}
        supersedes_id = payload.get("supersedes_id")
        if isinstance(supersedes_id, int) and supersedes_id != row.id:
            old = (
                db.query(AiBotKnowledge)
                .filter(
                    AiBotKnowledge.id == supersedes_id,
                    AiBotKnowledge.dashboard_id == row.dashboard_id,
                )
                .first()
            )
            if old is not None:
                old.status = "retired"
                old.superseded_by = row.id
        db.flush()
        GovernanceAIService._log(
            db, "memory", str(row.id), "approve",
            f"Duyệt tri thức AI: {(row.content or '')[:120]}", by,
        )
        return {"id": row.id, "status": row.status, "kind": row.kind}

    @staticmethod
    def reject_memory(db: Session, item: GovernReviewItem) -> None:
        """Rejecting a memory proposal retires the candidate FOR GOOD.

        The ``review_rejected`` marker matters: plain retirement can be undone by
        re-observation (that is how decay works), so without it a rejected claim
        could simply be re-taught a few times and be promoted again by the daily
        consolidate pass. store_learning reads this marker and refuses to mint a
        new candidate for the same content.
        """
        from app.models.ai_bot_knowledge import AiBotKnowledge

        if not item.entity_id:
            return
        row = db.query(AiBotKnowledge).filter(AiBotKnowledge.id == item.entity_id).first()
        if row is not None and row.status != "validated":
            row.status = "retired"
            row.evidence = {**(row.evidence or {}), "review_rejected": True}
            db.flush()

    @staticmethod
    def _dispatch_approval(db: Session, item: GovernReviewItem, by: str | None) -> dict[str, Any] | None:
        """Approving a SUGGEST item materializes the proposed entity (Approved).
        recertify → bump the bound metric; flag → optionally create a QA."""
        payload = dict(item.payload or {})
        payload["status"] = "Approved"
        try:
            if item.action == "suggest":
                if item.entity_type == "rule":
                    return GovernanceAIService.upsert_rule(db, payload, changed_by=by)
                if item.entity_type == "playbook":
                    return GovernanceAIService.upsert_playbook(db, payload, changed_by=by)
                if item.entity_type == "qa":
                    return GovernanceAIService.upsert_qa(db, payload, changed_by=by)
                if item.entity_type == "caveat":
                    return GovernanceAIService.upsert_caveat(db, payload, changed_by=by)
                if item.entity_type == "memory":
                    return GovernanceAIService._approve_memory(db, item, by)
                if item.entity_type == "metric":
                    from app.services.governance_service import GovernanceService
                    created = GovernanceService.upsert_managed_metric(db, payload, changed_by=by)
                    m = db.query(GovernMetric).filter(GovernMetric.name == created.get("name")).first()
                    if m:
                        m.status = "Approved"
                        db.flush()
                    return created
                if item.entity_type == "term":
                    from app.models.governance import Glossary
                    from app.services.governance_service import GovernanceService
                    gm = payload.get("glossary_machine")
                    if not gm:
                        g = db.query(Glossary).order_by(Glossary.id).first()
                        if g is None:
                            g = Glossary(name="business", display_name="Business", provider="user")
                            db.add(g)
                            db.flush()
                        gm = g.name
                    return GovernanceService.upsert_term(
                        db, gm,
                        payload.get("display") or payload.get("name") or item.title,
                        payload.get("machine_name"),
                        payload.get("description"),
                        payload.get("synonyms") or [],
                    )
            elif item.action == "recertify" and item.entity_type == "metric" and item.entity_id:
                m = db.query(GovernMetric).filter(GovernMetric.id == item.entity_id).first()
                if m:
                    m.status = "Approved"
                    m.version = (m.version or 1) + 1
                    GovernanceAIService._log(db, "metric", m.name, "status",
                                             f"Chứng thực lại sau binding drift: {m.display_name}", by)
                    return {"id": m.id, "name": m.name, "version": m.version}
            elif item.action == "flag" and isinstance(item.payload, dict) and item.payload.get("qa"):
                qa_payload = dict(item.payload["qa"])
                qa_payload["status"] = "Approved"
                return GovernanceAIService.upsert_qa(db, qa_payload, changed_by=by)
        except GovernanceError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("review dispatch failed", exc_info=True)
            raise GovernanceError(500, f"Không thể áp dụng mục duyệt: {exc}")
        return None

    # ═══ Cockpit overview ════════════════════════════════════════════════════
    @staticmethod
    def intelligence_overview(db: Session) -> dict[str, Any]:
        def _count(model, *filters) -> int:
            q = db.query(func.count(model.id))
            for f in filters:
                q = q.filter(f)
            return int(q.scalar() or 0)

        from app.models.governance import GlossaryTerm, GovernKnowledgeDoc

        metrics_all = db.query(GovernMetric).all()
        metrics_approved = [m for m in metrics_all if m.status == "Approved"]
        unbound = [
            {"id": m.id, "name": m.name, "display_name": m.display_name,
             "binding": GovernanceAIService.metric_binding_status(db, m), "status": m.status}
            for m in metrics_all
        ]
        unbound_bad = [u for u in unbound if u["binding"] != "ok"]

        coverage = {
            "metrics": {"approved": len(metrics_approved), "total": len(metrics_all)},
            "terms": {"approved": _count(GlossaryTerm, GlossaryTerm.status == "Approved"),
                      "total": _count(GlossaryTerm)},
            "rules": {"approved": _count(GovernRule, GovernRule.status == "Approved"),
                      "total": _count(GovernRule)},
            "playbooks": {"approved": _count(GovernPlaybook, GovernPlaybook.status == "Approved"),
                          "total": _count(GovernPlaybook)},
            "qa": {"approved": _count(GovernVerifiedQA, GovernVerifiedQA.status == "Approved"),
                   "total": _count(GovernVerifiedQA)},
            "docs": {"approved": _count(GovernKnowledgeDoc, GovernKnowledgeDoc.status == "Published"),
                     "total": _count(GovernKnowledgeDoc)},
        }
        approved_sum = sum(c["approved"] for c in coverage.values())
        total_sum = sum(c["total"] for c in coverage.values())
        readiness = round(approved_sum / total_sum * 100) if total_sum else 0

        pending = GovernanceAIService.review_count(db)
        flagged = _count(GovernReviewItem, GovernReviewItem.status == "pending",
                         GovernReviewItem.action == "flag")

        # Provenance top (30 ngày) + ungrounded questions.
        since = datetime.utcnow() - timedelta(days=30)
        prov_rows = (
            db.query(GovernAnswerProvenance)
            .filter(GovernAnswerProvenance.created_at >= since)
            .order_by(GovernAnswerProvenance.created_at.desc())
            .limit(2000).all()
        )
        agg: dict[tuple[str, str], int] = {}
        ungrounded: list[str] = []
        for p in prov_rows:
            if not p.grounded and p.question:
                ungrounded.append(p.question)
            for ref in (p.refs or []):
                if isinstance(ref, dict) and ref.get("name"):
                    key = (str(ref.get("kind") or "?"), str(ref["name"]))
                    agg[key] = agg.get(key, 0) + 1
        top_used = [
            {"kind": k, "name": n, "count": c}
            for (k, n), c in sorted(agg.items(), key=lambda kv: -kv[1])[:8]
        ]
        seen_q: list[str] = []
        for q in ungrounded:
            if q not in seen_q:
                seen_q.append(q)
        return {
            "readiness": readiness,
            "coverage": coverage,
            "pending_reviews": pending,
            "flagged": flagged,
            "answers_30d": len(prov_rows),
            "top_used": top_used,
            "ungrounded_questions": seen_q[:6],
            "unbound_metrics": unbound_bad[:8],
            "lifecycle": {
                "draft": sum(1 for u in unbound if u["status"] == "Draft"),
                "approved": len(metrics_approved),
                "deprecated": sum(1 for u in unbound if u["status"] == "Deprecated"),
                "pending_suggestions": pending,
            },
        }

    # ═══ AI compose (prompt → structured draft; user reviews inline) ══════════
    @staticmethod
    def ai_draft(db: Session, entity_type: str, prompt: str, dataset_id: int | None = None) -> dict[str, Any]:
        """Draft an Intelligence entity from a natural-language prompt. Returns a
        field dict the create modal fills in for the user to review/edit — the
        best on-ramp for non-tech authors. Grounded on real metric machine names
        so pickers resolve. Uses the shared LLMClient (OpenAI→Gemini→Anthropic)."""
        prompt = (prompt or "").strip()
        if not prompt:
            raise GovernanceError(422, "Thiếu mô tả để AI soạn.")
        from app.services.llm_client import LLMClient

        metrics = [{"machine_name": m.name, "display": m.display_name}
                   for m in db.query(GovernMetric).order_by(GovernMetric.display_name).all()][:80]
        metrics_hint = "; ".join(f"{m['display']} [{m['machine_name']}]" for m in metrics) or "(chưa có chỉ số nào)"
        dims_hint = ""
        if dataset_id:
            try:
                fields = GovernanceAIService.scope_fields(db, dataset_id)
                dims = [f["name"] for f in fields.get("measures", []) if f.get("kind") == "dimension"]
                if dims:
                    dims_hint = "; ".join(dims[:40])
            except Exception:  # noqa: BLE001
                pass

        specs: dict[str, str] = {
            "rule": (
                'Soạn một QUY TẮC nghiệp vụ để AI tuân theo khi phân tích.\n'
                'Trả JSON keys: {"name": tên ngắn gọn, "condition_text": "điều kiện (khi/nếu...)", '
                '"conclusion_text": "kết luận hoặc hành động (thì...)", "exceptions_text": chuỗi hoặc null, '
                '"applies_to": [{"kind":"metric","ref":"<machine_name TRONG danh sách>","label":"<tên hiển thị>"}]}.\n'
                f'Chỉ số có sẵn (chỉ chọn cái liên quan, ref phải khớp machine_name): {metrics_hint}'
            ),
            "playbook": (
                'Soạn một PLAYBOOK phân tích — công thức các bước AI làm khi gặp tình huống.\n'
                'Trả JSON keys: {"name": string, "trigger_text": "khi nào chạy", "steps": [chuỗi,...] các bước theo thứ tự, '
                '"dim_priority": [chuỗi,...] tên chiều ưu tiên, "expected_output": string, '
                '"linked_metrics": ["<machine_name>",...]}.\n'
                f'Chỉ số có sẵn: {metrics_hint}'
                + (f'\nChiều có sẵn (dùng cho dim_priority): {dims_hint}' if dims_hint else '')
            ),
            "qa": (
                'Soạn một HỎI-ĐÁP CHUẨN — câu hỏi + đáp án đã duyệt để AI neo vào.\n'
                'Trả JSON keys: {"question": string, "trigger_phrases": [chuỗi,...] các cách người dùng hay hỏi '
                '(viết thường, bỏ dấu câu), "answer_md": "đáp án ngắn gọn, chính xác"}.'
            ),
            "caveat": (
                'Soạn một LƯU Ý DỮ LIỆU mà AI phải luôn nhớ (độ tươi, grain, bẫy fan-out, chất lượng...).\n'
                'Trả JSON keys: {"title": tiêu đề ngắn, "content": "nội dung lưu ý"}.'
            ),
            "metric": (
                'Soạn định nghĩa một CHỈ SỐ (KPI).\n'
                'Trả JSON keys: {"name": string, "definition": string, "formula": "công thức/biểu thức", '
                '"unit": string, "grain": "daily|weekly|monthly|quarterly|yearly|point_in_time", '
                '"direction": "up_good|down_good|neutral", "synonyms": [chuỗi,...]}.'
            ),
        }
        spec = specs.get(entity_type)
        if spec is None:
            raise GovernanceError(422, f"Không hỗ trợ AI soạn cho loại: {entity_type}")

        system = ("Bạn là trợ lý quản trị tri thức cho một nền tảng BI. "
                  "Luôn trả về DUY NHẤT một JSON hợp lệ, không kèm giải thích hay markdown. "
                  "Viết nội dung bằng tiếng Việt, ngắn gọn và chính xác.")
        full = f"{spec}\n\nMÔ TẢ CỦA NGƯỜI DÙNG:\n{prompt}\n\nCHỈ trả về JSON."
        result = LLMClient.complete_json(full, system=system, max_tokens=1200)
        if not isinstance(result, dict):
            raise GovernanceError(503, "Chưa cấu hình khóa AI (OPENAI/GEMINI/ANTHROPIC) hoặc AI không phản hồi.")

        valid = {m["machine_name"] for m in metrics}
        if entity_type == "rule" and isinstance(result.get("applies_to"), list):
            result["applies_to"] = [a for a in result["applies_to"]
                                    if isinstance(a, dict) and a.get("ref") in valid][:8]
        if entity_type == "playbook" and isinstance(result.get("linked_metrics"), list):
            result["linked_metrics"] = [r for r in result["linked_metrics"] if r in valid][:8]
        return {"entity_type": entity_type, "draft": result}

    # ═══ Bot-injection helpers (called from knowledge_context; all fail-open) ═
    @staticmethod
    def active_instructions(db: Session, dataset_ids: set[int], dashboard_id: int | None) -> list[GovernAIInstruction]:
        q = db.query(GovernAIInstruction).filter(GovernAIInstruction.status == "active")
        rows = q.all()
        out = []
        for r in rows:
            if r.scope == "global":
                out.append(r)
            elif r.scope == "dataset" and r.scope_id in dataset_ids:
                out.append(r)
            elif r.scope == "dashboard" and dashboard_id and r.scope_id == dashboard_id:
                out.append(r)
        order = {"global": 0, "dataset": 1, "dashboard": 2}
        out.sort(key=lambda r: order.get(r.scope, 3))
        return out

    @staticmethod
    def guidance_for(db: Session, dataset_ids: set[int], metric_names: set[str]) -> tuple[list[GovernRule], list[GovernPlaybook]]:
        """Approved rules/playbooks whose bindings overlap this dashboard's data."""
        folded_metrics = {_fold(m) for m in metric_names}
        rules: list[GovernRule] = []
        for r in db.query(GovernRule).filter(GovernRule.status == "Approved").all():
            for a in (r.applies_to or []):
                if not isinstance(a, dict):
                    continue
                kind = a.get("kind")
                ref = _fold(str(a.get("ref") or ""))
                if kind == "dataset" and str(a.get("ref")) in {str(d) for d in dataset_ids}:
                    rules.append(r)
                    break
                if kind in ("metric", "column") and ref and ref in folded_metrics:
                    rules.append(r)
                    break
        playbooks: list[GovernPlaybook] = []
        for p in db.query(GovernPlaybook).filter(GovernPlaybook.status == "Approved").all():
            linked = {_fold(str(x)) for x in (p.linked_metrics or [])}
            if linked & folded_metrics:
                playbooks.append(p)
        return rules[:8], playbooks[:2]

    @staticmethod
    def caveats_for(db: Session, dataset_ids: set[int]) -> list[GovernDataCaveat]:
        rows = (
            db.query(GovernDataCaveat)
            .filter(GovernDataCaveat.always_inject.is_(True), GovernDataCaveat.status != "Deprecated")
            .all()
        )
        # A caveat MUST name its dataset. The clause used to be
        # `c.dataset_id is None or c.dataset_id in dataset_ids`, so an unscoped row
        # was injected into every report on the deployment — which is how "Dataset
        # Olist kết thúc 2018-10" ended up being told to reports built on other
        # data. Scoping it only in the builder would have left that path open: the
        # UI stops creating nulls, but a null arriving from an import, an older
        # environment or a direct write would still reach every answer.
        #
        # Dropping the escape means an unscoped caveat is now silently ignored
        # rather than silently universal. Of the two silences that is the safe one:
        # a warning that fails to appear is visible in the answer, a warning
        # attached to data it does not describe is not.
        return [c for c in rows if c.dataset_id is not None and c.dataset_id in dataset_ids][:8]

    @staticmethod
    def scope_exclusions(db: Session, dataset_ids: set[int]) -> tuple[set[str], set[str]]:
        cols: set[str] = set()
        measures: set[str] = set()
        if not dataset_ids:
            return cols, measures
        rows = db.query(GovernAIScope).filter(GovernAIScope.dataset_id.in_(dataset_ids)).all()
        for r in rows:
            cols |= {_fold(str(c)) for c in (r.excluded_columns or [])}
            measures |= {_fold(str(m)) for m in (r.excluded_measures or [])}
        return cols, measures

    @staticmethod
    def qa_match(db: Session, dashboard_id: int | None, question: str) -> GovernVerifiedQA | None:
        """Trigger-phrase match (folded substring, phrase >= 4 chars). Dashboard-
        scoped rows win over global rows."""
        fq = _fold(question)
        if not fq:
            return None
        rows = db.query(GovernVerifiedQA).filter(GovernVerifiedQA.status == "Approved").all()
        best: GovernVerifiedQA | None = None
        for r in rows:
            if r.dashboard_id and dashboard_id and r.dashboard_id != dashboard_id:
                continue
            for phrase in (r.trigger_phrases or []):
                p = _fold(str(phrase))
                if len(p) >= 4 and p in fq:
                    if best is None or (r.dashboard_id and not best.dashboard_id):
                        best = r
                    break
        return best

    @staticmethod
    def record_provenance(dashboard_id: int | None, question: str, refs: list[dict[str, Any]], grounded: bool) -> None:
        """Best-effort provenance write on a FRESH short session so it can never
        interfere with the caller's transaction (bot must never break)."""
        try:
            from app.core.database import SessionLocal
            s = SessionLocal()
            try:
                s.add(GovernAnswerProvenance(
                    dashboard_id=dashboard_id, question=(question or "")[:512],
                    refs=refs[:40], grounded=grounded,
                ))
                s.commit()
            finally:
                s.close()
        except Exception:  # noqa: BLE001
            logger.warning("record_provenance failed", exc_info=True)

    @staticmethod
    def bump_qa_use(qa_id: int) -> None:
        try:
            from app.core.database import SessionLocal
            s = SessionLocal()
            try:
                row = s.query(GovernVerifiedQA).filter(GovernVerifiedQA.id == qa_id).first()
                if row:
                    row.use_count = (row.use_count or 0) + 1
                    row.last_used_at = datetime.utcnow()
                    s.commit()
            finally:
                s.close()
        except Exception:  # noqa: BLE001
            logger.warning("bump_qa_use failed", exc_info=True)
