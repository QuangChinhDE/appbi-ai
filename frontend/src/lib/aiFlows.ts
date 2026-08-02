/**
 * Flow Studio client — /api/v1/catalog/ai/*
 *
 * The Studio is where a non-engineer composes how the AI analyses their data:
 * agents (prompt + tools + model tier), flows (the node graph), assistants
 * (which flow answers which intent) and bindings (which report gets which
 * chatbot).
 */
import { apiClient } from './api-client';

// ── Palette ────────────────────────────────────────────────────────────────
export interface NodeTypeSpec {
  type: string;
  label_vi: string;
  description_vi: string;
  system: boolean;
  llm: boolean;
}

export interface ToolSpec {
  name: string;
  category: 'metadata' | 'data' | 'analytics' | 'knowledge' | 'external' | 'ux';
  cost_class: 'cheap' | 'data_query' | 'expensive' | 'external';
  label_vi: string;
  label_en: string;
  description_vi: string;
  depths: string[];
  requires_web: boolean;
}

export interface HandlerSpec {
  name: string;
  label_vi: string;
  description_vi: string;
  routes: string[];
}

export interface ReducerSpec { name: string; label_vi: string; description_vi: string }
export interface ContextSource { key: string; label_vi: string; locked: boolean }
export interface IntentSpec { key: string; label_vi: string }

export interface Palette {
  node_types: NodeTypeSpec[];
  tools: ToolSpec[];
  handlers: HandlerSpec[];
  model_policies: { policy: string; label_vi: string; description_vi: string }[];
  writable_state_fields: { field: string; label_vi: string }[];
  reducers: ReducerSpec[];
  context_sources: ContextSource[];
  intents: IntentSpec[];
}

export async function getPalette(): Promise<Palette> {
  const { data } = await apiClient.get<Palette>('/catalog/ai/palette');
  return data;
}

// ── Graph ──────────────────────────────────────────────────────────────────
export interface FlowNode {
  type: string;
  display_name?: string | null;
  description?: string | null;
  position?: { x: number; y: number } | null;
  disabled?: boolean;
  branches?: string[];
  reducer?: string | null;
  next?: string | null;
  routes?: Record<string, string>;
  on_success?: string | null;
  on_failure?: string | null;
  agent?: string | null;
  tools?: string[];
  tool?: string | null;
  args?: Record<string, unknown>;
  handler?: string | null;
  when?: string | null;
  config?: Record<string, unknown>;
}

export interface FlowLimits {
  max_model_calls: number;
  max_tool_calls: number;
  deadline_seconds: number;
  max_usd: number;
  max_loops_per_node: number;
}

export interface FlowGraph {
  entrypoint: string;
  nodes: Record<string, FlowNode>;
  limits?: Partial<FlowLimits>;
  requires_tools?: boolean;
  viewport?: Record<string, number>;
}

export type IssueSeverity = 'error' | 'warning' | 'suggestion';

export interface ValidationError {
  code: string;
  message: string;
  node_key: string | null;
  severity: IssueSeverity;
  field_path?: string | null;
  suggested_action?: string | null;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationError[];
  errors: ValidationError[];
  counts: { error: number; warning: number; suggestion: number };
  limits_declared: FlowLimits | null;
  limits_effective: FlowLimits | null;
  limits_ceiling: Record<string, number> | null;
}

// ── Agents ─────────────────────────────────────────────────────────────────
export interface AgentVersion {
  id: number;
  agent_key: string;
  version: number;
  ref: string;
  status: 'draft' | 'published' | 'archived';
  display_name: string;
  model_policy: string;
  prompt_template: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  tool_allowlist: string[];
  writable_state_fields: string[];
  runtime_config: Record<string, unknown>;
  is_builtin: boolean;
  created_by: string | null;
  published_at: string | null;
  created_at: string | null;
}

export async function listAgents(): Promise<AgentVersion[]> {
  const { data } = await apiClient.get<{ agents: AgentVersion[] }>('/catalog/ai/agents');
  return data.agents;
}

export async function listAgentVersions(agentKey: string): Promise<AgentVersion[]> {
  const { data } = await apiClient.get<{ versions: AgentVersion[] }>(
    `/catalog/ai/agents/${agentKey}/versions`,
  );
  return data.versions;
}

export async function saveAgent(body: Partial<AgentVersion> & { agent_key: string; display_name: string }): Promise<AgentVersion> {
  const { data } = await apiClient.put<AgentVersion>('/catalog/ai/agents', body);
  return data;
}

