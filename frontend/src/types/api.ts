/**
 * TypeScript types matching the backend schemas.
 */

export enum DataSourceType {
  POSTGRESQL = 'postgresql',
  MYSQL = 'mysql',
  BIGQUERY = 'bigquery',
}

export enum ChartType {
  BAR = 'bar',
  LINE = 'line',
  PIE = 'pie',
  TIME_SERIES = 'time_series',
}

export interface DataSource {
  id: number;
  name: string;
  type: DataSourceType;
  description?: string;
  config: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface DataSourceCreate {
  name: string;
  type: DataSourceType;
  description?: string;
  config: Record<string, any>;
}

export interface DataSourceUpdate {
  name?: string;
  description?: string;
  config?: Record<string, any>;
}

export interface ColumnMetadata {
  name: string;
  type: string;
}

export interface Dataset {
  id: number;
  name: string;
  description?: string;
  data_source_id: number;
  sql_query: string;
  columns?: ColumnMetadata[];
  created_at: string;
  updated_at: string;
}

export interface DatasetCreate {
  name: string;
  description?: string;
  data_source_id: number;
  sql_query: string;
}

export interface DatasetUpdate {
  name?: string;
  description?: string;
  sql_query?: string;
}

export interface Chart {
  id: number;
  name: string;
  description?: string;
  dataset_id: number;
  chart_type: ChartType;
  config: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface ChartCreate {
  name: string;
  description?: string;
  dataset_id: number;
  chart_type: ChartType;
  config: Record<string, any>;
}

export interface ChartUpdate {
  name?: string;
  description?: string;
  chart_type?: ChartType;
  config?: Record<string, any>;
}

export interface DashboardChartLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardChart {
  id: number;
  chart_id: number;
  layout: Record<string, number>;
}

export interface Dashboard {
  id: number;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  dashboard_charts: DashboardChart[];
}

export interface DashboardCreate {
  name: string;
  description?: string;
  charts?: Array<{
    chart_id: number;
    layout: DashboardChartLayout;
  }>;
}

export interface DashboardUpdate {
  name?: string;
  description?: string;
}

export interface QueryExecuteRequest {
  data_source_id: number;
  sql_query: string;
  limit?: number;
}

export interface QueryExecuteResponse {
  columns: string[];
  data: Record<string, any>[];
  row_count: number;
  execution_time_ms: number;
}

export interface DatasetExecuteResponse {
  columns: string[];
  data: Record<string, any>[];
  row_count: number;
}

export interface ChartDataResponse {
  chart: Chart;
  data: Record<string, any>[];
}
