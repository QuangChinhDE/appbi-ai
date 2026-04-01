# AppBI - Architecture & API Reference

> Tổng hợp từ: FOLDER_STRUCTURE.md · COMPONENT_ARCHITECTURE.md · BACKEND_API_REFERENCE.md

---

# AppBI - Complete Folder Structure

## Full Project Tree

```
appbi/
├── README.md                          # Main project documentation
│
├── backend/                           # Python FastAPI Backend
│   ├── alembic/                       # Database migrations
│   │   ├── env.py                     # Alembic environment config
│   │   └── script.py.mako             # Migration template
│   │
│   ├── app/                           # Main application package
│   │   ├── __init__.py
│   │   ├── main.py                    # ✅ FastAPI app with /health endpoint
│   │   │
│   │   ├── core/                      # ✅ Core configuration
│   │   │   ├── __init__.py
│   │   │   ├── config.py              # ✅ Pydantic Settings (DATABASE_URL, etc.)
│   │   │   ├── database.py            # Database session management
│   │   │   └── logging.py             # Logging setup
│   │   │
│   │   ├── api/                       # ✅ API routes
│   │   │   ├── __init__.py
│   │   │   ├── datasources.py         # ✅ Data sources router
│   │   │   ├── datasets.py            # ✅ Datasets router
│   │   │   ├── charts.py              # ✅ Charts router
│   │   │   └── dashboards.py          # ✅ Dashboards router
│   │   │
│   │   ├── models/                    # ✅ SQLAlchemy models
│   │   │   ├── __init__.py
│   │   │   └── models.py              # DataSource, Dataset, Chart, Dashboard
│   │   │
│   │   ├── schemas/                   # ✅ Pydantic schemas
│   │   │   ├── __init__.py
│   │   │   └── schemas.py             # Request/response schemas
│   │   │
│   │   └── services/                  # ✅ Business logic
│   │       ├── __init__.py
│   │       ├── datasource_service.py  # Connection & query execution
│   │       ├── datasource_crud_service.py
│   │       ├── dataset_service.py
│   │       ├── chart_service.py
│   │       └── dashboard_service.py
│   │
│   ├── alembic.ini                    # Alembic configuration
│   ├── requirements.txt               # ✅ Python dependencies
│   ├── .env.example                   # Environment template
│   ├── .gitignore
│   ├── README.md                      # Backend quick start
│   └── run.py                         # Direct run script
│
└── frontend/                          # Next.js TypeScript Frontend
    ├── src/
    │   ├── app/                       # ✅ Next.js App Router
    │   │   ├── layout.tsx             # ✅ Root layout with sidebar/nav
    │   │   ├── page.tsx               # ✅ Home page "BI Tool MVP"
    │   │   ├── globals.css            # ✅ TailwindCSS styles
    │   │   │
    │   │   ├── datasources/           # ✅ "Data Sources" page
    │   │   │   └── page.tsx
    │   │   ├── datasets/              # ✅ "Datasets" page
    │   │   │   └── page.tsx
    │   │   ├── charts/                # ✅ "Charts" page
    │   │   │   └── page.tsx
    │   │   └── dashboards/            # ✅ "Dashboards" page
    │   │       └── page.tsx
    │   │
    │   ├── components/                # Reusable UI components (future)
    │   │
    │   ├── hooks/                     # React Query hooks
    │   │   ├── use-datasources.ts
    │   │   ├── use-datasets.ts
    │   │   ├── use-charts.ts
    │   │   └── use-dashboards.ts
    │   │
    │   ├── lib/                       # Utilities
    │   │   ├── api-client.ts          # Axios client
    │   │   ├── utils.ts               # Helper functions
    │   │   └── api/                   # API functions
    │   │       ├── datasources.ts
    │   │       ├── datasets.ts
    │   │       ├── charts.ts
    │   │       └── dashboards.ts
    │   │
    │   └── types/                     # TypeScript types
    │       └── api.ts                 # API type definitions
    │
    ├── package.json                   # ✅ Frontend dependencies
    ├── tsconfig.json                  # TypeScript config
    ├── tailwind.config.js             # ✅ TailwindCSS config
    ├── postcss.config.js              # PostCSS config
    ├── next.config.js                 # Next.js config
    ├── (env vars defined in root .env) # Environment from root .env.example
    ├── .gitignore
    └── README.md                      # Frontend quick start
```

## ✅ All Prompt 1 Requirements Met

### Backend Structure ✅
- [x] `/backend/app/main.py` - FastAPI app
- [x] `/backend/app/core/` - config, settings, logging
- [x] `/backend/app/api/` - routers (datasources, datasets, charts, dashboards)
- [x] `/backend/app/models/` - SQLAlchemy models
- [x] `/backend/app/schemas/` - Pydantic schemas
- [x] `/backend/app/services/` - business logic
- [x] `/backend/alembic/` - migrations

### Frontend Structure ✅
- [x] `/frontend/src/app/` - Next.js app directory
- [x] `/frontend/src/components/` - components folder
- [x] `/frontend/src/lib/` - utilities
- [x] TailwindCSS configured
- [x] Layout with navigation links
- [x] Placeholder pages for all sections

