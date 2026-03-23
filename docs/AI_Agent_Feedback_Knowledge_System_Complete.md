# AI Agent: Feedback-Driven Knowledge System — Complete Spec

> 5 features kết nối thành 1 vòng lặp tự cải thiện
> Brief kỹ thuật cho Development Team

---

## Tổng quan

Embedding search chỉ tốt khi "bộ nhớ" giàu thông tin. Bộ nhớ đó cần 5 nguồn để giàu lên, tạo thành vòng lặp khép kín:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   ① Auto-Describe         Mô tả được tạo/cập nhật         │
│   (Table + Chart)              │                            │
│        │                       ▼                            │
│        │               Embedding re-index                   │
│        │                       │                            │
│        ▼                       ▼                            │
│   ② UI Review ◄──── AI search chính xác hơn               │
│   (User xem + sửa)            │                            │
│        │                       ▼                            │
│        │               AI trả lời đúng hơn                 │
│        ▼                       │                            │
│   ③ Schema Change              ▼                            │
│   Detection           ④ Feedback capture                    │
│   (Cột thêm/xóa/đổi)   (User sửa khi AI sai)             │
│        │                       │                            │
│        └───────────┬───────────┘                            │
│                    ▼                                        │
│              ⑤ Re-embed                                     │
│        (Cập nhật vector index)                              │
│                    │                                        │
│                    └──────► Vòng lặp tiếp tục ──────►      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

| # | Feature | Giải quyết vấn đề gì | Áp dụng cho |
|---|---------|----------------------|-------------|
| ① | Auto-Describe | User lười viết mô tả, cold start | **Table + Chart** |
| ② | UI Review | User cần xem và chỉnh mô tả | **Table + Chart** |
| ③ | Schema Change Detection | Bảng thêm/xóa/đổi cột mà mô tả cũ | **Table** |
| ④ | Feedback Capture | AI trả sai, cần học từ phản hồi | **Table + Chart** |
| ⑤ | Re-embed Pipeline | Mọi thay đổi mô tả cần cập nhật embedding | **Table + Chart** |

---

## Feature ① — Auto-Describe (Table + Chart)

### Mục tiêu

AI tự đọc dữ liệu mẫu + metadata rồi viết mô tả. User không cần viết từ đầu.

### ① -A: Auto-Describe cho Table

**Trigger:** Sau khi tạo workspace table / sau sync / sau upload CSV-Excel

**Input gửi cho LLM:**

```python
prompt = f"""
Table name: {table.display_name}
Source: {datasource.name} ({datasource.type})
SQL query: {table.sql_query or "physical table import"}

Columns ({len(columns)} columns):
{_format_column_stats(table.column_stats)}
# Mỗi cột: name, type, cardinality, min, max, 5 sample values

Sample data (first 5 rows):
{_format_sample_rows(duckdb_query("SELECT * FROM table LIMIT 5"))}

Generate:
1. description: 2-3 sentence business description (Vietnamese OK)
2. column_descriptions: dict mapping column_name → 1-sentence description
3. common_questions: 3-5 questions users might ask about this table
Respond ONLY in JSON.
"""
```

**Output lưu vào `DatasetWorkspaceTable`:**

```json
{
  "auto_description": "Bảng đơn hàng từ Shopify. Mỗi row = 1 đơn hàng. Chứa doanh thu (revenue), khu vực (region), danh mục (category), ngày đặt (order_date). Data 2023-01 đến 2025-03, cập nhật hàng ngày.",
  "column_descriptions": {
    "revenue": "Doanh thu đơn hàng (USD), không bao gồm thuế",
    "region": "Khu vực địa lý: US, EU, APAC, LATAM, MEA",
    "category": "Danh mục sản phẩm: Electronics, Apparel, Food, Home",
    "order_date": "Ngày đặt hàng, format YYYY-MM-DD"
  },
  "common_questions": [
    "Doanh thu theo khu vực",
    "Trend doanh thu theo tháng",
    "Top sản phẩm bán chạy",
    "So sánh doanh thu quý này vs quý trước"
  ]
}
```

