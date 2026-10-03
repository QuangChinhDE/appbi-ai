"""Instants on the wire.

Timestamps in this database are naive UTC (``datetime.utcnow``). Emitted with a
bare ``isoformat()`` the browser parses them as LOCAL time, so every "data as of"
/ "refreshed" label was off by the viewer's offset (a snapshot built a minute ago
read as 7 hours old at UTC+7). Every freshness instant goes out through
``utc_iso``: an explicit ``Z`` (an aware value is converted to UTC first).
"""
import contextvars
from datetime import date, datetime, timezone
from typing import Any, Optional


def utc_iso(dt: Any) -> Optional[str]:
    """``dt`` as an ISO instant the browser reads AS UTC (…Z); None stays None."""
    if dt is None:
        return None
    if not isinstance(dt, datetime):
        return str(dt)
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.isoformat() + "Z"


# ── Relative-date anchor: one timezone, one anchor per logical report read ────
#
# "What does TODAY mean for this report?" must be an intentional product answer,
# not the server process's local clock. The whole stack emits instants in UTC
# (utc_iso), so relative-date presets resolve against an EXPLICIT app timezone
# (settings.APP_TIMEZONE, default UTC) — never naive datetime.now().
#
# And one logical report read must use ONE anchor: a dashboard whose tiles load
# across midnight must not mix "yesterday" and "today". The client stamps one
# instant per report load and sends it (X-AppBI-As-Of); a request-scoped
# contextvar carries it to the single resolution chokepoint without threading a
# parameter through the whole engine. Absent a client anchor (API, AI bot,
# scheduler), it falls back to now() in the app timezone.
_report_anchor: contextvars.ContextVar[Optional[datetime]] = contextvars.ContextVar(
    "appbi_report_anchor", default=None
)
_WARNED_BAD_TZ: set = set()


def _app_tz():
    try:
        from app.core.config import settings
        name = str(getattr(settings, "APP_TIMEZONE", "") or "UTC").strip() or "UTC"
    except Exception:
        name = "UTC"
    if name.upper() == "UTC":
        return timezone.utc
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:
        # An invalid APP_TIMEZONE must not silently change the day boundary with
        # no trace: warn (once per bad value) so a misconfiguration is visible,
        # then fall back to the safe UTC default.
        if name not in _WARNED_BAD_TZ:
            _WARNED_BAD_TZ.add(name)
            try:
                import logging
                logging.getLogger("app.time_contract").warning(
                    "APP_TIMEZONE=%r is not a valid IANA timezone; relative dates "
                    "resolve in UTC. Set a valid zone (e.g. 'UTC', 'Asia/Ho_Chi_Minh').",
                    name,
                )
            except Exception:
                pass
        return timezone.utc


def set_report_anchor(dt: Optional[datetime]):
    """Set the current request's report-read anchor (an aware instant). Returns
    the contextvar token so a dependency can reset it after the request."""
    return _report_anchor.set(dt)


def get_report_anchor() -> Optional[datetime]:
    """The current request's anchor, or None. Captured on the request thread and
    re-applied inside batch worker threads (which do not inherit contextvars)."""
    return _report_anchor.get()


def reset_report_anchor(token) -> None:
    try:
        _report_anchor.reset(token)
    except Exception:
        pass


def parse_anchor(raw: Any) -> Optional[datetime]:
    """Parse a client as-of instant (ISO 8601, 'Z' allowed) → aware datetime."""
    if not raw:
        return None
    s = str(raw).strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def current_report_date() -> date:
    """The date relative-date presets resolve against: the request's anchor (if a
    client stamped one for this logical read), else now(), both in the app
    timezone. One value for every tile of one read that shares the anchor."""
    anchor = _report_anchor.get()
    tz = _app_tz()
    if anchor is not None:
        return anchor.astimezone(tz).date()
    return datetime.now(tz).date()
