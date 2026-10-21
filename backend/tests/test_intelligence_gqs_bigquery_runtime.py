"""GQS executor bounds and cancellation on REAL BigQuery (PR-1C/1D runtime evidence).

Runs against an AppBI datasource named by GQS_BQ_DATASOURCE_ID, resolved through
AppBI's own config + credential path (nothing is copied out of AppBI). It runs
ONLY when that datasource is the approved QA project and ONLY over the approved
QA tables; anything else refuses to run. Without the variable the module skips —
a skip here is NOT coverage.

Every job this module submits is a read, carries the label `appbi_qa=gqs_rt`,
and is bounded by `maximum_bytes_billed`. The only job it cancels is one it
started itself, by the id the executor reported.

Locked here, on the real warehouse:
  * dry-run gives a byte estimate before anything runs;
  * a job whose scan exceeds `maximum_bytes_billed` is refused by BigQuery;
  * the executor's row cap holds and the job carries its attribution labels;
  * a cancel through BigQueryCanceller stops a running job early, and the
    job ends cancelled at the warehouse, not merely abandoned in Python;
  * a cancel naming a job that does not exist is harmless.
"""
from __future__ import annotations

import os
import threading
import time

import pytest

DS_ID = os.environ.get("GQS_BQ_DATASOURCE_ID", "")
pytestmark = pytest.mark.skipif(not DS_ID, reason="GQS_BQ_DATASOURCE_ID not set: no BigQuery runtime evidence")

QA_PROJECT = "base-testlab-01"
QA_DATASET = "dw_buoi_8"
LABELS = {"appbi_qa": "gqs_rt"}
CAP = 200 * 1024 ** 2  # 200 MB billed at most per job; the QA tables are far smaller


@pytest.fixture(scope="module")
def bq():
    from app.core.crypto import decrypt_config
    from app.core.database import SessionLocal
    from app.models import DataSource
    from app.services.datasource_service import _build_bigquery_client

    db = SessionLocal()
    try:
        ds = db.get(DataSource, int(DS_ID))
        assert ds is not None, f"datasource {DS_ID} not found"
        raw = dict(ds.config)
        ds_type = str(getattr(ds.type, "value", ds.type))
    finally:
        db.close()
    cfg = decrypt_config(raw)
    if ds_type != "bigquery" or cfg.get("project_id") != QA_PROJECT:
        pytest.fail(f"datasource {DS_ID} is not the approved QA project; refusing to run")
    return {"raw": raw, "cfg": cfg, "client": _build_bigquery_client(cfg)}


def _t(name: str) -> str:
    return f"`{QA_PROJECT}.{QA_DATASET}.{name}`"


def _execute(bq, sql, **kw):
    from app.services.datasource_service import DataSourceConnectionService

    kw.setdefault("maximum_bytes_billed", CAP)
    kw.setdefault("job_labels", LABELS)
    return DataSourceConnectionService.execute_query(ds_type="bigquery", config=bq["raw"], sql_query=sql, **kw)


def test_dry_run_estimates_before_running(bq):
    from app.services.datasource_service import DataSourceConnectionService

    est = DataSourceConnectionService._estimate_bigquery_bytes(
        bq["cfg"], f"SELECT product_id, price FROM {_t('olist_order_items_dataset')}")
    assert 0 < est < CAP


def test_a_scan_over_the_billing_cap_is_refused(bq):
    with pytest.raises(Exception) as exc:
        _execute(bq, f"SELECT COUNT(DISTINCT order_id) AS n FROM {_t('olist_order_items_dataset')}",
                 maximum_bytes_billed=1, timeout_seconds=60)
    assert "bytes" in str(exc.value).lower() or "billed" in str(exc.value).lower()


def test_the_row_cap_holds_and_the_job_is_labelled(bq):
    seen = {}
    _cols, rows, _ = _execute(bq, f"SELECT product_category_name FROM {_t('product_category_name_translation')}",
                              max_rows=5, timeout_seconds=60, on_backend_id=lambda b: seen.update(b))
    assert len(rows) == 5
    assert seen.get("job_id") and seen.get("project") == QA_PROJECT
    job = bq["client"].get_job(seen["job_id"], project=seen["project"], location=seen["location"])
    assert job.labels.get("appbi_qa") == "gqs_rt"
    assert job.maximum_bytes_billed == CAP


# Compute-only: no table is read, so nothing is billed by bytes; it only needs to
# run long enough to be cancelled while it is still running.
_SLOW = ("SELECT COUNT(*) AS n FROM UNNEST(GENERATE_ARRAY(1, 200000)) a "
         "CROSS JOIN UNNEST(GENERATE_ARRAY(1, 200000)) b WHERE MOD(a * 7 + b, 13) = 0")


def test_a_cancel_stops_the_running_job_at_the_warehouse(bq):
    from app.services.governed_query import BigQueryCanceller

    box = {}

    def run():
        t0 = time.time()
        try:
            box["rows"] = _execute(bq, _SLOW, timeout_seconds=120,
                                   on_backend_id=lambda b: box.setdefault("backend", b))[1]
        except Exception as exc:  # noqa: BLE001 - the cancellation is the result
            box["error"] = exc
        box["elapsed"] = time.time() - t0

    th = threading.Thread(target=run, daemon=True)
    th.start()
    deadline = time.time() + 30
    while "backend" not in box and time.time() < deadline:
        time.sleep(0.1)
    assert box.get("backend", {}).get("job_id"), "the executor did not report its job"
    time.sleep(1.0)
    assert th.is_alive(), "the job finished before it could be cancelled; make _SLOW slower"
    assert BigQueryCanceller(bq["raw"], box["backend"]).cancel() is True
    th.join(timeout=60)
    assert not th.is_alive()
    assert "rows" not in box, "a cancelled job returned rows"
    b = box["backend"]
    job = bq["client"].get_job(b["job_id"], project=b["project"], location=b["location"])
    assert job.state == "DONE"
    assert job.error_result and job.error_result.get("reason") == "stopped", job.error_result


def test_a_cancel_for_a_job_that_does_not_exist_is_harmless(bq):
    from app.services.governed_query import BigQueryCanceller

    fake = {"job_id": "appbi_qa_no_such_job", "project": QA_PROJECT, "location": "us-central1"}
    assert BigQueryCanceller(bq["raw"], fake).cancel() is False