### ①-B: Auto-Describe cho Chart

**Trigger:** Sau khi tạo chart mới / sau khi update chart config

**Input gửi cho LLM:**

```python
prompt = f"""
Chart name: {chart.name}
Chart type: {chart.chart_type}
Table: {table.display_name}
Table description: {table.auto_description}

Config:
  Dimensions (X-axis): {config.get("dimensions")}
  Metrics (Y-axis): {config.get("metrics")}
  Aggregation: {config.get("aggregation")}
  Filters: {config.get("filters")}
  Sort: {config.get("sort_by")}
  Limit: {config.get("limit")}

Available columns: {list(table.column_stats.keys())}

Generate:
1. description: 2-3 sentence description of what this chart shows
2. insight_keywords: 5-10 keywords/phrases users might search for
3. common_questions: 2-3 follow-up questions after viewing this chart
Respond ONLY in JSON.
"""
```

**Output lưu vào `ChartMetadata` (bảng chart_metadata đã có):**

```json
{
  "auto_description": "Bar chart hiển thị tổng doanh thu (SUM revenue) theo khu vực (region). Cho thấy US chiếm tỷ trọng lớn nhất, APAC tăng trưởng nhanh nhất.",
  "insight_keywords": [
    "revenue by region", "doanh thu theo vùng", "regional sales",
    "compare regions", "market share", "top market",
    "revenue breakdown", "geographic performance"
  ],
  "common_questions": [
    "Drill down vào khu vực APAC",
    "Trend doanh thu APAC qua các quý",
    "So sánh với cùng kỳ năm trước"
  ]
}
```

### ①-C: Model Changes

```python
# backend/app/models/dataset_workspace.py
class DatasetWorkspaceTable(Base):
    # ... existing fields ...
    
    # Phase 1 (đã có):
    column_stats = Column(JSONB)
    auto_description = Column(Text)
    stats_updated_at = Column(DateTime)
    
    # NEW:
    column_descriptions = Column(JSONB)       # {"col": "mô tả"}
    common_questions = Column(JSONB)          # ["câu hỏi 1", ...]
    query_aliases = Column(JSONB)             # ["revenue by region", ...] — từ feedback
    description_source = Column(VARCHAR(20))  # "auto" | "user" | "feedback"
    description_updated_at = Column(DateTime)
    schema_hash = Column(VARCHAR(64))         # SHA256 của sorted column names — cho Feature ③


# backend/app/models/models.py — Chart model (hoặc chart_metadata)
class ChartMetadata(Base):
    # ... existing fields (domain, intent, metrics, dimensions, tags) ...
    
    # NEW:
    auto_description = Column(Text)
    insight_keywords = Column(JSONB)          # ["revenue by region", ...]
    common_questions = Column(JSONB)
    query_aliases = Column(JSONB)             # Từ feedback
    description_source = Column(VARCHAR(20))  # "auto" | "user" | "feedback"
    description_updated_at = Column(DateTime)
```

### ①-D: Logic chống ghi đè

```python
async def auto_describe_table(db, table, force=False):
    """
    Auto-describe chỉ ghi khi:
    - Chưa có mô tả (description_source is None)
    - description_source = "auto" (AI tự viết lần trước → OK ghi đè)
    - force = True (user bấm "Regenerate")
    
    KHÔNG ghi đè khi:
    - description_source = "user" (user đã chỉnh tay)
    - description_source = "feedback" (đã được enrich từ feedback)
      → trừ khi force=True
    """
    if not force and table.description_source in ("user", "feedback"):
        return  # Tôn trọng bản user/feedback đã chỉnh
    
    result = await call_llm_describe(table)
    
    table.auto_description = result["description"]
    table.column_descriptions = result["column_descriptions"]
    table.common_questions = result["common_questions"]
    table.description_source = "auto"
    table.description_updated_at = datetime.utcnow()
    
    # Trigger re-embed (Feature ⑤)
    await re_embed_table(db, table)
    
    db.commit()
```

