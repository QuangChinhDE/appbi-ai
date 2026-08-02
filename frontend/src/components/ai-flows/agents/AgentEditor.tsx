'use client';

/**
 * Agent Editor — a screen, not a modal.
 *
 * The prompt is the highest-leverage thing in the whole system: it decides
 * whether the assistant hedges, invents, or cites. Editing it in a cramped side
 * panel guarantees it gets skimmed. So it gets its own screen, a real editor, a
 * live token count, and a lint pass naming the specific habits that make an
 * analyst prompt go wrong.
 *
 * The result shape offers a field table first and raw JSON Schema second —
 * demanding JSON for "the answer has a `total` number" would put this out of
 * reach of the people it exists for.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ChevronLeft, CheckCircle2, Lightbulb, Plus, Trash2, Upload, Variable,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select, Textarea } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import {
  type AgentVersion, type ModelPolicyRow, type Palette,
  listAgentVersions, listModelPolicies, publishAgent, saveAgent,
} from '@/lib/aiFlows';
import { CostBadge } from '../builder/NodePalette';
import { errText, useCanEdit, useCanPublish, timeAgo } from '../shared';

type EditorTab = 'prompt' | 'schema' | 'tools' | 'state' | 'model' | 'versions';

/** Variables the runtime substitutes into a prompt template. */
const VARIABLES = [
  'question', 'dashboard_name', 'context_block', 'findings', 'plan', 'filters',
] as const;

/** Rough token estimate. Vietnamese runs ~3.2 chars/token — enough for a budget hint. */
function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 3.2);
}

export function blankAgent(): AgentVersion {
  return {
    id: 0, agent_key: '', version: 0, ref: '', status: 'draft',
    display_name: '', model_policy: 'deep_reason', prompt_template: '',
    input_schema: {}, output_schema: {},
    tool_allowlist: [], writable_state_fields: ['answer'], runtime_config: {},
    is_builtin: false, created_by: null, published_at: null, created_at: null,
  };
}

interface Props {
  /** An existing key, or null to create one. */
  agentKey: string | null;
  palette: Palette | null;
  onBack: () => void;
  onChanged: () => void;
}

