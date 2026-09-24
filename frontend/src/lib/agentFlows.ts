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
  | 'agent' | 'coordinate' | 'report_read' | 'knowledge' | 'web' | 'tool'
  | 'if' | 'switch' | 'loop' | 'filter'
  | 'set_var' | 'transform' | 'stop' | 'delay' | 'skill';

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
  /** How dangerous calling it is. `unknown` means nobody classified it yet, and
   *  the backend refuses to run such a tool as an action. */
  risk?: 'unknown' | 'read_only' | 'side_effect' | 'destructive';
  /** JSON Schema of `result.data` — not of the envelope. */
  output_schema?: Record<string, unknown>;
  /** One row per argument, FOR RENDERING A FORM. Not a schema to validate
   *  against: the backend is the only place an argument is judged. */
  inputs?: Record<string, { type: string; required: boolean; description: string }>;
  /** Everything the tool can be FOUND by. The same text the runtime's capability
   *  discovery ranks it on, so what an author can search for and what an Agent
   *  can discover never disagree. */
  search_text?: string;
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

export interface AttachableItem {
  ref: string;
  name: string;
  group?: string;
  /** False for vocabulary — a definition with no query behind it. The builder
   *  shows this so an author can see how far an attachment reaches. */
  reads_data?: boolean;
  hint?: string;
}
export interface Attachable {
  documents: AttachableItem[];
  datasets: AttachableItem[];
  /** A metric ref is matched at run time against its machine name, so it must be
   *  PICKED, never typed. */
  metrics: AttachableItem[];
  /** Company vocabulary, addressed by FQN (`bộ-từ-điển.thuật-ngữ`). */
  terms: AttachableItem[];
}

// ── Notices ─────────────────────────────────────────────────────────────────
//
// Defined in `./notices` and re-exported here. It is a separate module because
// this one imports `apiClient`, and a VALUE import of these helpers from a
// component reachable by the public dashboard page would drag the authed client
// into the public bundle. See the note in `notices.ts`.
import type { FlowNotice } from './notices';

export type { FlowNotice, NoticeAudience } from './notices';
export { authorNotices, isAuthorNotice, readerNotices } from './notices';

// ── The flow tree ───────────────────────────────────────────────────────────
export interface ToolGrant {
  tool: string;
  note?: string;
  /** Skill grants (`skill:<key>`) only: the exact Skill version a PUBLISHED flow
   *  runs. Written by the server at publish; empty on a draft, which uses the
   *  latest published version. */
  version?: number | null;
}

/** A grant naming a published Skill rather than a registry tool. */
export const SKILL_GRANT_PREFIX = 'skill:';
export const skillGrant = (key: string) => `${SKILL_GRANT_PREFIX}${key}`;
export const skillKeyOfGrant = (tool: string) =>
  tool.startsWith(SKILL_GRANT_PREFIX) ? tool.slice(SKILL_GRANT_PREFIX.length) : null;
export interface KnowledgeAttachment {
  source: 'document' | 'semantic' | 'metric' | 'term';
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
   *  richer, but not streamable, because half a JSON object cannot be rendered.
   *  `choice` is a CLASSIFIER: the step emits exactly one of `choices` and the
   *  runtime enforces it rather than asking for it. */
  output_format?: 'chat' | 'json' | 'choice';
  /** The only answers a `choice` step may give. A Switch downstream matches on
   *  these, so they are values, not prose. */
  choices?: string[];
  /** What each choice MEANS, keyed by the choice. Optional and worth writing: a
   *  model handed bare variable names is guessing at what they stand for, and
   *  measured on a coverage harness it sent a plain lookup down the forecast
   *  branch. */
  choice_hints?: Record<string, string>;
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
  /** Read the charts the question is about instead of everything allowed. */
  match_question?: boolean;
  /** What to match on. Blank = the viewer's question. */
  query?: string;
  max_charts?: number;
  /** How much of each chart to carry forward. The backend has always had this and
   *  it is the single biggest lever on what the next step is handed - measured
   *  49,471 chars at `full` against 8,244 at `compact` on the same twenty-chart
   *  read - but until now no control existed for it, so every flow ran on the
   *  default and authors tuned the toggles they could see instead. */
  detail?: 'index' | 'compact' | 'full';
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

/** One sub-agent a coordinator may dispatch to.
 *
 *  `when` is required by the contract and the reason is measured: a classifier
 *  handed bare keys — `tra_so`, `so_sanh`, `bat_thuong` — sent "GMV toàn kỳ là bao
 *  nhiêu?" down the FORECAST branch and never once fired the lookup case. Those are
 *  variable names, not descriptions, and the planner reads this line to choose. */
export interface Specialist {
  key: string;
  name?: string;
  when: string;
  body: FlowNode[];
}

/** One agent picks the specialists a question needs; they run; the answer combines.
 *
 *  Routing used to be `if`/`switch` on conditions the author wrote by hand, which
 *  needs the questions enumerated in advance — the one thing a viewer's question
 *  never is. */
export interface CoordinateNode extends BaseNode {
  type: 'coordinate';
  prompt?: string;
  provider?: string;
  model?: string;
  api_key?: string;
  api_key_clear?: boolean;
  specialists: Specialist[];
  /** Ceiling on ONE plan. Each extra specialist is another model call for the
   *  same question, so this is a cost control, not a preference. */
  max_specialists?: number;
  /** Runs when the plan names nobody. Empty is fine: the answering step then says
   *  the question fitted none of them, which is the honest outcome. */
  fallback?: FlowNode[];
}

/** One argument of a ToolNode, bound to a variable or to a literal.
 *
 *  NOT a template string. `"{{sales_chart}}"` reads nicely and loses the type on
 *  the way through — an integer arrives as `"41"`, an object as
 *  `"[object Object]"`, null as `""` — and the tool then refuses an argument the
 *  author believes they supplied. The inspector still DISPLAYS `{{sales_chart}}`;
 *  this is what is stored and what runs. */
export interface ToolInput {
  source: 'variable' | 'literal';
  /** Variable name when source='variable'. No braces. */
  ref?: string;
  /** The value itself when source='literal'. Typed as authored. */
  value?: unknown;
}

/** Call exactly one tool with arguments the author chose. No model. */
export interface ToolNode extends BaseNode {
  type: 'tool';
  tool: string;
  inputs?: Record<string, ToolInput>;
}

/** Run a published Skill — a governed child flow — with inputs the author bound.
 *  Deterministic: no model decides whether it runs. */
export interface SkillNode extends BaseNode {
  type: 'skill';
  skill_key: string;
  /** Pinned at publish; empty on a draft. */
  version?: number | null;
  inputs?: Record<string, ToolInput>;
}

export type FlowNode =
  | AgentNode | ReportReadNode | KnowledgeNode | WebNode | ToolNode | SkillNode
  | SetVarNode | TransformNode | StopNode | DelayNode
  | FilterNode | IfNode | SwitchNode | LoopNode | CoordinateNode;

/** One typed input a Skill declares — the only data that enters a Skill. */
export interface SkillInput {
  name: string;
  type: 'text' | 'number' | 'date' | 'chart_ref';
  required: boolean;
  description?: string;
}

/** What a flow promises when it is published as a Skill. */
export interface SkillContract {
  inputs: SkillInput[];
  output: string;
  when_to_use: string;
}

/** A published Skill this user may attach (from `/skills`). */
export interface SkillSummary {
  key: string;
  name: string;
  version: number;
  description: string;
  grant: string;
  contract: SkillContract;
}

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
  /** Set when the flow is published as a Skill. */
  skill?: SkillContract | null;
}

