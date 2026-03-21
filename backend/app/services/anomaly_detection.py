"""
AnomalyDetectionService — Phase 4 Proactive Intelligence.

Runs on a scheduler (daily by default). For each active MonitoredMetric:
  1. Pulls historical daily values from DuckDB / Parquet
  2. Computes 7-day rolling mean + std
  3. Flags anomalies where |z-score| >= threshold
  4. Saves AnomalyAlert records with LLM-generated explanation

Design decisions:
  - Uses DuckDB directly (synced Parquet) — fast, no live-source round-trip
  - numpy is optional; falls back to stdlib statistics
  - LLM explanation is optional; stored in alert.explanation
"""
import logging
import statistics
from datetime import datetime, date, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.anomaly import AnomalyAlert, MonitoredMetric
from app.models.dataset_workspace import DatasetWorkspaceTable
from app.models.models import DataSource

logger = logging.getLogger(__name__)

_SEVERITY_THRESHOLDS = [(3.0, "critical"), (2.5, "warning"), (2.0, "info")]


class AnomalyDetectionService:

    # ── Core detection ──────────────────────────────────────────────────────

    @staticmethod
    def check_metric(metric: MonitoredMetric, db: Session) -> List[Dict[str, Any]]:
        """
        Check one metric for anomalies.
        Returns list of anomaly dicts (empty = no anomaly detected).
        """
        from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb
        from app.services.duckdb_engine import DuckDBEngine

        table: DatasetWorkspaceTable = metric.workspace_table
        if not table:
            return []
        datasource: DataSource = db.query(DataSource).filter(
            DataSource.id == table.datasource_id
        ).first()
        if not datasource:
            return []

        # Resolve DuckDB base table
        if table.source_kind == "sql_query" and table.source_query:
            rewritten = rewrite_sql_for_duckdb(datasource.id, table.source_query)
            if not rewritten:
                return []
            base = f"({rewritten}) AS base_table"
        elif table.source_kind == "physical_table" and table.source_table_name:
            view_name = get_synced_view(datasource.id, table.source_table_name)
            if not view_name:
                return []
            base = view_name
        else:
            return []

        time_col = metric.time_column
        metric_col = metric.metric_column
        agg = (metric.aggregation or "sum").upper()

        if not time_col:
            # Without time column we can't do period comparison — skip
            return []

        # Fetch last 30 days daily values
        try:
            history = DuckDBEngine.query(f"""
                SELECT
                    date_trunc('day', CAST("{time_col}" AS TIMESTAMP)) AS dt,
                    {agg}("{metric_col}") AS val
                FROM {base}
                WHERE CAST("{time_col}" AS TIMESTAMP) >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY 1
                ORDER BY 1
            """)
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
        for dim in dim_cols[:3]:
            try:
                dim_rows = DuckDBEngine.query(f"""
                    SELECT
                        "{dim}",
                        {agg}("{metric_col}") AS val
                    FROM {base}
                    WHERE CAST("{time_col}" AS TIMESTAMP) >= CURRENT_DATE - INTERVAL '7 days'
                    GROUP BY "{dim}"
                    ORDER BY val DESC
                    LIMIT 10
                """)
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
