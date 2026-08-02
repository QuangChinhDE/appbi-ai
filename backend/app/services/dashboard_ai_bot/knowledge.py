"""Company Knowledge Base — the AI bot's institutional memory & learning loop.

This module is the engine behind "the bot as a learning employee". It:

  • CAPTURES learnings — from the bot's own high-confidence findings
    (as unproven *candidates*) and from what the user explicitly TEACHES it
    (as *validated* truth), plus feedback (up/down) signals.
  • CONSOLIDATES daily — dedupes, promotes recurring candidates to validated,
    decays stale ones, retires contradicted ones. This is where an early WRONG
    guess gets filtered out instead of being trusted forever.
  • INJECTS the top validated learnings into every turn's system prompt so the
    bot answers with growing, company-specific understanding.

Scope is per dashboard_id. No LLM is required for the core loop (deterministic
curation), so it runs reliably regardless of provider/quota; an optional LLM
enrichment pass can be layered on later.

Design refs: InsightBench (ICLR-25) grounds the analysis depth (schema-aware,
goal-driven, multi-step); the persistent-learning layer here is AppBI's
extension so the agent accrues domain expertise over time.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy.orm import Session

from app.models.ai_bot_knowledge import AiBotKnowledge

logger = logging.getLogger(__name__)

# ── Tunables ────────────────────────────────────────────────────────────────
MAX_INJECT = 12               # learnings poured into the prompt per turn
CANDIDATE_CONF = 0.5          # a fresh bot finding
TAUGHT_CONF = 0.92            # user explicitly taught it → near-certain
FEEDBACK_UP_BOOST = 0.12
FEEDBACK_DOWN_PENALTY = 0.25
RECUR_BOOST = 0.1             # each independent re-observation
PROMOTE_SUPPORT = 2          # candidate → validated once seen this many times
RETIRE_CONF = 0.2            # below this after decay → retired
STALE_DAYS = 45               # not seen in this long → decay
CONTRADICT_RETIRE = 2         # contradicted this many times → retired
MAX_CONTENT = 400
VALID_KINDS = {"concept", "fact", "insight", "preference", "correction"}

# Domain-truth first (how the company defines things), then evidence, then
# softer signals. Used to order the injected block.
_KIND_RANK = {"concept": 0, "correction": 1, "fact": 2, "insight": 3, "preference": 4}

# Decoration the bot adds to prose — stripped before storing a clean claim.
_LADDER_RE = re.compile(r"\[(?:DESC|DIAG|PRED|PRESC|HIGH|MED|LOW|WEB)\]", re.IGNORECASE)
_CHART_TOKEN_RE = re.compile(r"\[chart:\d+\]", re.IGNORECASE)
_WORD_RE = re.compile(r"[0-9A-Za-zÀ-ỹ]+", re.UNICODE)
_STOP = {
    "the", "and", "for", "with", "này", "là", "của", "và", "có", "các", "một",
    "trong", "cho", "được", "theo", "về", "đã", "những", "cao", "nhất",
}


def _now() -> datetime:
    """Timezone-aware UTC now. The knowledge columns are DateTime(timezone=True),
    so everything we write/compare must be aware to avoid naive/aware TypeErrors."""
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    """Coerce a possibly-naive datetime (older rows) to aware UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _clean_content(text: str) -> str:
    t = _LADDER_RE.sub("", text or "")
    t = _CHART_TOKEN_RE.sub("", t)
    t = t.replace("▸", "").replace("•", "").strip(" -–—\t\n")
    t = re.sub(r"\s+", " ", t).strip()
    return t[:MAX_CONTENT]


def _tokens(text: str) -> set[str]:
    return {w.lower() for w in _WORD_RE.findall(text or "") if len(w) > 2 and w.lower() not in _STOP}


def _dedupe_key(kind: str, content: str) -> str:
    """Stable key so re-observing the same learning reinforces one row.

    Uses the kind + the most salient content tokens (sorted), so trivial
    rephrasing still collapses onto the same entry.
    """
    toks = sorted(_tokens(content))[:8]
    return (kind + ":" + "_".join(toks))[:160]


# ── Capture ───────────────────────────────────────────────────────────────


