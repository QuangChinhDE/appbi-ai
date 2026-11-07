"""The publisher's switch for a public link's Claude access (`appearance_config.mcp_access`).

Owner decisions (docs/features/public-read-mcp/spec.md, D1-D3):
- OFF by default, per link: a link serves a customer's Claude only when its publisher
  turns it on;
- the publisher guide reaches the external Claude only when `share_guide` is on;
- `keep_history` (default ON, the publisher may turn it off): the viewer's Claude
  conversation on this link is kept in AppBI's AI Bot turn tables (questions, answers,
  report tools used, view state — never a credential), with a notice shown in the chat;
- `epoch` is the publisher's "disconnect every Claude now": raising it invalidates every
  grant minted before, without touching the link itself or its viewers.

Stored in the link's free-form appearance JSON (no migration), and never served to a
viewer as-is: a viewer payload carries only `mcp_enabled`.
"""
from __future__ import annotations

from typing import Any, Dict

KEY = "mcp_access"


def settings_of(appearance: Any) -> Dict[str, Any]:
    raw = appearance.get(KEY) if isinstance(appearance, dict) else None
    raw = raw if isinstance(raw, dict) else {}
    try:
        epoch = int(raw.get("epoch") or 0)
    except (TypeError, ValueError):
        epoch = 0
    return {"enabled": raw.get("enabled") is True, "share_guide": raw.get("share_guide") is True,
            "keep_history": raw.get("keep_history") is not False, "epoch": epoch}


def enabled(appearance: Any) -> bool:
    return settings_of(appearance)["enabled"]


def for_viewer(appearance: Dict[str, Any], *, preview: bool = False) -> Dict[str, Any]:
    """The viewer-facing appearance: the switch's state only, never its settings."""
    out = dict(appearance or {})
    on = enabled(out) and not preview
    out.pop(KEY, None)
    out["mcp_enabled"] = on
    out["mcp_keeps_history"] = on and settings_of(appearance)["keep_history"]
    return out
