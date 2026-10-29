"""The password-strength rule (pure policy, no I/O).

One rule for every place a password is accepted: the auth/user schemas and the
bootstrap admin (core.bootstrap_admin). It lives in core so core can enforce it
without importing the schema layer; schemas import it from here.
"""
from __future__ import annotations

import re

_COMMON_PASSWORDS = frozenset([
    "password", "123456", "12345678", "qwerty", "abc123", "monkey", "master",
    "dragon", "111111", "baseball", "iloveyou", "trustno1", "sunshine",
    "princess", "welcome", "shadow", "superman", "michael", "football",
    "password1", "password123", "admin", "letmein", "1234567", "123456789",
    "12345", "1234567890", "0987654321", "000000", "654321", "qwerty123",
    "admin123", "admin1234", "passw0rd", "p@ssw0rd", "p@ssword",
])


def _validate_password_strength(password: str) -> str:
    """Enforce enterprise password policy."""
    errors: list[str] = []
    if len(password) < 8:
        errors.append("at least 8 characters")
    if not re.search(r"[A-Z]", password):
        errors.append("at least 1 uppercase letter")
    if not re.search(r"[a-z]", password):
        errors.append("at least 1 lowercase letter")
    if not re.search(r"\d", password):
        errors.append("at least 1 digit")
    if not re.search(r"[^A-Za-z0-9]", password):
        errors.append("at least 1 special character")
    if password.lower() in _COMMON_PASSWORDS:
        errors.append("must not be a commonly used password")
    if errors:
        raise ValueError("Password must contain: " + ", ".join(errors))
    return password
