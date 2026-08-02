"""Resolving which flow serves a question, and loading it.

Binding order — public_link → dashboard → global → builtin_thinking_v1 — is what
makes the rollout non-destructive: a deployment that has configured nothing
resolves to the built-in flow, which wraps the pre-v2 agent, so behaviour is
unchanged. Configuration is opt-in, per report, and reversible by deleting a row.

A binding pointing at a DRAFT flow is ignored rather than honoured: draft flows
must never serve live traffic, and silently falling through to the next tier is
safer than failing the turn.
"""
from __future__ import annotations

import hashlib
import logging
import threading
import time
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.services.intelligence.registry.validator import parse_and_validate
from app.services.intelligence.schemas.flow import FlowGraph

logger = logging.getLogger(__name__)

BUILTIN_FLOW_KEY = "builtin_thinking_v1"

# Small TTL cache: every question resolves a binding, and the rows change only
# when somebody publishes. Short enough that a publish is visible within a
# second or two without an invalidation channel.
_CACHE_TTL_SECONDS = 60.0
_lock = threading.RLock()
_cache: dict[str, tuple[float, "ResolvedFlow | None"]] = {}


@dataclass
class ResolvedFlow:
    flow_key: str
    flow_version: int
    graph: FlowGraph
    assistant_key: str | None = None
    budget: dict | None = None
    source: str = "builtin"     # public_link | dashboard | global | builtin
    # "primary" or "canary". Only set when a rule declares a canary, so a run
    # row can be attributed to the arm that produced it.
    arm: str = "primary"


def invalidate_cache() -> None:
    """Call after any publish/binding change."""
    with _lock:
        _cache.clear()


def _cache_get(key: str):
    with _lock:
        hit = _cache.get(key)
        if hit and (time.monotonic() - hit[0]) < _CACHE_TTL_SECONDS:
            return hit[1]
        return None


def _cache_put(key: str, value) -> None:
    with _lock:
        _cache[key] = (time.monotonic(), value)


def _load_flow(db: Session, flow_key: str) -> tuple[int, FlowGraph] | None:
    """Newest PUBLISHED version of a flow, parsed and validated."""
    from app.models.ai_intelligence import AiFlowVersion

    row = (
        db.query(AiFlowVersion)
        .filter(AiFlowVersion.flow_key == flow_key, AiFlowVersion.status == "published")
        .order_by(AiFlowVersion.version.desc())
        .first()
    )
    if row is None:
        return None
    raw = dict(row.graph or {})
    if row.limits:
        raw.setdefault("limits", row.limits)
    graph, errors = parse_and_validate(raw)
    if graph is None or errors:
        # A published-but-invalid flow is a data defect. Refusing it here sends
        # the caller down the fallback path instead of half-running a broken
        # graph in front of a viewer.
        logger.error(
            "[flow] published flow '%s' v%s failed validation: %s",
            flow_key, row.version, [e.code for e in errors],
        )
        return None
    return row.version, graph


def _binding_flow_key(db: Session, surface: str, surface_ref: str | None) -> tuple[str, str, dict] | None:
    from app.models.ai_intelligence import AiAssistant, AiAssistantBinding

    binding = (
        db.query(AiAssistantBinding)
        .filter(
            AiAssistantBinding.surface == surface,
            AiAssistantBinding.surface_ref == surface_ref,
            AiAssistantBinding.enabled.is_(True),
        )
        .first()
    )
    if binding is None:
        return None
    assistant = (
        db.query(AiAssistant)
        .filter(AiAssistant.id == binding.assistant_id, AiAssistant.status == "published")
        .first()
    )
    if assistant is None:
        return None
    return assistant.key, "", assistant.budget or {}


def _pick_rule_for_intent(routing: list, intent: str | None) -> dict | None:
    """First rule whose intents match, with '*' as the catch-all."""
    fallback: dict | None = None
    for rule in routing or []:
        if not isinstance(rule, dict):
            continue
        intents = rule.get("when_intent") or []
        if not rule.get("flow"):
            continue
        if "*" in intents:
            fallback = fallback or rule
            continue
        if intent and intent in intents:
            return rule
    return fallback


