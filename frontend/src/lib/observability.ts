/**
 * Observability client — the health module on top of AppBI's own engines.
 *
 * Talks to:
 *   /api/v1/observability/*   — overview, status, incidents, monitors, scans,
 *                               semantic lineage, usage, alert channels
 *
 * Every payload that can be acted on carries `capabilities` from the server.
 * The UI shows an action only when the server says the caller may take it;
 * the server enforces the same rule regardless.
 */
import { apiClient } from './api-client';

// ── shared ──────────────────────────────────────────────────────────────────
export type Pillar = 'freshness' | 'volume' | 'schema' | 'distribution' | 'quality' | 'semantic';
export type Severity = 'info' | 'warning' | 'critical';
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

/** What went wrong loading something — never rendered as empty or healthy. */
export type LoadError = 'forbidden' | 'not_found' | 'failed';
export function loadErrorOf(e: any): LoadError {
  const s = e?.response?.status;
  if (s === 403) return 'forbidden';
  if (s === 404) return 'not_found';
  return 'failed';
}

// ── Overview / status / me ──────────────────────────────────────────────────
/** semantic_invalid > breached > error (a check failed to run) > unknown (never
 *  run / still learning) > not_monitored > healthy — "healthy" only when every
 *  check ran and passed. */
export type HealthState = 'semantic_invalid' | 'breached' | 'error' | 'unknown' | 'not_monitored' | 'healthy';
/** The states that need someone to look — one definition for filter and count. */
export const NEEDS_ATTENTION: HealthState[] = ['semantic_invalid', 'breached', 'error'];
export interface SemanticState { status: 'pass' | 'fail' | 'unknown' | 'not_modelled'; failed?: number; reasons?: string[]; source?: string; since?: string | null }
export interface PillarHealth {
  pillar: Pillar;
  monitors: number;
  breached: number;
  errored?: number;
  unknown?: number;
  openIncidents: number;
  status?: HealthState;
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
  /** Unresolved incidents across datasets, worst first. */
  recentIncidents: Incident[];
}
export async function getOverview(): Promise<ObservabilityOverview> {
  const { data } = await apiClient.get<ObservabilityOverview>('/observability/overview');
  return data;
}

export interface ScanRun {
  id: number; scope: 'global' | 'dataset'; datasetId?: number | null; trigger: 'schedule' | 'manual';
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  startedAt?: string | null; finishedAt?: string | null;
  counts: Record<string, number>; errors: string[];
}
export interface ScannerStatus {
  lastScan: ScanRun | null;
  lastSuccessfulScan: ScanRun | null;
  running: boolean;
  stale: boolean;
  staleAfterHours: number;
  nextScheduledScan?: string | null;
  deliveries: { pending: number; failed: number; dead: number; sent: number; cancelled: number };
}
export async function getScannerStatus(): Promise<ScannerStatus> {
  const { data } = await apiClient.get<ScannerStatus>('/observability/status');
  return data;
}

export interface ObservabilityMe { admin: boolean; canScanAll: boolean; canManageGlobalChannels: boolean; canEdit: boolean }
export async function getObservabilityMe(): Promise<ObservabilityMe> {
  const { data } = await apiClient.get<ObservabilityMe>('/observability/me');
  return data;
}

// ── Incidents (unified lifecycle) ───────────────────────────────────────────
export interface IncidentHistoryEntry { action: string; at?: string; by?: string; reason?: string }
export interface Incident {
  id: number;
  datasetId: number;
  dataset?: string | null;
  datasetTableId?: number | null;
  source: 'freshness' | 'volume' | 'schema' | 'quality' | 'anomaly' | 'semantic';
  pillar: Pillar;
  title: string;
  detail?: (Record<string, any> & { history?: IncidentHistoryEntry[] }) | null;
  severity: Severity;
  status: IncidentStatus;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  resolvedAt?: string | null;
  acknowledgedAt?: string | null;
  mttrHours?: number | null;
  capabilities?: { act: boolean; acceptBaseline?: boolean };
}
export interface IncidentFilter {
  status?: 'open' | IncidentStatus;
  severity?: Severity;
  pillar?: Pillar;
  datasetId?: number;
  q?: string;
  limit?: number;
  offset?: number;
}
export interface IncidentPage { items: Incident[]; total: number; limit: number; offset: number }
export async function listIncidents(filter: IncidentFilter = {}): Promise<IncidentPage> {
  const { data } = await apiClient.get<IncidentPage>('/observability/incidents', {
    params: {
      status: filter.status, severity: filter.severity,
      pillar: filter.pillar, dataset_id: filter.datasetId,
      q: filter.q || undefined, limit: filter.limit ?? 50, offset: filter.offset ?? 0,
    },
  });
  return data;
}
export async function getIncident(id: number): Promise<Incident> {
  const { data } = await apiClient.get<Incident>(`/observability/incidents/${id}`);
  return data;
}
export type IncidentAction = 'acknowledge' | 'resolve' | 'reopen' | 'accept_baseline';
export async function updateIncident(id: number, action: IncidentAction): Promise<Incident> {
  const { data } = await apiClient.patch<Incident>(`/observability/incidents/${id}`, { action });
  return data;
}

