"""Move every legacy manual source (inline ``config.sheets[*].rows``) into
Parquet assets. Idempotent — already-converted sources are skipped.

    python -m app.scripts.migrate_manual_sources_to_assets
"""
from __future__ import annotations

import json


def main() -> int:
    from app.core.database import SessionLocal
    from app.services.manual_assets.service import migrate_all_legacy

    db = SessionLocal()
    try:
        result = migrate_all_legacy(db)
    finally:
        db.close()
    print(json.dumps(result))
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