def store_learning(
    db: Session,
    *,
    dashboard_id: int,
    kind: str,
    content: str,
    source: str,
    evidence: dict | None = None,
    confidence: float | None = None,
    status: str | None = None,
) -> AiBotKnowledge | None:
    """Upsert one learning. If a matching (dashboard, dedupe_key) row exists it
    is REINFORCED (support++, confidence up, last_seen refreshed) rather than
    duplicated. Returns the row (or None if content was empty)."""
    kind = (kind or "fact").strip().lower()
    if kind not in VALID_KINDS:
        kind = "fact"
    clean = _clean_content(content)
    if not clean or len(clean) < 4:
        return None
    key = _dedupe_key(kind, clean)
    now = _now()

    # An EXPLICIT status="candidate" is a hard ceiling, not a starting point:
    # it is how an anonymous caller's teaching enters the system. Without this
    # clamp the reinforce path below would still promote it (source
    # "user_taught" counts as authoritative), so re-posting the same fabricated
    # fact twice would validate it — exactly the poisoning route P0-01 closes.
    forced_candidate = status is not None and status != "validated"
    authoritative = (not forced_candidate) and source in ("user_taught", "user_feedback")
    base_conf = confidence if confidence is not None else (
        TAUGHT_CONF if (source == "user_taught" and not forced_candidate) else CANDIDATE_CONF
    )
    base_status = status or ("validated" if authoritative else "candidate")

    # A claim a human has REJECTED in the review inbox is settled. Re-teaching
    # it must not mint a fresh candidate: that candidate would accrue support
    # on each retelling and the daily consolidate pass would eventually promote
    # it, quietly undoing the rejection. Retirement from decay/contradiction is
    # different — that one may legitimately be resurrected by new evidence — so
    # only the review-rejected marker is treated as final.
    rejected = (
        db.query(AiBotKnowledge)
        .filter(
            AiBotKnowledge.dashboard_id == dashboard_id,
            AiBotKnowledge.dedupe_key == key,
            AiBotKnowledge.status == "retired",
        )
        .first()
    )
    if rejected is not None and (rejected.evidence or {}).get("review_rejected"):
        rejected.last_seen_at = now
        db.flush()
        return rejected

    row = (
        db.query(AiBotKnowledge)
        .filter(
            AiBotKnowledge.dashboard_id == dashboard_id,
            AiBotKnowledge.dedupe_key == key,
            AiBotKnowledge.status != "retired",
        )
        .first()
    )
    if row is not None:
        # Reinforce the existing belief.
        row.support_count = (row.support_count or 1) + 1
        row.confidence = min(0.99, (row.confidence or CANDIDATE_CONF) + RECUR_BOOST)
        row.last_seen_at = now
        if evidence:
            row.evidence = {**(row.evidence or {}), **evidence}
        # Recurrence (or an authoritative source) promotes a candidate — but
        # never when the caller forced candidate status (anonymous teaching):
        # that path is only promoted by a human approving the review item.
        if (
            not forced_candidate
            and row.status == "candidate"
            and (authoritative or row.support_count >= PROMOTE_SUPPORT)
        ):
            row.status = "validated"
        if authoritative:
            row.confidence = max(row.confidence, base_conf)
            row.source = source
        db.flush()
        return row

    row = AiBotKnowledge(
        dashboard_id=dashboard_id,
        kind=kind,
        content=clean,
        evidence=evidence or {},
        confidence=base_conf,
        status=base_status,
        source=source,
        support_count=1,
        contradiction_count=0,
        dedupe_key=key,
        created_at=now,
        last_seen_at=now,
    )
    db.add(row)
    db.flush()
    return row


_CONF_MAP = {"HIGH": 0.6, "MED": 0.45, "LOW": 0.3}


def capture_findings(
    db: Session,
    *,
    dashboard_id: int,
    findings: Iterable[dict],
    rated_down: bool = False,
) -> int:
    """Promote a turn's findings to KB candidates. HIGH/MED confidence only;
    LOW and one-liners are skipped. A rated-DOWN answer contributes nothing
    (we don't want to memorise an answer the user rejected). Returns count
    stored/reinforced."""
    if rated_down:
        return 0
    n = 0
    for f in findings or []:
        if not isinstance(f, dict):
            continue
        conf_label = str(f.get("confidence") or "").upper()
        if conf_label not in ("HIGH", "MED"):
            continue
        claim = str(f.get("claim") or "")
        clean = _clean_content(claim)
        # Skip prescriptive/action bullets and vague statements — those are
        # advice, not durable knowledge about the company.
        if not clean or len(clean) < 12:
            continue
        low = claim.lower()
        if "[presc]" in low or "đề xuất" in low or "nên " in low[:8]:
            continue
        chart_ids = [c for c in (f.get("chart_ids") or []) if isinstance(c, int)]
        ev: dict[str, Any] = {}
        if chart_ids:
            ev["chart_ids"] = chart_ids[:6]
        if f.get("metric_value") is not None:
            ev["metric_value"] = f.get("metric_value")
        row = store_learning(
            db,
            dashboard_id=dashboard_id,
            kind="insight",
            content=clean,
            source="bot_finding",
            evidence=ev or None,
            confidence=_CONF_MAP.get(conf_label, CANDIDATE_CONF),
        )
        if row is not None:
            n += 1
    return n


