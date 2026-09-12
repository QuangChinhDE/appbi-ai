"""
Database session management and connection handling.
"""
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from typing import Generator
from urllib.parse import quote_plus

from app.core.config import settings

# URL encode password in DATABASE_URL if needed
def prepare_database_url(url: str) -> str:
    """URL encode password in database URL for special characters"""
    if '@' in url and ':' in url:
        # Format: postgresql://user:password@host:port/db
        parts = url.split('://', 1)
        if len(parts) == 2:
            scheme, rest = parts
            if '@' in rest:
                auth_part, host_part = rest.split('@', 1)
                if ':' in auth_part:
                    user, password = auth_part.split(':', 1)
                    encoded_password = quote_plus(password)
                    return f"{scheme}://{user}:{encoded_password}@{host_part}"
    return url

# Create SQLAlchemy engine.
# NOTE: the real fix for QueuePool exhaustion under concurrent long BigQuery
# queries is releasing the ORM connection during the warehouse call (see
# chart_service._execute_semantic_chart_runtime). These pool settings are
# defense-in-depth: a modestly larger pool for burst concurrency, `pool_timeout`
# so an exhausted pool fails fast (10s) with a clear error instead of blocking
# every request (incl. /health) for the SQLAlchemy default 30s, and
# `pool_recycle` to drop connections a managed Postgres may have silently closed.
engine = create_engine(
    prepare_database_url(settings.DATABASE_URL),
    pool_pre_ping=True,  # Verify connections before using them
    pool_size=int(getattr(settings, "DB_POOL_SIZE", 20) or 20),
    max_overflow=int(getattr(settings, "DB_MAX_OVERFLOW", 30) or 30),
    pool_timeout=int(getattr(settings, "DB_POOL_TIMEOUT", 10) or 10),
    pool_recycle=int(getattr(settings, "DB_POOL_RECYCLE", 1800) or 1800),
)

# THE REQUEST PATH MAY RUN AS A DIFFERENT ROLE FROM THE ONE THAT OWNS THE SCHEMA.
#
# `engine` above owns the schema: alembic uses it, and anything that creates a
# table needs it. `app_engine` is what serves requests. They are the same object
# unless `DATABASE_URL_APP` is set, so a deployment that does not opt in behaves
# exactly as before.
#
# The reason for the split is that row-level security is skipped entirely for a
# SUPERUSER or BYPASSRLS role. Measured on this deployment with the single
# connection: 64 chunks readable with no scope set, 31 of them belonging to
# unpublished documents — through a policy that is written correctly and never
# evaluated. `vector_store_health()` reports `rls_in_force` either way, and the
# Knowledge Hub shows it, so this is never a silent state.
#
# Only SELECT is filtered by those policies (INSERT/UPDATE/DELETE are `true`), so
# indexing still writes draft chunks; the paths that READ drafts already declare
# `authoring_scope()`, which is the mechanism the policy was designed around.
_app_url = (getattr(settings, "DATABASE_URL_APP", "") or "").strip()
app_engine = create_engine(
    prepare_database_url(_app_url),
    pool_pre_ping=True,
    pool_size=int(getattr(settings, "DB_POOL_SIZE", 20) or 20),
    max_overflow=int(getattr(settings, "DB_MAX_OVERFLOW", 30) or 30),
    pool_timeout=int(getattr(settings, "DB_POOL_TIMEOUT", 10) or 10),
    pool_recycle=int(getattr(settings, "DB_POOL_RECYCLE", 1800) or 1800),
) if _app_url else engine

# Create session factory.
#
# Bound to `app_engine`, so background jobs get the same role as requests. A split
# where only `get_db` used the narrower role would leave every scheduler and every
# direct `SessionLocal()` on the owner connection — and "which of these two
# factories am I supposed to use" is the kind of question that gets answered wrong
# once and then leaks.
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=app_engine)

# Base class for all models
Base = declarative_base()


def get_db() -> Generator[Session, None, None]:
    """
    Dependency function that yields a database session.
    Ensures the session is properly closed after use.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
