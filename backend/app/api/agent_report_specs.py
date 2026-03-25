"""
API routes for persisted AI Agent report specs and runs.
"""
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.core import get_db
from app.core.dependencies import get_current_user, require_permission
from app.models.agent_report import AgentReportRun, AgentReportSpec
from app.models.user import User
from app.schemas.agent_report import (
    AgentReportRunCreate,
    AgentReportRunResponse,
    AgentReportRunUpdate,
    AgentReportSpecCreate,
    AgentReportSpecDetailResponse,
    AgentReportSpecResponse,
    AgentReportSpecUpdate,
)

router = APIRouter(prefix="/agent-report-specs", tags=["agent-report-specs"])


def _get_owned_spec(db: Session, spec_id: int, current_user: User) -> AgentReportSpec:
    spec = (
        db.query(AgentReportSpec)
        .options(joinedload(AgentReportSpec.runs))
        .filter(AgentReportSpec.id == spec_id)
        .first()
    )
    if not spec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent report spec not found")
    if spec.owner_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have access to this AI report")
    return spec


def _get_owned_run(
    db: Session,
    spec_id: int,
    run_id: int,
    current_user: User,
) -> tuple[AgentReportSpec, AgentReportRun]:
    spec = _get_owned_spec(db, spec_id, current_user)
    run = (
        db.query(AgentReportRun)
        .filter(AgentReportRun.report_spec_id == spec.id, AgentReportRun.id == run_id)
        .first()
    )
    if not run:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent report run not found")
    return spec, run


@router.get("/", response_model=List[AgentReportSpecResponse])
def list_agent_report_specs(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ai_agent", "view")),
):
    return (
        db.query(AgentReportSpec)
        .filter(AgentReportSpec.owner_id == current_user.id)
        .order_by(AgentReportSpec.updated_at.desc())
        .all()
    )


@router.post("/", response_model=AgentReportSpecResponse, status_code=status.HTTP_201_CREATED)
def create_agent_report_spec(
    spec_in: AgentReportSpecCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ai_agent", "edit")),
):
    spec = AgentReportSpec(
        name=spec_in.name,
        description=spec_in.description,
        status=spec_in.status,
        owner_id=current_user.id,
        latest_dashboard_id=spec_in.latest_dashboard_id,
        selected_tables_snapshot=spec_in.selected_tables_snapshot,
        brief_json=spec_in.brief_json,
        approved_plan_json=spec_in.approved_plan_json,
    )
    db.add(spec)
    db.commit()
    db.refresh(spec)
    return spec


@router.get("/{spec_id}", response_model=AgentReportSpecDetailResponse)
def get_agent_report_spec(
    spec_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ai_agent", "view")),
):
    return _get_owned_spec(db, spec_id, current_user)


@router.put("/{spec_id}", response_model=AgentReportSpecResponse)
def update_agent_report_spec(
    spec_id: int,
    spec_in: AgentReportSpecUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ai_agent", "edit")),
):
    spec = _get_owned_spec(db, spec_id, current_user)
    for key, value in spec_in.model_dump(exclude_unset=True).items():
        setattr(spec, key, value)
    db.commit()
    db.refresh(spec)
    return spec


@router.get("/{spec_id}/runs", response_model=List[AgentReportRunResponse])
def list_agent_report_runs(
    spec_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ai_agent", "view")),
):
    spec = _get_owned_spec(db, spec_id, current_user)
    return (
        db.query(AgentReportRun)
        .filter(AgentReportRun.report_spec_id == spec.id)
        .order_by(AgentReportRun.created_at.desc())
        .all()
    )


@router.post("/{spec_id}/runs", response_model=AgentReportRunResponse, status_code=status.HTTP_201_CREATED)
def create_agent_report_run(
    spec_id: int,
    run_in: AgentReportRunCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ai_agent", "edit")),
):
    spec = _get_owned_spec(db, spec_id, current_user)
    if run_in.input_brief_json:
        spec.brief_json = run_in.input_brief_json
        selected_tables = run_in.input_brief_json.get("selected_tables")
        if isinstance(selected_tables, list):
            spec.selected_tables_snapshot = selected_tables
    if run_in.plan_json:
        spec.approved_plan_json = run_in.plan_json
    run = AgentReportRun(
        report_spec_id=spec.id,
        triggered_by=current_user.id,
        build_mode=run_in.build_mode,
        status=run_in.status,
        input_brief_json=run_in.input_brief_json,
        plan_json=run_in.plan_json,
        target_dashboard_id=run_in.target_dashboard_id,
    )
    spec.status = "running"
    spec.last_run_at = datetime.now(timezone.utc)
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


@router.patch("/{spec_id}/runs/{run_id}", response_model=AgentReportRunResponse)
def update_agent_report_run(
    spec_id: int,
    run_id: int,
    run_in: AgentReportRunUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ai_agent", "edit")),
):
    spec, run = _get_owned_run(db, spec_id, run_id, current_user)
    update_data = run_in.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(run, key, value)

    if run.dashboard_id is not None:
        spec.latest_dashboard_id = run.dashboard_id

    if run.status == "succeeded":
        spec.status = "ready"
        spec.last_run_at = run.finished_at or datetime.now(timezone.utc)
    elif run.status == "failed":
        spec.status = "failed"
        spec.last_run_at = run.finished_at or datetime.now(timezone.utc)
    elif run.status in {"queued", "planning", "building"}:
        spec.status = "running"

    db.commit()
    db.refresh(run)
    return run