def record_correction(
    db: Session,
    *,
    dashboard_id: int,
    content: str,
    supersedes_id: int | None = None,
    evidence: dict | None = None,
    status: str = "validated",
) -> AiBotKnowledge | None:
    """Store a user/self correction and retire the belief it replaces (if given).

    ``status`` defaults to validated for AUTHENTICATED authors. An anonymous
    public viewer must pass ``status="candidate"`` — a correction is the most
    dangerous kind of learning to take on trust, because it also RETIRES an
    existing belief. When it is only a candidate we therefore leave the old row
    alone until a human approves the replacement.
    """
    row = store_learning(
        db,
        dashboard_id=dashboard_id,
        kind="correction",
        content=content,
        source="user_taught",
        evidence=evidence,
        confidence=TAUGHT_CONF if status == "validated" else CANDIDATE_CONF,
        status=status,
    )
    if status != "validated":
        return row
    if supersedes_id and row is not None:
        old = db.query(AiBotKnowledge).filter(
            AiBotKnowledge.id == supersedes_id,
            AiBotKnowledge.dashboard_id == dashboard_id,
        ).first()
        if old is not None:
            old.status = "retired"
            old.superseded_by = row.id
            db.flush()
    return row


def apply_feedback(db: Session, *, dashboard_id: int, claim_text: str, positive: bool) -> None:
    """Nudge KB entries matching a rated answer. Up-vote boosts + validates;
    down-vote penalises and may retire a shaky candidate."""
    key_tokens = _tokens(claim_text)
    if not key_tokens:
        return
    rows = (
        db.query(AiBotKnowledge)
        .filter(AiBotKnowledge.dashboard_id == dashboard_id, AiBotKnowledge.status != "retired")
        .all()
    )
    for r in rows:
        overlap = len(key_tokens & _tokens(r.content)) / max(1, len(key_tokens))
        if overlap < 0.5:
            continue
        if positive:
            r.confidence = min(0.99, (r.confidence or 0.5) + FEEDBACK_UP_BOOST)
            if r.status == "candidate":
                r.status = "validated"
        else:
            r.confidence = max(0.0, (r.confidence or 0.5) - FEEDBACK_DOWN_PENALTY)
            r.contradiction_count = (r.contradiction_count or 0) + 1
            if r.confidence < RETIRE_CONF or r.contradiction_count >= CONTRADICT_RETIRE:
                r.status = "retired"
    db.flush()


# ── Retrieve + inject ───────────────────────────────────────────────────────


def _recency_factor(last_seen: datetime | None) -> float:
    ls = _aware(last_seen)
    if not ls:
        return 0.5
    age_days = max(0.0, (_now() - ls).total_seconds() / 86400.0)
    # 1.0 today → ~0.5 at 60 days.
    return 1.0 / (1.0 + age_days / 60.0)


def retrieve(
    db: Session, *, dashboard_id: int, question: str = "", limit: int = MAX_INJECT
) -> list[AiBotKnowledge]:
    """Top validated learnings for this dashboard, ranked by
    kind-priority → relevance(question) → confidence → recency."""
    rows = (
        db.query(AiBotKnowledge)
        .filter(
            AiBotKnowledge.dashboard_id == dashboard_id,
            AiBotKnowledge.status == "validated",
        )
        .all()
    )
    if not rows:
        return []
    q_tokens = _tokens(question)

    def score(r: AiBotKnowledge) -> tuple:
        overlap = 0.0
        if q_tokens:
            overlap = len(q_tokens & _tokens(r.content)) / len(q_tokens)
        rel = (float(r.confidence or 0.5) * _recency_factor(r.last_seen_at)) * (1.0 + overlap)
        # Sort: lower kind-rank first, then higher relevance.
        return (_KIND_RANK.get(r.kind, 5), -rel)

    rows.sort(key=score)
    return rows[:limit]


