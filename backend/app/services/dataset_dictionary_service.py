"""Helpers for dataset-level dictionary storage and AI-facing context."""
from __future__ import annotations

from typing import Any, Iterable

from app.models.dataset import Dataset, DatasetTable


def _clean_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _clean_block_text(value: Any) -> str:
    lines = []
    for raw_line in str(value or "").splitlines():
        cleaned = " ".join(raw_line.strip().split())
        if cleaned:
            lines.append(cleaned)
    return "\n".join(lines).strip()


VALID_GLOSSARY_CATEGORIES = {"metric", "dimension", "entity", "rule", "other"}
VALID_QUALITY_SEVERITIES = {"info", "warning", "error"}
VALID_QUALITY_FORMAT_HINTS = {"email", "phone", "url", "date", "datetime", "currency", "percent", "custom"}


def _clean_scalar(value: Any) -> str | int | float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    text = str(value).strip()
    return text or None


def _normalize_column_quality(raw_quality: Any) -> dict[str, Any] | None:
    if not isinstance(raw_quality, dict):
        return None

    quality: dict[str, Any] = {}

    for key in ("required", "unique"):
        value = raw_quality.get(key)
        if isinstance(value, bool):
            quality[key] = value

    accepted_values = []
    seen_values: set[str] = set()
    for raw_value in raw_quality.get("accepted_values") or []:
        text = _clean_text(raw_value)
        fingerprint = text.casefold()
        if not text or fingerprint in seen_values:
            continue
        seen_values.add(fingerprint)
        accepted_values.append(text)
    if accepted_values:
        quality["accepted_values"] = accepted_values

    for key in ("min_value", "max_value"):
        value = _clean_scalar(raw_quality.get(key))
        if value is not None:
            quality[key] = value

    pattern = _clean_text(raw_quality.get("pattern"))
    if pattern:
        quality["pattern"] = pattern

    format_hint = _clean_text(raw_quality.get("format_hint"))
    if format_hint in VALID_QUALITY_FORMAT_HINTS:
        quality["format_hint"] = format_hint

    for key in ("null_threshold_percent", "distinct_threshold"):
        value = raw_quality.get(key)
        if value in (None, ""):
            continue
        try:
            quality[key] = float(value)
        except (TypeError, ValueError):
            continue

    severity = _clean_text(raw_quality.get("severity"))
    if severity in VALID_QUALITY_SEVERITIES:
        quality["severity"] = severity

    notes = _clean_block_text(raw_quality.get("notes"))
    if notes:
        quality["notes"] = notes

    return quality or None


