"""Phase-1 (PBI-parity migration) — semantic_views.primary_key + backfill cardinality
on existing semantic_explores.joins entries.

revision: 20260528_0001
down_revision: 20260526_0002

Two additive changes — neither destructive nor breaking:

  1.  Add ``semantic_views.primary_key`` (JSONB, nullable). Used by:
        - Phase-4 symmetric aggregates (MD5/FARM_FINGERPRINT trick) — fan-out-safe
          SUM/COUNT/AVG when a measure is computed across a JOIN that fans out.
        - Distinct-count correctness (``COUNTD(view)`` → ``COUNT(DISTINCT view.pk)``).
      Null = unknown — engine falls back to EXISTS rewrite (Phase-B', commit 5f8b7fd)
      which is already correct, just less performant.

  2.  Backfill ``cardinality`` into every existing ``semantic_explores.joins[*]`` entry
      that lacks it. Maps the legacy ``relationship`` string (which was informational
      only) through ``normalize_cardinality`` so the Phase-2 propagation engine has a
      reliable enum to drive direction rules.

Contracts preserved:
  - No column drops, no NOT NULL constraints added, no FK changes.
  - All JSON additions are in-place keys; existing readers ignore unknown keys.
  - Reverting (``downgrade``) drops the column but leaves backfilled JSON keys
    in place (harmless — readers ignoring them stays the same).
"""
from __future__ import annotations

import json
from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB


# revision identifiers, used by Alembic.
revision: str = "20260528_0001"
down_revision: Union[str, None] = "20260526_0002"
branch_labels = None
depends_on = None


# Same canonical map as semantic_join_resolver.normalize_cardinality — duplicated
# here so migration is self-contained and doesn't import live application code.
_CARDINALITY_ALIASES = {
    "one_to_one": "one_to_one", "one-to-one": "one_to_one", "1:1": "one_to_one",
    "one_to_many": "one_to_many", "one-to-many": "one_to_many",
    "1:n": "one_to_many", "1:m": "one_to_many",
    "many_to_one": "many_to_one", "many-to-one": "many_to_one",
    "n:1": "many_to_one", "m:1": "many_to_one",
    "many_to_many": "many_to_many", "many-to-many": "many_to_many",
    "n:m": "many_to_many", "m:n": "many_to_many",
}
_DEFAULT_CARDINALITY = "many_to_one"


def _normalize(raw):
    if not raw:
        return _DEFAULT_CARDINALITY
    return _CARDINALITY_ALIASES.get(str(raw).strip().lower().replace("-", "_"), _DEFAULT_CARDINALITY)


def upgrade() -> None:
    # ── 1. Add semantic_views.primary_key (nullable, JSON list of column names) ──
    op.add_column(
        "semantic_views",
        sa.Column("primary_key", JSONB, nullable=True),
    )

    # ── 2. Backfill cardinality on existing joins[] entries ──
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, joins FROM semantic_explores WHERE joins IS NOT NULL")
    ).fetchall()

    updated = 0
    for row in rows:
        joins = row.joins
        if not isinstance(joins, list):
            continue
        changed = False
        for j in joins:
            if not isinstance(j, dict):
                continue
            # Only fill when missing — don't clobber explicit values.
            if not j.get("cardinality"):
                j["cardinality"] = _normalize(j.get("relationship"))
                changed = True
            # Default cross_filter to 'single' if missing — PBI parity default.
            if not j.get("cross_filter"):
                j["cross_filter"] = "single"
                changed = True
        if changed:
            bind.execute(
                sa.text("UPDATE semantic_explores SET joins = CAST(:j AS jsonb) WHERE id = :id"),
                {"j": json.dumps(joins), "id": row.id},
            )
            updated += 1
    print(f"[phase1] cardinality + cross_filter backfilled on {updated} explore row(s)")


def downgrade() -> None:
    # Only drop the column; leave the JSON backfill in place (harmless to old code,
    # which ignores unknown keys).
    op.drop_column("semantic_views", "primary_key")
