"""Runtime feature flags for query routing and sync behavior."""
from app.core.config import settings


def datasource_sync_enabled() -> bool:
    """Whether datasource sync features are enabled for this deployment."""
    return bool(settings.ENABLE_DATASOURCE_SYNC)


def resolve_dataset_query_mode(db_table) -> str:
    """
    Resolve the effective query mode for a dataset table.

    When datasource sync is disabled, every dataset table is treated as live
    regardless of the persisted query_mode value.
    """
    if not datasource_sync_enabled():
        return "live"
    return getattr(db_table, "query_mode", "synced") or "synced"