export async function publishAgent(agentKey: string, version: number): Promise<AgentVersion> {
  const { data } = await apiClient.post<AgentVersion>(`/catalog/ai/agents/${agentKey}/${version}/publish`);
  return data;
}

export async function deleteAgent(agentKey: string, version: number): Promise<void> {
  await apiClient.delete(`/catalog/ai/agents/${agentKey}/${version}`);
}

// ── Flows ──────────────────────────────────────────────────────────────────
export type FlowStatus = 'draft' | 'ready' | 'in_review' | 'published' | 'archived';

export interface FlowSummary {
  id: number;
  flow_key: string;
  version: number;
  status: FlowStatus;
  display_name: string;
  description?: string | null;
  owner?: string | null;
  tags?: string[];
  limits: Partial<FlowLimits>;
  requires_tools: boolean;
  eval_pass_rate: number | null;
  is_builtin: boolean;
  created_by: string | null;
  published_at: string | null;
  created_at: string | null;
  node_count: number;
}

export interface FlowDetail extends FlowSummary {
  graph: FlowGraph;
  validation?: ValidationResult;
}

export async function listFlows(): Promise<FlowSummary[]> {
  const { data } = await apiClient.get<{ flows: FlowSummary[] }>('/catalog/ai/flows');
  return data.flows;
}

export async function getFlow(flowKey: string, version: number): Promise<FlowDetail> {
  const { data } = await apiClient.get<FlowDetail>(`/catalog/ai/flows/${flowKey}/${version}`);
  return data;
}

export async function validateGraph(graph: FlowGraph): Promise<ValidationResult> {
  const { data } = await apiClient.post<ValidationResult>('/catalog/ai/flows/validate', { graph });
  return data;
}

export async function saveFlow(body: {
  flow_key: string; version?: number | null; display_name: string; graph: FlowGraph;
  description?: string | null; tags?: string[];
}): Promise<FlowDetail> {
  const { data } = await apiClient.put<FlowDetail>('/catalog/ai/flows', body);
  return data;
}

export async function cloneFlow(flowKey: string, version: number, newKey: string, displayName: string): Promise<FlowDetail> {
  const { data } = await apiClient.post<FlowDetail>(
    `/catalog/ai/flows/${flowKey}/${version}/clone`,
    { new_key: newKey, display_name: displayName },
  );
  return data;
}

export async function publishFlow(flowKey: string, version: number): Promise<FlowDetail> {
  const { data } = await apiClient.post<FlowDetail>(`/catalog/ai/flows/${flowKey}/${version}/publish`);
  return data;
}

export async function rollbackFlow(flowKey: string): Promise<FlowDetail> {
  const { data } = await apiClient.post<FlowDetail>(`/catalog/ai/flows/${flowKey}/rollback`);
  return data;
}

export async function deleteFlow(flowKey: string, version: number): Promise<void> {
  await apiClient.delete(`/catalog/ai/flows/${flowKey}/${version}`);
}

// ── Assistants ─────────────────────────────────────────────────────────────
export interface RoutingRule {
  when_intent: string[];
  flow: string;
  /** Candidate flow to try on a slice of viewers. Empty = no split. */
  canary_flow?: string | null;
  /** 0–100. The share of viewers that get `canary_flow` instead of `flow`. */
  canary_percent?: number;
}

export interface AssistantBinding {
  id?: number;
  surface: 'public_link' | 'dashboard' | 'global';
  surface_ref: string | null;
  enabled: boolean;
}

export interface Assistant {
  id: number;
  key: string;
  display_name: string;
  status: 'draft' | 'published';
  routing: RoutingRule[];
  credential_ref: string | null;
  budget: { max_usd_per_day?: number; max_turns_per_hour?: number };
  knowledge_scope: Record<string, unknown>;
  locale: string;
  created_at: string | null;
  bindings: AssistantBinding[];
}

export async function listAssistants(): Promise<Assistant[]> {
  const { data } = await apiClient.get<{ assistants: Assistant[] }>('/catalog/ai/assistants');
  return data.assistants;
}

export async function saveAssistant(body: Partial<Assistant> & { key: string }): Promise<Assistant> {
  const { data } = await apiClient.put<Assistant>('/catalog/ai/assistants', body);
  return data;
}

