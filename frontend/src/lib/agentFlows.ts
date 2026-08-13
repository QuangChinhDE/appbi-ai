/**
 * Agent Flows client — /api/v1/agent-flows/*
 *
 * A flow is a TREE of typed nodes that a public link points at. It is a
 * first-class, shareable resource: any link may use any flow shared with its
 * owner, and a flow never knows which report it will serve.
 *
 * Two rules this file exists to keep:
 *
 *  1. NOTHING IS HARD-CODED HERE. Tools, models, attachable sources and the NODE
 *     LIBRARY all come from the server. The previous version kept a hand-written
 *     capability table in the frontend and it drifted from the executor — a palette
 *     entry that publishes a flow which then does nothing.
 *
 *  2. A FLOW DECLARES WHAT IT NEEDS; A BINDING SAYS WHAT THAT MEANS ON ONE LINK.
 *     The link's data scope is defined BEFORE the flow is assigned, and a link with
 *     no valid binding does not answer. There is no run-time inference to fall back
 *     on, by design.
 */
import { apiClient } from './api-client';

export type Provider = 'inherit' | 'openai' | 'anthropic' | 'gemini';

// ── Node library (server-generated) ─────────────────────────────────────────
export type NodeCategory = 'ai' | 'data' | 'logic' | 'flow' | 'utility';

export interface NodeSpec {
  type: NodeType;
  label_vi: string;
  label_en: string;
  description_vi: string;
  category: NodeCategory;
  icon: string;
  /** Whether this node type costs a model call. Nine of twelve do not, and saying
   *  so in the palette is what stops an author reaching for an AI Agent to do
   *  something the engine can just do. */
  costs_llm: boolean;
  reaches_outside: boolean;
  /** Grantable while authoring, decided per link at run time. Distinct from
   *  `available`, which answers "would THIS deployment dispatch it". */
  gated_by_link: boolean;
  available: boolean;
}

export type NodeType =
  | 'agent' | 'report_read' | 'knowledge' | 'web'
  | 'if' | 'switch' | 'loop' | 'filter'
  | 'set_var' | 'transform' | 'stop' | 'delay';

// ── Tools & models ──────────────────────────────────────────────────────────

/** What shape a tool's result has. Mirrors `ResultKind` in
 *  `agent_flows/tools/result.py`; an author reads it to know whether the next
 *  node can use the result directly or needs a model to interpret it. */
export type ResultKind =
  | 'value' | 'ranking' | 'table' | 'series' | 'comparison'
  | 'diagnosis' | 'projection' | 'documents' | 'narrative' | 'catalogue';

export interface ToolSpec {
  name: string;
  label_vi: string;
  label_en: string;
  description_vi: string;
  /** What the call costs the WAREHOUSE. */
  cost_class: 'cheap' | 'data_query' | 'expensive' | 'external';
  /** How big the RESULT is — the other cost axis, and the one that used to be
   *  invisible. `list_charts` queries nothing (so: cheap) and returned ~15,600
   *  tokens on a 70-chart report, which is what an agent actually spends. */
  payload?: 'small' | 'medium' | 'large' | 'scales_with_report';
  reaches_outside: boolean;
  /** The output half of the contract — what comes back, and how it may be used.
   *  Optional so a frontend deployed ahead of the backend degrades to the old
   *  picker rather than rendering `undefined`. */
  result_kind?: ResultKind;
  /** `{field: what it holds}`, for wiring a result into the next node. */
  returns?: Record<string, string>;
  deterministic?: boolean;
  cacheable?: boolean;
  /** Answers a question on its own — no model needed to read the result. These
   *  are the cheap ones, and the reason the catalogue can keep growing. */
  self_sufficient?: boolean;
  answers_vi?: string[];
}

export interface ToolPack {
  key: string;
  label_vi: string;
  label_en: string;
  /** One line on when to reach into this pack. */
  purpose_vi?: string;
  available: boolean;
  requires_setting: string | null;
  gated_by_link: boolean;
  gate_note_vi: string;
  tools: ToolSpec[];
}

export interface ProviderGroup {
  provider: Provider;
  label: string;
  models: { model: string; label: string; tier_hint: string }[];
  note: string;
}

export interface AttachableItem { ref: string; name: string; group?: string }
export interface Attachable {
  documents: AttachableItem[];
  datasets: AttachableItem[];
  /** A metric ref is matched at run time against its machine name, so it must be
   *  PICKED, never typed. */
  metrics: AttachableItem[];
}

