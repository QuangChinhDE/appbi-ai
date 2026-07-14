"""Personal Access Token bootstrap kit — the one credential the MCP needs.

The MCP authenticates to AppBI with a Personal Access Token (PAT). Minting a
PAT is a *bootstrap* step: it requires an interactive AppBI account (email +
password) because a PAT-authenticated call cannot create the very token it
would need to authenticate. This module holds the minting + .env-writing
logic so BOTH the in-MCP `bootstrap_personal_access_token` tool and the
standalone `bootstrap_pat.py` CLI share one implementation.

Deliberately depends on NOTHING from the MCP core so it stays importable even
when the PAT is missing/broken — it only uses httpx + the stdlib.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import httpx

# Scope keys the AppBI backend recognises for a PAT, mapped to the levels the
# full Workboard journey (Source -> Dataset -> Model -> Workboard -> Share)
# actually exercises. "full" supersets view/edit, so this is the safe default;
# callers can pass a tighter dict.
DEFAULT_SCOPES: dict[str, str] = {
    "data_sources": "full",
    "datasets": "full",
    "explore_charts": "full",
    "dashboards": "full",
    "workboards": "full",
}

# Response keys AppBI has used for the freshly-minted secret, most-likely first.
_TOKEN_KEYS = ("token", "secret", "access_token", "plaintext", "value", "pat")


def normalize_base_url(raw: str) -> str:
    """Return an ``.../api/v1`` base from a bare host or an already-suffixed URL."""
    base = str(raw or "").strip().rstrip("/")
    if not base:
        raise ValueError("base_url is required, e.g. http://localhost:8000")
    if base.endswith("/api/v1"):
        return base
    return f"{base}/api/v1"


def _extract_jwt(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    for key in ("access_token", "token", "session_token", "jwt"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def extract_token(payload: Any) -> str | None:
    """Pull the plaintext PAT secret out of a create-PAT response."""
    if not isinstance(payload, dict):
        return None
    for key in _TOKEN_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    # Some APIs nest it, e.g. {"personal_access_token": {"token": ...}}.
    for nested in payload.values():
        if isinstance(nested, dict):
            found = extract_token(nested)
            if found:
                return found
    return None


def mint_pat(
    base_url: str,
    email: str,
    password: str,
    *,
    name: str = "workboard-mcp",
    scopes: dict[str, str] | None = None,
    expires_in_days: int | None = None,
    verify_tls: bool = False,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Log in with an AppBI account and mint a Personal Access Token.

    Returns ``{"token", "base_url", "scopes", "name", "raw"}``. Raises
    ``RuntimeError`` with a human-readable message on login/mint failure.
    """
    api = normalize_base_url(base_url)
    scope_map = dict(scopes or DEFAULT_SCOPES)
    with httpx.Client(timeout=timeout, verify=verify_tls, follow_redirects=True) as client:
        # 1) Session login. AppBI has accepted both {email} and {username}.
        login_resp = None
        for body in ({"email": email, "password": password}, {"username": email, "password": password}):
            login_resp = client.post(f"{api}/auth/login", json=body)
            if login_resp.status_code < 400:
                break
        if login_resp is None or login_resp.status_code >= 400:
            detail = _safe_detail(login_resp)
            raise RuntimeError(
                f"Login failed ({getattr(login_resp, 'status_code', '?')}). "
                f"Check the email/password and base_url. Detail: {detail}"
            )
        jwt = _extract_jwt(login_resp.json() if login_resp.content else None)
        if not jwt:
            raise RuntimeError(
                "Login succeeded but no session token was returned — cannot mint a PAT."
            )

        # 2) Mint the PAT.
        pat_body: dict[str, Any] = {"name": name, "scopes": scope_map}
        if expires_in_days is not None:
            pat_body["expires_in_days"] = int(expires_in_days)
        pat_resp = client.post(
            f"{api}/auth/personal-access-tokens/",
            headers={"Authorization": f"Bearer {jwt}"},
            json=pat_body,
        )
        if pat_resp.status_code >= 400:
            raise RuntimeError(
                f"Creating the PAT failed ({pat_resp.status_code}). "
                f"Detail: {_safe_detail(pat_resp)}"
            )
        raw = pat_resp.json() if pat_resp.content else {}

    token = extract_token(raw)
    if not token:
        raise RuntimeError(
            "The PAT was created but the plaintext token was not in the response "
            f"(keys: {sorted(raw) if isinstance(raw, dict) else type(raw).__name__}). "
            "Mint it from the AppBI UI instead."
        )
    return {"token": token, "base_url": api, "scopes": scope_map, "name": name, "raw": raw}


def _safe_detail(resp: httpx.Response | None) -> str:
    if resp is None:
        return "no response"
    try:
        payload = resp.json()
        if isinstance(payload, dict):
            return str(payload.get("detail", payload))[:300]
        return str(payload)[:300]
    except ValueError:
        return (resp.text or "")[:300]


def upsert_env_vars(env_path: str | Path, updates: dict[str, str]) -> Path:
    """Set KEY=value lines in a .env file, preserving comments and other keys.

    Creates the file if missing. Existing keys are replaced in place; new keys
    are appended. Written as UTF-8 without a BOM so python-dotenv reads it.
    """
    path = Path(env_path)
    remaining = dict(updates)
    lines: list[str] = []
    if path.exists():
        lines = path.read_text(encoding="utf-8-sig").splitlines()
        for idx, line in enumerate(lines):
            stripped = line.lstrip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key = stripped.split("=", 1)[0].strip()
            if key in remaining:
                lines[idx] = f"{key}={remaining.pop(key)}"
    for key, value in remaining.items():
        lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def mask_token(token: str) -> str:
    """Return a display-safe fingerprint of a PAT (never log the full secret)."""
    token = str(token or "")
    if len(token) <= 12:
        return "***"
    return f"{token[:10]}...{token[-4:]}"


# Kept for symmetry / potential future validation of PAT shape.
_PAT_SHAPE = re.compile(r"^appbi_pat_[0-9a-f]+\.[A-Za-z0-9_\-]+$")


def looks_like_pat(token: str) -> bool:
    return bool(_PAT_SHAPE.match(str(token or "").strip()))