// ── Native monitors (freshness / volume / schema) ───────────────────────────
export type MonitorKind = 'freshness' | 'volume' | 'schema';
export interface Monitor {
  id: number; datasetId: number; tableId: number; table?: string | null;
  kind: MonitorKind; name: string; config: Record<string, any>; severity: Severity;
  isActive: boolean; lastStatus?: 'ok' | 'breached' | 'error' | 'unknown' | null;
  lastValue?: number | null; lastDetail?: Record<string, any> | null; lastCheckedAt?: string | null;
}
export interface MonitorTable { tableId: number; name: string; kinds: MonitorKind[]; timeColumns: string[]; enabled: boolean }
export interface MonitorSetup { tables: MonitorTable[]; monitors: Monitor[]; capabilities: { configure: boolean; scan: boolean } }
export async function getMonitors(datasetId: number): Promise<MonitorSetup> {
  const { data } = await apiClient.get<MonitorSetup>(`/observability/datasets/${datasetId}/monitors`);
  return data;
}
export interface MonitorSave { table_id: number; kind: MonitorKind; config?: Record<string, any>; severity?: Severity; is_active?: boolean }
export async function saveMonitor(datasetId: number, body: MonitorSave): Promise<Monitor> {
  const { data } = await apiClient.put<Monitor>(`/observability/datasets/${datasetId}/monitors`, body);
  return data;
}
export async function deleteMonitor(id: number): Promise<void> {
  await apiClient.delete(`/observability/monitors/${id}`);
}

// ── Scans ───────────────────────────────────────────────────────────────────
export interface ScanResult extends Record<string, any> {
  status: 'succeeded' | 'partial'; run_id: number; errors: string[];
  monitors: number; breached: number; monitor_errors: number; new_incidents: number; alerts_sent: number;
}
export async function runScan(): Promise<ScanResult> {
  const { data } = await apiClient.post<ScanResult>('/observability/scan');
  return data;
}
export async function scanDataset(datasetId: number): Promise<ScanResult> {
  const { data } = await apiClient.post<ScanResult>(`/observability/datasets/${datasetId}/scan`);
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
  /** Full blast radius; hidden* = charts / dashboards the caller cannot open (counted, not named). */
  impact?: { charts: number; dashboards: number; hiddenCharts: number; hiddenDashboards: number };
  fieldUsage?: 'inferred';
}
export async function getSemanticLineage(datasetId: number): Promise<SemanticLineage> {
  const { data } = await apiClient.get<SemanticLineage>('/observability/semantic-lineage', { params: { dataset_id: datasetId } });
  return data;
}

// ── Usage & per-dataset health ──────────────────────────────────────────────
export interface CheckCounts { active: number; passing: number; failing: number; errored: number; notRun: number }
export interface UsageRow {
  datasetId: number; dataset: string;
  tables: number; rows: number; sizeBytes: number;
  chartCount: number; dashboardCount: number;
  lastRefresh?: string | null;
  lastCheckedAt?: string | null;
  monitors: number; activeMonitors?: number; qualityRules: number; enabledRules?: number; openIncidents: number;
  checks?: CheckCounts;
  erroredChecks?: number; unknownChecks?: number; health?: HealthState; semantic?: SemanticState;
  unused: boolean; observed: boolean;
  capabilities?: { configure: boolean };
}
export async function getUsage(): Promise<UsageRow[]> {
  const { data } = await apiClient.get<UsageRow[]>('/observability/usage');
  return data ?? [];
}

// ── Alert channels ──────────────────────────────────────────────────────────
export type ChannelKind = 'email' | 'slack' | 'webhook';
export interface AlertChannel {
  id: number;
  kind: ChannelKind;
  name: string;
  target: string;
  targetMasked?: boolean;
  scope: 'global' | 'dataset';
  minSeverity: Severity;
  isActive: boolean;
  datasetId?: number | null;
  dataset?: string | null;
  lastSentAt?: string | null;
  lastError?: string | null;
  deliveries?: { pending: number; failed: number; dead: number };
  capabilities?: { manage: boolean; test: boolean; reveal_target: boolean };
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

/** The server's message for a refused request, when it sent a readable one. */
export function apiErrorMessage(e: any): string | null {
  const d = e?.response?.data?.detail;
  if (typeof d === 'string') return d;
  if (d && typeof d.message === 'string') return d.message;
  return null;
}
