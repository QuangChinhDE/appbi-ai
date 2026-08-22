"""Re-export of the tool context, which now lives with the data path.

WHY THIS FILE IS FOUR LINES INSTEAD OF FIVE HUNDRED.

It used to be the definition, and a migration moved that definition to
`agent_flows/tools/context.py` — where it belongs, because merging a dashboard's
public filters into a query, resolving the semantic layer, choosing snapshot or
live and coercing column types is the DATA PATH, not a way of thinking. The new
module's own docstring already said "the old location now re-exports from here".

It never did. Both files stayed whole, so there were two 500-line copies of the
same fourteen symbols, and the one nobody had migrated away from kept collecting
fixes: `max_rows_per_call`, `max_result_tokens` and a typed `_err` were added HERE
and never reached the copy the packs import from. Nothing broke, because every
caller in the codebase constructs `ToolContext` from this path — which is exactly
what makes it dangerous. The second copy was a type-only twin, silently a version
behind, waiting for the day something started using it.

Both drifts are now in the real home, and this is the shim the migration promised.
Import from `app.services.agent_flows.tools.context` in new code; this exists so
the first-generation bot's twenty import sites keep working while it is still
standing, and so the next fix to the chart-fetch path can only land in one place.
"""
from app.services.agent_flows.tools.context import (  # noqa: F401
    MAX_ROWS_FOR_PACK,
    MAX_TOP_N,
    ToolContext,
    ToolError,
    _err,
    _fetch_chart_data,
    _hash_filters,
    _humanize_field,
    _ok,
    _resolve_excluded_columns,
    _round,
    compute_related_charts,
    extract_chart_field_semantics,
    fields_block,
    fold_column,
    resolve_field_label,
)

__all__ = [
    "MAX_ROWS_FOR_PACK",
    "MAX_TOP_N",
    "ToolContext",
    "ToolError",
    "compute_related_charts",
    "extract_chart_field_semantics",
    "fields_block",
    "fold_column",
    "resolve_field_label",
]
