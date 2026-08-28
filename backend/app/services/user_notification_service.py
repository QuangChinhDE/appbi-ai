"""
UserNotificationService — writes to the server-side per-user notification
feed (UserNotification). This is the single place background jobs
(observability scans, snapshot builds, user invites) reach an end user,
distinct from ObservabilityAlertChannel (admin-configured email/Slack/webhook).

`dedup_key` collapses a repeating condition into ONE unread row: a monitor
that keeps breaching every scan should not spam a new row each time.

Re-notify throttle (mirrors Power BI Data Alerts' "at most once an
hour" / "at most every 24 hours" — https://learn.microsoft.com/power-bi
/create-reports/service-set-data-alerts): a caller like
schedule_source_change_check can re-check a persistently failing
condition every ~2 minutes. Without a cooldown, `created_at` would bump
to "just now" on every check and the SAME unresolved problem would keep
resurfacing as brand-new for as long as it stays broken (a 24h BigQuery
quota outage would otherwise re-notify ~720 times). The cooldown below
caps how often an already-known, still-unread notification is allowed
to visibly "bump" — the underlying row is still kept fresh (latest
error detail), it just doesn't re-surface as new every call.
"""
import logging
from datetime import datetime, timedelta
from typing import Iterable, List, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.user_notification import UserNotification

logger = logging.getLogger(__name__)

# Power BI-style fixed throttle by severity. Critical issues (revenue-facing
# dashboards silently serving stale data) can resurface hourly; everything
# else is capped at once a day — enough to stay visible without training
# the user to ignore the bell icon.
_RENOTIFY_COOLDOWN = {
    "error": timedelta(hours=1),
    "warning": timedelta(hours=24),
    "info": timedelta(hours=24),
    "success": timedelta(hours=24),
}
_DEFAULT_COOLDOWN = timedelta(hours=24)
_SEVERITY_RANK = {"success": 0, "info": 1, "warning": 2, "error": 3}


def notify_user(
    db: Session,
    user_id: UUID,
    *,
    level: str,
    title: str,
    description: Optional[str] = None,
    link: Optional[str] = None,
    source: Optional[str] = None,
    dedup_key: Optional[str] = None,
) -> UserNotification:
    """Create (or refresh) one notification for one user. Best-effort: the
    caller decides whether a failure here should break its own flow.

    Without `dedup_key`, always inserts (caller is responsible for not
    spamming — e.g. one-shot events like "user invited").

    With `dedup_key`, dedup looks at the MOST RECENT row for that key
    REGARDLESS of `read` state — deliberately, not just `read=False`.
    Marking a notification read is a UI-only signal ("I've seen this");
    it must NOT reopen the re-notify cooldown. If it did, a user who opens
    the bell (which auto-marks-all-read, see Sidebar.tsx) while a problem
    is still ongoing would cause the very next background check to find
    no unread row to dedup against and insert a brand-new one — silently
    defeating the whole cooldown every time the bell is opened. PagerDuty's
    model is the same: acknowledging/reading suppresses the badge, not the
    dedup key itself.
    """
    existing = None
    if dedup_key:
        existing = (
            db.query(UserNotification)
            .filter(
                UserNotification.user_id == user_id,
                UserNotification.dedup_key == dedup_key,
            )
            .order_by(UserNotification.created_at.desc())
            .first()
        )

    now = datetime.utcnow()

    if existing:
        cooldown = _RENOTIFY_COOLDOWN.get(level, _DEFAULT_COOLDOWN)
        stale_enough = (now - existing.created_at) >= cooldown if existing.created_at else True
        # A severity escalation (e.g. warning -> error on the same
        # condition) is treated as a genuinely new occurrence and bumps
        # immediately, same as PagerDuty re-opening escalation on a
        # severity raise.
        escalated = _SEVERITY_RANK.get(level, 0) > _SEVERITY_RANK.get(existing.level, 0)
        existing.title = title
        existing.description = description
        existing.link = link
        existing.source = source
        if stale_enough or escalated:
            existing.level = level
            existing.created_at = now
            existing.read = False
        row = existing
    else:
        row = UserNotification(
            user_id=user_id,
            level=level,
            title=title,
            description=description,
            link=link,
            source=source,
            dedup_key=dedup_key,
            created_at=now,
        )
        db.add(row)

    try:
        db.commit()
    except Exception as exc:  # noqa: BLE001 — a notification write must never break the caller
        db.rollback()
        logger.warning("[user_notification] write failed user=%s: %s", user_id, exc)
    return row


def notify_users(
    db: Session,
    user_ids: Iterable[UUID],
    *,
    level: str,
    title: str,
    description: Optional[str] = None,
    link: Optional[str] = None,
    source: Optional[str] = None,
    dedup_key: Optional[str] = None,
) -> List[UserNotification]:
    seen = set()
    rows = []
    for uid in user_ids:
        if uid is None or uid in seen:
            continue
        seen.add(uid)
        rows.append(
            notify_user(
                db, uid, level=level, title=title, description=description,
                link=link, source=source, dedup_key=dedup_key,
            )
        )
    return rows


def notification_dict(n: UserNotification) -> dict:
    return {
        "id": n.id,
        "level": n.level,
        "title": n.title,
        "description": n.description,
        "link": n.link,
        "source": n.source,
        "read": n.read,
        "createdAt": n.created_at.isoformat() if n.created_at else None,
    }
