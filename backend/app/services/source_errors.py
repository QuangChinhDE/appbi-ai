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


_IPV4_RE = re.compile(r"(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])")
_IPV6_RE = re.compile(r"(?<![\w:.])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:%\w+)?(?![\w:])")


def redact_ip_literals(text: str, keep: Any = None) -> str:
    """Replace IP address literals in *text* with ``<address>``, except *keep*
    (the host the user typed). A network failure names the address the host
    RESOLVED to, which for an internal name is an internal IP the user never
    gave us; the host name itself stays, so the message is still actionable."""
    import ipaddress

    keep_s = str(keep or "").strip().strip("[]").lower()

    def _sub(m: "re.Match[str]") -> str:
        lit = m.group(0)
        try:
            ipaddress.ip_address(lit.split("%", 1)[0])
        except ValueError:
            return lit
        return lit if lit.lower() == keep_s else "<address>"

    return _IPV6_RE.sub(_sub, _IPV4_RE.sub(_sub, str(text or "")))


# ── Error classification (F16) ───────────────────────────────────────────────
# A connection-test failure is reported as one of these categories. The
# category decides what the person should do; the (redacted) message only
# explains. Classification uses exception TYPES and structured attributes
# (pgcode, MySQL errno, HTTP status, google.api_core class) first; message
# matching is only the last-resort fallback for drivers that give nothing else.
SOURCE_ERROR_CODES = (
    "auth", "network", "permission", "missing_resource", "invalid_config", "query",
    "timeout", "quota", "unsupported", "internal", "policy_blocked",
)

# PostgreSQL SQLSTATE → category (class prefix or full code).
_PG_CODES = {
    "28P01": "auth", "28000": "auth",
    "3D000": "missing_resource", "3F000": "missing_resource", "42P01": "missing_resource",
    "42501": "permission",
    "57014": "timeout",
    "53300": "quota", "53400": "quota",
    "42601": "query", "42703": "query", "42883": "query", "22P02": "query",
}
_PG_CLASSES = {"08": "network", "28": "auth", "42": "query", "53": "quota", "57": "timeout", "22": "query"}

# MySQL errno → category.
_MYSQL_CODES = {
    1044: "permission", 1045: "auth", 1049: "missing_resource", 1146: "missing_resource",
    1142: "permission", 1064: "query", 1054: "query",
    2003: "network", 2005: "network", 2006: "network", 2013: "timeout", 3024: "timeout",
}

_HTTP_STATUS = {400: "query", 401: "auth", 403: "permission", 404: "missing_resource",
                408: "timeout", 429: "quota", 504: "timeout"}

_FALLBACK = (
    ("timeout", ("timed out", "timeout")),
    ("auth", ("authentication failed", "invalid_grant", "access denied for user", "unauthenticated",
              "invalid credentials", "token has expired")),
    ("permission", ("permission denied", "does not have", "forbidden", "not authorized")),
    ("missing_resource", ("does not exist", "not found", "unknown database")),
    ("network", ("could not connect", "connection refused", "could not translate host",
                 "name or service not known", "no route to host", "network is unreachable")),
    ("quota", ("quota", "rate limit")),
)


def _http_status(exc: BaseException):
    for attr in ("code", "status_code", "status"):
        val = getattr(exc, attr, None)
        if isinstance(val, int) and 100 <= val < 600:
            return val
    resp = getattr(exc, "resp", None)  # googleapiclient HttpError
    status = getattr(resp, "status", None)
    try:
        return int(status) if status is not None else None
    except (TypeError, ValueError):
        return None


def classify_source_error(exc: Any) -> str:
    """Map a source failure to one SOURCE_ERROR_CODES category. Never raises."""
    try:
        if exc is None:
            return "internal"
        if isinstance(exc, str):
            return _classify_text(exc)
        # Policy / capability refusals first: they are ValueErrors too.
        from app.services.source_network_policy import SourceNetworkPolicyError
        if isinstance(exc, SourceNetworkPolicyError):
            return "policy_blocked"
        try:
            from app.services.datasource_service import PlatformCredentialNotAllowed
            if isinstance(exc, PlatformCredentialNotAllowed):
                return "policy_blocked"
        except Exception:  # noqa: BLE001
            pass
        from app.services.source_capabilities import SourceNotTabularError
        if isinstance(exc, SourceNotTabularError):
            return "unsupported"
        import socket
        if isinstance(exc, (TimeoutError, socket.timeout)):
            return "timeout"
        if isinstance(exc, socket.gaierror) or isinstance(exc, ConnectionError):
            return "network"

        # google-auth: a refresh/exchange failure is an auth problem.
        try:
            from google.auth import exceptions as gauth_exc
            if isinstance(exc, (gauth_exc.RefreshError, gauth_exc.DefaultCredentialsError)):
                return "auth"
            if isinstance(exc, gauth_exc.TransportError):
                return "network"
        except Exception:  # noqa: BLE001
            pass
        # google.api_core (BigQuery): typed HTTP errors.
        try:
            from google.api_core import exceptions as gexc
            for cls, code in ((gexc.Unauthenticated, "auth"), (gexc.Forbidden, "permission"),
                              (gexc.NotFound, "missing_resource"), (gexc.TooManyRequests, "quota"),
                              (gexc.ResourceExhausted, "quota"), (gexc.DeadlineExceeded, "timeout"),
                              (gexc.BadRequest, "query"), (gexc.ServiceUnavailable, "network")):
                if isinstance(exc, cls):
                    if code == "permission" and "quota" in str(exc).lower():
                        return "quota"  # BigQuery reports quotaExceeded as 403
                    return code
        except Exception:  # noqa: BLE001
            pass

        # psycopg2: SQLSTATE.
        pgcode = getattr(exc, "pgcode", None)
        if isinstance(pgcode, str) and pgcode:
            return _PG_CODES.get(pgcode) or _PG_CLASSES.get(pgcode[:2]) or "query"
        try:
            import psycopg2
            if isinstance(exc, psycopg2.OperationalError):
                text = _classify_text(str(exc), default="")
                return text or "network"
        except Exception:  # noqa: BLE001
            pass
        # pymysql: errno in args[0].
        try:
            import pymysql
            if isinstance(exc, pymysql.err.MySQLError):
                errno = exc.args[0] if exc.args and isinstance(exc.args[0], int) else None
                if errno in _MYSQL_CODES:
                    return _MYSQL_CODES[errno]
                if isinstance(exc, pymysql.err.OperationalError):
                    return "network"
                if isinstance(exc, pymysql.err.ProgrammingError):
                    return "query"
        except Exception:  # noqa: BLE001
            pass

        status = _http_status(exc)
        if status in _HTTP_STATUS:
            return _HTTP_STATUS[status]
        if status and status >= 500:
            return "network"

        if isinstance(exc, (KeyError, ValueError, TypeError)):
            text = _classify_text(str(exc), default="")
            return text or "invalid_config"
        return _classify_text(str(exc))
    except Exception:  # noqa: BLE001 — classification must never fail a test
        return "internal"


def _classify_text(text: str, default: str = "internal") -> str:
    low = (text or "").lower()
    for code, needles in _FALLBACK:
        if any(n in low for n in needles):
            return code
    return default
