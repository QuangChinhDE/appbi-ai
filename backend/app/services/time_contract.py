"""Instants on the wire.

Timestamps in this database are naive UTC (``datetime.utcnow``). Emitted with a
bare ``isoformat()`` the browser parses them as LOCAL time, so every "data as of"
/ "refreshed" label was off by the viewer's offset (a snapshot built a minute ago
read as 7 hours old at UTC+7). Every freshness instant goes out through
``utc_iso``: an explicit ``Z`` (an aware value is converted to UTC first).
"""
from datetime import datetime, timezone
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
