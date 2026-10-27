"""Where the Answer Core reads data from: one interface, two scopes.

PO directive (2026-10-28): ONE Answer Core. Its planner, grounding, filter-value
checks, ranking rules, narrative and envelope are shared by every consumer; what
differs is WHO is asking and therefore WHAT may be read:

  * `GovernedScope` - a signed-in person in AI Chat: semantic explores of the
    Datasets they may EXPLORE, read through GQS under their own principal (this
    file moves that code out of `service.ask` unchanged);
  * `answer_core.published_report.PublishedReportScope` - an anonymous viewer of
    a public link: the link's published charts, read through the same governed
    public chart path its tiles use, never wider than the link.

`service.ask` only ever talks to a scope through the methods below; it holds no
data path of its own.
"""
from __future__ import annotations

from typing import Any, Optional, Protocol

from app.services.governed_query.principal import GovernedRefusal as Refusal  # noqa: F401 - THE Core's refusal type



class DataScope(Protocol):
    #: "governed" | "published_report"
    kind: str
    #: who a signed clarification choice is bound to (a user id, a link)
    subject: str
    #: whether a dropped filter may be accepted by the asker (GQS consent)
    consent_enabled: bool

    def catalog(self) -> list: ...

    def exhausted(self) -> Optional[tuple]: ...

    def read(self, p: Any, dims, measures, filters, sorts, grains, max_rows: int) -> Any: ...

    def evidence(self, p: Any, result: Any) -> dict: ...

    def can_save(self, p: Any) -> bool: ...

    def find_value(self, p: Any, question: str, unexplained: set, used: list) -> Optional[tuple]: ...


class GovernedScope:
    """A signed-in asker: GQS under their own principal, on the `chat` surface."""

    kind = "governed"

    def __init__(self, db, user, deps, *, turn_id: str, ceiling_dataset_ids: Optional[list[int]] = None,
                 drop_consent: Optional[str] = None):
        from app.core.config import settings
        from app.services.governed_query import (AuthorizationContext, EffectivePrincipal, GovernedQueryService,
                                                 SurfaceCeiling)

        self.db, self.user, self.deps, self.turn_id = db, user, deps, turn_id
        self.drop_consent = drop_consent
        self.subject = str(user.id)
        self.consent_enabled = bool(getattr(settings, "ANALYST_DROP_CONSENT_ENABLED", False))
        self.principal = EffectivePrincipal.for_user(user, surface="chat", request_id=turn_id)
        self.authz = AuthorizationContext(db=db, principal=self.principal, user=user,
                                          ceiling=SurfaceCeiling.of(ceiling_dataset_ids))
        self.gqs = GovernedQueryService(self.authz, audit=deps.ledger, cancel_registry=deps.registry)

    def catalog(self) -> list:
        from app.services.data_core.catalog import discover

        return discover(self.authz)

    def exhausted(self) -> Optional[tuple]:
        """The per-user daily query budget, read before the paid model is asked."""
        check = getattr(self.deps.ledger, "user_day_exhausted", None)
        return check(self.principal.user_id) if check else None

    def read(self, p, dims, measures, filters, sorts, grains, max_rows: int):
        from app.core.config import settings
        from app.services.governed_query import GovernedQueryRequest, QueryBounds, RelationRef, SemanticAsk

        return self.gqs.execute(GovernedQueryRequest(
            principal=self.principal,
            relation=RelationRef(kind="semantic_explore", id=p.explore.explore_id, model_id=p.explore.model_id),
            ask=SemanticAsk(dimensions=tuple(dims), measures=tuple(measures), filters=dict(filters),
                            sorts=tuple(sorts), time_grains=dict(grains)),
            requested_bounds=QueryBounds(max_rows=max_rows, timeout_seconds=60,
                                         bq_max_bytes=int(settings.ANALYST_MAX_BQ_BYTES_PER_USER_DAY)),
            run_id=self.turn_id,
            drop_consent=self.drop_consent,
        ))

    def evidence(self, p, result) -> dict:
        ev = result.evidence
        return {
            "query_id": ev.query_id, "source": p.explore.dataset_name, "source_type": p.explore.source_type,
            "explore_id": p.explore.explore_id, "datasets": list(ev.datasets), "dialect": ev.dialect,
            "sql_fingerprint": ev.sql_fingerprint[:16], "policy_fingerprint": ev.policy_fingerprint[:16],
            "semantic_epoch": ev.semantic_epoch, "filters_applied": list(ev.filters_applied),
            "filters_dropped": list(ev.filters_dropped), "bounds": ev.bounds.as_dict(),
            "rows_returned": ev.rows_returned, "duration_ms": ev.duration_ms, "freshness": ev.freshness.mode,
        }

    def can_save(self, p) -> bool:
        """What POST /charts will decide for this person, asked BEFORE offering the
        button: `explore_charts: edit` and BUILD on the answer's Dataset. Advisory for
        the UI only - the chart API still enforces both."""
        from app.core.authz.decision import Action
        from app.core.dependencies import _normalize_permissions
        from app.models.dataset import Dataset

        level = _normalize_permissions(self.user).get("explore_charts", "none")
        if level not in ("edit", "full"):
            return False
        ds = self.db.get(Dataset, p.explore.dataset_id)
        return bool(ds is not None and self.authz.decide(Action.BUILD, ds).allowed)

    def find_value(self, p, question: str, unexplained: set, used: list) -> Optional[tuple]:
        return find_value_via(self.read, p, question, unexplained)


def find_value_via(read, p, question: str, unexplained: set) -> Optional[tuple]:
    """(ref, real value) when exactly one text field of the plan's source has a real
    value whose words are in the question and cover an unexplained word; else None.
    Each field's values are read through the scope's own `read` (bounded, governed)."""
    import re

    from app.services.data_core.catalog import is_identifier
    from app.services.data_core.grounding import fold, syllables

    qtext = " " + " ".join(w for w in re.split(r"[^0-9a-z]+", fold(question)) if w) + " "
    candidates = [f for f in p.explore.fields if f.kind == "dimension" and f.type == "string"
                  and not is_identifier(f)][:8]
    if not candidates or len(unexplained) > 4:
        return None  # each lookup is a governed read against the asker's budget: kept small
    hits = []
    for f in candidates:
        try:
            res = read(p, [f.ref], p.measures[:1], {}, [], {}, 200)
        except Exception:  # noqa: BLE001 - a refused lookup only means no value from this field
            continue
        col = next((c.name for c in res.columns if c.ref == f.ref), None)
        for r in res.rows if col else []:
            v = r.get(col)
            words = syllables(v) if isinstance(v, str) else set()
            if words and words & unexplained and \
                    f" {' '.join(w for w in re.split(r'[^0-9a-z]+', fold(v)) if w)} " in qtext:
                hits.append((f.ref, v))
    return hits[0] if len({h[0] for h in hits}) == 1 and len(hits) == 1 else None
