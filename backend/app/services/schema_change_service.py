"""
SchemaChangeService - detect column schema changes for workspace tables.

This service is intentionally pure: it compares the previous known schema with
the newly computed one and returns a structured diff. The caller owns all side
effects such as marking a description stale, triggering regeneration, or
embedding the resource again.
"""
import hashlib
import json
from typing import Any, Dict


def compute_schema_hash(column_stats: Dict[str, Any]) -> str:
    """
    SHA256 of sorted "col:dtype" pairs from column_stats dict.
    Stable across row-count or stats value changes - only structure matters.
    """
    pairs = sorted(
        f"{col}:{stats.get('dtype', 'unknown')}"
        for col, stats in column_stats.items()
    )
    payload = json.dumps(pairs, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


class SchemaChangeService:

    @staticmethod
    def detect_change(
        previous_column_stats: Dict[str, Any] | None,
        previous_schema_hash: str | None,
        new_column_stats: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Compare previous schema metadata with the new schema snapshot.

        Returns:
            {
              "changed": bool,
              "added": [..],
              "removed": [..],
              "new_hash": "<sha256>",
            }
        """
        new_hash = compute_schema_hash(new_column_stats)
        previous_column_stats = previous_column_stats or {}

        if not previous_schema_hash:
            return {
                "changed": False,
                "added": [],
                "removed": [],
                "new_hash": new_hash,
            }

        if previous_schema_hash == new_hash:
            return {
                "changed": False,
                "added": [],
                "removed": [],
                "new_hash": new_hash,
            }

        old_cols = set(previous_column_stats.keys())
        new_cols = set(new_column_stats.keys())
        return {
            "changed": True,
            "added": sorted(new_cols - old_cols),
            "removed": sorted(old_cols - new_cols),
            "new_hash": new_hash,
        }