export async function setBindings(key: string, bindings: AssistantBinding[]): Promise<Assistant> {
  const { data } = await apiClient.put<Assistant>(`/catalog/ai/assistants/${key}/bindings`, { bindings });
  return data;
}

export async function deleteAssistant(key: string): Promise<void> {
  await apiClient.delete(`/catalog/ai/assistants/${key}`);
}

/**
 * What would ACTUALLY answer on this surface. Binding inheritance
 * (link → dashboard → global → built-in) is the single easiest thing to get
 * wrong from memory, so the Assistant page shows the resolved answer instead of
 * asking the author to simulate it in their head.
 */
export interface EffectiveFlow {
  resolved: boolean;
  reason?: string;
  flow_key?: string;
  flow_version?: number;
  assistant_key?: string | null;
  source?: string;
  matches_this_assistant?: boolean;
}

export async function getEffectiveFlow(
  key: string,
  params: { token?: string; dashboard_id?: number; intent?: string },
): Promise<EffectiveFlow> {
  const { data } = await apiClient.get<EffectiveFlow>(
    `/catalog/ai/assistants/${key}/effective`, { params },
  );
  return data;
}

// ── Export / import ────────────────────────────────────────────────────────
export interface BundleCheck {
  ok: boolean;
  fatal: string[];
  warnings: string[];
  flow_key?: string;
  display_name?: string;
  node_count?: number;
  agents_in_bundle?: string[];
}

export async function exportFlow(flowKey: string, version: number): Promise<Record<string, unknown>> {
  const { data } = await apiClient.get<Record<string, unknown>>(
    `/catalog/ai/flows/${flowKey}/${version}/export`,
  );
  return data;
}

export async function checkBundle(bundle: Record<string, unknown>): Promise<BundleCheck> {
  const { data } = await apiClient.post<BundleCheck>(
    '/catalog/ai/flows/import', { bundle, dry_run: true },
  );
  return data;
}

export async function importBundle(
  bundle: Record<string, unknown>, newKey?: string,
): Promise<FlowDetail & { imported?: Record<string, unknown> }> {
  const { data } = await apiClient.post<FlowDetail & { imported?: Record<string, unknown> }>(
    '/catalog/ai/flows/import', { bundle, new_key: newKey || null },
  );
  return data;
}

// ── Surfaces ───────────────────────────────────────────────────────────────
export interface Surfaces {
  public_links: { token: string; dashboard_id: number; dashboard_name: string; provider: string | null; model: string | null }[];
  dashboards: { id: number; name: string }[];
}

export async function getSurfaces(): Promise<Surfaces> {
  const { data } = await apiClient.get<Surfaces>('/catalog/ai/surfaces');
  return data;
}

// ── Runs & trace ───────────────────────────────────────────────────────────
export interface RunRow {
  id: string;
  flow_key: string;
  flow_version: number;
  assistant_key: string | null;
  mode: string | null;
  dashboard_id: number;
  question: string | null;
  status: string;
  model_calls: number;
  tool_calls: number;
  usd: number;
  verification_coverage: number | null;
  latency_ms: number | null;
  error_code: string | null;
  started_at: string | null;
}

export interface TraceNode {
  seq: number;
  node_key: string;
  node_type: string;
  status: string;
  model: string | null;
  latency_ms: number | null;
  error: unknown;
}

export interface EvidenceRow {
  id: number;
  tool_name: string;
  source_ref: Record<string, unknown>;
  numbers: number[];
  row_count: number | null;
  truncated: boolean;
  ok: boolean;
  created_at: string | null;
}

export interface Trace {
  run: RunRow;
  nodes: TraceNode[];
  evidence: EvidenceRow[];
}

export async function listRuns(params?: { limit?: number; flow_key?: string }): Promise<RunRow[]> {
  const { data } = await apiClient.get<{ runs: RunRow[] }>('/catalog/ai/runs', { params });
  return data.runs;
}

export async function getTrace(runId: string): Promise<Trace> {
  const { data } = await apiClient.get<Trace>(`/catalog/ai/runs/${runId}/trace`);
  return data;
}

/** Aggregates over real traffic — how a canary is judged, not guessed. */
export interface FlowStat {
  flow_key: string;
  runs: number;
  usd_total: number;
  usd_avg: number;
  latency_p50_ms: number | null;
  verified_avg: number | null;
  verified_runs: number;
  error_rate: number | null;
}

