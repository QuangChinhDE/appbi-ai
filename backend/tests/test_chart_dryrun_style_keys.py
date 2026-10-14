"""Chart dry-run must not warn "won't render" for styleConfig keys the Explore
renderer actually consumes, and must still warn for unknown keys.

Each key below has a real consumer in the frontend renderer:
  yAxisRightSeriesKey  ExploreChart.tsx (dual-axis right series)
  axisDisplayUnits     ExploreChart.tsx (axis tick formatter)
  seriesLabels         ExploreChart.tsx / AdvancedExploreCharts.tsx
  tableColumnFormats   ExploreChart.tsx (table formatMap override)
  tableColumnLabels    AdvancedExploreCharts.tsx / ChartPreview.tsx
  kpiBackgroundMode    ExploreChart.tsx / ChartPreview.tsx (KPI card)
  dualYAxis, chartSortRules, dataLimit, dataLimitDirection, timeGranularity
                       ExploreChart.tsx (already registered; locked here)
"""
from __future__ import annotations

import pytest

from app.api.charts import _collect_fe_unrecognised_keys

RENDERER_HONOURED_STYLE_KEYS = [
    "dualYAxis", "yAxisRightSeriesKey", "chartSortRules", "dataLimit",
    "dataLimitDirection", "timeGranularity", "axisDisplayUnits",
    "seriesLabels", "tableColumnFormats", "tableColumnLabels",
    "kpiBackgroundMode",
]


@pytest.mark.parametrize("key", RENDERER_HONOURED_STYLE_KEYS)
def test_dry_run_does_not_warn_for_renderer_honoured_style_key(key):
    cfg = {"chartType": "BAR", "styleConfig": {key: 1}}
    assert _collect_fe_unrecognised_keys(cfg) == []


def test_dry_run_still_warns_for_unknown_style_key():
    cfg = {"chartType": "BAR", "styleConfig": {"dualYAxis": True, "notARealKey": 1}}
    assert _collect_fe_unrecognised_keys(cfg) == ["config.styleConfig.notARealKey"]
