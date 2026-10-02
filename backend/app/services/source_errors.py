"""A source failure as something a person can act on — and never a secret.

Creating a datasource already shows the driver's own reason ("password
authentication failed for user …", "database … does not exist", "could not
translate host name …"). Browsing the same source after its credential was
rotated said only "Failed to list tables." (500), and the table picker turned
that into "No tables found" — an empty source, the wrong action. Every source
browse now carries the same reason the create form does, scrubbed of the
configured secret values.
"""
from __future__ import annotations

import re
from typing import Any

_SECRET_KEYS = ("password", "private_key", "client_secret", "refresh_token", "access_token",
                "credentials_json", "service_account_json", "token")
_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
    re.compile(r"(?i)(password|pwd|secret|token|api_key|key)=[^&\s\"';]+"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{8,}"),
)
_MAX = 400


def _secret_values(config: Any) -> list[str]:
    out: list[str] = []
    if isinstance(config, dict):
        for k, v in config.items():
            if isinstance(v, (dict, list)):
                out += _secret_values(v)
            elif isinstance(v, str) and len(v) >= 4 and any(s in str(k).lower() for s in _SECRET_KEYS):
                out.append(v)
    elif isinstance(config, list):
        for v in config:
            out += _secret_values(v)
    return out


def describe_source_error(exc: Any, config: Any = None) -> str:
    """The driver's reason, without any value of the source's secrets."""
    text = str(exc or "").strip() or exc.__class__.__name__
    secrets = _secret_values(config)
    try:  # a stored config holds its secrets encrypted; the driver saw them plain
        from app.core.crypto import decrypt_config

        secrets += _secret_values(decrypt_config(config)) if isinstance(config, dict) else []
    except Exception:  # noqa: BLE001
        pass
    for secret in sorted(set(secrets), key=len, reverse=True):
        text = text.replace(secret, "••••")
    for pat in _PATTERNS:
        text = pat.sub(lambda m: (m.group(1) + "=••••") if m.groups() and m.group(1) else "••••", text)
    text = " ".join(text.split())
    return text[:_MAX]
