"""A source failure as something a person can act on — and never a secret.

Creating a datasource already shows the driver's own reason ("password
authentication failed for user …", "database … does not exist", "could not
translate host name …"). Browsing the same source after its credential was
rotated said only "Failed to list tables." (500), and the table picker turned
that into "No tables found" — an empty source, the wrong action. Every source
browse now carries the same reason the create form does, scrubbed of the
configured secret values AND of inline secret shapes.

Redaction keeps the actionable part (host / database / user / the driver's
sentence) and removes only secret VALUES: configured secrets (found by
secret-ish key name, decrypted first since stored configs are encrypted) and
inline secret shapes (private keys, bearer tokens, key/pwd/token=… params,
long opaque API-key / JWT strings). It does not blanket-scrub every config
value — host and database names are what make the message useful.
"""
from __future__ import annotations

import re
from typing import Any

# A config key is treated as holding a secret when its name CONTAINS any of
# these — so unusual spellings (app_pwd, sa_json, bearer_tok, svc_credential)
# are caught, not only a fixed allow-list.
_SECRET_KEY_HINTS = ("password", "passwd", "pass", "pwd", "secret", "token", "key",
                     "cred", "auth", "private", "sa_json", "json")
# Keys that merely CONTAIN a hint but are not secrets (don't scrub their value).
_SECRET_KEY_FALSE = ("schema", "keyspace", "key_column", "keys", "key_field",
                     "primary_key", "foreign_key", "sort_key", "partition_key")
_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
    re.compile(r"(?i)(password|passwd|pwd|secret|token|api[_-]?key|key|auth)\s*[=:]\s*[^&\s\"';,}]+"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{6,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\b"),  # JWT
    re.compile(r"\b[A-Za-z0-9+/_\-]{40,}={0,2}\b"),  # long opaque token / base64 blob
    re.compile(r"\bAIza[0-9A-Za-z_\-]{10,}\b"),      # Google API key
    re.compile(r"\bsk-[A-Za-z0-9_\-]{8,}\b"),        # OpenAI-style key
)
_MIN_SECRET_LEN = 3
_MAX = 400


def _is_secret_key(key: Any) -> bool:
    k = str(key or "").lower()
    if any(f in k for f in _SECRET_KEY_FALSE):
        return False
    return any(h in k for h in _SECRET_KEY_HINTS)


def _secret_values(config: Any) -> list[str]:
    out: list[str] = []
    if isinstance(config, dict):
        for k, v in config.items():
            if isinstance(v, (dict, list)):
                out += _secret_values(v)
            elif isinstance(v, str) and len(v) >= _MIN_SECRET_LEN and _is_secret_key(k):
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
        text = pat.sub(lambda m: (m.group(1) + "=••••") if (m.groups() and m.group(1)) else "••••", text)
    text = " ".join(text.split())
    return text[:_MAX]
