"""
DEPRECATED — backwards-compat shim. Phase-7 (2026-05-15) canonicalised
this module under ``semantic_query_engine`` (no v2 suffix). Old import
paths keep working via this re-export so we don't have to update every
external caller in lock-step.

New code should import from ``app.services.semantic_query_engine`` and
use ``SemanticQueryEngine``. ``SemanticQueryEngineV2`` is an alias and
will be removed once every caller has migrated.
"""
from app.services.semantic_query_engine import SemanticQueryEngine

# Legacy alias — keep until every caller has migrated.
SemanticQueryEngineV2 = SemanticQueryEngine

__all__ = ["SemanticQueryEngine", "SemanticQueryEngineV2"]
