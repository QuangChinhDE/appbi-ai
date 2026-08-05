"""
Logging configuration for the application.
"""
import logging
import sys
from app.core.config import settings


def setup_logging():
    """Configure application logging."""
    log_level = getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO)
    
    # Configure root logger
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout)
        ]
    )
    
    # Set specific log levels for noisy libraries
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    # httpx LEAKS CREDENTIALS AT INFO. Its request log prints the full URL, and
    # Gemini takes its credential as a query parameter — so every model call wrote
    # the API key into the container log in the clear:
    #
    #   HTTP Request: POST .../gemini-2.5-flash:streamGenerateContent?key=AQ.Ab8RN...
    #
    # That is a viewer's or an author's token sitting in `docker logs`, in whatever
    # ships logs onward, and in any bug report that pastes them. Raised to WARNING so
    # failures are still logged (without a body) and successful calls say nothing.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance for a specific module."""
    return logging.getLogger(name)