def normalize_dictionary_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    raw = payload or {}
    dictionary: dict[str, Any] = {}

    for key in ("overview", "business_purpose", "usage_guidelines", "ai_context"):
        text = _clean_block_text(raw.get(key))
        if text:
            dictionary[key] = text

    for key in ("default_filters", "warnings"):
        values = []
        seen: set[str] = set()
        for item in raw.get(key) or []:
            text = _clean_text(item)
            fingerprint = text.casefold()
            if not text or fingerprint in seen:
                continue
            seen.add(fingerprint)
            values.append(text)
        if values:
            dictionary[key] = values

    glossary = []
    for item in raw.get("glossary") or []:
        if not isinstance(item, dict):
            continue
        term = _clean_text(item.get("term"))
        definition = _clean_text(item.get("definition"))
        if not term or not definition:
            continue
        category = _clean_text(item.get("category")) or "other"
        if category not in VALID_GLOSSARY_CATEGORIES:
            category = "other"
        glossary_item: dict[str, Any] = {
            "term": term,
            "definition": definition,
            "category": category,
        }
        for list_key in ("synonyms", "related_columns", "examples"):
            values = []
            seen: set[str] = set()
            for raw_value in item.get(list_key) or []:
                text = _clean_text(raw_value)
                fingerprint = text.casefold()
                if not text or fingerprint in seen:
                    continue
                seen.add(fingerprint)
                values.append(text)
            if values:
                glossary_item[list_key] = values
        related_tables = []
        seen_table_ids: set[int] = set()
        for raw_id in item.get("related_tables") or []:
            try:
                table_id = int(raw_id)
            except (TypeError, ValueError):
                continue
            if table_id in seen_table_ids:
                continue
            seen_table_ids.add(table_id)
            related_tables.append(table_id)
        if related_tables:
            glossary_item["related_tables"] = related_tables
        glossary.append(glossary_item)
    if glossary:
        dictionary["glossary"] = glossary

    table_notes = []
    for item in raw.get("table_notes") or []:
        if not isinstance(item, dict):
            continue
        try:
            table_id = int(item.get("table_id"))
        except (TypeError, ValueError):
            continue
        note: dict[str, Any] = {"table_id": table_id}
        for key in ("business_role", "grain"):
            text = _clean_text(item.get(key))
            if text:
                note[key] = text
        for key in ("freshness_expectation",):
            text = _clean_text(item.get(key))
            if text:
                note[key] = text
        for key in ("join_hint", "owner_note", "row_count_expectation"):
            text = _clean_block_text(item.get(key))
            if text:
                note[key] = text
        important_columns = []
        seen_cols: set[str] = set()
        for raw_col in item.get("important_columns") or []:
            text = _clean_text(raw_col)
            fingerprint = text.casefold()
            if not text or fingerprint in seen_cols:
                continue
            seen_cols.add(fingerprint)
            important_columns.append(text)
        if important_columns:
            note["important_columns"] = important_columns
        column_notes = []
        seen_column_note_names: set[str] = set()
        for raw_column_note in item.get("column_notes") or []:
            if not isinstance(raw_column_note, dict):
                continue
            column_name = _clean_text(raw_column_note.get("column_name"))
            description = _clean_block_text(raw_column_note.get("description"))
            business_name = _clean_text(raw_column_note.get("business_name"))
            examples = []
            seen_examples: set[str] = set()
            for raw_example in raw_column_note.get("examples") or []:
                example = _clean_text(raw_example)
                fingerprint = example.casefold()
                if not example or fingerprint in seen_examples:
                    continue
                seen_examples.add(fingerprint)
                examples.append(example)
            quality = _normalize_column_quality(raw_column_note.get("quality"))
            fingerprint = column_name.casefold()
            if not column_name or fingerprint in seen_column_note_names:
                continue
            seen_column_note_names.add(fingerprint)
            entry = {"column_name": column_name}
            if description:
                entry["description"] = description
            if business_name:
                entry["business_name"] = business_name
            if examples:
                entry["examples"] = examples
            if quality:
                entry["quality"] = quality
            if len(entry) > 1:
                column_notes.append(entry)
        if column_notes:
            note["column_notes"] = column_notes
        if len(note) > 1:
            table_notes.append(note)
    if table_notes:
        dictionary["table_notes"] = table_notes

    return dictionary


def build_dictionary_stats(
    dictionary: dict[str, Any] | None,
    tables: Iterable[DatasetTable] | None,
) -> dict[str, int]:
    table_ids = {int(table.id) for table in (tables or [])}
    covered_table_ids = {
        int(note.get("table_id"))
        for note in (dictionary or {}).get("table_notes") or []
        if isinstance(note, dict) and int(note.get("table_id") or 0) in table_ids
    }
    return {
        "glossary_terms": len((dictionary or {}).get("glossary") or []),
        "warnings": len((dictionary or {}).get("warnings") or []),
        "default_filters": len((dictionary or {}).get("default_filters") or []),
        "table_notes": len((dictionary or {}).get("table_notes") or []),
        "covered_tables": len(covered_table_ids),
        "total_tables": len(table_ids),
    }


