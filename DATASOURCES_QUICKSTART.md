# Data Sources UI - Quick Start

## 🚀 Quick Start (5 Minutes)

### 1. Start Backend
```powershell
cd backend
.\venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000
```
Verify: http://localhost:8000/health

### 2. Start Frontend
```powershell
cd frontend
npm run dev
```
Verify: http://localhost:3000

### 3. Test Data Sources UI
1. Navigate to http://localhost:3000/datasources
2. Click "New Data Source"
3. Create a PostgreSQL connection:
   - Name: `Test DB`
   - Type: `PostgreSQL`
   - Host: `localhost`
   - Port: `5432`
   - Database: `postgres`
   - Username: `postgres`
   - Password: `postgres`
4. Click "Create"
5. Click test icon → See green success toast
6. Click "Run Query" → Execute: `SELECT version()`
7. See results!

---

## ✅ What Was Built

### Three New Components
1. **DataSourceForm.tsx** - Create/edit with dynamic fields
2. **DataSourceList.tsx** - Table with actions
3. **QueryRunner.tsx** - SQL execution with results

### One Updated Page
- **datasources/page.tsx** - Full CRUD + query runner

### Integration Complete
- React Query hooks (already existed)
- API client (already existed)
- Backend endpoints (already implemented in Prompt 2A)

---

## 📸 UI Features

### List View
```
┌────────────────────────────────────────────────┐
│ Data Sources                    [Run Query] [+ New] │
├────────────────────────────────────────────────┤
│ Name        Type         Description    Actions│
│ My PostgreSQL [PostgreSQL] Prod DB     🧪 ✏️ 🗑️ │
│ Analytics   [BigQuery]    GCP data     🧪 ✏️ 🗑️ │
└────────────────────────────────────────────────┘
```

### Create/Edit Form
```
┌────────────────────────────────────────────────┐
│ Create Data Source                         [✕] │
├────────────────────────────────────────────────┤
│ Name: [________________]                        │
│ Type: [PostgreSQL ▼]                            │
│ Description: [___________________]              │
│                                                 │
│ Connection Configuration                        │
│ Host: [localhost    ] Port: [5432]              │
│ Database: [mydb________________]                │
│ Username: [user________________]                │
│ Password: [••••••••]                            │
│                                                 │
│ [Cancel] [Create]                               │
└────────────────────────────────────────────────┘
```

