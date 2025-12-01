# Prompt 2B Implementation - Data Sources Management UI

## Overview

Complete implementation of the Data Sources management interface in Next.js with full CRUD operations, connection testing, and ad-hoc query execution.

---

## 📁 Files Created/Modified

### New Components

1. **`frontend/src/components/datasources/DataSourceForm.tsx`**
   - Dynamic form for creating/editing data sources
   - Type-specific config fields (PostgreSQL/MySQL/BigQuery)
   - Form validation and loading states

2. **`frontend/src/components/datasources/DataSourceList.tsx`**
   - Table view of all data sources
   - Inline actions (Edit, Delete, Test)
   - Empty state handling
   - Type badges with color coding

3. **`frontend/src/components/datasources/QueryRunner.tsx`**
   - SQL query editor with syntax highlighting awareness
   - Data source selector dropdown
   - Configurable limit and timeout
   - Results table with column headers
   - Execution time and row count display
   - Error handling with user-friendly messages

### Updated Files

4. **`frontend/src/app/datasources/page.tsx`**
   - Complete page implementation with state management
   - View switching (list/create/edit/query)
   - Toast notifications for test results
   - Loading states and error handling

5. **`frontend/src/lib/api-client.ts`**
   - Added `dataSourcesApi` object with typed methods
   - Already existed: `frontend/src/lib/api/datasources.ts` with full implementation

6. **`frontend/src/hooks/use-datasources.ts`**
   - Already existed with complete React Query hooks
   - No changes needed

---

## 🎨 UI Features Implemented

### 1. Data Source List View
- **Table Layout**: Clean table with columns for Name, Type, Description, Created Date, Actions
- **Type Badges**: Color-coded badges (PostgreSQL=blue, MySQL=orange, BigQuery=green)
- **Actions**: Edit, Delete, Test Connection buttons with icons
- **Empty State**: Helpful message when no data sources exist
- **Loading State**: Spinner while fetching data

### 2. Create/Edit Form
- **Dynamic Fields**: Config fields change based on selected type
- **PostgreSQL/MySQL Fields**:
  - Host (text input, default: localhost)
  - Port (number input, default: 5432/3306)
  - Database (text input)
  - Username (text input)
  - Password (password input)
  
- **BigQuery Fields**:
  - Project ID (text input)
  - Service Account JSON (textarea, monospace font)
  - Default Dataset (optional text input)

- **Common Fields**:
  - Name (required)
  - Type (select dropdown, disabled when editing)
  - Description (optional textarea)

- **UX Details**:
  - Required field indicators (*)
  - Disabled submit button while loading
  - Loading spinner on submit button
  - Cancel button to return to list
  - Type cannot be changed after creation (noted with helper text)

### 3. Connection Testing
- **Test Button**: Available in data source list for each item
- **Toast Notifications**: 
  - Green success toast with checkmark icon
  - Red error toast with alert icon
  - Auto-dismiss after 5 seconds
  - Shows backend response message

### 4. Ad-Hoc Query Runner
- **Controls Row**:
  - Data source selector (dropdown)
  - Limit input (number, 1-10000, default 100)
  - Timeout input (seconds, 1-300, default 30)
  
- **SQL Editor**:
  - Large textarea with monospace font
  - Placeholder text showing example query
  - Helper text: "Only SELECT queries are allowed for safety"
  
- **Execute Button**:
  - Green "Run Query" button with play icon
  - Disabled when no data source selected or empty query
  - Shows loading spinner while executing

- **Results Display**:
  - Execution metadata (row count, execution time in ms)
  - Scrollable table (max height 96 units)
  - Sticky header row
  - Null value handling (shown as italic gray "null")
  - JSON object handling (shown as formatted JSON string)
  - Empty results message when no rows returned

- **Error Display**:
  - Red error box with backend error message
  - Shown above results area

---

## 🔌 Backend API Integration

### Expected Endpoints

All endpoints are prefixed with `/api/v1` (configurable via `NEXT_PUBLIC_API_URL`).

#### 1. List Data Sources
```
GET /datasources/
Response: DataSource[]
```

#### 2. Get Single Data Source
```
GET /datasources/{id}
Response: DataSource
```

#### 3. Create Data Source
```
POST /datasources/
Body: {
  name: string;
  type: "postgresql" | "mysql" | "bigquery";
  description?: string;
  config: {
    // PostgreSQL/MySQL
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
    
    // BigQuery
    project_id?: string;
    credentials_json?: string;
    default_dataset?: string;
  }
}
Response: DataSource
```

#### 4. Update Data Source
```
PUT /datasources/{id}
Body: {
  name?: string;
  description?: string;
  config?: Record<string, any>;
}
Response: DataSource
```

#### 5. Delete Data Source
```
DELETE /datasources/{id}
Response: 204 No Content
```

