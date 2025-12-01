# Prompt 3C Complete: Dashboard Builder with Drag-and-Drop Layout

## ✅ Implementation Summary

Successfully built a complete Dashboard Builder UI with drag-and-drop functionality using react-grid-layout, allowing users to compose multiple charts into interactive dashboards with customizable layouts.

## 📦 Deliverables

### Components Created

1. **ChartTile.tsx** (68 lines)
   - Individual chart tile component
   - Integrates with ChartPreview from Prompt 3B
   - Remove button with hover effect
   - Loading and error states

2. **DashboardGrid.tsx** (92 lines)
   - React-grid-layout integration
   - Responsive grid with breakpoints
   - Drag and resize functionality
   - Layout persistence
   - Empty state handling

3. **AddChartModal.tsx** (170 lines)
   - Modal for adding charts to dashboard
   - Chart selector dropdown
   - Size configuration (width/height)
   - Filters out already-added charts

4. **DashboardList.tsx** (95 lines)
   - Table view of all dashboards
   - Chart count display
   - Open and Delete actions
   - Empty state

### Pages Created/Updated

5. **dashboards/page.tsx** (180 lines)
   - Dashboard list view
   - Create dashboard modal
   - Full CRUD operations
   - Navigation to dashboard builder

6. **dashboards/[id]/page.tsx** (270 lines)
   - Main dashboard builder interface
   - Inline name editing
   - Add/remove charts
   - Auto-save layout with debouncing
   - Real-time layout updates

### Existing Infrastructure Used

- ✅ `lib/api/dashboards.ts` - Already had all 8 endpoints
- ✅ `hooks/use-dashboards.ts` - Already had all React Query hooks
- ✅ `types/api.ts` - Already had Dashboard, DashboardChart, DashboardChartLayout types

## 🎯 Key Features Implemented

### 1. Dashboard Management

**Create Dashboard:**
- Simple form with name and description
- Modal interface
- Instant creation and navigation

**List Dashboards:**
- Table view with metadata
- Chart count per dashboard
- Creation date
- Quick actions (Open, Delete)

**Delete Dashboard:**
- Confirmation dialog
- Removes dashboard and all chart arrangements
- Loading state during deletion

### 2. Dashboard Builder

**Layout Editor:**
- Drag-and-drop chart positioning
- Resize charts by dragging corners
- Grid-based layout (12 columns)
- Responsive breakpoints
- Auto-save with 1-second debounce

**Add Charts:**
- Modal with chart selector
- Size configuration (2-12 columns, 2-10 rows)
- Prevents adding duplicate charts
- New charts placed at top (x:0, y:0)

**Remove Charts:**
- Hover to reveal remove button
- Confirmation dialog
- Loading state during removal
- Immediate UI update

**Inline Editing:**
- Click edit icon to rename dashboard
- Save/cancel buttons
- Persists immediately

### 3. Layout System

**react-grid-layout Integration:**
```typescript
// Backend layout format
{
  id: number,          // dashboard_chart_id
  chart_id: number,
  layout: {
    x: number,         // Column position (0-11)
    y: number,         // Row position
    w: number,         // Width in columns
    h: number          // Height in rows
  }
}

// Converted to RGL format
{
  i: string,           // dashboard_chart_id as string
  x: number,
  y: number,
  w: number,
  h: number,
  minW: 2,            // Minimum 2 columns
  minH: 2             // Minimum 2 rows
}
```

**Auto-save Flow:**
1. User drags/resizes chart
2. `onLayoutChange` triggered
3. Debounce timer starts (1 second)
4. After 1 second of inactivity:
   - Layout converted to backend format
   - API call: `PUT /dashboards/{id}/layout`
   - "Saving..." indicator shown
5. Success → cache invalidated, data refetched
6. UI updates automatically

## 🔄 User Workflows

### Creating and Building a Dashboard

**Step 1: Create Dashboard**
1. Navigate to `/dashboards`
2. Click "Create Dashboard"
3. Enter name: "Sales Performance Dashboard"
4. Enter description (optional)
5. Click "Create"
6. Automatically opens dashboard builder