Chart tương tự — cùng logic, cùng flow.

---

## Feature ② — UI Review (Table + Chart)

### Mục tiêu

User nhìn thấy mô tả AI viết, có thể sửa ngay. Giảm effort từ "viết từ đầu" thành "review và sửa".

### ②-A: Table Description Panel

Hiển thị trong **Workspace Table Detail page** (khi click vào 1 table trong workspace):

```
┌──────────────────────────────────────────────────────────────┐
│ 📋 About this table                         [Edit] [🔄 Regen]│
│                                                               │
│ Bảng đơn hàng từ Shopify. Mỗi row = 1 đơn hàng. Chứa      │
│ doanh thu, khu vực, danh mục sản phẩm, ngày đặt hàng.      │
│ Data từ 2023-01 đến 2025-03.                                 │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐  │
│ │ Column          │ Type     │ Description                │  │
│ │─────────────────│──────────│────────────────────────────│  │
│ │ revenue         │ FLOAT    │ Doanh thu đơn hàng (USD)  │  │
│ │ region          │ VARCHAR  │ Khu vực: US, EU, APAC...  │  │
│ │ category        │ VARCHAR  │ Danh mục: Electronics...  │  │
│ │ order_date      │ DATE     │ Ngày đặt hàng             │  │
│ └─────────────────────────────────────────────────────────┘  │
│                                                               │
│ 💡 People often ask:                                          │
│ ┌──────────────────┐ ┌─────────────────┐ ┌────────────────┐  │
│ │Doanh thu theo vùng│ │Trend theo tháng │ │Top SP bán chạy │  │
│ └──────────────────┘ └─────────────────┘ └────────────────┘  │
│                                                               │
│ ✨ Auto-generated · Updated 5 min ago                         │
└──────────────────────────────────────────────────────────────┘
```

**Edit mode** (khi click [Edit]):
- Description: textarea, editable
- Column descriptions: inline edit từng dòng (click vào text → thành input)
- Common questions: thêm/xóa/sửa
- Save → `description_source = "user"` → không bị auto-overwrite

**[🔄 Regen]**: Confirm dialog "Regenerate will overwrite current description. Continue?" → gọi `auto_describe(force=True)`

**Badge**: "✨ Auto-generated" / "✏️ Edited by you" / "🔄 Updated from feedback"

### ②-B: Chart Description Panel

Hiển thị trong **Explore Chart Detail page** (khi mở chart detail):

```
┌──────────────────────────────────────────────────────────────┐
│ 📊 About this chart                         [Edit] [🔄 Regen]│
│                                                               │
│ Bar chart hiển thị tổng doanh thu (SUM revenue) theo khu     │
│ vực (region). US chiếm tỷ trọng lớn nhất.                   │
│                                                               │
│ 🏷️ Keywords: revenue by region, doanh thu theo vùng,         │
│    regional sales, geographic performance                     │
│                                                               │
│ 💡 Follow-up questions:                                       │
│ ┌──────────────────────┐ ┌──────────────────────────┐        │
│ │Drill down vào APAC   │ │Trend APAC qua các quý   │        │
│ └──────────────────────┘ └──────────────────────────┘        │
│                                                               │
│ ✨ Auto-generated · Updated 2 hours ago                       │
└──────────────────────────────────────────────────────────────┘
```

Tương tự table: Edit mode cho sửa description, keywords, questions. Save → `description_source = "user"`.

**Keywords đặc biệt quan trọng** — đây chính là thứ embedding search dùng để match. User thêm keyword = trực tiếp cải thiện search accuracy.

### ②-C: Frontend Files

