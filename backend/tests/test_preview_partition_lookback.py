"""BigQuery preview lookback: a table with empty recent partitions must not make
one round trip per day.

Regression (2026-10-18, Explore Run stuck disabled): ``execute_preview_query``
widened the partition window one day at a time — a dry-run + a query per day.
Table dw_buoi_8.olist_order_items_dataset has no rows in its last ~118 days, so
the preview made ~120 BigQuery round trips (~200 s cold), the Next.js proxy cut
it at 120 s, React Query retried, and Explore's Run (gated on the preview) never
enabled. The window is cumulative ([today-N, tomorrow)), so widening by doubling
returns the same rows in a handful of attempts.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.services import live_query_service as lqs


def test_steps_double_and_end_exactly_at_the_history():
    assert lqs.preview_partition_lookback_steps(0) == [0]
    assert lqs.preview_partition_lookback_steps(1) == [0, 1]
    assert lqs.preview_partition_lookback_steps(5) == [0, 1, 3, 5]
    steps = lqs.preview_partition_lookback_steps(365)
    assert steps == [0, 1, 3, 7, 15, 31, 63, 127, 255, 365]
    assert steps == sorted(set(steps)), 'steps must strictly grow (each window is a superset)'
    assert lqs.preview_partition_lookback_steps(-3) == [0]


@pytest.fixture
def bigquery_preview(monkeypatch):
    """A BigQuery physical table whose last 118 days are empty; history = 365 days."""
    calls = {'queries': 0, 'dry_runs': 0, 'windows': []}
    earliest = (datetime.utcnow() - timedelta(days=365)).date()

    monkeypatch.setattr(lqs, '_get_bigquery_partition_metadata',
                        lambda config, table: {'has_supported_partitioning': True,
                                               'earliest_partition_date': earliest})
    monkeypatch.setattr(lqs, '_describe_bigquery_partition_target', lambda meta: '_airbyte_extracted_at')
    monkeypatch.setattr(lqs, '_should_cache_live_query', lambda ds_type: False)
    monkeypatch.setattr(lqs, 'build_dataset_table_cache_identifier', lambda t: 'tbl')

    def fake_plan(datasource, db_table, apply_type_overrides=True, partition_days_ago=None, bigquery_partition_meta=None):
        n = partition_days_ago or 0
        return SimpleNamespace(
            sql=f'SELECT a FROM t WHERE d >= DATE_SUB(CURRENT_DATE(), INTERVAL {n} DAY)',
            output_columns=['a'], source_columns=['a'])

    monkeypatch.setattr(lqs, 'build_live_base_query_plan', fake_plan)

    def fake_dry_run(config, sql):
        calls['dry_runs'] += 1
        return 0

    monkeypatch.setattr(lqs, '_estimate_bigquery_bytes', fake_dry_run)

    import app.core.crypto as crypto
    monkeypatch.setattr(crypto, 'decrypt_config', lambda c: c)

    from app.services import datasource_service

    def fake_execute(ds_type, config, sql, timeout_seconds=60, skip_bigquery_cost_check=True):
        calls['queries'] += 1
        n = int(re.search(r'INTERVAL (\d+) DAY', sql).group(1))
        calls['windows'].append(n)
        rows = [{'a': i} for i in range(100)] if n >= 119 else []
        return ['a'], rows, 5.0

    monkeypatch.setattr(datasource_service.DataSourceConnectionService, 'execute_query', staticmethod(fake_execute))
    datasource = SimpleNamespace(id=52, type='bigquery', config={})
    table = SimpleNamespace(source_kind='physical_table', source_table_name='p.d.t',
                            transformations=[], type_overrides=None)
    return calls, datasource, table


def test_empty_recent_partitions_take_a_handful_of_round_trips(bigquery_preview):
    calls, datasource, table = bigquery_preview
    result = lqs.LiveQueryService.execute_preview_query(datasource, table, limit=100)

    assert len(result['rows']) == 100, 'the rows that exist further back are still found'
    # One-day steps made 120 queries + 120 dry-runs here (~200 s against BigQuery).
    assert calls['queries'] <= 12, f"{calls['queries']} preview queries for one preview: {calls['windows']}"
    assert calls['dry_runs'] == calls['queries']
    assert calls['windows'] == sorted(calls['windows'])
    assert result['partition_days_ago'] == calls['windows'][-1] >= 119


def test_rows_in_the_newest_partition_stop_at_the_first_attempt(bigquery_preview, monkeypatch):
    calls, datasource, table = bigquery_preview
    from app.services import datasource_service

    def recent_rows(ds_type, config, sql, timeout_seconds=60, skip_bigquery_cost_check=True):
        calls['queries'] += 1
        return ['a'], [{'a': i} for i in range(100)], 5.0

    monkeypatch.setattr(datasource_service.DataSourceConnectionService, 'execute_query', staticmethod(recent_rows))
    result = lqs.LiveQueryService.execute_preview_query(datasource, table, limit=100)
    assert calls['queries'] == 1 and result['partition_days_ago'] == 0


def test_a_table_with_no_rows_at_all_still_stops_at_its_history(bigquery_preview, monkeypatch):
    calls, datasource, table = bigquery_preview
    from app.services import datasource_service

    def no_rows(ds_type, config, sql, timeout_seconds=60, skip_bigquery_cost_check=True):
        calls['queries'] += 1
        calls['windows'].append(int(re.search(r'INTERVAL (\d+) DAY', sql).group(1)))
        return ['a'], [], 5.0

    monkeypatch.setattr(datasource_service.DataSourceConnectionService, 'execute_query', staticmethod(no_rows))
    result = lqs.LiveQueryService.execute_preview_query(datasource, table, limit=100)
    assert result['rows'] == []
    assert calls['windows'][-1] == 365, 'the last attempt covers the whole partition history'
    assert calls['queries'] <= 12
