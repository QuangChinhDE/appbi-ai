/**
 * Agent Flows client — /api/v1/agent-flows/*
 *
 * A brain is a chain of agents a public link points at. It is a first-class,
 * shareable resource: any link may use any brain shared with its owner, and a brain
 * never knows which report it will serve — so nothing here is scoped to a dashboard.
 *
 * Every list the builder offers comes from the server: tools from the registry,
 * models from the catalogue, attachable sources filtered by the caller's own
 * rights. Nothing is hard-coded here, because a second copy of any of those lists
 * is a second thing to drift.
 */
import { apiClient } from './api-client';

export type Provider = 'inherit' | 'openai' | 'anthropic' | 'gemini';

export interface ToolSpec {
  name: string;
  label_vi: string;
  label_en: string;
  description_vi: string;
  cost_class: 'cheap' | 'data_query' | 'expensive' | 'external';
  reaches_outside: boolean;
}

export interface ToolPack {
  key: string;
  label_vi: string;
  label_en: string;
  /** Whether THIS deployment would dispatch the pack for the call that asked.
   *  Not the same question as "may an author grant it" — see `gated_by_link`. */
  available: boolean;
  requires_setting: string | null;
  /** True when the pack's gate is decided PER LINK at run time. Such a pack is
   *  grantable in the builder and the condition is stated; reading `available`
   *  instead is what made web tools impossible to grant at all. */
  gated_by_link: boolean;
  /** The condition, in the author's language. Empty when there is none. */
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
  /** Optional grouping label (a metric's category). Used to section the picker. */
  group?: string;
}

export interface Attachable {
  documents: AttachableItem[];
  datasets: AttachableItem[];
  /** Governed metric definitions. A metric ref is matched at run time against the
   *  metric's machine name or display name, so it must be PICKED, never typed. */
  metrics: AttachableItem[];
}

export interface ToolGrant { tool: string; note?: string }
export interface KnowledgeAttachment {
  source: 'document' | 'semantic' | 'metric';
  ref: string;
  description: string;
}

export interface AgentStep {
  key: string;
  name?: string;
  prompt: string;
  provider?: Provider;
  model?: string;
  model_tier?: 'fast' | 'balanced' | 'deep';
  tools?: ToolGrant[];
  knowledge?: KnowledgeAttachment[];
  max_tool_calls?: number;

  /** THIS STEP'S OWN TOKEN — three fields for one secret, because the server never
   *  hands the stored value back.
   *
   *    has_api_key   read-only, from the server: is a token stored for this step.
   *    api_key       write-only: a NEW token to store. Never populated from a GET.
   *    api_key_clear write-only: remove the stored token.
   *
   *  Leaving `api_key` empty means KEEP, not "erase" — the builder cannot resend a
   *  value it was never shown, so removal has to be its own explicit flag. */
  has_api_key?: boolean;
  api_key?: string;
  api_key_clear?: boolean;
}

export interface BrainBody { steps: AgentStep[] }

export interface BrainSummary {
  brain_key: string;
  version: number;
  status: BrainStatus;
  name: string;
  description: string;
  owner_email: string | null;
  created_by: string | null;
  is_builtin: boolean;
  created_at: string | null;
  published_at: string | null;
  /** Present on list rows only. How long the chain is, and how many live public
   *  links point at this brain — the two things worth scanning a list for. */
  step_count?: number;
  link_count?: number;
}

export type BrainStatus = 'draft' | 'published' | 'archived';

export interface BrainVersionRow {
  version: number;
  status: BrainStatus;
  created_by: string | null;
  published_at: string | null;
}

export interface BrainLinkUsage {
  link_id: number;
  link_name: string;
  dashboard_id: number;
  token: string;
  bot_enabled: boolean;
}

export interface BrainDetail extends BrainSummary {
  body: BrainBody;
  /** What this brain gives up, stated rather than prevented — there is no mandatory
   *  frame, so the cost of that freedom is surfaced instead of hidden. */
  warnings: string[];
  /** Every source it may read. What the share dialog must disclose. */
  reads: { source: string; label: string; ref: string }[];
  step_count: number;
}

const BASE = '/agent-flows';

/** Hard caps, mirrored from `contract.py`. A number input that bounds itself to a
 *  different number than the server does is a 422 the author cannot see coming. */
export const MAX_STEPS = 12;
export const MAX_TOOL_CALLS = 30;
/** Shortest knowledge description the server will accept. */
export const MIN_KNOWLEDGE_DESCRIPTION = 10;

