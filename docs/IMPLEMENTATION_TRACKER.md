# Implementation Tracker — Feedback-Driven Knowledge System

> **Mục đích:** External memory cho AI agent. Đọc file này đầu mỗi session để biết chính xác đang ở đâu, đã làm gì, cần làm gì tiếp.
> **Cập nhật:** Sau mỗi task nhỏ hoàn thành, update checklist tương ứng.
> **Spec gốc:** `docs/AI_AGENT.md` (Section 11: Roadmap)

---

## Trạng thái tổng quan

| Bước | Tên | Trạng thái |
|------|-----|------------|
| 1 | Migrations + Model Changes | ✅ DONE |
| 2 | Upgrade AutoTaggingService | ✅ DONE |
| 3 | Upgrade EmbeddingService | ✅ DONE |
| 4 | SchemaChangeService | ✅ DONE |
| 5 | Description API + Frontend panels | ✅ DONE |
| 6 | Feedback Capture (API + Frontend) | ✅ DONE |
| 7 | Wire + Integration check | ✅ DONE |

**Chú thích:** ❌ PENDING → 🔄 IN PROGRESS → ✅ DONE

---

## Quyết định thiết kế đã chốt

| # | Quyết định | Lý do |
|---|-----------|-------|
| D1 | `ai_feedback.session_id` và `message_id` là `VARCHAR(100)`, **không có FK** | `chat_sessions` không tồn tại dưới dạng DB table — sessions là in-memory dict trong orchestrator |
| D2 | `ai_feedback.ai_matched_resource_id` là `Integer`, nullable | AI service chưa expose resource đã match; field tồn tại nhưng optional |
| D3 | Thứ tự trigger sau `TableStatsService`: `SchemaChange → AutoDescribe → ReEmbed` | Chain này đảm bảo embedding luôn reflect data mới nhất |
| D4 | `description_source` nhận 3 giá trị: `"auto"` \| `"user"` \| `"feedback"` | "auto" = AI tự viết, "user" = user đã sửa tay, "feedback" = enrich từ feedback loop |
| D5 | Chống ghi đè: nếu `description_source in ("user", "feedback")` thì skip auto-describe trừ khi `force=True` | Tôn trọng nội dung user đã chỉnh |

---

## Migration chain

**HEAD hiện tại:** `20260321_ai02`
**down_revision của HEAD:** `20260321_ai01`

### Migration sẽ tạo:

| File | Revision ID | down_revision | Nội dung |
|------|------------|---------------|----------|
| `20260322_0008_add_knowledge_fields.py` | `20260322_fb01` | `20260321_ai02` | Thêm fields vào `dataset_workspace_tables` + `chart_metadata` |
| `20260322_0009_add_ai_feedback_table.py` | `20260322_fb02` | `20260322_fb01` | Tạo bảng `ai_feedback` |

---

## Bước 1 — Migrations + Model Changes

### 1A: Migration `20260322_0008_add_knowledge_fields.py`

**Revision ID:** `20260322_fb01`
**down_revision:** `20260321_ai02`

**Thêm vào bảng `dataset_workspace_tables`:**

| Column | Type | Default | Nullable |
|--------|------|---------|----------|
| `column_descriptions` | JSONB | NULL | YES |
| `common_questions` | JSONB | NULL | YES |
| `query_aliases` | JSONB | NULL | YES |
| `description_source` | VARCHAR(20) | NULL | YES |
| `description_updated_at` | DateTime | NULL | YES |
| `schema_hash` | VARCHAR(64) | NULL | YES |
| `schema_change_pending` | Boolean | False | YES |

**Thêm vào bảng `chart_metadata`:**

| Column | Type | Default | Nullable |
|--------|------|---------|----------|
| `auto_description` | Text | NULL | YES |
| `insight_keywords` | JSONB | NULL | YES |
| `common_questions` | JSONB | NULL | YES |
| `query_aliases` | JSONB | NULL | YES |
| `description_source` | VARCHAR(20) | NULL | YES |
| `description_updated_at` | DateTime | NULL | YES |

