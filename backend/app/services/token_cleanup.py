"""
Periodic cleanup of expired revoked tokens.

Runs daily to remove entries from the ``revoked_tokens`` table whose
``expires_at`` has passed (the JWT they reference has already expired
naturally, so the blacklist entry is no longer needed).
"""
import logging
import threading
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_timer: threading.Timer | None = None
_INTERVAL_SECONDS = 24 * 60 * 60  # once per day


def _cleanup() -> None:
    """Delete expired revoked tokens from the database."""
    try:
        from app.core.database import SessionLocal
        from app.models.revoked_token import RevokedToken

        db = SessionLocal()
        try:
            now = datetime.now(timezone.utc)
            deleted = db.query(RevokedToken).filter(RevokedToken.expires_at < now).delete()
            db.commit()
            if deleted:
                logger.info("Cleaned up %d expired revoked tokens", deleted)
        finally:
            db.close()
    except Exception:
        logger.exception("Failed to clean up revoked tokens")

    # Reschedule
    schedule_token_cleanup()


def schedule_token_cleanup() -> None:
    """Schedule the next cleanup run."""
    global _timer
    _timer = threading.Timer(_INTERVAL_SECONDS, _cleanup)
    _timer.daemon = True
    _timer.start()
