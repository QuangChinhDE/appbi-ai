# Backend API Reference for Frontend

This document maps the frontend's expectations to the actual backend endpoints.

## Base URL
```
Default: http://localhost:8000/api/v1
Configurable via: NEXT_PUBLIC_API_URL environment variable
```

## Endpoint Mapping

### 1. List All Data Sources
**Frontend Call:**
```typescript
dataSourceApi.getAll()
```

**HTTP Request:**
```
GET /api/v1/datasources/
Query Params: ?skip=0&limit=50 (optional, available but not used yet)
```

**Response Schema:**
```json
[
  {
    "id": 1,
    "name": "My PostgreSQL",
    "type": "postgresql",
    "description": "Production database",
    "config": {
      "host": "localhost",
      "port": 5432,
      "database": "mydb",
      "username": "user",
      "password": "pass"
    },
    "created_at": "2025-11-28T10:00:00Z",
    "updated_at": "2025-11-28T10:00:00Z"
  }
]
```

---

### 2. Get Single Data Source
**Frontend Call:**
```typescript
dataSourceApi.getById(id)
```

**HTTP Request:**
```
GET /api/v1/datasources/{id}
```

**Response Schema:** Same as single item from list above

---

### 3. Create Data Source
**Frontend Call:**
```typescript
dataSourceApi.create({
  name: "My PostgreSQL",
  type: "postgresql",
  description: "Test DB",
  config: { host: "localhost", port: 5432, ... }
})
```

**HTTP Request:**
```
POST /api/v1/datasources/
Content-Type: application/json
```

**Request Body:**
```json
{
  "name": "My PostgreSQL",
  "type": "postgresql",
  "description": "Test DB",
  "config": {
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "username": "user",
    "password": "pass"
  }
}
```

**Response Schema:** Same as list item (newly created DataSource)

**Validation:**
- Backend validates config against type-specific Pydantic models (PostgreSQLConfig, MySQLConfig, BigQueryConfig)
- Returns 422 Unprocessable Entity if validation fails

---

### 4. Update Data Source
**Frontend Call:**
```typescript
dataSourceApi.update(id, {
  name: "Updated Name",
  description: "New description",
  config: { ... }
})
```

**HTTP Request:**
```
PUT /api/v1/datasources/{id}
Content-Type: application/json
```

**Request Body:**
```json
{
  "name": "Updated Name",
  "description": "New description",
  "config": {
    "host": "newhost",
    "port": 5432,
    "database": "newdb",
    "username": "newuser",
    "password": "newpass"
  }
}
```

**Notes:**
- All fields are optional
- `type` cannot be changed (not in DataSourceUpdate schema)
- Config is validated against the existing type

**Response Schema:** Updated DataSource object

---

### 5. Delete Data Source
**Frontend Call:**
```typescript
dataSourceApi.delete(id)
```

**HTTP Request:**
```
DELETE /api/v1/datasources/{id}
```

**Response:**
```
Status: 204 No Content
Body: (empty)
```

---

### 6. Test Connection
**Frontend Call:**
```typescript
dataSourceApi.test(type, config)
```

**HTTP Request:**
```
POST /api/v1/datasources/test
Content-Type: application/json
```

**Request Body:**
```json
{
  "type": "postgresql",
  "config": {
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "username": "user",
    "password": "pass"
  }
}
```

**Response Schema (Success):**
```json
{
  "success": true,
  "message": "Successfully connected to PostgreSQL database"
}
```

**Response Schema (Failure):**
```json
{
  "success": false,
  "message": "Connection failed: could not connect to server"
}
```

**Status Codes:**
- 200: Test completed (check `success` field for result)
- 422: Invalid request body

---

### 7. Execute Ad-Hoc Query
**Frontend Call:**
```typescript
dataSourceApi.executeQuery({
  data_source_id: 1,
  sql_query: "SELECT * FROM users",
  limit: 100,
  timeout_seconds: 30
})
```

**HTTP Request:**
```
POST /api/v1/datasources/query
Content-Type: application/json
```

**Request Body:**
```json
{
  "data_source_id": 1,
  "sql_query": "SELECT * FROM users WHERE active = true",
  "limit": 100,
  "timeout_seconds": 30
}
```

**Response Schema (Success):**
```json
{
  "columns": ["id", "name", "email", "active"],
  "data": [
    { "id": 1, "name": "Alice", "email": "alice@example.com", "active": true },
    { "id": 2, "name": "Bob", "email": "bob@example.com", "active": true }
  ],
  "row_count": 2,
  "execution_time_ms": 45
}
```

**Error Responses:**
- 400 Bad Request: SQL validation failed (e.g., not a SELECT query)
  ```json
  {
    "detail": "Query validation failed: Query must start with SELECT"
  }
  ```
- 404 Not Found: Data source doesn't exist
- 500 Internal Server Error: Query execution failed
  ```json
  {
    "detail": "Query execution failed: relation 'users' does not exist"
  }
  ```

**Backend Safety Features:**
- SQL validation blocks non-SELECT queries (INSERT, UPDATE, DELETE, DROP, etc.)
- Query timeout enforced (default 30s)
- Result limit applied

---

## Error Handling

### Frontend Error Extraction
```typescript
catch (error: any) {
  const message = error.response?.data?.detail || error.message;
  // Display message to user
}
```

### Backend Error Format
FastAPI returns errors in this format:
```json
{
  "detail": "Human-readable error message"
}
```

For validation errors (422):
```json
{
  "detail": [
    {
      "loc": ["body", "config", "host"],
      "msg": "field required",
      "type": "value_error.missing"
    }
  ]
}
```

---

## Environment Variables

### Frontend
```bash
# .env.local
NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1
```

### Backend
```bash
# .env
DATABASE_URL=postgresql://user:pass@localhost:5432/appbi_metadata
```

---

## CORS Configuration

Backend must allow frontend origin:

```python
# backend/app/main.py
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # Frontend URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

---

## Testing the Integration

### 1. Start Backend
```bash
cd backend
uvicorn app.main:app --reload --port 8000
```

Verify health endpoint:
```bash
curl http://localhost:8000/health
```

### 2. Start Frontend
```bash
cd frontend
npm run dev
```

Navigate to: http://localhost:3000/datasources

### 3. Test Flow
1. Create a data source (PostgreSQL/MySQL/BigQuery)
2. Test connection (should see green toast)
3. Run a query (SELECT * FROM table_name)
4. Edit the data source
5. Delete the data source

### 4. Check Browser Console
- API requests logged: `[API] GET /datasources/`
- Errors logged: `[API Error] {...}`

### 5. Check Backend Logs
- Query execution logs
- Connection test results
- SQL validation messages

---

## Type Safety

### Frontend Types (types/api.ts)
```typescript
export interface DataSource {
  id: number;
  name: string;
  type: DataSourceType;
  description?: string;
  config: Record<string, any>;
  created_at: string;
  updated_at: string;
}
```

### Backend Types (schemas/schemas.py)
```python
class DataSourceResponse(BaseModel):
    id: int
    name: str
    type: str
    description: Optional[str] = None
    config: dict
    created_at: datetime
    updated_at: datetime
```

**Alignment:** ✅ Frontend and backend types match exactly

---

## Summary

All frontend API calls are **fully aligned** with the backend implementation from Prompts 1 and 2A:

- ✅ Endpoints match
- ✅ Request/response schemas match
- ✅ Error handling implemented
- ✅ Type safety maintained
- ✅ Backend validation (SQL safety, config validation) integrated
- ✅ Timeout support included

The UI is ready to use with the existing backend!