_KIND_LABEL = {
    "concept": "KHÁI NIỆM",
    "correction": "ĐÍNH CHÍNH",
    "fact": "SỰ THẬT",
    "insight": "NHẬN ĐỊNH",
    "preference": "SỞ THÍCH USER",
}


def build_knowledge_prompt_block(db: Session, *, dashboard_id: int, question: str = "") -> str:
    """The '🧠 what I've learned about this company' block injected each turn.
    Empty string when nothing validated yet."""
    rows = retrieve(db, dashboard_id=dashboard_id, question=question)
    if not rows:
        # No accumulated knowledge yet — still advertise the learning ability so
        # the bot knows it CAN become smarter about this company over time.
        return (
            "═══ 🧠 BỘ NHỚ CÔNG TY (đang học) ═══\n"
            "Chưa có kiến thức tích luỹ cho báo cáo này. Khi người dùng DẠY bạn một "
            "khái niệm/quy ước/cách tính một chỉ số, hay một sự thật bền vững về công "
            "ty, hãy gọi tool `remember_fact` để ghi nhớ LÂU DÀI cho các phiên sau. "
            "Nếu phát hiện một điều đã học trước đây là sai, gọi `remember_fact` với "
            "kind='correction'."
        )
    lines = [
        "═══ 🧠 ĐIỀU TÔI ĐÃ HỌC ĐƯỢC VỀ CÔNG TY / BÁO CÁO NÀY ═══",
        "(Kiến thức tích luỹ qua các phiên trước — ƯU TIÊN dùng để hiểu đúng "
        "concept & bối cảnh. NHƯNG nếu số liệu HIỆN TẠI mâu thuẫn với một mục, "
        "hãy NÓI RÕ điều đó và tin dữ liệu hiện tại; đừng lặp lại kiến thức cũ đã sai.)",
    ]
    for r in rows:
        tag = _KIND_LABEL.get(r.kind, r.kind.upper())
        ev = r.evidence or {}
        cids = ev.get("chart_ids") or []
        cite = f" [chart:{cids[0]}]" if cids else ""
        lines.append(f"- [{tag}] {r.content}{cite}")
    lines.append(
        "Khi người dùng DẠY bạn một khái niệm/sự thật mới về công ty (vd cách "
        "tính một chỉ số, quy ước ngành, mục tiêu), hãy gọi tool `remember_fact` "
        "để ghi nhớ lâu dài. Nếu bạn phát hiện một điều đã học trước đây là SAI, "
        "gọi `remember_fact` với kind='correction'."
    )
    return "\n".join(lines)


# ── Daily reflection (deterministic consolidation) ──────────────────────────


def consolidate(db: Session, *, dashboard_id: int) -> dict:
    """The daily 'deep review'. No LLM required. Returns a small report.

    - promote candidates seen ≥ PROMOTE_SUPPORT times → validated
    - decay confidence of entries not seen in > STALE_DAYS
    - retire entries that decayed below RETIRE_CONF or were contradicted enough
    """
    rows = (
        db.query(AiBotKnowledge)
        .filter(
            AiBotKnowledge.dashboard_id == dashboard_id,
            AiBotKnowledge.status != "retired",
        )
        .all()
    )
    promoted = decayed = retired = 0
    now = _now()
    stale_before = now - timedelta(days=STALE_DAYS)
    for r in rows:
        # Promote well-supported candidates.
        if r.status == "candidate" and (r.support_count or 1) >= PROMOTE_SUPPORT:
            r.status = "validated"
            promoted += 1
        # Decay stale beliefs.
        if r.last_seen_at and _aware(r.last_seen_at) < stale_before:
            r.confidence = round(max(0.0, (r.confidence or 0.5) * 0.8), 3)
            decayed += 1
        # Retire the weak / contradicted.
        if (r.confidence or 0.0) < RETIRE_CONF or (r.contradiction_count or 0) >= CONTRADICT_RETIRE:
            r.status = "retired"
            retired += 1
    db.commit()
    report = {
        "dashboard_id": dashboard_id,
        "reviewed": len(rows),
        "promoted": promoted,
        "decayed": decayed,
        "retired": retired,
    }
    logger.info("[ai_bot_knowledge] consolidate %s", report)
    return report