### Query Runner
```
┌────────────────────────────────────────────────┐
│ Query Runner                               [✕] │
├────────────────────────────────────────────────┤
│ Data Source: [My PostgreSQL ▼] Limit: [100]    │
│ Timeout: [30] seconds                           │
│                                                 │
│ SQL Query:                                      │
│ ┌──────────────────────────────────────────┐  │
│ │ SELECT * FROM users WHERE active = true   │  │
│ │ ORDER BY created_at DESC                  │  │
│ └──────────────────────────────────────────┘  │
│ Only SELECT queries allowed for safety         │
│                                                 │
│ [▶ Run Query]                                  │
│                                                 │
│ 👥 25 rows | ⏱️ 45ms                            │
│ ┌──────────────────────────────────────────┐  │
│ │ id │ name  │ email        │ active      │  │
│ │ 1  │ Alice │ alice@...    │ true        │  │
│ │ 2  │ Bob   │ bob@...      │ true        │  │
│ └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

---

## 🔌 Backend Alignment

### All Endpoints Work
✅ `GET /datasources` - List all
✅ `POST /datasources` - Create
✅ `PUT /datasources/{id}` - Update
✅ `DELETE /datasources/{id}` - Delete
✅ `POST /datasources/test` - Test connection
✅ `POST /datasources/query` - Execute query

### Backend Features Used
✅ SQL validation (SELECT-only)
✅ Type-safe config models
✅ Query timeout support
✅ Connection pooling
✅ Error handling

---

## 📦 Files Summary

### Created (3 components)
- `frontend/src/components/datasources/DataSourceForm.tsx` (280 lines)
- `frontend/src/components/datasources/DataSourceList.tsx` (140 lines)
- `frontend/src/components/datasources/QueryRunner.tsx` (220 lines)

### Updated (1 page)
- `frontend/src/app/datasources/page.tsx` (310 lines)

### Already Existed (reused)
- `frontend/src/hooks/use-datasources.ts`
- `frontend/src/lib/api/datasources.ts`
- `frontend/src/types/api.ts`

### Documentation (3 files)
- `PROMPT_2B_SUMMARY.md` - Full implementation guide
- `BACKEND_API_REFERENCE.md` - API specifications
- `COMPONENT_ARCHITECTURE.md` - Technical diagrams

---

## 🎯 Key Features

### 1. Dynamic Form Fields
Form changes based on database type:
- **PostgreSQL/MySQL**: host, port, database, username, password
- **BigQuery**: project_id, credentials_json, default_dataset

### 2. Connection Testing
Test button on each data source:
- Calls backend `/datasources/test` endpoint
- Shows green toast on success
- Shows red toast on failure
- Auto-dismisses after 5 seconds

### 3. Ad-Hoc Query Runner
Full SQL execution interface:
- Data source selector
- Configurable limit and timeout
- Results table with scrolling
- Execution time and row count
- Error handling with messages

### 4. Full CRUD
- **Create**: Form with validation
- **Read**: Table view with pagination support
- **Update**: Edit form (type locked after creation)
- **Delete**: Confirmation dialog

---

## 🧪 Test Scenarios

### Scenario 1: Create PostgreSQL
1. Click "New Data Source"
2. Fill: Name, select PostgreSQL, enter config
3. Click "Create"
4. ✅ See new row in table

### Scenario 2: Test Connection
1. Click test icon on any row
2. ✅ See green toast: "Connection Successful"

### Scenario 3: Run Query
1. Click "Run Query"
2. Select data source
3. Enter: `SELECT 1 as test`
4. Click "Run Query"
5. ✅ See result: `test | 1`

### Scenario 4: Edit Data Source
1. Click edit icon
2. Change description
3. Click "Update"
4. ✅ See updated description

### Scenario 5: Delete Data Source
1. Click trash icon
2. Confirm deletion
3. ✅ Row removed from table

### Scenario 6: Error Handling
1. Create with invalid config (e.g., wrong port)
2. Test connection
3. ✅ See red toast with error message

### Scenario 7: SQL Validation
1. Try to run: `DELETE FROM users`
2. ✅ See error: "Query must start with SELECT"

---

## 💡 Tips

### Development
- Backend auto-reloads on code changes
- Frontend hot-reloads on save
- Check browser console for API logs
- Check terminal for backend logs

### Debugging
```powershell
# Check backend health
curl http://localhost:8000/health

# Check API response
curl http://localhost:8000/api/v1/datasources/

# Check environment
echo $env:NEXT_PUBLIC_API_URL
```

### Customization
Want to add a new database type?
1. Backend: Add to `DataSourceType` enum
2. Backend: Create config model (e.g., `RedshiftConfig`)
3. Frontend: Add case in form's `renderConfigFields()`

---

## 📚 Documentation

| File | Purpose |
|------|---------|
| `PROMPT_2B_SUMMARY.md` | Complete feature documentation |
| `BACKEND_API_REFERENCE.md` | API endpoint specifications |
| `COMPONENT_ARCHITECTURE.md` | Component diagrams and flows |
| `DATASOURCES_QUICKSTART.md` | This file |

---

## ✨ What's Next?

With Data Sources complete, you can now:

1. **Use the Query Runner**: Test SQL queries against your databases
2. **Build Datasets UI**: Save frequently used queries
3. **Build Charts UI**: Visualize query results
4. **Build Dashboards UI**: Combine multiple charts

---

## 🎉 Success!

You now have a fully functional Data Sources management interface with:
- ✅ Create/Edit/Delete data sources
- ✅ Test connections
- ✅ Run ad-hoc SQL queries
- ✅ View results in tables
- ✅ Type-safe config validation
- ✅ SQL safety (SELECT-only)
- ✅ Error handling
- ✅ Loading states
- ✅ Responsive design

Enjoy! 🚀