export async function getFlowStats(flowKeys: string[], days = 7): Promise<FlowStat[]> {
  if (!flowKeys.length) return [];
  const { data } = await apiClient.get<{ days: number; stats: FlowStat[] }>(
    '/catalog/ai/flow-stats', { params: { flow_keys: flowKeys.join(','), days } },
  );
  return data.stats;
}

// ── Model policies ─────────────────────────────────────────────────────────
export interface ModelPolicyRow {
  id: number; policy: string; provider: string; model: string;
  supports_tools: boolean; priority: number; enabled: boolean;
}

export async function listModelPolicies(): Promise<ModelPolicyRow[]> {
  const { data } = await apiClient.get<{ policies: ModelPolicyRow[] }>('/catalog/ai/model-policies');
  return data.policies;
}

export async function patchModelPolicy(id: number, body: { model?: string; enabled?: boolean }): Promise<void> {
  await apiClient.patch(`/catalog/ai/model-policies/${id}`, body);
}

// ── Preview ────────────────────────────────────────────────────────────────
export interface PreviewEvent {
  type: string;
  text?: string;
  tool?: string;
  node?: string;
  node_type?: string;
  ok?: boolean;
  latency_ms?: number;
  run_id?: string;
  nodes?: string[];
  errors?: { node?: string; code?: string }[];
  usd?: number;
  model_calls?: number;
  tool_calls?: number;
  verification?: { coverage: number | null; total_numbers: number; matched: number } | null;
  [k: string]: unknown;
}

/**
 * Stream a draft flow run. Uses fetch (not apiClient) because this is SSE, and
 * the axios client buffers the whole body — which would defeat the point: the
 * builder needs to watch nodes light up as they execute.
 */
export async function runPreview(
  body: { flow_key: string; version: number; token: string; question: string },
  onEvent: (ev: PreviewEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const base = process.env.NEXT_PUBLIC_API_URL || '/api/v1';
  const res = await fetch(`${base}/catalog/ai/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = j?.detail || detail;
    } catch { /* body was not json */ }
    throw new Error(detail);
  }
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as PreviewEvent);
      } catch { /* ignore a partial frame */ }
    }
  }
}

// ── Lifecycle: versions, diff, impact, eval ────────────────────────────────
export interface FlowDiff {
  flow_key: string;
  target_version: number;
  base_version: number | null;
  is_first_publish: boolean;
  nodes_added: string[];
  nodes_removed: string[];
  nodes_changed: string[];
  agents_added: string[];
  agents_removed: string[];
  limit_changes: Record<string, { from: unknown; to: unknown }>;
  eval: { target: number | null; base: number | null };
}

export interface FlowImpact {
  assistants: { key: string; display_name: string; status: string }[];
  bindings: { surface: string; surface_ref: string | null; enabled: boolean; assistant_key: string | null }[];
  assistant_count: number;
  binding_count: number;
}

export interface EvalCheck {
  key: string; label_vi: string; passed: boolean; hard: boolean; detail: string;
}

export interface EvalResult {
  flow_key: string;
  version: number;
  pass_rate: number;
  passed: number;
  total: number;
  can_publish: boolean;
  checks: EvalCheck[];
  note: string;
}

export async function listFlowVersions(flowKey: string): Promise<FlowSummary[]> {
  const { data } = await apiClient.get<{ versions: FlowSummary[] }>(
    `/catalog/ai/flows/${flowKey}/versions`,
  );
  return data.versions;
}

export async function getFlowDiff(flowKey: string, version: number, against?: number): Promise<FlowDiff> {
  const { data } = await apiClient.get<FlowDiff>(
    `/catalog/ai/flows/${flowKey}/${version}/diff`,
    { params: against != null ? { against } : undefined },
  );
  return data;
}

export async function getFlowImpact(flowKey: string): Promise<FlowImpact> {
  const { data } = await apiClient.get<FlowImpact>(`/catalog/ai/flows/${flowKey}/impact`);
  return data;
}

export async function runFlowEval(flowKey: string, version: number): Promise<EvalResult> {
  const { data } = await apiClient.post<EvalResult>(`/catalog/ai/flows/${flowKey}/${version}/eval`);
  return data;
}

export async function setFlowStatus(flowKey: string, version: number, status: string): Promise<FlowDetail> {
  const { data } = await apiClient.post<FlowDetail>(
    `/catalog/ai/flows/${flowKey}/${version}/status`, { status },
  );
  return data;
}