def build_dictionary_context(
    dataset: Dataset,
    tables: Iterable[DatasetTable] | None = None,
) -> str:
    dictionary = normalize_dictionary_payload(getattr(dataset, "dictionary", None))
    table_lookup = {
        int(table.id): (table.display_name or table.source_table_name or f"Table {table.id}")
        for table in (tables or [])
    }
    lines = [
        f"Dataset: {dataset.name}",
    ]
    if getattr(dataset, "description", None):
        lines.append(f"Dataset description: {str(dataset.description).strip()}")

    field_labels = {
        "overview": "Overview",
        "business_purpose": "Business purpose",
        "usage_guidelines": "Usage guidelines",
        "ai_context": "AI instructions",
    }
    for key, label in field_labels.items():
        value = dictionary.get(key)
        if value:
            lines.append(f"{label}: {value}")

    default_filters = dictionary.get("default_filters") or []
    if default_filters:
        lines.append("Default filters / assumptions:")
        lines.extend(f"- {item}" for item in default_filters)

    warnings = dictionary.get("warnings") or []
    if warnings:
        lines.append("Warnings / caveats:")
        lines.extend(f"- {item}" for item in warnings)

    glossary = dictionary.get("glossary") or []
    if glossary:
        lines.append("Business glossary:")
        for item in glossary:
            if not isinstance(item, dict):
                continue
            fragments = []
            term = _clean_text(item.get("term"))
            definition = _clean_text(item.get("definition"))
            if term:
                fragments.append(term)
            if definition:
                fragments.append(definition)
            synonyms = item.get("synonyms") or []
            if synonyms:
                fragments.append(f"synonyms: {', '.join(str(value) for value in synonyms)}")
            related_tables = [
                table_lookup.get(int(table_id), f"Table {table_id}")
                for table_id in (item.get("related_tables") or [])
                if int(table_id) in table_lookup
            ]
            if related_tables:
                fragments.append(f"tables: {', '.join(related_tables)}")
            related_columns = item.get("related_columns") or []
            if related_columns:
                fragments.append(f"columns: {', '.join(str(value) for value in related_columns)}")
            examples = item.get("examples") or []
            if examples:
                fragments.append(f"examples: {', '.join(str(value) for value in examples)}")
            if fragments:
                lines.append(f"- {' | '.join(fragments)}")

    table_notes = dictionary.get("table_notes") or []
    if table_notes:
        lines.append("Table notes:")
        for note in table_notes:
            if not isinstance(note, dict):
                continue
            try:
                table_id = int(note.get("table_id"))
            except (TypeError, ValueError):
                continue
            header = table_lookup.get(table_id, f"Table {table_id}")
            detail_parts = []
            for key, label in (
                ("business_role", "role"),
                ("grain", "grain"),
                ("freshness_expectation", "freshness"),
                ("join_hint", "join"),
                ("owner_note", "note"),
                ("row_count_expectation", "row count"),
            ):
                value = _clean_text(note.get(key))
                if value:
                    detail_parts.append(f"{label}: {value}")
            important_columns = note.get("important_columns") or []
            if important_columns:
                detail_parts.append(f"important columns: {', '.join(str(value) for value in important_columns)}")
            if detail_parts:
                lines.append(f"- {header} | {' | '.join(detail_parts)}")
            column_notes = note.get("column_notes") or []
            for column_note in column_notes:
                if not isinstance(column_note, dict):
                    continue
                column_name = _clean_text(column_note.get("column_name"))
                description = _clean_block_text(column_note.get("description"))
                business_name = _clean_text(column_note.get("business_name"))
                quality = column_note.get("quality") if isinstance(column_note.get("quality"), dict) else None
                fragments = []
                if description:
                    fragments.append(description)
                if business_name:
                    fragments.append(f"business name: {business_name}")
                examples = column_note.get("examples") or []
                if examples:
                    fragments.append(f"examples: {', '.join(str(value) for value in examples)}")
                if quality:
                    quality_parts = []
                    if quality.get("required") is True:
                        quality_parts.append("required")
                    if quality.get("unique") is True:
                        quality_parts.append("unique")
                    accepted_values = quality.get("accepted_values") or []
                    if accepted_values:
                        quality_parts.append(f"accepted values: {', '.join(str(value) for value in accepted_values)}")
                    for key, label in (
                        ("min_value", "min"),
                        ("max_value", "max"),
                        ("pattern", "pattern"),
                        ("format_hint", "format"),
                        ("null_threshold_percent", "null threshold %"),
                        ("distinct_threshold", "distinct threshold"),
                        ("severity", "severity"),
                        ("notes", "quality notes"),
                    ):
                        value = quality.get(key)
                        cleaned = _clean_text(value) if key != "notes" else _clean_block_text(value)
                        if cleaned:
                            quality_parts.append(f"{label}: {cleaned}")
                    if quality_parts:
                        fragments.append(f"quality: {'; '.join(quality_parts)}")
                if column_name and fragments:
                    lines.append(f"  - column {column_name}: {' | '.join(fragments)}")

    return "\n".join(lines).strip()
