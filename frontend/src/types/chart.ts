// Chart Type Definitions aligned with backend models

export type ChartType = "bar" | "line" | "pie" | "time_series";

// Chart Configuration - aligns with backend chart_config.py
export interface ChartConfig {
  // For bar and line charts
  xField?: string;
  yFields?: string[];
  
  // For pie charts
  labelField?: string;
  valueField?: string;
  
  // For time series charts
  timeField?: string;
  // valueField is shared with pie charts
  
  // Optional customization
  title?: string;
  colors?: string[];
  showLegend?: boolean;
  showGrid?: boolean;
}

// Chart model
export interface Chart {
  id: number;
  name: string;
  description?: string;
  dataset_table_id?: number | null;
  chart_type: ChartType;
  config: ChartConfig;
  created_at?: string;
  updated_at?: string;
}

// Request payloads
export interface ChartCreate {
  name: string;
  description?: string;
  dataset_table_id?: number | null;
  chart_type: ChartType;
  config: ChartConfig;
}

export interface ChartUpdate {
  name?: string;
  description?: string;
  dataset_table_id?: number | null;
  chart_type?: ChartType;
  config?: ChartConfig;
}

// Response from GET /charts/{id}/data
export interface ChartDataResponse {
  data: Array<Record<string, any>>;
  config: ChartConfig;
  meta?: {
    row_count?: number;
    execution_time_ms?: number;
  };
}

// List query parameters
export interface ChartListParams {
  skip?: number;
  limit?: number;
}
