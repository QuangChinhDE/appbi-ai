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
from typing import Any, Dict, List, Optional

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
        Returns list of anomaly dicts (empty = no anomaly detected).
        """
        from app.services.live_query_service import (
            _dialect_for_ds_type,
            _quote_identifier,
            build_live_base_query_plan,
        )
        from app.services.datasource_service import DataSourceConnectionService

        table: DatasetTable = metric.dataset_table
        if not table:
            return []
        datasource: DataSource = db.query(DataSource).filter(
            DataSource.id == table.datasource_id
        ).first()
        if not datasource:
            return []

        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)

        # Build live base query (handles physical tables, sql_query, transforms, type overrides)
        try:
            plan = build_live_base_query_plan(datasource, table, apply_type_overrides=True)
        except Exception as exc:
            logger.warning("AnomalyDetection: failed to build query plan for metric %s — %s", metric.id, exc)
            return []

        base = f"({plan.sql}) AS base_table"

        time_col = metric.time_column
        metric_col = metric.metric_column

        if not time_col or not metric_col:
            # Without time column we can't do period comparison — skip
            return []

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
            return []

        if len(history) < 8:
            return []  # not enough data

        values = [float(r.get("val") or 0) for r in history]
        window = values[-8:-1]  # last 7 days (excluding today)
        if len(window) < 3:
            return []

        mean = statistics.mean(window)
        try:
            std = statistics.stdev(window)
        except statistics.StatisticsError:
            std = 0.0
        if std == 0:
            return []

        current = values[-1]
        z = (current - mean) / std

        if abs(z) < metric.threshold_z_score:
            return []

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

        return [anomaly]

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
        for metric in metrics:
            try:
                anomalies = AnomalyDetectionService.check_metric(metric, db)
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

        if found > 0:
            try:
                db.commit()
            except Exception as exc:
                logger.error("AnomalyDetection: commit failed — %s", exc)
                db.rollback()

        logger.info("AnomalyDetection: checked=%d anomalies_found=%d", checked, found)
        return {"checked": checked, "anomalies_found": found}

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
