"""
Fully-Qualified-Name (FQN) strategy for OpenMetadata.

OM identifies every asset by a stable FQN. Re-syncing with a DIFFERENT FQN
duplicates the asset instead of updating it — so FQNs MUST be deterministic and
derived from AppBI's INTERNAL IDs (which never change), never from display names
(which users rename).

    Service      : appbi_ds_<datasource_id>
    Database     : appbi_ds_<datasource_id>.default
    Schema       : appbi_ds_<datasource_id>.default.public
    Table        : appbi_ds_<datasource_id>.default.public.t_<dataset_table_id>
    Column       : <table_fqn>.<column_name>
    Glossary     : appbi_glossary
    GlossaryTerm : appbi_glossary.ds<dataset_id>_<slug>
    Metric       : appbi_metric.ds<dataset_id>_<measure_key>

OM joins FQN parts with ".". Parts that themselves contain "." are wrapped in
double quotes by OM; we keep our parts dot-free to avoid that complication.
"""
from __future__ import annotations

import re

_DEFAULT_DB = "default"
_DEFAULT_SCHEMA = "public"
GLOSSARY_NAME = "appbi_glossary"
_METRIC_GLOSSARY = "appbi_metric"


def _slug(value: str, max_len: int = 80) -> str:
    """Lowercase, dot-free, space->underscore slug safe for an FQN part."""
    text = re.sub(r"\s+", "_", str(value or "").strip().lower())
    text = re.sub(r"[^a-z0-9_\-]", "", text).strip("_-")
    return (text or "x")[:max_len]


def service_name(datasource_id: int) -> str:
    return f"appbi_ds_{int(datasource_id)}"


def service_fqn(datasource_id: int) -> str:
    return service_name(datasource_id)


def database_name() -> str:
    return _DEFAULT_DB


def database_fqn(datasource_id: int) -> str:
    return f"{service_fqn(datasource_id)}.{_DEFAULT_DB}"


def schema_name() -> str:
    return _DEFAULT_SCHEMA


def schema_fqn(datasource_id: int) -> str:
    return f"{database_fqn(datasource_id)}.{_DEFAULT_SCHEMA}"


def table_name(dataset_table_id: int) -> str:
    # Prefix with t_ so the FQN part is stable + never collides with a number-only name.
    return f"t_{int(dataset_table_id)}"


def table_fqn(datasource_id: int, dataset_table_id: int) -> str:
    return f"{schema_fqn(datasource_id)}.{table_name(dataset_table_id)}"


def column_fqn(datasource_id: int, dataset_table_id: int, column_name: str) -> str:
    return f"{table_fqn(datasource_id, dataset_table_id)}.{column_name}"


def glossary_term_name(dataset_id: int, term: str) -> str:
    return f"ds{int(dataset_id)}_{_slug(term)}"


def glossary_term_fqn(dataset_id: int, term: str) -> str:
    return f"{GLOSSARY_NAME}.{glossary_term_name(dataset_id, term)}"


def metric_name(dataset_id: int, measure_key: str) -> str:
    return f"ds{int(dataset_id)}_{_slug(measure_key)}"