# ── Tool handlers (shared by normal + thinking variants) ────────────────────
#
# Signature matches ToolFn = Callable[[ToolContext, dict], dict]. Imported +
# registered in normal/tools.py and thinking/tools.py.


def submit_memory_for_review(
    db: Session,
    *,
    row: AiBotKnowledge,
    dashboard_id: int,
    supersedes_id: int | None = None,
) -> int | None:
    """Queue a candidate learning in the SINGLE review ledger (govern_review_items).

    Deliberately reuses the existing ledger rather than adding a second
    proposals table: "what is pending and who approved what" must keep having
    exactly one answer. Returns the review item id, or None when the ledger is
    unavailable (the learning still exists as a harmless candidate).
    """
    try:
        from app.models.governance import GovernReviewItem

        existing = (
            db.query(GovernReviewItem)
            .filter(
                GovernReviewItem.entity_type == "memory",
                GovernReviewItem.entity_id == row.id,
                GovernReviewItem.status == "pending",
            )
            .first()
        )
        if existing is not None:
            return existing.id

        item = GovernReviewItem(
            entity_type="memory",
            entity_id=row.id,
            action="suggest",
            title=(row.content or "")[:512],
            payload={
                "dashboard_id": dashboard_id,
                "kind": row.kind,
                "content": row.content,
                "supersedes_id": supersedes_id,
            },
            evidence=(
                "Người xem ẩn danh dạy AI qua chat công khai — cần duyệt trước "
                "khi áp dụng cho mọi người xem."
            ),
            confidence=float(row.confidence or 0.0),
            source="ai",
            status="pending",
            created_by="public_session",
        )
        db.add(item)
        db.flush()
        return item.id
    except Exception:  # noqa: BLE001
        logger.warning("[ai_bot_knowledge] review-item enqueue failed", exc_info=True)
        return None


def tool_remember_fact(ctx, args: dict) -> dict:
    """Persist a learning the user TAUGHT (or a self-correction).

    Trust depends on WHO is teaching (P0-01):
      • authenticated in-app user → written as validated truth immediately
        (identified, audited, already inside the permission model);
      • anonymous public-link viewer → written as a CANDIDATE plus a pending
        row in govern_review_items. It is not injected into any later turn
        until somebody with ai_inbox:edit approves it.

    Commits immediately so the record survives even if the turn later errors.
    """
    from app.services.dashboard_ai_bot.tool_context import _ok, _err

    kind = str(args.get("kind") or "fact").strip().lower()
    content = str(args.get("content") or "").strip()
    if not content:
        return _err("remember_fact cần 'content' không rỗng.")
    dash_id = getattr(ctx.dashboard, "id", None)
    if not isinstance(dash_id, int):
        return _err("no dashboard scope for knowledge.")
    chart_ids = [c for c in (args.get("chart_ids") or []) if isinstance(c, int)]
    ev = {"chart_ids": chart_ids} if chart_ids else None
    raw_sup = args.get("supersedes_id")
    supersedes = int(raw_sup) if isinstance(raw_sup, (int, float)) or (
        isinstance(raw_sup, str) and raw_sup.isdigit()
    ) else None

    needs_review = getattr(ctx, "actor_type", "public_session") != "user"
    target_status = "candidate" if needs_review else "validated"

    try:
        if kind == "correction":
            row = record_correction(
                ctx.db, dashboard_id=dash_id, content=content,
                supersedes_id=supersedes, evidence=ev, status=target_status,
            )
        else:
            row = store_learning(
                ctx.db, dashboard_id=dash_id, kind=kind, content=content,
                source="user_taught", evidence=ev, status=target_status,
            )
        review_id = None
        already_rejected = row is not None and row.status == "retired"
        if row is not None and needs_review and not already_rejected:
            review_id = submit_memory_for_review(
                ctx.db, row=row, dashboard_id=dash_id, supersedes_id=supersedes,
            )
        ctx.db.commit()
    except Exception as exc:  # noqa: BLE001
        ctx.db.rollback()
        logger.warning("[ai_bot_knowledge] remember_fact failed: %s", exc)
        return _err(f"không lưu được: {type(exc).__name__}")
    if row is None:
        return _err("nội dung quá ngắn để ghi nhớ.")
    if already_rejected:
        return _ok({
            "stored": False, "id": row.id, "status": row.status,
            "note": (
                "Nội dung này đã được người phụ trách xem xét và từ chối trước đó, "
                "nên không được ghi nhớ lại. Hãy nói với người dùng rằng thông tin "
                "này cần trao đổi với người quản trị báo cáo."
            ),
        })
    if needs_review:
        return _ok({
            "stored": True, "id": row.id, "kind": row.kind, "status": row.status,
            "review_item_id": review_id,
            "note": (
                "Đã ghi nhận và gửi cho người phụ trách duyệt. Hãy nói với người "
                "dùng rằng thông tin sẽ được áp dụng sau khi được duyệt — KHÔNG "
                "khẳng định là đã ghi nhớ vĩnh viễn."
            ),
        })
    return _ok({
        "stored": True, "id": row.id, "kind": row.kind, "status": row.status,
        "note": "Đã ghi nhớ lâu dài — các phiên sau sẽ tự biết điều này.",
    })