**Step 2: Add First Chart**
1. Click "Add Chart" button
2. Select chart from dropdown (e.g., "Monthly Revenue Bar Chart")
3. Set size: width=6, height=4
4. Click "Add Chart"
5. Chart appears at top of grid

**Step 3: Add More Charts**
1. Click "Add Chart" again
2. Select "Customer Distribution Pie Chart"
3. Set size: width=6, height=4
4. Click "Add Chart"
5. Chart appears next to first chart

**Step 4: Arrange Layout**
1. Drag first chart to top-left
2. Drag second chart to top-right
3. Add third chart below
4. Resize charts by dragging corners
5. Layout auto-saves after each change
6. "Saving..." indicator appears briefly

**Step 5: Remove Chart (if needed)**
1. Hover over chart tile
2. Click red X button in top-right corner
3. Confirm removal
4. Chart removed instantly
5. Grid reflows automatically

### Editing Dashboard Name

1. Click edit icon next to dashboard name
2. Type new name in input field
3. Click green checkmark to save
4. Or click X to cancel
5. Name updates immediately

### Opening Existing Dashboard

1. From `/dashboards`, click eye icon on dashboard row
2. Dashboard builder opens with saved layout
3. All charts render with their data
4. Can immediately start rearranging

## 🧩 Component Architecture

### ChartTile Component

**Purpose:** Renders individual chart in dashboard grid

**Key Features:**
- Fetches chart metadata with `useChart(chartId)`
- Fetches chart data with `useChartData(chartId)`
- Reuses `<ChartPreview>` from Prompt 3B
- Remove button visible on hover
- Loading spinner while fetching
- Error state if chart fails to load

**Props:**
```typescript
interface ChartTileProps {
  chartId: number;              // Chart to display
  dashboardChartId: number;     // Dashboard-chart relationship ID
  onRemove: (dcId: number) => void;
  isRemoving?: boolean;         // Loading state for remove button
}
```

**Structure:**
```
┌────────────────────────────────┐
│ ┌────┐ Remove (X) button       │
│ │    │ (visible on hover)      │
│ └────┘                         │
│                                │
│ Chart Name                     │
│ Description                    │
│                                │
│ ╔════════════════════════════╗ │
│ ║                            ║ │
│ ║    ChartPreview Component  ║ │
│ ║    (Bar/Line/Pie/TimeSeries)║ │
│ ║                            ║ │
│ ╚════════════════════════════╝ │
└────────────────────────────────┘
```

### DashboardGrid Component

**Purpose:** Grid container with drag-and-drop functionality

**Props:**
```typescript
interface DashboardGridProps {
  dashboardCharts: DashboardChart[];
  onLayoutChange: (layouts: Layout[]) => void;
  onRemoveChart: (dashboardChartId: number) => void;
  removingChartId?: number;
}
```

**react-grid-layout Configuration:**
```typescript
<ResponsiveGridLayout
  layouts={{ lg: layouts }}
  breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
  cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
  rowHeight={80}
  onLayoutChange={handleLayoutChange}
  draggableHandle=".drag-handle"
  isDraggable={true}
  isResizable={true}
  compactType="vertical"
  preventCollision={false}
>
```

**Key Settings:**
- **12-column grid** on large screens
- **80px row height**
- **Vertical compacting** (items move up to fill gaps)
- **Drag handle:** Entire tile is draggable (`.drag-handle` class)
- **Min size:** 2x2 (prevents too-small charts)

### AddChartModal Component

**Purpose:** Modal for adding charts to dashboard

**Features:**
- Lists all available charts
- Filters out charts already in dashboard
- Size configuration with validation
- Shows helpful tip about positioning
- Disabled state while adding

**Size Constraints:**
- Width: 2-12 columns (default 4)
- Height: 2-10 rows (default 4)
- Charts placed at x:0, y:0 initially
- User can reposition after adding

### DashboardList Component