// ── The flow tree ───────────────────────────────────────────────────────────
export interface ToolGrant { tool: string; note?: string }
export interface KnowledgeAttachment {
  source: 'document' | 'semantic' | 'metric';
  ref: string;
  description: string;
}

export type ConditionOp =
  | 'contains' | 'not_contains' | 'equals' | 'not_equals'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'is_empty' | 'is_not_empty' | 'matches' | 'in_list';

export interface Condition { left: string; op: ConditionOp; right?: string }

/** How often a node runs across the turns of ONE conversation. Explicit rather
 *  than inferred from "does the variable already have a value" — inferred skipping
 *  is control flow that never appears on the canvas. */
export type RunPolicy = 'every_turn' | 'once_per_session' | 'when_stale';
/** How much of the transcript this node's model sees. The engine used to send all
 *  of it to every step; a switch condition does not need the greeting. */
export type ContextPolicy = 'none' | 'question' | 'last_3' | 'full';

export interface BaseNode {
  key: string;
  type: NodeType;
  name?: string;
  output_var?: string;
  run_policy?: RunPolicy;
  context_policy?: ContextPolicy;
  retry?: { max_attempts: number; backoff_seconds: number; on: 'error' | 'empty' | 'either' } | null;
  on_error?: 'continue' | 'stop';
  comment?: string;
}

export interface AgentNode extends BaseNode {
  type: 'agent';
  prompt: string;
  provider?: Provider;
  model?: string;
  tools?: ToolGrant[];
  knowledge?: KnowledgeAttachment[];
  max_tool_calls?: number;
  /** `chat` streams prose and is the default. `json` asks for typed answer blocks —
   *  richer, but not streamable, because half a JSON object cannot be rendered. */
  output_format?: 'chat' | 'json';
  /** Read-only, from the server: is a token stored for this node. The value itself
   *  is never returned, so `api_key` empty means KEEP and erasing needs its own
   *  flag. */
  has_api_key?: boolean;
  api_key?: string;
  api_key_clear?: boolean;
}

export interface ReportReadNode extends BaseNode {
  type: 'report_read';
  chart_ids?: number[];
  include_summary?: boolean;
  include_data?: boolean;
  include_filters?: boolean;
  max_rows?: number;
}

export interface KnowledgeNode extends BaseNode {
  type: 'knowledge';
  query?: string;
  knowledge?: KnowledgeAttachment[];
  top_k?: number;
}

export interface WebNode extends BaseNode {
  type: 'web';
  query?: string;
  /** Enforced on every fetch by the server, not merely suggested to the model. */
  allowed_domains?: string[];
  fetch_pages?: boolean;
  top_k?: number;
}

export interface SetVarNode extends BaseNode {
  type: 'set_var';
  var: string;
  value?: string;
  value_type?: 'text' | 'number' | 'object' | 'list' | 'bool';
}

export interface TransformNode extends BaseNode {
  type: 'transform';
  operation: 'append_to_list' | 'map_fields' | 'format_object' | 'join_text' | 'pick';
  source?: string;
  target?: string;
  mapping?: Record<string, string>;
  separator?: string;
}

export interface StopNode extends BaseNode { type: 'stop'; emit?: boolean; message?: string }
export interface DelayNode extends BaseNode { type: 'delay'; seconds?: number }
export interface FilterNode extends BaseNode {
  type: 'filter';
  match?: 'all' | 'any';
  conditions?: Condition[];
}

export interface FlowPath {
  key: string;
  name?: string;
  kind: 'rules' | 'always' | 'fallback';
  match?: 'all' | 'any';
  conditions?: Condition[];
  body: FlowNode[];
}

export interface IfNode extends BaseNode { type: 'if'; paths: FlowPath[] }

export interface SwitchCase {
  key: string;
  label?: string;
  op?: ConditionOp;
  value?: string;
  body: FlowNode[];
}

export interface SwitchNode extends BaseNode {
  type: 'switch';
  value: string;
  mode?: 'first_match' | 'all_match';
  cases: SwitchCase[];
  fallback?: FlowNode[];
  has_fallback?: boolean;
}

export interface LoopNode extends BaseNode {
  type: 'loop';
  over: string;
  item_var?: string;
  index_var?: string;
  max_iterations?: number;
  body: FlowNode[];
  collect_into?: string;
}

export type FlowNode =
  | AgentNode | ReportReadNode | KnowledgeNode | WebNode
  | SetVarNode | TransformNode | StopNode | DelayNode
  | FilterNode | IfNode | SwitchNode | LoopNode;

/** What a flow needs from whichever link runs it.
 *  Prefer `metric`: a governed metric name is unique and resolves on every
 *  dashboard, while a `chart` requirement is positional and has to be re-mapped by
 *  hand on each link. */
