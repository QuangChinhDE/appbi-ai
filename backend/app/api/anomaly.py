"""
API routes for Phase 4 Proactive Intelligence:
  - Monitored Metrics (CRUD)
  - Anomaly Alerts (list, mark read, delete)
  - Manual trigger for anomaly scan
"""
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core import get_db
from app.core.dependencies import get_current_user, require_permission, require_view_access
from app.models.dataset import Dataset, DatasetTable
from app.models.anomaly import AnomalyAlert, MonitoredMetric
from app.models.user import User
from app.services.anomaly_detection import AnomalyDetectionService

router = APIRouter(prefix="/anomaly", tags=["anomaly"])


# ── Pydantic schemas ────────────────────────────────────────────────────────────

class MonitoredMetricCreate(BaseModel):
    dataset_table_id: int
    metric_column: str
    aggregation: str = "sum"
    time_column: Optional[str] = None
    dimension_columns: List[str] = []
    check_frequency: str = "daily"
    threshold_z_score: float = 2.0


class MonitoredMetricResponse(BaseModel):
    id: int
    dataset_table_id: int
    metric_column: str
    aggregation: str
    time_column: Optional[str]
    dimension_columns: List[str]
    check_frequency: str
    threshold_z_score: float
    is_active: bool
    owner_id: str
    created_at: datetime

    model_config = {"from_attributes": True}


class AnomalyAlertResponse(BaseModel):
    id: int
    monitored_metric_id: int
    detected_at: datetime
    current_value: float
    expected_value: float
    z_score: float
    change_pct: float
    dimension_values: Optional[Dict[str, Any]]
    severity: str
    is_read: bool
    explanation: Optional[str]
    metric_column: Optional[str] = None
    table_name: Optional[str] = None

    model_config = {"from_attributes": True}


# ── Monitored Metrics ──────────────────────────────────────────────────────────

@router.get("/metrics", response_model=List[MonitoredMetricResponse])
def list_monitored_metrics(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all monitored metrics owned by the current user."""
    return db.query(MonitoredMetric).filter(
        MonitoredMetric.owner_id == current_user.id
    ).order_by(MonitoredMetric.created_at.desc()).all()


@router.post("/metrics", response_model=MonitoredMetricResponse, status_code=201)
def create_monitored_metric(
    payload: MonitoredMetricCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ai_chat", "edit")),
):
    """Create a new monitored metric."""
    table = db.query(DatasetTable).filter(
        DatasetTable.id == payload.dataset_table_id
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Dataset table not found")
    dataset_obj = db.query(Dataset).filter(
        Dataset.id == table.dataset_id
    ).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")

    metric = MonitoredMetric(
        dataset_table_id=payload.dataset_table_id,
        metric_column=payload.metric_column,
        aggregation=payload.aggregation,
        time_column=payload.time_column,
        dimension_columns=payload.dimension_columns,
        check_frequency=payload.check_frequency,
        threshold_z_score=payload.threshold_z_score,
        owner_id=current_user.id,
    )
    db.add(metric)
    db.commit()
    db.refresh(metric)
    return metric


@router.patch("/metrics/{metric_id}/toggle", response_model=MonitoredMetricResponse)
def toggle_monitored_metric(
    metric_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Toggle active/inactive for a monitored metric."""
    metric = db.query(MonitoredMetric).filter(
        MonitoredMetric.id == metric_id,
        MonitoredMetric.owner_id == current_user.id,
    ).first()
    if not metric:
        raise HTTPException(status_code=404, detail="Metric not found")
    metric.is_active = not metric.is_active
    db.commit()
    db.refresh(metric)
    return metric


@router.delete("/metrics/{metric_id}", status_code=204)
def delete_monitored_metric(
    metric_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a monitored metric and all its alerts."""
    metric = db.query(MonitoredMetric).filter(
        MonitoredMetric.id == metric_id,
        MonitoredMetric.owner_id == current_user.id,
    ).first()
    if not metric:
        raise HTTPException(status_code=404, detail="Metric not found")
    db.delete(metric)
    db.commit()


# ── Anomaly Alerts ─────────────────────────────────────────────────────────────

@router.get("/alerts", response_model=List[AnomalyAlertResponse])
def list_anomaly_alerts(
    unread_only: bool = False,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List anomaly alerts for the current user's metrics."""
    q = (
        db.query(AnomalyAlert)
        .join(MonitoredMetric, AnomalyAlert.monitored_metric_id == MonitoredMetric.id)
        .filter(MonitoredMetric.owner_id == current_user.id)
    )
    if unread_only:
        q = q.filter(AnomalyAlert.is_read == False)
    alerts = q.order_by(AnomalyAlert.detected_at.desc()).limit(min(limit, 200)).all()

    # Enrich with metric column + table name
    result = []
    for alert in alerts:
        a = AnomalyAlertResponse.model_validate(alert)
        a.metric_column = alert.metric.metric_column if alert.metric else None
        if alert.metric and alert.metric.dataset_table:
            a.table_name = alert.metric.dataset_table.display_name
        result.append(a)
    return result


@router.patch("/alerts/{alert_id}/read", response_model=AnomalyAlertResponse)
def mark_alert_read(
    alert_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark an alert as read."""
    alert = (
        db.query(AnomalyAlert)
        .join(MonitoredMetric)
        .filter(
            AnomalyAlert.id == alert_id,
            MonitoredMetric.owner_id == current_user.id,
        )
        .first()
    )
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    alert.is_read = True
    db.commit()
    db.refresh(alert)
    return alert


@router.delete("/alerts/read-all", status_code=204)
def clear_read_alerts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete all read alerts for the current user."""
    (
        db.query(AnomalyAlert)
        .join(MonitoredMetric)
        .filter(
            MonitoredMetric.owner_id == current_user.id,
            AnomalyAlert.is_read == True,
        )
        .delete(synchronize_session="fetch")
    )
    db.commit()


# ── Manual scan trigger ────────────────────────────────────────────────────────

@router.post("/scan", response_model=Dict[str, Any])
def trigger_anomaly_scan(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ai_chat", "edit")),
):
    """
    Manually trigger anomaly detection for all active metrics.
    Normally runs automatically via scheduler.
    """
    result = AnomalyDetectionService.run_all_checks(db)
    return result
