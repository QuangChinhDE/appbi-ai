"""Writing the evidence ledger.

Called once per executed tool. Everything here is best-effort and runs on its
OWN session: recording evidence is an observability concern and must never be
able to fail a turn the viewer is waiting on.

The interesting part is `extract_numbers`. The verifier can only confirm a
figure that appears in this list, so the extractor has to reach numbers wherever
a tool happens to put them — top-level scalars, rows of lists, nested dicts of
stats — while staying bounded so one big table doesn't write 50k floats.
"""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from app.core.config import settings

logger = logging.getLogger(__name__)

MAX_NUMBERS = 500          # per evidence row
MAX_DEPTH = 6
MAX_DIGEST_CHARS = 4000

# Keys whose values are never analytical figures — ids, indices and internal
# counters would otherwise flood `numbers` and let the verifier "confirm" a
# figure by coincidence.
_SKIP_KEYS = frozenset({
    "chart_id", "chart_a", "chart_b", "id", "index", "idx", "step_index",
    "dataset_id", "dataset_table_id", "page", "page_id", "tool_call_id",
})


def canonical_args_hash(args: Any) -> str:
    try:
        blob = json.dumps(args or {}, sort_keys=True, default=str, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        blob = repr(args)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def hash_filters(filters: Any) -> str:
    try:
        blob = json.dumps(filters or [], sort_keys=True, default=str, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        blob = repr(filters)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]


def extract_numbers(payload: Any, *, limit: int = MAX_NUMBERS) -> list[float]:
    """Every analytical number in a tool result, de-duplicated, order preserved.

    Booleans are excluded (``isinstance(True, int)`` is True in Python and a
    stray 1.0 would let the verifier confirm the wrong figure). Numeric strings
    ARE included: several tools return money as a string.
    """
    out: list[float] = []
    seen: set[float] = set()

    def _add(value: Any) -> None:
        if len(out) >= limit:
            return
        if isinstance(value, bool):
            return
        num: float | None = None
        if isinstance(value, (int, float)):
            num = float(value)
        elif isinstance(value, str):
            s = value.strip().replace(" ", "")
            if s and len(s) <= 32:
                try:
                    num = float(s)
                except ValueError:
                    return
        if num is None or num != num or num in (float("inf"), float("-inf")):
            return
        key = round(num, 6)
        if key in seen:
            return
        seen.add(key)
        out.append(num)

    def _walk(node: Any, depth: int) -> None:
        if depth > MAX_DEPTH or len(out) >= limit:
            return
        if isinstance(node, dict):
            for k, v in node.items():
                if str(k).lower() in _SKIP_KEYS:
                    continue
                _walk(v, depth + 1)
        elif isinstance(node, (list, tuple)):
            for v in node:
                _walk(v, depth + 1)
        else:
            _add(node)

    _walk(payload, 0)
    return out


def _digest(payload: Any) -> Any:
    """Scrubbed, size-capped copy of the result for human inspection."""
    try:
        from app.services.dashboard_ai_bot.thinking.agent import _scrub_for_log
        scrubbed = _scrub_for_log(payload if isinstance(payload, dict) else {"value": payload})
    except Exception:  # noqa: BLE001
        scrubbed = payload if isinstance(payload, dict) else {"value": str(payload)[:500]}
    try:
        blob = json.dumps(scrubbed, ensure_ascii=False, default=str)
        if len(blob) > MAX_DIGEST_CHARS:
            return {"_truncated": True, "preview": blob[:MAX_DIGEST_CHARS]}
        return scrubbed
    except Exception:  # noqa: BLE001
        return {"_unserialisable": True}


def _source_ref(tool_name: str, args: dict | None, result: Any) -> dict:
    ref: dict[str, Any] = {"tool": tool_name}
    args = args or {}
    for key in ("chart_id", "chart_a", "chart_b"):
        if isinstance(args.get(key), int):
            ref[key] = args[key]
    if isinstance(result, dict):
        data = result.get("data")
        if isinstance(data, dict):
            for key in ("measure", "dimension", "column", "breakdown"):
                if isinstance(data.get(key), str):
                    ref[key] = data[key]
    return ref


#: Tools whose output must NEVER become verifier evidence.
#:
#: Evidence answers one question: "did this run actually measure that number?"
#: A figure inside a document — a target, an example, last quarter quoted in a
#: memo — was written by a person, not measured from the data on screen. Record
#: it and the verifier will happily "confirm" a claim by matching it against
#: prose, which is exactly the mistake it exists to catch.
#: `web_search` / `fetch_url` are deliberately NOT here. By the same argument
#: they should be — a figure on a web page is not a measurement either — but they
#: record evidence today, and taking that away in this change would start
#: stripping legitimately web-sourced figures (an industry benchmark, say) from
#: answers, silently altering a feature this rework is not about. Their status is
#: a verifier-policy question: the verifier needs a way to attribute a claim to a
#: non-measured source rather than a binary matched/unmatched.
NON_EVIDENTIAL_TOOLS: frozenset[str] = frozenset({
    "search_knowledge",
    "read_document",
    "recall_knowledge",
    "remember_fact",
})


def record_tool_evidence(
    *,
    run_ref: str,
    dashboard_id: int,
    tool_name: str,
    args: dict | None,
    result: Any,
    node_key: str | None = None,
    link_token: str | None = None,
    session_key: str | None = None,
    filter_hash: str | None = None,
) -> int | None:
    """Persist one evidence row. Returns its id, or None when disabled/failed.

    Opens its OWN session: the turn's request-scoped session may already be
    mid-transaction, and a bookkeeping write must never join — let alone fail —
    the transaction the viewer's answer depends on.
    """
    if not settings.INTELLIGENCE_EVIDENCE_ENABLED:
        return None
    if tool_name in NON_EVIDENTIAL_TOOLS:
        return None
    try:
        from app.core.database import SessionLocal
        from app.models.ai_evidence import AiEvidence

        ok = True
        payload_for_numbers: Any = result
        row_count: int | None = None
        truncated = False
        if isinstance(result, dict):
            ok = bool(result.get("ok", True))
            data = result.get("data")
            payload_for_numbers = data if data is not None else result
            if isinstance(data, dict):
                for key in ("total_rows", "row_count", "rows_returned"):
                    if isinstance(data.get(key), int):
                        row_count = data[key]
                        break
                truncated = bool(data.get("truncated"))

        db = SessionLocal()
        try:
            row = AiEvidence(
                run_ref=run_ref,
                node_key=node_key,
                dashboard_id=dashboard_id,
                link_token=link_token,
                session_key=session_key,
                tool_name=tool_name,
                args_hash=canonical_args_hash(args),
                source_ref=_source_ref(tool_name, args, result),
                filter_hash=filter_hash,
                numbers=extract_numbers(payload_for_numbers) if ok else [],
                payload_digest=_digest(result),
                row_count=row_count,
                truncated=truncated,
                ok=ok,
            )
            db.add(row)
            db.commit()
            return row.id
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        logger.warning("[ai_evidence] write failed tool=%s", tool_name, exc_info=True)
        return None


def load_run_numbers(db, run_ref: str) -> list[float]:
    """Union of every number recorded for a turn — the verifier's ground truth."""
    try:
        from app.models.ai_evidence import AiEvidence

        rows = (
            db.query(AiEvidence.numbers)
            .filter(AiEvidence.run_ref == run_ref, AiEvidence.ok.is_(True))
            .all()
        )
    except Exception:  # noqa: BLE001
        logger.warning("[ai_evidence] read failed run_ref=%s", run_ref, exc_info=True)
        return []
    seen: set[float] = set()
    out: list[float] = []
    for (nums,) in rows:
        for n in nums or []:
            try:
                val = float(n)
            except (TypeError, ValueError):
                continue
            key = round(val, 6)
            if key not in seen:
                seen.add(key)
                out.append(val)
    return out


def purge_expired(db, *, ttl_days: int | None = None) -> int:
    """Retention sweep. Runs from the daily scheduler (advisory-locked)."""
    from datetime import datetime, timedelta, timezone

    from app.models.ai_evidence import AiEvidence

    days = ttl_days if ttl_days is not None else settings.INTELLIGENCE_EVIDENCE_TTL_DAYS
    if days <= 0:
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    deleted = (
        db.query(AiEvidence)
        .filter(AiEvidence.created_at < cutoff)
        .delete(synchronize_session=False)
    )
    db.commit()
    return int(deleted or 0)
