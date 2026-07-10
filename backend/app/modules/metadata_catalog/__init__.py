"""
metadata_catalog — AppBI's NATIVE Govern backend (its own Postgres).

Responsibilities
----------------
1. GovernanceService : AppBI's own CRUD over Postgres for Glossary (terms) and
   Classification (tags). Metrics, Data Quality and Incidents come from AppBI's
   semantic/quality engines; nothing depends on a third-party catalog server.
2. api               : endpoints under /api/v1/catalog/* that power the AppBI
   frontend's Govern module (Vocabulary + Metrics + Knowledge Hub).

Safety
------
This whole module is INERT unless ``settings.METADATA_CATALOG_ENABLED`` is True.
The core app imports nothing from here while the flag is off (see
``app/api/__init__.py``), so it cannot affect the running system.
"""
