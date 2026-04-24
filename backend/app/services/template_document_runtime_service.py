"""Runtime preview helpers for clean-slate template documents."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Tuple


def build_template_document_runtime_preview(
    definition: Dict[str, Any],
    source_previews: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Build runtime preview payloads for document-engine blocks."""
    data_sources = definition.get("dataSources") if isinstance(definition, dict) else None
    default_source_id = None
    if isinstance(data_sources, list):
      for item in data_sources:
          if isinstance(item, dict):
              candidate = str(item.get("id") or "").strip()
              if candidate:
                  default_source_id = candidate
                  break

    block_previews: Dict[str, Dict[str, Any]] = {}
    warnings: List[str] = []

    root = definition.get("root") if isinstance(definition, dict) else None
    if isinstance(root, dict):
        for block in _walk_blocks(root):
            preview, block_warnings = _build_block_preview(block, source_previews, default_source_id)
            if preview is not None:
                block_previews[str(block.get("id") or "")] = preview
            warnings.extend(block_warnings)

    normalized_sources = {
        source_id: {
            "sourceId": source_id,
            "datasetId": payload.get("datasetId"),
            "tableId": payload.get("tableId"),
            "columns": list(payload.get("columns") or []),
            "rows": list(payload.get("rows") or []),
            "total": int(payload.get("total") or 0),
        }
        for source_id, payload in source_previews.items()
    }

    return {
        "sources": normalized_sources,
        "blocks": block_previews,
        "warnings": warnings,
    }


def _walk_blocks(block: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    yield block
    for child in block.get("children") or []:
        if isinstance(child, dict):
            yield from _walk_blocks(child)


def _build_block_preview(
    block: Dict[str, Any],
    source_previews: Dict[str, Dict[str, Any]],
    default_source_id: str | None,
) -> Tuple[Dict[str, Any] | None, List[str]]:
    block_id = str(block.get("id") or "").strip()
    block_type = str(block.get("type") or "").strip().lower()
    if not block_id or not block_type:
        return None, []

    source_id = str(block.get("dataSourceId") or default_source_id or "").strip() or None
    source_payload = source_previews.get(source_id) if source_id else None
    rows = list(source_payload.get("rows") or []) if source_payload else []
    columns = list(source_payload.get("columns") or []) if source_payload else []
    total = int(source_payload.get("total") or len(rows)) if source_payload else 0
    warnings: List[str] = []

    if block_type not in {"table", "metric", "input", "repeater"}:
        return None, []

    if source_id and source_payload is None:
        warnings.append(f"Block '{block_id}' references source '{source_id}' but no runtime preview was available.")

    if block_type == "table":
        selected_columns = _resolve_table_columns(block, columns)
        preview_rows = [
            {column_name: row.get(column_name) for column_name in selected_columns}
            for row in rows[:5]
            if isinstance(row, dict)
        ]
        return {
            "blockId": block_id,
            "blockType": block_type,
            "kind": "table",
            "sourceId": source_id,
            "columns": selected_columns,
            "rows": preview_rows,
            "total": total,
            "warnings": warnings,
        }, warnings

    source_field = str(block.get("sourceField") or "").strip()

    if block_type == "metric":
        value = rows[0].get(source_field) if source_field and rows and isinstance(rows[0], dict) else len(rows)
        return {
            "blockId": block_id,
            "blockType": block_type,
            "kind": "metric",
            "sourceId": source_id,
            "field": source_field or None,
            "value": value,
            "total": total,
            "warnings": warnings,
        }, warnings

    if block_type == "input":
        value = rows[0].get(source_field) if source_field and rows and isinstance(rows[0], dict) else None
        return {
            "blockId": block_id,
            "blockType": block_type,
            "kind": "input",
            "sourceId": source_id,
            "field": source_field or None,
            "value": value,
            "total": total,
            "warnings": warnings,
        }, warnings

    items = [
        row.get(source_field)
        for row in rows[:5]
        if source_field and isinstance(row, dict) and row.get(source_field) not in (None, "")
    ]
    return {
        "blockId": block_id,
        "blockType": block_type,
        "kind": "repeater",
        "sourceId": source_id,
        "field": source_field or None,
        "items": items,
        "total": total,
        "warnings": warnings,
    }, warnings


def _resolve_table_columns(block: Dict[str, Any], columns: List[Dict[str, Any]]) -> List[str]:
    configured = [
        str(item).strip()
        for item in (block.get("columnKeys") or [])
        if str(item).strip()
    ]
    if configured:
        return configured[:6]
    resolved_columns = [str(column.get("name") or "").strip() for column in columns if str(column.get("name") or "").strip()]
    return resolved_columns[:6]