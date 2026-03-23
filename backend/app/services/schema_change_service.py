"""
SchemaChangeService — detect and handle column schema changes in workspace tables.

When TableStatsService recomputes stats, it calls check_and_handle_schema_change().
Logic:
  - Compute SHA256 hash of sorted ["col:dtype", ...] pairs
  - Compare with stored schema_hash
  - On change:
      * If description_source == "user": set schema_change_pending=True (show UI warning)
        and only auto-describe new columns (partial update)
      * Otherwise: force full re-describe + re-embed
  - On first hash computation: just store it silently
"""
import hashlib
import json
import logging
from typing import Dict, Any

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def compute_schema_hash(column_stats: Dict[str, Any]) -> str:
    """
    SHA256 of sorted 'col:dtype' pairs from column_stats dict.
    Stable across row-count or stats value changes — only structure matters.
    """
    pairs = sorted(
        f"{col}:{stats.get('dtype', 'unknown')}"
        for col, stats in column_stats.items()
    )
    payload = json.dumps(pairs, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


class SchemaChangeService:

    @staticmethod
    def check_and_handle(
        db: Session,
        table_id: int,
        new_column_stats: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Compare new column_stats against stored schema_hash.
        Triggers re-describe and/or re-embed as needed.
        Returns {"changed": bool, "added": [...], "removed": [...]}.
        Safe to call synchronously after table_stats update (already committed).
        """
        from app.models.dataset_workspace import DatasetWorkspaceTable
        from app.services.auto_tagging_service import AutoTaggingService
        from app.services.embedding_service import EmbeddingService

        try:
            table = db.query(DatasetWorkspaceTable).filter(
                DatasetWorkspaceTable.id == table_id
            ).first()
            if not table:
                return {"changed": False}

            new_hash = compute_schema_hash(new_column_stats)

            # First time — just record the hash silently
            if not table.schema_hash:
                table.schema_hash = new_hash
                db.commit()
                logger.debug("SchemaChange: initial hash stored for table %s", table_id)
                return {"changed": False}

            # No change
            if table.schema_hash == new_hash:
                return {"changed": False}

            # Schema changed — compute diff
            old_cols = set()
            if table.column_stats:
                old_cols = set(table.column_stats.keys())
            new_cols = set(new_column_stats.keys())
            added = list(new_cols - old_cols)
            removed = list(old_cols - new_cols)

            logger.info(
                "SchemaChange: table %s schema changed — added=%s removed=%s",
                table_id, added, removed,
            )

            # Update hash
            table.schema_hash = new_hash

            if table.description_source == "user":
                # Respect user's description — flag UI warning, don't overwrite
                table.schema_change_pending = True
                db.commit()
                logger.info(
                    "SchemaChange: table %s has user description — set schema_change_pending=True",
                    table_id,
                )
            else:
                # Auto or feedback — regenerate fully
                table.schema_change_pending = False
                db.commit()
                # Force re-describe (runs synchronously in background task context)
                AutoTaggingService.describe_table(db, table_id, force=True)
                # Re-embed with fresh description
                EmbeddingService.embed_table(db, table_id)
                logger.info(
                    "SchemaChange: table %s re-described and re-embedded after schema change",
                    table_id,
                )

            return {"changed": True, "added": added, "removed": removed}

        except Exception as exc:
            logger.warning("SchemaChange: failed for table %s — %s", table_id, exc)
            try:
                db.rollback()
            except Exception:
                pass
            return {"changed": False}