def canary_bucket(flow_key: str, session_key: str | None) -> int:
    """A stable 0-99 bucket for one viewer on one rule.

    Hashing the SESSION (not the turn) is the whole point: a viewer who lands on
    the candidate flow must stay there for the rest of the conversation.
    Re-rolling per question would mix two flows inside one thread, and the
    follow-up "why did that change?" would be unanswerable.

    Salting with the flow key keeps two different rules from splitting the same
    viewers the same way, so a viewer unlucky on one rule is not automatically
    unlucky on all of them.
    """
    seed = f"{flow_key}:{session_key or 'anon'}".encode()
    return int(hashlib.sha256(seed).hexdigest()[:8], 16) % 100


def _canary_choice(rule: dict, session_key: str | None) -> tuple[str, str]:
    """(flow_key, arm) for this rule and this viewer."""
    primary = str(rule.get("flow") or "")
    candidate = rule.get("canary_flow")
    try:
        percent = int(rule.get("canary_percent") or 0)
    except (TypeError, ValueError):
        percent = 0
    percent = max(0, min(100, percent))
    if not candidate or percent <= 0 or candidate == primary:
        return primary, "primary"
    if canary_bucket(primary, session_key) < percent:
        return str(candidate), "canary"
    return primary, "primary"


def resolve_flow(
    db: Session,
    *,
    link_token: str | None,
    dashboard_id: int,
    intent: str | None = None,
    session_key: str | None = None,
) -> ResolvedFlow | None:
    """Which flow should serve this turn? None = caller should use the legacy path.

    Never raises: a resolution failure must degrade to the pre-v2 behaviour, not
    take the assistant offline.
    """
    # The session only enters the cache key because a canary splits viewers; for
    # everyone else, leaving it out keeps one cache entry per surface instead of
    # one per visitor.
    cache_key = f"{link_token or '-'}|{dashboard_id}|{intent or '-'}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    session_cache_key = f"{cache_key}|s:{session_key or '-'}"
    cached = _cache_get(session_cache_key)
    if cached is not None:
        return cached

    try:
        from app.models.ai_intelligence import AiAssistant

        tiers = [
            ("public_link", link_token),
            ("dashboard", str(dashboard_id)),
            ("global", None),
        ]
        for surface, ref in tiers:
            if surface == "public_link" and not ref:
                continue
            found = _binding_flow_key(db, surface, ref)
            if found is None:
                continue
            assistant_key, _unused, budget = found
            assistant = (
                db.query(AiAssistant).filter(AiAssistant.key == assistant_key).first()
            )
            rule = _pick_rule_for_intent(assistant.routing if assistant else [], intent)
            if rule is None:
                continue
            flow_key, arm = _canary_choice(rule, session_key)
            if not flow_key:
                continue

            loaded = _load_flow(db, flow_key)
            if loaded is None and arm == "canary":
                # A candidate that will not load must not cost anyone an answer:
                # fall back to the arm the rule was already serving.
                logger.warning(
                    "[flow] canary '%s' is unpublished/invalid — serving primary",
                    flow_key,
                )
                flow_key, arm = str(rule.get("flow")), "primary"
                loaded = _load_flow(db, flow_key)
            if loaded is None:
                logger.warning(
                    "[flow] binding %s→%s points at an unpublished/invalid flow "
                    "'%s' — falling through", surface, ref, flow_key,
                )
                continue
            version, graph = loaded
            resolved = ResolvedFlow(
                flow_key=flow_key, flow_version=version, graph=graph,
                assistant_key=assistant_key, budget=budget, source=surface, arm=arm,
            )
            # A split result is per-viewer, so it must not land in the shared
            # entry other viewers read.
            _cache_put(
                session_cache_key if rule.get("canary_flow") else cache_key, resolved,
            )
            return resolved

        # Nothing configured → the built-in flow (which wraps the legacy agent).
        loaded = _load_flow(db, BUILTIN_FLOW_KEY)
        if loaded is None:
            _cache_put(cache_key, None)
            return None
        version, graph = loaded
        resolved = ResolvedFlow(
            flow_key=BUILTIN_FLOW_KEY, flow_version=version, graph=graph, source="builtin",
        )
        _cache_put(cache_key, resolved)
        return resolved
    except Exception:  # noqa: BLE001
        logger.warning("[flow] resolve failed — using legacy path", exc_info=True)
        return None