| File | Mô tả |
|------|-------|
| `frontend/src/components/datasets/TableDescriptionPanel.tsx` | Panel mô tả table (view + edit mode) |
| `frontend/src/components/explore/ChartDescriptionPanel.tsx` | Panel mô tả chart (view + edit mode) |
| `frontend/src/hooks/useDescription.ts` | Hook: GET/PUT description, trigger regen |

---

## Feature ③ — Schema Change Detection

### Mục tiêu

Khi table thay đổi schema (thêm cột, xóa cột, đổi tên cột, đổi type) — mô tả cũ trở nên outdated. Hệ thống cần tự detect và cập nhật.

### Khi nào xảy ra

- User transform data trong workspace (thêm computed column)
- Datasource sync lại và source table đã thay đổi schema
- User re-import CSV/Excel với cấu trúc khác
- User sửa SQL query của workspace table

### Cách detect

Dùng `schema_hash` — SHA256 hash của sorted column names + types:

```python
# backend/app/services/schema_change_service.py

import hashlib
import json

def compute_schema_hash(column_stats: dict) -> str:
    """
    Hash sorted column names + types.
    Nếu hash thay đổi → schema đã thay đổi.
    """
    if not column_stats:
        return ""
    
    schema_signature = sorted([
        f"{col}:{stats['dtype']}"
        for col, stats in column_stats.items()
    ])
    
    return hashlib.sha256(
        json.dumps(schema_signature).encode()
    ).hexdigest()


async def check_and_handle_schema_change(db, table, new_column_stats: dict):
    """
    Gọi sau mỗi lần compute column_stats.
    So sánh schema_hash cũ vs mới.
    """
    new_hash = compute_schema_hash(new_column_stats)
    old_hash = table.schema_hash
    
    if old_hash and old_hash != new_hash:
        # Schema đã thay đổi!
        
        # 1. Tìm diff
        old_cols = set(table.column_stats.keys()) if table.column_stats else set()
        new_cols = set(new_column_stats.keys())
        
        added = new_cols - old_cols
        removed = old_cols - new_cols
        
        # 2. Cập nhật column_stats
        table.column_stats = new_column_stats
        table.schema_hash = new_hash
        
        # 3. Xử lý mô tả
        if table.description_source == "user":
            # User đã viết custom → KHÔNG auto ghi đè
            # Nhưng thông báo cho user biết schema đã đổi
            table.schema_change_pending = True  # Flag để UI hiện warning
            
            # Cập nhật column_descriptions cho cột mới (thêm vào, không xóa cột cũ)
            if added:
                new_col_descs = await _describe_new_columns(
                    table, added, new_column_stats
                )
                existing = table.column_descriptions or {}
                existing.update(new_col_descs)
                table.column_descriptions = existing
        else:
            # Auto hoặc feedback → regenerate toàn bộ
            await auto_describe_table(db, table, force=True)
        
        # 4. Re-embed (Feature ⑤)
        await re_embed_table(db, table)
        
        db.commit()
        
        return {
            "changed": True,
            "added_columns": list(added),
            "removed_columns": list(removed)
        }
    
    # Không đổi → chỉ cập nhật hash lần đầu
    if not old_hash:
        table.schema_hash = new_hash
        db.commit()
    
    return {"changed": False}
```

### UI Warning khi schema thay đổi

Nếu `schema_change_pending = True` và `description_source = "user"`:

```
┌──────────────────────────────────────────────────────────────┐
│ ⚠️ Table schema has changed                                  │
│                                                               │
│ 2 columns added: [new_col_1] [new_col_2]                    │
│ 1 column removed: [old_col]                                  │
│                                                               │
│ Your description may be outdated.                            │
│ [Update description] [Dismiss]                                │
└──────────────────────────────────────────────────────────────┘
```

- [Update description]: Gọi `auto_describe(force=True)` → merge kết quả mới với phần user đã viết
- [Dismiss]: Set `schema_change_pending = False`

### Model Changes

```python
class DatasetWorkspaceTable(Base):
    # ... existing + Feature ① fields ...
    
    # NEW for Feature ③:
    schema_hash = Column(VARCHAR(64))
    schema_change_pending = Column(Boolean, default=False)
```

