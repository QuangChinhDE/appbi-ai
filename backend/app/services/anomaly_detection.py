"""
AnomalyDetectionService — Phase 4 Proactive Intelligence.

Runs on a scheduler (daily by default). For each active MonitoredMetric:
  1. Pulls historical daily values via live query against the source database
  2. Computes 7-day rolling mean + std
  3. Flags anomalies where |z-score| >= threshold
  4. Saves AnomalyAlert records with LLM-generated explanation

Design decisions:
  - Queries the source database directly (BigQuery / PostgreSQL / MySQL)
  - numpy is optional; falls back to stdlib statistics
  - LLM explanation is optional; stored in alert.explanation
"""
import logging
import statistics
from datetime import datetime, date, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.anomaly import AnomalyAlert, MonitoredMetric
from app.models.dataset import DatasetTable
from app.models.models import DataSource

logger = logging.getLogger(__name__)

_SEVERITY_THRESHOLDS = [(3.0, "critical"), (2.5, "warning"), (2.0, "info")]


class AnomalyDetectionService:

    # ── Core detection ──────────────────────────────────────────────────────

    @staticmethod
    def _date_bucket_day(column_name: str, dialect: str) -> str:
        """Return a dialect-aware day bucket expression for the given column."""
        from app.services.live_query_service import _quote_identifier

        quoted = _quote_identifier(column_name, dialect)
        if dialect == "bigquery":
            return f"DATE({quoted})"
        if dialect == "mysql":
            return f"DATE({quoted})"
        # postgresql (default)
        return f"CAST({quoted} AS DATE)"

    @staticmethod
    def _render_aggregate(metric_column: str, aggregation: str, dialect: str) -> str:
        """Render a safe aggregate expression for the metric column."""
        from app.services.live_query_service import _quote_identifier

        quoted_metric = _quote_identifier(metric_column, dialect)
        normalized = str(aggregation or "sum").upper().replace(" ", "_")
        if normalized == "COUNT_DISTINCT":
            return f"COUNT(DISTINCT {quoted_metric})"
        if normalized == "COUNT":
            return f"COUNT({quoted_metric})"
        return f"{normalized}({quoted_metric})"

    @staticmethod
    def _date_interval_ago(days: int, dialect: str) -> str:
        """Return dialect-aware 'current_date minus N days' expression."""
        if dialect == "bigquery":
            return f"DATE_SUB(CURRENT_DATE(), INTERVAL {days} DAY)"
        if dialect == "mysql":
            return f"DATE_SUB(CURDATE(), INTERVAL {days} DAY)"
        # postgresql (default)
        return f"CURRENT_DATE - INTERVAL '{days} days'"

    @staticmethod
    def check_metric(metric: MonitoredMetric, db: Session) -> List[Dict[str, Any]]:
        """
        Check one metric for anomalies.
        Returns list of anomaly dicts (empty = no anomaly detected OR the check
        could not run - use check_metric_outcome to tell those apart).
        """
        return AnomalyDetectionService.check_metric_outcome(metric, db)[1]

    @staticmethod
    def check_metric_outcome(metric: MonitoredMetric, db: Session) -> Tuple[str, List[Dict[str, Any]], Optional[str]]:
        """(status, anomalies, reason). status: ok | anomaly | error | insufficient.
        "ok" only when the queries ran and the latest value is inside the
        expected band - never for a check that failed or could not judge."""
        from app.services.live_query_service import (
            _dialect_for_ds_type,
            _quote_identifier,
        )
        from app.services.dataset_relation_service import resolve_dataset_table_relation
        from app.services.datasource_service import DataSourceConnectionService

        table: DatasetTable = metric.dataset_table
        if not table:
            return "error", [], "dataset table missing"
        datasource: DataSource = db.query(DataSource).filter(
            DataSource.id == table.datasource_id
        ).first()
        if not datasource:
            return "error", [], "data source missing"

        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)

        # Build live base query (handles physical tables, sql_query, transforms, type overrides)
        try:
            plan = resolve_dataset_table_relation(datasource, table)
        except Exception as exc:
            logger.warning("AnomalyDetection: failed to build query plan for metric %s — %s", metric.id, exc)
            return "error", [], f"cannot build the table query: {type(exc).__name__}"

        base = f"({plan.sql}) AS base_table"

        time_col = metric.time_column
        metric_col = metric.metric_column

        if not time_col or not metric_col:
            # Without time column we can't do period comparison — skip
            return "insufficient", [], "no time column"

        dt_expr = AnomalyDetectionService._date_bucket_day(time_col, dialect)
        time_expr = AnomalyDetectionService._date_bucket_day(time_col, dialect)
        metric_expr = AnomalyDetectionService._render_aggregate(metric_col, metric.aggregation, dialect)
        since_30d = AnomalyDetectionService._date_interval_ago(30, dialect)

        # Fetch last 30 days daily values
        history_sql = f"""
            SELECT
                {dt_expr} AS dt,
                {metric_expr} AS val
            FROM {base}
            WHERE {time_expr} >= {since_30d}
            GROUP BY 1
            ORDER BY 1
        """
        try:
            _, history, _ = DataSourceConnectionService.execute_query(
                ds_type, datasource.config, history_sql, timeout_seconds=60,
            )
        except Exception as exc:
            logger.warning("AnomalyDetection: history query failed for metric %s — %s", metric.id, exc)
            return "error", [], f"history query failed: {type(exc).__name__}"

        if len(history) < 8:
            return "insufficient", [], "fewer than 8 days of data"

        values = [float(r.get("val") or 0) for r in history]
        window = values[-8:-1]  # last 7 days (excluding today)
        if len(window) < 3:
            return "insufficient", [], "fewer than 3 baseline days"

        mean = statistics.mean(window)
        try:
            std = statistics.stdev(window)
        except statistics.StatisticsError:
            std = 0.0
        current = values[-1]
        if std == 0:
            # A constant baseline: equal is normal; a different value cannot be
            # scored - it is not evidence of "normal" either.
            if current == mean:
                return "ok", [], None
            return "insufficient", [], "constant baseline, value changed"

        z = (current - mean) / std

        if abs(z) < metric.threshold_z_score:
            return "ok", [], None

        change_pct = round((current - mean) / mean * 100, 1) if mean else 0
        severity = "info"
        for threshold, sev in _SEVERITY_THRESHOLDS:
            if abs(z) >= threshold:
                severity = sev
                break

        anomaly: Dict[str, Any] = {
            "current_value": current,
            "expected_value": round(mean, 4),
            "z_score": round(z, 2),
            "change_pct": change_pct,
            "severity": severity,
            "dimension_values": None,
        }

        # Optional: drill down by dimension columns
        dim_cols: List[str] = metric.dimension_columns or []
        breakdowns = {}
        since_7d = AnomalyDetectionService._date_interval_ago(7, dialect)
        for dim in dim_cols[:3]:
            try:
                quoted_dim = _quote_identifier(dim, dialect)
                dim_sql = f"""
                    SELECT
                        {quoted_dim},
                        {metric_expr} AS val
                    FROM {base}
                    WHERE {time_expr} >= {since_7d}
                    GROUP BY {quoted_dim}
                    ORDER BY val DESC
                    LIMIT 10
                """
                _, dim_rows, _ = DataSourceConnectionService.execute_query(
                    ds_type, datasource.config, dim_sql, timeout_seconds=60,
                )
                breakdowns[dim] = [{k: v for k, v in r.items()} for r in dim_rows[:5]]
            except Exception:
                pass
        if breakdowns:
            anomaly["dimension_values"] = breakdowns

        return "anomaly", [anomaly], None

    @staticmethod
    def run_all_checks(db: Session) -> Dict[str, int]:
        """
        Scheduled job: check all active monitored metrics.
        Returns summary {checked, anomalies_found}.
        """
        metrics = db.query(MonitoredMetric).filter(
            MonitoredMetric.is_active == True
        ).all()

        checked = 0
        found = 0
        errored = 0
        for metric in metrics:
            now = datetime.utcnow()
            try:
                status, anomalies, reason = AnomalyDetectionService.check_metric_outcome(metric, db)
            except Exception as exc:  # noqa: BLE001 — recorded as a failed check, never as normal
                logger.warning("AnomalyDetection: metric %s failed — %s", metric.id, exc)
                status, anomalies, reason = "error", [], f"{type(exc).__name__}"
            metric.last_checked_at = now
            metric.last_check_status = status
            metric.last_check_error = reason if status in ("error", "insufficient") else None
            if status == "ok":
                metric.last_ok_at = now
            if status == "error":
                errored += 1
            try:
                for a in anomalies:
                    alert = AnomalyAlert(
                        monitored_metric_id=metric.id,
                        current_value=a["current_value"],
                        expected_value=a["expected_value"],
                        z_score=a["z_score"],
                        change_pct=a["change_pct"],
                        severity=a["severity"],
                        dimension_values=a.get("dimension_values"),
                        explanation=AnomalyDetectionService._build_explanation(metric, a),
                    )
                    db.add(alert)
                    found += 1
                checked += 1
            except Exception as exc:
                logger.warning("AnomalyDetection: metric %s failed — %s", metric.id, exc)

        # Always commit: the check outcomes are what the Observability fold
        # reads to decide whether an anomaly is over.
        try:
            db.commit()
        except Exception as exc:
            logger.error("AnomalyDetection: commit failed — %s", exc)
            db.rollback()
            raise

        logger.info("AnomalyDetection: checked=%d anomalies_found=%d errored=%d", checked, found, errored)
        return {"checked": checked, "anomalies_found": found, "errored": errored}

    @staticmethod
    def _build_explanation(metric: MonitoredMetric, anomaly: Dict) -> str:
        """Build a simple text explanation without LLM (avoids extra cost/latency in scheduler)."""
        direction = "increased" if anomaly["change_pct"] > 0 else "decreased"
        return (
            f"{metric.metric_column} {direction} by {abs(anomaly['change_pct']):.1f}% "
            f"(z-score={anomaly['z_score']:.2f}) compared to the 7-day average of "
            f"{anomaly['expected_value']:.2f}. Current value: {anomaly['current_value']:.2f}. "
            f"Severity: {anomaly['severity']}."
        )
