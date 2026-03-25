from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Any, Iterable, List

from app.schemas.agent import ProfilingArtifactItem
from app.services.output_language import is_vietnamese


def _top_values(rows: list[dict[str, Any]], column_name: str, limit: int = 5) -> list[str]:
    counter: Counter[str] = Counter()
    for row in rows:
        value = row.get(column_name)
        if value in (None, ""):
            continue
        counter[str(value).strip()] += 1
    return [item for item, _count in counter.most_common(limit)]


def _null_ratio(rows: list[dict[str, Any]], column_name: str) -> float:
    if not rows:
        return 0.0
    null_count = sum(1 for row in rows if row.get(column_name) in (None, ""))
    return null_count / max(len(rows), 1)


def _freshness_summary(rows: list[dict[str, Any]], candidate_time_fields: Iterable[str], language: str | None) -> str | None:
    parsed_values: list[tuple[str, datetime]] = []
    for field in candidate_time_fields:
        for row in rows:
            value = row.get(field)
            if not value:
                continue
            text = str(value).strip()
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y"):
                try:
                    parsed_values.append((field, datetime.strptime(text, fmt)))
                    break
                except ValueError:
                    continue
    if not parsed_values:
        return None

    parsed_values.sort(key=lambda item: item[1])
    first_field, first_value = parsed_values[0]
    last_field, last_value = parsed_values[-1]
    vi = is_vietnamese(language)
    if first_field == last_field:
        return (
            f"{first_field} trải từ {first_value.date()} đến {last_value.date()} trong mẫu dữ liệu."
            if vi
            else f"{first_field} ranges from {first_value.date()} to {last_value.date()} in the sample."
        )
    return (
        (
            f"Phát hiện độ phủ thời gian từ {first_value.date()} ({first_field}) "
            f"đến {last_value.date()} ({last_field}) trong dữ liệu mẫu."
        )
        if vi
        else (
            f"Detected time coverage from {first_value.date()} ({first_field}) "
            f"to {last_value.date()} ({last_field}) in the sampled rows."
        )
    )


def build_profiling_report(profiles: list[Any], language: str | None = None) -> list[ProfilingArtifactItem]:
    vi = is_vietnamese(language)
    report: list[ProfilingArtifactItem] = []
    for profile in profiles:
        rows = list(profile.context.sample_rows or [])
        categorical_candidates = list(profile.dimension_candidates or profile.categorical_columns or [])
        top_dimensions = {
            column_name: _top_values(rows, column_name)
            for column_name in categorical_candidates[:3]
            if _top_values(rows, column_name)
        }
        null_risk_columns = [
            column["name"]
            for column in profile.typed_columns
            if _null_ratio(rows, column["name"]) >= 0.35
        ][:6]
        risk_flags = list(profile.question_matches or [])
        if null_risk_columns:
            risk_flags.append(
                "Nhiều trường có tỷ lệ null cao trong dữ liệu mẫu."
                if vi
                else "Several fields have high null rates in the sampled rows."
            )
        if not profile.date_columns:
            risk_flags.append(
                "Không phát hiện trường thời gian rõ ràng để phân tích xu hướng."
                if vi
                else "No clear time field detected for trend analysis."
            )
        if not profile.metric_candidates and not profile.numeric_columns:
            risk_flags.append(
                "Không phát hiện metric số rõ ràng; có thể phải ưu tiên phân tích đếm bản ghi."
                if vi
                else "No clear numeric metric detected; count-based analysis may be required."
            )

        report.append(
            ProfilingArtifactItem(
                workspace_id=profile.context.workspace_id,
                workspace_name=profile.context.workspace_name,
                table_id=profile.context.table_id,
                table_name=profile.context.table_name,
                row_sample_count=len(rows),
                column_count=len(profile.typed_columns),
                table_grain=profile.table_kind,
                candidate_metrics=list(profile.metric_candidates[:6]),
                candidate_dimensions=list(categorical_candidates[:6]),
                candidate_time_fields=list(profile.date_columns[:4]),
                top_dimensions=top_dimensions,
                null_risk_columns=null_risk_columns,
                freshness_summary=_freshness_summary(rows, profile.date_columns, language),
                semantic_summary=profile.business_summary,
                risk_flags=risk_flags[:8],
            )
        )
    return report
