"""Helpers for AI bot settings stored on dashboard public links."""
from __future__ import annotations

from fastapi import HTTPException, status


def resolve_public_ai_mode(
    appearance_config: dict | None,
    *,
    x_user_ai_mode: str | None,
) -> str:
    """Resolve the bot mode to hand the dispatcher.

    Precedence:
      1. Viewer's explicit header ("normal"/"thinking") — manual override so a
         curious user can force a depth (used while trying the router out).
      2. Admin per-link default ``ai_bot_default_mode`` ("auto"/"normal"/
         "thinking"), defaulting to "auto".
    "auto" flows through to the heuristic router in the dispatcher.
    """
    header = (x_user_ai_mode or "").strip().lower()
    if header in ("normal", "thinking"):
        return header
    admin_default = str((appearance_config or {}).get("ai_bot_default_mode") or "auto").strip().lower()
    if admin_default in ("normal", "thinking", "auto"):
        return admin_default
    return "auto"


def web_search_enabled(appearance_config: dict | None) -> bool:
    """Admin opt-in (default OFF) for the bot's domain web-search tool."""
    return bool((appearance_config or {}).get("ai_bot_web_search_enabled"))


def sanitize_report_context_note(raw_value) -> str:
    # Admin-authored system prompt that steers how the bot reads THIS report.
    # Stored under the legacy key `ai_bot_report_context_note`. Raised 1200 →
    # 4000 chars (2026-06-23) when it became a full report system prompt.
    return str(raw_value or "").strip()[:4000]


def deployment_key(preferred_provider: str = "") -> tuple[str, str]:
    """The API key this DEPLOYMENT holds, as `(key, provider)` — or `("", "")`.

    WHY THIS EXISTS
    ---------------
    An operator who puts `OPENAI_API_KEY` in the environment reasonably expects the
    assistant to work. It did not: credentials were resolved from exactly two places
    — the key a viewer pastes, and a key stored on the link — so a configured
    deployment answered every public viewer with "paste your API key", and a flow
    that was authored, published, bound and correct never ran a single turn.

    THE BLAST RADIUS, STATED
    ------------------------
    This lets an anonymous viewer spend the deployment's key. Three things already
    gate that, and none of them are implicit: the bot must be switched ON for that
    link, the link must have a flow BOUND to it with a data contract, and every turn
    is bounded by that binding's budget. An operator who wants none of it sets
    `PUBLIC_BOT_USE_DEPLOYMENT_KEY=false`.
    """
    from app.core.config import settings

    if not getattr(settings, "PUBLIC_BOT_USE_DEPLOYMENT_KEY", True):
        return "", ""

    available = [
        ("openai", (settings.OPENAI_API_KEY or "").strip()),
        ("anthropic", (settings.ANTHROPIC_API_KEY or "").strip()),
        ("gemini", (settings.GEMINI_API_KEY or "").strip()),
    ]
    wanted = (preferred_provider or "").strip().lower()
    # The link's own provider first: a link configured for Anthropic must not be
    # answered on an OpenAI key just because that one is also present.
    for name, key in available:
        if key and name == wanted:
            return key, name
    if wanted:
        return "", ""
    for name, key in available:
        if key:
            return key, name
    return "", ""


def _infer_provider_from_key(key: str) -> str | None:
    """Best-effort provider from an API key prefix.

    Safety net for links that stored a key but no provider (or where a
    viewer's default provider header would otherwise mismatch the admin key).
    """
    k = (key or "").strip()
    if k.startswith("sk-ant"):
        return "anthropic"
    if k.startswith("AIza"):
        return "gemini"
    if k.startswith("sk-"):  # incl. "sk-proj-" (OpenAI project keys)
        return "openai"
    return None


def resolve_public_ai_credentials(
    appearance_config: dict | None,
    *,
    x_user_ai_key: str | None,
    x_user_ai_provider: str | None,
    x_user_ai_model: str | None,
    missing_key_detail: str,
) -> tuple[str, str, str | None]:
    config = appearance_config or {}

    stored_key = config.get("ai_bot_key") or ""
    viewer_key = (x_user_ai_key or "").strip()
    effective_key = (viewer_key or stored_key).strip()

    # Third source, and the one an operator expects to just work: the deployment's
    # own key. Last in precedence — a viewer's key and a link's key both still win —
    # so this only ever fills the gap that used to be a hard 400.
    deployment_provider = ""
    if not effective_key:
        effective_key, deployment_provider = deployment_key(
            str(config.get("ai_bot_provider") or "").strip().lower()
        )

    if not effective_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=missing_key_detail,
        )

    # When the viewer is using the ADMIN's pre-configured key (no own key),
    # the provider/model MUST match that key — a viewer's default provider
    # header (e.g. the FE's "gemini" default) would mismatch an OpenAI key and
    # 400. So ignore viewer provider/model in that case, and fall back to
    # inferring the provider from the key prefix when the admin left it blank.
    # A key the VIEWER did not supply — the admin's, or the deployment's — must not
    # be paired with the viewer's provider/model headers: the browser's default
    # provider would mismatch the key and 400, which is the same failure this
    # function exists to prevent.
    using_stored_key = not viewer_key and bool(stored_key)
    using_deployment_key = bool(deployment_provider)
    stored_provider = (config.get("ai_bot_provider") or "").strip().lower()
    inferred = _infer_provider_from_key(effective_key)

    if using_deployment_key:
        provider = deployment_provider
    elif using_stored_key:
        provider = stored_provider or inferred or "openai"
    else:
        provider = (x_user_ai_provider or "").strip().lower() or stored_provider or inferred or "gemini"

    if provider not in ("anthropic", "openai", "gemini"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-User-Ai-Provider must be one of: anthropic, openai, gemini.",
        )

    stored_model = (config.get("ai_bot_model") or "").strip()
    if using_stored_key or using_deployment_key:
        # The link's configured model, or the provider adapter's default — NOT the
        # viewer's. A browser that remembers "gpt-5" from a previous session was
        # overriding the model an operator chose for the link, turning a 16-second
        # turn into a 91-second one on a key the operator pays for.
        model = stored_model or None
    else:
        model = ((x_user_ai_model or stored_model).strip()) or None
    if model is not None and len(model) > 120:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-User-Ai-Model is too long.",
        )

    return effective_key, provider, model


def resolve_public_ai_critique_enabled(appearance_config: dict | None) -> bool:
    """Phase 15.72 — self-critique pass is opt-in per public link.

    Default OFF. Critique doubles per-turn latency + cost and tends to
    soften sharp insights ("có thể là" sanitizer drops bullets). Admin
    can flip it on per link via appearance_config.ai_bot_critique_enabled
    when they want stricter citation/contradiction enforcement.
    """
    return bool((appearance_config or {}).get("ai_bot_critique_enabled"))
