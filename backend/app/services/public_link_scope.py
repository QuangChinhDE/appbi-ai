"""The data contract of ONE public link, as an AI tool context.

What a public link's viewer may read — the report's layered filters, the link's
🔒 / 🚫 locks and limit scopes, every page bound, the fields the link exposes
and the link's snapshot freshness — is resolved by the public router
(``app/api/public.py``), where the link's whole structure-shaping lives. Every
caller that runs the AI "as this link" must get THAT context, never a second
approximation of it:

* the public chatbot / recon / briefing / explore endpoints (the live viewer);
* the Agent Flow Studio's Test button (``agent_flows.api.test_flow``), which
  presents itself as testing a flow ON a link — it ran with no link filter at
  all, so the author was shown the unrestricted report's numbers.

The Studio lives in ``app/modules``, which may not import ``app/api`` (the
layer rules invert otherwise). So the contract is owned HERE, in the service
layer: the public router registers its builder at import time and every caller
asks this module. Nothing registered (the public router not loaded) is a
refusal — never a context without the link's bounds.
"""
from __future__ import annotations

from typing import Any, Callable, Optional

#: (db, dashboard, filters_config, appearance_config, viewer_filters, context_for_log, **ctx_kwargs) → ToolContext
_BUILDER: Optional[Callable[..., Any]] = None


class LinkScopeUnavailable(RuntimeError):
    """No public-link scope builder is registered: the link's data contract
    cannot be resolved, so nothing may run as that link."""


def register_link_context_builder(builder: Callable[..., Any]) -> None:
    global _BUILDER
    _BUILDER = builder


def link_tool_context(
    db: Any,
    *,
    dashboard: Any,
    filters_config: Optional[list] = None,
    appearance_config: Optional[dict] = None,
    viewer_filters: Optional[list] = None,
    context_for_log: str = "link_context",
    **ctx_kwargs: Any,
) -> Any:
    """The ToolContext a viewer of the link with ``filters_config`` /
    ``appearance_config`` gets: the same merge, page scope, exposed fields and
    freshness as the link's own tiles."""
    if _BUILDER is None:
        raise LinkScopeUnavailable("public link scope is not available in this process")
    return _BUILDER(
        db, dashboard, list(filters_config or []), dict(appearance_config or {}),
        [f for f in (viewer_filters or []) if isinstance(f, dict)],
        context_for_log=context_for_log, **ctx_kwargs,
    )
