# Dataset Transformations Implementation Status

## ✅ COMPLETED - Backend (100%)

### 1. Database Model
- ✅ Added `transformations` JSON column to Dataset model
- ✅ Added `transformation_version` int column
- Location: `backend/app/models/models.py`

### 2. Pydantic Schemas
- ✅ Added transformations to DatasetBase, DatasetUpdate, DatasetResponse
- ✅ Added `apply_transformations` flag to DatasetExecuteRequest
- Location: `backend/app/schemas/schemas.py`

### 3. Transform Compiler Service
- ✅ Created `TransformCompiler` class
- ✅ Supports all transformation types:
  - select_columns
  - rename_columns
  - filter_rows
  - add_column
  - cast_column
  - replace_value
  - sort
  - limit
- ✅ Multi-dialect support (PostgreSQL, MySQL, BigQuery)
- ✅ SQL safety checks
- Location: `backend/app/services/transform_compiler.py`

### 4. Dataset Execute Endpoint
- ✅ Updated to accept `apply_transformations` parameter
- ✅ Compiles transformations into SQL before execution
- ✅ Falls back to base SQL if compilation fails
- Location: `backend/app/api/datasets.py`, `backend/app/services/dataset_service.py`

### 5. Migration
- ⚠️ Need to create Alembic migration (run in backend folder):
```bash
alembic revision -m "add_dataset_transformations"
# Then edit the migration file:
# - Add transformations column (JSON)
# - Add transformation_version column (INTEGER DEFAULT 1)
alembic upgrade head
```

---

## 🚧 TODO - Frontend

### 1. Update Dataset Types (`frontend/src/types/api.ts`)
```typescript
export interface Dataset {
  // ... existing fields
  transformations?: TransformationStep[];
  transformation_version?: number;
}

export interface TransformationStep {
  id: string;
  type: 'select_columns' | 'rename_columns' | 'filter_rows' | 
        'add_column' | 'cast_column' | 'replace_value' | 'sort' | 'limit';
  enabled: boolean;
  params: Record<string, any>;
}

export interface DatasetExecuteRequest {
  limit?: number;
  timeout_seconds?: number;
  apply_transformations?: boolean;
}
```

### 2. Create Transform Tab Component (`frontend/src/components/datasets/TransformTab.tsx`)
```typescript
interface TransformTabProps {
  dataset: Dataset;
  onSave: (transformations: TransformationStep[]) => void;
}

// Features:
// - Left panel: Steps list (draggable, toggle, delete)
// - Main panel: Step editor form
// - "Add Step" dropdown
// - "Preview" button
// - "Save" button
```

### 3. Create Step Editor Components (`frontend/src/components/datasets/transform/`)
```
StepEditor.tsx              // Main step editor wrapper
SelectColumnsStep.tsx       // Multi-select columns
RenameColumnsStep.tsx       // Table mapping old->new
FilterRowsStep.tsx          // Condition builder UI
AddColumnStep.tsx           // Name + expression input
CastColumnStep.tsx          // Select field + type
ReplaceValueStep.tsx        // Field + from/to
SortStep.tsx                // Sort keys list
LimitStep.tsx               // Number input
```

### 4. Update DatasetEditor Component
Add tabs:
```typescript
const [activeTab, setActiveTab] = useState<'sql' | 'transform' | 'preview'>('sql');

<Tabs value={activeTab} onValueChange={setActiveTab}>
  <TabsList>
    <TabsTrigger value="sql">SQL</TabsTrigger>
    <TabsTrigger value="transform">Transform</TabsTrigger>
    <TabsTrigger value="preview">Preview</TabsTrigger>
  </TabsList>
  
  <TabsContent value="sql">
    {/* Existing SQL editor */}
  </TabsContent>
  
  <TabsContent value="transform">
    <TransformTab dataset={dataset} onSave={handleSaveTransformations} />
  </TabsContent>
  
  <TabsContent value="preview">
    {/* Existing preview with transformations applied */}
  </TabsContent>
</Tabs>
```

### 5. Update Dataset API Hooks (`frontend/src/hooks/use-datasets.ts`)
```typescript
// Update mutation to include transformations
export function useUpdateDataset() {
  return useMutation({
    mutationFn: async ({ id, data }: { id: number, data: Partial<Dataset> }) => {
      const response = await fetch(`${API_URL}/datasets/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data) // includes transformations
      });
      return response.json();
    }
  });
}