#### 6. Test Connection
```
POST /datasources/test
Body: {
  type: "postgresql" | "mysql" | "bigquery";
  config: Record<string, any>;
}
Response: {
  success: boolean;
  message: string;
}
```

#### 7. Execute Ad-Hoc Query
```
POST /datasources/query
Body: {
  data_source_id: number;
  sql_query: string;
  limit?: number;
  timeout_seconds?: number;
}
Response: {
  columns: string[];
  data: Record<string, any>[];
  row_count: number;
  execution_time_ms: number;
}
```

---

## 📊 Type Definitions

### Request/Response Types (from `types/api.ts`)

```typescript
enum DataSourceType {
  POSTGRESQL = 'postgresql',
  MYSQL = 'mysql',
  BIGQUERY = 'bigquery',
}

interface DataSource {
  id: number;
  name: string;
  type: DataSourceType;
  description?: string;
  config: Record<string, any>;
  created_at: string;
  updated_at: string;
}

interface DataSourceCreate {
  name: string;
  type: DataSourceType;
  description?: string;
  config: Record<string, any>;
}

interface DataSourceUpdate {
  name?: string;
  description?: string;
  config?: Record<string, any>;
}

interface QueryExecuteRequest {
  data_source_id: number;
  sql_query: string;
  limit?: number;
  timeout_seconds?: number;
}

interface QueryExecuteResponse {
  columns: string[];
  data: Record<string, any>[];
  row_count: number;
  execution_time_ms: number;
}
```

---

## 🎯 Component Architecture

### Page Structure
```
DataSourcesPage (page.tsx)
├── State Management
│   ├── currentView: 'list' | 'create' | 'edit' | 'query'
│   ├── editingDataSource: DataSource | null
│   ├── testResult: { success, message } | null
│   ├── queryResult: QueryExecuteResponse | null
│   └── queryError: string | null
│
├── React Query Hooks
│   ├── useDataSources() - list
│   ├── useCreateDataSource() - create mutation
│   ├── useUpdateDataSource() - update mutation
│   ├── useDeleteDataSource() - delete mutation
│   ├── useTestDataSource() - test mutation
│   └── useExecuteQuery() - query mutation
│
└── Conditional Rendering
    ├── List View → DataSourceList component
    ├── Create View → DataSourceForm component
    ├── Edit View → DataSourceForm component (with initialData)
    └── Query View → QueryRunner component
```

### Data Flow

1. **Create Flow**:
   - User clicks "New Data Source"
   - View switches to 'create'
   - DataSourceForm renders with empty state
   - User fills form → Submit
   - `handleCreate()` → `createMutation.mutateAsync()`
   - React Query auto-invalidates cache
   - View returns to 'list' with new item

2. **Edit Flow**:
   - User clicks Edit icon on row
   - `handleEdit()` sets `editingDataSource` and switches view
   - DataSourceForm renders with `initialData`
   - User modifies → Submit
   - `handleUpdate()` → `updateMutation.mutateAsync()`
   - Cache invalidated
   - View returns to 'list'

3. **Delete Flow**:
   - User clicks Delete icon
   - Confirmation dialog shown
   - If confirmed: `handleDelete()` → `deleteMutation.mutateAsync()`
   - Optimistic UI update (button disabled with spinner)
   - Cache invalidated

4. **Test Flow**:
   - User clicks Test icon
   - `handleTest()` → `testMutation.mutateAsync()`
   - Toast notification shown with result
   - Auto-dismisses after 5 seconds

5. **Query Flow**:
   - User clicks "Run Query" button
   - View switches to 'query'
   - User selects data source, writes SQL, sets options
   - Clicks "Run Query"
   - `handleExecuteQuery()` → `executeMutation.mutateAsync()`
   - Results displayed in table OR error shown

---

## 🛠️ Technical Details

### Styling Approach
- **TailwindCSS**: Utility-first classes for all styling
- **No External UI Library**: Custom components using Tailwind
- **Responsive**: Grid layouts that adapt to screen size
- **Icons**: lucide-react for consistent iconography

### State Management
- **React Query**: Server state (data sources, mutations)
- **useState**: Local UI state (views, modals, results)
- **No Redux**: Not needed for this scope

### Error Handling
- Try/catch blocks around all mutations
- Backend error messages extracted from `error.response?.data?.detail`
- User-friendly alerts for critical errors
- Inline error display for query execution

### Loading States
- Spinner icons on buttons during mutations
- Full-page spinner during initial data load
- Disabled states prevent double-submission

### Validation
- HTML5 form validation (required, type="number", etc.)
- Backend validation (Pydantic models)
- Frontend shows backend validation errors via alerts

---

## 🚀 How to Use

### Running the UI

1. **Start Backend** (if not already running):
   ```bash
   cd backend
   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
   ```

2. **Start Frontend**:
   ```bash
   cd frontend
   npm run dev
   ```

