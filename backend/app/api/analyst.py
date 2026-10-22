"""AppBI Analyst API (M2 MVP). Mounted only when ANALYST_ENABLED.

Gate (every route, router level): `analyst: view` AND `explore_charts: view` AND
the e-mail in ANALYST_PILOT_ALLOWLIST (empty = nobody). The per-Dataset decision
(EXPLORE relation, GovernAIScope) is made by the Governed Query Service on every
read. Nothing here executes SQL: `ask` goes through GQS, the ledger and the
server's budgets.

  GET  /analyst/catalog                 what this person may ask about
  POST /analyst/ask                     one turn: plan -> governed read -> answer
  POST /analyst/consents                the PERSON accepts a dropped filter
  POST /analyst/turns/{turn_id}/cancel  stop this person's running turn
"""
from __future__ import annotations

import re
import threading
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.models.user import User

def _pilot_allowlist() -> set[str]:
    from app.core.config import settings

    raw = str(getattr(settings, "ANALYST_PILOT_ALLOWLIST", "") or "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def require_analyst(user: User = Depends(require_permission("analyst", "view")),
                    _explore: User = Depends(require_permission("explore_charts", "view"))) -> User:
    """Who may use the Analyst at all: the `analyst` module permission AND
    `explore_charts: view` AND the pilot allowlist. Read from the stored user on
    every request, so a revocation applies to the next request. Which DATA a
    question may touch is decided after this, per dataset (EXPLORE relation and
    GovernAIScope in services/analyst/catalog.py)."""
    if str(getattr(user, "email", "") or "").strip().lower() not in _pilot_allowlist():
        raise HTTPException(status_code=403, detail="The Analyst pilot is not enabled for this account.")
    return user


router = APIRouter(prefix="/analyst", tags=["analyst"], dependencies=[Depends(require_analyst)])

_TURN = re.compile(r"^[0-9a-f]{32}$")
_lock = threading.Lock()
_deps = None


def _analyst_deps():
    """One ledger + one cancel watcher per worker process, started on first use."""
    global _deps
    with _lock:
        if _deps is None:
            from app.services.analyst.service import AnalystDeps, ledger_from_settings
            from app.services.governed_query.cancellation import REGISTRY
            from app.services.governed_query.ledger import CancelWatcher

            ledger = ledger_from_settings()
            CancelWatcher(ledger, REGISTRY, interval_seconds=1.0, recover_after_seconds=600).start()
            _deps = AnalystDeps(ledger=ledger, registry=REGISTRY)
        return _deps


class AskBody(BaseModel):
    question: str = Field(..., min_length=1, max_length=1000)
    turn_id: Optional[str] = None
    previous_plan: Optional[dict] = None
    drop_consent: Optional[str] = Field(None, max_length=2000)
    # The plan of the refused turn the person is accepting (see services/analyst/service.ask).
    consented_plan: Optional[dict] = None
    # The Dataset the person chose in a clarification between sources.
    dataset_id: Optional[int] = None
    # A real value picked for a filter that matched none: {plan, field, value}.
    value_choice: Optional[dict] = None
    # A metric/source picked from a clarification: the server-signed token of that option.
    choice_token: Optional[str] = Field(None, max_length=2000)


class ConsentBody(BaseModel):
    query_fingerprint: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    fields: list[str] = Field(..., min_length=1, max_length=20)


def _turn(turn_id: Optional[str]) -> Optional[str]:
    if turn_id is not None and not _TURN.match(turn_id):
        raise HTTPException(status_code=422, detail="turn_id must be 32 lowercase hex characters")
    return turn_id


@router.get("/catalog")
def catalog(db: Session = Depends(get_db),
            user: User = Depends(require_analyst)) -> dict[str, Any]:
    from app.services.analyst.catalog import discover
    from app.services.governed_query import AuthorizationContext, EffectivePrincipal

    p = EffectivePrincipal.for_user(user, surface="analyst")
    items = discover(AuthorizationContext(db=db, principal=p, user=user))
    return {"sources": [{"explore_id": c.explore_id, "dataset": c.dataset_name, "source_type": c.source_type,
                         "measures": [f.label for f in c.fields if f.kind == "measure"][:12],
                         "dimensions": [f.label for f in c.fields if f.kind == "dimension"][:12]}
                        for c in items]}


@router.post("/ask")
def ask(body: AskBody, request: Request, db: Session = Depends(get_db),
        user: User = Depends(require_analyst)) -> dict[str, Any]:
    from app.services import llm_test_budget as _budget
    from app.services.analyst.service import ask as run_turn

    if _budget.active():
        # Test harness labels for the spending ledger (ignored unless a test budget is set).
        _budget.PURPOSE.set(request.headers.get("x-appbi-test-purpose", "")[:60])
        _budget.CASE_ID.set(request.headers.get("x-appbi-test-case", "")[:60])
        _budget.RC_SHA.set(request.headers.get("x-appbi-test-rc", "")[:40])

    previous = body.previous_plan if isinstance(body.previous_plan, dict) else None
    return run_turn(db, user, body.question, _analyst_deps(), previous=previous,
                    drop_consent=body.drop_consent, turn_id=_turn(body.turn_id),
                    consented_plan=body.consented_plan if isinstance(body.consented_plan, dict) else None,
                    dataset_id=body.dataset_id,
                    value_choice=body.value_choice if isinstance(body.value_choice, dict) else None,
                    choice_token=body.choice_token)


@router.post("/consents")
def consent(body: ConsentBody,
            user: User = Depends(require_analyst)) -> dict[str, Any]:
    """Called by the person's own click in the UI. The token is bound to this
    user and this exact query; GQS verifies it and the ledger spends it once."""
    from app.core.config import settings

    if not getattr(settings, "ANALYST_DROP_CONSENT_ENABLED", False):
        raise HTTPException(status_code=403, detail="Accepting a dropped filter is not enabled in this pilot.")
    from app.services.governed_query import consent as c

    return {"drop_consent": c.issue(user_id=user.id, query_fp=body.query_fingerprint, fields=body.fields),
            "expires_in": c.DEFAULT_TTL_SECONDS}


class FeedbackBody(BaseModel):
    turn_id: str = Field(..., pattern=r"^[0-9a-f]{32}$")
    verdict: str = Field(..., pattern=r"^(up|down)$")
    comment: Optional[str] = Field(None, max_length=1000)


@router.post("/feedback", status_code=201)
def feedback(body: FeedbackBody, db: Session = Depends(get_db),
             user: User = Depends(require_analyst)) -> dict[str, Any]:
    """The person's verdict on one of THEIR answers (engineering dogfood / pilot).
    Only a turn this person ran (its ledger run id) can be rated."""
    import os

    from app.models.analyst_feedback import AnalystFeedback

    ledger = _analyst_deps().ledger
    owner = getattr(ledger, "run_owner", None)
    if owner is not None and str(owner(body.turn_id) or "") != str(user.id):
        raise HTTPException(status_code=404, detail="Unknown answer.")
    row = AnalystFeedback(user_id=user.id, turn_id=body.turn_id, verdict=body.verdict,
                          comment=(body.comment or "").strip() or None,
                          rc_sha=(os.environ.get("APPBI_BUILD_SHA") or "")[:40] or None)
    db.add(row)
    db.commit()
    return {"id": row.id}


@router.post("/turns/{turn_id}/cancel")
def cancel(turn_id: str, user: User = Depends(require_analyst)) -> dict[str, Any]:
    _turn(turn_id)
    marked = _analyst_deps().ledger.request_cancel_run(turn_id, requested_by=user.id)
    return {"cancel_requested": marked}