**Purpose:** Table view of all dashboards

**Columns:**
- Name + Description
- Chart count
- Created date
- Actions (Open, Delete)

**Features:**
- Empty state with helpful message
- Hover effect on rows
- Loading spinner for delete action
- Navigation to builder via useRouter

### Dashboard Builder Page

**Purpose:** Main dashboard editing interface

**State Management:**
```typescript
const [isAddChartModalOpen, setIsAddChartModalOpen] = useState(false);
const [removingChartId, setRemovingChartId] = useState<number>();
const [isEditingName, setIsEditingName] = useState(false);
const [editedName, setEditedName] = useState('');
const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
```

**Debounce Implementation:**
```typescript
// Custom hook for debouncing
function useDebounce<T extends (...args: any[]) => any>(
  callback: T,
  delay: number
): (...args: Parameters<T>) => void {
  const [timeoutId, setTimeoutId] = useState<NodeJS.Timeout | null>(null);

  return useCallback(
    (...args: Parameters<T>) => {
      if (timeoutId) clearTimeout(timeoutId);
      const id = setTimeout(() => callback(...args), delay);
      setTimeoutId(id);
    },
    [callback, delay, timeoutId]
  );
}

// Usage
const debouncedSaveLayout = useDebounce(
  async (layouts: Layout[]) => {
    // Convert and save layout
    await updateLayoutMutation.mutateAsync({
      dashboardId,
      chartLayouts,
    });
  },
  1000 // 1 second
);
```

**Layout Update Process:**
1. `handleLayoutChange` triggered by grid
2. Sets `hasUnsavedChanges` to true
3. Calls `debouncedSaveLayout`
4. Debounce waits 1 second
5. Converts RGL format to backend format
6. Calls API: `PUT /dashboards/{id}/layout`
7. On success: invalidates cache, sets `hasUnsavedChanges` to false

## 🔌 API Integration

### Endpoints Used

**Dashboard CRUD:**
```typescript
GET    /dashboards              // List all
GET    /dashboards/{id}         // Get with charts
POST   /dashboards              // Create new
PUT    /dashboards/{id}         // Update name/description
DELETE /dashboards/{id}         // Delete dashboard
```

**Chart Management:**
```typescript
POST   /dashboards/{id}/charts         // Add chart
DELETE /dashboards/{id}/charts/{chart_id}  // Remove chart
PUT    /dashboards/{id}/layout         // Update all layouts
```

**Payload Formats:**

**Add Chart:**
```json
{
  "chart_id": 5,
  "layout": {
    "x": 0,
    "y": 0,
    "w": 4,
    "h": 4
  }
}
```

**Update Layout:**
```json
{
  "chart_layouts": [
    {
      "id": 1,           // dashboard_chart_id
      "layout": {
        "x": 0,
        "y": 0,
        "w": 6,
        "h": 4
      }
    },
    {
      "id": 2,
      "layout": {
        "x": 6,
        "y": 0,
        "w": 6,
        "h": 4
      }
    }
  ]
}
```

### Data Flow

**Loading Dashboard:**
```
1. useDashboard(id) fetches from /dashboards/{id}
2. Response includes:
   - Dashboard info (name, description, created_at)
   - dashboard_charts array:
     - id (dashboard_chart_id)
     - chart_id
     - layout {x, y, w, h}
3. DashboardGrid converts layouts for RGL
4. Each ChartTile fetches its own chart data
```

**Adding Chart:**
```
1. User selects chart + size in modal
2. addChartMutation.mutateAsync() called
3. POST /dashboards/{id}/charts
4. Backend creates dashboard_chart record
5. Returns updated dashboard
6. useDashboard cache invalidated
7. Dashboard refetches
8. New chart appears in grid
```

**Layout Update:**
```
1. User drags/resizes chart
2. RGL calls onLayoutChange with new Layout[]
3. Debounce timer resets (1 second)
4. After 1 second of inactivity:
   - Layout converted to backend format
   - updateLayoutMutation.mutateAsync() called
   - PUT /dashboards/{id}/layout
5. Backend updates all layouts
6. useDashboard cache invalidated
7. Dashboard refetches (but no visual change)
```

