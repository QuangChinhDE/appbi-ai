"""Write-time chart config validation for every path that stores or previews a
chart config without going through ChartCreate (SEC-13 defense in depth).

ChartCreate already enforces `app.schemas.chart_config.role_config_shape_errors`.
These paths built `Chart(config=...)` or assigned `chart.config` directly, so an
out-of-contract role config (for example a time grain that is not day/week/month/
quarter/year) could be stored and then rendered on every view, public links
included:

  * POST /charts/preview-data
  * POST /dashboards/import-html/build and build-batch
  * POST /dashboards/import-snapshot and POST /dashboards/{id}/duplicate
  * POST /dashboards/{id}/charts/{tile}/fork-chart (the in-place branch)

This module applies the SAME contract there. It is a second layer only: the
semantic engine refuses an invalid grain at the SQL render boundary regardless,
so a config stored before this check existed is still refused when it runs.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status


def require_valid_chart_config(config: Any) -> None:
    """422 when the config's active role config breaks the ChartCreate shape
    contract. Same status ChartCreate's validation yields."""
    from app.schemas.chart_config import role_config_shape_errors

    errors = role_config_shape_errors(config if isinstance(config, dict) else None)
    if errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"role_config shape errors: {'; '.join(errors)}",
        )
