"""
Quality Report PDF builder
==========================
Renders a DatasetQualityRun into a compact, email-friendly PDF using ReportLab.
The report is generated in-memory (no filesystem writes) and returned as bytes
so the email service can attach it directly.

The layout is intentionally table-heavy and dependency-free (no fonts or
images beyond ReportLab defaults) to keep rendering robust on minimal
container images.
"""
from __future__ import annotations

import io
from datetime import datetime
from typing import Any, Dict, List, Optional
from xml.sax.saxutils import escape

from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.models.dataset import (
    Dataset,
    DatasetQualityRule,
    DatasetQualityRun,
    DatasetTable,
)


_DIMENSIONS_ORDER = [
    "completeness",
    "validity",
    "uniqueness",
    "consistency",
    "timeliness",
    "accuracy",
]


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


def _fmt_dt(value: Optional[datetime]) -> str:
    if not value:
        return "—"
    return value.strftime("%Y-%m-%d %H:%M:%S UTC")


def _fmt_score(score: Optional[float]) -> str:
    if score is None:
        return "—"
    try:
        return f"{float(score):.1f}%"
    except (TypeError, ValueError):
        return "—"


def _truncate(value: Any, max_len: int = 120) -> str:
    text = str(value or "")
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "…"


def _paragraph(value: Any, style: ParagraphStyle, default: str = "—") -> Paragraph:
    text = str(value).strip() if value is not None else ""
    if not text:
        text = default
    safe_text = escape(text).replace("\n", "<br/>")
    return Paragraph(safe_text, style)