## 🎨 Styling and UX

### Grid Layout Styles

**CSS Required:**
```tsx
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
```

**Custom Classes:**
- `.drag-handle` - Makes entire tile draggable
- `.group` - Tailwind group for hover effects
- `.group-hover:opacity-100` - Show remove button on hover

### Visual Indicators

**Layout Saving:**
```tsx
{hasUnsavedChanges && (
  <span className="text-sm text-gray-500 flex items-center">
    <Loader2 className="h-4 w-4 animate-spin mr-1" />
    Saving...
  </span>
)}
```

**Remove Button Hover:**
```tsx
<button className="... opacity-0 group-hover:opacity-100 transition-opacity ...">
  <X className="h-4 w-4 text-red-600" />
</button>
```

**Inline Name Editing:**
- Regular: Dashboard name + edit icon
- Editing: Text input + check/X buttons
- Green check = save, Gray X = cancel

### Responsive Behavior

**Breakpoints:**
- **lg (1200px+):** 12 columns, full drag/resize
- **md (996px):** 10 columns
- **sm (768px):** 6 columns
- **xs (480px):** 4 columns, simplified layout
- **xxs (<480px):** 2 columns, stacked charts

**Mobile Considerations:**
- Grid still works but less practical
- Touch drag/resize supported
- Recommend desktop for building
- Mobile good for viewing only

## 🔧 Technical Implementation Details

### Layout Conversion

**Backend → RGL:**
```typescript
const layouts = dashboardCharts.map((dc) => {
  const layout = dc.layout as Record<string, number>;
  return {
    i: dc.id.toString(),     // RGL requires string ID
    x: layout.x || 0,
    y: layout.y || 0,
    w: layout.w || 4,
    h: layout.h || 4,
    minW: 2,                 // Minimum constraints
    minH: 2,
  };
});
```

**RGL → Backend:**
```typescript
const chartLayouts = newLayout.map(item => ({
  id: Number(item.i),        // Convert back to number
  layout: {
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
  }
}));
```

### Change Detection

Only save layout if actually changed:
```typescript
const handleLayoutChange = (newLayout: Layout[]) => {
  const hasChanged = newLayout.some((item, index) => {
    const oldItem = layouts[index];
    return (
      oldItem &&
      (item.x !== oldItem.x ||
        item.y !== oldItem.y ||
        item.w !== oldItem.w ||
        item.h !== oldItem.h)
    );
  });

  if (hasChanged) {
    onLayoutChange(newLayout);
  }
};
```

### Chart ID Resolution

**Problem:** removeChartFromDashboard needs chart_id, but we only have dashboard_chart_id in grid

**Solution:**
```typescript
const handleRemoveChart = async (dashboardChartId: number) => {
  // Find dashboard_chart by ID
  const dashboardChart = dashboard.dashboard_charts?.find(
    (dc) => dc.id === dashboardChartId
  );
  
  if (!dashboardChart) return;

  // Use chart_id from relationship
  await removeChartMutation.mutateAsync({
    dashboardId,
    chartId: dashboardChart.chart_id,
  });
};
```

### Performance Optimizations

**Debouncing:**
- Prevents excessive API calls during dragging
- 1-second delay balances responsiveness with API load
- Timer resets on each change

**React Query Caching:**
- Dashboard data cached with `['dashboards', id]`
- Chart data cached with `['charts', id, 'data']`
- Mutations invalidate relevant caches only
- Prevents unnecessary refetches

**Component Optimization:**
- ChartTile only renders when chart data changes
- DashboardGrid uses React.memo implicitly (not needed due to small data)
- Layout changes don't cause ChartTile re-renders (separate queries)

## 📊 Usage Examples

### Example 1: Sales Dashboard

**Goal:** Create dashboard with sales metrics

