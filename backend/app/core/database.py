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

# Create SQLAlchemy engine
engine = create_engine(
    prepare_database_url(settings.DATABASE_URL),
    pool_pre_ping=True,  # Verify connections before using them
    pool_size=10,
    max_overflow=20,
)

# Create session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

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