export interface Requirement {
  key: string;
  kind: 'metric' | 'dimension' | 'measure' | 'chart' | 'document' | 'dataset' | 'value';
  label?: string;
  hint?: string;
  required: boolean;
}

export interface FlowRequirements { items: Requirement[]; capabilities: string[] }

export interface FlowBody {
  schema_version?: number;
  requirements?: FlowRequirements;
  nodes: FlowNode[];
  /** The node whose text reaches the viewer. Empty means the last top-level node —
   *  named explicitly because under branching "the last one" stopped meaning
   *  anything. */
  answer_node?: string;
}

export type BrainStatus = 'draft' | 'published' | 'archived';

export interface BrainSummary {
  brain_key: string;
  version: number;
  status: BrainStatus;
  name: string;
  description: string;
  owner_email: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at?: string | null;
  published_at: string | null;
  node_count?: number;
  link_count?: number;
}

export interface BrainDetail extends BrainSummary {
  body: FlowBody;
  warnings: string[];
  reads: { source: string; label: string; ref: string }[];
  node_count: number;
  requirements: FlowRequirements;
  answer_node?: string;
  /** The three facts the title bar states — "Nháp v6 · Published v5 · 3 links" —
   *  which used to need three round trips. */
  published_version?: number | null;
}

export interface BrainVersionRow {
  version: number;
  status: BrainStatus;
  name?: string;
  created_by: string | null;
  updated_at?: string | null;
  published_at: string | null;
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  node_count?: number;
  answer_node?: string;
  requirements?: FlowRequirements;
  /** Worst case for ONE question. On a public link with an unbounded audience this
   *  is the number the author is committing to. */
  estimate?: { max_llm_calls: number; max_tool_calls: number };
  produced_vars?: string[];
  referenced_vars?: string[];
}

// ── Bindings ────────────────────────────────────────────────────────────────
export interface ResolveEntry {
  kind: 'measure' | 'dimension' | 'chart' | 'document' | 'dataset' | 'metric' | 'value';
  chart_id?: number | null;
  field?: string;
  ref?: string;
  label?: string;
  values?: unknown[];
}

export interface DataContract {
  charts: { mode: 'allowlist' | 'all_current'; ids: number[] };
  resolve: Record<string, ResolveEntry>;
  knowledge: {
    mode: 'flow_all' | 'subset';
    doc_ids?: number[];
    dataset_ids?: number[];
    metric_names?: string[];
  };
  capabilities: { web_search: boolean; read_rows: boolean; max_rows_per_call: number };
  defaults: Record<string, unknown>;
  budget: { max_llm_calls: number; max_tool_calls: number; max_seconds: number };
}

export interface Binding {
  id: number;
  link_id: number;
  brain_key: string;
  pinned_version: number | null;
  status: 'draft' | 'active' | 'broken' | 'needs_review';
  data_contract: DataContract;
  last_validation: { errors?: PreflightIssue[]; warnings?: PreflightIssue[] };
  store_question_content: boolean;
  validated_at: string | null;
}

export interface PreflightIssue { code: string; key: string; message: string }

export interface PreflightResult {
  ok: boolean;
  errors: PreflightIssue[];
  warnings: PreflightIssue[];
  estimate: { max_llm_calls: number; max_tool_calls: number };
  resolved: string[];
  unresolved: string[];
}

export interface BindingCandidates {
  requirements: FlowRequirements;
  charts: {
    id: number;
    title: string;
    chart_type: string;
    measures: { field: string; label: string }[];
    dimensions: { field: string; label: string }[];
  }[];
  flow_knowledge: { source: string; ref: string; description: string }[];
  flow_capabilities: { web_search: boolean };
}

export interface FlowLinkUsage {
  binding_id: number;
  link_id: number;
  link_name: string;
  token: string;
  dashboard_id: number;
  status: Binding['status'];
  pinned_version: number | null;
  bot_enabled: boolean;
  link_active: boolean;
  validated_at: string | null;
  issues: PreflightIssue[];
  warnings: PreflightIssue[];
}

// ── Runs ────────────────────────────────────────────────────────────────────
export interface RunRow {
  id: number;
  run_key: string;
  at: string | null;
  status: 'ok' | 'partial' | 'blocked' | 'failed' | 'throttled';
  link_token: string | null;
  binding_id: number | null;
  version: number | null;
  question: string | null;
  execution_path: string | null;
  latency_ms: number | null;
  tokens: number;
  rating: 'up' | 'down' | null;
  is_test: boolean;
  blocked_reason: string | null;
}