**Steps:**
1. Create "Sales Q4 2024" dashboard
2. Add "Revenue by Region" bar chart (w:12, h:4) - full width
3. Add "Top Products" pie chart (w:6, h:4) - left half
4. Add "Sales Trend" line chart (w:6, h:4) - right half
5. Add "Monthly Targets" time series (w:12, h:3) - bottom

**Result:** 
- Full-width revenue chart at top
- Two half-width charts in middle row
- Full-width trend at bottom
- Professional sales overview

### Example 2: Analytics Dashboard

**Goal:** Monitor website analytics

**Steps:**
1. Create "Website Analytics" dashboard
2. Add "Page Views" time series (w:8, h:5)
3. Add "Top Pages" table chart (w:4, h:5) - right side
4. Add "User Demographics" pie (w:4, h:4)
5. Add "Conversion Funnel" bar (w:8, h:4)

**Layout:**
```
┌──────────────────────┬──────┐
│                      │      │
│   Page Views         │ Top  │
│   (Time Series)      │Pages │
│                      │      │
└──────────────────────┴──────┘
┌────────┬──────────────────────┐
│  User  │   Conversion Funnel  │
│  Demo  │   (Bar Chart)        │
└────────┴──────────────────────┘
```

### Example 3: Executive Dashboard

**Goal:** High-level KPI dashboard

**Steps:**
1. Create "Executive Overview" dashboard
2. Add KPI metric charts (small, 3x2 each)
3. Add main trend chart (w:12, h:6)
4. Add comparison charts (w:6, h:4 each)

## 🚀 Advanced Features

### Multi-Dashboard Workflows

**Scenario:** Different dashboards for different audiences

**Sales Team Dashboard:**
- Revenue charts
- Lead conversion metrics
- Sales rep performance

**Marketing Dashboard:**
- Campaign performance
- Traffic sources
- Conversion rates

**Executive Dashboard:**
- High-level KPIs
- Trend summaries
- Strategic metrics

### Best Practices

**Layout Design:**
- Important charts at top (first view)
- Related charts grouped together
- Consistent sizing for comparison charts
- Full-width for summary charts
- Half-width for detail charts

**Chart Selection:**
- Choose appropriate chart types
- Ensure data refreshes regularly
- Consider load time (limit charts per dashboard)
- Use descriptive chart names

**Organization:**
- One dashboard per topic/audience
- Keep dashboards focused (5-8 charts max)
- Use meaningful names and descriptions
- Regular cleanup of unused dashboards

## 🔮 Future Enhancements

### Potential Features

**Dashboard Templates:**
- Pre-built dashboard layouts
- Industry-specific templates
- One-click dashboard creation
- Template marketplace

**Enhanced Layout Options:**
- Lock/unlock charts
- Snap to grid toggle
- Undo/redo layout changes
- Copy layout between dashboards

**Sharing and Permissions:**
- Public dashboard links
- Embed dashboards in websites
- Role-based access control
- Scheduled email reports

**Advanced Interactions:**
- Drill-down from charts
- Filter across all charts
- Date range selector for dashboard
- Refresh all charts button

**Export and Reporting:**
- Export dashboard as PDF
- Schedule dashboard snapshots
- Print-friendly layout
- Dashboard versioning

## 🧪 Testing Scenarios

### Functional Tests

**Dashboard Creation:**
- [ ] Create dashboard with only name
- [ ] Create dashboard with name and description
- [ ] Cancel creation
- [ ] Name validation (required field)

**Chart Management:**
- [ ] Add chart to empty dashboard
- [ ] Add multiple charts
- [ ] Add all available charts
- [ ] Try to add same chart twice (should be filtered)
- [ ] Remove chart with confirmation
- [ ] Cancel chart removal

**Layout Manipulation:**
- [ ] Drag chart to new position
- [ ] Resize chart larger
- [ ] Resize chart smaller
- [ ] Resize to minimum size (2x2)
- [ ] Layout saves after drag
- [ ] Layout saves after resize
- [ ] Multiple rapid changes (debounce works)