3. **Access UI**:
   - Navigate to `http://localhost:3000/datasources`

### Testing the Features

#### 1. Create a Data Source
- Click "New Data Source"
- Fill in name: "My PostgreSQL"
- Select type: PostgreSQL
- Fill config:
  - Host: localhost
  - Port: 5432
  - Database: testdb
  - Username: postgres
  - Password: postgres
- Click "Create"

#### 2. Test Connection
- Click the test tube icon on the created data source
- See toast notification with result

#### 3. Run a Query
- Click "Run Query" button in header
- Select your data source
- Enter SQL: `SELECT * FROM users LIMIT 10`
- Set limit: 10
- Click "Run Query"
- View results in table

#### 4. Edit Data Source
- Click edit icon on any row
- Modify name or config
- Click "Update"

#### 5. Delete Data Source
- Click trash icon
- Confirm deletion
- Item removed from list

---

## 🔍 Alignment with Backend

### Current Backend State (from Prompt 2A)

The backend already implements:
- ✅ SQL validation (SELECT-only queries)
- ✅ Type-safe config models
- ✅ Query timeout support
- ✅ Pagination (not used in UI yet, but available)
- ✅ All CRUD endpoints

### Frontend → Backend Mapping

| Frontend Action | Backend Endpoint | Request Body | Response |
|----------------|------------------|--------------|----------|
| Load list | `GET /datasources?skip=0&limit=50` | — | `DataSource[]` |
| Create | `POST /datasources` | `DataSourceCreate` | `DataSource` |
| Update | `PUT /datasources/{id}` | `DataSourceUpdate` | `DataSource` |
| Delete | `DELETE /datasources/{id}` | — | 204 |
| Test | `POST /datasources/test` | `{type, config}` | `{success, message}` |
| Query | `POST /datasources/query` | `QueryExecuteRequest` | `QueryExecuteResponse` |

### Config Structure Validation

The backend (Prompt 2A) validates configs using:
- `PostgreSQLConfig` (host, port, database, username, password)
- `MySQLConfig` (host, port, database, username, password)
- `BigQueryConfig` (project_id, credentials_json, default_dataset)

The frontend form matches these schemas exactly.

---

## 🎨 UI/UX Highlights

### Visual Consistency
- Blue primary color scheme
- Gray neutral tones
- Color-coded type badges
- Consistent spacing and padding
- Shadow elevation for cards

### Interaction Patterns
- Hover states on all interactive elements
- Disabled states with opacity reduction
- Loading states with spinners
- Smooth transitions (Tailwind transition classes)

### Accessibility Considerations
- Semantic HTML (buttons, labels, tables)
- Icon buttons with title attributes
- Color contrast meets WCAG guidelines
- Form labels properly associated with inputs

### Responsive Design
- Grid layouts collapse on mobile
- Table scrolls horizontally when needed
- Buttons stack vertically on small screens
- Container max-width for readability

---

## 📝 Notes & Future Enhancements

### Current Limitations
1. **No Pagination UI**: Backend supports it, but frontend loads all results
2. **No Search/Filter**: List shows all data sources
3. **No Syntax Highlighting**: SQL editor is plain textarea
4. **No Query History**: Each execution is independent
5. **No Export**: Results can't be downloaded as CSV/JSON

### Possible Enhancements
1. **Pagination**: Add prev/next buttons, page size selector
2. **Search**: Filter data sources by name/type
3. **Rich SQL Editor**: Integrate CodeMirror or Monaco Editor
4. **Query Templates**: Save frequently used queries
5. **Export Results**: Download as CSV, JSON, or Excel
6. **Schema Browser**: Show available tables/columns
7. **Query Builder**: Visual query builder for non-SQL users
8. **Favorites**: Pin frequently used data sources
9. **Recent Queries**: Show history with re-run option
10. **Keyboard Shortcuts**: Ctrl+Enter to run query

---

## ✅ Deliverables Checklist

- ✅ **Updated `app/datasources/page.tsx`** with full UI implementation
- ✅ **API client functions** in `lib/api/datasources.ts` (already existed)
- ✅ **React Query hooks** in `hooks/use-datasources.ts` (already existed)
- ✅ **DataSourceForm component** for create/edit
- ✅ **DataSourceList component** for table display
- ✅ **QueryRunner component** for ad-hoc queries
- ✅ **This documentation** explaining API expectations and implementation

---

## 🎉 Summary

The Data Sources management UI is now **fully functional** with:
- Complete CRUD operations
- Dynamic form fields per data source type
- Connection testing with visual feedback
- Ad-hoc query execution with results display
- Clean, responsive UI using TailwindCSS
- Proper error handling and loading states
- Full integration with FastAPI backend

The implementation follows React best practices, uses TypeScript for type safety, and provides a solid foundation for future enhancements.