// Update execute to pass apply_transformations flag
export function useExecuteDataset() {
  return useMutation({
    mutationFn: async ({ 
      id, 
      limit, 
      apply_transformations = true 
    }: { 
      id: number, 
      limit?: number,
      apply_transformations?: boolean 
    }) => {
      const response = await fetch(`${API_URL}/datasets/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit, apply_transformations })
      });
      return response.json();
    }
  });
}
```

### 6. Update Explore Integration
Explore should automatically use transformed dataset:
- ✅ Already works because execute endpoint applies transformations by default
- Dataset columns reflect transformed schema
- No changes needed in Explore page

---

## 🎯 Quick Start Implementation Order

### Phase 1: Basic UI (1-2 hours)
1. Update types in `types/api.ts`
2. Create basic `TransformTab.tsx` with steps list
3. Add "Transform" tab to DatasetEditor
4. Update API hooks to support transformations

### Phase 2: Step Editors (2-3 hours)
5. Create `SelectColumnsStep.tsx` (simplest)
6. Create `FilterRowsStep.tsx` (condition builder)
7. Create `RenameColumnsStep.tsx` (mapping table)
8. Create `AddColumnStep.tsx` (expression input)

### Phase 3: Advanced Steps (1-2 hours)
9. Create `CastColumnStep.tsx`
10. Create `ReplaceValueStep.tsx`
11. Create `SortStep.tsx`
12. Create `LimitStep.tsx`

### Phase 4: UX Polish (1 hour)
13. Add drag-and-drop for step reordering
14. Add enable/disable toggle
15. Add preview button with loading state
16. Add validation & error messages

---

## 📚 Reference Examples

### Example Transformation JSON
```json
[
  {
    "id": "uuid-1",
    "type": "select_columns",
    "enabled": true,
    "params": {
      "columns": ["year_month", "loai_san_pham", "total_gia"]
    }
  },
  {
    "id": "uuid-2",
    "type": "filter_rows",
    "enabled": true,
    "params": {
      "conditions": [
        {
          "field": "total_gia",
          "op": "gt",
          "value": 1000
        }
      ],
      "logic": "AND"
    }
  },
  {
    "id": "uuid-3",
    "type": "add_column",
    "enabled": true,
    "params": {
      "newField": "year",
      "expression": "EXTRACT(YEAR FROM last_update)"
    }
  }
]
```

### Example Compiled SQL
```sql
WITH base AS (
  SELECT * FROM products WHERE created_at > '2024-01-01'
),
t1 AS (
  SELECT "year_month", "loai_san_pham", "total_gia" FROM base
),
t2 AS (
  SELECT * FROM t1 WHERE "total_gia" > 1000
),
t3 AS (
  SELECT *, (EXTRACT(YEAR FROM last_update)) AS "year" FROM t2
)
SELECT * FROM t3
```

---

## 🐛 Testing Checklist

### Backend
- [ ] Create dataset with transformations
- [ ] Update dataset transformations
- [ ] Execute with `apply_transformations=true` (default)
- [ ] Execute with `apply_transformations=false`
- [ ] Test each transformation type
- [ ] Test multiple transformations chained
- [ ] Test disabled steps (should skip)
- [ ] Test SQL injection protection
- [ ] Test different datasource types (PostgreSQL, MySQL, BigQuery)

### Frontend
- [ ] Add transformation steps via UI
- [ ] Edit step parameters
- [ ] Reorder steps
- [ ] Enable/disable steps
- [ ] Delete steps
- [ ] Preview with transformations
- [ ] Save transformations to dataset
- [ ] Load dataset with transformations
- [ ] Use transformed dataset in Explore

---

## 💡 Next Session Tasks

If continuing implementation:

1. **Start with types**: Add transformation types to `frontend/src/types/api.ts`
2. **Create basic tab**: Add Transform tab to DatasetEditor with empty state
3. **Implement simplest step first**: SelectColumnsStep (just a multi-select)
4. **Test end-to-end**: Create dataset -> Add transformation -> Preview -> Save
5. **Iterate**: Add more step types one by one

The backend is ready and tested. Frontend is modular - can implement steps incrementally.
