"""Runtime feature flags for query routing and sync behavior."""
from app.core.config import settings


def datasource_sync_enabled() -> bool:
    """Whether datasource sync features are enabled for this deployment."""
    return bool(settings.ENABLE_DATASOURCE_SYNC)


def resolve_dataset_query_mode(db_table) -> str:
    """
    Resolve the effective query mode for a dataset table.

    When datasource sync is disabled globally, prefer live mode for new tables,
    but still honor an existing synced table if it already has cached sync
    artifacts. This keeps previously-synced datasets usable after a restart
    without forcing an external live-source roundtrip.
    """
    stored_mode = getattr(db_table, "query_mode", "synced") or "synced"

    if datasource_sync_enabled():
        return stored_mode

    has_synced_artifacts = bool(
        getattr(db_table, "columns_cache", None) or getattr(db_table, "sample_cache", None)
    )
    if stored_mode == "synced" and has_synced_artifacts:
        return "synced"

    return "live"
