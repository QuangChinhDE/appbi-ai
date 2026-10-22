"""Write-time chart-config validation (SEC-13 defense in depth).

The semantic engine refuses an invalid time grain at the SQL render boundary.
This is the SECOND layer: every path that stores or previews a chart config now
applies the same role-config contract ChartCreate applies, so an out-of-contract
config (for example a grain that is not day/week/month/quarter/year) cannot be
stored in the first place. The engine stays the last line of defence.

These are unit tests (no DB): the shared contract, the service guard, the
ChartCreate path, and a source-level check that every write path is wired to the
one guard — the bug class here is a NEW write path that forgets to call it.
"""
import os
import pathlib
import re
import sys

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_chart_config_write.db")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.schemas.chart_config import role_config_shape_errors  # noqa: E402

APP = pathlib.Path(__file__).resolve().parents[1] / "app"


def _cfg(grain):
    return {"roleConfig": {"dimension": "v.d", "metrics": [{"field": "v.m", "agg": "sum"}],
                           "timeGrains": {"v.d": grain}}}


@pytest.mark.parametrize("grain", ["day", "week", "month", "quarter", "year"])
def test_a_valid_grain_passes_the_contract(grain):
    assert role_config_shape_errors(_cfg(grain)) == []


@pytest.mark.parametrize("grain", ["not_a_grain", "days", "", "HOUR", "0"])
def test_an_invalid_grain_is_an_error(grain):
    errs = role_config_shape_errors(_cfg(grain))
    assert errs and any("timeGrains" in e for e in errs)


def test_custom_sql_mode_and_empty_config_are_not_blocked():
    # custom-SQL mode is datasource authority, checked elsewhere; the shape gate
    # must not fire on it, and an empty/None config has no role config to check.
    assert role_config_shape_errors({"queryMode": "custom", "customSql": "SELECT 1",
                                     "roleConfig": _cfg("not_a_grain")["roleConfig"]}) == []
    assert role_config_shape_errors(None) == []
    assert role_config_shape_errors({}) == []


def test_the_service_guard_raises_422_on_an_invalid_grain():
    from fastapi import HTTPException

    from app.services.chart_config_guard import require_valid_chart_config

    require_valid_chart_config(_cfg("month"))          # valid: no raise
    require_valid_chart_config({})                      # empty: no raise
    with pytest.raises(HTTPException) as exc:
        require_valid_chart_config(_cfg("not_a_grain"))
    assert exc.value.status_code == 422 and "timeGrains" in str(exc.value.detail)


def test_chart_create_rejects_an_invalid_grain_config():
    from pydantic import ValidationError

    from app.schemas import ChartCreate

    with pytest.raises((ValidationError, ValueError)):
        ChartCreate(name="x", dataset_table_id=1, chart_type="BAR", config=_cfg("not_a_grain"))
    # a valid grain saves its config shape fine
    ChartCreate(name="x", dataset_table_id=1, chart_type="BAR", config=_cfg("month"))


def test_every_write_path_is_wired_to_the_one_guard():
    """A new path that writes Chart(config=...) or chart.config without calling
    require_valid_chart_config (and not via ChartCreate) is the regression this
    locks. Each known write site must reference the guard."""
    wiring = {
        "api/charts.py": "preview-data",
        "services/dashboard_html_import_service.py": "HTML import build + batch",
        "services/dashboard_service.py": "fork-chart in place",
    }
    missing = []
    for rel in wiring:
        text = (APP / rel).read_text(encoding="utf-8")
        if "require_valid_chart_config" not in text:
            missing.append(rel)
    assert not missing, f"write paths not wired to the config guard: {missing}"
    # snapshot import/duplicate goes through the HTML-import rebuild, which is in
    # dashboard_html_import_service.py (already asserted above).
    assert "require_valid_chart_config" in (APP / "services/dashboard_html_import_service.py").read_text(encoding="utf-8")