export interface RunStep {
  seq: number;
  key: string;
  type: string | null;
  name: string | null;
  /** `reused` is not a flavour of ok — a table that reports a skipped node as
   *  having run misstates what the turn cost. */
  status: 'ok' | 'error' | 'skipped' | 'reused' | 'blocked';
  ms: number | null;
  branch: string | null;
  iteration: number | null;
  preview: string | null;
  error: string | null;
}

export interface RunDetail {
  id: number;
  run_key: string;
  at: string | null;
  status: RunRow['status'];
  version: number | null;
  link_token: string | null;
  binding_id: number | null;
  execution_path: string | null;
  latency_ms: number | null;
  usage: { llm_calls: number; tool_calls: number; prompt_tokens: number; completion_tokens: number };
  rating: 'up' | 'down' | null;
  question: string | null;
  answer: string | null;
  citations: unknown[];
  notices: { code: string; text: string }[];
  replayable: boolean;
  steps: RunStep[];
}

export interface RunStats {
  runs: number;
  success_rate: number;
  p95_latency_ms: number;
  avg_tokens: number;
  errors: number;
  window_hours: number;
  links: number;
}

export interface ActivityEvent {
  at: string | null;
  action: string;
  actor: string | null;
  version: number | null;
  summary: string;
  details: Record<string, unknown>;
}

// ── Answer blocks (what the bot renders) ────────────────────────────────────
export interface SourceRef { chart_id?: number | null; doc_id?: number | null; metric?: string }

export type AnswerBlock =
  | { type: 'text'; markdown: string }
  | {
      type: 'metric'; label: string; value: unknown; format: string;
      delta?: { value: number; format: string; direction: 'up' | 'down' | 'flat' } | null;
      source?: SourceRef | null;
    }
  | {
      type: 'table';
      columns: { key: string; label: string; format: string }[];
      rows: Record<string, unknown>[];
      source?: SourceRef | null;
    }
  | {
      type: 'chart_ref'; chart_id: number;
      highlight?: { field: string; values: unknown[] } | null;
      caption?: string;
    }
  | { type: 'callout'; level: 'info' | 'warning' | 'danger'; text: string }
  | { type: 'followups'; items: string[] };

export interface FlowOutputEnvelope {
  schema_version: number;
  run_id: string;
  status: 'ok' | 'partial' | 'blocked' | 'failed';
  answer: { blocks: AnswerBlock[] };
  citations: { kind: string; ref: string; label?: string; url?: string; quote?: string }[];
  notices: { code: string; text: string }[];
  trace: { path: string; steps: RunStep[] };
  usage: { llm_calls: number; tool_calls: number; prompt_tokens: number; completion_tokens: number; ms: number };
}

const BASE = '/agent-flows';

/** Hard caps, mirrored from `contract.py`. A number input that bounds itself to a
 *  different number than the server does is a 422 the author cannot see coming. */
export const MAX_NODES = 40;
export const MAX_DEPTH = 4;
export const MAX_LOOP_ITERATIONS = 25;
export const MAX_TOOL_CALLS = 30;
export const MIN_KNOWLEDGE_DESCRIPTION = 10;

// ── Catalogues ──────────────────────────────────────────────────────────────
export async function listNodeSpecs(webEnabled = true): Promise<NodeSpec[]> {
  const { data } = await apiClient.get<{ nodes: NodeSpec[] }>(
    `${BASE}/nodes`, { params: { web_enabled: webEnabled } });
  return data.nodes || [];
}

export async function listToolPacks(webEnabled = false): Promise<ToolPack[]> {
  const { data } = await apiClient.get<{ packs: ToolPack[] }>(
    `${BASE}/tools`, { params: { web_enabled: webEnabled } });
  return data.packs || [];
}

export async function listProviders(): Promise<ProviderGroup[]> {
  const { data } = await apiClient.get<{ providers: ProviderGroup[] }>(`${BASE}/models`);
  return data.providers || [];
}

export async function listAttachable(): Promise<Attachable> {
  const { data } = await apiClient.get<Attachable>(`${BASE}/attachable`);
  return {
    documents: data.documents || [],
    datasets: data.datasets || [],
    metrics: data.metrics || [],
  };
}

// ── Drafting a flow with an outside assistant ───────────────────────────────
export interface AuthoringPrompt {
  prompt: string;
  stats: { node_types: number; tool_packs: number; tools: number };
  author_supplied_fields: string[];
}

