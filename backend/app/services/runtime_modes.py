"""Runtime feature flags for query routing."""


def datasource_sync_enabled() -> bool:
    """Datasource sync is permanently disabled — all queries go to the live source."""
    return False


def resolve_dataset_query_mode(db_table) -> str:
    """All tables use live mode — queries execute directly on the source database."""
    return "live"