### 1B: Migration `20260322_0009_add_ai_feedback_table.py`

**Revision ID:** `20260322_fb02`
**down_revision:** `20260322_fb01`

**Tạo bảng `ai_feedback`:**

| Column | Type | Constraint |
|--------|------|-----------|
| `id` | UUID | PK, default gen_random_uuid() |
| `session_id` | VARCHAR(100) | nullable — in-memory session ID, **no FK** |
| `message_id` | VARCHAR(100) | nullable — in-memory message ID, **no FK** |
| `user_id` | UUID | FK → users.id ON DELETE CASCADE, NOT NULL |
| `user_query` | Text | NOT NULL |
| `ai_matched_resource_type` | VARCHAR(50) | nullable |
| `ai_matched_resource_id` | Integer | nullable |
| `feedback_type` | VARCHAR(30) | NOT NULL — `wrong_table`\|`wrong_chart`\|`unclear`\|`other` |
| `correct_resource_type` | VARCHAR(50) | nullable — `chart`\|`workspace_table` |
| `correct_resource_id` | Integer | nullable |
| `notes` | Text | nullable |
| `is_positive` | Boolean | default False |
| `created_at` | TIMESTAMP | default NOW() |

**Indexes:** `(correct_resource_type, correct_resource_id)`, `(user_id)`, `(created_at DESC)`

### 1C: Sửa SQLAlchemy models

**`backend/app/models/dataset_workspace.py`** — thêm vào class `DatasetWorkspaceTable`:
```python
# Knowledge system fields (Feedback-Driven Knowledge System)
column_descriptions = Column(JSONB, nullable=True, default=None)
common_questions = Column(JSONB, nullable=True, default=None)
query_aliases = Column(JSONB, nullable=True, default=None)
description_source = Column(String(20), nullable=True, default=None)  # "auto"|"user"|"feedback"
description_updated_at = Column(DateTime, nullable=True, default=None)
schema_hash = Column(String(64), nullable=True, default=None)
schema_change_pending = Column(Boolean, nullable=True, default=False)
```

**`backend/app/models/models.py`** — thêm vào class `ChartMetadata` (sau field `tags`):
```python
# Knowledge system fields
auto_description = Column(Text, nullable=True, default=None)
insight_keywords = Column(JSON, nullable=True, default=None)
common_questions = Column(JSON, nullable=True, default=None)
query_aliases = Column(JSON, nullable=True, default=None)
description_source = Column(String(20), nullable=True, default=None)  # "auto"|"user"|"feedback"
description_updated_at = Column(DateTime(timezone=True), nullable=True, default=None)
```

**Tạo mới `backend/app/models/ai_feedback.py`**

### Checklist Bước 1:

- [ ] Tạo `backend/alembic/versions/20260322_0008_add_knowledge_fields.py`
- [ ] Tạo `backend/alembic/versions/20260322_0009_add_ai_feedback_table.py`
- [ ] Sửa `backend/app/models/dataset_workspace.py`
- [ ] Sửa `backend/app/models/models.py` (ChartMetadata)
- [ ] Tạo `backend/app/models/ai_feedback.py`
- [ ] Chạy `alembic upgrade head` và verify không lỗi

---

## Bước 2 — Upgrade AutoTaggingService

**File sửa:** `backend/app/services/auto_tagging_service.py`

### 2A: Upgrade `describe_table()`

**Prompt mới** (thay thế prompt cũ) — gửi:
- `table.display_name`
- `datasource.name` + `datasource.type`
- `table.source_query` hoặc "physical table"
- `table.column_stats` — mỗi cột: name, dtype, cardinality, samples[:3]
- Sample rows từ DuckDB (5 rows, nếu có)

**Output JSON mong đợi:**
```json
{
  "description": "2-3 câu mô tả business",
  "column_descriptions": {"col_name": "1 câu mô tả"},
  "common_questions": ["câu hỏi 1", "câu hỏi 2", "câu hỏi 3"]
}
```