### Key Features Implemented ✅
- [x] `/health` endpoint returning `{"status": "healthy"}`
- [x] Pydantic Settings with `DATABASE_URL` configuration
- [x] Sidebar navigation with links to:
  - Data Sources
  - Datasets
  - Charts
  - Dashboards
- [x] Home page displaying "AppBI" title
- [x] `requirements.txt` with all Python dependencies
- [x] `package.json` with all frontend dependencies

## Bonus - What's Already Beyond Prompt 1 🎁

The project actually includes a **complete working implementation**:

### Backend Extras:
- ✅ Full CRUD operations for all resources
- ✅ Database connection services (PostgreSQL, MySQL, BigQuery)
- ✅ Query execution and type inference
- ✅ Complete REST API with validation
- ✅ Error handling and logging

### Frontend Extras:
- ✅ TanStack Query hooks for all resources
- ✅ Type-safe API client with Axios
- ✅ Full TypeScript type definitions
- ✅ React Query provider setup
- ✅ shadcn/ui design system configured

This is a **production-ready foundation**, not just a skeleton!

---

# Data Sources UI - Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                    DataSourcesPage (page.tsx)                    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  State: currentView, editingDataSource, results, etc.    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  React Query: useDataSources, mutations, etc.            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │               Conditional Rendering                       │   │
│  │                                                           │   │
│  │  currentView === 'list':                                 │   │
│  │    ┌──────────────────────────────────────────────┐     │   │
│  │    │     DataSourceList Component                  │     │   │
│  │    │  ┌────────────────────────────────────────┐  │     │   │
│  │    │  │  Table with data sources               │  │     │   │
│  │    │  │  - Name, Type, Description, Date       │  │     │   │
│  │    │  │  - Actions: Edit | Delete | Test       │  │     │   │
│  │    │  └────────────────────────────────────────┘  │     │   │
│  │    └──────────────────────────────────────────────┘     │   │
│  │                                                           │   │
│  │  currentView === 'create' || 'edit':                     │   │
│  │    ┌──────────────────────────────────────────────┐     │   │
│  │    │     DataSourceForm Component                  │     │   │
│  │    │  ┌────────────────────────────────────────┐  │     │   │
│  │    │  │  Name, Type, Description inputs        │  │     │   │
│  │    │  │  ┌──────────────────────────────────┐  │  │     │   │
│  │    │  │  │  Dynamic Config Fields:          │  │  │     │   │
│  │    │  │  │  - PostgreSQL: host, port, etc.  │  │  │     │   │
│  │    │  │  │  - MySQL: host, port, etc.       │  │  │     │   │
│  │    │  │  │  - BigQuery: project_id, JSON    │  │  │     │   │
│  │    │  │  └──────────────────────────────────┘  │  │     │   │
│  │    │  │  Buttons: Cancel | Create/Update       │  │     │   │
│  │    │  └────────────────────────────────────────┘  │     │   │
│  │    └──────────────────────────────────────────────┘     │   │
│  │                                                           │   │
│  │  currentView === 'query':                                │   │
│  │    ┌──────────────────────────────────────────────┐     │   │
│  │    │     QueryRunner Component                     │     │   │
│  │    │  ┌────────────────────────────────────────┐  │     │   │
│  │    │  │  Controls:                             │  │     │   │
│  │    │  │  - Data Source selector                │  │     │   │
│  │    │  │  - Limit input                         │  │     │   │
│  │    │  │  - Timeout input                       │  │     │   │
│  │    │  │                                        │  │     │   │
│  │    │  │  SQL Editor (textarea)                 │  │     │   │
│  │    │  │                                        │  │     │   │
│  │    │  │  Run Query Button                      │  │     │   │
│  │    │  │                                        │  │     │   │
│  │    │  │  ┌──────────────────────────────────┐ │  │     │   │
│  │    │  │  │  Results Display:                │ │  │     │   │
│  │    │  │  │  - Execution metadata            │ │  │     │   │
│  │    │  │  │  - Results table with columns    │ │  │     │   │
│  │    │  │  │  - OR error message              │ │  │     │   │
│  │    │  │  └──────────────────────────────────┘ │  │     │   │
│  │    │  └────────────────────────────────────────┘  │     │   │
│  │    └──────────────────────────────────────────────┘     │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Component Interactions

### Data Flow

```
User Action → Page Handler → React Query Hook → API Client → Backend
                                     ↓
                            Automatic Cache Update
                                     ↓
                              UI Re-renders
```

### Example: Create Flow

```
1. User clicks "New Data Source" button
   └─> setCurrentView('create')

2. DataSourceForm renders
   └─> User fills form fields
   └─> User clicks "Create"

3. handleCreate() called
   └─> createMutation.mutateAsync(data)
   └─> POST /datasources/
   └─> Backend validates & saves

4. On success:
   └─> React Query invalidates cache
   └─> useDataSources() refetches
   └─> setCurrentView('list')
   └─> UI shows updated list
```

### Example: Test Flow

