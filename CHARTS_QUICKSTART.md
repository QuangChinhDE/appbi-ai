# Charts Feature - Quick Reference

## 🚀 Quick Start

### Navigate to Charts
```
http://localhost:3000/charts
```

### Create a Chart
1. Click "Create Chart" button
2. Fill in name and select a dataset
3. Choose chart type (Bar, Line, Pie, Time Series)
4. Map fields from your dataset
5. Preview the chart
6. Click "Create Chart" to save

## 📊 Chart Type Reference

| Chart Type | Best For | Required Fields | Example Use Case |
|------------|----------|-----------------|------------------|
| **Bar** | Comparing categories | X-axis (any), Y-axes (numeric) | Sales by region |
| **Line** | Showing trends | X-axis (any), Y-axes (numeric) | Revenue over quarters |
| **Pie** | Showing proportions | Labels (text), Values (numeric) | Market share distribution |
| **Time Series** | Tracking over time | Time field (date), Value (numeric) | Website traffic by day |

## 🎯 Field Mapping Guide

### Bar and Line Charts
- **X Field:** Category or label column (any type)
- **Y Fields:** One or more numeric columns
- Can select multiple Y fields for comparison

### Pie Charts
- **Label Field:** Text column for slice names
- **Value Field:** Numeric column for slice sizes

### Time Series Charts
- **Time Field:** Date/datetime column (auto-detected)
- **Value Field:** Numeric column to plot

## 🔌 API Endpoints

```typescript
GET    /api/v1/charts              // List all charts
GET    /api/v1/charts/{id}         // Get chart details
POST   /api/v1/charts              // Create chart
PUT    /api/v1/charts/{id}         // Update chart
DELETE /api/v1/charts/{id}         // Delete chart
GET    /api/v1/charts/{id}/data    // Get chart data (execute)
```

## 📦 Component Usage

### ChartPreview Component

Use this component anywhere you need to render a chart:

```tsx
import { ChartPreview } from '@/components/charts/ChartPreview';

<ChartPreview
  chartType={ChartType.BAR}
  data={[
    { month: 'Jan', sales: 1000, profit: 200 },
    { month: 'Feb', sales: 1500, profit: 300 },
  ]}
  config={{
    xField: 'month',
    yFields: ['sales', 'profit'],
    showLegend: true,
    showGrid: true,
  }}
/>
```

### Using Chart Hooks

```tsx
import { useCharts, useChartData } from '@/hooks/use-charts';

// List all charts
const { data: charts, isLoading } = useCharts();

// Get chart data for visualization
const { data: chartData } = useChartData(chartId);

// Create a chart
const createMutation = useCreateChart();
await createMutation.mutateAsync({
  name: 'My Chart',
  dataset_id: 1,
  chart_type: ChartType.BAR,
  config: { xField: 'category', yFields: ['value'] }
});
```

## 🎨 Configuration Options

### Available in ChartConfig

```typescript
interface ChartConfig {
  // Chart-specific fields
  xField?: string;           // Bar, Line
  yFields?: string[];        // Bar, Line
  labelField?: string;       // Pie
  valueField?: string;       // Pie, Time Series
  timeField?: string;        // Time Series
  
  // Display options (optional)
  title?: string;
  colors?: string[];         // Custom color palette
  showLegend?: boolean;      // Default: true
  showGrid?: boolean;        // Default: true
}
```

### Default Colors

```typescript
const DEFAULT_COLORS = [
  '#3b82f6', // blue-500
  '#10b981', // green-500
  '#f59e0b', // amber-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#06b6d4', // cyan-500
  '#f97316', // orange-500
];
```

## 🔄 Common Workflows

### Workflow 1: Create Sales Dashboard Chart
```typescript
// 1. Select "Monthly Sales" dataset
// 2. Choose Bar chart
// 3. Configure:
//    - X: month
//    - Y: total_sales, target
// 4. Save as "Sales vs Target"
```