**Logic sau khi nhận kết quả:**
```python
# Ghi các fields mới
table.auto_description = result["description"]
table.column_descriptions = result.get("column_descriptions", {})
table.common_questions = result.get("common_questions", [])
table.description_source = "auto"
table.description_updated_at = datetime.utcnow()
```

**Guard chống ghi đè:**
```python
if not force and table.description_source in ("user", "feedback"):
    return False  # skip
```

### 2B: Upgrade `tag_chart()`

**Output JSON mới** (mở rộng, giữ tương thích ngược):
```json
{
  "domain": "...",
  "intent": "...",
  "metrics": [...],
  "dimensions": [...],
  "tags": [...],
  "auto_description": "2-3 câu mô tả chart",
  "insight_keywords": ["keyword1", ...],
  "common_questions": ["question1", ...]
}
```

**Logic lưu vào ChartMetadata:**
- Các fields cũ (domain/intent/metrics/dimensions/tags): giữ nguyên logic
- Fields mới: lưu với guard `description_source`

### Checklist Bước 2:

- [ ] Upgrade `describe_table()` — prompt mới + 3 output fields
- [ ] Thêm `force` param + guard chống ghi đè vào `describe_table()`
- [ ] Upgrade `tag_chart()` — thêm auto_description, insight_keywords, common_questions vào output
- [ ] Thêm guard chống ghi đè vào `tag_chart()`
- [ ] Test: tạo 1 table mới → verify `column_descriptions` và `common_questions` được populate

---

## Bước 3 — Upgrade EmbeddingService

**File sửa:** `backend/app/services/embedding_service.py`

### 3A: Upgrade `build_table_text()`

**Text mới** (thứ tự ưu tiên — phần đầu quan trọng nhất cho embedding):
```
Table: {display_name}
Description: {auto_description}
{foreach col in column_descriptions}: Column {col}: {desc}
Columns: {col} ({dtype}), ... (từ column_stats)
Also known as: {query_aliases joined by ", "}
Common questions: {common_questions joined by "; "}
```

### 3B: Upgrade `build_chart_text()`

**Text mới:**
```
Chart: {name} ({chart_type})
{auto_description từ ChartMetadata nếu có}
Domain: {domain}  Intent: {intent}
Metrics: {metrics}  Dimensions: {dimensions}
Tags: {tags}
Keywords: {insight_keywords joined by ", "}
Also searched as: {query_aliases joined by ", "}
X-axis: {config.dimensions}  Y-axis: {config.metrics}
Source table: {table.display_name} — {table.auto_description[:150]}
```

### Checklist Bước 3:

- [ ] Upgrade `build_table_text()` — gộp column_descriptions, query_aliases, common_questions
- [ ] Upgrade `build_chart_text()` — gộp auto_description, insight_keywords, query_aliases từ ChartMetadata
- [ ] Verify existing `embed_table()` và `embed_chart()` tự động dùng text mới (chúng gọi build_*_text)

---

## Bước 4 — SchemaChangeService

**File mới:** `backend/app/services/schema_change_service.py`

### Logic:

```python
def compute_schema_hash(column_stats: dict) -> str:
    # SHA256 của sorted ["col:dtype", ...]

def check_and_handle_schema_change(db, table, new_column_stats: dict) -> dict:
    new_hash = compute_schema_hash(new_column_stats)
    if table.schema_hash and table.schema_hash != new_hash:
        # Schema đã thay đổi
        added = new_cols - old_cols
        removed = old_cols - new_cols
        table.column_stats = new_column_stats
        table.schema_hash = new_hash
        if table.description_source == "user":
            table.schema_change_pending = True
            # Chỉ describe các cột mới thêm (partial update)
        else:
            # Auto hoặc feedback → regenerate toàn bộ (force=True)
            AutoTaggingService.describe_table(db, table.id, force=True)
        EmbeddingService.embed_table(db, table.id)
        db.commit()
        return {"changed": True, "added": list(added), "removed": list(removed)}
    if not table.schema_hash:
        table.schema_hash = new_hash
        db.commit()
    return {"changed": False}
```