export interface ImportedDraft {
  ok: boolean;
  errors: string[];
  warnings: string[];
  name?: string;
  description?: string;
  body?: Record<string, unknown>;
  node_count?: number;
  answer_node?: string;
  todo?: string[];
  needs_attachment?: { key: string; name: string; missing: string[]; why: string }[];
}

/** The brief to paste into ChatGPT/Claude. Generated server-side from the live
 *  registries, so it can never describe a node type this deployment lacks. */
export async function getAuthoringPrompt(): Promise<AuthoringPrompt> {
  const { data } = await apiClient.get<AuthoringPrompt>(`${BASE}/authoring-prompt`);
  return data;
}

/** Parse a pasted draft and report what it is. Saves NOTHING — creating stays
 *  the explicit action, because a draft written elsewhere is the least trusted
 *  input this module takes and the author has not read it yet. */
export async function importDraft(raw: string, name?: string): Promise<ImportedDraft> {
  const { data } = await apiClient.post<ImportedDraft>(`${BASE}/import-draft`, { raw, name });
  return data;
}

// ── Flows ───────────────────────────────────────────────────────────────────
export async function listBrains(): Promise<BrainSummary[]> {
  const { data } = await apiClient.get<{ brains: BrainSummary[] }>(`${BASE}/brains`);
  return data.brains || [];
}

export async function getBrain(key: string, version?: number): Promise<BrainDetail> {
  const { data } = await apiClient.get<BrainDetail>(
    `${BASE}/brains/${encodeURIComponent(key)}`,
    { params: version ? { version } : undefined });
  return data;
}

export async function saveBrain(body: {
  brain_key: string; name: string; description: string; body: FlowBody;
}): Promise<BrainDetail> {
  const { data } = await apiClient.put<BrainDetail>(`${BASE}/brains`, body);
  return data;
}

/** Check without saving, so the validity badge can update while the author types.
 *  Before this the only way to see a warning was to save — and saving used to mint
 *  a version, so the act of checking changed the thing being checked. */
export async function validateFlow(body: {
  brain_key: string; name: string; body: FlowBody;
}): Promise<ValidateResult> {
  const { data } = await apiClient.post<ValidateResult>(`${BASE}/validate`, body);
  return data;
}

export async function publishBrain(
  key: string, version: number,
): Promise<BrainDetail & { pinned_links?: { link_name: string; reasons: string[] }[] }> {
  const { data } = await apiClient.post(
    `${BASE}/brains/${encodeURIComponent(key)}/${version}/publish`, {});
  return data;
}

export async function rollbackBrain(key: string): Promise<BrainDetail> {
  const { data } = await apiClient.post<BrainDetail>(
    `${BASE}/brains/${encodeURIComponent(key)}/rollback`, {});
  return data;
}

/** Load an old version back onto the canvas. NOT `rollback` — that re-publishes to
 *  viewers; this only changes what the author is editing. */
export async function restoreToDraft(key: string, version: number): Promise<BrainDetail> {
  const { data } = await apiClient.post<BrainDetail>(
    `${BASE}/brains/${encodeURIComponent(key)}/versions/${version}/restore-to-draft`, {});
  return data;
}

export async function deleteBrainVersion(key: string, version: number): Promise<void> {
  await apiClient.delete(`${BASE}/brains/${encodeURIComponent(key)}/${version}`);
}

export async function listVersions(key: string): Promise<BrainVersionRow[]> {
  const { data } = await apiClient.get<{ versions: BrainVersionRow[] }>(
    `${BASE}/brains/${encodeURIComponent(key)}/versions`);
  return data.versions || [];
}

export async function brainImpact(key: string): Promise<{
  links: FlowLinkUsage[]; count: number; broken: number; needs_review: number;
}> {
  const { data } = await apiClient.get(`${BASE}/brains/${encodeURIComponent(key)}/impact`);
  return data;
}

export async function brainActivity(key: string, limit = 100): Promise<ActivityEvent[]> {
  const { data } = await apiClient.get<{ events: ActivityEvent[] }>(
    `${BASE}/brains/${encodeURIComponent(key)}/activity`, { params: { limit } });
  return data.events || [];
}

// ── Runs ────────────────────────────────────────────────────────────────────
export async function listRuns(key: string, params: {
  status?: string; binding_id?: number; since_hours?: number;
  search?: string; include_tests?: boolean; limit?: number; offset?: number;
} = {}): Promise<{ total: number; runs: RunRow[] }> {
  const { data } = await apiClient.get(
    `${BASE}/brains/${encodeURIComponent(key)}/runs`, { params });
  return data;
}

export async function runStats(key: string, sinceHours = 24): Promise<RunStats> {
  const { data } = await apiClient.get<RunStats>(
    `${BASE}/brains/${encodeURIComponent(key)}/runs/stats`, { params: { since_hours: sinceHours } });
  return data;
}

