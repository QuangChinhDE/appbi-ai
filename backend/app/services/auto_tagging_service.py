"""
AutoTaggingService - LLM-powered semantic metadata generation.

- tag_chart:      generates domain, intent, metrics, dimensions, tags,
                  auto_description, insight_keywords, common_questions
- describe_table: generates auto_description, column_descriptions,
                  common_questions

Both run safely in synchronous background tasks. The orchestration layer owns
queueing, stale handling, and generation status updates. This service focuses on
prompting the LLM and persisting AI-generated fields.
"""
import json
import logging
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy.orm import Session

from app.services.llm_client import LLMClient

logger = logging.getLogger(__name__)

TABLE_PROMPT_CHAR_BUDGET = 12_000
CHART_PROMPT_CHAR_BUDGET = 9_000
TABLE_SAMPLE_ROW_LIMIT = 12
CHART_SAMPLE_ROW_LIMIT = 8
TABLE_SAMPLE_CHAR_BUDGET = 3_600
CHART_SAMPLE_CHAR_BUDGET = 2_400
MAX_CELL_CHARS = 120
MAX_ROW_CHARS = 700
MAX_SQL_CHARS = 500


_TABLE_DESCRIBE_SYSTEM = (
    "Ban la AI tro ly data catalog cho he thong BI. "
    "Dua tren metadata bang du lieu, hay tao mo ta phuc vu nguoi dung nghiep vu. "
    "LUON tra loi bang Tieng Viet. "
    "Chi tra ve mot JSON object hop le - khong markdown, khong text thua. "
    "Cac key JSON bat buoc: "
    "description (string: 2-3 cau mo ta nghiep vu ro rang, de cap khoang thoi gian du lieu neu co), "
    "column_descriptions (object: BAT BUOC mo ta TAT CA cac cot, moi cot 1 cau Tieng Viet ro rang), "
    "common_questions (array 3-5 cau hoi Tieng Viet ngan gon ma nguoi dung nghiep vu hay dat ra ve bang nay)."
)

_CHART_TAG_SYSTEM = (
    "Ban la AI chuyen gia metadata BI. "
    "Dua tren thong tin bieu do, hay trich xuat metadata ngu nghia. "
    "LUON tra loi bang Tieng Viet (ngoai tru cac gia tri ky thuat nhu ten cot). "
    "Chi tra ve mot JSON object hop le - khong markdown, khong text thua. "
    "Cac key JSON: "
    "domain (string: sales/marketing/finance/operations/hr/logistics/other), "
    "intent (string: trend/comparison/ranking/summary/distribution/other), "
    "metrics (array ten cac chi so nghiep vu), "
    "dimensions (array cac chieu phan tich/nhom), "
    "tags (array toi da 8 tu khoa tieng Viet), "
    "auto_description (string: 2-3 cau mo ta bieu do nay the hien gi va diem quan trong - Tieng Viet), "
    "insight_keywords (array 5-10 cum tu nguoi dung co the tim kiem - bao gom ca Tieng Viet va ten cot), "
    "common_questions (array 2-3 cau hoi Tieng Viet ma nguoi dung hay dat ra sau khi xem bieu do nay)."
)


def _extract_col_names(columns_cache) -> list:
    """Handle both list [{name,type},...] and dict {columns:[...]} formats."""
    if not columns_cache:
        return []
    if isinstance(columns_cache, dict):
        columns_cache = columns_cache.get("columns", [])
    return [c.get("name", c) if isinstance(c, dict) else c for c in columns_cache]


def _normalize_columns(columns_cache, column_stats: Optional[dict] = None) -> List[Dict[str, str]]:
    """Merge columns_cache and column_stats into a stable ordered list."""
    column_stats = column_stats or {}
    seen: Set[str] = set()
    columns: List[Dict[str, str]] = []

    raw_columns: Iterable[Any]
    if isinstance(columns_cache, dict):
        raw_columns = columns_cache.get("columns", [])
    else:
        raw_columns = columns_cache or []

    for raw in raw_columns:
        if isinstance(raw, dict):
            name = str(raw.get("name") or "").strip()
            dtype = str(raw.get("type") or column_stats.get(name, {}).get("dtype") or "unknown")
        else:
            name = str(raw or "").strip()
            dtype = str(column_stats.get(name, {}).get("dtype") or "unknown")
        if not name or name in seen:
            continue
        seen.add(name)
        columns.append({"name": name, "type": dtype})

    for name, stats in column_stats.items():
        normalized_name = str(name or "").strip()
        if not normalized_name or normalized_name in seen:
            continue
        seen.add(normalized_name)
        columns.append({"name": normalized_name, "type": str(stats.get("dtype") or "unknown")})

    return columns


