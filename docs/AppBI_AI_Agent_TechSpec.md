# AppBI — AI Agent Enhancement: Technical Specification

> **Tài liệu kỹ thuật chi tiết cho Development Team**
> Version 1.0 — March 2026 | CONFIDENTIAL

---

## Table of Contents

- [1. Overview & Objectives](#1-overview--objectives)
- [2. Phase 1: Foundation — Metadata Enrichment & Vector Search](#2-phase-1-foundation--metadata-enrichment--vector-search)
- [3. Phase 2: Smart Routing — Context Compression](#3-phase-2-smart-routing--context-compression)
- [4. Phase 3: Enhanced Tools](#4-phase-3-enhanced-tools)
- [5. Phase 4: Proactive Intelligence](#5-phase-4-proactive-intelligence)
- [6. Testing Strategy](#6-testing-strategy)
- [7. Deployment & Migration](#7-deployment--migration)
- [8. File Map — Files cần tạo / sửa](#8-file-map--files-cần-tạo--sửa)
- [Appendix A: Cost Estimation](#appendix-a-cost-estimation)
- [Appendix B: Glossary](#appendix-b-glossary)

---

## 1. Overview & Objectives

### 1.1 Tổng quan vấn đề

AI Agent hiện tại của AppBI có 4 tools (`search_charts`, `run_chart`, `execute_sql`, `query_table`) hoạt động tốt với quy mô nhỏ. Tuy nhiên, khi số lượng datasets, workspaces, và charts tăng lên (50+ datasources, 200+ charts, 30+ workspaces), agent sẽ gặp các vấn đề nghiêm trọng:

- **Search accuracy giảm:** `search_charts` dựa vào text matching trả về kết quả sai khi nhiều charts có tên tương tự ("Revenue Q1", "Revenue by Region", "Revenue YoY").
- **Context window overflow:** Nếu dump toàn bộ metadata vào prompt, LLM sẽ bị ngập (~50K+ tokens) và chất lượng output giảm.
- **Không awareness về permissions:** Agent có thể trả về chart mà user không có quyền xem.
- **Không hiểu data relationships:** Agent không biết tables nào liên quan đến nhau, không thể suggest JOINs.
- **Chỉ tìm được, không tạo được:** Agent chỉ search charts có sẵn, không thể tạo chart mới từ câu hỏi.

### 1.2 Mục tiêu

1. **Accuracy:** AI Agent trả lời đúng > 90% câu hỏi, kể cả khi có 200+ charts.
2. **Performance:** Response time < 5s cho hầu hết các query (không tính SQL execution).
3. **Capability:** Agent có thể tự tạo chart, giải thích insight, và phát hiện anomaly.
4. **Security:** Agent chỉ access data mà user có permission.
5. **Differentiator:** Biến AI Agent thành điểm khác biệt lớn nhất của AppBI so với mọi BI tool khác.

### 1.3 Kiến trúc tổng thể

Upgrade AI Agent theo 3 layers và 4 phases:

| Layer | Mục đích | Components chính |
|-------|----------|-----------------|
| 1. Knowledge Graph | Agent biết data nào có gì | Metadata Index, Semantic Catalog, Vector Embeddings, Relationship Map |
| 2. Smart Routing | Thu hẹp context trước khi gọi LLM | Query Classifier, Context Builder, Permission Filter |
| 3. Enhanced Tools | Mở rộng khả năng của agent | `create_chart`, `explore_data`, `explain_insight`, `suggest_next` |

| Phase | Nội dung | Timeline | Effort |
|-------|----------|----------|--------|
| Phase 1 | Foundation — Metadata Enrichment & Vector Search | 2–3 tuần | ~12 ngày |
| Phase 2 | Smart Routing — Context Compression Pipeline | 2–3 tuần | ~12 ngày |
| Phase 3 | Enhanced Tools — Create, Explore, Explain | 3–4 tuần | ~17 ngày |
| Phase 4 | Proactive Intelligence — Anomaly, Auto-Dashboard | 4–6 tuần | ~23 ngày |

---

## Implementation Status (Updated 2026-03-21)

### Phase 1 — Foundation: Metadata Enrichment & Vector Search

| Feature | Status | Notes |
|---------|--------|-------|
| 2.1 DB columns (`column_stats`, `auto_description`, `stats_updated_at`) | ✅ DONE | Migration applied |
| 2.1 `TableStatsService.compute_stats()` | ❌ PENDING | Service file does not exist; `columns_cache` field (datasource metadata) is used as column name fallback |
| 2.1 Auto-compute on sync/upload/create | ❌ PENDING | Not hooked in |
| 2.2 `resource_embeddings` table + pgvector | ✅ DONE | Migration applied |
| 2.2 `EmbeddingService` | ✅ DONE | **Model changed**: `gemini-embedding-001` (768-dim) via httpx instead of `text-embedding-3-small`; requires `GEMINI_API_KEY` |
| 2.2 Vector search endpoints (`GET /charts/search`, `GET /dataset-workspaces/tables/search`) | ✅ DONE | Permission-aware JOIN for charts |
| 2.2 Auto-embed on chart/table CRUD | ❌ PENDING | Deferred — will add hooks after Phase 4 review |
| 2.3 LLM Auto-Tagging (`AutoTaggingService`) | ❌ PENDING | Not implemented |
| 2.4 Permission-Aware Search | ✅ DONE | Vector search has permission JOIN; list endpoints use `filter_by_visibility()` |

### Phase 2 — Smart Routing: Context Compression

| Feature | Status | Notes |
|---------|--------|-------|
| 3.1 Query Classifier (`classify_query`) | ❌ PENDING | Raw user message used for vector search instead |
| 3.2 Context Builder — per-turn vector search | ✅ DONE | `context_builder.py` implemented; top-3 charts + top-3 tables injected into system prompt per turn |
| 3.2 Context Builder — query classifier integration | ❌ PENDING | Classifier not implemented; direct search used |
| 3.2 Context compression < 3K tokens | ✅ DONE | Compact `ContextPackage` format |
| 3.2 `_trim_history` boundary safety | ✅ DONE | Advances to first `role: "user"` after cut point to avoid orphaned tool messages |
| 3.3 Conversation Memory (`chat_sessions`, `chat_messages`) | ✅ DONE | Tables existed; WebSocket session management already present |
| 3.3 Sliding window (last N messages) | ✅ DONE | `_trim_history` keeps last 20 messages |
| 3.3 Old-message summarization | ❌ PENDING | Not implemented |
| 3.4 Usage-Based Ranking (`resource_views` table) | ❌ PENDING | Not implemented |

### Phase 3 — Enhanced Tools

| Feature | Status |
|---------|--------|
| `create_chart` tool | ❌ PENDING → implementing now |
| `explore_data` tool | ❌ PENDING → implementing now |
| `explain_insight` tool | ❌ PENDING → implementing now |
| `suggest_next` post-response suggestions | ❌ PENDING → implementing now |

### Phase 4 — Proactive Intelligence

| Feature | Status |
|---------|--------|
| Anomaly Detection (`monitored_metrics` + `anomaly_alerts`) | ❌ PENDING → implementing now |
| `create_dashboard` tool | ❌ PENDING → implementing now |
| Data Storytelling (weekly narrative) | ❌ PENDING → implementing now |

---

## 2. Phase 1: Foundation — Metadata Enrichment & Vector Search

Phase này xây nền móng cho toàn bộ hệ thống AI Agent. Không cần thay đổi tools hiện tại, chỉ bổ sung metadata và cải thiện chất lượng search.

### 2.1 Auto Column Statistics

> **Effort:** ~3 ngày | **Priority:** P0

#### 2.1.1 Mục tiêu

Tự động thu thập statistics cho mỗi column của mỗi table trong workspace. Agent sẽ dùng thông tin này để biết column nào chứa data gì mà không cần query full table.

#### 2.1.2 Database Changes

Thêm field mới vào model `DatasetWorkspaceTable`:

```python
# backend/app/models/dataset_workspace.py

class DatasetWorkspaceTable(Base):
    # ... existing fields ...

    # NEW: Column-level statistics
    column_stats = Column(JSONB, nullable=True, default=None)
    # Format:
    # {
    #   "column_name": {
    #     "dtype": "VARCHAR" | "INTEGER" | "FLOAT" | "DATE" | ...,
    #     "cardinality": 150,        # distinct value count
    #     "null_count": 5,
    #     "null_pct": 0.02,
    #     "min": "2024-01-01",        # string representation
    #     "max": "2024-12-31",
    #     "samples": ["US", "EU", "APAC", "LATAM", "MEA"],
    #     "is_numeric": false,
    #     "mean": null,               # only for numeric
    #     "std": null                  # only for numeric
    #   }
    # }

    # NEW: Auto-generated description
    auto_description = Column(Text, nullable=True, default=None)

    # NEW: Last stats update timestamp
    stats_updated_at = Column(DateTime, nullable=True, default=None)
```

#### 2.1.3 Alembic Migration

```python
# alembic/versions/YYYYMMDD_HHMM_add_column_stats.py

def upgrade():
    op.add_column("dataset_workspace_tables",
        sa.Column("column_stats", JSONB, nullable=True))
    op.add_column("dataset_workspace_tables",
        sa.Column("auto_description", sa.Text, nullable=True))
    op.add_column("dataset_workspace_tables",
        sa.Column("stats_updated_at", sa.DateTime, nullable=True))
```

#### 2.1.4 Service Implementation

Tạo file mới:

```python
# backend/app/services/table_stats_service.py

import duckdb
from datetime import datetime
from app.core.database import get_duckdb_connection


class TableStatsService:
    """Compute column-level statistics using DuckDB."""

    @staticmethod
    async def compute_stats(table_id: str, parquet_path: str) -> dict:
        """
        Compute stats for all columns of a workspace table.
        Uses DuckDB to read directly from parquet file.
        Returns dict mapping column_name -> stats.
        """
        conn = get_duckdb_connection()

        # Get column info
        columns = conn.execute(
            f"DESCRIBE SELECT * FROM '{parquet_path}'"
        ).fetchall()

        stats = {}
        for col_name, col_type, *_ in columns:
            is_numeric = col_type in (
                "INTEGER", "BIGINT", "FLOAT", "DOUBLE",
                "DECIMAL", "HUGEINT", "SMALLINT", "TINYINT"
            )

            # Basic stats
            row = conn.execute(f"""
                SELECT
                    approx_count_distinct("{col_name}") as cardinality,
                    count(*) - count("{col_name}") as null_count,
                    round(
                        (count(*) - count("{col_name}"))::float
                        / greatest(count(*), 1), 4
                    ) as null_pct,
                    min("{col_name}")::varchar as min_val,
                    max("{col_name}")::varchar as max_val
                FROM '{parquet_path}'
            """).fetchone()

            # Sample values
            samples_rows = conn.execute(f"""
                SELECT DISTINCT "{col_name}"::varchar
                FROM '{parquet_path}'
                WHERE "{col_name}" IS NOT NULL
                LIMIT 5
            """).fetchall()
            samples = [r[0] for r in samples_rows]

            col_stats = {
                "dtype": col_type,
                "cardinality": row[0],
                "null_count": row[1],
                "null_pct": float(row[2]) if row[2] else 0,
                "min": row[3],
                "max": row[4],
                "samples": samples,
                "is_numeric": is_numeric,
                "mean": None,
                "std": None,
            }

            # Numeric-only stats
            if is_numeric:
                num_row = conn.execute(f"""
                    SELECT
                        round(avg("{col_name}"), 4),
                        round(stddev("{col_name}"), 4)
                    FROM '{parquet_path}'
                """).fetchone()
                col_stats["mean"] = float(num_row[0]) if num_row[0] else None
                col_stats["std"] = float(num_row[1]) if num_row[1] else None

            stats[col_name] = col_stats

        return stats

    @staticmethod
    async def update_table_stats(db, table_id: str, parquet_path: str):
        """Compute and persist stats for a table."""
        stats = await TableStatsService.compute_stats(table_id, parquet_path)

        # Update in database
        table = db.query(DatasetWorkspaceTable).get(table_id)
        table.column_stats = stats
        table.stats_updated_at = datetime.utcnow()
        db.commit()

        return stats
```

#### 2.1.5 Integration Points

Gọi compute stats tại 3 điểm:

- **Sau khi sync datasource:** Trong sync scheduler (`app/main.py` lifespan), sau khi sync xong mỗi table, gọi `update_table_stats()`.
- **Sau khi upload CSV/Excel:** Trong `datasources.py` endpoint POST `/datasources` (manual type), sau khi import xong.
- **Sau khi tạo/update workspace table:** Trong `dataset_workspaces.py` endpoint POST `/tables` và PUT `/tables/{id}`.

---

### 2.2 Vector Embeddings cho Semantic Search

> **Effort:** ~4 ngày | **Priority:** P0

#### 2.2.1 Mục tiêu

Thay thế text-based search bằng vector similarity search. Khi user hỏi "monthly revenue trend", agent sẽ tìm được chart tên "Sales Performance Over Time" vì vector embeddings hiểu được ngữ nghĩa, không chỉ từ khóa.

#### 2.2.2 Tech Stack

| Component | Lựa chọn | Lý do |
|-----------|----------|-------|
| Vector DB | pgvector (PostgreSQL extension) | Đã dùng PostgreSQL, không cần thêm infra mới |
| Embedding Model | `text-embedding-3-small` (OpenAI) | Chi phí thấp ($0.02/1M tokens), 1536 dimensions, chất lượng tốt |
| Fallback Model | Anthropic / local model | Khi không có OpenAI key, dùng TF-IDF fallback |

#### 2.2.3 Database Setup

```sql
-- Migration: Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- New table for embeddings
CREATE TABLE resource_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_type VARCHAR(50) NOT NULL,
    -- "chart", "workspace_table", "dashboard"
    resource_id UUID NOT NULL,
    embedding vector(1536),
    -- text used to generate embedding
    source_text TEXT NOT NULL,
    model_version VARCHAR(100) DEFAULT 'text-embedding-3-small',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    UNIQUE(resource_type, resource_id)
);

-- Index for fast similarity search
CREATE INDEX idx_embeddings_cosine
    ON resource_embeddings
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Index for filtering by type
CREATE INDEX idx_embeddings_type
    ON resource_embeddings(resource_type);
```

#### 2.2.4 Embedding Service

```python
# backend/app/services/embedding_service.py

import httpx
from typing import Optional
from app.core.config import settings


class EmbeddingService:
    """Generate and manage vector embeddings."""

    @staticmethod
    async def generate_embedding(text: str) -> list[float]:
        """Call OpenAI embedding API."""
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={
                    "Authorization": f"Bearer {settings.OPENAI_API_KEY}"
                },
                json={
                    "model": "text-embedding-3-small",
                    "input": text[:8000]  # truncate
                }
            )
            data = resp.json()
            return data["data"][0]["embedding"]

    @staticmethod
    def build_chart_text(chart, table) -> str:
        """
        Build searchable text from chart + table info.
        This is what gets embedded.
        """
        parts = [
            f"Chart: {chart.name}",
            f"Type: {chart.chart_type}",
        ]

        # Add chart metadata if exists
        if chart.metadata:
            if chart.metadata.domain:
                parts.append(f"Domain: {chart.metadata.domain}")
            if chart.metadata.intent:
                parts.append(f"Intent: {chart.metadata.intent}")
            if chart.metadata.metrics:
                parts.append(f"Metrics: {chart.metadata.metrics}")
            if chart.metadata.dimensions:
                parts.append(f"Dimensions: {chart.metadata.dimensions}")
            if chart.metadata.tags:
                parts.append(f"Tags: {chart.metadata.tags}")

        # Add table column info
        if table:
            parts.append(f"Table: {table.display_name}")
            if table.column_stats:
                col_names = list(table.column_stats.keys())
                parts.append(f"Columns: {', '.join(col_names)}")

        # Add chart config dimensions/metrics
        config = chart.config or {}
        if config.get("dimensions"):
            parts.append(f"X-axis: {config['dimensions']}")
        if config.get("metrics"):
            parts.append(f"Y-axis: {config['metrics']}")

        return "\n".join(parts)

    @staticmethod
    async def embed_chart(db, chart, table):
        """Create/update embedding for a chart."""
        text = EmbeddingService.build_chart_text(chart, table)
        embedding = await EmbeddingService.generate_embedding(text)

        # Upsert into resource_embeddings
        db.execute(text("""
            INSERT INTO resource_embeddings
                (resource_type, resource_id, embedding, source_text, updated_at)
            VALUES
                (:type, :id, :emb, :text, NOW())
            ON CONFLICT (resource_type, resource_id)
            DO UPDATE SET
                embedding = :emb,
                source_text = :text,
                updated_at = NOW()
        """), {
            "type": "chart",
            "id": str(chart.id),
            "emb": str(embedding),
            "text": text
        })
        db.commit()

    @staticmethod
    async def search_similar(
        db, query: str,
        resource_type: str = "chart",
        limit: int = 5,
        user_id: str = None
    ) -> list[dict]:
        """
        Vector similarity search with permission filtering.
        """
        query_embedding = await EmbeddingService.generate_embedding(query)

        # Search with permission join
        results = db.execute(text("""
            SELECT
                re.resource_id,
                re.source_text,
                1 - (re.embedding <=> :qemb) AS similarity
            FROM resource_embeddings re
            JOIN charts c ON c.id = re.resource_id
            LEFT JOIN resource_shares rs
                ON rs.resource_type = 'chart'
                AND rs.resource_id = c.id
                AND rs.user_id = :uid
            WHERE re.resource_type = :rtype
            AND (
                c.owner_id = :uid
                OR rs.id IS NOT NULL
            )
            ORDER BY re.embedding <=> :qemb
            LIMIT :lim
        """), {
            "qemb": str(query_embedding),
            "rtype": resource_type,
            "uid": user_id,
            "lim": limit
        }).fetchall()

        return [
            {
                "resource_id": str(r[0]),
                "source_text": r[1],
                "similarity": float(r[2])
            }
            for r in results
        ]
```

#### 2.2.5 Integration Points

- **Tạo chart mới:** Sau khi save chart (`charts.py` POST), gọi `embed_chart()` async.
- **Update chart:** Sau khi update chart (`charts.py` PUT), gọi `embed_chart()` async.
- **Xóa chart:** Xóa row tương ứng trong `resource_embeddings`.
- **Batch re-index:** Script để re-embed toàn bộ charts hiện có (chạy 1 lần khi deploy).

---

### 2.3 LLM Auto-Tagging

> **Effort:** ~3 ngày | **Priority:** P1

#### 2.3.1 Mục tiêu

Tự động generate business description, metrics, dimensions, và tags cho mỗi chart và workspace table. Hiện `chart_metadata` table đã có các fields này nhưng phải điền thủ công. LLM sẽ tự động điền.

#### 2.3.2 Implementation

```python
# backend/app/services/auto_tagging_service.py

from app.services.llm_client import call_llm


class AutoTaggingService:

    SYSTEM_PROMPT = """
    You are a data catalog assistant.
    Given table/chart info, generate metadata.
    Respond ONLY in JSON format:
    {
      "description": "2-sentence business purpose",
      "domain": "sales|marketing|finance|ops|hr|...",
      "metrics": ["revenue", "count", ...],
      "dimensions": ["region", "date", ...],
      "tags": ["monthly", "trend", ...],
      "suggested_questions": [
        "What is the total revenue by region?",
        "How has revenue changed over time?"
      ]
    }
    """

    @staticmethod
    async def tag_table(table) -> dict:
        """Auto-tag a workspace table."""
        prompt = f"""
        Table name: {table.display_name}
        Source: {table.datasource.name}
        Columns: {list(table.column_stats.keys()) if table.column_stats else "unknown"}
        Column details:
        {_format_col_stats(table.column_stats)}
        SQL query: {table.sql_query or "physical table"}
        """

        response = await call_llm(
            system=AutoTaggingService.SYSTEM_PROMPT,
            user=prompt,
            model="claude-3-5-haiku-20241022",
            max_tokens=500
        )
        return _parse_json(response)

    @staticmethod
    async def tag_chart(chart, table) -> dict:
        """Auto-tag a chart based on its config."""
        config = chart.config or {}
        prompt = f"""
        Chart name: {chart.name}
        Chart type: {chart.chart_type}
        Table: {table.display_name if table else "N/A"}
        Dimensions (X-axis): {config.get("dimensions")}
        Metrics (Y-axis): {config.get("metrics")}
        Filters: {config.get("filters")}
        Columns available: {list(table.column_stats.keys()) if table and table.column_stats else "unknown"}
        """

        response = await call_llm(
            system=AutoTaggingService.SYSTEM_PROMPT,
            user=prompt,
            model="claude-3-5-haiku-20241022",
            max_tokens=500
        )
        return _parse_json(response)
```

#### 2.3.3 Persist Tags

Update existing `chart_metadata` table. Nếu row chưa có, tạo mới. Nếu đã có và user đã edit thủ công, không ghi đè (keep user overrides).

- **Chạy async:** Background task, không block API response.
- **Rate limiting:** Max 10 LLM calls/minute cho tagging. Dùng queue (`asyncio.Queue` hoặc Celery nếu có).
- **Cost control:** Dùng Haiku/GPT-4o-mini, trung bình ~$0.001/chart. 200 charts = ~$0.20.

---

### 2.4 Permission-Aware Search

> **Effort:** ~2 ngày | **Priority:** P0

#### 2.4.1 Mục tiêu

Mọi kết quả search của AI Agent đều phải filtered theo user permissions. Agent không bao giờ được "thấy" data mà user không có quyền.

#### 2.4.2 Changes Required

- **`ai-service/app/clients/bi_client.py`:** Mọi API call từ AI service đến backend đều phải include user's JWT token (hiện đã làm qua WebSocket auth).
- **`search_charts` tool:** Sử dụng vector search với permission JOIN (như query trong section 2.2.4). Backend đã có `filter_by_visibility()` — đảm bảo gọi đúng.
- **`execute_sql` tool:** Kiểm tra user có quyền với `datasource_id` được query không. Gọi `GET /datasources/{id}` với user token trước khi execute.
- **`query_table` tool:** Kiểm tra user có quyền với `workspace_id` không. Gọi `GET /dataset-workspaces/{id}` với user token trước.

---

## 3. Phase 2: Smart Routing — Context Compression

Phase này giải quyết vấn đề cốt lõi: làm sao đưa đúng thông tin vào context window của LLM mà không bị ngập.

### 3.1 Query Classifier

> **Effort:** ~4 ngày | **Priority:** P0

#### 3.1.1 Mục tiêu

Phân loại intent của user query trước khi gọi main LLM agent. Dùng lightweight model (để nhanh và rẻ) để extract:

- **Intent:** `metric_lookup` | `comparison` | `trend` | `breakdown` | `anomaly` | `explore` | `create_chart` | `general_question`
- **Entities:** Tên metrics, dimensions, time ranges, chart names, datasource names.
- **Confidence:** Để quyết định có cần clarification hay không.

#### 3.1.2 Implementation

```python
# ai-service/app/agents/query_classifier.py

from dataclasses import dataclass
from enum import Enum
from app.clients.llm_client import call_llm


class QueryIntent(str, Enum):
    METRIC_LOOKUP = "metric_lookup"
    COMPARISON = "comparison"
    TREND = "trend"
    BREAKDOWN = "breakdown"
    ANOMALY = "anomaly"
    EXPLORE = "explore"
    CREATE_CHART = "create_chart"
    GENERAL = "general_question"


@dataclass
class ClassifiedQuery:
    intent: QueryIntent
    entities: dict
    # {"metrics": [...], "dimensions": [...],
    #  "time_range": ..., "filters": [...]}
    confidence: float
    search_queries: list[str]
    # optimized queries for vector search


CLASSIFIER_PROMPT = """
You are a query intent classifier for a BI tool.
Given a user question, extract:

1. intent: One of:
   - metric_lookup: "what is X?", "show me X"
   - comparison: "compare X vs Y", "X by category"
   - trend: "how has X changed?", "X over time"
   - breakdown: "X by region", "break down X"
   - anomaly: "why did X drop?", "what happened to X?"
   - explore: "tell me about X", "anything interesting?"
   - create_chart: "create a chart for...", "build me a..."
   - general_question: greetings, non-data questions

2. entities:
   - metrics: ["revenue", "orders", ...]
   - dimensions: ["region", "month", ...]
   - time_range: "last quarter" / "2024" / null
   - filters: ["country=US", ...]

3. confidence: 0.0 to 1.0

4. search_queries: 1-3 optimized search strings for finding
   relevant charts/tables. Focus on key business concepts.

Respond ONLY in JSON. No markdown fences.
"""


async def classify_query(
    user_message: str,
    conversation_history: list[dict] = None
) -> ClassifiedQuery:
    """
    Classify user query intent using lightweight LLM.
    ~50ms latency with Haiku.
    """
    context = ""
    if conversation_history:
        # Include last 3 messages for context
        recent = conversation_history[-3:]
        context = "\nRecent conversation:\n"
        context += "\n".join(
            f"{m['role']}: {m['content'][:200]}"
            for m in recent
        )

    response = await call_llm(
        system=CLASSIFIER_PROMPT,
        user=f"Query: {user_message}{context}",
        model="claude-3-5-haiku-20241022",
        max_tokens=300
    )

    parsed = _safe_parse_json(response)

    return ClassifiedQuery(
        intent=QueryIntent(parsed.get("intent", "general_question")),
        entities=parsed.get("entities", {}),
        confidence=parsed.get("confidence", 0.5),
        search_queries=parsed.get("search_queries", [user_message])
    )
```

#### 3.1.3 Caching

Cache kết quả classifier cho các query pattern giống nhau (nếu dùng Redis hoặc in-memory LRU). Key = normalized query text. TTL = 1 giờ.

---

### 3.2 Context Builder

> **Effort:** ~3 ngày | **Priority:** P0

#### 3.2.1 Mục tiêu

Dựa trên classified query + vector search results, build một compact context package chỉ chứa thông tin liên quan. Target: dưới 3K tokens thay vì 50K+ nếu dump toàn bộ.

#### 3.2.2 Context Package Format

```python
# ai-service/app/agents/context_builder.py

@dataclass
class ContextPackage:
    """Compact context sent to main LLM."""

    # Relevant charts (top 3-5)
    charts: list[dict]
    # Format per chart:
    # {
    #   "id": "uuid",
    #   "name": "Revenue by Region",
    #   "chart_type": "bar",
    #   "table_name": "sales_data",
    #   "dimensions": ["region"],
    #   "metrics": ["sum(revenue)"],
    #   "similarity": 0.89
    # }

    # Relevant tables (top 3-5)
    tables: list[dict]
    # Format per table:
    # {
    #   "workspace_id": "uuid",
    #   "table_id": "uuid",
    #   "name": "sales_data",
    #   "columns": [
    #     {"name": "revenue", "dtype": "FLOAT",
    #      "description": "Total sales amount"},
    #     {"name": "region", "dtype": "VARCHAR",
    #      "samples": ["US", "EU", "APAC"]}
    #   ],
    #   "row_count": 50000
    # }

    # Data relationships
    relationships: list[dict]
    # [{"from": "orders.customer_id",
    #   "to": "customers.id",
    #   "type": "many_to_one"}]

    # Conversation context
    conversation_summary: str
    # Compressed summary of prior turns


async def build_context(
    classified: ClassifiedQuery,
    user_id: str,
    db,
    conversation_history: list = None
) -> ContextPackage:
    """
    Build compact context for main LLM.

    Flow:
    1. Vector search for relevant charts
    2. Get tables referenced by those charts
    3. Find additional tables matching entities
    4. Extract relationships between tables
    5. Compress conversation history
    """

    # 1. Search charts using optimized queries
    all_charts = []
    for sq in classified.search_queries:
        results = await EmbeddingService.search_similar(
            db, sq,
            resource_type="chart",
            limit=3,
            user_id=user_id
        )
        all_charts.extend(results)

    # Deduplicate and take top 5
    seen = set()
    charts = []
    for c in sorted(all_charts, key=lambda x: x["similarity"], reverse=True):
        if c["resource_id"] not in seen:
            seen.add(c["resource_id"])
            charts.append(c)
        if len(charts) >= 5:
            break

    # 2. Get compact chart + table info
    chart_details = []
    table_ids = set()
    for c in charts:
        chart = await get_chart_compact(db, c["resource_id"])
        chart_details.append(chart)
        if chart.get("workspace_table_id"):
            table_ids.add(chart["workspace_table_id"])

    # 3. Search for additional tables matching extracted entities
    entity_tables = await search_tables_by_entities(
        db, classified.entities, user_id
    )
    for t in entity_tables:
        table_ids.add(t["id"])

    # 4. Get compact table info
    table_details = []
    for tid in list(table_ids)[:5]:
        tbl = await get_table_compact(db, tid)
        table_details.append(tbl)

    # 5. Find relationships
    relationships = await find_relationships(db, list(table_ids))

    # 6. Conversation summary
    conv_summary = ""
    if conversation_history and len(conversation_history) > 2:
        conv_summary = await summarize_conversation(conversation_history)

    return ContextPackage(
        charts=chart_details,
        tables=table_details,
        relationships=relationships,
        conversation_summary=conv_summary
    )
```

#### 3.2.3 System Prompt Template

Update system prompt của main agent để sử dụng context package:

```python
# ai-service/app/agents/system_prompt.py

def build_system_prompt(context: ContextPackage) -> str:
    return f"""
You are AppBI AI assistant. Help users analyze their business data.

## Available Data Context

### Relevant Charts (pre-matched):
{_format_charts(context.charts)}

### Available Tables:
{_format_tables(context.tables)}

### Table Relationships:
{_format_relationships(context.relationships)}

### Conversation Context:
{context.conversation_summary or "New conversation"}

## Tools Available:
- search_charts(query): find more charts
- run_chart(chart_id): execute and show chart
- execute_sql(datasource_id, sql): run query
- query_table(workspace_id, table_id, ...): aggregation query
- create_chart(...): create new visualization
- explore_data(table_id): profile a table
- explain_insight(chart_id, metric): drill-down analysis

## Rules:
1. Use pre-matched charts FIRST before searching
2. If a relevant chart exists, run_chart it
3. Only execute_sql as last resort
4. Always show data, not just describe it
5. Suggest follow-up questions
"""
```

---

### 3.3 Conversation Memory

> **Effort:** ~3 ngày | **Priority:** P0

#### 3.3.1 Mục tiêu

Cho phép multi-turn conversations. User hỏi "show me revenue" rồi tiếp "break it down by region" — agent phải biết "it" là revenue.

#### 3.3.2 Database Schema

```sql
CREATE TABLE chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    title VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL
        REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,
    -- "user", "assistant", "tool_call", "tool_result"
    content TEXT NOT NULL,
    metadata JSONB,
    -- tool_name, chart_id, etc.
    created_at TIMESTAMP DEFAULT NOW(),

    -- Order within session
    sequence_num INTEGER NOT NULL
);

CREATE INDEX idx_chat_messages_session
    ON chat_messages(session_id, sequence_num);
```

#### 3.3.3 Sliding Window Strategy

Không gửi toàn bộ conversation history vào LLM (tốn tokens). Thay vào đó:

- **Last 10 messages:** Gửi nguyên văn (user + assistant messages).
- **Older messages:** Summarize bằng lightweight LLM thành 1 đoạn ngắn (~200 tokens).
- **Tool results:** Chỉ include tool_name + summarized result, không include raw data.

#### 3.3.4 WebSocket Changes

Update WebSocket endpoint để support sessions:

```python
# ai-service/app/routers/chat.py

@router.websocket("/ws/chat")
async def chat_websocket(websocket: WebSocket):
    await websocket.accept()
    user = await authenticate_ws(websocket)

    # Get or create session
    session_id = websocket.query_params.get("session_id")
    if session_id:
        history = await load_session_history(session_id, window=10)
    else:
        session_id = await create_session(user.id)
        history = []

    try:
        while True:
            data = await websocket.receive_json()
            user_msg = data["message"]

            # Save user message
            await save_message(session_id, "user", user_msg)

            # 1. Classify
            classified = await classify_query(user_msg, history)

            # 2. Build context
            context = await build_context(
                classified, str(user.id), db, history
            )

            # 3. Run agent with streaming
            response = ""
            async for chunk in run_agent(
                user_msg, context, history, user
            ):
                await websocket.send_json(chunk)
                if chunk.get("type") == "text":
                    response += chunk["content"]

            # Save assistant response
            await save_message(session_id, "assistant", response)
            history.append({"role": "user", "content": user_msg})
            history.append({"role": "assistant", "content": response})
    except WebSocketDisconnect:
        pass
```

---

### 3.4 Usage-Based Ranking

> **Effort:** ~2 ngày | **Priority:** P1

#### 3.4.1 Mục tiêu

Charts/tables thường được xem bởi user hoặc team sẽ rank cao hơn trong search. Popularity là signal rất mạnh cho relevance.

#### 3.4.2 Implementation

```sql
-- Track resource views
CREATE TABLE resource_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_type VARCHAR(50) NOT NULL,
    resource_id UUID NOT NULL,
    user_id UUID NOT NULL,
    viewed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_views_resource
    ON resource_views(resource_type, resource_id);

-- Materialized view for popularity scores
CREATE MATERIALIZED VIEW resource_popularity AS
SELECT
    resource_type,
    resource_id,
    count(*) as total_views,
    count(DISTINCT user_id) as unique_viewers,
    count(*) FILTER (
        WHERE viewed_at > NOW() - INTERVAL '7 days'
    ) as views_7d,
    count(*) FILTER (
        WHERE viewed_at > NOW() - INTERVAL '30 days'
    ) as views_30d
FROM resource_views
GROUP BY resource_type, resource_id;

-- Refresh daily via cron / scheduler
REFRESH MATERIALIZED VIEW resource_popularity;
```

Trong vector search, combine similarity score với popularity:

```python
final_score = 0.7 * similarity + 0.3 * normalized_popularity
```

---

## 4. Phase 3: Enhanced Tools

Phase này thêm 4 tools mới cho agent. Mỗi tool được định nghĩa như một function mà LLM có thể gọi thông qua tool-calling.

### 4.1 Tool: `create_chart`

> **Effort:** ~5 ngày | **Priority:** P0

#### 4.1.1 Mục tiêu

Agent tự tạo chart mới từ câu hỏi NL. Ví dụ: user hỏi "show me monthly churn rate" nhưng không có chart nào về churn → agent xác định table, columns, chart_type và tạo luôn.

#### 4.1.2 Tool Definition (cho LLM)

```json
{
  "name": "create_chart",
  "description": "Create a new chart visualization. Use when no existing chart matches the user's question and you have identified the right table and columns.",
  "parameters": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Chart title"
      },
      "workspace_table_id": {
        "type": "string",
        "description": "UUID of the workspace table"
      },
      "chart_type": {
        "type": "string",
        "enum": ["bar", "line", "area", "pie", "scatter", "grouped_bar", "stacked_bar", "table", "kpi", "time_series", "combo"],
        "description": "Chart type"
      },
      "config": {
        "type": "object",
        "properties": {
          "dimensions": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Column names for X-axis / grouping"
          },
          "metrics": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "column": {"type": "string"},
                "aggregation": {
                  "type": "string",
                  "enum": ["sum", "avg", "count", "min", "max", "count_distinct"]
                }
              }
            },
            "description": "Metrics to show"
          },
          "filters": {
            "type": "array",
            "description": "Optional filters"
          },
          "sort_by": {"type": "string"},
          "limit": {"type": "integer"}
        }
      },
      "save": {
        "type": "boolean",
        "default": false,
        "description": "Save permanently or temporary preview only"
      }
    },
    "required": ["name", "workspace_table_id", "chart_type", "config"]
  }
}
```

#### 4.1.3 Backend Implementation

Tạo endpoint mới cho AI-generated charts:

```python
# backend/app/api/charts.py

@router.post("/charts/ai-preview")
async def ai_preview_chart(
    payload: ChartCreateSchema,
    current_user = Depends(get_current_user),
    db = Depends(get_db)
):
    """
    Create a temporary chart preview for AI.
    Does NOT save to database unless save=true.
    Returns rendered chart data.
    """
    # Permission check
    table = db.query(DatasetWorkspaceTable).get(
        payload.workspace_table_id
    )
    require_view_access(db, current_user, table.workspace)

    # Build and execute DuckDB query
    query = build_chart_query(table, payload.config)
    data = execute_duckdb_query(query)

    chart_response = {
        "chart_type": payload.chart_type,
        "config": payload.config,
        "data": data,
        "row_count": len(data),
    }

    if payload.save:
        # Save permanently
        chart = Chart(
            name=payload.name,
            workspace_table_id=payload.workspace_table_id,
            chart_type=payload.chart_type,
            config=payload.config,
            owner_id=current_user.id
        )
        db.add(chart)
        db.commit()
        chart_response["chart_id"] = str(chart.id)
        chart_response["saved"] = True

        # Trigger async embedding + tagging
        background_tasks.add_task(embed_chart, db, chart, table)

    return chart_response
```

#### 4.1.4 Frontend: Render AI Charts in Chat

AI chat component cần render chart trực tiếp trong conversation:

- **WebSocket message type mới:** `{ type: "chart_preview", data: {...}, chart_type: "bar" }`
- **Reuse ChartPreview component:** Import từ `components/charts/ChartPreview` và render trong chat bubble.
- **Save button:** Thêm button "Save to My Charts" và "Pin to Dashboard" trong chart preview.

---

### 4.2 Tool: `explore_data`

> **Effort:** ~4 ngày | **Priority:** P1

#### 4.2.1 Tool Definition

```json
{
  "name": "explore_data",
  "description": "Profile a table to discover patterns, distributions, and anomalies. Use when user says 'tell me about this data', 'anything interesting?', or when you need to understand a table before creating charts.",
  "parameters": {
    "properties": {
      "workspace_table_id": {
        "type": "string"
      },
      "focus_columns": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Specific columns to analyze. If empty, analyze all."
      },
      "analysis_type": {
        "type": "string",
        "enum": ["overview", "distribution", "correlation", "time_patterns", "outliers"],
        "default": "overview"
      }
    },
    "required": ["workspace_table_id"]
  }
}
```

#### 4.2.2 Backend: Profiling Queries

Chạy tập hợp DuckDB queries tùy theo `analysis_type`:

| analysis_type | Queries chạy | Output |
|---------------|-------------|--------|
| `overview` | Row count, column stats summary, null rates, top 5 values per categorical column | Table profile overview |
| `distribution` | Histogram bins cho numeric, value_counts cho categorical | Distribution data per column |
| `correlation` | `CORR()` giữa các numeric columns | Correlation matrix |
| `time_patterns` | `GROUP BY date_trunc('month', date_col)`, AVG/SUM metrics | Trends over time |
| `outliers` | Z-score > 3 hoặc IQR method | Outlier rows + context |

---

### 4.3 Tool: `explain_insight`

> **Effort:** ~5 ngày | **Priority:** P0

#### 4.3.1 Mục tiêu

Đây là tool tạo giá trị lớn nhất. Khi một metric thay đổi, agent tự động drill down để tìm nguyên nhân.

Ví dụ: "Why did revenue drop last week?" → Agent:

1. Chạy revenue tổng tuần này vs tuần trước: **-15%**
2. Drill down by region: APAC **-32%**, EU -5%, US +2%
3. Drill down APAC by product: Electronics **-45%**, Apparel +3%
4. Kết luận: Revenue giảm chủ yếu do Electronics sales ở APAC

#### 4.3.2 Tool Definition

```json
{
  "name": "explain_insight",
  "description": "Automatically drill down into a metric change to find root cause. Use when user asks 'why did X change?', 'what happened to X?', 'explain this trend'.",
  "parameters": {
    "properties": {
      "workspace_table_id": {"type": "string"},
      "metric_column": {
        "type": "string",
        "description": "Column to analyze (e.g. 'revenue')"
      },
      "aggregation": {
        "type": "string",
        "enum": ["sum", "avg", "count", "max", "min"]
      },
      "time_column": {
        "type": "string",
        "description": "Date/time column for period comparison"
      },
      "comparison": {
        "type": "string",
        "enum": ["week_over_week", "month_over_month", "quarter_over_quarter", "year_over_year", "custom"],
        "default": "week_over_week"
      },
      "dimension_columns": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Columns to drill into. If empty, auto-detect from table."
      }
    },
    "required": ["workspace_table_id", "metric_column", "aggregation"]
  }
}
```

#### 4.3.3 Drill-Down Algorithm

```python
# ai-service/app/agents/tools/explain_insight.py

async def explain_metric_change(
    table_id: str,
    metric_col: str,
    agg: str,
    time_col: str,
    comparison: str,
    dimension_cols: list[str],
    db, user_id: str
) -> dict:
    """
    Multi-level drill-down to explain metric change.
    Returns structured analysis.
    """
    table = get_table_info(db, table_id)
    parquet = get_parquet_path(table)
    conn = get_duckdb_connection()

    # 1. Compute overall change
    periods = get_comparison_periods(time_col, comparison)
    overall = conn.execute(f"""
        SELECT
            {agg}("{metric_col}") FILTER
                (WHERE "{time_col}"
                 BETWEEN '{periods.current_start}'
                 AND '{periods.current_end}')
                as current_val,
            {agg}("{metric_col}") FILTER
                (WHERE "{time_col}"
                 BETWEEN '{periods.prev_start}'
                 AND '{periods.prev_end}')
                as previous_val
        FROM '{parquet}'
    """).fetchone()

    change_pct = (
        (overall[0] - overall[1]) / overall[1] * 100
        if overall[1] else 0
    )

    # 2. Auto-detect dimensions if not provided
    if not dimension_cols:
        dimension_cols = [
            col for col, stats in table.column_stats.items()
            if not stats["is_numeric"]
            and stats["cardinality"] < 50
            and col != time_col
        ]

    # 3. Drill down each dimension
    drill_results = []
    for dim in dimension_cols[:5]:
        breakdown = conn.execute(f"""
            SELECT
                "{dim}",
                {agg}("{metric_col}") FILTER
                    (WHERE "{time_col}"
                     BETWEEN '{periods.current_start}'
                     AND '{periods.current_end}')
                    as current_val,
                {agg}("{metric_col}") FILTER
                    (WHERE "{time_col}"
                     BETWEEN '{periods.prev_start}'
                     AND '{periods.prev_end}')
                    as previous_val
            FROM '{parquet}'
            GROUP BY "{dim}"
            ORDER BY ABS(current_val - previous_val) DESC
            LIMIT 10
        """).fetchall()

        contributions = []
        for row in breakdown:
            dim_val, curr, prev = row
            dim_change = (
                (curr - prev) / prev * 100 if prev else 0
            )
            absolute_impact = (
                (curr - prev) / (overall[0] - overall[1]) * 100
                if overall[0] != overall[1] else 0
            )
            contributions.append({
                "value": str(dim_val),
                "current": float(curr or 0),
                "previous": float(prev or 0),
                "change_pct": round(dim_change, 1),
                "contribution_pct": round(absolute_impact, 1)
            })

        drill_results.append({
            "dimension": dim,
            "contributions": contributions
        })

    # 4. Find top contributor
    top_contributor = None
    max_impact = 0
    for dr in drill_results:
        for c in dr["contributions"]:
            if abs(c["contribution_pct"]) > max_impact:
                max_impact = abs(c["contribution_pct"])
                top_contributor = {
                    "dimension": dr["dimension"],
                    "value": c["value"],
                    "change_pct": c["change_pct"],
                    "contribution_pct": c["contribution_pct"]
                }

    return {
        "overall": {
            "current": float(overall[0] or 0),
            "previous": float(overall[1] or 0),
            "change_pct": round(change_pct, 1),
            "period": comparison
        },
        "drill_downs": drill_results,
        "top_contributor": top_contributor,
        "summary": _generate_summary(
            metric_col, change_pct, top_contributor
        )
    }
```

---

### 4.4 Tool: `suggest_next`

> **Effort:** ~3 ngày | **Priority:** P1

#### 4.4.1 Mục tiêu

Sau mỗi response, generate 2-3 follow-up questions dựa trên context + data patterns. Hiển thị dưới dạng clickable chips trong chat UI.

#### 4.4.2 Implementation

Không cần là tool riêng cho LLM gọi. Thay vào đó, sau mỗi agent response, append vào system prompt:

```python
# After agent generates response, ask for suggestions

SUGGEST_PROMPT = """
Based on the conversation and data context,
suggest 2-3 natural follow-up questions
the user might want to ask next.

Requirements:
- Questions should be specific and actionable
- Reference actual data/tables/metrics available
- Vary the types: one drill-down, one comparison,
  one trend or anomaly question
- Keep under 10 words each

Respond ONLY as JSON array of strings.
"""


async def generate_suggestions(
    response: str,
    context: ContextPackage,
    classified: ClassifiedQuery
) -> list[str]:
    """Generate follow-up question suggestions."""
    result = await call_llm(
        system=SUGGEST_PROMPT,
        user=f"""
        Last response: {response[:500]}
        Available metrics: {_extract_metrics(context)}
        Available dimensions: {_extract_dimensions(context)}
        User intent was: {classified.intent}
        """,
        model="claude-3-5-haiku-20241022",
        max_tokens=200
    )
    return _safe_parse_json(result)
```

#### 4.4.3 Frontend: Suggestion Chips

Trong AI chat component, render suggestions dưới dạng clickable chips:

- **Component:** `SuggestionChips.tsx` — horizontal scrollable list của pill buttons.
- **On click:** Gửi suggestion text như user message qua WebSocket.
- **Positioning:** Đặt dưới mỗi assistant message, trước input box.
- **Animation:** Fade in với stagger delay (100ms mỗi chip).

---

## 5. Phase 4: Proactive Intelligence

Phase này biến AI Agent từ reactive (chờ user hỏi) thành proactive (tự phát hiện và thông báo). Đây là differentiator lớn nhất so với mọi BI tool.

### 5.1 Anomaly Detection & Alerts

> **Effort:** ~8 ngày | **Priority:** P1

#### 5.1.1 Mục tiêu

Hệ thống tự động chạy hàng ngày, so sánh metrics với baseline, và thông báo khi phát hiện anomaly. User mở AI Chat và thấy: "Revenue ở EU giảm 25% hôm qua so với 7-day average."

#### 5.1.2 Architecture

- **Scheduler:** Chạy daily (hoặc hourly cho critical metrics) vào lúc off-peak (2AM).
- **Metric Registry:** User/admin define metrics cần monitor (table, column, aggregation, dimensions).
- **Detection Algorithm:** So sánh giá trị hiện tại với moving average (7 ngày). Flag nếu |z-score| > 2.
- **Alert Storage:** Lưu vào bảng `anomaly_alerts`.
- **Delivery:** Push vào AI Chat như system message. Phase sau: email notifications.

#### 5.1.3 Database Schema

```sql
CREATE TABLE monitored_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_table_id UUID NOT NULL
        REFERENCES dataset_workspace_tables(id),
    metric_column VARCHAR(200) NOT NULL,
    aggregation VARCHAR(20) DEFAULT 'sum',
    time_column VARCHAR(200),
    dimension_columns JSONB DEFAULT '[]',
    check_frequency VARCHAR(20) DEFAULT 'daily',
    -- "hourly", "daily", "weekly"
    threshold_z_score FLOAT DEFAULT 2.0,
    is_active BOOLEAN DEFAULT true,
    owner_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE anomaly_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    monitored_metric_id UUID NOT NULL
        REFERENCES monitored_metrics(id),
    detected_at TIMESTAMP DEFAULT NOW(),
    current_value FLOAT NOT NULL,
    expected_value FLOAT NOT NULL,
    z_score FLOAT NOT NULL,
    change_pct FLOAT NOT NULL,
    dimension_values JSONB,
    -- {"region": "EU", "product": "Electronics"}
    severity VARCHAR(20),
    -- "info", "warning", "critical"
    is_read BOOLEAN DEFAULT false,
    explanation TEXT
    -- LLM-generated explanation
);
```

#### 5.1.4 Detection Service

```python
# backend/app/services/anomaly_detection.py

import duckdb
import numpy as np


class AnomalyDetectionService:

    @staticmethod
    async def check_metric(metric, db) -> list:
        """
        Check a single metric for anomalies.
        Returns list of detected anomalies.
        """
        conn = get_duckdb_connection()
        parquet = get_parquet_path(metric.table)

        # Get historical values (last 30 days)
        history = conn.execute(f"""
            SELECT
                date_trunc('day', "{metric.time_column}") as dt,
                {metric.aggregation}("{metric.metric_column}") as val
            FROM '{parquet}'
            WHERE "{metric.time_column}"
                >= current_date - INTERVAL '30 days'
            GROUP BY 1
            ORDER BY 1
        """).fetchall()

        if len(history) < 7:
            return []  # not enough data

        values = [h[1] for h in history]
        dates = [h[0] for h in history]

        # 7-day rolling stats
        window = values[-8:-1]  # last 7 days (excluding today)
        mean = np.mean(window)
        std = np.std(window)
        current = values[-1]

        if std == 0:
            return []

        z = (current - mean) / std

        anomalies = []
        if abs(z) >= metric.threshold_z_score:
            change_pct = (current - mean) / mean * 100
            severity = (
                "critical" if abs(z) >= 3
                else "warning" if abs(z) >= 2.5
                else "info"
            )

            anomalies.append({
                "current_value": current,
                "expected_value": round(mean, 2),
                "z_score": round(z, 2),
                "change_pct": round(change_pct, 1),
                "severity": severity,
                "date": str(dates[-1])
            })

            # Drill down by dimensions
            if metric.dimension_columns:
                for dim in metric.dimension_columns:
                    dim_anomalies = await _check_dimension(
                        conn, parquet, metric, dim, mean, std
                    )
                    anomalies[0][f"breakdown_{dim}"] = dim_anomalies

        return anomalies

    @staticmethod
    async def run_all_checks(db):
        """
        Cron job: check all active monitored metrics.
        """
        metrics = db.query(MonitoredMetric).filter(
            MonitoredMetric.is_active == True
        ).all()

        for metric in metrics:
            anomalies = await AnomalyDetectionService.check_metric(
                metric, db
            )
            for a in anomalies:
                # Save alert
                alert = AnomalyAlert(
                    monitored_metric_id=metric.id,
                    **a
                )
                db.add(alert)

                # Generate LLM explanation
                alert.explanation = await _generate_explanation(
                    metric, a
                )

        db.commit()
```

---

### 5.2 Auto-Dashboard Generation

> **Effort:** ~10 ngày | **Priority:** P1

#### 5.2.1 Mục tiêu

User nói "build me a sales dashboard" → Agent tự động:

1. Tìm các tables liên quan đến "sales"
2. Xác định KPI metrics (total revenue, order count, avg order value)
3. Tạo 4-6 charts: KPI cards + time series + breakdown + table
4. Compose thành dashboard với layout hợp lý
5. Trả về link đến dashboard mới

#### 5.2.2 Tool Definition

```json
{
  "name": "create_dashboard",
  "description": "Automatically generate a complete dashboard with multiple charts. Use when user asks 'build me a dashboard', 'create a dashboard for...', 'I need a monitoring page for...'.",
  "parameters": {
    "properties": {
      "topic": {
        "type": "string",
        "description": "Dashboard topic: 'sales', 'marketing', 'SaaS metrics'"
      },
      "workspace_table_ids": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Tables to use. If empty, auto-detect from topic."
      },
      "chart_count": {
        "type": "integer",
        "default": 6,
        "description": "Number of charts (4-8)"
      }
    },
    "required": ["topic"]
  }
}
```

#### 5.2.3 Dashboard Composition Logic

Agent sử dụng một dashboard template strategy:

| Slot | Chart Type | Purpose | Auto-config |
|------|-----------|---------|-------------|
| 1-2 (top row) | `kpi` | Key metrics at a glance | Top 2 numeric columns, compare vs previous period |
| 3 (wide) | `time_series` / `line` | Trend over time | Main metric by date column, 30-day range |
| 4 (wide) | `bar` / `grouped_bar` | Breakdown by dimension | Main metric by top categorical column |
| 5 | `pie` | Composition | Main metric by second categorical |
| 6 | `table` | Detail view | Top 20 rows, sorted by metric desc |

Layout grid (`react-grid-layout` format):

```python
DEFAULT_LAYOUT = [
    {"i": "kpi-1",     "x": 0, "y": 0,  "w": 3, "h": 2},
    {"i": "kpi-2",     "x": 3, "y": 0,  "w": 3, "h": 2},
    {"i": "trend",     "x": 0, "y": 2,  "w": 6, "h": 4},
    {"i": "breakdown", "x": 0, "y": 6,  "w": 4, "h": 4},
    {"i": "pie",       "x": 4, "y": 6,  "w": 2, "h": 4},
    {"i": "table",     "x": 0, "y": 10, "w": 6, "h": 4},
]
```

---

### 5.3 Data Storytelling (Weekly Narrative)

> **Effort:** ~5 ngày | **Priority:** P2

#### 5.3.1 Mục tiêu

Tự động generate weekly/monthly narrative summary. Ví dụ:

> *"This week, total orders increased 12% driven by the new product launch. However, return rate also increased 8%, primarily in electronics category. APAC region showed strongest growth at +18%."*

#### 5.3.2 Implementation

- **Scheduler:** Chạy weekly (Monday 8AM) hoặc monthly (1st of month).
- **Data Collection:** Cho mỗi monitored metric, collect current vs previous period.
- **LLM Narrative:** Gửi structured data đến LLM với prompt: "Write a 3-paragraph business narrative..."
- **Delivery:** Push vào AI Chat + option gửi qua email (Phase sau).

---

## 6. Testing Strategy

### 6.1 Unit Tests

| Component | Test Cases | Framework |
|-----------|-----------|-----------|
| `TableStatsService` | Compute stats cho các data types khác nhau, handle empty tables, handle null columns | pytest |
| `EmbeddingService` | Mock OpenAI API, test `build_chart_text` với các chart configs, test `search_similar` với permission filtering | pytest + httpx mock |
| `QueryClassifier` | Test 20+ query patterns, verify intent + entity extraction | pytest |
| `ContextBuilder` | Verify output < 3K tokens, test deduplication, test empty results | pytest |
| `ExplainInsight` | Test drill-down với known data, verify z-score calculation, test dimension auto-detection | pytest |

### 6.2 Integration Tests

- **E2E Chat Flow:** User query → classify → build context → agent response → verify answer references correct chart.
- **Permission Test:** User A asks about User B's chart → verify 403 / no results.
- **Create Chart Flow:** NL query → `create_chart` tool → verify chart data matches expected.
- **Anomaly Detection:** Inject known anomaly into test data → verify detection + alert creation.

### 6.3 Evaluation Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Search Accuracy (Top-3) | > 85% | Manually labeled test set của 100 queries, check if correct chart trong top 3 |
| Response Relevance | > 90% | LLM-as-judge: prompt GPT-4 đánh giá relevant/irrelevant |
| Latency (P95) | < 5s | Measure từ user send đến first token |
| Context Compression | < 3K tokens | Log token count của context package |
| Permission Leaks | 0 | Automated test suite: 50 cross-user queries |

---

## 7. Deployment & Migration

### 7.1 Database Migrations

Tất cả schema changes đều dùng Alembic. Thứ tự migration:

1. **`add_column_stats`** — Thêm `column_stats`, `auto_description`, `stats_updated_at` vào `dataset_workspace_tables`
2. **`add_pgvector`** — Enable pgvector extension, tạo `resource_embeddings` table
3. **`add_chat_sessions`** — Tạo `chat_sessions` + `chat_messages` tables
4. **`add_resource_views`** — Tạo `resource_views` + materialized view
5. **`add_anomaly_tables`** — Tạo `monitored_metrics` + `anomaly_alerts`

### 7.2 Docker Changes

- **PostgreSQL image:** Chuyển sang `pgvector/pgvector:pg16` (drop-in replacement cho `postgres:16`, đã include pgvector extension).
- **AI Service:** Thêm `httpx` vào `requirements.txt` (cho embedding API calls).
- **Environment Variables mới:** `EMBEDDING_MODEL`, `ANOMALY_CHECK_CRON`, `ENABLE_AUTO_TAGGING`.

### 7.3 Rollout Plan

| Step | Action | Rollback |
|------|--------|----------|
| 1 | Deploy database migrations (non-breaking, additive only) | Migrations đều là ADD COLUMN / CREATE TABLE, không ảnh hưởng existing features |
| 2 | Deploy backend với Phase 1 code (column stats + embeddings) | Feature flag: `ENABLE_VECTOR_SEARCH=false` để fallback về text search |
| 3 | Run batch re-index script cho existing charts | Không cần rollback, chỉ populate mới |
| 4 | Deploy AI service với Phase 2 (classifier + context builder) | Feature flag: `ENABLE_SMART_ROUTING=false` |
| 5 | Deploy Phase 3 tools (create_chart, explore_data, explain_insight) | Tool definitions có thể disable trong agent config |
| 6 | Enable anomaly detection (Phase 4) cho pilot users | `ENABLE_ANOMALY_DETECTION=false` |

---

## 8. File Map — Files cần tạo / sửa

### 8.1 Files mới cần tạo

| File Path | Mô tả | Phase |
|-----------|-------|-------|
| `backend/app/services/table_stats_service.py` | Compute column statistics với DuckDB | 1 |
| `backend/app/services/embedding_service.py` | Vector embedding generation + search | 1 |
| `backend/app/services/auto_tagging_service.py` | LLM auto-tagging cho charts/tables | 1 |
| `ai-service/app/agents/query_classifier.py` | Query intent classification | 2 |
| `ai-service/app/agents/context_builder.py` | Build compact context package | 2 |
| `ai-service/app/agents/system_prompt.py` | Dynamic system prompt builder | 2 |
| `ai-service/app/agents/tools/create_chart.py` | Tool: create new chart from NL | 3 |
| `ai-service/app/agents/tools/explore_data.py` | Tool: data profiling | 3 |
| `ai-service/app/agents/tools/explain_insight.py` | Tool: drill-down analysis | 3 |
| `ai-service/app/agents/tools/suggest_next.py` | Generate follow-up suggestions | 3 |
| `backend/app/services/anomaly_detection.py` | Anomaly detection engine | 4 |
| `backend/app/services/auto_dashboard.py` | Auto-dashboard composition | 4 |
| `backend/app/services/storytelling.py` | Weekly narrative generation | 4 |
| `frontend/src/components/ai-chat/SuggestionChips.tsx` | Clickable follow-up suggestions | 3 |
| `frontend/src/components/ai-chat/ChatChartPreview.tsx` | Render chart trong chat | 3 |
| `frontend/src/components/ai-chat/AnomalyAlert.tsx` | Anomaly notification trong chat | 4 |

### 8.2 Files cần sửa

| File Path | Changes | Phase |
|-----------|---------|-------|
| `backend/app/models/dataset_workspace.py` | Thêm `column_stats`, `auto_description`, `stats_updated_at` | 1 |
| `backend/app/api/charts.py` | Thêm POST `/charts/ai-preview` endpoint | 3 |
| `backend/app/api/datasources.py` | Gọi `update_table_stats` sau sync/import | 1 |
| `backend/app/api/dataset_workspaces.py` | Gọi `update_table_stats` sau create/update table | 1 |
| `backend/app/main.py` | Thêm anomaly detection scheduler | 4 |
| `ai-service/app/routers/chat.py` | Thêm session management, new pipeline | 2 |
| `ai-service/app/agents/agent.py` | Integrate context builder, new tools | 2-3 |
| `ai-service/app/agents/tools.py` | Register 4 new tools | 3 |
| `frontend/src/components/ai-chat/*` | Chat UI: chart preview, suggestions, alerts | 3-4 |
| `docker-compose.yml` | Switch to pgvector image, add env vars | 1 |
| `ai-service/requirements.txt` | Thêm `httpx`, `numpy` | 1 |

---

## Appendix A: Cost Estimation

| Feature | LLM Calls/Day | Model | Cost/Day | Cost/Month |
|---------|--------------|-------|----------|------------|
| Auto-tagging (batch) | ~50 (new charts/tables) | Haiku | ~$0.05 | ~$1.50 |
| Query Classifier | ~200 (per user query) | Haiku | ~$0.10 | ~$3.00 |
| Context Builder | ~200 (summarize conv.) | Haiku | ~$0.10 | ~$3.00 |
| Main Agent | ~200 | GPT-4o / Claude Sonnet | ~$2.00 | ~$60.00 |
| Suggest Next | ~200 | Haiku | ~$0.10 | ~$3.00 |
| Anomaly Explanation | ~10 | Haiku | ~$0.01 | ~$0.30 |
| Embeddings | ~50 new + ~200 queries | text-embedding-3-small | ~$0.01 | ~$0.30 |
| **TOTAL** | | | **~$2.37** | **~$71.10** |

> **Ghi chú:** Estimates dựa trên team ~10 users, mỗi user ~20 queries/ngày. Scale tuyến tính với số queries. Chi phí chủ yếu ở main agent (~85%).

---

## Appendix B: Glossary

| Thuật ngữ | Định nghĩa |
|-----------|------------|
| **Vector Embedding** | Biểu diễn số học (array of floats) của text, cho phép tìm kiếm theo ngữ nghĩa thay vì từ khóa |
| **pgvector** | PostgreSQL extension hỗ trợ vector data type và similarity search |
| **Context Window** | Số tokens tối đa mà LLM có thể xử lý trong một request |
| **Tool-Calling** | Khả năng của LLM gọi function/API để thực hiện tác vụ (search, query, create) |
| **Z-Score** | Đo lường số độ lệch tiêu chuẩn của giá trị so với trung bình. \|z\| > 2 = anomaly |
| **Semantic Search** | Tìm kiếm dựa trên ý nghĩa ("monthly sales" tìm được "revenue over time") |
| **Sliding Window** | Chiến lược chỉ giữ N messages gần nhất, summarize phần cũ hơn |
| **Drill-Down** | Phân tích sâu hơn bằng cách chia nhỏ theo dimension (region, product, time) |