export async function runDetail(key: string, runId: number): Promise<RunDetail> {
  const { data } = await apiClient.get<RunDetail>(
    `${BASE}/brains/${encodeURIComponent(key)}/runs/${runId}`);
  return data;
}

/** How often each node actually ran. Drawn ON the canvas — a branch nobody reaches
 *  is a branch to delete, and no author finds that by re-reading their own diagram. */
export async function branchCoverage(key: string, days = 30): Promise<Record<string, number>> {
  const { data } = await apiClient.get<{ counts: Record<string, number> }>(
    `${BASE}/brains/${encodeURIComponent(key)}/runs/coverage`, { params: { days } });
  return data.counts || {};
}

// ── Test ────────────────────────────────────────────────────────────────────
export async function testFlow(key: string, body: {
  question: string; link_id: number; version?: number;
}): Promise<{ envelope: FlowOutputEnvelope | null }> {
  const { data } = await apiClient.post(
    `${BASE}/brains/${encodeURIComponent(key)}/test`, body);
  return data;
}

export async function testNode(key: string, nodeKey: string, body: {
  link_id: number; vars?: Record<string, unknown>; version?: number;
}): Promise<Record<string, unknown>> {
  const { data } = await apiClient.post(
    `${BASE}/brains/${encodeURIComponent(key)}/nodes/${encodeURIComponent(nodeKey)}/test`, body);
  return data;
}

// ── Bindings ────────────────────────────────────────────────────────────────
export async function getBinding(linkId: number): Promise<Binding | null> {
  const { data } = await apiClient.get<{ binding: Binding | null }>(
    `${BASE}/bindings/link/${linkId}`);
  return data.binding;
}

export async function bindingCandidates(
  linkId: number, brainKey: string,
): Promise<BindingCandidates> {
  const { data } = await apiClient.get<BindingCandidates>(
    `${BASE}/bindings/link/${linkId}/candidates`, { params: { brain_key: brainKey } });
  return data;
}

export async function preflightBinding(body: {
  link_id: number; brain_key: string; data_contract: Partial<DataContract>;
  pinned_version?: number | null; store_question_content?: boolean;
}): Promise<PreflightResult> {
  const { data } = await apiClient.post<PreflightResult>(`${BASE}/bindings/preflight`, body);
  return data;
}

export async function saveBinding(body: {
  link_id: number; brain_key: string; data_contract: Partial<DataContract>;
  pinned_version?: number | null; store_question_content?: boolean;
}): Promise<{ binding_id: number; status: string } & PreflightResult> {
  const { data } = await apiClient.put(`${BASE}/bindings`, body);
  return data;
}

export async function deleteBinding(linkId: number): Promise<void> {
  await apiClient.delete(`${BASE}/bindings/link/${linkId}`);
}

// ── Tree helpers ────────────────────────────────────────────────────────────
/** Every node in the tree, in document order. The canvas, the validity badge and
 *  the key-uniqueness check all need this and must not each walk it differently. */
export function walkNodes(nodes: FlowNode[]): FlowNode[] {
  const out: FlowNode[] = [];
  const visit = (list: FlowNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.type === 'if') n.paths.forEach((p) => visit(p.body || []));
      else if (n.type === 'switch') {
        n.cases.forEach((c) => visit(c.body || []));
        visit(n.fallback || []);
      } else if (n.type === 'loop') visit(n.body || []);
    }
  };
  visit(nodes || []);
  return out;
}

export function findNode(nodes: FlowNode[], key: string): FlowNode | null {
  return walkNodes(nodes).find((n) => n.key === key) || null;
}

/** Replace one node anywhere in the tree, returning a new tree.
 *  Immutable so React state updates are safe and undo can hold snapshots. */
export function replaceNode(nodes: FlowNode[], key: string, next: FlowNode): FlowNode[] {
  return (nodes || []).map((n) => {
    if (n.key === key) return next;
    if (n.type === 'if') {
      return { ...n, paths: n.paths.map((p) => ({ ...p, body: replaceNode(p.body || [], key, next) })) };
    }
    if (n.type === 'switch') {
      return {
        ...n,
        cases: n.cases.map((c) => ({ ...c, body: replaceNode(c.body || [], key, next) })),
        fallback: replaceNode(n.fallback || [], key, next),
      };
    }
    if (n.type === 'loop') return { ...n, body: replaceNode(n.body || [], key, next) };
    return n;
  });
}

