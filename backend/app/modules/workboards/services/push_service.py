"""Web Push (VAPID) for mini-app users.

Sends encrypted notifications to a Workboard app-user's subscribed devices —
e.g. "your record was reviewed". Keys come from env:

  VAPID_PUBLIC_KEY      base64url uncompressed P-256 point (browser applicationServerKey)
  VAPID_PRIVATE_KEY_B64 base64 of the PKCS8 PEM private key
  VAPID_SUBJECT         mailto: or https: contact (default mailto:admin@appbi.io)

When the env is unset, ``is_configured()`` is False and sends are silently
skipped (the rest of the app is unaffected). Dead subscriptions (404/410) are
pruned automatically on send.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import tempfile
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.modules.workboards.models import WorkboardPushSubscription

logger = logging.getLogger(__name__)

_PEM_PATH: Optional[str] = None


def get_public_key() -> Optional[str]:
    return os.environ.get("VAPID_PUBLIC_KEY") or None


def is_configured() -> bool:
    return bool(os.environ.get("VAPID_PUBLIC_KEY") and os.environ.get("VAPID_PRIVATE_KEY_B64"))


def _vapid_pem_path() -> Optional[str]:
    """Materialize the PEM private key to a temp file once (pywebpush wants a path)."""
    global _PEM_PATH
    if _PEM_PATH and os.path.exists(_PEM_PATH):
        return _PEM_PATH
    b64 = os.environ.get("VAPID_PRIVATE_KEY_B64")
    if not b64:
        return None
    try:
        pem = base64.b64decode(b64).decode()
    except Exception:
        logger.error("VAPID_PRIVATE_KEY_B64 is not valid base64")
        return None
    fd, path = tempfile.mkstemp(suffix="_vapid.pem")
    with os.fdopen(fd, "w") as f:
        f.write(pem)
    _PEM_PATH = path
    return path


def save_subscription(
    db: Session,
    workboard_id: int,
    username: str,
    subscription: Dict[str, Any],
    user_agent: Optional[str] = None,
) -> None:
    endpoint = subscription.get("endpoint")
    keys = subscription.get("keys") or {}
    p256dh = keys.get("p256dh")
    auth = keys.get("auth")
    if not (endpoint and p256dh and auth):
        raise ValueError("Subscription must include endpoint + keys.p256dh + keys.auth")
    existing = (
        db.query(WorkboardPushSubscription)
        .filter(
            WorkboardPushSubscription.workboard_id == workboard_id,
            WorkboardPushSubscription.username == username,
            WorkboardPushSubscription.endpoint == endpoint,
        )
        .first()
    )
    if existing:
        existing.p256dh = p256dh
        existing.auth = auth
        existing.user_agent = (user_agent or "")[:500] or None
    else:
        db.add(
            WorkboardPushSubscription(
                workboard_id=workboard_id,
                username=username,
                endpoint=endpoint,
                p256dh=p256dh,
                auth=auth,
                user_agent=(user_agent or "")[:500] or None,
            )
        )
    db.commit()


def delete_subscription(db: Session, workboard_id: int, endpoint: str) -> None:
    db.query(WorkboardPushSubscription).filter(
        WorkboardPushSubscription.workboard_id == workboard_id,
        WorkboardPushSubscription.endpoint == endpoint,
    ).delete(synchronize_session=False)
    db.commit()


def send_to_user(
    db: Session,
    workboard_id: int,
    username: str,
    *,
    title: str,
    body: str,
    url: Optional[str] = None,
) -> int:
    """Push to every device the user has subscribed. Returns #delivered.

    Never raises — a misconfigured/unsubscribed user just yields 0 so callers
    (e.g. the row-update path) don't have to guard.
    """
    if not is_configured() or not username:
        return 0
    try:
        from pywebpush import webpush, WebPushException  # lazy: optional dep
    except Exception:
        logger.warning("pywebpush not installed — skipping push")
        return 0
    pem = _vapid_pem_path()
    if not pem:
        return 0
    subs = (
        db.query(WorkboardPushSubscription)
        .filter(
            WorkboardPushSubscription.workboard_id == workboard_id,
            WorkboardPushSubscription.username == username,
        )
        .all()
    )
    if not subs:
        return 0
    payload = json.dumps({"title": title, "body": body, "url": url})
    subject = os.environ.get("VAPID_SUBJECT", "mailto:admin@appbi.io")
    delivered = 0
    dead: list[WorkboardPushSubscription] = []
    for s in subs:
        try:
            webpush(
                subscription_info={
                    "endpoint": s.endpoint,
                    "keys": {"p256dh": s.p256dh, "auth": s.auth},
                },
                data=payload,
                vapid_private_key=pem,
                vapid_claims={"sub": subject},
            )
            delivered += 1
        except WebPushException as exc:  # type: ignore[misc]
            code = getattr(getattr(exc, "response", None), "status_code", None)
            if code in (404, 410):
                dead.append(s)
            else:
                logger.warning("push send failed (%s): %s", code, exc)
        except Exception:
            logger.exception("push send crashed for endpoint %s", s.endpoint[:60])
    for s in dead:
        db.delete(s)
    if dead:
        db.commit()
    return delivered