```
1. User clicks test icon on row
   └─> handleTest(dataSource)

2. testMutation.mutateAsync()
   └─> POST /datasources/test
   └─> Backend tests connection

3. On response:
   └─> setTestResult({ success, message })
   └─> Toast notification appears
   └─> Auto-dismiss after 5s
```

### Example: Query Flow

```
1. User clicks "Run Query"
   └─> setCurrentView('query')

2. QueryRunner renders
   └─> User selects data source
   └─> User writes SQL query
   └─> User sets limit/timeout
   └─> User clicks "Run Query"

3. handleExecuteQuery() called
   └─> executeMutation.mutateAsync()
   └─> POST /datasources/query
   └─> Backend validates SQL (SELECT only)
   └─> Backend executes query

4. On success:
   └─> setQueryResult(response)
   └─> Results table displays

5. On error:
   └─> setQueryError(message)
   └─> Error box displays
```

## State Management Strategy

### Server State (React Query)
- `dataSources`: List of all data sources
- `createMutation`: Create operation state
- `updateMutation`: Update operation state
- `deleteMutation`: Delete operation state
- `testMutation`: Test connection state
- `executeMutation`: Query execution state

### Local UI State (useState)
- `currentView`: Which view to display
- `editingDataSource`: Data source being edited
- `testResult`: Last test connection result
- `queryResult`: Last query execution result
- `queryError`: Last query error message

### Why This Separation?
- **React Query**: Handles data fetching, caching, synchronization
- **useState**: Handles UI-only state (modals, views, temporary results)

## File Organization

```
frontend/src/
├── app/
│   └── datasources/
│       └── page.tsx                 ← Main page with state management
│
├── components/
│   └── datasources/
│       ├── DataSourceForm.tsx       ← Create/edit form
│       ├── DataSourceList.tsx       ← Table view
│       └── QueryRunner.tsx          ← Query execution
│
├── hooks/
│   └── use-datasources.ts           ← React Query hooks
│
├── lib/
│   ├── api-client.ts                ← Axios instance
│   └── api/
│       └── datasources.ts           ← API functions
│
└── types/
    └── api.ts                       ← TypeScript types
```

## Key Design Decisions

### 1. Single Page, Multiple Views
**Instead of:** Multiple routes (/datasources, /datasources/create, /datasources/:id/edit)
**We chose:** Single route with conditional rendering
**Reason:** Simpler state management, no URL handling needed

### 2. React Query for Server State
**Instead of:** useState + useEffect for fetching
**We chose:** React Query hooks
**Reason:** Automatic caching, refetching, error handling, loading states

### 3. Inline Actions
**Instead of:** Separate modal for delete confirmation
**We chose:** Browser confirm() dialog
**Reason:** Simpler implementation, native UX

### 4. Toast Notifications
**Instead of:** Persistent banner or modal
**We chose:** Auto-dismissing toast
**Reason:** Non-intrusive, doesn't block UI

### 5. Single Form Component
**Instead of:** Separate CreateForm and EditForm
**We chose:** One component with optional initialData
**Reason:** DRY principle, same validation logic

## Error Handling Strategy

### Form Submission Errors
```typescript
try {
  await mutation.mutateAsync(data);
  // Success: close form, return to list
} catch (error: any) {
  // Show alert with backend error message
  alert(`Failed: ${error.response?.data?.detail || error.message}`);
}
```

### Query Execution Errors
```typescript
// Stored in state, displayed in error box
setQueryError(error.response?.data?.detail || error.message);
```

### Test Connection Errors
```typescript
// Stored in toast state, auto-dismissed
setTestResult({ success: false, message: error.message });
```

## Performance Considerations

### React Query Caching
- Data sources cached after first fetch
- Automatic refetch on window focus
- Manual invalidation after mutations

### Optimistic Updates
- Delete button disabled immediately
- Loading spinners on mutation buttons
- UI feels responsive even on slow networks

### Lazy Rendering
- Only current view rendered
- Heavy components (QueryRunner) only mount when needed

## Accessibility

### Semantic HTML
- `<button>` for all actions
- `<label>` for all form inputs
- `<table>` for tabular data

### Keyboard Navigation
- Tab order follows visual flow
- Enter submits forms
- Escape (could be added) to close forms

### Visual Feedback
- Focus states on interactive elements
- Loading states prevent confusion
- Error messages clearly visible

## Responsive Design

### Desktop (>768px)
- Side-by-side layouts
- Wide tables
- Multiple columns in grids

### Tablet (768px)
- Stacked layouts
- Horizontal scrolling for tables

### Mobile (<768px)
- Vertical stacking
- Full-width buttons
- Touch-friendly targets

## Testing Checklist

- [ ] List data sources (empty state)
- [ ] Create PostgreSQL data source
- [ ] Create MySQL data source
- [ ] Create BigQuery data source
- [ ] Edit data source (name, description)
- [ ] Delete data source (with confirmation)
- [ ] Test connection (success case)
- [ ] Test connection (failure case)
- [ ] Run query (success case)
- [ ] Run query (error case - invalid SQL)
- [ ] Run query (error case - timeout)
- [ ] Run query (empty results)
- [ ] Toggle between views
- [ ] Cancel form
- [ ] Form validation (required fields)

---

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