export async function listToolPacks(webEnabled = false): Promise<ToolPack[]> {
  const { data } = await apiClient.get<{ packs: ToolPack[] }>(
    `${BASE}/tools`, { params: { web_enabled: webEnabled } },
  );
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

export async function listBrains(): Promise<BrainSummary[]> {
  const { data } = await apiClient.get<{ brains: BrainSummary[] }>(`${BASE}/brains`);
  return data.brains || [];
}

export async function getBrain(key: string, version?: number): Promise<BrainDetail> {
  const { data } = await apiClient.get<BrainDetail>(`${BASE}/brains/${encodeURIComponent(key)}`,
    { params: version ? { version } : undefined });
  return data;
}

export async function saveBrain(body: {
  brain_key: string; name: string; description: string; body: BrainBody;
}): Promise<BrainDetail> {
  const { data } = await apiClient.put<BrainDetail>(`${BASE}/brains`, body);
  return data;
}

export async function publishBrain(key: string, version: number): Promise<BrainDetail> {
  const { data } = await apiClient.post<BrainDetail>(
    `${BASE}/brains/${encodeURIComponent(key)}/${version}/publish`, {},
  );
  return data;
}

export async function brainImpact(key: string): Promise<{
  links: BrainLinkUsage[];
  count: number;
}> {
  const { data } = await apiClient.get<{ links: BrainLinkUsage[]; count: number }>(
    `${BASE}/brains/${encodeURIComponent(key)}/impact`,
  );
  return { links: data.links || [], count: data.count || 0 };
}

/** Every version of this brain, newest first. What the history menu shows. */
export async function listVersions(key: string): Promise<BrainVersionRow[]> {
  const { data } = await apiClient.get<{ versions: BrainVersionRow[] }>(
    `${BASE}/brains/${encodeURIComponent(key)}/versions`,
  );
  return data.versions || [];
}

/** Re-publish the version that was live before the current one. */
export async function rollbackBrain(key: string): Promise<BrainDetail> {
  const { data } = await apiClient.post<BrainDetail>(
    `${BASE}/brains/${encodeURIComponent(key)}/rollback`, {},
  );
  return data;
}

/** Delete one DRAFT version. The server refuses the published one. */
export async function deleteBrainVersion(key: string, version: number): Promise<void> {
  await apiClient.delete(`${BASE}/brains/${encodeURIComponent(key)}/${version}`);
}

/** A blank step, with a key that cannot collide with the steps already present.
 *
 *  Numbering by `steps.length` looked right and was not: delete the first of three
 *  steps and add one, and the new step is `buoc_3` beside the existing `buoc_3`.
 *  The server rejects duplicate keys, so the author lost the save to a message
 *  about a field the builder never showed them. */
export function blankStep(existing: AgentStep[] = []): AgentStep {
  const taken = new Set(existing.map((s) => s.key));
  let n = existing.length + 1;
  while (taken.has(`buoc_${n}`)) n += 1;
  return {
    key: `buoc_${n}`,
    name: `Bước ${n}`,
    prompt: '',
    provider: 'inherit',
    model: '',
    tools: [],
    knowledge: [],
    max_tool_calls: 8,
  };
}

/** A brain-key from a name the author typed. Must satisfy the server's pattern
 *  (`^[a-z][a-z0-9_]{0,39}$`), so this strips accents rather than hoping. */
export function slugifyBrainKey(name: string): string {
  const base = name
    .replace(/[đĐ]/g, 'd')
    // NFD splits "ế" into "e" + a combining mark, then the non-ASCII strip drops
    // the mark and keeps the letter. Dropping non-ASCII BEFORE decomposing would
    // delete the whole letter; turning marks into separators (the obvious
    // `[^a-z0-9] -> _`) would spell "doanh_thu" as "d_o_a_n_h".
    .normalize('NFD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  const head = /^[a-z]/.test(base) ? base : `bo_nao_${base}`.slice(0, 36);
  return `${head || 'bo_nao'}_${Date.now().toString(36).slice(-4)}`.slice(0, 40);
}

export interface StepProblem {
  /** Index into the chain, so the UI can point at the step rather than describe it. */
  index: number;
  tab: 'basic' | 'knowledge' | 'advanced';
  message: string;
}

/** The server's save rules, checked before the round trip.
 *
 *  NOT a replacement for the server's validation — that stays the authority. This
 *  exists because `save_draft` reports the FIRST pydantic failure as one sentence
 *  with no step index, so an author with a six-step chain and one empty prompt was
 *  told "mỗi bước phải có hướng dẫn cho agent" and had to go looking. */
export function validateSteps(steps: AgentStep[]): StepProblem[] {
  const out: StepProblem[] = [];
  if (steps.length === 0) {
    return [{ index: 0, tab: 'basic', message: 'Bộ não phải có ít nhất một bước.' }];
  }
  if (steps.length > MAX_STEPS) {
    out.push({ index: MAX_STEPS, tab: 'basic', message: `Tối đa ${MAX_STEPS} bước.` });
  }
  const seen = new Map<string, number>();
  steps.forEach((step, index) => {
    if (!step.prompt.trim()) {
      out.push({ index, tab: 'basic', message: 'Chưa có hướng dẫn cho agent.' });
    }
    const first = seen.get(step.key);
    if (first !== undefined) {
      out.push({ index, tab: 'basic', message: `Trùng mã bước với bước ${first + 1} (${step.key}).` });
    } else {
      seen.set(step.key, index);
    }
    (step.knowledge || []).forEach((k) => {
      if (!k.ref.trim()) {
        out.push({ index, tab: 'knowledge', message: 'Có nguồn tri thức chưa chọn.' });
      } else if (k.description.trim().length < MIN_KNOWLEDGE_DESCRIPTION) {
        out.push({
          index, tab: 'knowledge',
          message: 'Nguồn tri thức phải nói rõ nó chứa gì và khi nào nên tra.',
        });
      }
    });
    const cap = step.max_tool_calls ?? 8;
    if (cap < 1 || cap > MAX_TOOL_CALLS) {
      out.push({
        index, tab: 'advanced',
        message: `Số lượt gọi công cụ phải từ 1 đến ${MAX_TOOL_CALLS}.`,
      });
    }
    if (step.provider && step.provider !== 'inherit' && !step.model) {
      out.push({ index, tab: 'advanced', message: 'Đã chọn nhà cung cấp nhưng chưa chọn model.' });
    }
    // Mirrors the server's `_credential_is_usable`. A token belongs to one vendor,
    // and "theo cấu hình link" means the vendor is whatever the link happens to
    // use — so the pair is unusable and the server refuses it.
    const hasToken = Boolean(step.has_api_key || (step.api_key || '').trim()) && !step.api_key_clear;
    if (hasToken && (!step.provider || step.provider === 'inherit')) {
      out.push({
        index, tab: 'advanced',
        message: 'Bước có token riêng thì phải chọn nhà cung cấp cụ thể, không để “theo cấu hình link”.',
      });
    }
  });
  return out;
}
