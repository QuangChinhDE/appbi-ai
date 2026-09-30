"""AI Keys: the provider keys Agent Flow steps run on.

Every endpoint is gated at the router by the `agent_flows` module and, per key, by
`get_effective_permission` inside the service. No response carries the secret —
there is no field for it in `credentials.serialize`.

Sharing a key uses the generic share endpoints (`/shares/ai_credential/{id}`).
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.models.user import User
from app.services.agent_flows import credentials as creds

router = APIRouter(prefix="/agent-flows/credentials", tags=["agent-flows"])

can_view = require_permission("agent_flows", "view")
can_edit = require_permission("agent_flows", "edit")


def _run(fn):
    try:
        return fn()
    except creds.CredentialError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail)


class CredentialCreate(BaseModel):
    name: str = Field(..., max_length=200)
    provider: Literal["openai", "anthropic", "gemini"]
    secret: str = Field(..., max_length=1000)
    is_default: bool | None = None


class CredentialUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    #: Blank or absent = keep the stored secret.
    secret: str | None = Field(default=None, max_length=1000)
    is_default: bool | None = None


@router.get("")
def list_credentials(
    provider: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(can_view),
) -> dict[str, Any]:
    return {"credentials": _run(lambda: creds.list_usable(db, user, provider=provider))}


@router.post("", status_code=201)
def create_credential(
    body: CredentialCreate,
    db: Session = Depends(get_db),
    user: User = Depends(can_edit),
) -> dict[str, Any]:
    return _run(lambda: creds.create(
        db, user, name=body.name, provider=body.provider, secret=body.secret,
        is_default=body.is_default,
    ))


@router.patch("/{credential_id}")
def update_credential(
    credential_id: int,
    body: CredentialUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(can_edit),
) -> dict[str, Any]:
    return _run(lambda: creds.update(
        db, user, credential_id, name=body.name, secret=body.secret, is_default=body.is_default,
    ))


@router.get("/{credential_id}/usage")
def credential_usage(
    credential_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(can_view),
) -> dict[str, Any]:
    def go():
        row = creds.get_for(db, user, credential_id, level="view")
        return {"affected": creds.usage(db, row.id)}

    return _run(go)


@router.delete("/{credential_id}")
def delete_credential(
    credential_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(can_edit),
) -> dict[str, Any]:
    return _run(lambda: creds.delete(db, user, credential_id))


@router.post("/{credential_id}/test")
async def test_credential(
    credential_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(can_view),
) -> dict[str, Any]:
    try:
        return await creds.test(db, user, credential_id)
    except creds.CredentialError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail)
