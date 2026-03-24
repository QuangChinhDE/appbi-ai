"""Top-level package for the backend application."""

__all__ = ["app"]


def __getattr__(name: str):
    """Lazily expose the FastAPI app without importing it for every submodule import."""
    if name == "app":
        from app.main import app as fastapi_app
        return fastapi_app
    raise AttributeError(f"module 'app' has no attribute {name!r}")