**Dashboard Editing:**
- [ ] Edit dashboard name
- [ ] Save new name
- [ ] Cancel name edit
- [ ] Empty name validation

### UI/UX Tests

**Responsive Design:**
- [ ] Dashboard grid on desktop (12 cols)
- [ ] Dashboard grid on tablet (10/6 cols)
- [ ] Dashboard grid on mobile (4/2 cols)
- [ ] Add chart modal on small screens
- [ ] Touch drag/resize on mobile

**Loading States:**
- [ ] Loading spinner while fetching dashboard
- [ ] Loading spinner in chart tiles
- [ ] "Saving..." indicator during auto-save
- [ ] Remove button spinner

**Empty States:**
- [ ] Empty dashboard list
- [ ] Empty dashboard (no charts)
- [ ] No available charts to add

### Integration Tests

**Cross-Feature:**
- [ ] Add chart created in Charts feature
- [ ] Navigate from Dashboards to Charts
- [ ] Dashboard shows chart with correct data
- [ ] Chart updates reflect in dashboard

**API Error Handling:**
- [ ] Network error during dashboard load
- [ ] Failed chart addition
- [ ] Failed chart removal
- [ ] Failed layout save
- [ ] Failed dashboard delete

## 📝 Code Quality

### Reusability

**ChartPreview:**
- Used in Charts feature (Prompt 3B)
- Reused in ChartTile component
- Consistent visualization across app

**Hooks:**
- All dashboard hooks in one file
- Consistent mutation patterns
- Cache invalidation strategies

**Components:**
- ChartTile is self-contained
- DashboardGrid is pure layout logic
- AddChartModal is reusable modal pattern

### Type Safety

**TypeScript Throughout:**
```typescript
interface DashboardGridProps {
  dashboardCharts: DashboardChart[];
  onLayoutChange: (layouts: Layout[]) => void;
  onRemoveChart: (dashboardChartId: number) => void;
  removingChartId?: number;
}
```

**API Type Alignment:**
- Frontend types match backend Pydantic models
- DashboardChartLayout identical structure
- Type inference prevents bugs

### Maintainability

**Clear Separation:**
- Layout logic in DashboardGrid
- Chart rendering in ChartTile
- Modal logic in AddChartModal
- Page orchestration in [id]/page.tsx

**Consistent Patterns:**
- Same mutation patterns as Charts/Datasets
- Same loading state handling
- Same error handling strategy

## 📚 Related Features

**Dependencies:**
- Charts (Prompt 3B): Provides chart visualizations
- Datasets (Prompt 3A): Data source for charts
- Data Sources (Prompt 2B): Connection to databases

**Integration Points:**
- Dashboard → Charts (chart_id references)
- Charts → Datasets (dataset_id references)
- Datasets → Data Sources (data_source_id references)

**Data Hierarchy:**
```
Data Source
    └── Dataset (SQL query)
        └── Chart (visualization config)
            └── Dashboard (layout arrangement)
```

## ✅ Completion Checklist

**All Requirements Met:**
- ✅ Dashboard list with create/delete
- ✅ Dashboard builder page
- ✅ Drag-and-drop layout with react-grid-layout
- ✅ Add charts to dashboard
- ✅ Remove charts from dashboard
- ✅ Auto-save layout with debouncing
- ✅ Inline name editing
- ✅ Chart tiles with ChartPreview
- ✅ Responsive grid layout
- ✅ Full API integration
- ✅ Loading and error states
- ✅ Empty states
- ✅ Confirmation dialogs

**Production Ready:**
- All CRUD operations functional
- Layout persistence working
- Debouncing prevents API spam
- React Query caching optimized
- TypeScript type safety
- Consistent styling
- User-friendly interactions

---

**Implementation Date:** November 28, 2025  
**Framework:** Next.js 14 App Router  
**Grid Library:** react-grid-layout  
**State Management:** React Query + useState  
**Styling:** TailwindCSS  
**Chart Visualization:** Recharts (via ChartPreview)