**Sửa `table_stats_service.py`** — cuối `update_table_stats()`, sau `db.commit()`, gọi:
```python
from app.services.schema_change_service import check_and_handle_schema_change
check_and_handle_schema_change(db, table, stats)
```

**Thêm vào `services/__init__.py`:**
```python
from app.services.schema_change_service import SchemaChangeService
```

### Checklist Bước 4:

- [ ] Tạo `backend/app/services/schema_change_service.py`
- [ ] Sửa `table_stats_service.py` — gọi schema change check sau compute
- [ ] Sửa `backend/app/services/__init__.py` — export `SchemaChangeService`
- [ ] Test: tạo table, verify schema_hash được set; mô phỏng schema change, verify re-describe trigger

---

## Bước 5 — Description API + Frontend

### 5A: Backend API — Dataset Workspaces

**Sửa `backend/app/api/dataset_workspaces.py`** — thêm 3 endpoints:

```
GET  /dataset-workspaces/{id}/tables/{table_id}/description
     → trả: {auto_description, column_descriptions, common_questions, query_aliases,
              description_source, description_updated_at, schema_change_pending}

PUT  /dataset-workspaces/{id}/tables/{table_id}/description
     body: {auto_description?, column_descriptions?, common_questions?, query_aliases?}
     → set description_source="user", description_updated_at=now()
     → BackgroundTask: EmbeddingService.embed_table()
     → trả updated description object

POST /dataset-workspaces/{id}/tables/{table_id}/description/regenerate
     → BackgroundTask: AutoTaggingService.describe_table(force=True) + embed_table()
     → trả: {"status": "regenerating"}
```

### 5B: Backend API — Charts

**Sửa `backend/app/api/charts.py`** — thêm 3 endpoints tương tự:

```
GET  /charts/{id}/description
     → trả: {auto_description, insight_keywords, common_questions, query_aliases,
              description_source, description_updated_at} từ ChartMetadata

PUT  /charts/{id}/description
     → set description_source="user", re-embed

POST /charts/{id}/description/regenerate
     → AutoTaggingService.tag_chart(force=True) + embed_chart()
```

### 5C: Frontend

**Tạo mới `frontend/src/hooks/useDescription.ts`:**
- `useTableDescription(workspaceId, tableId)` — GET + PUT + regen
- `useChartDescription(chartId)` — GET + PUT + regen

**Tạo mới `frontend/src/components/datasets/TableDescriptionPanel.tsx`:**
- View mode: description text, column descriptions table, common_questions chips, badge (Auto-generated / ✏️ Edited / 🔄 From feedback), `[Edit]` + `[🔄 Regen]` buttons
- Edit mode: textarea description, inline edit column descriptions, add/remove common_questions
- Nếu `schema_change_pending = true`: hiện warning banner với diff (added/removed cols)

**Tạo mới `frontend/src/components/explore/ChartDescriptionPanel.tsx`:**
- Tương tự table panel, thêm `insight_keywords` section (tags có thể thêm/xóa)

**Mount:**
- `frontend/src/app/(main)/dataset-workspaces/[id]/page.tsx` — đọc file trước khi mount
- `frontend/src/app/(main)/explore/[id]/page.tsx` — đọc file trước khi mount

### Checklist Bước 5:

- [ ] Thêm GET description endpoint — dataset_workspaces.py
- [ ] Thêm PUT description endpoint — dataset_workspaces.py
- [ ] Thêm POST regenerate endpoint — dataset_workspaces.py
- [ ] Thêm GET description endpoint — charts.py
- [ ] Thêm PUT description endpoint — charts.py
- [ ] Thêm POST regenerate endpoint — charts.py
- [ ] Tạo `useDescription.ts`
- [ ] Tạo `TableDescriptionPanel.tsx`
- [ ] Tạo `ChartDescriptionPanel.tsx`
- [ ] Đọc `dataset-workspaces/[id]/page.tsx` → mount `TableDescriptionPanel`
- [ ] Đọc `explore/[id]/page.tsx` → mount `ChartDescriptionPanel`