export function AgentEditor({ agentKey, palette, onBack, onChanged }: Props) {
  const { t } = useI18n();
  const canEdit = useCanEdit();
  const canPublish = useCanPublish();
  const isNew = !agentKey;

  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [current, setCurrent] = useState<AgentVersion | null>(isNew ? blankAgent() : null);
  const [tab, setTab] = useState<EditorTab>('prompt');
  const [policies, setPolicies] = useState<ModelPolicyRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => fromVersion(blankAgent()));

  const load = useCallback(() => {
    if (!agentKey) return;
    listAgentVersions(agentKey)
      .then((vs) => {
        setVersions(vs);
        const live = vs.find((v) => v.status === 'draft')
          ?? vs.find((v) => v.status === 'published') ?? vs[0];
        if (live) {
          setCurrent(live);
          setDraft(fromVersion(live));
          setDirty(false);
        }
      })
      .catch(() => toast.error(t('aiFlows.common.error')));
  }, [agentKey, t]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { listModelPolicies().then(setPolicies).catch(() => undefined); }, []);

  const readOnly = !canEdit || !!current?.is_builtin;
  const tokens = useMemo(() => estimateTokens(draft.prompt_template), [draft.prompt_template]);

  const lint = useMemo(() => {
    const text = draft.prompt_template;
    const out: { level: 'warn' | 'hint'; message: string }[] = [];
    if (!text.trim()) return [{ level: 'warn' as const, message: t('aiFlows.agents.lint.empty') }];
    const lower = text.toLowerCase();
    if (text.length > 6000) out.push({ level: 'warn', message: t('aiFlows.agents.lint.tooLong') });
    if (!/(không|đừng|tuyệt đối|never|do not|must not)/i.test(text)) {
      out.push({ level: 'hint', message: t('aiFlows.agents.lint.noProhibition') });
    }
    if (!/(nguồn|trích|chart|evidence|cite|source)/.test(lower)) {
      out.push({ level: 'hint', message: t('aiFlows.agents.lint.noCitation') });
    }
    if (/(chắc chắn|luôn luôn|mọi trường hợp|always|certainly)/.test(lower)) {
      out.push({ level: 'hint', message: t('aiFlows.agents.lint.absolutes') });
    }
    const unknown = Array.from(text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi))
      .map((m) => m[1])
      .filter((v) => !(VARIABLES as readonly string[]).includes(v));
    if (unknown.length) {
      out.push({
        level: 'warn',
        message: t('aiFlows.agents.lint.unknownVar', {
          names: Array.from(new Set(unknown)).join(', '),
        }),
      });
    }
    return out;
  }, [draft.prompt_template, t]);

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const patch = (p: Partial<typeof draft>) => { setDraft((d) => ({ ...d, ...p })); setDirty(true); };

  /**
   * Insert at the caret, not at the end. Appending to a 3000-character prompt
   * drops the variable nowhere near where the author was typing.
   */
  const insertVariable = (name: string) => {
    const el = promptRef.current;
    const token = `{{${name}}}`;
    if (!el) { patch({ prompt_template: draft.prompt_template + token }); return; }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    patch({
      prompt_template: draft.prompt_template.slice(0, start) + token + draft.prompt_template.slice(end),
    });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    if (!draft.agent_key.trim() || !draft.display_name.trim()) {
      toast.error(t('aiFlows.common.required'));
      return;
    }
    setBusy(true);
    try {
      const saved = await saveAgent({
        agent_key: draft.agent_key.trim(),
        // Overwrite in place only while the row is still a draft. Editing a
        // published specialist must mint a NEW version — never mutate what is
        // answering viewers right now.
        version: current && current.status === 'draft' && current.version
          ? current.version : undefined,
        display_name: draft.display_name.trim(),
        model_policy: draft.model_policy,
        prompt_template: draft.prompt_template,
        tool_allowlist: draft.tool_allowlist,
        writable_state_fields: draft.writable_state_fields,
        output_schema: draft.output_schema,
      });
      toast.success(
        current?.version && saved.version !== current.version
          ? t('aiFlows.agents.newVersion', { version: saved.version })
          : t('aiFlows.common.saved'),
      );
      setCurrent(saved);
      setDraft(fromVersion(saved));
      setDirty(false);
      onChanged();
      listAgentVersions(saved.agent_key).then(setVersions).catch(() => undefined);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const doPublish = async () => {
    if (!current?.version) return;
    try {
      await publishAgent(current.agent_key, current.version);
      toast.success(t('aiFlows.common.saved'));
      load();
      onChanged();
    } catch (e) {
      toast.error(errText(e));
    }
  };

  if (!current) {
    return (
      <div className="px-8 py-10 text-caption text-text-tertiary">
        {t('aiFlows.common.loading')}
      </div>
    );
  }

  const policyRows = policies.filter((p) => p.policy === draft.model_policy);

  return (
    <div className="flex h-[calc(100vh-0px)] flex-col">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" /> {t('aiFlows.common.back')}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={draft.display_name}
              disabled={readOnly}
              placeholder={t('aiFlows.agents.name')}
              onChange={(e) => patch({ display_name: e.target.value })}
              className="min-w-0 max-w-sm flex-1 truncate border-0 bg-transparent p-0 text-body font-strong text-text-primary outline-none placeholder:text-text-quaternary focus:ring-0 disabled:opacity-70"
            />
            <Badge variant={current.status === 'published' ? 'success' : 'warning'} size="xs">
              {t(`aiFlows.status.${current.status}`)}
            </Badge>
            {!!current.version && <Badge variant="subtle" size="xs">v{current.version}</Badge>}
            {current.is_builtin && <Badge variant="info" size="xs">{t('aiFlows.status.builtin')}</Badge>}
            {dirty && <Badge variant="warning" size="xs">{t('aiFlows.builder.unsaved')}</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-tiny text-text-tertiary">
            {current.id ? (
              <code>{draft.agent_key}</code>
            ) : (
              <input
                value={draft.agent_key}
                placeholder="revenue_analyst"
                onChange={(e) => patch({
                  agent_key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                })}
                className="w-48 rounded border border-[rgb(var(--border-line))] bg-surface-0 px-1.5 py-0.5 font-mono text-tiny text-text-primary outline-none focus:border-brand"
              />
            )}
            <span>·</span>
            <span>{draft.model_policy}</span>
            <span>·</span>
            <span>{t('aiFlows.agents.promptTokens', { count: tokens })}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!readOnly && (
            <Button variant="secondary" size="sm" disabled={busy || !dirty} onClick={save}>
              {dirty ? t('aiFlows.common.saveDraft') : t('aiFlows.common.saved')}
            </Button>
          )}
          {canPublish && current.status === 'draft' && !!current.version && (
            <Button
              variant="primary" size="sm" disabled={dirty} onClick={doPublish}
              title={dirty ? t('aiFlows.builder.publishBlockedDirty') : undefined}
            >
              <Upload className="h-4 w-4" /> {t('aiFlows.agents.publish')}
            </Button>
          )}
        </div>
      </header>

      {current.is_builtin && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-warning/25 bg-warning/[0.06] px-4 py-1.5 text-tiny text-text-secondary">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-warning" />
          {t('aiFlows.builder.readOnly')}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <Tabs
          className="mb-4"
          value={tab}
          onChange={(k) => setTab(k as EditorTab)}
          items={[
            { key: 'prompt', label: t('aiFlows.agents.tabPrompt') },
            { key: 'schema', label: t('aiFlows.agents.tabSchema') },
            { key: 'tools', label: t('aiFlows.agents.tabTools') },
            { key: 'state', label: t('aiFlows.agents.tabState') },
            { key: 'model', label: t('aiFlows.agents.tabModel') },
            { key: 'versions', label: t('aiFlows.agents.tabVersions') },
          ]}
        />

        {tab === 'prompt' && (
          <div className="grid max-w-5xl gap-4 lg:grid-cols-[minmax(0,1fr),280px]">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <Label>{t('aiFlows.agents.prompt')}</Label>
                <span className="text-tiny text-text-quaternary">
                  {t('aiFlows.agents.promptTokens', { count: tokens })}
                </span>
              </div>
              <Textarea
                ref={promptRef}
                rows={22}
                className="font-mono !text-caption"
                value={draft.prompt_template}
                disabled={readOnly}
                onChange={(e) => patch({ prompt_template: e.target.value })}
              />
              <p className="mt-1 text-tiny leading-relaxed text-text-quaternary">
                {t('aiFlows.agents.promptHint')}
              </p>
            </div>

            <aside className="space-y-3">
              <div className="rounded-lg border border-[rgb(var(--border-line))] p-2.5">
                <div className="mb-1.5 flex items-center gap-1.5 text-tiny font-strong uppercase tracking-wide text-text-quaternary">
                  <Variable className="h-3 w-3" /> {t('aiFlows.agents.variables')}
                </div>
                <div className="flex flex-wrap gap-1">
                  {VARIABLES.map((v) => (
                    <button
                      key={v}
                      type="button"
                      disabled={readOnly}
                      title={t(`aiFlows.agents.var.${v}`)}
                      onClick={() => insertVariable(v)}
                      className="rounded-full border border-[rgb(var(--border-line))] px-2 py-0.5 font-mono text-tiny text-text-secondary transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
                    >
                      {`{{${v}}}`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-[rgb(var(--border-line))] p-2.5">
                <div className="mb-1.5 text-tiny font-strong uppercase tracking-wide text-text-quaternary">
                  {t('aiFlows.agents.lintTitle')}
                </div>
                {lint.length === 0 ? (
                  <p className="flex items-center gap-1.5 text-tiny text-success">
                    <CheckCircle2 className="h-3 w-3" /> {t('aiFlows.validation.ok')}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {lint.map((l, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-tiny leading-tight">
                        {l.level === 'warn'
                          ? <AlertTriangle className="mt-px h-3 w-3 flex-shrink-0 text-warning" />
                          : <Lightbulb className="mt-px h-3 w-3 flex-shrink-0 text-info" />}
                        <span className="text-text-secondary">{l.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </aside>
          </div>
        )}

        {tab === 'schema' && (
          <OutputSchemaEditor
            schema={draft.output_schema}
            readOnly={readOnly}
            onChange={(output_schema) => patch({ output_schema })}
          />
        )}

        {tab === 'tools' && (
          <div className="max-w-4xl">
            <Label>{t('aiFlows.inspector.tools')}</Label>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {(palette?.tools ?? []).map((tool) => (
                <label
                  key={tool.name}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-[rgb(var(--border-line))] p-2 transition-colors hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    disabled={readOnly}
                    checked={draft.tool_allowlist.includes(tool.name)}
                    onChange={() => patch({
                      tool_allowlist: draft.tool_allowlist.includes(tool.name)
                        ? draft.tool_allowlist.filter((x) => x !== tool.name)
                        : [...draft.tool_allowlist, tool.name],
                    })}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1">
                      <span className="truncate text-caption font-emphasis text-text-primary">
                        {tool.label_vi}
                      </span>
                      <CostBadge cls={tool.cost_class} />
                    </span>
                    <span className="block text-tiny leading-tight text-text-tertiary">
                      {tool.description_vi}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {tab === 'state' && (
          <div className="grid max-w-4xl gap-5 sm:grid-cols-2">
            <div>
              <Label>{t('aiFlows.agents.canWrite')}</Label>
              <div className="mt-1 flex flex-wrap gap-1">
                {(palette?.writable_state_fields ?? []).map((f) => {
                  const on = draft.writable_state_fields.includes(f.field);
                  return (
                    <button
                      key={f.field}
                      type="button"
                      disabled={readOnly}
                      onClick={() => patch({
                        writable_state_fields: on
                          ? draft.writable_state_fields.filter((x) => x !== f.field)
                          : [...draft.writable_state_fields, f.field],
                      })}
                      className={`rounded-full border px-2 py-0.5 text-tiny transition-colors disabled:opacity-50 ${
                        on ? 'border-brand bg-brand/10 text-brand'
                           : 'border-[rgb(var(--border-line))] text-text-tertiary'
                      }`}
                    >
                      {f.label_vi}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-tiny leading-relaxed text-text-quaternary">
                {t('aiFlows.inspector.writesHint')}
              </p>
            </div>
            <div>
              <Label>{t('aiFlows.agents.canRead')}</Label>
              <p className="mt-1 text-tiny leading-relaxed text-text-tertiary">
                {t('aiFlows.agents.readHint')}
              </p>
            </div>
          </div>
        )}

        {tab === 'model' && (
          <div className="max-w-3xl space-y-4">
            <div>
              <Label>{t('aiFlows.agents.policy')}</Label>
              <Select
                value={draft.model_policy}
                disabled={readOnly}
                onChange={(e) => patch({ model_policy: e.target.value })}
              >
                {(palette?.model_policies ?? []).map((p) => (
                  <option key={p.policy} value={p.policy}>{p.label_vi}</option>
                ))}
              </Select>
              <p className="mt-1 text-tiny text-text-quaternary">
                {palette?.model_policies.find((p) => p.policy === draft.model_policy)?.description_vi}
              </p>
            </div>

            <div>
              <Label>{t('aiFlows.agents.providerSupport')}</Label>
              <div className="mt-1 overflow-x-auto rounded-lg border border-[rgb(var(--border-line))]">
                <table className="w-full text-caption">
                  <thead className="bg-surface-2 text-tiny uppercase tracking-wide text-text-quaternary">
                    <tr>
                      <th className="px-3 py-1.5 text-left">{t('aiFlows.policies.colProvider')}</th>
                      <th className="px-3 py-1.5 text-left">{t('aiFlows.policies.colModel')}</th>
                      <th className="px-3 py-1.5 text-left">{t('aiFlows.policies.colTools')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {policyRows.map((p) => (
                      <tr key={p.id} className="border-t border-[rgb(var(--border-line))]">
                        <td className="px-3 py-1.5 text-text-primary">{p.provider}</td>
                        <td className="px-3 py-1.5"><code className="text-tiny">{p.model}</code></td>
                        <td className="px-3 py-1.5">
                          {p.supports_tools
                            ? <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                            : <Badge variant="warning" size="xs">
                                {t('aiFlows.agents.toolsUnsupported')}
                              </Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-tiny text-text-quaternary">
                {t('aiFlows.agents.modelHint')}
              </p>
            </div>
          </div>
        )}

        {tab === 'versions' && (
          <div className="max-w-3xl overflow-x-auto rounded-lg border border-[rgb(var(--border-line))]">
            <table className="w-full text-caption">
              <thead className="bg-surface-2 text-tiny uppercase tracking-wide text-text-quaternary">
                <tr>
                  <th className="px-3 py-1.5 text-left">v</th>
                  <th className="px-3 py-1.5 text-left">{t('aiFlows.flows.col.status')}</th>
                  <th className="px-3 py-1.5 text-left">{t('aiFlows.agents.policy')}</th>
                  <th className="px-3 py-1.5 text-right">token</th>
                  <th className="px-3 py-1.5 text-left">{t('aiFlows.flows.col.updated')}</th>
                  <th className="px-3 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr
                    key={v.version}
                    className={`border-t border-[rgb(var(--border-line))] ${
                      v.version === current.version ? 'bg-brand/[0.04]' : ''
                    }`}
                  >
                    <td className="px-3 py-1.5 text-text-primary">v{v.version}</td>
                    <td className="px-3 py-1.5">
                      <Badge variant={v.status === 'published' ? 'success' : 'subtle'} size="xs">
                        {t(`aiFlows.status.${v.status}`)}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 text-text-secondary">{v.model_policy}</td>
                    <td className="px-3 py-1.5 text-right text-text-secondary">
                      {estimateTokens(v.prompt_template)}
                    </td>
                    <td className="px-3 py-1.5 text-tiny text-text-tertiary">
                      {timeAgo(v.published_at ?? v.created_at)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {v.version !== current.version && (
                        <Button
                          variant="ghost" size="xs"
                          onClick={() => {
                            setCurrent(v);
                            setDraft(fromVersion(v));
                            setDirty(false);
                            setTab('prompt');
                          }}
                        >
                          {t('aiFlows.common.open')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function fromVersion(v: AgentVersion) {
  return {
    agent_key: v.agent_key,
    display_name: v.display_name,
    model_policy: v.model_policy,
    prompt_template: v.prompt_template,
    tool_allowlist: [...(v.tool_allowlist ?? [])],
    writable_state_fields: [...(v.writable_state_fields ?? [])],
    output_schema: (v.output_schema ?? {}) as Record<string, unknown>,
  };
}

// ── Result shape: field table first, JSON second ────────────────────────────
interface SchemaField { name: string; type: string; required: boolean; description: string }

const FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'];

function toFields(schema: Record<string, unknown>): SchemaField[] {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const req = (schema?.required ?? []) as string[];
  return Object.entries(props).map(([name, def]) => ({
    name,
    type: String(def?.type ?? 'string'),
    required: req.includes(name),
    description: String(def?.description ?? ''),
  }));
}

function toSchema(fields: SchemaField[]): Record<string, unknown> {
  const named = fields.filter((f) => f.name.trim());
  if (!named.length) return {};
  return {
    type: 'object',
    properties: Object.fromEntries(named.map((f) => [
      f.name.trim(),
      { type: f.type, ...(f.description ? { description: f.description } : {}) },
    ])),
    required: named.filter((f) => f.required).map((f) => f.name.trim()),
  };
}

function OutputSchemaEditor({ schema, readOnly, onChange }: {
  schema: Record<string, unknown>;
  readOnly?: boolean;
  onChange: (s: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const [advanced, setAdvanced] = useState(false);
  const [raw, setRaw] = useState(() => JSON.stringify(schema ?? {}, null, 2));
  const [rawError, setRawError] = useState('');

  // Rows live in local state so a half-typed row survives. Deriving them from
  // the schema on every keystroke would drop a row the instant its name was
  // cleared — you could never rename a field.
  const [fields, setFieldsState] = useState<SchemaField[]>(() => toFields(schema));
  const setFields = (next: SchemaField[]) => { setFieldsState(next); onChange(toSchema(next)); };

  return (
    <div className="max-w-4xl space-y-3">
      <div className="flex items-center justify-between">
        <Label>{t('aiFlows.agents.tabSchema')}</Label>
        <Button
          variant="ghost" size="xs"
          onClick={() => {
            if (!advanced) setRaw(JSON.stringify(toSchema(fields), null, 2));
            else setFieldsState(toFields(schema));
            setAdvanced((v) => !v);
          }}
        >
          {advanced ? t('aiFlows.agents.schemaSimple') : t('aiFlows.inspector.advanced')}
        </Button>
      </div>

      {advanced ? (
        <>
          <Textarea
            rows={16}
            className="font-mono !text-caption"
            value={raw}
            disabled={readOnly}
            onChange={(e) => {
              setRaw(e.target.value);
              try {
                onChange(JSON.parse(e.target.value || '{}'));
                setRawError('');
              } catch (err) {
                setRawError((err as Error).message);
              }
            }}
          />
          {rawError ? (
            <p className="text-tiny text-danger">{rawError}</p>
          ) : (
            <p className="flex items-center gap-1 text-tiny text-success">
              <CheckCircle2 className="h-3 w-3" /> {t('aiFlows.agents.jsonValid')}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            {fields.map((f, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                <Input
                  className="min-w-[140px] flex-1"
                  placeholder={t('aiFlows.agents.fieldName')}
                  value={f.name}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = [...fields]; next[i] = { ...f, name: e.target.value }; setFields(next);
                  }}
                />
                <Select
                  className="w-28"
                  value={f.type}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = [...fields]; next[i] = { ...f, type: e.target.value }; setFields(next);
                  }}
                >
                  {FIELD_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
                </Select>
                <Input
                  className="min-w-[160px] flex-1"
                  placeholder={t('aiFlows.agents.fieldDesc')}
                  value={f.description}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = [...fields]; next[i] = { ...f, description: e.target.value }; setFields(next);
                  }}
                />
                <label className="flex items-center gap-1 text-tiny text-text-tertiary">
                  <input
                    type="checkbox" checked={f.required} disabled={readOnly}
                    onChange={(e) => {
                      const next = [...fields]; next[i] = { ...f, required: e.target.checked }; setFields(next);
                    }}
                  />
                  {t('aiFlows.agents.fieldRequired')}
                </label>
                <Button
                  variant="ghost" size="xs" disabled={readOnly}
                  onClick={() => setFields(fields.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-3 w-3 text-danger" />
                </Button>
              </div>
            ))}
          </div>
          {!readOnly && (
            <Button
              variant="subtle" size="xs"
              onClick={() => setFields([
                ...fields, { name: '', type: 'string', required: false, description: '' },
              ])}
            >
              <Plus className="h-3 w-3" /> {t('aiFlows.agents.schemaAddField')}
            </Button>
          )}
          <p className="text-tiny leading-relaxed text-text-quaternary">
            {t('aiFlows.agents.schemaHint')}
          </p>
        </>
      )}
    </div>
  );
}
