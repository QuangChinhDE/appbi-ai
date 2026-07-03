/**
 * Observability client — the unified module (5 pillars: freshness · volume ·
 * schema · distribution · quality) on top of AppBI's own engines.
 *
 * Talks to:
 *   /api/v1/observability/*   — monitors, incidents, overview, lineage, usage
 *   /api/v1/anomaly/*         — the Phase-4 anomaly engine (metrics + alerts)
 *   /api/v1/catalog/observability/quality-overview — the rule-based quality rollup
 */
import { apiClient } from './api-client';

// ── shared ──────────────────────────────────────────────────────────────────
export type Pillar = 'freshness' | 'volume' | 'schema' | 'distribution' | 'quality';
export type MonitorKind = 'freshness' | 'volume' | 'schema';
export type Severity = 'info' | 'warning' | 'critical';
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

// ── Overview ──────────────────────────────────────────────────────────────────
export interface PillarHealth {
  pillar: Pillar;
  monitors: number;
  breached: number;
  openIncidents: number;
  healthy: boolean;
}
export interface ObservabilityOverview {
  datasetsMonitored: number;
  monitors: { total: number; active: number };
  incidents: {
    open: number; acknowledged: number; resolved7d: number;
    bySeverity: Record<string, number>;
    byPillar: Record<string, number>;
  };
  pillars: PillarHealth[];
  mttrHours: number | null;
  recentIncidents: Incident[];
}

export async function getOverview(): Promise<ObservabilityOverview> {
  const { data } = await apiClient.get<ObservabilityOverview>('/observability/overview');
  return data;
}

// ── Monitors (freshness/volume/schema) ──────────────────────────────────────
export interface Monitor {
  id: number;
  datasetId: number;
  datasetTableId: number;
  tableName?: string | null;
  kind: MonitorKind;
  name: string;
  config: Record<string, any>;
  severity: Severity;
  isActive: boolean;
  lastStatus?: 'ok' | 'breached' | 'error' | 'unknown' | null;
  lastValue?: number | null;
  lastDetail?: Record<string, any> | null;
  lastCheckedAt?: string | null;
}
export interface MonitorCreate {
  dataset_table_id: number;
  kind: MonitorKind;
  name?: string;
  config?: Record<string, any>;
  severity?: Severity;
}
export interface MonitorCheck { checkedAt: string | null; value: number | null; status: string; }

export async function listMonitors(datasetId?: number): Promise<Monitor[]> {
  const { data } = await apiClient.get<Monitor[]>('/observability/monitors', {
    params: datasetId != null ? { dataset_id: datasetId } : undefined,
  });
  return data ?? [];
}
export async function createMonitor(body: MonitorCreate): Promise<Monitor> {
  const { data } = await apiClient.post<Monitor>('/observability/monitors', body);
  return data;
}
export async function updateMonitor(id: number, patch: Partial<Pick<Monitor, 'name' | 'severity' | 'isActive'>> & { config?: Record<string, any> }): Promise<Monitor> {
  const body: Record<string, any> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.severity !== undefined) body.severity = patch.severity;
  if (patch.isActive !== undefined) body.is_active = patch.isActive;
  if (patch.config !== undefined) body.config = patch.config;
  const { data } = await apiClient.patch<Monitor>(`/observability/monitors/${id}`, body);
  return data;
}
export async function deleteMonitor(id: number): Promise<void> {
  await apiClient.delete(`/observability/monitors/${id}`);
}
export async function runMonitor(id: number): Promise<{ monitor: Monitor; result: any }> {
  const { data } = await apiClient.post(`/observability/monitors/${id}/run`);
  return data;
}
export async function getMonitorChecks(id: number, limit = 60): Promise<MonitorCheck[]> {
  const { data } = await apiClient.get<MonitorCheck[]>(`/observability/monitors/${id}/checks`, { params: { limit } });
  return data ?? [];
}

// ── Incidents (unified lifecycle) ───────────────────────────────────────────
export interface Incident {
  id: number;
  datasetId: number;
  dataset?: string | null;
  datasetTableId?: number | null;
  source: 'freshness' | 'volume' | 'schema' | 'quality' | 'anomaly';
  pillar: Pillar;
  title: string;
  detail?: Record<string, any> | null;
  severity: Severity;
  status: IncidentStatus;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  resolvedAt?: string | null;
  acknowledgedAt?: string | null;
  mttrHours?: number | null;
}
export interface IncidentFilter {
  status?: 'open' | IncidentStatus;
  severity?: Severity;
  pillar?: Pillar;
  datasetId?: number;
}
export async function listIncidents(filter: IncidentFilter = {}): Promise<Incident[]> {
  const { data } = await apiClient.get<Incident[]>('/observability/incidents', {
    params: {
      status: filter.status, severity: filter.severity,
      pillar: filter.pillar, dataset_id: filter.datasetId,
    },
  });
  return data ?? [];
}
export async function updateIncident(id: number, action: 'acknowledge' | 'resolve' | 'reopen'): Promise<Incident> {
  const { data } = await apiClient.patch<Incident>(`/observability/incidents/${id}`, { action });
  return data;
}

// ── Lineage & impact ────────────────────────────────────────────────────────
export interface LineageNode { id: string; type: 'source' | 'table' | 'chart' | 'dashboard'; label: string; openIncidents?: number; rows?: number | null; }
export interface LineageEdge { from: string; to: string; }
export interface LineageTable {
  tableId: number; name: string; source?: string | null;
  chartCount: number; dashboardCount: number;
  dashboards: { id: number; name: string }[];
  openIncidents: number; rows?: number | null;
}
export interface Lineage {
  dataset: { id: number; name: string } | null;
  nodes: LineageNode[];
  edges: LineageEdge[];
  tables: LineageTable[];
  impact?: { charts: number; dashboards: number };
}
export async function getLineage(datasetId: number): Promise<Lineage> {
  const { data } = await apiClient.get<Lineage>('/observability/lineage', { params: { dataset_id: datasetId } });
  return data;
}