### Integration Points

Gọi `check_and_handle_schema_change()` tại:

1. Sau `TableStatsService.update_table_stats()` (mỗi lần compute stats mới)
2. Sau khi add/remove computed columns
3. Sau khi user sửa SQL query của table
4. Sau datasource sync hoàn tất

---

## Feature ④ — Feedback Capture (Table + Chart)

### Mục tiêu

Khi AI trả sai, user có thể phản hồi. Feedback được dùng để bổ sung mô tả → cải thiện search cho mọi user.

### ④-A: UI trong AI Chat

Sau **mỗi AI response**, hiển thị:

```
┌──────────────────────────────────────────────────────────────┐
│ [AI response nội dung...]                                     │
│                                                               │
│ Was this helpful?    [👍 Yes]  [👎 No]  [💬 Correct this]    │
└──────────────────────────────────────────────────────────────┘
```

**Khi click 👎 hoặc 💬**, mở feedback form:

```
┌──────────────────────────────────────────────────────────────┐
│ Help us improve                                               │
│                                                               │
│ What went wrong?                                              │
│ ○ Used wrong table / data source                              │
│ ○ Used wrong chart                                            │
│ ○ Data is correct but answer is unclear                       │
│ ○ Other                                                       │
│                                                               │
│ The correct answer should reference:                          │
│ ┌──────────────────────────────────────────────────┐         │
│ │ 🔍 Search tables and charts...                    │         │
│ │                                                    │         │
│ │ 📊 Charts:                                        │         │
│ │   □ Revenue by Region (bar chart)                 │         │
│ │   □ Monthly Revenue Trend (time_series)           │         │
│ │                                                    │         │
│ │ 📋 Tables:                                        │         │
│ │   □ orders_2024 (Sales workspace)                 │         │
│ │   □ marketing_spend (Marketing workspace)         │         │
│ └──────────────────────────────────────────────────┘         │
│                                                               │
│ Additional notes (optional):                                  │
│ ┌──────────────────────────────────────────────────┐         │
│ │ Ở đây chúng tôi gọi "revenue" là "GMV"          │         │
│ └──────────────────────────────────────────────────┘         │
│                                                               │
│                                    [Cancel] [Submit Feedback] │
└──────────────────────────────────────────────────────────────┘
```

### ④-B: Database Schema

```sql
CREATE TABLE ai_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Context: câu hỏi nào, session nào
    session_id UUID REFERENCES chat_sessions(id),
    message_id UUID REFERENCES chat_messages(id),
    user_id UUID NOT NULL REFERENCES users(id),
    user_query TEXT NOT NULL,
    
    -- AI đã match resource nào (sai)
    ai_matched_resource_type VARCHAR(50),  -- "chart" | "workspace_table"
    ai_matched_resource_id UUID,
    
    -- User chỉ ra resource nào đúng
    feedback_type VARCHAR(30) NOT NULL,
    -- "wrong_table" | "wrong_chart" | "unclear" | "other"
    correct_resource_type VARCHAR(50),     -- "chart" | "workspace_table"
    correct_resource_id UUID,
    notes TEXT,                             -- Free-text notes
    
    -- Signal
    is_positive BOOLEAN DEFAULT false,     -- true = 👍
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_feedback_correct ON ai_feedback(correct_resource_type, correct_resource_id);
CREATE INDEX idx_feedback_user ON ai_feedback(user_id);
```

### ④-C: API Endpoints