def _format_column_catalog(columns: Sequence[Dict[str, str]], max_line_chars: int = 160) -> str:
    """Render the full column catalog compactly so we can keep all names."""
    if not columns:
        return "  (no columns available)"

    entries = [f"{column['name']} ({column.get('type') or 'unknown'})" for column in columns]
    lines: List[str] = []
    current = "  - "
    for entry in entries:
        candidate = entry if current == "  - " else f", {entry}"
        if len(current) + len(candidate) > max_line_chars and current != "  - ":
            lines.append(current)
            current = f"  - {entry}"
        else:
            current += candidate if current != "  - " else entry
    if current.strip():
        lines.append(current)
    return "\n".join(lines)


def _trim_text(value: Any, max_chars: int = MAX_CELL_CHARS) -> str:
    text = " ".join(str(value).replace("\r", " ").replace("\n", " ").split())
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


def _normalize_sample_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, (list, dict)):
        return _trim_text(json.dumps(value, ensure_ascii=False), MAX_CELL_CHARS)
    return _trim_text(value, MAX_CELL_CHARS)


def _ordered_column_names(
    columns: Sequence[Dict[str, str]],
    column_stats: Optional[dict] = None,
    preferred_columns: Optional[Sequence[str]] = None,
) -> List[str]:
    """Prioritize preferred columns first, then the most informative remaining columns."""
    preferred_columns = [col for col in (preferred_columns or []) if col]
    column_stats = column_stats or {}

    names_in_order = [column["name"] for column in columns]
    preferred = [name for name in preferred_columns if name in names_in_order]
    remaining = [name for name in names_in_order if name not in preferred]
    position_map = {name: index for index, name in enumerate(names_in_order)}

    def score(name: str) -> Tuple[int, int, int, int]:
        stats = column_stats.get(name, {})
        dtype = str(stats.get("dtype") or "").lower()
        null_pct = float(stats.get("null_pct") or 0)
        sample_count = len(stats.get("samples") or [])
        is_numeric = bool(stats.get("is_numeric")) or dtype in {
            "integer", "int", "bigint", "smallint", "float", "double",
            "decimal", "numeric", "number", "real",
        }
        is_temporal = "date" in dtype or "time" in dtype
        if is_numeric:
            kind_rank = 2
        elif is_temporal:
            kind_rank = 1
        else:
            kind_rank = 0
        return (kind_rank, int(null_pct * 100), -sample_count, position_map.get(name, 0))

    remaining.sort(key=score)
    return preferred + remaining


def _format_column_stats(
    column_stats: dict,
    ordered_names: Optional[Sequence[str]] = None,
    max_chars: int = 4_000,
) -> str:
    """Format column_stats into readable lines within a global char budget."""
    if not column_stats:
        return "  (no column stats available)"
    lines: List[str] = []
    names = list(ordered_names or column_stats.keys())
    names.extend([name for name in column_stats.keys() if name not in names])
    used_chars = 0
    rendered = 0
    for col in names:
        stats = column_stats.get(col)
        if not stats:
            continue
        dtype = stats.get("dtype", "unknown")
        cardinality = stats.get("cardinality", "?")
        samples = stats.get("samples", [])[:3]
        null_pct = stats.get("null_pct", 0)
        line = f"  - {col} ({dtype}, {cardinality} distinct values"
        if null_pct > 0:
            line += f", {null_pct * 100:.0f}% null"
        if samples:
            line += f", samples: {samples}"
        line += ")"
        if used_chars + len(line) + 1 > max_chars and lines:
            remaining = len([name for name in names[rendered:] if name in column_stats])
            lines.append(
                f"  ... trimmed detailed stats for {remaining} more columns to stay within token budget"
            )
            break
        lines.append(line)
        used_chars += len(line) + 1
        rendered += 1
    return "\n".join(lines)