def build_quality_run_pdf(
    dataset: Dataset,
    run: DatasetQualityRun,
    rules: List[DatasetQualityRule],
    tables: List[DatasetTable],
) -> bytes:
    """Return a PDF as bytes summarising the given quality run."""
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"Quality Report — {dataset.name}",
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        name="TitleBold",
        parent=styles["Title"],
        fontSize=18,
        spaceAfter=6,
    )
    subtitle_style = ParagraphStyle(
        name="Subtitle",
        parent=styles["Normal"],
        fontSize=10,
        textColor=colors.HexColor("#6b7280"),
        spaceAfter=12,
    )
    section_style = ParagraphStyle(
        name="Section",
        parent=styles["Heading2"],
        fontSize=13,
        spaceAfter=6,
        spaceBefore=10,
    )
    body_style = ParagraphStyle(
        name="Body",
        parent=styles["Normal"],
        fontSize=9.5,
        leading=13,
    )
    table_cell_style = ParagraphStyle(
        name="TableCell",
        parent=body_style,
        fontSize=8.2,
        leading=10,
        alignment=TA_LEFT,
        wordWrap="CJK",
    )
    table_cell_center_style = ParagraphStyle(
        name="TableCellCenter",
        parent=table_cell_style,
        alignment=TA_CENTER,
    )
    failed_header_style = ParagraphStyle(
        name="FailedHeader",
        parent=table_cell_center_style,
        fontSize=8,
        leading=9,
        textColor=colors.white,
        fontName="Helvetica-Bold",
    )

    story: List[Any] = []

    # ── Header ────────────────────────────────────────────────────────
    story.append(Paragraph(f"Dataset Quality Report", title_style))
    story.append(
        Paragraph(
            f"Dataset: <b>{dataset.name}</b> &nbsp;•&nbsp; Run #{run.id} &nbsp;•&nbsp; "
            f"Triggered: {run.trigger_source or 'manual'}",
            subtitle_style,
        )
    )

    # ── Run summary table ────────────────────────────────────────────
    results: Dict[str, Any] = run.results or {}
    rule_by_id = {r.id: r for r in rules}
    table_by_id = {t.id: t for t in tables}

    stats = {"passed": 0, "info": 0, "warning": 0, "failed": 0, "skipped": 0}
    error_n = 0
    total = 0
    for rule in rules:
        result = results.get(str(rule.id)) if isinstance(results, dict) else None
        if not isinstance(result, dict):
            continue
        total += 1
        status = _rule_status(rule, result)
        stats[status] += 1
        if result.get("error"):
            error_n += 1

    overview_rows = [
        ["Status", (run.status or "").capitalize()],
        ["Score", _fmt_score(run.score)],
        ["Started at", _fmt_dt(run.started_at)],
        ["Completed at", _fmt_dt(run.completed_at)],
        ["Rules evaluated", f"{total}"],
        ["Passed", f"{stats['passed']}"],
        ["Info findings", f"{stats['info']}"],
        ["Warning findings", f"{stats['warning']}"],
        ["Failed findings", f"{stats['failed']}"],
        ["Skipped", f"{stats['skipped']}"],
    ]
    if error_n:
        overview_rows.append(["Execution errors", f"{error_n}"])
    if run.error_message:
        overview_rows.append(["Run error", _truncate(run.error_message, 240)])

    overview = Table(overview_rows, colWidths=[45 * mm, 110 * mm])
    overview.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#e5e7eb")),
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f9fafb")),
                ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9.5),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(overview)

    # ── Dimension breakdown ──────────────────────────────────────────
    story.append(Paragraph("Dimension breakdown", section_style))
    dim_stats: Dict[str, Dict[str, int]] = {}
    for rule in rules:
        res = results.get(str(rule.id)) if isinstance(results, dict) else None
        if not isinstance(res, dict):
            continue
        d = dim_stats.setdefault(
            rule.dimension,
            {"total": 0, "passed": 0, "info": 0, "warning": 0, "failed": 0, "skipped": 0},
        )
        d["total"] += 1
        d[_rule_status(rule, res)] += 1

    dim_rows = [["Dimension", "Total", "Passed", "Info", "Warning", "Failed", "Skipped"]]
    for dim in _DIMENSIONS_ORDER:
        if dim not in dim_stats:
            continue
        s = dim_stats[dim]
        dim_rows.append([
            dim.capitalize(),
            str(s["total"]),
            str(s["passed"]),
            str(s["info"]),
            str(s["warning"]),
            str(s["failed"]),
            str(s["skipped"]),
        ])
    if len(dim_rows) == 1:
        dim_rows.append(["—", "0", "0", "0", "0", "0", "0"])

    dim_table = Table(
        dim_rows,
        colWidths=[44 * mm, 18 * mm, 18 * mm, 18 * mm, 18 * mm, 18 * mm, 18 * mm],
    )
    dim_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#111827")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#e5e7eb")),
                ("FONTSIZE", (0, 0), (-1, -1), 9.5),
                ("ALIGN", (1, 0), (-1, -1), "CENTER"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(dim_table)

    # ── Non-pass findings ────────────────────────────────────────────
    story.append(Paragraph("Non-pass findings", section_style))
    failed_rows = [[
        _paragraph("Rule", failed_header_style),
        _paragraph("Table / Column", failed_header_style),
        _paragraph("Dimension", failed_header_style),
        _paragraph("Status", failed_header_style),
        _paragraph("Severity", failed_header_style),
        _paragraph("Rows failed / checked", failed_header_style),
        _paragraph("Detail", failed_header_style),
    ]]
    for rule_id_str, res in sorted(results.items(), key=lambda kv: kv[0]):
        if not isinstance(res, dict):
            continue
        if res.get("passed") or res.get("skipped"):
            continue
        try:
            rid = int(rule_id_str)
        except (ValueError, TypeError):
            continue
        rule = rule_by_id.get(rid)
        if rule is None:
            continue
        status = _rule_status(rule, res)
        if status in {"passed", "skipped"}:
            continue
        table = table_by_id.get(rule.table_id)
        table_label = (table.display_name or table.source_table_name) if table else f"#{rule.table_id}"
        scope = f"{table_label}" + (f" · {rule.column_name}" if rule.column_name else "")
        rows_failed = res.get("rows_failed")
        rows_checked = res.get("rows_checked")
        counts = (
            f"{rows_failed if rows_failed is not None else '—'} / "
            f"{rows_checked if rows_checked is not None else '—'}"
        )
        detail = _truncate(res.get("detail") or ("EXECUTION ERROR" if res.get("error") else ""), 180)
        failed_rows.append(
            [
                _paragraph(_truncate(rule.name, 90), table_cell_style),
                _paragraph(_truncate(scope, 90), table_cell_style),
                _paragraph(rule.dimension.capitalize(), table_cell_center_style),
                _paragraph(status.capitalize(), table_cell_center_style),
                _paragraph(rule.severity.capitalize(), table_cell_center_style),
                _paragraph(counts, table_cell_center_style),
                _paragraph(detail, table_cell_style),
            ]
        )

    if len(failed_rows) == 1:
        story.append(
            Paragraph(
                "No info, warning, or failed findings to report for this run.",
                body_style,
            )
        )
    else:
        failed_table = Table(
            failed_rows,
            colWidths=[28 * mm, 30 * mm, 18 * mm, 16 * mm, 16 * mm, 24 * mm, 38 * mm],
            repeatRows=1,
        )
        failed_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#111827")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#e5e7eb")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f9fafb")]),
                    ("LEFTPADDING", (0, 0), (-1, -1), 4),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ]
            )
        )
        story.append(failed_table)

    story.append(Spacer(1, 8))
    story.append(
        Paragraph(
            "Generated automatically by AppBI Dataset Quality scheduler.",
            ParagraphStyle(
                name="Footer",
                parent=styles["Normal"],
                fontSize=8,
                textColor=colors.HexColor("#9ca3af"),
                alignment=1,
            ),
        )
    )

    doc.build(story)
    return buffer.getvalue()