```python
# backend/app/api/feedback.py

@router.post("/ai/feedback")
async def submit_feedback(
    payload: FeedbackCreateSchema,
    current_user = Depends(get_current_user),
    db = Depends(get_db)
):
    """Submit feedback on AI response."""
    feedback = AIFeedback(
        user_id=current_user.id,
        **payload.dict()
    )
    db.add(feedback)
    db.commit()
    
    # Trigger async processing (Feature ⑤)
    background_tasks.add_task(
        process_feedback, feedback, db
    )
    
    return {"status": "ok", "feedback_id": str(feedback.id)}


@router.get("/ai/feedback/stats")
async def feedback_stats(
    current_user = Depends(get_current_user),
    db = Depends(get_db)
):
    """Dashboard: feedback stats for admin."""
    # Tổng positive/negative, top corrected tables, trending queries
    ...
```

---

## Feature ⑤ — Re-embed Pipeline

### Mục tiêu

Mọi thay đổi mô tả (từ ①②③④) đều phải cập nhật embedding vector. Đây là "hệ thống thần kinh" nối tất cả lại.

### Khi nào trigger re-embed

| Event | Trigger |
|-------|---------|
| Auto-describe hoàn tất (Feature ①) | `re_embed_table()` / `re_embed_chart()` |
| User edit description (Feature ②) | PUT API save → `re_embed()` |
| Schema change detected (Feature ③) | Sau `auto_describe(force=True)` |
| Feedback processed (Feature ④) | Sau `process_feedback()` |

### Implementation

```python
# backend/app/services/re_embed_service.py

async def re_embed_table(db, table):
    """
    Rebuild embedding cho table dựa trên MỌI thông tin hiện có.
    Gộp: description + column descriptions + query aliases + common questions
    """
    parts = []
    
    # 1. Main description
    if table.auto_description:
        parts.append(table.auto_description)
    
    # 2. Column descriptions
    if table.column_descriptions:
        for col, desc in table.column_descriptions.items():
            parts.append(f"Column {col}: {desc}")
    
    # 3. Column names + types (từ column_stats)
    if table.column_stats:
        col_summary = ", ".join([
            f"{col} ({stats['dtype']})"
            for col, stats in table.column_stats.items()
        ])
        parts.append(f"Columns: {col_summary}")
    
    # 4. Query aliases (từ feedback)
    if table.query_aliases:
        parts.append(
            f"Also known as / commonly searched with: "
            f"{', '.join(table.query_aliases)}"
        )
    
    # 5. Common questions
    if table.common_questions:
        parts.append(
            f"Common questions: {'; '.join(table.common_questions)}"
        )
    
    text = "\n".join(parts)
    
    await EmbeddingService.embed_resource(
        db,
        resource_type="workspace_table",
        resource_id=table.id,
        text=text
    )


async def re_embed_chart(db, chart):
    """
    Rebuild embedding cho chart.
    """
    metadata = chart.metadata  # ChartMetadata
    parts = []
    
    # 1. Chart name + type
    parts.append(f"Chart: {chart.name} ({chart.chart_type})")
    
    # 2. Auto description
    if metadata and metadata.auto_description:
        parts.append(metadata.auto_description)
    
    # 3. Existing metadata fields
    if metadata:
        if metadata.domain:
            parts.append(f"Domain: {metadata.domain}")
        if metadata.metrics:
            parts.append(f"Metrics: {metadata.metrics}")
        if metadata.dimensions:
            parts.append(f"Dimensions: {metadata.dimensions}")
        if metadata.tags:
            parts.append(f"Tags: {metadata.tags}")
    
    # 4. Insight keywords
    if metadata and metadata.insight_keywords:
        parts.append(
            f"Keywords: {', '.join(metadata.insight_keywords)}"
        )
    
    # 5. Query aliases (từ feedback)
    if metadata and metadata.query_aliases:
        parts.append(
            f"Also searched as: {', '.join(metadata.query_aliases)}"
        )
    
    # 6. Chart config info
    config = chart.config or {}
    if config.get("dimensions"):
        parts.append(f"X-axis: {config['dimensions']}")
    if config.get("metrics"):
        parts.append(f"Y-axis: {config['metrics']}")
    
    # 7. Table info (nối context)
    table = chart.workspace_table
    if table and table.auto_description:
        parts.append(f"Source table: {table.display_name} — {table.auto_description[:200]}")
    
    text = "\n".join(parts)
    
    await EmbeddingService.embed_resource(
        db,
        resource_type="chart",
        resource_id=chart.id,
        text=text
    )
```

