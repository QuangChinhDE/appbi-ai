"""
Fernet symmetric encryption for DataSource credentials.

Sensitive fields (passwords, API keys, tokens) stored in DataSource.config are
encrypted at rest. The encryption key is loaded from DATASOURCE_ENCRYPTION_KEY
setting (a base64url-encoded 32-byte key generated via `Fernet.generate_key()`).

If DATASOURCE_ENCRYPTION_KEY is empty, credentials are stored in plain text
(development mode). A warning is logged on startup.

Encrypted values are prefixed with "_enc:" so we can detect them and skip
double-encryption.
"""
from __future__ import annotations

import base64
import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)

_ENCRYPTED_PREFIX = "_enc:"

# Sentinel returned in GET responses instead of the actual secret value.
MASKED_PLACEHOLDER = "__stored__"

# Fields considered sensitive across all DataSource types.
_SENSITIVE_FIELDS = frozenset({
    "password",
    "api_key",
    "token",
    "access_token",
    "secret_key",
    "private_key",
    "client_secret",
    "service_account_json",
    "credentials_json",
})


def _get_fernet():
    """Lazily build and return the Fernet instance. Returns None if key is unset."""
    from app.core.config import settings
    key_str = (settings.DATASOURCE_ENCRYPTION_KEY or "").strip()
    if not key_str:
        return None
    try:
        from cryptography.fernet import Fernet
        # Fernet.generate_key() returns bytes; .env stores it as str
        return Fernet(key_str.encode() if isinstance(key_str, str) else key_str)
    except Exception as e:
        logger.error("Failed to initialize Fernet — credentials will NOT be encrypted: %s", e)
        return None


def _is_encrypted(value: str) -> bool:
    return isinstance(value, str) and value.startswith(_ENCRYPTED_PREFIX)


def encrypt_value(plaintext: str) -> str:
    """Encrypt a string value. Returns prefixed ciphertext or original if no key."""
    f = _get_fernet()
    if f is None:
        return plaintext
    token = f.encrypt(plaintext.encode()).decode()
    return f"{_ENCRYPTED_PREFIX}{token}"


def decrypt_value(ciphertext: str) -> str:
    """Decrypt a prefixed ciphertext. Returns original if not encrypted or no key."""
    if not _is_encrypted(ciphertext):
        return ciphertext
    f = _get_fernet()
    if f is None:
        logger.warning("Cannot decrypt credential — DATASOURCE_ENCRYPTION_KEY not set")
        return ciphertext
    token = ciphertext[len(_ENCRYPTED_PREFIX):]
    return f.decrypt(token.encode()).decode()


def encrypt_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Return a copy of the config dict with sensitive fields encrypted.
    Non-sensitive fields are left untouched.
    """
    result = dict(config)
    for field in _SENSITIVE_FIELDS:
        if field in result and result[field] and not _is_encrypted(str(result[field])):
            result[field] = encrypt_value(str(result[field]))
    return result


def decrypt_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Return a copy of the config dict with sensitive fields decrypted.
    Non-sensitive fields are left untouched.
    """
    result = dict(config)
    for field in _SENSITIVE_FIELDS:
        if field in result and result[field] and _is_encrypted(str(result[field])):
            result[field] = decrypt_value(str(result[field]))
    return result


def mask_config_for_response(config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Return config with sensitive fields replaced by MASKED_PLACEHOLDER.
    Called before returning config in API responses so secrets never leave the server.
    """
    if not isinstance(config, dict):
        return config
    result = dict(config)
    for field in _SENSITIVE_FIELDS:
        if field in result and result[field]:
            result[field] = MASKED_PLACEHOLDER
    return result
