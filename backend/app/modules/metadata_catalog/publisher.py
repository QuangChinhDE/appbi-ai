"""
Publisher — pushes AppBI metadata INTO OpenMetadata.

Tier 1 (implemented): datasource → service → database → schema → tables → columns
                      (+ optional PK/FK constraints).
Tier 2/3 (stubs)    : glossary terms (from dataset.dictionary), metrics
                      (from semantic_views.measures), column-level lineage.

Everything is idempotent: re-running upserts by FQN (OM PUT = create-or-update),
so a re-sync updates in place instead of duplicating.
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.models import DataSource, DatasetTable

from . import fqn, mapping
from .om_client import OpenMetadataClient

logger = logging.getLogger("app.metadata_catalog.publisher")


class Publisher:
    def __init__(self, om: OpenMetadataClient):
        self.om = om

    # ── Tier 1: catalog ───────────────────────────────────────────────────
    async def publish_datasource(self, db: Session, datasource_id: int) -> dict[str, Any]:
        """
        Publish a datasource and all its dataset tables to OM.
        Returns a summary dict (counts + any per-table errors).
        """
        ds = db.query(DataSource).filter(DataSource.id == datasource_id).first()
        if ds is None:
            raise ValueError(f"Datasource {datasource_id} not found")

        # 1) service → database → schema (the containing hierarchy)
        # NOTE: OM nests the service entity under /services/ (verified against
        # DatabaseServiceResource @Path). databases/schemas/tables are top-level.
        await self.om.put("services/databaseServices", mapping.service_payload(ds))
        await self.om.put("databases", mapping.database_payload(ds.id))
        await self.om.put("databaseSchemas", mapping.schema_payload(ds.id))

        # 2) every dataset table that draws from this datasource
        tables = (
            db.query(DatasetTable)
            .filter(DatasetTable.datasource_id == datasource_id)
            .all()
        )

        published, errors = 0, []
        for t in tables:
            try:
                columns = mapping.normalize_columns(t.columns_cache)
                constraints = self._extract_constraints(db, t)
                await self.om.put(
                    "tables",
                    mapping.table_payload(ds.id, t, columns, constraints),
                )
                published += 1
            except Exception as exc:  # one bad table must not abort the batch
                logger.exception("Failed to publish table %s", t.id)
                errors.append({"table_id": t.id, "error": str(exc)})

        return {
            "datasource_id": datasource_id,
            "service_fqn": fqn.service_fqn(datasource_id),
            "tables_total": len(tables),
            "tables_published": published,
            "errors": errors,
        }

    def _extract_constraints(self, db: Session, table: DatasetTable) -> list[dict[str, Any]]:
        """
        TODO(Tier-1 finish): derive PRIMARY_KEY / FOREIGN_KEY from
        semantic_views.primary_key + the dataset model joins, and map FK
        referredColumns to the target table's column FQN. Returns [] for now so
        the catalog still publishes without constraints.
        """
        return []

    # ── Tier 2: glossary (STUB) ───────────────────────────────────────────
    async def publish_glossary(self, db: Session, dataset_id: int) -> dict[str, Any]:
        """
        TODO: read dataset.dictionary, ensure the `appbi_glossary` Glossary
        exists, then upsert a GlossaryTerm per business definition and link it to
        the matching column(s) via the term's `assets`.
        """
        raise NotImplementedError("Tier-2 glossary publish not implemented yet")

    # ── Tier 3: metrics + lineage (STUB) ──────────────────────────────────
    async def publish_metrics(self, db: Session, dataset_id: int) -> dict[str, Any]:
        """TODO: map semantic_views.measures → OM Metric entities."""
        raise NotImplementedError("Tier-3 metric publish not implemented yet")

    async def publish_lineage(self, db: Session, dataset_id: int) -> dict[str, Any]:
        """TODO: emit column-level lineage source-col → measure → chart → dashboard."""
        raise NotImplementedError("Tier-3 lineage publish not implemented yet")