### Feedback Processing → Re-embed

```python
# backend/app/services/feedback_processor.py

async def process_feedback(feedback, db):
    """
    Khi user chỉ ra resource đúng:
    1. Bổ sung query vào query_aliases
    2. Re-embed resource đúng
    3. Ghi nhận negative signal cho resource sai
    """
    if not feedback.correct_resource_id:
        return
    
    if feedback.correct_resource_type == "workspace_table":
        table = db.query(DatasetWorkspaceTable).get(feedback.correct_resource_id)
        
        # Thêm query vào aliases
        aliases = table.query_aliases or []
        normalized_query = feedback.user_query.strip().lower()
        if normalized_query not in [a.lower() for a in aliases]:
            aliases.append(feedback.user_query.strip())
            table.query_aliases = aliases
        
        # Thêm notes nếu có
        if feedback.notes:
            existing = table.auto_description or ""
            if feedback.notes.lower() not in existing.lower():
                table.auto_description = existing + f"\nNote: {feedback.notes}"
        
        table.description_source = "feedback"
        table.description_updated_at = datetime.utcnow()
        
        await re_embed_table(db, table)
    
    elif feedback.correct_resource_type == "chart":
        chart = db.query(Chart).get(feedback.correct_resource_id)
        metadata = chart.metadata or ChartMetadata(chart_id=chart.id)
        
        aliases = metadata.query_aliases or []
        normalized_query = feedback.user_query.strip().lower()
        if normalized_query not in [a.lower() for a in aliases]:
            aliases.append(feedback.user_query.strip())
            metadata.query_aliases = aliases
        
        metadata.description_source = "feedback"
        metadata.description_updated_at = datetime.utcnow()
        
        if not metadata.id:
            db.add(metadata)
        
        await re_embed_chart(db, chart)
    
    # Negative signal cho resource sai (optional, cho ranking)
    if feedback.ai_matched_resource_id:
        negative = NegativeSignal(
            resource_type=feedback.ai_matched_resource_type,
            resource_id=feedback.ai_matched_resource_id,
            query=feedback.user_query
        )
        db.add(negative)
    
    db.commit()
```

### Search Ranking với Feedback Signal

```python
# Trong search:
final_score = (
    0.55 * vector_similarity     # Embedding match
    + 0.20 * popularity_score    # Usage frequency
    + 0.15 * feedback_boost      # Positive feedback cho query tương tự
    + 0.10 * recency_score       # Mới update = ưu tiên hơn
)

# feedback_boost:
#   +0.2 nếu resource này từng là correct_resource cho query tương tự
#   -0.3 nếu resource này từng là ai_matched (sai) cho query tương tự
```

---

## Ví dụ End-to-End

```
Ngày 1 — User tạo table "orders_2024"
  Feature ①: Auto-Describe chạy
  → AI viết: "Order data with amounts and dates. Columns: order_id, amount, region, created_at"
  Feature ⑤: Embed vector V1 được tạo

Ngày 2 — User mở table detail  
  Feature ②: Thấy description panel, đọc lướt, OK đúng rồi → không sửa

Ngày 3 — Source thêm 2 cột mới: "discount", "payment_method"
  Datasource sync → column_stats cập nhật
  Feature ③: schema_hash thay đổi! 
  → Auto-describe lại: "...Columns include discount amount and payment method"
  → column_descriptions thêm 2 cột mới
  Feature ⑤: Re-embed → vector V2

Ngày 5 — User hỏi AI Chat: "show me GMV by region"
  Vector search: "GMV" không match "amount" → AI tìm nhầm marketing_spend
  User click 👎, chọn "Wrong table", chỉ orders_2024
  Feature ④: Feedback ghi nhận
  → query_aliases thêm "GMV by region"
  → auto_description append: "Users refer to amount as GMV"
  Feature ⑤: Re-embed → vector V3

Ngày 6 — User khác hỏi: "what is GMV trend this quarter?"
  Vector search: "GMV" matches orders_2024 (vì V3 chứa "GMV")
  → AI trả đúng!
  User click 👍 → positive signal ghi nhận → boost ranking

Ngày 10 — User mở chart "Revenue by Region"
  Feature ②: Thấy Chart Description panel
  → Thêm keyword: "doanh thu", "doanh số", "sales performance"
  Feature ⑤: Re-embed chart → lần sau search tiếng Việt cũng match
```

