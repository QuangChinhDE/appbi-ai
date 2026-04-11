"""
Phase 2 Light — Minimal Context Builder.

Per-turn: vector-search for the top-N dataset tables and charts most
relevant to the current user message, then inject ONLY those into the
system prompt instead of the full database schema dump.

Falls back to keyword match when no embeddings are available.
"""
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

# How many items to include from each category
_TOP_TABLES = 5
_TOP_CHARTS = 5
# Minimum similarity score to include (avoids irrelevant items)
_MIN_SIMILARITY = 0.3


def _fuzzy_score(query: str, text: str) -> int:
    q_words = set(str(query or "").lower().split())
    t_words = set(str(text or "").lower().split())
    return len(q_words & t_words)


def _extract_columns(table_payload: Dict[str, Any]) -> List[Any]:
    if table_payload.get("column_stats"):
        return list(table_payload["column_stats"].keys())

    columns_cache = table_payload.get("columns_cache")
    if isinstance(columns_cache, dict):
        columns_cache = columns_cache.get("columns", [])
    if columns_cache:
        return [
            {"name": c.get("name", c), "type": c.get("type", "unknown")} if isinstance(c, dict) else c
            for c in columns_cache
        ]
    return []


@dataclass
class ContextPackage:
    """Compact context bundle built for a single user turn."""

    tables: List[Dict[str, Any]] = field(default_factory=list)
    charts: List[Dict[str, Any]] = field(default_factory=list)
    # For tables that lack embeddings, a fallback list of all table names
    fallback_used: bool = False

    def is_empty(self) -> bool:
        return not self.tables and not self.charts

    def to_prompt_section(self) -> str:
        """Render as a compact DATA SCHEMA section for the system prompt."""
        if self.is_empty():
            return ""

        lines = ["## DATA SCHEMA (relevant to this query)\n"]

        if self.fallback_used:
            lines.append("_(vector search unavailable — showing tables from the current dataset scope)_\n")

        if self.tables:
            lines.append("### Dataset Tables")
            for t in self.tables:
                lines.append(
                    f"- **{t['display_name']}** "
                    f"(dataset_id={t['dataset_id']}, table_id={t['id']})"
                )
                if t.get("auto_description"):
                    lines.append(f"  Description: {t['auto_description']}")
                if t.get("columns"):
                    cols_preview = t["columns"][:20]
                    col_strs = []
                    for c in cols_preview:
                        if isinstance(c, dict):
                            col_strs.append(f"{c.get('name', c)}:{c.get('type', '?')}")
                        else:
                            col_strs.append(str(c))
                    lines.append(f"  Columns: {', '.join(col_strs)}")
            lines.append("")

        if self.charts:
            lines.append("### Pre-built Charts")
            for c in self.charts:
                lines.append(
                    f"- **{c['name']}** (chart_id={c['id']}, type={c['chart_type']})"
                )
            lines.append("")

        return "\n".join(lines)


async def build_context(
    user_message: str,
    token: str,
    dataset_id: int | None = None,
    max_tables: int = _TOP_TABLES,
    max_charts: int = _TOP_CHARTS,
) -> ContextPackage:
    """
    Build a ContextPackage relevant to `user_message` by running
    vector similarity search over tables and charts.

    Falls back to listing accessible tables when embeddings are not yet
    available. If dataset_id is provided, the context is strictly limited
    to that dataset.
    """
    from app.clients.bi_client import bi_client

    pkg = ContextPackage()
    scoped_tables: List[Dict[str, Any]] = []
    scoped_table_ids: set[int] = set()

    if dataset_id:
        try:
            dataset = await bi_client.get_dataset(int(dataset_id), token=token)
            for tbl in dataset.get("tables", []):
                tbl_id = tbl.get("id")
                if tbl_id is None:
                    continue
                scoped_table_ids.add(int(tbl_id))
                scoped_tables.append({
                    "id": int(tbl_id),
                    "dataset_id": int(dataset_id),
                    "display_name": tbl.get("display_name", tbl.get("name", "")),
                    "auto_description": tbl.get("auto_description"),
                    "columns": _extract_columns(tbl),
                })
        except Exception as exc:
            logger.warning("context_builder: scoped dataset load error — %s", exc)

    try:
        table_hits = await bi_client.search_similar_tables(
            user_message,
            limit=max_tables,
            token=token,
        )
        if table_hits:
            if dataset_id:
                table_hits = [
                    hit for hit in table_hits
                    if int(hit.get("dataset_id", -1)) == int(dataset_id)
                ]
            pkg.tables = [
                t for t in table_hits
                if t.get("similarity", 1.0) >= _MIN_SIMILARITY
            ]
    except Exception as exc:
        logger.warning("context_builder: table search error — %s", exc)

    try:
        if dataset_id and scoped_table_ids:
            charts = await bi_client.list_charts(limit=200, token=token)
            scoped_charts = [
                chart for chart in charts
                if chart.get("dataset_table_id") in scoped_table_ids
            ]
            scored = []
            for chart in scoped_charts:
                search_text = " ".join(
                    filter(None, [chart.get("name", ""), chart.get("description", "")])
                )
                score = _fuzzy_score(user_message, search_text)
                if score > 0:
                    scored.append((score, chart))
            scored.sort(key=lambda item: item[0], reverse=True)
            pkg.charts = [
                {
                    "id": chart["id"],
                    "name": chart.get("name", ""),
                    "chart_type": chart.get("chart_type", ""),
                }
                for _, chart in scored[:max_charts]
            ]
        else:
            chart_hits = await bi_client.search_similar_charts(
                user_message,
                limit=max_charts,
                token=token,
            )
            if chart_hits:
                pkg.charts = [
                    c for c in chart_hits
                    if c.get("similarity", 1.0) >= _MIN_SIMILARITY
                ]
    except Exception as exc:
        logger.warning("context_builder: chart search error — %s", exc)

    if not pkg.tables:
        if dataset_id and scoped_tables:
            pkg.tables = scoped_tables[:max_tables]
            pkg.fallback_used = True
        else:
            try:
                datasets = await bi_client.list_datasets(token=token)
                for dataset in datasets:
                    try:
                        ws_detail = await bi_client.get_dataset(dataset["id"], token=token)
                        for tbl in ws_detail.get("tables", []):
                            pkg.tables.append({
                                "id": tbl["id"],
                                "dataset_id": dataset["id"],
                                "display_name": tbl.get("display_name", tbl.get("name", "")),
                                "auto_description": tbl.get("auto_description"),
                                "columns": _extract_columns(tbl),
                            })
                    except Exception:
                        pass
                if pkg.tables:
                    pkg.fallback_used = True
            except Exception as exc:
                logger.warning("context_builder: fallback table load error — %s", exc)

    return pkg
