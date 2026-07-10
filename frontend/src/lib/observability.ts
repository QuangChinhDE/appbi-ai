/**
 * Observability client — the health module on top of AppBI's own engines.
 *
 * Talks to:
 *   /api/v1/observability/*   — overview, incidents, semantic lineage, usage,
 *                               manual scan, alert channels
 */
import { apiClient } from './api-client';

// ── shared ──────────────────────────────────────────────────────────────────
export type Pillar = 'freshness' | 'volume' | 'schema' | 'distribution' | 'quality';
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

// ── Semantic (column + measure level) lineage ────────────────────────────────
export interface SemColumn { name: string; type?: string | null; rules: number; failingRules: number; incidents: number; joinKey: boolean; }
export interface SemMeasure { name: string; label: string; type?: string | null; dependsColumns: { table: number; column: string }[]; dependsMeasures: { table: number; measure: string }[]; }
export interface SemTable {
  tableId: number; view: string; name: string; source?: string | null;
  columns: SemColumn[]; measures: SemMeasure[];
  tableRules: number; tableFailingRules: number; openIncidents: number;
}
export interface SemJoin { fromTable: number; fromColumn?: string | null; toTable: number; toColumn?: string | null; relationship?: string | null; }
export interface SemChart { id: number; name: string; tableId: number; usesColumns: string[]; usesMeasures: string[]; dashboardIds: number[]; }
export interface SemanticLineage {
  dataset: { id: number; name: string } | null;
  hasModel: boolean;
  tables: SemTable[];
  joins: SemJoin[];
  charts: SemChart[];
  dashboards: { id: number; name: string }[];
}
export async function getSemanticLineage(datasetId: number): Promise<SemanticLineage> {
  const { data } = await apiClient.get<SemanticLineage>('/observability/semantic-lineage', { params: { dataset_id: datasetId } });
  return data;
}

// ── Usage & resource footprint ──────────────────────────────────────────────
export interface UsageRow {
  datasetId: number; dataset: string;
  tables: number; rows: number; sizeBytes: number;
  chartCount: number; dashboardCount: number;
  lastRefresh?: string | null;
  monitors: number; qualityRules: number; openIncidents: number;
  unused: boolean; observed: boolean;
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