### Workflow 2: Time Series Analysis
```typescript
// 1. Select "Website Analytics" dataset
// 2. Choose Time Series chart
// 3. Configure:
//    - Time: date
//    - Value: page_views
// 4. Save as "Daily Page Views"
```

### Workflow 3: Distribution Visualization
```typescript
// 1. Select "Customer Segments" dataset
// 2. Choose Pie chart
// 3. Configure:
//    - Label: segment_name
//    - Value: customer_count
// 4. Save as "Customer Distribution"
```

## 🛠️ Troubleshooting

### Chart Not Displaying
- ✅ Check that dataset has data
- ✅ Verify field names match column names
- ✅ Ensure numeric fields for Y-axes/values
- ✅ Check browser console for errors

### Preview Not Loading
- ✅ Dataset must be selected first
- ✅ Wait for dataset execution (max 100 rows)
- ✅ Check if dataset query is valid
- ✅ Verify data source is connected

### Fields Not Appearing
- ✅ Dataset must return data
- ✅ Column types must be appropriate:
  - Numeric columns for Y-axes/values
  - Any columns for X-axes/labels
  - Date columns for time series

### Date Formatting Issues
- ✅ Time field must contain valid ISO dates or timestamps
- ✅ If no date columns detected, select manually
- ✅ ChartPreview auto-formats to locale date

## 📚 File Structure

```
frontend/src/
├── components/charts/
│   ├── ChartPreview.tsx      # Recharts visualization
│   ├── ChartBuilder.tsx      # Create/edit form
│   └── ChartList.tsx         # Table view
├── app/charts/
│   ├── page.tsx              # Main charts page
│   └── [id]/page.tsx         # Chart detail page
├── hooks/
│   └── use-charts.ts         # React Query hooks
├── lib/api/
│   └── charts.ts             # API client
└── types/
    ├── api.ts                # Chart types (existing)
    └── chart.ts              # Detailed config types
```

## 🔗 Related Features

- **Datasets:** Charts visualize saved datasets
- **Data Sources:** Datasets connect to data sources
- **Dashboards:** (Prompt 3C) Will display multiple charts in grid layout

## 💡 Pro Tips

1. **Multiple Metrics:** Use Bar/Line charts with multiple Y fields to compare metrics
2. **Date Detection:** Name columns with "date" or "time" for auto-detection
3. **Preview First:** Always preview before saving to verify appearance
4. **Reuse Datasets:** Create multiple charts from one dataset with different configurations
5. **Color Consistency:** Charts auto-assign colors consistently across the app

## 📊 Sample Chart Configurations

### Multi-Series Bar Chart
```json
{
  "name": "Quarterly Performance",
  "chart_type": "bar",
  "config": {
    "xField": "quarter",
    "yFields": ["revenue", "profit", "expenses"]
  }
}
```

### Revenue Trend Line
```json
{
  "name": "Revenue Growth",
  "chart_type": "line",
  "config": {
    "xField": "month",
    "yFields": ["actual_revenue", "projected_revenue"]
  }
}
```

### Market Share Pie
```json
{
  "name": "Market Share Q4",
  "chart_type": "pie",
  "config": {
    "labelField": "company_name",
    "valueField": "market_share_percentage"
  }
}
```

### Traffic Time Series
```json
{
  "name": "Website Traffic",
  "chart_type": "time_series",
  "config": {
    "timeField": "visit_date",
    "valueField": "unique_visitors"
  }
}
```

## 🎓 Next Steps

After mastering charts:
1. **Create Multiple Charts:** Build a library of visualizations
2. **Experiment with Types:** Try different chart types for same data
3. **Prepare for Dashboards:** Think about which charts to group together
4. **Optimize Queries:** Ensure datasets execute quickly for smooth charting

---

Need help? Check `PROMPT_3B_COMPLETE.md` for detailed implementation documentation.