export function removeNode(nodes: FlowNode[], key: string): FlowNode[] {
  return (nodes || [])
    .filter((n) => n.key !== key)
    .map((n) => {
      if (n.type === 'if') {
        return { ...n, paths: n.paths.map((p) => ({ ...p, body: removeNode(p.body || [], key) })) };
      }
      if (n.type === 'switch') {
        return {
          ...n,
          cases: n.cases.map((c) => ({ ...c, body: removeNode(c.body || [], key) })),
          fallback: removeNode(n.fallback || [], key),
        };
      }
      if (n.type === 'loop') return { ...n, body: removeNode(n.body || [], key) };
      return n;
    });
}

/** Where a new node goes. A container path is `<nodeKey>:<group>:<index>` — e.g.
 *  `gate:path:yes` or `per_seg:body` — so an insert point on the canvas can name
 *  its own destination instead of the canvas keeping a parallel map of them. */
export type InsertTarget = { containerPath: string; index: number };

export function insertNode(
  nodes: FlowNode[], target: InsertTarget, node: FlowNode,
): FlowNode[] {
  const { containerPath, index } = target;
  if (!containerPath) {
    const next = [...(nodes || [])];
    next.splice(Math.min(index, next.length), 0, node);
    return next;
  }
  const [ownerKey, group, groupKey] = containerPath.split(':');
  return (nodes || []).map((n) => {
    if (n.key !== ownerKey) {
      if (n.type === 'if') {
        return { ...n, paths: n.paths.map((p) => ({ ...p, body: insertNode(p.body || [], target, node) })) };
      }
      if (n.type === 'switch') {
        return {
          ...n,
          cases: n.cases.map((c) => ({ ...c, body: insertNode(c.body || [], target, node) })),
          fallback: insertNode(n.fallback || [], target, node),
        };
      }
      if (n.type === 'loop') return { ...n, body: insertNode(n.body || [], target, node) };
      return n;
    }
    if (n.type === 'if' && group === 'path') {
      return {
        ...n,
        paths: n.paths.map((p) => {
          if (p.key !== groupKey) return p;
          const body = [...(p.body || [])];
          body.splice(Math.min(index, body.length), 0, node);
          return { ...p, body };
        }),
      };
    }
    if (n.type === 'switch' && group === 'case') {
      return {
        ...n,
        cases: n.cases.map((c) => {
          if (c.key !== groupKey) return c;
          const body = [...(c.body || [])];
          body.splice(Math.min(index, body.length), 0, node);
          return { ...c, body };
        }),
      };
    }
    if (n.type === 'switch' && group === 'fallback') {
      const body = [...(n.fallback || [])];
      body.splice(Math.min(index, body.length), 0, node);
      return { ...n, fallback: body };
    }
    if (n.type === 'loop' && group === 'body') {
      const body = [...(n.body || [])];
      body.splice(Math.min(index, body.length), 0, node);
      return { ...n, body };
    }
    return n;
  });
}

/** Where a node currently sits, in the same coordinates an insert point uses. */
export function locateNode(
  nodes: FlowNode[], key: string, containerPath = '',
): { containerPath: string; index: number } | null {
  for (let i = 0; i < (nodes || []).length; i += 1) {
    const n = nodes[i];
    if (n.key === key) return { containerPath, index: i };
    if (n.type === 'if') {
      for (const p of n.paths) {
        const hit = locateNode(p.body || [], key, `${n.key}:path:${p.key}`);
        if (hit) return hit;
      }
    } else if (n.type === 'switch') {
      for (const c of n.cases) {
        const hit = locateNode(c.body || [], key, `${n.key}:case:${c.key}`);
        if (hit) return hit;
      }
      const fb = locateNode(n.fallback || [], key, `${n.key}:fallback:`);
      if (fb) return fb;
    } else if (n.type === 'loop') {
      const hit = locateNode(n.body || [], key, `${n.key}:body:`);
      if (hit) return hit;
    }
  }
  return null;
}

/** Every key inside `key`'s own subtree, including itself.
 *  A drag that drops a container into its own body would detach the whole branch
 *  from the tree — the node would vanish and its children with it. */
export function subtreeKeys(nodes: FlowNode[], key: string): Set<string> {
  const node = findNode(nodes, key);
  if (!node) return new Set([key]);
  return new Set(walkNodes([node]).map((n) => n.key));
}

/** Can `key` be dropped into `containerPath` without swallowing itself? */
export function canDropInto(nodes: FlowNode[], key: string, containerPath: string): boolean {
  if (!containerPath) return true;
  const owner = containerPath.split(':')[0];
  return !subtreeKeys(nodes, key).has(owner);
}

