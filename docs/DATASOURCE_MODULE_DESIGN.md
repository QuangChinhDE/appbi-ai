# Thiết kế Module Datasource — AppBI v2

> **Phạm vi:** Toàn bộ module Source, bao gồm Connection Management, Sync Engine, Storage Layer (DuckDB + Parquet) và tích hợp với Chart / Dashboard / AI Agent.
>
> **Trạng thái hiện tại:** Draft thiết kế — chưa implement
>
> **Ngày:** 19/03/2026
>
> **Cập nhật:** 19/03/2026 — Revision 2: Sửa 5 vấn đề thiết kế (DuckDB concurrency, sync_config placement, APScheduler multi-worker, Fernet backward compat, DuckDB query validation)

---

## Mục lục

1. [Tổng quan kiến trúc](#1-tổng-quan-kiến-trúc)
2. [Vấn đề hiện tại](#2-vấn-đề-hiện-tại)
3. [Data Model mới](#3-data-model-mới)
4. [Connection Management](#4-connection-management)
5. [Sync Engine](#5-sync-engine)
6. [Storage Layer: DuckDB + Parquet](#6-storage-layer-duckdb--parquet)
7. [Query Engine](#7-query-engine)
8. [API Endpoints mới](#8-api-endpoints-mới)
9. [Frontend UI/UX](#9-frontend-uiux)
10. [Bảo mật](#10-bảo-mật)
11. [Lộ trình implement](#11-lộ-trình-implement)
12. [Quyết định thiết kế & Constraints đã biết](#12-quyết-định-thiết-kế--constraints-đã-biết)

---

## 1. Tổng quan kiến trúc

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           DATA SOURCES                                   │
│   PostgreSQL │ MySQL │ BigQuery │ Google Sheets │ CSV/Excel (Manual)     │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                ┌──────────────▼──────────────┐
                │      CONNECTION LAYER        │
                │  • Test connection           │
                │  • Schema browser            │
                │  • Table/column discovery    │
                │  • SSL / SSH tunnel config   │
                └──────────────┬──────────────┘
                               │
                ┌──────────────▼──────────────┐
                │       SYNC SCHEDULER         │
                │  APScheduler (in-process)    │
                │  • CRON / INTERVAL / MANUAL  │
                │  • Job registry từ DB        │
                │  • Retry + backoff           │
                │  • Concurrency lock          │
                └──────────────┬──────────────┘
                               │  Pull (streaming 10k/batch)
                ┌──────────────▼──────────────┐
                │      INGESTION ENGINE        │
                │  • FULL_REFRESH              │
                │  • INCREMENTAL (watermark)   │
                │  • APPEND_ONLY               │
                │  Apply transformations       │
                │  Arrow batch → Parquet       │
                └──────────────┬──────────────┘
                               │
                ┌──────────────▼──────────────────────────────┐
                │              STORAGE LAYER                   │
                │                                              │
                │  /data/datasets/{id}/data.parquet            │
                │  /data/datasets/{id}/delta/*.parquet         │
                │  duckdb.duckdb  ← persistent catalog         │
                └──────────────┬──────────────────────────────┘
                               │
                ┌──────────────▼──────────────┐
                │       QUERY ENGINE           │
                │  DuckDB (columnar, in-proc)  │
                │  Aggregation pushdown        │
                │  Connection pool             │
                └──────┬────────┬─────────────┘
                       │        │         │
                   Charts   AI Agent   Explore
```

---

## 2. Vấn đề hiện tại

### 2.1 Bottleneck hiệu năng

| # | Vấn đề | Code hiện tại | Impact |
|---|---|---|---|
| P1 | **No connection pool** | `psycopg2.connect()` mới mỗi query | TCP handshake + auth overhead mỗi chart load |
| P2 | **fetchall() load toàn bộ RAM** | `rows = cursor.fetchall()` | 1M rows × 10 cols ≈ 500MB RAM/query |
| P3 | **SELECT * không aggregate** | `SELECT * FROM table LIMIT 1000` | Frontend nhận raw rows, không push agg xuống DB |
| P4 | **File CSV lưu trong PostgreSQL JSON** | `config = {"rows": [...all rows...]}` | 50MB CSV → 100MB+ JSON blob, deserialize mỗi lần |
| P5 | **DuckDB `:memory:` tạo/hủy mỗi request** | `duckdb.connect(":memory:")` per query | Re-ingest toàn bộ DataFrame mỗi lần |
| P6 | **Không có schedule, chỉ manual** | Không có APScheduler/Celery | User phải bấm refresh thủ công |
| P7 | **AI N+1 HTTP calls** | `gather(*[get_chart_metadata(id) for c])` | 200 charts = 200 HTTP round-trips per search |

### 2.2 Lỗ hổng bảo mật

| # | Vấn đề | Code hiện tại | OWASP |
|---|---|---|---|
| S1 | **SQL Injection trong workspace execute** | `f"{field} LIKE '%{value}%'"` — user input vào SQL trực tiếp | A03 Injection |
| S2 | **Credential lưu plaintext JSON** | `config = {"password": "abc123"}` không mã hóa | A02 Cryptographic Failures |

---

## 3. Data Model mới

### 3.1 Model `DataSource` — KHÔNG thêm `sync_config`

> **Quyết định thiết kế:** `sync_config` chỉ đặt ở **Dataset level**, không đặt ở DataSource level.
>
> **Lý do:** Nếu đặt ở cả hai nơi, cần định nghĩa logic merge/override (DataSource cron "0 2 * * *" vs Dataset override interval 3600 — cái nào thắng?), gây confusion cho dev và user. Dataset-level cho phép mỗi dataset tự quản lý schedule độc lập, linh hoạt hơn và không có ambiguity.

```python
class DataSource(Base):
    __tablename__ = "data_sources"

    id            = Column(Integer, primary_key=True)
    name          = Column(String(255), unique=True, nullable=False)
    type          = Column(Enum(DataSourceType), nullable=False)
    description   = Column(Text, nullable=True)
    config        = Column(JSON, nullable=False)        # connection credentials (encrypted)
    # sync_config KHÔNG có ở DataSource — xem Dataset.sync_config
    created_at    = Column(DateTime(timezone=True), ...)
    updated_at    = Column(DateTime(timezone=True), ...)
```

**Cấu trúc `sync_config`:**

```json
{
  "mode": "full_refresh",
  "schedule": {
    "type": "cron",
    "cron": "0 2 * * *",
    "interval_seconds": null,
    "timezone": "Asia/Ho_Chi_Minh",
    "enabled": true
  },
  "incremental": {
    "watermark_column": "updated_at",
    "watermark_type": "timestamp",
    "last_value": "2026-03-19T02:05:12",
    "lookback_minutes": 60
  },
  "retry": {
    "max_attempts": 3,
    "backoff_seconds": 300
  },
  "notify": {
    "on_failure": true,
    "webhook_url": null
  }
}
```

**`sync_config.mode` options:**

| Mode | Mô tả | Khi nào dùng |
|---|---|---|
| `full_refresh` | Truncate + re-pull toàn bộ | < 5M rows, không có watermark |
| `incremental` | Pull WHERE watermark > last_value, UPSERT | > 5M rows, có updated_at |
| `append_only` | Pull rows mới, không update rows cũ | Log/event table, immutable data |
| `manual` | Chỉ chạy khi user trigger | Static file, lookup table |

### 3.2 Model `Dataset` — Thêm `sync_config` (Dataset là nơi duy nhất)

```python
class Dataset(Base):
    __tablename__ = "datasets"

    # ... existing fields ...
    materialization = Column(JSON, nullable=True)   # cấu trúc mở rộng bên dưới
    sync_config     = Column(JSON, nullable=True)   # ← MỚI: sync schedule + mode, chỉ ở đây
```

> **Lưu ý:** `sync_config` chỉ tồn tại ở Dataset, không ở DataSource. Một DataSource có thể có nhiều Datasets — mỗi dataset có lịch sync riêng (VD: `orders` sync mỗi giờ, `customers` sync mỗi ngày). Đây là điểm khác biệt với cách đặt ở DataSource level.

**Cấu trúc `materialization` mới:**

```json
{
  "mode": "parquet",
  "storage_path": "datasets/42/data.parquet",
  "row_count": 1420000,
  "size_bytes": 18500000,
  "last_refreshed_at": "2026-03-19T02:05:12",
  "last_duration_seconds": 47,
  "status": "idle",
  "error": null,
  "columns_schema": [
    {"name": "order_id",    "type": "INTEGER",   "nullable": false},
    {"name": "amount",      "type": "DOUBLE",    "nullable": true},
    {"name": "created_at",  "type": "TIMESTAMP", "nullable": false}
  ],
  "incremental_watermark": "2026-03-19T02:05:12"
}
```

**`materialization.status` lifecycle:**

```
IDLE → RUNNING → SUCCESS (→ IDLE)
             → FAILED  (retry → RUNNING hoặc → IDLE nếu hết retry)
```

### 3.3 Alembic Migration cần tạo

```python
# Migration: add_sync_config_to_datasets_and_job_runs
def upgrade():
    # CHỈ thêm vào datasets, không thêm vào data_sources
    op.add_column('datasets',
        sa.Column('sync_config', sa.JSON(), nullable=True))
    
    # Bổ sung bảng sync_job_runs để lưu lịch sử
    op.create_table('sync_job_runs',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('dataset_id', sa.Integer(), sa.ForeignKey('datasets.id'), nullable=False),
        sa.Column('triggered_by', sa.String(50)),   # scheduler | manual | api
        sa.Column('mode', sa.String(50)),            # full_refresh | incremental | append_only
        sa.Column('status', sa.String(20)),          # running | success | failed
        sa.Column('rows_pulled', sa.Integer()),
        sa.Column('duration_seconds', sa.Float()),
        sa.Column('error', sa.Text()),
        sa.Column('started_at', sa.DateTime(timezone=True)),
        sa.Column('finished_at', sa.DateTime(timezone=True)),
    )
```

---

## 4. Connection Management

### 4.1 Config theo từng loại datasource

**PostgreSQL:**
```json
{
  "host": "db.example.com",
  "port": 5432,
  "database": "mydb",
  "username": "readonly_user",
  "password": "****",
  "schema": "public",
  "ssl_mode": "require",
  "connection_timeout": 10,
  "query_timeout": 30
}
```

**MySQL:**
```json
{
  "host": "db.example.com",
  "port": 3306,
  "database": "mydb",
  "username": "readonly_user",
  "password": "****",
  "charset": "utf8mb4",
  "ssl_ca": null,
  "connection_timeout": 10
}
```

**BigQuery:**
```json
{
  "project_id": "my-gcp-project",
  "dataset": "analytics",
  "credentials_json": "{\"type\":\"service_account\",...}",
  "location": "US"
}
```

**Google Sheets:**
```json
{
  "spreadsheet_id": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
  "credentials_json": "{\"type\":\"service_account\",...}",
  "range": "Sheet1!A:Z",
  "has_header": true
}
```

**Manual (CSV/Excel):**
```json
{
  "filename": "orders_2026.xlsx",
  "file_id": "uuid-ref-to-stored-parquet",
  "sheets": ["orders", "returns"],
  "uploaded_at": "2026-03-19T10:00:00"
}
```
> Lưu ý: **Không lưu rows trong config nữa**. Sau khi upload → chuyển ngay sang Parquet, config chỉ lưu reference.

### 4.2 Schema/Table Browser (tính năng mới)

```
GET /datasources/{id}/schemas
→ ["public", "analytics", "reporting"]

GET /datasources/{id}/schemas/{schema}/tables
→ [
    {"name": "orders",    "type": "table", "row_count": 1420000},
    {"name": "v_summary", "type": "view",  "row_count": null}
  ]

GET /datasources/{id}/schemas/{schema}/tables/{table}/columns
→ [
    {"name": "order_id",  "type": "integer",   "nullable": false, "is_pk": true},
    {"name": "amount",    "type": "numeric",   "nullable": true,  "is_pk": false},
    {"name": "created_at","type": "timestamp", "nullable": false, "is_pk": false}
  ]
```

### 4.3 Connection Pool

Thay vì `psycopg2.connect()` mới mỗi request, dùng pool per datasource:

```python
# core/connection_pool.py
from psycopg2 import pool as pg_pool

_pools: Dict[int, pg_pool.ThreadedConnectionPool] = {}

def get_pool(datasource_id: int, config: dict) -> pg_pool.ThreadedConnectionPool:
    if datasource_id not in _pools:
        _pools[datasource_id] = pg_pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=5,
            host=config["host"],
            port=config.get("port", 5432),
            database=config["database"],
            user=config["username"],
            password=config["password"],
        )
    return _pools[datasource_id]
```

---

## 5. Sync Engine

### 5.1 APScheduler tích hợp FastAPI

```python
# main.py — lifespan hook
from contextlib import asynccontextmanager
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from app.services.sync_scheduler import SyncScheduler

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    scheduler = AsyncIOScheduler(timezone="UTC")
    await SyncScheduler.register_all_jobs(scheduler, db=next(get_db()))
    scheduler.start()
    yield
    # Shutdown
    scheduler.shutdown(wait=False)

app = FastAPI(lifespan=lifespan)
```

### 5.2 SyncScheduler — Job Registry

> **⚠ Constraint đã biết — APScheduler in-process + multiple workers:**
> APScheduler chạy in-process (trong FastAPI) hoạt động tốt với **single worker**. Nếu backend scale lên `uvicorn --workers 4`, mỗi worker tạo scheduler riêng và **một job có thể chạy 4 lần đồng thời** gây duplicate sync, data corruption.
>
> **Giới hạn:** Thiết kế này chỉ hỗ trợ **single-worker deployment**. Ghi rõ trong `.env` và Docker config: `API_WORKERS=1`.
>
> **Khi cần scale:** Chuyển sang APScheduler với `jobstore=SQLAlchemyJobStore(url=DATABASE_URL)` (dùng DB advisory lock để đảm bảo chỉ 1 worker chạy mỗi job), hoặc tách scheduler thành process riêng (Celery Beat / standalone APScheduler process).

```python
# services/sync_scheduler.py

class SyncScheduler:
    
    @staticmethod
    async def register_all_jobs(scheduler, db: Session):
        """Đọc tất cả datasets có sync_config.schedule.enabled = true → đăng ký job."""
        datasets = db.query(Dataset).filter(
            Dataset.sync_config.isnot(None)
        ).all()
        
        for dataset in datasets:
            sc = dataset.sync_config or {}
            schedule = sc.get("schedule", {})
            if not schedule.get("enabled", False):
                continue
            SyncScheduler.register_job(scheduler, dataset)
    
    @staticmethod
    def register_job(scheduler, dataset: Dataset):
        sc = dataset.sync_config
        schedule = sc["schedule"]
        tz = schedule.get("timezone", "UTC")
        
        if schedule["type"] == "cron":
            trigger = CronTrigger.from_crontab(schedule["cron"], timezone=tz)
        elif schedule["type"] == "interval":
            trigger = IntervalTrigger(seconds=schedule["interval_seconds"])
        else:
            return  # manual — không đăng ký auto job
        
        scheduler.add_job(
            func=run_sync_job,
            trigger=trigger,
            id=f"sync_dataset_{dataset.id}",
            args=[dataset.id],
            max_instances=1,        # không cho job trùng lặp
            misfire_grace_time=300, # nếu miss 5 phút thì vẫn chạy
            replace_existing=True
        )
```

### 5.3 Ba chế độ Sync

#### FULL_REFRESH

```
Luồng:
  1. Tạo record sync_job_runs (status=running)
  2. Chạy dataset.sql_query với streaming (fetchmany 10k)
  3. Apply transformations → Arrow batch
  4. Write /data/datasets/{id}/data.parquet (overwrite)
  5. Cập nhật materialization: {row_count, size, last_refreshed_at}
  6. DuckDB: CREATE OR REPLACE VIEW dataset_{id} AS
             SELECT * FROM read_parquet('{path}')
  7. Cập nhật sync_job_runs (status=success)

Khi nào dùng:
  - Lần đầu tiên sync bất kỳ dataset
  - Dataset có mode = full_refresh
  - User bấm "Force full refresh"
```

#### INCREMENTAL

```
Luồng:
  1. Lấy last_value từ materialization.incremental_watermark
  2. Inject vào SQL: SELECT * FROM orders 
                     WHERE updated_at > '{last_value - lookback_minutes}'
  3. Pull theo batch khi streaming
  4. Merge vào data.parquet:
       a. Load existing Parquet vào DuckDB temp table
       b. UPSERT: INSERT OR REPLACE BY primary_key từ batch mới
       c. Ghi lại Parquet mới
  5. Cập nhật watermark = MAX(watermark_column) của batch vừa pull
  6. Cập nhật row_count, size, last_refreshed_at

Điều kiện:
  - Dataset phải có watermark_column (VD: updated_at)
  - Source phải hỗ trợ WHERE clause trên cột đó
  - Nếu không tìm thấy rows mới → skip, không ghi file
```

#### APPEND_ONLY

```
Luồng:
  1. Lấy last_value (MAX của cursor_column)
  2. Pull WHERE cursor_column > last_value
  3. Write delta file: /data/datasets/{id}/delta/{timestamp}.parquet
  4. DuckDB VIEW sẽ UNION all delta files + base file:
       CREATE OR REPLACE VIEW dataset_{id} AS
       SELECT * FROM read_parquet([
         'datasets/{id}/data.parquet',
         'datasets/{id}/delta/*.parquet'
       ])
  5. Định kỳ compact: merge tất cả delta vào data.parquet (VD: hàng tuần)

Ưu điểm: không cần rewrite file lớn, append nhanh
```

### 5.4 Retry & Error Handling

```
Attempt 1 fails → wait 5 min  → Attempt 2
Attempt 2 fails → wait 15 min → Attempt 3
Attempt 3 fails → status = "failed", ghi error, gửi notification

Trong khi retry:
  - Dataset vẫn serve data từ Parquet cũ (stale nhưng available)
  - UI hiển thị badge cảnh báo: "⚠ Last sync failed 2h ago"

Concurrency:
  - max_instances=1: nếu job T đang chạy, job T+1 bị miss/skip
  - Lock file: /data/datasets/{id}/.lock để tránh race condition
    giữa scheduled job và manual trigger
```

### 5.5 Sync Job History

Bảng `sync_job_runs` lưu lịch sử để:
- Hiển thị "Run history" trong UI
- Debug khi sync fail
- Tính toán average duration để estimate ETA

```
GET /datasets/{id}/sync/history
→ [
    {
      "id": 42,
      "triggered_by": "scheduler",
      "mode": "incremental",
      "status": "success",
      "rows_pulled": 15420,
      "duration_seconds": 12.4,
      "started_at": "2026-03-19T02:00:01",
      "finished_at": "2026-03-19T02:00:13"
    },
    ...
  ]
```

---

## 6. Storage Layer: DuckDB + Parquet

### 6.1 Cấu trúc thư mục

```
/data/                                   ← Docker volume (persistent)
├── duckdb.duckdb                        ← DuckDB catalog + indexes
├── datasets/
│   ├── 42/
│   │   ├── data.parquet                 ← full materialized data (snappy)
│   │   ├── metadata.json                ← {schema, row_count, size, refreshed}
│   │   ├── .lock                        ← sync lock file
│   │   └── delta/                       ← incremental partitions
│   │       ├── 20260319_020000.parquet
│   │       └── 20260319_030000.parquet
│   └── 87/
│       └── data.parquet
└── workspaces/
    └── ws_3/
        └── table_7.parquet
```

### 6.2 DuckDB Persistent Engine — Read Pool + Write Lock

> **Vấn đề đã sửa:** Phiên bản trước dùng `threading.Lock()` cho **mọi query** — serialize toàn bộ requests qua 1 lock. 10 users mở dashboard cùng lúc (10×8 charts = 80 requests) sẽ xếp hàng thay vì chạy song song.
>
> **Giải pháp:** DuckDB hỗ trợ concurrent reads từ nhiều connections cùng 1 file. Dùng **read connection pool** (N connections cho queries) + **1 write lock** chỉ cho các thao tác ghi (sync, register VIEW). Reads không block nhau, write block reads.

```python
# services/duckdb_engine.py

import duckdb
import threading
import queue
from pathlib import Path
from contextlib import contextmanager

DUCKDB_PATH = Path(os.environ.get("DATA_DIR", "/data")) / "duckdb.duckdb"
READ_POOL_SIZE = int(os.environ.get("DUCKDB_READ_POOL_SIZE", "8"))

class DuckDBEngine:
    """Read connection pool + exclusive write lock.
    
    Architecture:
      - READ:  N connections từ pool, concurrent, dùng xong trả về pool
      - WRITE: 1 connection riêng, có write_lock, serialize mọi write ops
                (sync ingestion, CREATE OR REPLACE VIEW)
    """
    
    _read_pool: queue.Queue = None       # pool of read connections
    _write_conn: duckdb.DuckDBPyConnection = None
    _write_lock = threading.Lock()       # chỉ lock khi write
    _init_lock  = threading.Lock()       # lock khởi tạo pool
    _initialized = False

    @classmethod
    def _initialize(cls):
        with cls._init_lock:
            if cls._initialized:
                return
            DUCKDB_PATH.parent.mkdir(parents=True, exist_ok=True)
            
            # Read pool: N independent connections, tất cả read-only
            cls._read_pool = queue.Queue(maxsize=READ_POOL_SIZE)
            for _ in range(READ_POOL_SIZE):
                conn = duckdb.connect(str(DUCKDB_PATH), read_only=True)
                cls._read_pool.put(conn)
            
            # Write connection: 1 connection duy nhất, read_only=False
            cls._write_conn = duckdb.connect(str(DUCKDB_PATH), read_only=False)
            cls._write_conn.execute("SET threads=4")
            cls._write_conn.execute("SET memory_limit='2GB'")
            
            cls._initialized = True

    @classmethod
    @contextmanager
    def read_conn(cls):
        """Borrow a read connection from pool. Returns immediately available conn."""
        if not cls._initialized:
            cls._initialize()
        conn = cls._read_pool.get(timeout=30)  # wait max 30s
        try:
            yield conn
        finally:
            cls._read_pool.put(conn)  # always return to pool

    @classmethod
    @contextmanager  
    def write_conn(cls):
        """Exclusive write connection. Blocks concurrent writes."""
        if not cls._initialized:
            cls._initialize()
        with cls._write_lock:
            yield cls._write_conn

    @classmethod
    def query(cls, sql: str, params=None) -> pd.DataFrame:
        """Execute read query — concurrent, does NOT block other reads."""
        with cls.read_conn() as conn:
            if params:
                return conn.execute(sql, params).df()
            return conn.execute(sql).df()

    @classmethod
    def register_dataset(cls, dataset_id: int, parquet_path: str):
        """Register/refresh DuckDB VIEW — exclusive write, blocks during switch."""
        view_name = f"dataset_{dataset_id}"
        delta_dir = Path(parquet_path).parent / "delta"
        delta_glob = str(delta_dir / "*.parquet")

        if delta_dir.exists() and any(delta_dir.iterdir()):
            sql = f"""
                CREATE OR REPLACE VIEW {view_name} AS
                SELECT * FROM read_parquet(['{parquet_path}', '{delta_glob}'])
            """
        else:
            sql = f"""
                CREATE OR REPLACE VIEW {view_name} AS
                SELECT * FROM read_parquet('{parquet_path}')
            """
        
        with cls.write_conn() as conn:
            conn.execute(sql)
        
        # Read pool connections cần refresh để thấy VIEW mới
        # DuckDB đọc views từ catalog file — reconnect để pick up changes
        cls._refresh_read_pool()

    @classmethod
    def _refresh_read_pool(cls):
        """Drain pool và tạo lại read connections để thấy VIEW updates."""
        if cls._read_pool is None:
            return
        with cls._write_lock:  # prevent concurrent refresh
            old_conns = []
            while not cls._read_pool.empty():
                try:
                    old_conns.append(cls._read_pool.get_nowait())
                except queue.Empty:
                    break
            for c in old_conns:
                try:
                    c.close()
                except Exception:
                    pass
            for _ in range(READ_POOL_SIZE):
                conn = duckdb.connect(str(DUCKDB_PATH), read_only=True)
                cls._read_pool.put(conn)
```

> **Kết quả:** 80 concurrent chart queries chia đều trên 8 read connections, không block nhau. Write operations (sync) chỉ block trong thời gian ngắn khi register VIEW (~1ms).

### 6.3 Ingestion Streaming

```python
# services/ingestion_engine.py

import pyarrow as pa
import pyarrow.parquet as pq

BATCH_SIZE = 10_000

def pull_to_parquet(
    ds_type: str,
    config: dict,
    sql: str,
    output_path: Path,
    on_progress: callable = None
) -> dict:
    """
    Stream từ source → Arrow batches → Parquet file.
    RAM usage: O(BATCH_SIZE) thay vì O(total_rows).
    """
    conn = _open_connection(ds_type, config)
    cursor = conn.cursor()
    cursor.execute(sql)
    
    writer = None
    total_rows = 0
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    try:
        while True:
            batch = cursor.fetchmany(BATCH_SIZE)
            if not batch:
                break
            
            columns = [desc[0] for desc in cursor.description]
            table = pa.Table.from_pylist(
                [dict(zip(columns, row)) for row in batch]
            )
            
            if writer is None:
                writer = pq.ParquetWriter(
                    output_path,
                    table.schema,
                    compression="snappy"
                )
            
            writer.write_table(table)
            total_rows += len(batch)
            
            if on_progress:
                on_progress(total_rows)
    finally:
        if writer:
            writer.close()
        cursor.close()
        conn.close()
    
    return {
        "rows": total_rows,
        "size_bytes": output_path.stat().st_size
    }
```

### 6.4 Parquet Compaction (Delta → Base)

Định kỳ (VD: hàng tuần) merge delta files vào base để tránh quá nhiều file nhỏ:

```python
def compact_dataset(dataset_id: int):
    """Merge all delta/*.parquet into data.parquet."""
    base = DATA_DIR / "datasets" / str(dataset_id) / "data.parquet"
    delta_dir = base.parent / "delta"
    
    if not delta_dir.exists():
        return
    
    delta_files = list(delta_dir.glob("*.parquet"))
    if not delta_files:
        return
    
    # DuckDB merge
    files = [str(base)] + [str(f) for f in delta_files]
    files_sql = ", ".join(f"'{f}'" for f in files)
    
    tmp = base.parent / "data_tmp.parquet"
    DuckDBEngine.get().execute(f"""
        COPY (SELECT * FROM read_parquet([{files_sql}]))
        TO '{tmp}' (FORMAT PARQUET, COMPRESSION SNAPPY)
    """)
    
    # Atomic swap
    tmp.rename(base)
    
    # Cleanup delta
    for f in delta_files:
        f.unlink()
    
    DuckDBEngine.register_dataset(dataset_id, str(base))
```

---

## 7. Query Engine

### 7.1 Chart Query với Aggregation Pushdown

Thay vì `SELECT * FROM table LIMIT 1000` rồi frontend aggregate:

```python
# services/chart_query_engine.py

def build_chart_sql(chart_config: dict, dataset_id: int) -> str:
    """
    Build aggregation SQL pushed xuống DuckDB.
    Không trả raw rows về frontend.
    """
    dimension  = chart_config.get("dimension")
    metrics    = chart_config.get("metrics", [])    # [{"column": "amount", "agg": "SUM"}]
    breakdown  = chart_config.get("breakdown")
    filters    = chart_config.get("filters", [])
    limit      = chart_config.get("limit", 500)
    
    view = f"dataset_{dataset_id}"
    
    select_parts = []
    group_parts  = []
    
    if dimension:
        select_parts.append(f'"{dimension}"')
        group_parts.append(f'"{dimension}"')
    
    if breakdown:
        select_parts.append(f'"{breakdown}"')
        group_parts.append(f'"{breakdown}"')
    
    for m in metrics:
        col = m["column"]
        agg = m.get("agg", "SUM").upper()
        alias = f"{agg.lower()}_{col}"
        select_parts.append(f'{agg}("{col}") AS "{alias}"')
    
    where_clause = _build_where(filters)  # parameterized
    
    sql = f"""
        SELECT {', '.join(select_parts)}
        FROM {view}
        {where_clause}
        GROUP BY {', '.join(group_parts) if group_parts else '1'}
        ORDER BY {select_parts[-1].split(' AS ')[-1].strip('"')} DESC
        LIMIT {min(limit, 2000)}
    """
    return sql
```

### 7.2 Routing Logic: DuckDB vs Live Source

```python
def resolve_query_target(dataset: Dataset) -> str:
    """
    Quyết định query từ DuckDB Parquet hay live source.
    Priority: DuckDB (nhanh) > Live source (fallback)
    """
    mat = dataset.materialization or {}
    
    parquet_path = DATA_DIR / "datasets" / str(dataset.id) / "data.parquet"
    
    if (
        mat.get("mode") == "parquet"
        and parquet_path.exists()
        and mat.get("status") in ("idle", "running")  # running = stale data OK
    ):
        return "duckdb"
    
    return "live"  # fallback: query trực tiếp từ source
```

### 7.3 AI Agent với DuckDB

AI Agent hiện gọi `execute_sql` → external source. Sau khi có DuckDB:

```
AI: "Top 5 products by revenue this month"
  ↓
execute_sql(datasource_id, sql, use_materialized=True)
  ↓ resolve: DuckDB available?
  ↓ YES
DuckDB:
  SELECT product_name, SUM(revenue) AS total_revenue
  FROM dataset_42           ← VIEW → reads data.parquet
  WHERE order_date >= '2026-03-01'
  GROUP BY product_name
  ORDER BY total_revenue DESC
  LIMIT 5
  ↓
5 rows trả về trong ~50ms dù dataset có 10M rows
```

---

## 8. API Endpoints mới

### 8.1 Datasource Endpoints (bổ sung)

```
# Schema/Table Browser
GET  /datasources/{id}/schemas
GET  /datasources/{id}/schemas/{schema}/tables
GET  /datasources/{id}/schemas/{schema}/tables/{table}/columns
GET  /datasources/{id}/schemas/{schema}/tables/{table}/preview?limit=100

# Sync Config
GET  /datasources/{id}/sync-config
PUT  /datasources/{id}/sync-config
POST /datasources/{id}/sync/trigger          # manual trigger full_refresh
POST /datasources/{id}/sync/trigger-incremental

# Sync Status
GET  /datasources/{id}/sync/status
GET  /datasources/{id}/sync/history?limit=20
```

### 8.2 Dataset Endpoints (bổ sung)

```
# Materialization
POST /datasets/{id}/materialize              # trigger sync (existing, enhanced)
POST /datasets/{id}/refresh                  # trigger full refresh  
POST /datasets/{id}/refresh/incremental      # trigger incremental

# Sync Config (per-dataset override)
GET  /datasets/{id}/sync-config
PUT  /datasets/{id}/sync-config

# Status
GET  /datasets/{id}/sync/status
GET  /datasets/{id}/sync/history

# Storage info
GET  /datasets/{id}/storage-info
→ {
    "row_count": 1420000,
    "size_bytes": 18500000,
    "last_refreshed_at": "2026-03-19T02:05:12",
    "parquet_path": "datasets/42/data.parquet",
    "delta_files": 3,
    "status": "idle"
  }
```

### 8.3 Request/Response Schemas mới

```python
class SyncConfig(BaseModel):
    mode: Literal["full_refresh", "incremental", "append_only", "manual"]
    schedule: SyncSchedule
    incremental: Optional[IncrementalConfig] = None
    retry: RetryConfig = RetryConfig()

class SyncSchedule(BaseModel):
    type: Literal["cron", "interval", "manual"]
    cron: Optional[str] = None          # "0 2 * * *"
    interval_seconds: Optional[int] = None
    timezone: str = "Asia/Ho_Chi_Minh"
    enabled: bool = True

class IncrementalConfig(BaseModel):
    watermark_column: str               # "updated_at"
    watermark_type: Literal["timestamp", "integer", "date"]
    lookback_minutes: int = 60

class RetryConfig(BaseModel):
    max_attempts: int = 3
    backoff_seconds: int = 300
```

---

## 9. Frontend UI/UX

### 9.1 Datasource Form — Tab mới "Sync Settings"

```
┌─────────────────────────────────────────────────────────┐
│  [Connection] [Sync Settings] [Tables]                  │
│                                                         │
│  Sync Mode                                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │ ○ Full Refresh    Truncate & re-pull mỗi lần     │  │
│  │ ○ Incremental     Pull rows mới kể từ last sync  │  │
│  │ ○ Append Only     Chỉ thêm rows mới, không update│  │
│  │ ○ Manual          Chỉ sync khi bấm nút           │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  Schedule                                               │
│  ┌──────────────────────────────────────────────────┐  │
│  │ ○ Every X minutes/hours    [  1  ] [hours  ▼]   │  │
│  │ ○ Daily at                 [02:00] [Asia/HCM ▼]  │  │
│  │ ○ Custom cron              [0 2 * * *          ] │  │
│  │   Preview: "Every day at 2:00 AM (Asia/HCM)"     │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  Incremental Settings  (hiện khi mode = Incremental)   │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Watermark Column   [updated_at ▼]               │  │
│  │ Column Type        [Timestamp  ▼]               │  │
│  │ Lookback Buffer    [60] minutes                 │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 9.2 Dataset Card — Sync Status Badge

```
┌─────────────────────────────────────────────────────┐
│  📊 Sales Orders                        [Edit] [...]│
│  Source: Production DB · 1,420,000 rows             │
│                                                     │
│  ✅ Synced 2h ago  ·  Next: in 1h  ·  18.5 MB     │
│                                    [Refresh now]    │
└─────────────────────────────────────────────────────┘

# Nếu đang sync:
│  🔄 Syncing... 340,000 / 1,420,000 rows (24%)      │
│  [Cancel]                                           │

# Nếu sync fail:
│  ⚠ Sync failed 3h ago · Retrying in 12 min         │
│  Error: Connection timeout                          │
│  [View logs]  [Retry now]                           │
```

### 9.3 Schema Browser trong Datasource

```
┌────────────────────────────────────────────────────┐
│  Schema Browser                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ 🗃 public                              [▼]  │   │
│  │   📋 orders             1,420,000 rows      │   │
│  │   📋 customers            82,000 rows       │   │
│  │   👤 v_order_summary      (view)            │   │
│  │ 🗃 analytics                          [▼]  │   │
│  │   📋 events            12,500,000 rows      │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  Selected: public.orders                            │
│  ┌─────────────────────────────────────────────┐   │
│  │ order_id    INTEGER     NOT NULL  PK         │   │
│  │ customer_id INTEGER     NOT NULL  FK         │   │
│  │ amount      DECIMAL     nullable             │   │
│  │ status      VARCHAR(20) NOT NULL             │   │
│  │ created_at  TIMESTAMP   NOT NULL  indexed    │   │
│  │ updated_at  TIMESTAMP   nullable  indexed    │   │
│  └─────────────────────────────────────────────┘   │
│  [Preview 100 rows]  [Use in Dataset →]             │
└────────────────────────────────────────────────────┘
```

---

## 10. Bảo mật

### 10.1 SQL Injection Fix (ưu tiên cao nhất)

**Vấn đề hiện tại** (`dataset_workspaces.py`):
```python
# NGUY HIỂM — user input trực tiếp vào SQL
where_conditions.append(f"{filter_cond.field} LIKE '%{filter_cond.value}%'")
where_conditions.append(f"{filter_cond.field} {filter_cond.operator} '{filter_cond.value}'")
```

**Fix:**
```python
# Whitelist column names
allowed_columns = {col["name"] for col in table_columns}
if filter_cond.field not in allowed_columns:
    raise ValueError(f"Invalid column: {filter_cond.field}")

# Parameterized values
params = []
if filter_cond.operator.upper() == "LIKE":
    where_conditions.append(f'"{filter_cond.field}" LIKE ?')
    params.append(f"%{filter_cond.value}%")
else:
    safe_ops = {"=", "!=", ">", "<", ">=", "<=", "IN", "NOT IN"}
    if filter_cond.operator.upper() not in safe_ops:
        raise ValueError(f"Invalid operator: {filter_cond.operator}")
    where_conditions.append(f'"{filter_cond.field}" {filter_cond.operator} ?')
    params.append(filter_cond.value)
```

### 10.2 Credential Encryption

Credentials trong `DataSource.config` hiện lưu plaintext. Cần encrypt trước khi lưu:

> **Vấn đề đã sửa:** Phiên bản trước dùng `except: pass` khi decrypt fail — nuốt mọi exception, không phân biệt được "chuỗi plaintext cũ" với "key sai" hay "data bị corrupt". Cần phân biệt rõ ràng và có migration script.

```python
# core/crypto.py
import logging
from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

ENCRYPTION_KEY = os.environ["DATASOURCE_ENCRYPTION_KEY"]  # 32-byte Fernet key
_cipher = Fernet(ENCRYPTION_KEY)

SENSITIVE_FIELDS = {"password", "credentials_json", "api_key", "access_token"}
_FERNET_PREFIX = b"gAAAAA"  # tất cả Fernet tokens bắt đầu bằng prefix này

def _is_encrypted(value: str) -> bool:
    """Kiểm tra nhanh xem value đã được Fernet encrypt chưa."""
    return isinstance(value, str) and value.encode().startswith(_FERNET_PREFIX)

def encrypt_config(config: dict) -> dict:
    result = dict(config)
    for field in SENSITIVE_FIELDS:
        if field in result and result[field] and not _is_encrypted(result[field]):
            result[field] = _cipher.encrypt(result[field].encode()).decode()
    return result

def decrypt_config(config: dict) -> dict:
    result = dict(config)
    for field in SENSITIVE_FIELDS:
        if field not in result or not result[field]:
            continue
        value = result[field]
        if not _is_encrypted(value):
            # Plaintext legacy credential — log warning, không raise
            logger.warning(
                "Datasource config field '%s' contains unencrypted plaintext. "
                "Run migration script: python scripts/encrypt_credentials.py",
                field
            )
            # Trả về as-is để không break existing functionality
            continue
        try:
            result[field] = _cipher.decrypt(value.encode()).decode()
        except InvalidToken:
            # Key sai hoặc data corrupt — đây là lỗi nghiêm trọng, raise
            raise ValueError(
                f"Failed to decrypt field '{field}': invalid token. "
                "Check DATASOURCE_ENCRYPTION_KEY environment variable."
            )
    return result
```

**Migration script cho existing credentials:**

```python
# scripts/encrypt_credentials.py
"""One-time migration: encrypt all plaintext credentials in data_sources.config."""
from app.core.database import SessionLocal
from app.models.models import DataSource
from app.core.crypto import encrypt_config, _is_encrypted, SENSITIVE_FIELDS

def migrate():
    db = SessionLocal()
    sources = db.query(DataSource).all()
    migrated = 0
    
    for ds in sources:
        config = dict(ds.config)
        needs_update = any(
            field in config and config[field] and not _is_encrypted(config[field])
            for field in SENSITIVE_FIELDS
        )
        if needs_update:
            ds.config = encrypt_config(config)
            migrated += 1
    
    db.commit()
    print(f"Encrypted credentials for {migrated} datasources.")

if __name__ == "__main__":
    migrate()
```

### 10.3 Query Validation cho DuckDB

> **Vấn đề đã sửa:** Keyword blocking dễ bypass — `WITH evil AS (COPY ...)` hoặc comment tricks. Cần approach mạnh hơn.
>
> **Approach được chọn: DuckDB read-only connection + sqlglot AST validation (defense in depth)**
>
> - **Tầng 1 (mạnh nhất):** Query chạy trên read-only DuckDB connection — DuckDB tự từ chối mọi write operations ở engine level, không thể bypass
> - **Tầng 2 (early rejection):** sqlglot AST parse để reject sớm trước khi gửi xuống DuckDB, trả về error message có ý nghĩa cho AI

```python
# core/query_validator.py
import sqlglot
import sqlglot.expressions as exp
from typing import Optional

# Statement types được phép
ALLOWED_STATEMENT_TYPES = (exp.Select,)   # chỉ SELECT (bao gồm WITH...SELECT)

def validate_duckdb_query(sql: str) -> None:
    """
    Validate SQL bằng AST parse.
    Tầng 2 defense — tầng 1 là read_only=True connection.
    """
    try:
        statements = sqlglot.parse(sql, dialect="duckdb")
    except sqlglot.errors.ParseError as e:
        raise ValueError(f"Invalid SQL syntax: {e}")
    
    if not statements:
        raise ValueError("Empty SQL query")
    
    if len(statements) > 1:
        raise ValueError("Multiple statements not allowed. Send one query at a time.")
    
    stmt = statements[0]
    
    # Kiểm tra statement type ở root level
    if not isinstance(stmt, ALLOWED_STATEMENT_TYPES):
        stmt_type = type(stmt).__name__
        raise ValueError(
            f"Statement type '{stmt_type}' is not allowed. Only SELECT queries are permitted."
        )
    
    # Kiểm tra không có subquery/CTE chứa write operations
    # sqlglot walk toàn bộ AST tree
    for node in stmt.walk():
        if isinstance(node, (
            exp.Insert, exp.Update, exp.Delete,
            exp.Drop, exp.Create, exp.Alter,
            exp.Command,  # ATTACH, COPY, PRAGMA, etc.
        )):
            node_type = type(node).__name__
            raise ValueError(
                f"Write operation '{node_type}' found inside query. Not allowed."
            )

# Usage trong DuckDBEngine:
# validate_duckdb_query(sql)          # tầng 2: AST check, fail-fast với good error
# with cls.read_conn() as conn:       # tầng 1: read_only connection, engine-level block
#     return conn.execute(sql).df()
```

> **Lưu ý cài đặt:** `pip install sqlglot` — lightweight, zero dependencies, hỗ trợ DuckDB dialect.

---

## 11. Lộ trình implement

### Phase 0 — Security Fix (1–2 giờ) **[NGAY BÂY GIỜ]**
- [ ] Fix SQL injection trong `execute_workspace_table_query`
- [ ] Whitelist column names + parameterized values

### Phase 1 — Core Storage (3–4 ngày)
- [ ] `pip install pyarrow duckdb apscheduler`
- [ ] Alembic migration: thêm `sync_config` vào `DataSource` và `Dataset`
- [ ] Alembic migration: tạo bảng `sync_job_runs`
- [ ] `DuckDBEngine` — persistent singleton
- [ ] `IngestionEngine` — streaming pull → Parquet
- [ ] `DatasetMaterializationService` v2 — ghi Parquet + register DuckDB VIEW
- [ ] Query routing: DuckDB nếu Parquet exist, fallback live source

### Phase 2 — Sync Scheduler (2–3 ngày)
- [ ] APScheduler tích hợp FastAPI lifespan
- [ ] `SyncScheduler.register_all_jobs()` khi startup
- [ ] FULL_REFRESH mode
- [ ] INCREMENTAL mode (watermark)
- [ ] APPEND_ONLY mode + delta compaction
- [ ] Retry policy với backoff
- [ ] API: `/sync/trigger`, `/sync/status`, `/sync/history`

### Phase 3 — Connection Enhancement (1–2 ngày)
- [ ] Schema/Table Browser endpoints
- [ ] Connection pool (psycopg2 ThreadedConnectionPool)
- [ ] Credential encryption (Fernet)
- [ ] Manual datasource: lưu Parquet thay vì JSON blob trong config

### Phase 4 — Frontend (2–3 ngày)
- [ ] Datasource form: tab "Sync Settings"
- [ ] Dataset card: sync status badge + progress
- [ ] Schema browser component
- [ ] Sync history timeline

### Phase 5 — AI Agent Routing (1 ngày)
- [ ] `execute_sql` route to DuckDB VIEW khi materialized
- [ ] Better table catalog context cho AI: pass schema + row_count + last_refreshed

---

## Phụ lục: So sánh hiệu năng ước tính

| Scenario | Hiện tại | Sau khi implement |
|---|---|---|
| Chart load (100k rows, aggregation) | 3–8s | 50–200ms |
| Dashboard 10 charts | 30–80s | 500ms–2s |
| AI query trên 1M rows | Timeout/OOM | 100–500ms |
| File upload 100k rows | 2s + 50MB JSON | 500ms → 5MB Parquet |
| Dataset first sync 5M rows | Không có | ~3–5 phút (one-time) |
| Incremental sync (10k new rows/h) | Không có | ~5–15 giây/lần |
| RAM per chart query | O(total_rows) | O(result_rows) |

---

*Document này sẽ được cập nhật khi bắt đầu implement từng Phase.*

---

## 12. Quyết định thiết kế & Constraints đã biết

Phần này ghi lại các quyết định quan trọng và lý do, để tránh re-open các tranh luận đã được resolve.

### ADR-001: sync_config chỉ ở Dataset level (không ở DataSource)

| | |
|---|---|
| **Quyết định** | `sync_config` chỉ đặt ở `Dataset`, không đặt ở `DataSource` |
| **Lý do** | Tránh ambiguity merge logic. Một DataSource có N Datasets — mỗi dataset cần lịch riêng (orders mỗi giờ, customers mỗi ngày). Nếu đặt ở DataSource, tất cả datasets phải dùng chung schedule, kém linh hoạt. |
| **Trade-off** | Nếu muốn sync tất cả datasets của 1 source cùng lúc, user cần set schedule giống nhau cho từng dataset — hơi tedious. Phase sau có thể thêm "Apply to all datasets" shortcut trên UI. |

### ADR-002: DuckDB Read Pool + Write Lock (không phải global lock)

| | |
|---|---|
| **Quyết định** | N read connections (pool), 1 write connection với write_lock |
| **Lý do** | DuckDB hỗ trợ concurrent reads từ multiple connections cùng 1 file. Global lock serialize tất cả = thắt cổ chai khi nhiều user. |
| **Trade-off** | Write (sync) block reads trong lúc `_refresh_read_pool()` — thời gian rất ngắn (~50ms). Acceptable. |
| **Pool size** | Default 8, configurable qua `DUCKDB_READ_POOL_SIZE` env var. Nên set = số CPU cores. |

### ADR-003: APScheduler in-process, single-worker only

| | |
|---|---|
| **Quyết định** | APScheduler chạy in-process trong FastAPI worker duy nhất |
| **Constraint** | `API_WORKERS=1` bắt buộc. Nhiều workers = N schedulers = job chạy N lần đồng thời |
| **Scale path** | Khi cần > 1 worker: chuyển sang `APScheduler + SQLAlchemyJobStore` (DB-level locking) hoặc tách scheduler thành dedicated process |
| **Ghi chú** | Ghi rõ `API_WORKERS=1` trong `.env`, `docker-compose.yml`, và deployment docs |

### ADR-004: DuckDB query validation = AST parse (sqlglot) + read-only connection

| | |
|---|---|
| **Quyết định** | Defense in depth: sqlglot AST (tầng 2, early rejection) + read_only connection (tầng 1, engine-level block) |
| **Lý do từ chối keyword blocking** | Dễ bypass qua `WITH x AS (COPY...)`, comments, string literals |
| **Dependency** | `sqlglot` — zero transitive dependencies, ~2MB |

### ADR-005: Fernet với prefix detection thay vì bare except

| | |
|---|---|
| **Quyết định** | Detect encrypted vs plaintext bằng Fernet token prefix `gAAAAA`, log warning cho plaintext, raise rõ ràng khi key sai |
| **Lý do** | `except: pass` nuốt cả lỗi "key sai" — không thể phân biệt với backward compat case |
| **Migration** | Script `scripts/encrypt_credentials.py` cần chạy 1 lần sau khi set `DATASOURCE_ENCRYPTION_KEY` |