export type BrainStatus = 'draft' | 'published' | 'archived';

export interface BrainSummary {
  brain_key: string;
  /** Which surface this flow was built for. Optional so a frontend deployed ahead
   *  of the backend reads `undefined` and falls back to `bot`, which is what every
   *  flow written before the type existed actually is. */
  flow_type?: FlowType;
  /** What a link carries. Shared by every version of this flow, unlike a version
   *  row's own id. Every API call below still uses `brain_key`. */
  flow_id: number | null;
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
  /** What sharing this flow lends beyond itself: every source it attached, by
   *  name, and for a dataset how many charts that reaches. `ref` is the raw id and
   *  is only a fallback — a disclosure showing ids discloses nothing. */
  reads: { source: string; label: string; ref: string; name?: string; reach?: string }[];
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
  /** The subset of `warnings` that REFUSES a publish (a `{{variable}}` no step
   *  produces). Separate from `warnings` because notes are trade-offs an author
   *  may accept and these are defects that change what a viewer is told.
   *  Optional so a frontend deployed ahead of the backend simply shows nothing. */
  blocking_problems?: string[];
  node_count?: number;
  answer_node?: string;
  requirements?: FlowRequirements;
  /** Worst case for ONE question. On a public link with an unbounded audience this
   *  is the number the author is committing to. */
  estimate?: { max_llm_calls: number; max_tool_calls: number };
  produced_vars?: string[];
  referenced_vars?: string[];
  /** Why this SHAPE could not run with no report on screen. Returned for either
   *  type, so the builder can state both readings at once: an author on a bot flow
   *  sees what would have to change before switching, and an author on a chat flow
   *  sees the moment they break it — in the builder, rather than at the chat door
   *  where they are not standing. */
  chat_blockers?: string[];
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
  /** `draft` was in this union and never in the data — the server declared it and
   *  assigned it nowhere, so every branch written for it was unreachable. */
  status: 'active' | 'broken' | 'needs_review';
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
  /** What the step produced. */
  preview: string | null;
  /** What the step was HANDED — the variables readable when it started. Kept
   *  beside the output because "answered badly" and "was given nothing to answer
   *  from" are indistinguishable from the output alone. */
  input: string | null;
  /** Tool names this step called, in order. */
  tool_calls: string[];
  /** What this step COST. `null` means the run predates per-step accounting —
   *  distinct from `0`, which would claim the step was free. */
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** The node's settings IN THE VERSION THAT RAN, read back from that immutable
   *  version rather than stored per step. `null` when the version is gone. */
  config: Record<string, unknown> | null;
  /** `{{name}}` this step used that NOTHING in the flow produces. Each one
   *  resolved to empty at run time — a Switch on an unproduced variable takes its
   *  fallback every time, an agent prompt silently loses a sentence, and the
   *  answer still comes out. The likeliest cause of a run that looks fine and is
   *  not. */
  unresolved_refs: string[];
  error: string | null;
  /** An Agent step's capability view — what it was granted, what was eligible,
   *  what it was shown each round, what it discovered, invoked and had refused. */
  capabilities?: CapabilityTrace | null;
  /** Skill runs this step created. */
  children?: ChildRun[];
}

