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
