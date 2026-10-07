"""First-boot administrator: never a universally known credential.

The entrypoint used to seed ``admin@appbi.io`` with password ``123456`` whenever
``ADMIN_PASSWORD`` was unset, and ``scripts/bootstrap-env.sh`` rewrote a
placeholder to ``123456`` on purpose. The production config validator never
looked at it, and the seed ran before the app (and the validator) started, so a
fresh internet-facing deployment that kept the defaults had a full
administrator anyone could log into.

Rules (``resolve_bootstrap_password``):

* Seeding only happens while the users table is empty. Once any user exists the
  bootstrap password is irrelevant and nothing here can block startup.
* Production (any ENVIRONMENT other than dev/development/test): ADMIN_PASSWORD
  must be supplied, must not be a placeholder, must pass the product password
  policy and be at least 12 characters. Otherwise startup FAILS - there is no
  fallback credential.
* Development/test: an unusable or missing value is replaced by a random
  one-time password, printed once to the container log and never stored in
  plaintext. Never active in production mode.
"""
from __future__ import annotations

import os
import secrets
import string

DEV_ENVIRONMENTS = ("dev", "development", "test")
PROD_MIN_LENGTH = 12
_PLACEHOLDER_PREFIXES = ("change_me", "changeme", "replace_me", "your_")


class BootstrapRefused(RuntimeError):
    """Production first boot without an acceptable administrator password."""


def is_dev(environment: str | None) -> bool:
    return (environment or "production").strip().lower() in DEV_ENVIRONMENTS


def _is_placeholder(value: str) -> bool:
    v = value.strip().lower()
    return not v or v.startswith(_PLACEHOLDER_PREFIXES) or v in {"none", "null", "<set-me>"}


def password_problem(password: str | None, *, production: bool) -> str | None:
    """Why ``password`` is not acceptable for the bootstrap admin, or None."""
    from app.schemas.auth import _validate_password_strength

    if password is None or _is_placeholder(password):
        return "ADMIN_PASSWORD is not set (or is a placeholder)"
    try:
        _validate_password_strength(password)
    except ValueError as exc:
        return str(exc)
    if production and len(password) < PROD_MIN_LENGTH:
        return f"ADMIN_PASSWORD must be at least {PROD_MIN_LENGTH} characters in production"
    return None


def generate_password() -> str:
    alphabet = string.ascii_letters + string.digits
    core = "".join(secrets.choice(alphabet) for _ in range(20))
    # Guarantee every class the policy asks for.
    return core + secrets.choice(string.ascii_uppercase) + secrets.choice(string.digits) + "!"


def resolve_bootstrap_password(environment: str | None, supplied: str | None) -> tuple[str, bool]:
    """(password, generated). Raises BootstrapRefused in production."""
    production = not is_dev(environment)
    problem = password_problem(supplied, production=production)
    if problem is None:
        return supplied, False  # type: ignore[return-value]
    if production:
        raise BootstrapRefused(
            "Refusing to create the first administrator: " + problem + ". "
            "Set a strong ADMIN_PASSWORD (or create the first user another way); "
            "there is no default credential in production."
        )
    return generate_password(), True


def seed_first_admin(engine, env: dict | None = None) -> str:
    """Create the first administrator when the users table is empty.

    Returns a short status string for the entrypoint log. Raises
    BootstrapRefused (production, no acceptable password) - the entrypoint
    exits non-zero on it."""
    import json

    from passlib.context import CryptContext
    from sqlalchemy import text

    env = dict(os.environ if env is None else env)
    with engine.connect() as conn:
        count = conn.execute(text("SELECT COUNT(*) FROM users")).scalar()
        if count:
            return "users table already has rows - no bootstrap admin"
        password, generated = resolve_bootstrap_password(
            env.get("ENVIRONMENT"), env.get("ADMIN_PASSWORD")
        )
        email = (env.get("ADMIN_EMAIL") or "admin@appbi.io").strip()
        name = (env.get("ADMIN_NAME") or "Admin").strip()
        from app.core.dependencies import MODULE_KEYS

        perms = {k: "full" for k in MODULE_KEYS}
        perms["chat"] = "view"
        perms["settings"] = "full"
        hashed = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12).hash(password)
        conn.execute(text(
            "INSERT INTO users (email, password_hash, full_name, status, permissions) "
            "VALUES (:email, :pw, :name, 'active', cast(:perms AS jsonb))"
        ), {"email": email, "pw": hashed, "name": name, "perms": json.dumps(perms)})
        conn.commit()
    if generated:
        return (
            f"admin user created: {email}\n"
            f"    DEVELOPMENT ONLY one-time password: {password}\n"
            "    (shown once; not stored in plaintext; change it after logging in)"
        )
    return f"admin user created: {email}"