// ── Usage & resource footprint ──────────────────────────────────────────────
export interface UsageRow {
  datasetId: number; dataset: string;
  tables: number; rows: number; sizeBytes: number;
  chartCount: number; dashboardCount: number;
  lastRefresh?: string | null;
  monitors: number; openIncidents: number; unused: boolean;
}
export async function getUsage(): Promise<UsageRow[]> {
  const { data } = await apiClient.get<UsageRow[]>('/observability/usage');
  return data ?? [];
}

// ── Manual scan ──────────────────────────────────────────────────────────────
export async function runScan(): Promise<Record<string, number>> {
  const { data } = await apiClient.post('/observability/scan');
  return data;
}

// ── Anomaly engine (Phase-4) — surfaced under the Monitors tab ───────────────
export interface AnomalyMetric {
  id: number;
  dataset_table_id: number;
  metric_column: string;
  aggregation: string;
  time_column?: string | null;
  dimension_columns: string[];
  check_frequency: string;
  threshold_z_score: number;
  is_active: boolean;
  owner_id: string;
  created_at: string;
}
export interface AnomalyMetricCreate {
  dataset_table_id: number;
  metric_column: string;
  aggregation?: string;
  time_column?: string | null;
  dimension_columns?: string[];
  check_frequency?: string;
  threshold_z_score?: number;
}
export interface AnomalyAlert {
  id: number;
  monitored_metric_id: number;
  detected_at: string;
  current_value: number;
  expected_value: number;
  z_score: number;
  change_pct: number;
  dimension_values?: Record<string, any> | null;
  severity: string;
  is_read: boolean;
  explanation?: string | null;
  metric_column?: string | null;
  table_name?: string | null;
}
export async function listAnomalyMetrics(): Promise<AnomalyMetric[]> {
  const { data } = await apiClient.get<AnomalyMetric[]>('/anomaly/metrics');
  return data ?? [];
}
export async function createAnomalyMetric(body: AnomalyMetricCreate): Promise<AnomalyMetric> {
  const { data } = await apiClient.post<AnomalyMetric>('/anomaly/metrics', body);
  return data;
}
export async function toggleAnomalyMetric(id: number): Promise<AnomalyMetric> {
  const { data } = await apiClient.patch<AnomalyMetric>(`/anomaly/metrics/${id}/toggle`);
  return data;
}
export async function deleteAnomalyMetric(id: number): Promise<void> {
  await apiClient.delete(`/anomaly/metrics/${id}`);
}
export async function listAnomalyAlerts(unreadOnly = false, limit = 50): Promise<AnomalyAlert[]> {
  const { data } = await apiClient.get<AnomalyAlert[]>('/anomaly/alerts', { params: { unread_only: unreadOnly, limit } });
  return data ?? [];
}
export async function runAnomalyScan(): Promise<Record<string, number>> {
  const { data } = await apiClient.post('/anomaly/scan');
  return data;
}

// ── Alert channels (P2 dispatch) ────────────────────────────────────────────
export type ChannelKind = 'email' | 'slack' | 'webhook';
export interface AlertChannel {
  id: number;
  kind: ChannelKind;
  name: string;
  target: string;
  minSeverity: Severity;
  isActive: boolean;
  datasetId?: number | null;
  lastSentAt?: string | null;
  lastError?: string | null;
}
export interface AlertChannelCreate {
  kind: ChannelKind;
  name: string;
  target: string;
  min_severity?: Severity;
  dataset_id?: number | null;
}
export async function listAlertChannels(): Promise<AlertChannel[]> {
  const { data } = await apiClient.get<AlertChannel[]>('/observability/alert-channels');
  return data ?? [];
}
export async function createAlertChannel(body: AlertChannelCreate): Promise<AlertChannel> {
  const { data } = await apiClient.post<AlertChannel>('/observability/alert-channels', body);
  return data;
}
export async function updateAlertChannel(id: number, patch: Partial<Pick<AlertChannel, 'name' | 'target' | 'isActive'>> & { min_severity?: Severity }): Promise<AlertChannel> {
  const body: Record<string, any> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.target !== undefined) body.target = patch.target;
  if (patch.min_severity !== undefined) body.min_severity = patch.min_severity;
  if (patch.isActive !== undefined) body.is_active = patch.isActive;
  const { data } = await apiClient.patch<AlertChannel>(`/observability/alert-channels/${id}`, body);
  return data;
}
export async function deleteAlertChannel(id: number): Promise<void> {
  await apiClient.delete(`/observability/alert-channels/${id}`);
}
export async function testAlertChannel(id: number): Promise<{ ok: boolean; error: string | null }> {
  const { data } = await apiClient.post(`/observability/alert-channels/${id}/test`);
  return { ok: data.ok, error: data.error };
}

// ── helpers ─────────────────────────────────────────────────────────────────
export const PILLAR_LABEL: Record<Pillar, string> = {
  freshness: 'Độ tươi', volume: 'Khối lượng', schema: 'Lược đồ',
  distribution: 'Phân phối', quality: 'Chất lượng',
};
export const SEVERITY_LABEL: Record<Severity, string> = {
  info: 'Thông tin', warning: 'Cảnh báo', critical: 'Nghiêm trọng',
};