export interface CapabilityTrace {
  granted: string[];
  eligible: string[];
  excluded: Record<string, string>;
  limit: number;
  shortlisted: boolean;
  visible_per_round?: string[][];
  visible?: string[];
  discovered?: string[];
  invoked?: string[];
  rejected?: { name: string; code: string }[];
}

/** A Skill run created by another run. */
export interface ChildRun {
  id: number;
  run_key: string;
  brain_key: string;
  version: number | null;
  status: string;
  invoked_as: 'agent_capability' | 'skill_node' | 'coordinator_lane' | null;
  parent_step_key: string | null;
  latency_ms: number | null;
  tokens: number;
  llm_calls: number;
  tool_calls: number;
}

export interface RunDetail {
  /** Where the question came from. `is_test` distinguishes an author's own trial
   *  in the Studio from a viewer asking on a public link — the same event shape,
   *  opposite meanings. */
  /** The conversation this turn belongs to — `null` for a legacy run that was
   *  never part of a session. Lets a `?run=` link open the whole conversation. */
  session_key?: string | null;
  is_test?: boolean;
  trigger?: string | null;
  id: number;
  run_key: string;
  at: string | null;
  status: RunRow['status'];
  version: number | null;
  link_token: string | null;
  binding_id: number | null;
  execution_path: string | null;
  latency_ms: number | null;
  usage: {
    llm_calls: number;
    tool_calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    /** What the turn actually cost. Stored since this table existed and never
     *  returned, so the one number an operator is accountable for was invisible.
     *  `null` when the provider did not report a price. */
    usd: number | null;
  };
  /** Which flow version the per-step `config` was read from, or why it could not
   *  be. Shown so nobody mistakes it for the flow's CURRENT settings. */
  config_source?: string;
  /** The version's own review notes. Same detector as the builder's badge — the
   *  Runs tab needs them too, because that is the screen somebody opens when an
   *  answer looks wrong. */
  flow_warnings?: string[];
  /** Flow nodes with no trace row. `on_branch` distinguishes "sat on a branch
   *  nobody took" (correct) from "absent off the spine" (a defect) — without it
   *  a trace cannot tell the two apart, which is what makes a run look like it
   *  is skipping steps in silence. */
  not_executed?: { key: string; name: string; type: string; on_branch: boolean }[];
  rating: 'up' | 'down' | null;
  /** Set when this run is a Skill another run invoked. */
  parent?: {
    run_key: string; step_key: string | null; invoked_as: string | null;
    id: number | null; brain_key: string | null; version: number | null;
  } | null;
  /** Skill runs this run created. */
  children?: ChildRun[];
  question: string | null;
  answer: string | null;
  citations: unknown[];
  notices: FlowNotice[];
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
  /** Which traffic these figures describe, echoed back so the screen can label the
   *  scope instead of asserting one it only assumed. */
  source?: RunSourceFilter;
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
  /** `text` is the SERVER's rendering of `blocks`, and is what a rating is
   *  matched against. Optional so a frontend deployed ahead of the backend falls
   *  back to rendering it locally rather than to `undefined`. */
  answer: { blocks: AnswerBlock[]; text?: string };
  citations: { kind: string; ref: string; label?: string; url?: string; quote?: string }[];
  notices: FlowNotice[];
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

/** Published Skills this user may attach. Server-side, like `/attachable`. */
export async function listSkills(): Promise<SkillSummary[]> {
  const { data } = await apiClient.get<{ skills: SkillSummary[] }>(`${BASE}/skills`);
  return data.skills || [];
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
    terms: data.terms || [],
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

/** The `brain_key` behind the number in a link. */
export async function resolveFlowId(flowId: number): Promise<string> {
  const { data } = await apiClient.get<{ brain_key: string }>(
    `${BASE}/brains/resolve/${flowId}`);
  return data.brain_key;
}

export async function getBrain(key: string, version?: number): Promise<BrainDetail> {
  const { data } = await apiClient.get<BrainDetail>(
    `${BASE}/brains/${encodeURIComponent(key)}`,
    { params: version ? { version } : undefined });
  return data;
}

export type FlowType = 'bot' | 'chat' | 'skill';

export async function saveBrain(body: {
  brain_key: string; name: string; description: string; body: FlowBody;
  /** Read only when this save CREATES the flow. Later saves carry the type
   *  forward; changing it goes through `setFlowType`, which can refuse. */
  flow_type?: FlowType;
}): Promise<BrainDetail> {
  const { data } = await apiClient.put<BrainDetail>(`${BASE}/brains`, body);
  return data;
}

/** Which surface this flow is for.
 *
 *  Refused when a flow that reads a report is asked to become a chat flow — the
 *  server returns the reasons, because the author is the one who can act on them.
 */
export async function setFlowType(key: string, flowType: FlowType): Promise<{
  brain_key: string; flow_type: FlowType; reasons: string[];
}> {
  const { data } = await apiClient.put(
    `${BASE}/brains/${encodeURIComponent(key)}/type`, { flow_type: flowType });
  return data;
}

/** Check without saving, so the validity badge can update while the author types.
 *  Before this the only way to see a warning was to save — and saving used to mint
 *  a version, so the act of checking changed the thing being checked. */
export async function validateFlow(body: {
  brain_key: string; name: string; body: FlowBody;
  /** Which surface to check against. Three of the review notes state a
   *  consequence that only holds on a report, so a chat flow checked as a bot is
   *  told the opposite of the truth. */
  flow_type?: FlowType;
}): Promise<ValidateResult> {
  const { data } = await apiClient.post<ValidateResult>(`${BASE}/validate`, body);
  return data;
}

export async function publishBrain(
  key: string, version: number,
  /** Publish anyway, with the blocking problems seen and accepted. The server
   *  answers 409 without it — see `Flow.blocking_problems`. */
  acknowledgeProblems = false,
): Promise<BrainDetail & { pinned_links?: { link_name: string; reasons: string[] }[] }> {
  const q = acknowledgeProblems ? '?acknowledge_problems=true' : '';
  const { data } = await apiClient.post(
    `${BASE}/brains/${encodeURIComponent(key)}/${version}/publish${q}`, {});
  return data;
}

/** A report the caller may test a flow on. Same permission answer the Dashboards
 *  module gives — the picker and the run must not disagree about which reports are
 *  offered and which actually execute. */
export interface TestTargetReport {
  id: number;
  name: string;
  description?: string | null;
  permission?: string;
}

export async function listTestTargetReports(): Promise<TestTargetReport[]> {
  const { data } = await apiClient.get<TestTargetReport[]>('/dashboards/accessible-summary');
  return Array.isArray(data) ? data : [];
}

export interface ReportTestResult {
  envelope: unknown;
  /** What a real link would still have to answer. A flow mid-build normally has
   *  some of these; they are shown, not treated as a failure. */
  readiness?: {
    errors?: { message: string }[];
    warnings?: { message: string }[];
    /** Which KINDS of question this flow can answer, derived from the tools it
     *  grants. Gaps are not errors — a flow narrowed on purpose is a good flow —
     *  but the alternative to naming them here is the bot naming them in
     *  production, badly: asked for anomalies with no diagnostic tool granted, it
     *  told the viewer the report contained no such information. */
    coverage?: {
      answerable: number;
      total: number;
      covered: { key: string; label: string; example: string }[];
      gaps: { key: string; label: string; example: string; pack: string }[];
    };
  };
  report?: {
    id: number; name: string; charts_read?: number; charts_total?: number;
    /** `id → title` for the charts this run could cite, so `[chart:N]` in the
     *  answer renders as the tile's name — what the viewer's chat shows. */
    charts?: { id: number; title: string }[];
  };
  /** The history row this test wrote, so the dialog can hand over the full trace.
   *  Not the envelope's `run_id` — that is a generated string, this is the row the
   *  Runs tab addresses (`?run=193`). Marked `is_test` there. */
  run_row_id?: number | null;
}

/** Run the draft against a REPORT, with no link and no binding. The companion to
 *  `testFlow`, which needs a link — see the endpoint's docstring for why both
 *  exist. */
export async function testFlowOnReport(
  key: string,
  body: {
    dashboard_id: number; question: string; version?: number;
    /** Same key across the turns of one test chat, so the session store carries
     *  memory between them. Without it a test cannot exercise `once_per_session`,
     *  `context_policy: last_3`, or a `memory_delta` surviving into a later turn —
     *  an author could configure all three and never see any of them run. */
    session_key?: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
  },
): Promise<ReportTestResult> {
  const { data } = await apiClient.post(
    `${BASE}/brains/${encodeURIComponent(key)}/test-on-report`, body);
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

export async function runStats(
  key: string, sinceHours = 24, source: RunSourceFilter = 'viewer',
): Promise<RunStats> {
  const { data } = await apiClient.get<RunStats>(
    `${BASE}/brains/${encodeURIComponent(key)}/runs/stats`,
    { params: { since_hours: sinceHours, source } });
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
  /** Same conversation fields as `testFlowOnReport`. Both paths carry them: they
   *  answer different questions — the link's real contract versus "does this work
   *  at all" — but they are the same machinery, and if only one could hold a
   *  session then which question you asked would decide whether `once_per_session`
   *  was observable at all. */
  session_key?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
}): Promise<{
  envelope: FlowOutputEnvelope | null;
  run_row_id?: number | null;
  report?: { id: number; name: string; charts?: { id: number; title: string }[] };
}> {
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

/** Exactly what one AI step hands the model — assembled by the backend from the
 *  same three functions a real run uses, with no provider called. */
export interface StepPreview {
  step: { key: string; name: string; is_answering: boolean };
  model: { provider: string; model: string };
  system_prompt: {
    full: string;
    /** Which base this step receives. The answering step gets the full contract;
     *  every other step gets a compact one. A real rule, and one an author had no
     *  way to observe before this screen. */
    base_kind: 'full' | 'compact' | 'classifier' | 'none';
    shared_base_chars: number;
    this_step_chars: number;
    this_step: string;
  };
  messages: { role: string; content: string; chars: number }[];
  tools: { name: string; description: string; arguments: string[]; required: string[] }[];
  /** Granted vs eligible vs shown on round one, and why anything granted was left
   *  out. `tools` is what the model receives; this is how it got there. */
  capabilities?: CapabilityTrace;
  knowledge_scope: Record<string, unknown>;
  budget: { max_tool_calls: number; max_llm_calls: number; max_seconds: number };
  totals: { system_chars: number; message_chars: number; tool_count: number };
  /** Variables an earlier step produces. They are unresolved here because nothing
   *  upstream has run — saying so beats rendering an empty block the author would
   *  read as "this step gets nothing". */
  pending_upstream: string[];
}

export async function previewStep(key: string, nodeKey: string, body: {
  /** Omitted for a chat flow — there is no report, and the server assembles the
   *  preview the way a chat turn is actually assembled. */
  dashboard_id?: number; question?: string; version?: number;
}): Promise<StepPreview> {
  const { data } = await apiClient.post<StepPreview>(
    `${BASE}/brains/${encodeURIComponent(key)}/nodes/${encodeURIComponent(nodeKey)}/preview`,
    body);
  return data;
}


// ── Bindings ────────────────────────────────────────────────────────────────
export interface ChatTestResult {
  envelope: unknown;
  run_row_id?: number | null;
  /** What the flow could reach this turn, counted. There is no report on screen to
   *  imply it, so the panel states it: an author reading a wrong figure needs to
   *  know which sources were even in play. */
  scope: { doc_ids: number; dataset_ids: number; metric_names: number; charts: number };
  /** Why this shape could not run with no report. Reported, not refused — a flow
   *  mid-build usually has something wrong with it. */
  blockers: string[];
}

/** Run a draft the way AI Chat will: a question, and no report.
 *
 *  The other two test calls need a link or a report, and a chat flow has neither —
 *  which meant its author had to publish it and go to the Chat screen to find out
 *  whether it worked.
 */
export async function testFlowAsChat(key: string, body: {
  question: string; version?: number; session_key?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
}): Promise<ChatTestResult> {
  const { data } = await apiClient.post<ChatTestResult>(
    `${BASE}/brains/${encodeURIComponent(key)}/test-as-chat`, body);
  return data;
}

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

// ── Where a container keeps its children ────────────────────────────────────
//
// ONE DECLARATION, READ BY EVERY WALKER.
//
// This used to be written out by hand in five functions in this file and seven
// more across the canvas, the edge generator, the inspector and the test panel —
// forty-seven branches, each a separate chance to teach eleven systems about a new
// node type and forget the twelfth. That is not hypothetical: `coordinate` was
// added without being taught to the backend's `all_nodes()`, a specialist's lane
// became invisible to every authoring check at once, and asked which product
// category earned the most the flow answered "13,591,643.70" — the report's grand
// total, no category named, no notice raised.
//
// The backend declares the same topology in `contract.CHILD_SLOTS` and serves it
// on `/nodes` as `child_slots`. `npm run qa:node-topology` asserts the two agree,
// so this table cannot quietly drift from the models it describes.

/** How to get from a container's field to a list of nodes. */
export type ChildSlot = {
  /** The property on the node. */
  field: 'paths' | 'cases' | 'specialists' | 'fallback' | 'body';
  /** `nodes` — the field IS a list of nodes.
   *  `groups` — a list of lanes that each carry a `body`. */
  kind: 'nodes' | 'groups';
  /** The token this lane uses inside a `containerPath` (`<key>:<token>:<laneKey>`),
   *  which is how an insert point on the canvas names its own destination. FE-only:
   *  the backend has no notion of canvas routing. */
  token: 'path' | 'case' | 'specialist' | 'fallback' | 'body';
  /** Draw this lane even when it is empty, so an author can drop a step into it.
   *
   *  A switch RESERVES its fallback — an empty "everything else" lane is still a
   *  branch of the flow, and `has_fallback: false` is how an author says they do
   *  not want one. A coordinator has no such switch, so its fallback appears only
   *  once it holds something. Declared rather than inferred from the value, because
   *  `has_fallback === undefined` means "reserved" on a switch and has no meaning
   *  at all elsewhere. */
  reserveWhenEmpty?: boolean;
};

export const CHILD_SLOTS: Partial<Record<NodeType, ChildSlot[]>> = {
  if: [{ field: 'paths', kind: 'groups', token: 'path' }],
  switch: [
    { field: 'cases', kind: 'groups', token: 'case' },
    { field: 'fallback', kind: 'nodes', token: 'fallback', reserveWhenEmpty: true },
  ],
  coordinate: [
    { field: 'specialists', kind: 'groups', token: 'specialist' },
    { field: 'fallback', kind: 'nodes', token: 'fallback' },
  ],
  loop: [{ field: 'body', kind: 'nodes', token: 'body' }],
};

/** One lane of children, with enough context to rebuild the node around it. */
export type ChildLane = {
  slot: ChildSlot;
  /** The lane's own key — a path/case/specialist key, or '' for `fallback`/`body`. */
  laneKey: string;
  nodes: FlowNode[];
};

/** The node types that hold other nodes. A TYPE-level convenience only — the
 *  runtime answer always comes from `CHILD_SLOTS`, which is the declaration a new
 *  container has to join to be walked at all. */
export type ContainerNode = IfNode | SwitchNode | CoordinateNode | LoopNode;
export type BranchingNode = IfNode | SwitchNode | CoordinateNode;

export function isContainer(node: FlowNode): node is ContainerNode {
  return !!CHILD_SLOTS[node.type];
}

/** A container whose lanes are ALTERNATIVES — one of them runs.
 *
 *  The distinction is in the declaration rather than a list of type names: a
 *  branching container has a `groups` slot (named lanes to choose between), a loop
 *  has only `nodes` (one body, run repeatedly). `coordinate` counts, and leaving it
 *  out is how the chip under the title said "1 branch" for a flow with three. */
export function isBranching(node: FlowNode): node is BranchingNode {
  return (CHILD_SLOTS[node.type] || []).some((s) => s.kind === 'groups');
}

/** Every lane of child nodes this node holds, in declaration order. */
export function childLanes(node: FlowNode): ChildLane[] {
  const slots = CHILD_SLOTS[node.type];
  if (!slots) return [];
  const out: ChildLane[] = [];
  for (const slot of slots) {
    const value = (node as unknown as Record<string, unknown>)[slot.field];
    if (slot.kind === 'nodes') {
      out.push({ slot, laneKey: '', nodes: (value as FlowNode[]) || [] });
    } else {
      for (const lane of (value as { key: string; body?: FlowNode[] }[]) || []) {
        out.push({ slot, laneKey: lane.key, nodes: lane.body || [] });
      }
    }
  }
  return out;
}

/** A lane as the canvas and the edge generator want it: a key, its body, and the
 *  `containerPath` an insert point inside it would use.
 *
 *  BOTH OF THEM USED TO BUILD THIS THEMSELVES, and `useFlowEdges` still carries the
 *  note about what that cost: "`FlowCanvas` learned to DRAW the lanes and this did
 *  not learn to CONNECT them, so the specialists rendered as two cards floating
 *  either side of a line that ran straight past them — the picture said the flow
 *  ignores them, which is the opposite of what the node does."
 *
 *  A `fallback` lane is shown when it has content, or when the node carries
 *  `has_fallback` and has not turned it off — a switch reserves its fallback lane
 *  even while empty, so an author can drop a step into it. */
export function laneViews(
  node: FlowNode,
): { key: string; body: FlowNode[]; path: string }[] {
  return childLanes(node).flatMap((lane) => {
    if (lane.slot.reserveWhenEmpty) {
      // Reserved unless the author turned it off.
      const off = (node as unknown as { has_fallback?: boolean }).has_fallback === false;
      if (off && lane.nodes.length === 0) return [];
    } else if (lane.slot.kind === 'nodes' && lane.nodes.length === 0) {
      // Not reserved: an empty lane is not a lane.
      return [];
    }
    return [{
      key: lane.slot.kind === 'groups' ? lane.laneKey : lane.slot.token,
      body: lane.nodes,
      path: `${node.key}:${lane.slot.token}:${lane.laneKey}`,
    }];
  });
}

/** Rebuild a node with each of its lanes passed through `fn`.
 *
 *  Immutable, because React state updates and the undo stack both hold snapshots.
 *  The shape-preserving part is the point: a caller says what to do to a list of
 *  nodes and never has to know that `if` keeps them under `paths[].body` while
 *  `loop` keeps them under `body`. */
export function mapChildLanes(
  node: FlowNode, fn: (nodes: FlowNode[], lane: ChildLane) => FlowNode[],
): FlowNode {
  const slots = CHILD_SLOTS[node.type];
  if (!slots) return node;
  const next: Record<string, unknown> = { ...(node as unknown as Record<string, unknown>) };
  for (const slot of slots) {
    const value = next[slot.field];
    if (slot.kind === 'nodes') {
      const nodes = (value as FlowNode[]) || [];
      next[slot.field] = fn(nodes, { slot, laneKey: '', nodes });
    } else {
      next[slot.field] = ((value as { key: string; body?: FlowNode[] }[]) || []).map(
        (lane) => ({
          ...lane,
          body: fn(lane.body || [], { slot, laneKey: lane.key, nodes: lane.body || [] }),
        }),
      );
    }
  }
  return next as unknown as FlowNode;
}

// ── Tree helpers ────────────────────────────────────────────────────────────
/** Every node in the tree, in document order. The canvas, the validity badge and
 *  the key-uniqueness check all need this and must not each walk it differently. */
export function walkNodes(nodes: FlowNode[]): FlowNode[] {
  const out: FlowNode[] = [];
  const visit = (list: FlowNode[]) => {
    for (const n of list) {
      out.push(n);
      for (const lane of childLanes(n)) visit(lane.nodes);
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
    return mapChildLanes(n, (lane) => replaceNode(lane, key, next));
  });
}

export function removeNode(nodes: FlowNode[], key: string): FlowNode[] {
  return (nodes || [])
    .filter((n) => n.key !== key)
    .map((n) => mapChildLanes(n, (lane) => removeNode(lane, key)));
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
  const [ownerKey, token, laneKey] = containerPath.split(':');
  return (nodes || []).map((n) => {
    // Not the owner: keep descending, every lane, without naming any of them.
    if (n.key !== ownerKey) {
      return mapChildLanes(n, (lane) => insertNode(lane, target, node));
    }
    // The owner: splice into the ONE lane the path names.
    return mapChildLanes(n, (lane, ctx) => {
      if (ctx.slot.token !== token) return lane;
      if (ctx.slot.kind === 'groups' && ctx.laneKey !== laneKey) return lane;
      const body = [...lane];
      body.splice(Math.min(index, body.length), 0, node);
      return body;
    });
  });
}

/** Where a node currently sits, in the same coordinates an insert point uses. */
export function locateNode(
  nodes: FlowNode[], key: string, containerPath = '',
): { containerPath: string; index: number } | null {
  for (let i = 0; i < (nodes || []).length; i += 1) {
    const n = nodes[i];
    if (n.key === key) return { containerPath, index: i };
    for (const lane of childLanes(n)) {
      const hit = locateNode(lane.nodes, key, `${n.key}:${lane.slot.token}:${lane.laneKey}`);
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
    case 'tool':
      return { ...base, type: 'tool', tool: '', inputs: {},
        run_policy: 'every_turn' };
    case 'skill':
      return { ...base, type: 'skill', skill_key: '', inputs: {},
        output_var: uniqueKey(nodes, 'ket_qua_skill'), run_policy: 'every_turn' };
    case 'report_read':
      return { ...base, type, output_var: uniqueKey(nodes, 'dashboard_context'),
        include_summary: true, include_data: true, include_filters: true,
        match_question: false, max_charts: 20, detail: 'compact',
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
    case 'coordinate':
      // Two lanes, because one specialist is not a coordination problem and the
      // contract refuses it. Each starts with a blank `when` the author must fill:
      // the planner reads that line and nothing else to choose.
      return { ...base, type, prompt: '', provider: 'inherit', max_specialists: 3,
        specialists: [
          { key: 'chuyen_gia_1', name: '', when: '', body: [] },
          { key: 'chuyen_gia_2', name: '', when: '', body: [] },
        ], fallback: [] };
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

// ── The V1 starter ──────────────────────────────────────────────────────────

/** The tools a report assistant needs, and deliberately no more.
 *
 *  WHY A FIXED LIST AND NOT A PACK. Granting `measure` whole would also hand over
 *  `list_charts`, whose result scales with the report — measured at ~15,600 tokens
 *  on a seventy-chart report, paid on every model round. Granting `diagnose` or
 *  `project` would add `explain_change` and `forecast_measure`, both `expensive`,
 *  to a flow whose author has not yet asked a single question. So the starter
 *  grants the ten calls that answer "how much / which is biggest / what share /
 *  versus last period", plus the three that establish what the numbers MEAN
 *  before they are quoted.
 *
 *  `external` is gated per link and is never granted here; `knowledge` is not a V1
 *  promise and would make the starter depend on an attachment the author has not
 *  made. Both remain one click away in the inspector.
 */
const STARTER_TOOLS: string[] = [
  // Find the right chart before measuring it.
  'search_business_assets', 'resolve_chart_candidates',
  // Establish scope BEFORE quoting a figure. These three are what stop an answer
  // inventing a currency, a date range or a filter the report does not carry.
  'inspect_filters', 'describe_time_coverage', 'get_chart_glossary',
  // Answer "how much", "which is biggest", "what share", "versus when".
  'total_measure', 'rank_values', 'share_of', 'get_chart_data', 'compare_periods',
];

/** The first flow a pilot author should ever see: a BI assistant for a report.
 *
 *  WHAT THIS IS NOT. Not a template system, not a second runtime, not a second way
 *  for a flow to enter the product. It returns an ordinary `FlowBody` that goes
 *  through the same `saveBrain` the blank path uses and is editable from the first
 *  second. Delete a node and it is simply a flow.
 *
 *  WHY THREE STEPS AND NOT TWO. The obvious shape — read the report, then one
 *  agent that both fetches and answers — is refused by the product's own review:
 *  *“Bước viết câu trả lời mà còn gọi được công cụ thì dễ đưa ra số chưa qua các
 *  bước trước.”* Shipping the recommended starting shape with a standing review
 *  note is how authors learn that notes are noise. Splitting gather from answer
 *  costs one model call per question and is the architecture the note is asking
 *  for: figures pass through a step where they can be checked before anything is
 *  written. Measured against the contract, this shape raises one note (no
 *  knowledge attached) against the two-step shape's two.
 *
 *  WHY `detail: 'index'`. The contract documents the pairing: an index when the
 *  next step has computing tools, because `rank_values`/`total_measure` reach
 *  exact figures over every row on demand, so pasting a data sample into the
 *  prompt buys nothing and is paid on every round.
 *
 *  WHY NOT `match_question`. It was the obvious choice and it is wrong here,
 *  which a real run showed: on a sales report, "tổng doanh thu" matched no chart
 *  at all, so the read step handed over nothing and the author was shown a
 *  confident answer next to the diagnosis *"báo cáo này không có dữ liệu cho câu
 *  hỏi đó"*. Question matching narrows to charts it can tie to the question; an
 *  index of everything costs about the same and is what the gathering step needs
 *  to choose from. The dimension truth that question mode was protecting is not
 *  lost — it lives in `resolve_chart_candidates` and in the dimension gate on
 *  `get_chart_data`, which this step is granted and which run per tool call.
 *
 *  NOTHING HERE IS SPECIFIC TO ONE CUSTOMER. No dashboard id, no report name, no
 *  measure name, no account: a bot flow is handed whichever report the link it is
 *  bound to is showing.
 */
export function starterFlow(
  t: (key: string, values?: Record<string, string | number>) => string,
): FlowBody {
  const read: FlowNode = {
    key: 'doc_bao_cao',
    type: 'report_read',
    name: t('agentFlows.list.starter.readName'),
    output_var: 'bao_cao',
    match_question: false,
    max_charts: 20,
    detail: 'index',
    include_summary: true,
    include_data: true,
    include_filters: true,
    max_rows: 200,
    run_policy: 'when_stale',
  };
  const gather: FlowNode = {
    key: 'tim_so_lieu',
    type: 'agent',
    name: t('agentFlows.list.starter.gatherName'),
    prompt: t('agentFlows.list.starter.gatherPrompt'),
    provider: 'inherit',
    max_tool_calls: 8,
    output_format: 'chat',
    context_policy: 'question',
    tools: STARTER_TOOLS.map((tool) => ({ tool })),
    knowledge: [],
  };
  const answer: FlowNode = {
    key: 'tra_loi',
    type: 'agent',
    name: t('agentFlows.list.starter.answerName'),
    prompt: t('agentFlows.list.starter.answerPrompt'),
    provider: 'inherit',
    // Not zero: the contract's lower bound is 1. The step is given no tools, so
    // the budget is unreachable either way — this is the schema's floor, not a
    // quiet allowance.
    max_tool_calls: 1,
    output_format: 'chat',
    context_policy: 'question',
    tools: [],
    knowledge: [],
  };
  return { schema_version: 2, nodes: [read, gather, answer], answer_node: answer.key };
}

// ── Conversations & feedback ────────────────────────────────────────────────
//
// The per-run list stays where it is. These read the SAME rows grouped by
// session, which is the unit a viewer actually experiences: somebody who asked
// four times because the first three answers were useless is one dissatisfied
// conversation, not four `ok` rows.

/** One turn inside a conversation. */
export interface ConversationTurn {
  index: number;
  run_id: number;
  at: string | null;
  status: 'ok' | 'partial' | 'blocked' | 'failed';
  version: number | null;
  is_test: boolean;
  trigger: string | null;
  rating: 'up' | 'down' | null;
  question: string | null;
  answer: string | null;
  citations: unknown[];
  notices: FlowNotice[];
  execution_path: string | null;
  blocked_reason: string | null;
  missing_requirements: unknown[];
  usage: {
    llm_calls: number | null; tool_calls: number | null;
    prompt_tokens: number | null; completion_tokens: number | null;
    ms: number | null; usd: number | null;
  };
  steps: RunStep[];
  /** What this turn did that could explain a complaint — the branch it took, a
   *  step that errored or was skipped, a notice it raised. Factual, never an
   *  inference about the viewer's mood. */
  signals: { code: string; text: string }[];
}

export interface ConversationSummary {
  /** Groups by session. Falls back to the run id for legacy turns that were never
   *  part of a session, so nothing silently drops out of history. */
  key: string;
  session_key: string | null;
  turns: number;
  started_at: string | null;
  last_at: string | null;
  first_run_id: number;
  last_run_id: number;
  first_question: string;
  worst_status: 'ok' | 'partial' | 'blocked' | 'failed';
  statuses: string[];
  tokens: number;
  ms: number;
  up: number;
  down: number;
  is_test: boolean;
  paths: string[];
  dashboard_id: number | null;
  link_token: string | null;
  version: number | null;
  /** Long enough that the viewer was probably not satisfied by the early answers. */
  kept_asking: boolean;
}

export interface ConversationDetail {
  key: string;
  session_key: string | null;
  brain_key: string;
  turns: ConversationTurn[];
  turn_count: number;
  started_at: string | null;
  last_at: string | null;
  is_test: boolean;
  dashboard_id: number | null;
  link_token: string | null;
  version: number | null;
  tokens: number;
  up: number;
  down: number;
}

export async function listConversations(key: string, params: {
  since_hours?: number; source?: RunSourceFilter; status?: string;
  /** Matches ANY turn's question, not just the opening one: the phrase somebody
   *  remembers is usually from the middle of the conversation. */
  search?: string;
  rated?: 'up' | 'down' | 'any'; limit?: number; offset?: number;
} = {}): Promise<{ total: number; conversations: ConversationSummary[] }> {
  const { data } = await apiClient.get(
    `${BASE}/brains/${encodeURIComponent(key)}/conversations`, { params });
  return data;
}

export async function conversationDetail(
  key: string, conversationKey: string,
): Promise<ConversationDetail> {
  const { data } = await apiClient.get(
    `${BASE}/brains/${encodeURIComponent(key)}/conversations/${encodeURIComponent(conversationKey)}`);
  return data;
}

export interface FeedbackItem {
  run_id: number;
  conversation_key: string;
  session_key: string | null;
  conversation_turns: number;
  at: string | null;
  rating: 'up' | 'down';
  status: string;
  is_test: boolean;
  version: number | null;
  link_token: string | null;
  dashboard_id: number | null;
  question: string | null;
  answer: string | null;
  execution_path: string | null;
  signals: { code: string; text: string }[];
}

export interface FeedbackResult {
  items: FeedbackItem[];
  /** What the complaints have in common — counted over the DOWN votes only, since
   *  a signal shared with an up vote is not what went wrong. */
  summary: {
    up: number; down: number; rated: number; down_share: number;
    by_signal: { key: string; count: number }[];
    by_path: { key: string; count: number }[];
    by_status: { key: string; count: number }[];
  };
}

export async function listFeedback(key: string, params: {
  rating?: 'up' | 'down'; since_hours?: number; source?: RunSourceFilter; limit?: number;
} = {}): Promise<FeedbackResult> {
  const { data } = await apiClient.get(
    `${BASE}/brains/${encodeURIComponent(key)}/feedback`, { params });
  return data;
}

/** Rate one run from inside AppBI. `null` clears it.
 *
 *  By id, not by answer text: the public chat client rates text because it does not
 *  know run ids, and the studio does, so it should not inherit the ambiguity —
 *  two turns that happened to answer identically are indistinguishable by text. */
export async function rateRun(
  key: string, runId: number, rating: 'up' | 'down' | null,
): Promise<void> {
  await apiClient.post(
    `${BASE}/brains/${encodeURIComponent(key)}/runs/${runId}/rating`, { rating });
}

/** WHERE A TURN CAME FROM, as a filter.
 *
 *  Three values, not a boolean. The old `include_tests` flag could express "viewers"
 *  or "viewers and me" and never "just what I ran" — which is the view an author
 *  wants while building, and the one the Runs tab could not produce. It also
 *  defaulted to excluding tests, so the tab was empty in the moment right after a
 *  test run. */
export type RunSourceFilter = 'all' | 'viewer' | 'test';