---

## Summary: Files & Effort

### Files mới

| File | Feature | Effort |
|------|---------|--------|
| `backend/app/services/auto_describe_service.py` | ① | 2 ngày |
| `backend/app/services/schema_change_service.py` | ③ | 2 ngày |
| `backend/app/services/feedback_processor.py` | ④⑤ | 3 ngày |
| `backend/app/services/re_embed_service.py` | ⑤ | 2 ngày |
| `backend/app/api/feedback.py` | ④ | 1 ngày |
| `frontend/src/components/datasets/TableDescriptionPanel.tsx` | ② | 2 ngày |
| `frontend/src/components/explore/ChartDescriptionPanel.tsx` | ② | 2 ngày |
| `frontend/src/components/ai-chat/FeedbackButtons.tsx` | ④ | 2 ngày |
| `frontend/src/hooks/useDescription.ts` | ② | 1 ngày |

### Files sửa

| File | Changes | Feature |
|------|---------|---------|
| `backend/app/models/dataset_workspace.py` | Thêm column_descriptions, common_questions, query_aliases, description_source, schema_hash, schema_change_pending | ①③ |
| `backend/app/models/models.py` (ChartMetadata) | Thêm auto_description, insight_keywords, common_questions, query_aliases, description_source | ① |
| `backend/app/api/dataset_workspaces.py` | Trigger auto-describe sau create/update table | ① |
| `backend/app/api/charts.py` | Trigger auto-describe chart sau create/update | ① |
| `backend/app/services/table_stats_service.py` | Gọi check_schema_change sau compute_stats | ③ |
| `backend/app/services/embedding_service.py` | Thêm embed_resource() generic method | ⑤ |
| `ai-service/app/routers/chat.py` | Include feedback metadata trong response | ④ |
| `frontend/src/components/ai-chat/ChatMessage.tsx` | Mount FeedbackButtons | ④ |
| `frontend/src/components/datasets/WorkspaceTableDetail.tsx` | Mount TableDescriptionPanel | ② |
| `frontend/src/app/(main)/explore/[id]/page.tsx` | Mount ChartDescriptionPanel | ② |

### Tổng Effort

| Feature | Backend | Frontend | Tổng |
|---------|---------|----------|------|
| ① Auto-Describe (Table + Chart) | 3 ngày | — | 3 ngày |
| ② UI Review (Table + Chart) | 1 ngày (API) | 4 ngày | 5 ngày |
| ③ Schema Change Detection | 2 ngày | 1 ngày (warning UI) | 3 ngày |
| ④ Feedback Capture | 1 ngày | 2 ngày | 3 ngày |
| ⑤ Re-embed Pipeline | 2 ngày | — | 2 ngày |
| **Tổng** | **9 ngày** | **7 ngày** | **~16 ngày** |

### Dependencies

```
Feature ① (Auto-Describe) ← cần Phase 1 column_stats
Feature ② (UI Review)     ← cần Feature ①
Feature ③ (Schema Change)  ← cần Feature ①
Feature ④ (Feedback)       ← không dependency, làm song song được
Feature ⑤ (Re-embed)       ← cần Phase 1 embedding service
```

Suggested order: **① → ⑤ → ② → ③ → ④** (hoặc ④ song song với ②③)
