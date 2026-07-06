"""Setup / bootstrap tools — get the MCP connected before the real work.

The one thing a freshly-cloned MCP is missing is its PAT (the token it uses to
authenticate to AppBI). `bootstrap_personal_access_token` closes that gap from
INSIDE the MCP: give it an AppBI email + password and it logs in, mints a PAT
with the scopes the full journey needs, installs it into the running process
(so the very next tool call authenticates) and writes it to .env for restarts.

This is intentionally the only tool that works with no PAT configured — every
other tool authenticates with the PAT this one produces.
"""
from __future__ import annotations

import os
from typing import Any

import appbi_wb_patkit as patkit
from appbi_wb_core import ROOT, Context, _requires_confirmation, logger, tool


@tool("all")
async def bootstrap_personal_access_token(
    email: str,
    password: str,
    base_url: str | None = None,
    name: str = "workboard-mcp",
    scopes: dict[str, str] | None = None,
    expires_in_days: int | None = None,
    write_env: bool = True,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Mint an AppBI Personal Access Token and connect this MCP with it.

    Use this ONCE per machine when health_check / any tool reports `needs_pat`
    (no APPBI_PAT configured). Requires an AppBI account's email + password —
    a PAT cannot mint itself, so this is the one credential you must supply.

    On success the token is installed into the running server immediately (the
    next tool call is authenticated) and, when write_env=true, saved to .env so
    future restarts stay connected. Nothing happens until user_confirmed=true.

    Args:
        email/password: an AppBI login that can create Personal Access Tokens.
        base_url: AppBI base (e.g. http://localhost:8000). Defaults to APPBI_BASE_URL
            or http://localhost:8000.
        name: label for the token in AppBI.
        scopes: {resource: level} override; default grants full on the five
            resources the journey uses (data_sources/datasets/explore_charts/
            dashboards/workboards).
        expires_in_days: optional expiry; omit for the backend default.
        write_env: also persist APPBI_PAT/APPBI_BASE_URL to .env (recommended).
    """
    resolved_base = base_url or os.getenv("APPBI_BASE_URL") or "http://localhost:8000"
    scope_map = dict(scopes or patkit.DEFAULT_SCOPES)

    if not user_confirmed:
        return _requires_confirmation(
            "bootstrap_personal_access_token",
            {
                "will": "Log in to AppBI and mint a Personal Access Token, then "
                "connect this MCP with it.",
                "base_url": resolved_base,
                "account": email,
                "token_name": name,
                "scopes": scope_map,
                "expires_in_days": expires_in_days,
                "write_env": write_env,
                "env_path": str(ROOT / ".env") if write_env else None,
                "note": "The password is used only for this one login and is not stored.",
            },
        )

    verify_tls = str(os.getenv("APPBI_VERIFY_TLS") or "").strip().lower() in {
        "1", "true", "yes", "y", "on",
    }
    try:
        minted = patkit.mint_pat(
            resolved_base,
            email,
            password,
            name=name,
            scopes=scope_map,
            expires_in_days=expires_in_days,
            verify_tls=verify_tls,
        )
    except (RuntimeError, ValueError) as exc:
        return {
            "status": "error",
            "detail": str(exc),
            "claude_should": (
                "Tell the user the login/mint failed with this detail and ask "
                "them to double-check the AppBI email, password, and base_url."
            ),
        }

    token = minted["token"]
    api_base = minted["base_url"]

    # Make it live in THIS process so the next tool call is authenticated.
    os.environ["APPBI_PAT"] = token
    os.environ["APPBI_BASE_URL"] = api_base

    wrote_to: str | None = None
    write_error: str | None = None
    if write_env:
        try:
            path = patkit.upsert_env_vars(
                ROOT / ".env", {"APPBI_PAT": token, "APPBI_BASE_URL": api_base}
            )
            wrote_to = str(path)
        except OSError as exc:  # e.g. read-only clone; token still works this session
            write_error = str(exc)

    logger.info(
        "bootstrapped PAT %s (base=%s, wrote_env=%s)",
        patkit.mask_token(token),
        api_base,
        bool(wrote_to),
    )
    result: dict[str, Any] = {
        "status": "ok",
        "personal_access_token": token,  # returned once so it can go into a client config too
        "token_fingerprint": patkit.mask_token(token),
        "base_url": api_base,
        "scopes": minted["scopes"],
        "wrote_env": wrote_to,
        "connected_this_session": True,
        "next": "PAT is active now — call health_check to confirm, then continue the build.",
    }
    if write_error:
        result["write_env_warning"] = (
            f"Could not write .env ({write_error}); the token works this session "
            "but add it to .env or your MCP client config to persist it."
        )
    return result
