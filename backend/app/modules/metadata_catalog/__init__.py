"""
metadata_catalog — AppBI's bridge to a HIDDEN OpenMetadata (OM) backend.

Responsibilities
----------------
1. publisher : push AppBI metadata (datasources, tables, columns, PK/FK,
   glossary, measures, lineage) INTO OM via its REST API.
2. api       : proxy endpoints under /api/v1/catalog/* so the AppBI frontend
   reads catalog/glossary/lineage WITHOUT ever talking to OM directly.
   Users never learn OM exists.

Safety
------
This whole module is INERT unless ``settings.METADATA_CATALOG_ENABLED`` is True.
The core app imports nothing from here while the flag is off (see
``app/api/__init__.py``), so it cannot affect the running system.
"""
