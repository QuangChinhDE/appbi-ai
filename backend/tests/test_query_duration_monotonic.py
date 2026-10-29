"""A query's reported duration never goes negative.

Explore showed "20 rows · -855.7ms": execution_time_ms was a WALL-clock
difference (time.time()), and a wall clock that steps back mid-query (NTP /
container clock sync) yields a negative duration. Durations come from a
monotonic clock now.
"""
import time

from app.services.datasource_service import DataSourceConnectionService


def test_execute_query_duration_survives_a_wall_clock_step_back(monkeypatch):
    wall = {"now": 1_000_000.0}
    monkeypatch.setattr(time, "time", lambda: wall["now"])

    def fake_pg(config, sql, limit, timeout, params, max_rows=None, **_kw):  # on_backend_id (GQS cancel)
        wall["now"] -= 0.855  # the wall clock steps back while the query runs
        return [{"name": "x"}], [{"x": 1}]

    monkeypatch.setattr(DataSourceConnectionService, "_execute_postgresql", staticmethod(fake_pg))
    monkeypatch.setattr("app.core.crypto.decrypt_config", lambda c: c)

    _cols, rows, ms = DataSourceConnectionService.execute_query(
        "postgresql", {"host": "h"}, "SELECT 1 AS x",
    )
    assert rows == [{"x": 1}]
    assert ms >= 0, f"negative duration {ms}"


def test_no_wall_clock_duration_left_on_the_query_paths():
    import inspect
    import re

    from app.services import chart_service, datasource_service, live_query_service

    for mod in (chart_service, datasource_service, live_query_service):
        src = inspect.getsource(mod)
        hits = re.findall(r"time\.time\(\)\s*-\s*(?:start|start_time|_duck_start)\b", src)
        assert not hits, f"{mod.__name__}: wall-clock duration {hits}"