def _normalize_sample_rows(sample_cache: Any) -> List[Dict[str, Any]]:
    if not isinstance(sample_cache, list):
        return []
    return [row for row in sample_cache if isinstance(row, dict)]


def _build_row_payload(
    row: Dict[str, Any],
    ordered_columns: Sequence[str],
    max_columns: int,
    max_chars: int = MAX_ROW_CHARS,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    for column_name in ordered_columns:
        if column_name not in row:
            continue
        raw_value = row.get(column_name)
        if raw_value in (None, ""):
            continue
        payload[column_name] = _normalize_sample_value(raw_value)
        if len(payload) >= max_columns:
            break
        if len(json.dumps(payload, ensure_ascii=False)) > max_chars:
            payload.pop(column_name, None)
            break
    return payload


def _select_representative_rows(
    sample_cache: Any,
    columns: Sequence[Dict[str, str]],
    column_stats: Optional[dict] = None,
    preferred_columns: Optional[Sequence[str]] = None,
    max_rows: int = TABLE_SAMPLE_ROW_LIMIT,
    max_chars: int = TABLE_SAMPLE_CHAR_BUDGET,
    max_columns_per_row: int = 12,
) -> List[Dict[str, Any]]:
    """Greedily pick diverse rows while respecting a prompt budget."""
    rows = _normalize_sample_rows(sample_cache)
    if not rows:
        return []

    ordered_columns = _ordered_column_names(columns, column_stats, preferred_columns)
    if not ordered_columns:
        ordered_columns = sorted({key for row in rows for key in row.keys()})

    selected: List[Dict[str, Any]] = []
    seen_signatures: Set[str] = set()
    seen_values: Dict[str, Set[str]] = {name: set() for name in ordered_columns}
    used_chars = 0

    def add_payload(payload: Dict[str, Any]) -> bool:
        nonlocal used_chars
        if not payload:
            return False
        signature = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        if signature in seen_signatures:
            return False
        if selected and used_chars + len(signature) + 1 > max_chars:
            return False
        seen_signatures.add(signature)
        used_chars += len(signature) + 1
        selected.append(payload)
        for key, value in payload.items():
            seen_values.setdefault(key, set()).add(json.dumps(value, sort_keys=True, ensure_ascii=False))
        return True

    add_payload(_build_row_payload(rows[0], ordered_columns, max_columns_per_row))

    remaining = rows[1:]
    while remaining and len(selected) < max_rows:
        best_index = None
        best_score = None
        best_payload = None

        for index, row in enumerate(remaining):
            payload = _build_row_payload(row, ordered_columns, max_columns_per_row)
            if not payload:
                continue
            novelty = 0
            for key, value in payload.items():
                marker = json.dumps(value, sort_keys=True, ensure_ascii=False)
                if marker not in seen_values.setdefault(key, set()):
                    novelty += 1
            completeness = len(payload)
            score = (novelty, completeness, -index)
            if best_score is None or score > best_score:
                best_index = index
                best_score = score
                best_payload = payload

        if best_index is None or best_payload is None:
            break
        if not add_payload(best_payload):
            break
        remaining.pop(best_index)

    return selected


def _format_sample_rows(rows: Sequence[Dict[str, Any]]) -> str:
    if not rows:
        return "  (no sample rows available)"
    return "\n".join(
        f"  {index}. {json.dumps(row, ensure_ascii=False)}"
        for index, row in enumerate(rows, start=1)
    )


def _extract_chart_columns(config: Optional[dict]) -> List[str]:
    """Extract likely column references from chart config shapes."""
    if not isinstance(config, dict):
        return []

    columns: List[str] = []
    seen: Set[str] = set()

    def add_candidate(candidate: Any) -> None:
        if not isinstance(candidate, str):
            return
        normalized = candidate.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            columns.append(normalized)

    def visit(value: Any) -> None:
        if isinstance(value, str):
            add_candidate(value)
            return
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if isinstance(value, dict):
            for key in ("column", "field", "dimension", "metric", "x", "y"):
                if key in value:
                    add_candidate(value.get(key))
            for key in ("dimensions", "metrics", "filters", "series", "groupBy", "xAxis", "yAxis"):
                if key in value:
                    visit(value[key])

    for key in ("dimensions", "metrics", "filters", "series", "groupBy", "xAxis", "yAxis"):
        if key in config:
            visit(config[key])
    return columns


def _remaining_budget(parts: Sequence[str], total_budget: int) -> int:
    return total_budget - sum(len(part) for part in parts) - max(len(parts) - 1, 0)


def _build_table_prompt(table) -> str:
    columns = _normalize_columns(table.columns_cache, table.column_stats)
    ordered_column_names = [column["name"] for column in columns]
    parts = [f"Table name: {table.display_name}"]

    if table.source_kind == "sql_query" and table.source_query:
        parts.append(f"Source: SQL query\nSQL excerpt: {_trim_text(table.source_query, MAX_SQL_CHARS)}")
    else:
        parts.append("Source: physical table import")

    if columns:
        parts.append(f"\nAll columns ({len(columns)} total):")
        parts.append(_format_column_catalog(columns))

    if table.column_stats:
        remaining = _remaining_budget(parts, TABLE_PROMPT_CHAR_BUDGET)
        if remaining > 600:
            parts.append("\nColumn stats summary:")
            parts.append(
                _format_column_stats(
                    table.column_stats,
                    ordered_names=ordered_column_names,
                    max_chars=min(remaining - 200, 4_200),
                )
            )

    if table.sample_cache:
        remaining = _remaining_budget(parts, TABLE_PROMPT_CHAR_BUDGET)
        if remaining > 600:
            rows = _select_representative_rows(
                table.sample_cache,
                columns,
                column_stats=table.column_stats,
                max_rows=TABLE_SAMPLE_ROW_LIMIT,
                max_chars=min(TABLE_SAMPLE_CHAR_BUDGET, remaining - 200),
                max_columns_per_row=14,
            )
            if rows:
                parts.append(
                    "\nRepresentative sample rows (real values, trimmed only to fit token budget):"
                )
                parts.append(_format_sample_rows(rows))

    parts.append(
        "\nUse both the full column catalog and the representative sample rows to infer the real business meaning of the dataset. "
        "Generate: description, column_descriptions (for every column listed), "
        "and common_questions. Respond ONLY in JSON."
    )
    return "\n".join(parts)


def _build_chart_prompt(chart, table=None) -> str:
    parts = [
        f"Chart name: {chart.name}",
        f"Chart type: {chart.chart_type}",
    ]
    config = chart.config or {}
    if config.get("dimensions"):
        parts.append(f"X-axis / dimension columns: {config['dimensions']}")
    if config.get("metrics"):
        parts.append(f"Y-axis / metric columns: {config['metrics']}")
    if config.get("filters"):
        parts.append(f"Filters: {config['filters']}")

    if table:
        columns = _normalize_columns(table.columns_cache, table.column_stats)
        referenced_columns = _extract_chart_columns(config)
        parts.append(f"\nSource table: {table.display_name}")
        if table.auto_description:
            parts.append(f"Table description: {table.auto_description}")
        if columns:
            parts.append(f"All source columns ({len(columns)} total):")
            parts.append(_format_column_catalog(columns))
        if referenced_columns:
            parts.append(f"Chart-referenced columns: {', '.join(referenced_columns)}")
        if table.column_stats:
            remaining = _remaining_budget(parts, CHART_PROMPT_CHAR_BUDGET)
            if remaining > 500:
                stats_focus = referenced_columns or [column["name"] for column in columns]
                parts.append("\nRelevant column stats:")
                parts.append(
                    _format_column_stats(
                        table.column_stats,
                        ordered_names=stats_focus,
                        max_chars=min(remaining - 200, 2_600),
                    )
                )
        if table.sample_cache:
            remaining = _remaining_budget(parts, CHART_PROMPT_CHAR_BUDGET)
            if remaining > 500:
                rows = _select_representative_rows(
                    table.sample_cache,
                    columns,
                    column_stats=table.column_stats,
                    preferred_columns=referenced_columns,
                    max_rows=CHART_SAMPLE_ROW_LIMIT,
                    max_chars=min(CHART_SAMPLE_CHAR_BUDGET, remaining - 200),
                    max_columns_per_row=max(6, min(len(referenced_columns) or 8, 10)),
                )
                if rows:
                    parts.append(
                        "\nRepresentative source rows focused on the chart context (trimmed for token budget):"
                    )
                    parts.append(_format_sample_rows(rows))

    parts.append(
        "\nUse the chart config together with the source table metadata and representative sample rows. "
        "Generate all required JSON keys including auto_description, "
        "insight_keywords, and common_questions."
    )
    return "\n".join(parts)


class AutoTaggingService:

    @staticmethod
    def describe_table_detailed(db: Session, table_id: int) -> Tuple[bool, Optional[str]]:
        """Generate and store AI description fields for a workspace table."""
        try:
            from app.models.dataset_workspace import DatasetWorkspaceTable

            table = db.query(DatasetWorkspaceTable).filter(
                DatasetWorkspaceTable.id == table_id
            ).first()
            if not table:
                return False, "Table not found"

            result = LLMClient.complete_json(
                _build_table_prompt(table),
                system=_TABLE_DESCRIBE_SYSTEM,
                max_tokens=800,
            )
            if not result:
                return False, "AI provider returned no table description payload"

            if result.get("description"):
                table.auto_description = result["description"]
            if result.get("column_descriptions"):
                table.column_descriptions = result["column_descriptions"]
            if result.get("common_questions"):
                table.common_questions = result["common_questions"]

            table.description_source = "auto"
            table.description_updated_at = datetime.utcnow()
            db.commit()

            logger.info(
                "AutoTaggingService: described table %s (cols=%d, questions=%d)",
                table_id,
                len(result.get("column_descriptions") or {}),
                len(result.get("common_questions") or []),
            )
            return True, None

        except Exception as exc:
            logger.warning("AutoTaggingService: describe_table %s failed - %s", table_id, exc)
            db.rollback()
            return False, str(exc)

    @staticmethod
    def describe_table(db: Session, table_id: int, force: bool = False) -> bool:
        """Compatibility wrapper; orchestration should prefer describe_table_detailed()."""
        ok, _ = AutoTaggingService.describe_table_detailed(db, table_id)
        return ok

    @staticmethod
    def tag_chart_detailed(db: Session, chart_id: int) -> Tuple[bool, Optional[str]]:
        """Generate and upsert semantic metadata plus AI description fields for a chart."""
        try:
            from app.models.dataset_workspace import DatasetWorkspaceTable
            from app.models.models import Chart, ChartMetadata

            chart = db.query(Chart).filter(Chart.id == chart_id).first()
            if not chart:
                return False, "Chart not found"

            table = None
            if chart.workspace_table_id:
                table = db.query(DatasetWorkspaceTable).filter(
                    DatasetWorkspaceTable.id == chart.workspace_table_id
                ).first()

            result = LLMClient.complete_json(
                _build_chart_prompt(chart, table),
                system=_CHART_TAG_SYSTEM,
                max_tokens=800,
            )
            if not result:
                return False, "AI provider returned no chart description payload"

            meta = db.query(ChartMetadata).filter(
                ChartMetadata.chart_id == chart_id
            ).first()
            if not meta:
                meta = ChartMetadata(chart_id=chart_id)
                db.add(meta)

            meta.domain = result.get("domain") or meta.domain
            meta.intent = result.get("intent") or meta.intent
            meta.metrics = result.get("metrics") or meta.metrics
            meta.dimensions = result.get("dimensions") or meta.dimensions
            meta.tags = result.get("tags") or meta.tags
            if result.get("auto_description"):
                meta.auto_description = result["auto_description"]
            if result.get("insight_keywords"):
                meta.insight_keywords = result["insight_keywords"]
            if result.get("common_questions"):
                meta.common_questions = result["common_questions"]
            meta.description_source = "auto"
            meta.description_updated_at = datetime.utcnow()

            db.commit()
            logger.info(
                "AutoTaggingService: tagged chart %s -> domain=%s intent=%s",
                chart_id,
                result.get("domain"),
                result.get("intent"),
            )
            return True, None

        except Exception as exc:
            logger.warning("AutoTaggingService: tag_chart %s failed - %s", chart_id, exc)
            db.rollback()
            return False, str(exc)

    @staticmethod
    def tag_chart(db: Session, chart_id: int, force: bool = False) -> bool:
        """Compatibility wrapper; orchestration should prefer tag_chart_detailed()."""
        ok, _ = AutoTaggingService.tag_chart_detailed(db, chart_id)
        return ok
