"""Server-verified consent to answer with a filter dropped (I-6, PR-1F).

A filter the engine cannot apply makes the answer wider than the question. GQS
refuses `filter_would_drop` and names the filters plus a `query_fingerprint`.
Only the PERSON may accept the wider scope: an authenticated endpoint the person
calls issues a consent token, and the model never holds a way to mint one.

A token is bound to:
  * the authenticated user (a token for one person is useless to another);
  * the exact query (`query_fingerprint` over relation + ask — change a measure,
    a filter value or the grain and the token no longer applies);
  * the exact set of dropped filters it accepts (a new drop needs a new consent);
  * an expiry;
  * a nonce, consumed in the audit ledger in the SAME transaction as the
    execution's `begin` (a unique index), so a token runs at most once.

It is HMAC-signed with a key derived from SECRET_KEY. Nothing in it is secret;
it is unforgeable, not confidential.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any, Iterable, Optional

from app.services.governed_query.principal import GovernedRefusal

DEFAULT_TTL_SECONDS = 300
_VERSION = "v1"


@dataclass(frozen=True)
class DropConsent:
    nonce: str
    fields: tuple[str, ...]


def _key() -> bytes:
    from app.core.config import settings

    return hmac.new(str(settings.SECRET_KEY).encode("utf-8"), b"gqs-drop-consent-v1", hashlib.sha256).digest()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def query_fingerprint(request: Any) -> str:
    """The exact question: relation + ask. Bounds and run id are not part of it
    (a consent is about WHAT is answered, not how it is limited)."""
    rel, ask = request.relation, request.ask
    body = {
        "relation": [rel.kind, rel.id, rel.model_id],
        "dimensions": list(ask.dimensions), "measures": list(ask.measures),
        "filters": ask.filters, "sorts": list(ask.sorts), "time_grains": ask.time_grains, "limit": ask.limit,
    }
    return hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def issue(*, user_id: Any, query_fp: str, fields: Iterable[str], ttl_seconds: int = DEFAULT_TTL_SECONDS,
          now: Optional[float] = None) -> str:
    payload = {"u": str(user_id), "q": query_fp, "f": sorted({str(f) for f in fields}),
               "e": int((now if now is not None else time.time()) + ttl_seconds), "n": secrets.token_hex(16)}
    if not payload["f"]:
        raise ValueError("a consent names at least one filter")
    body = _b64(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    sig = _b64(hmac.new(_key(), f"{_VERSION}.{body}".encode("ascii"), hashlib.sha256).digest())
    return f"{_VERSION}.{body}.{sig}"


def _invalid(reason: str) -> GovernedRefusal:
    return GovernedRefusal("consent_invalid", "Xác nhận phạm vi rộng hơn không hợp lệ cho câu hỏi này.",
                           {"reason": reason})


def verify(token: str, *, user_id: Any, query_fp: str, dropped_fields: Iterable[str],
           now: Optional[float] = None) -> DropConsent:
    try:
        version, body, sig = str(token).split(".")
    except ValueError:
        raise _invalid("malformed") from None
    if version != _VERSION:
        raise _invalid("malformed")
    expected = _b64(hmac.new(_key(), f"{version}.{body}".encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, sig):
        raise _invalid("signature")
    try:
        payload = json.loads(_unb64(body))
    except Exception:  # noqa: BLE001
        raise _invalid("malformed") from None
    if payload.get("u") != str(user_id):
        raise _invalid("other_user")
    if payload.get("q") != query_fp:
        raise _invalid("other_query")
    if int(payload.get("e") or 0) < (now if now is not None else time.time()):
        raise _invalid("expired")
    if sorted({str(f) for f in dropped_fields}) != list(payload.get("f") or []):
        raise _invalid("other_filters")
    return DropConsent(nonce=str(payload["n"]), fields=tuple(payload["f"]))