---

## Bước 6 — Feedback Capture

### 6A: Model

**Tạo mới `backend/app/models/ai_feedback.py`** — class `AIFeedback` (schema đã định nghĩa ở Bước 1B)

**Sửa `backend/app/models/__init__.py`** — export `AIFeedback`

### 6B: FeedbackProcessor Service

**Tạo mới `backend/app/services/feedback_processor.py`:**

```python
def process_feedback(feedback: AIFeedback, db: Session):
    if not feedback.correct_resource_id:
        return
    if feedback.correct_resource_type == "workspace_table":
        # Thêm user_query vào query_aliases
        # Append notes vào auto_description
        # set description_source = "feedback"
        # EmbeddingService.embed_table(db, table_id)
    elif feedback.correct_resource_type == "chart":
        # Thêm user_query vào ChartMetadata.query_aliases
        # set description_source = "feedback"
        # EmbeddingService.embed_chart(db, chart_id)
    db.commit()
```

**Sửa `backend/app/services/__init__.py`** — export `FeedbackProcessor`

### 6C: Backend API

**Tạo mới `backend/app/api/feedback.py`:**

```
POST /ai/feedback
     body: {session_id?, message_id?, user_query, feedback_type,
             correct_resource_type?, correct_resource_id?, notes?,
             ai_matched_resource_type?, ai_matched_resource_id?, is_positive}
     → save AIFeedback
     → BackgroundTask: process_feedback()
     → return {"status": "ok", "feedback_id": "..."}

GET /ai/feedback/stats   (require admin)
     → {total, positive_count, negative_count, top_corrected_tables: [...]}
```

**Sửa `backend/app/api/__init__.py`** — import và register `feedback.router`

### 6D: Frontend

**Sửa `frontend/src/components/ai-chat/ChatMessage.tsx`:**
- Nút 👎 hiện tại gọi `onFeedback(id, messageId, 'down')` — giữ nguyên 👍
- Thêm nút `💬 Correct this` bên cạnh 👎, khi click mở `FeedbackModal`

**Tạo mới `frontend/src/components/ai-chat/FeedbackModal.tsx`:**
- State: `feedbackType` (radio), `correctResourceType`, `correctResourceId`, `notes`
- Radio group: "Used wrong table" / "Used wrong chart" / "Answer unclear" / "Other"
- Search input lọc charts và workspace tables
- Checkbox list hiện kết quả search
- Notes textarea (optional)
- Submit → `POST /api/v1/ai/feedback`
- Dùng `user_query` = câu hỏi user vừa hỏi (lấy từ message context)

**Sửa `frontend/src/components/ai-chat/ChatPanel.tsx`:**
- Truyền `userQuery` (nội dung message user) vào `ChatMessage` để `FeedbackModal` dùng
- Handler mới `handleDetailedFeedback` gọi API feedback

### Checklist Bước 6:

- [ ] Tạo `backend/app/models/ai_feedback.py`
- [ ] Sửa `backend/app/models/__init__.py`
- [ ] Tạo `backend/app/services/feedback_processor.py`
- [ ] Sửa `backend/app/services/__init__.py`
- [ ] Tạo `backend/app/api/feedback.py`
- [ ] Sửa `backend/app/api/__init__.py` — register router
- [ ] Sửa `ChatMessage.tsx` — thêm "Correct this" button
- [ ] Tạo `FeedbackModal.tsx`
- [ ] Sửa `ChatPanel.tsx` — pass userQuery + handler mới

---

## Bước 7 — Wire + Integration Check

### Checklist cuối:

- [ ] Verify chain BackgroundTasks: table create → TableStats → SchemaChange → AutoDescribe → ReEmbed
- [ ] Verify chain BackgroundTasks: chart create → AutoTag → Embed
- [ ] Verify description_source guard: tạo table, auto-describe → sửa tay → trigger regen → KHÔNG ghi đè
- [ ] Verify schema change: thêm computed column → schema_hash đổi → auto-describe lại
- [ ] Verify feedback loop: submit feedback chỉ đúng resource → query_aliases được thêm → embed lại → search lần sau match đúng
- [ ] Verify `schema_change_pending` UI warning hiển thị đúng
- [ ] Verify description badge đúng (Auto / Edited / From feedback)
- [ ] Run `alembic upgrade head` sạch từ fresh DB

---

## Files tạo mới (toàn bộ)

### Backend
| File | Bước |
|------|------|
| `backend/alembic/versions/20260322_0008_add_knowledge_fields.py` | 1 |
| `backend/alembic/versions/20260322_0009_add_ai_feedback_table.py` | 1 |
| `backend/app/models/ai_feedback.py` | 1 / 6 |
| `backend/app/services/schema_change_service.py` | 4 |
| `backend/app/services/feedback_processor.py` | 6 |
| `backend/app/api/feedback.py` | 6 |

### Frontend
| File | Bước |
|------|------|
| `frontend/src/hooks/useDescription.ts` | 5 |
| `frontend/src/components/datasets/TableDescriptionPanel.tsx` | 5 |
| `frontend/src/components/explore/ChartDescriptionPanel.tsx` | 5 |
| `frontend/src/components/ai-chat/FeedbackModal.tsx` | 6 |

---

## Files sửa (toàn bộ)

### Backend
| File | Thay đổi | Bước |
|------|----------|------|
| `backend/app/models/dataset_workspace.py` | Thêm 7 fields vào DatasetWorkspaceTable | 1 |
| `backend/app/models/models.py` | Thêm 6 fields vào ChartMetadata | 1 |
| `backend/app/models/__init__.py` | Export AIFeedback | 6 |
| `backend/app/services/auto_tagging_service.py` | Richer prompts, force param, guard | 2 |
| `backend/app/services/embedding_service.py` | Richer text builders | 3 |
| `backend/app/services/table_stats_service.py` | Gọi schema change check | 4 |
| `backend/app/services/__init__.py` | Export SchemaChangeService, FeedbackProcessor | 4 / 6 |
| `backend/app/api/dataset_workspaces.py` | 3 description endpoints | 5 |
| `backend/app/api/charts.py` | 3 description endpoints | 5 |
| `backend/app/api/__init__.py` | Register feedback router | 6 |

### Frontend
| File | Thay đổi | Bước |
|------|----------|------|
| `frontend/src/app/(main)/dataset-workspaces/[id]/page.tsx` | Mount TableDescriptionPanel | 5 |
| `frontend/src/app/(main)/explore/[id]/page.tsx` | Mount ChartDescriptionPanel | 5 |
| `frontend/src/components/ai-chat/ChatMessage.tsx` | Thêm "Correct this" button | 6 |
| `frontend/src/components/ai-chat/ChatPanel.tsx` | Pass userQuery, handler mới | 6 |

---

## Notes quan trọng khi code

1. **`DatasetWorkspaceTable` không có relationship sang `DataSource` trong model** — khi cần lấy datasource trong services phải query riêng qua `table.datasource_id`
2. **`LLMClient` là sync** (httpx sync) — dùng trong BackgroundTasks là OK, **không** dùng trong async request handler trực tiếp
3. **`EmbeddingService` là sync** — pattern hiện tại là `background_tasks.add_task(EmbeddingService.embed_table, db, table_id)` — giữ đúng pattern này
4. **`ChartMetadata` có relationship tên `chart_meta`** (không phải `metadata`) — `chart.chart_meta` trong code
5. **Migration JSONB vs JSON**: `DatasetWorkspaceTable` dùng `JSONB`, `ChartMetadata` dùng `JSON` — giữ nhất quán
6. **`columns_cache` format** có thể là list hoặc dict — luôn dùng helper `_extract_col_names()` trong EmbeddingService
7. **Frontend API base URL** — dùng `lib/api/` client có sẵn, không gọi fetch trực tiếp
