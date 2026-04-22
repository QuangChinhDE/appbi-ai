"""
Dataset Quality Automation Scheduler
====================================
Background APScheduler that periodically runs all enabled quality rules for
each dataset whose `DatasetQualitySchedule.enabled=True` and `type="schedule"`,
then emails a PDF report to configured recipients.

The DB is the source of truth. On FastAPI startup we load every enabled
schedule and register a cron job per dataset. API endpoints call
`sync_dataset_schedule(dataset_id)` after every create/update/delete to keep
the live job registry in sync without a full restart.

Overlap is handled centrally by `DatasetQualityService.trigger_run`, which
refuses to create a scheduled run while another run is still queued or
running for the same dataset.

This module intentionally mirrors `anomaly_scheduler` for consistency.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.core.database import SessionLocal
from app.models.dataset import (
    Dataset,
    DatasetQualityRule,
    DatasetQualityRun,
    DatasetQualitySchedule,
    DatasetTable,
)
from app.services.dataset_quality_service import DatasetQualityService
from app.services.quality_email_service import send_quality_report
from app.services.quality_report_pdf import build_quality_run_pdf

logger = logging.getLogger(__name__)

_scheduler: Optional[BackgroundScheduler] = None


def _rule_status(rule: DatasetQualityRule, result: Dict[str, Any]) -> str:
    if result.get("skipped"):
        return "skipped"
    if result.get("passed") and not result.get("error"):
        return "passed"

    severity = str(getattr(rule, "severity", "warning") or "warning").lower()
    if result.get("error") or severity == "error":
        return "failed"
    if severity == "warning":
        return "warning"
    return "info"


def _job_id(dataset_id: int) -> str:
    return f"dataset_quality:{dataset_id}"


def _get_trigger(schedule: DatasetQualitySchedule) -> Optional[CronTrigger]:
    if not schedule.enabled or schedule.type != "schedule":
        return None
    if not schedule.cron:
        return None
    try:
        return CronTrigger.from_crontab(schedule.cron, timezone=schedule.timezone or "UTC")
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "[quality_scheduler] Invalid cron/timezone for dataset %s (%r / %r): %s",
            schedule.dataset_id,
            schedule.cron,
            schedule.timezone,
            exc,
        )
        return None


def _execute_scheduled_run(dataset_id: int, schedule_id: int) -> None:
    """
    Full scheduled run body: create run -> execute -> email PDF -> update
    schedule bookkeeping. Runs inside the APScheduler worker thread with its
    own DB session (like anomaly_scheduler / FastAPI background tasks).
    """
    db = SessionLocal()
    try:
        schedule = (
            db.query(DatasetQualitySchedule)
            .filter(DatasetQualitySchedule.id == schedule_id)
            .first()
        )
        if schedule is None or not schedule.enabled or schedule.type != "schedule":
            logger.info(
                "[quality_scheduler] Schedule %s no longer active — skipping.",
                schedule_id,
            )
            return

        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if dataset is None:
            logger.warning("[quality_scheduler] Dataset %s missing — disabling schedule.", dataset_id)
            schedule.enabled = False
            schedule.last_error = "Dataset not found"
            db.commit()
            return

        run = DatasetQualityService.trigger_run(
            db,
            dataset_id,
            triggered_by_id=schedule.created_by_id,
            trigger_source="schedule",
            schedule_id=schedule.id,
            allow_overlap=False,
        )
        if run is None:
            # Another run is still active. Skip this tick; next tick will try again.
            logger.info(
                "[quality_scheduler] Skipped scheduled run for dataset %s (overlap).",
                dataset_id,
            )
            schedule.last_error = "Skipped — previous run still active"
            _refresh_next_run(schedule)
            db.commit()
            return

        run_id = run.id
        # Release current session before the (potentially slow) execute_run —
        # execute_run opens its own session internally.
        db.close()
        db = SessionLocal()

        DatasetQualityService.execute_run(run_id)

        # Reload the run and rules to build the email.
        run = db.query(DatasetQualityRun).filter(DatasetQualityRun.id == run_id).first()
        schedule = (
            db.query(DatasetQualitySchedule)
            .filter(DatasetQualitySchedule.id == schedule_id)
            .first()
        )
        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if run is None or schedule is None or dataset is None:
            return

        rules = (
            db.query(DatasetQualityRule)
            .filter(DatasetQualityRule.dataset_id == dataset_id)
            .all()
        )
        tables = (
            db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == dataset_id)
            .all()
        )

        schedule.last_run_at = run.completed_at or datetime.utcnow()
        schedule.last_run_status = run.status
        schedule.last_error = run.error_message if run.status == "failed" else None
        _refresh_next_run(schedule)

        send = False
        if run.status == "failed" and schedule.notify_on_failure:
            send = True
        elif run.status == "completed" and schedule.notify_on_success:
            send = True

        if send:
            try:
                pdf_bytes = build_quality_run_pdf(dataset, run, rules, tables)
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "[quality_scheduler] PDF build failed for dataset %s run %s: %s",
                    dataset_id,
                    run_id,
                    exc,
                )
                pdf_bytes = None

            subject = _build_subject(dataset.name, run.status, run.score)
            text_body, html_body = _build_bodies(dataset.name, run, rules)
            filename = f"quality-{dataset.id}-run-{run.id}.pdf"

            delivered = send_quality_report(
                subject=subject,
                html_body=html_body,
                text_body=text_body,
                primary_recipient=schedule.recipient_email,
                cc_recipients=list(schedule.cc_emails or []),
                pdf_bytes=pdf_bytes,
                pdf_filename=filename,
            )
            if not delivered:
                # Do not mark the schedule as errored just because SMTP is
                # unconfigured — the monitoring run itself succeeded.
                logger.info(
                    "[quality_scheduler] Email not delivered for dataset %s run %s",
                    dataset_id,
                    run_id,
                )

        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "[quality_scheduler] Unhandled error (dataset=%s, schedule=%s): %s",
            dataset_id,
            schedule_id,
            exc,
            exc_info=True,
        )
        try:
            sched = (
                db.query(DatasetQualitySchedule)
                .filter(DatasetQualitySchedule.id == schedule_id)
                .first()
            )
            if sched is not None:
                sched.last_error = str(exc)[:2000]
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _build_subject(dataset_name: str, status: Optional[str], score: Optional[float]) -> str:
    status_label = (status or "").capitalize() or "Completed"
    score_label = f" — {float(score):.1f}%" if isinstance(score, (int, float)) else ""
    return f"[AppBI] Quality report · {dataset_name}{score_label} · {status_label}"


def _build_bodies(
    dataset_name: str,
    run: DatasetQualityRun,
    rules: list[DatasetQualityRule],
) -> tuple[str, str]:
    score = run.score
    score_text = f"{score:.1f}%" if isinstance(score, (int, float)) else "—"
    status_text = (run.status or "").capitalize() or "Completed"
    results = run.results or {}
    stats = {"passed": 0, "info": 0, "warning": 0, "failed": 0, "skipped": 0}
    total = 0
    for rule in rules:
        result = results.get(str(rule.id)) if isinstance(results, dict) else None
        if not isinstance(result, dict):
            continue
        total += 1
        stats[_rule_status(rule, result)] += 1

    findings_line = (
        f"pass {stats['passed']} · info {stats['info']} · "
        f"warning {stats['warning']} · failed {stats['failed']}"
    )
    if stats["skipped"]:
        findings_line += f" · skipped {stats['skipped']}"

    text = (
        f"AppBI Dataset Quality — {dataset_name}\n"
        f"Run #{run.id} · {status_text}\n"
        f"Score: {score_text}\n"
        f"Rule status summary: {findings_line} (total {total})\n\n"
        "See the attached PDF for the full breakdown."
    )
    html = (
        f"<p>Hi,</p>"
        f"<p>The scheduled quality check for dataset "
        f"<b>{dataset_name}</b> has finished.</p>"
        f"<ul>"
        f"<li><b>Run:</b> #{run.id}</li>"
        f"<li><b>Status:</b> {status_text}</li>"
        f"<li><b>Score:</b> {score_text}</li>"
        f"<li><b>Rule status summary:</b> {findings_line} (total {total})</li>"
        f"</ul>"
        f"<p>Full details are attached as a PDF report.</p>"
        f"<p style='color:#6b7280;font-size:12px'>— Sent automatically by AppBI.</p>"
    )
    return text, html


def _refresh_next_run(schedule: DatasetQualitySchedule) -> None:
    """Compute next_run_at from cron if the scheduler is active."""
    trigger = _get_trigger(schedule)
    if trigger is None or _scheduler is None or not _scheduler.running:
        schedule.next_run_at = None
        return
    try:
        next_fire = trigger.get_next_fire_time(None, datetime.utcnow())
        schedule.next_run_at = next_fire.replace(tzinfo=None) if next_fire else None
    except Exception:
        schedule.next_run_at = None


# ── Public API ────────────────────────────────────────────────────────────


def sync_dataset_schedule(dataset_id: int) -> None:
    """
    Synchronise the APScheduler job registry with the DB record for this
    dataset. Called from API endpoints after create/update/disable.
    """
    global _scheduler
    if _scheduler is None or not _scheduler.running:
        # Scheduler not active yet (e.g. during tests) — DB changes persist;
        # startup() will pick them up on next boot.
        return

    db = SessionLocal()
    try:
        schedule = (
            db.query(DatasetQualitySchedule)
            .filter(DatasetQualitySchedule.dataset_id == dataset_id)
            .first()
        )

        job_id = _job_id(dataset_id)
        _scheduler.remove_job(job_id) if _scheduler.get_job(job_id) else None

        if schedule is None:
            return

        trigger = _get_trigger(schedule)
        if trigger is None:
            schedule.next_run_at = None
            db.commit()
            return

        _scheduler.add_job(
            _execute_scheduled_run,
            trigger=trigger,
            id=job_id,
            args=[schedule.dataset_id, schedule.id],
            replace_existing=True,
            misfire_grace_time=600,
            coalesce=True,
            max_instances=1,
        )
        _refresh_next_run(schedule)
        db.commit()
        logger.info(
            "[quality_scheduler] Scheduled dataset %s cron=%r tz=%r",
            dataset_id,
            schedule.cron,
            schedule.timezone,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("[quality_scheduler] sync failed for dataset %s: %s", dataset_id, exc)
    finally:
        db.close()


def startup() -> None:
    """Boot scheduler and register all enabled schedules from DB."""
    global _scheduler
    if _scheduler is not None and _scheduler.running:
        return

    _scheduler = BackgroundScheduler(timezone="UTC")
    _scheduler.start()

    db = SessionLocal()
    try:
        schedules = (
            db.query(DatasetQualitySchedule)
            .filter(DatasetQualitySchedule.enabled.is_(True))
            .filter(DatasetQualitySchedule.type == "schedule")
            .all()
        )
        for schedule in schedules:
            trigger = _get_trigger(schedule)
            if trigger is None:
                continue
            _scheduler.add_job(
                _execute_scheduled_run,
                trigger=trigger,
                id=_job_id(schedule.dataset_id),
                args=[schedule.dataset_id, schedule.id],
                replace_existing=True,
                misfire_grace_time=600,
                coalesce=True,
                max_instances=1,
            )
            _refresh_next_run(schedule)
        db.commit()
        logger.info(
            "[quality_scheduler] Started with %d active schedule(s).",
            len(schedules),
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("[quality_scheduler] Startup load failed: %s", exc)
    finally:
        db.close()


def shutdown() -> None:
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("[quality_scheduler] Stopped")
    _scheduler = None