def tool_recall_knowledge(ctx, args: dict) -> dict:
    """Search the accumulated company knowledge base (beyond the top-K already
    injected into the prompt)."""
    from app.services.dashboard_ai_bot.tool_context import _ok, _err

    dash_id = getattr(ctx.dashboard, "id", None)
    if not isinstance(dash_id, int):
        return _err("no dashboard scope for knowledge.")
    q = str(args.get("query") or "")
    rows = retrieve(ctx.db, dashboard_id=dash_id, question=q, limit=20)
    return _ok({
        "count": len(rows),
        "items": [
            {
                "kind": r.kind, "content": r.content,
                "confidence": round(float(r.confidence or 0.0), 2),
                "evidence": r.evidence or {},
            }
            for r in rows
        ],
    })


REMEMBER_FACT_TOOL_DEF: dict = {
    "name": "remember_fact",
    "description": (
        "Ghi nhớ LÂU DÀI một điều về công ty/báo cáo này để CÁC PHIÊN SAU tự biết. "
        "GỌI khi người dùng DẠY bạn: một khái niệm/quy ước/cách tính chỉ số "
        "(kind='concept'), một sự thật bền vững về công ty (kind='fact'), cách họ "
        "muốn được trả lời (kind='preference'); hoặc khi bạn nhận ra một điều đã học "
        "trước đây là SAI và cần đính chính (kind='correction', kèm supersedes_id nếu "
        "biết id cũ từ recall_knowledge). TUYỆT ĐỐI KHÔNG dùng cho số liệu một-lần, "
        "suy đoán chưa chắc, hay lời khuyên — chỉ ghi tri thức bền vững về doanh nghiệp."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": ["concept", "fact", "preference", "correction"]},
            "content": {"type": "string", "description": "Điều cần nhớ, 1-2 câu rõ ràng bằng tiếng Việt."},
            "chart_ids": {
                "type": "array", "items": {"type": "integer"},
                "description": "Biểu đồ làm bằng chứng, nếu có.",
            },
            "supersedes_id": {
                "type": "integer",
                "description": "Chỉ với kind='correction': id kiến thức cũ bị thay thế (lấy từ recall_knowledge).",
            },
        },
        "required": ["kind", "content"],
    },
}

RECALL_KNOWLEDGE_TOOL_DEF: dict = {
    "name": "recall_knowledge",
    "description": (
        "Tra cứu kho kiến thức đã tích luỹ về công ty này (khái niệm, sự thật, đính "
        "chính, nhận định đã xác nhận). Dùng khi cần xem lại điều đã học ngoài phần đã "
        "tóm tắt sẵn ở đầu prompt, ví dụ để kiểm tra một concept trước khi trả lời."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Từ khoá/câu hỏi để lọc (để trống = lấy tất cả)."},
        },
    },
}

# Learning tools are offered in BOTH variants — teaching/recall must work
# whether the router picks Normal or Thinking.
KNOWLEDGE_TOOL_DEFS: list[dict] = [REMEMBER_FACT_TOOL_DEF, RECALL_KNOWLEDGE_TOOL_DEF]
KNOWLEDGE_TOOLS = {
    "remember_fact": tool_remember_fact,
    "recall_knowledge": tool_recall_knowledge,
}


def list_knowledge(db: Session, *, dashboard_id: int, include_retired: bool = False) -> list[dict]:
    q = db.query(AiBotKnowledge).filter(AiBotKnowledge.dashboard_id == dashboard_id)
    if not include_retired:
        q = q.filter(AiBotKnowledge.status != "retired")
    rows = q.order_by(AiBotKnowledge.status.asc(), AiBotKnowledge.confidence.desc()).all()
    return [r.to_dict() for r in rows]
