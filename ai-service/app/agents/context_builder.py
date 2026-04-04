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
            lines.append("_(vector search unavailable — showing all accessible tables)_\n")

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
                    # Show column name with type if available
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
    max_tables: int = _TOP_TABLES,
    max_charts: int = _TOP_CHARTS,
) -> ContextPackage:
    """
    Build a ContextPackage relevant to `user_message` by running
    vector similarity search over tables and charts.

    Falls back to listing all accessible tables/charts when embeddings
    are not yet available (e.g. first boot with no embeddings computed).
    """
    from app.clients.bi_client import bi_client

    pkg = ContextPackage()

    # ── Vector search for tables ──────────────────────────────────────────────
    try:
        table_hits = await bi_client.search_similar_tables(
            user_message, limit=max_tables, token=token
        )
        if table_hits:
            pkg.tables = [
                t for t in table_hits
                if t.get("similarity", 1.0) >= _MIN_SIMILARITY
            ]
    except Exception as exc:
        logger.warning("context_builder: table search error — %s", exc)

    # ── Vector search for charts ──────────────────────────────────────────────
    try:
        chart_hits = await bi_client.search_similar_charts(
            user_message, limit=max_charts, token=token
        )
        if chart_hits:
            pkg.charts = [
                c for c in chart_hits
                if c.get("similarity", 1.0) >= _MIN_SIMILARITY
            ]
    except Exception as exc:
        logger.warning("context_builder: chart search error — %s", exc)

    # ── Fallback: load all tables if embeddings returned nothing ──────────────
    if not pkg.tables:
        try:
            datasets = await bi_client.list_datasets(token=token)
            for ws in datasets:
                try:
                    ws_detail = await bi_client.get_dataset(ws["id"], token=token)
                    for tbl in ws_detail.get("tables", []):
                        cols = []
                        if tbl.get("column_stats"):
                            cols = list(tbl["column_stats"].keys())
                        elif tbl.get("columns_cache"):
                            cc = tbl["columns_cache"]
                            # Handle both array [{name, type}, ...] and object {"columns": [...]}
                            if isinstance(cc, dict):
                                cc = cc.get("columns", [])
                            cols = [
                                {"name": c.get("name", c), "type": c.get("type", "unknown")} if isinstance(c, dict) else c
                                for c in cc
                            ]
                        pkg.tables.append({
                            "id": tbl["id"],
                            "dataset_id": ws["id"],
                            "display_name": tbl.get("display_name", tbl.get("name", "")),
                            "auto_description": tbl.get("auto_description"),
                            "columns": cols,
                        })
                except Exception:
                    pass
            if pkg.tables:
                pkg.fallback_used = True
        except Exception as exc:
            logger.warning("context_builder: fallback table load error — %s", exc)

    return pkg