/** Move a node to a new position.
 *
 *  Removes first, then inserts — and drops the index by one when the move is
 *  DOWNWARD inside the same container, because removing the node shifted every
 *  later sibling up. Without that a node dragged one slot down lands where it
 *  started, which reads as "drag doesn't work". */
export function moveNode(
  nodes: FlowNode[], key: string, target: InsertTarget,
): FlowNode[] {
  if (!canDropInto(nodes, key, target.containerPath)) return nodes;
  const from = locateNode(nodes, key);
  const node = findNode(nodes, key);
  if (!node || !from) return nodes;

  let index = target.index;
  if (from.containerPath === target.containerPath && from.index < target.index) {
    index -= 1;
  }
  if (from.containerPath === target.containerPath && index === from.index) return nodes;
  return insertNode(removeNode(nodes, key), { ...target, index }, node);
}

/** A flow's stable identity, derived from its first name. Mirrors the server's
 *  `_KEY_RE`: lowercase letters, digits and underscores, starting with a letter.
 *  Derived rather than typed, because the key is what public links store and a
 *  free-text field invites someone to change it later. */
export function slugifyBrainKey(name: string): string {
  const base = (name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40);
  return base || `flow_${Date.now().toString(36)}`;
}

/** A key that is unique across the WHOLE tree. Duplicates are a 422 from the
 *  server, and a builder that can produce one has simply moved the error later. */
export function uniqueKey(nodes: FlowNode[], base: string): string {
  const taken = new Set(walkNodes(nodes).map((n) => n.key));
  const root = base.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '') || 'node';
  if (!taken.has(root)) return root;
  for (let i = 2; i < 500; i += 1) if (!taken.has(`${root}_${i}`)) return `${root}_${i}`;
  return `${root}_${Date.now().toString(36)}`;
}

/** A new node of `type`, with the defaults the server would apply anyway. Kept
 *  here so the canvas never inserts a node the contract would reject. */
export interface BlankNodeLabels {
  agentPrompt?: string;
  pathA?: string;
  pathB?: string;
}

export function blankNode(type: NodeType, nodes: FlowNode[], labels: BlankNodeLabels = {}): FlowNode {
  const key = uniqueKey(nodes, type);
  const base = { key, name: '' };
  switch (type) {
    case 'agent':
      return { ...base, type, prompt: labels.agentPrompt || 'Describe what this step should do.', provider: 'inherit',
        max_tool_calls: 8, output_format: 'chat', context_policy: 'question', tools: [], knowledge: [] };
    case 'report_read':
      return { ...base, type, output_var: uniqueKey(nodes, 'dashboard_context'),
        include_summary: true, include_data: true, include_filters: true,
        max_rows: 200, run_policy: 'when_stale' };
    case 'knowledge':
      return { ...base, type, query: '{{question}}', top_k: 5, knowledge: [],
        output_var: uniqueKey(nodes, 'knowledge_context') };
    case 'web':
      return { ...base, type, query: '{{question}}', top_k: 5, fetch_pages: true,
        allowed_domains: [], output_var: uniqueKey(nodes, 'web_context') };
    case 'if':
      return { ...base, type, paths: [
        { key: 'yes', name: labels.pathA || 'Branch A', kind: 'rules', match: 'all',
          conditions: [{ left: '{{question}}', op: 'contains', right: '' }], body: [] },
        { key: 'no', name: labels.pathB || 'Branch B', kind: 'fallback', body: [] },
      ] };
    case 'switch':
      return { ...base, type, value: '{{}}', mode: 'first_match', has_fallback: true,
        cases: [{ key: 'case_1', label: 'CASE 1', op: 'equals', value: '', body: [] }], fallback: [] };
    case 'loop':
      return { ...base, type, over: '{{}}', item_var: 'item', max_iterations: 10, body: [],
        collect_into: uniqueKey(nodes, 'all_findings') };
    case 'filter':
      return { ...base, type, match: 'all', conditions: [{ left: '{{}}', op: 'is_not_empty' }] };
    case 'set_var':
      return { ...base, type, var: uniqueKey(nodes, 'my_var'), value: '', value_type: 'text' };
    case 'transform':
      return { ...base, type, operation: 'append_to_list', source: '{{previous}}',
        target: uniqueKey(nodes, 'all_items'), mapping: {}, separator: '\n' };
    case 'stop':
      return { ...base, type, emit: true, message: '' };
    case 'delay':
      return { ...base, type, seconds: 3 };
    default:
      return { ...base, type: 'set_var', var: 'my_var', value: '' } as FlowNode;
  }
}
