'use client';

/**
 * Assigning a flow to a public link — in three steps, and the third one can refuse.
 *
 * THE RULE THIS SCREEN IMPLEMENTS
 * -------------------------------
 * Define the data BEFORE assigning the flow. Not: assign it and let the runtime
 * work out what it may read.
 *
 * A flow declares what it NEEDS (`revenue`, `segments`, …) without knowing any
 * dashboard. This screen says what those mean HERE — which chart, which field —
 * plus which charts the bot may read at all, whether it may reach the web, and how
 * much one question may cost. `preflight` refuses while anything required is
 * unresolved, and until it passes there is no Assign button to press.
 *
 * Everything offered comes from the server, so the picker cannot suggest a field
 * this dashboard does not have — which is the exact failure the whole design exists
 * to prevent.
 */
import React from 'react';
import { AlertTriangle, Check, Loader2, Workflow } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import {
  bindingCandidates, deleteBinding, getBinding, listBrains, preflightBinding, saveBinding,
  type Binding, type BindingCandidates, type BrainSummary,
  type DataContract, type PreflightResult, type ResolveEntry,
} from '@/lib/agentFlows';

const DEFAULT_CONTRACT: DataContract = {
  charts: { mode: 'allowlist', ids: [] },
  resolve: {},
  knowledge: { mode: 'flow_all' },
  capabilities: { web_search: false, read_rows: true, max_rows_per_call: 5000 },
  defaults: {},
  budget: { max_llm_calls: 12, max_tool_calls: 40, max_seconds: 45 },
};

/** A pending change this editor holds but has not written yet. */
export type BindingFlush = () => Promise<void>;

interface FlowBindingEditorProps {
  linkId: number | null;
  /**
   * Hands the parent a way to WRITE a pending choice, or null when there is
   * nothing pending.
   *
   * This editor keeps the chosen flow and its data contract in local state and
   * used to persist them only through its own "Update assignment" button. The
   * modal around it has a primary "Save changes" that knew nothing about any of
   * that — so picking a flow and pressing the obvious Save closed the dialog,
   * reported "Link updated", and threw the choice away. Reopening showed the old
   * flow, which reads as "the setting did not stick" rather than "you pressed the
   * wrong button". One Save that saves everything on the screen is the contract a
   * reader already assumes; this is how the modal keeps it.
   */
  registerFlush?: (flush: BindingFlush | null) => void;
}

/** Key-order-independent, so a re-serialized contract does not read as an edit. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v).sort().reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {})
      : v,
  );
}

export function FlowBindingEditor({ linkId, registerFlush }: FlowBindingEditorProps) {
  const { t } = useI18n();
  const [loading, setLoading] = React.useState(true);
  const [flows, setFlows] = React.useState<BrainSummary[]>([]);
  const [binding, setBinding] = React.useState<Binding | null>(null);
  const [brainKey, setBrainKey] = React.useState('');
  const [contract, setContract] = React.useState<DataContract>(DEFAULT_CONTRACT);
  const [candidates, setCandidates] = React.useState<BindingCandidates | null>(null);
  const [check, setCheck] = React.useState<PreflightResult | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (linkId == null) { setLoading(false); return; }
    let alive = true;
    Promise.all([listBrains(), getBinding(linkId)])
      .then(([list, b]) => {
        if (!alive) return;
        // Only published flows can be assigned: a link pointing at a draft would be
        // running something nobody approved.
        setFlows(list.filter((f) => f.status === 'published'));
        setBinding(b);
        if (b) {
          setBrainKey(b.brain_key);
          setContract({ ...DEFAULT_CONTRACT, ...(b.data_contract || {}) });
        }
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [linkId]);

  React.useEffect(() => {
    if (linkId == null || !brainKey) { setCandidates(null); return; }
    bindingCandidates(linkId, brainKey).then(setCandidates).catch(() => setCandidates(null));
  }, [linkId, brainKey]);

  // Preflight runs as the mapping changes, so the author sees the gate move rather
  // than discovering it when they press the button.
  React.useEffect(() => {
    if (linkId == null || !brainKey) { setCheck(null); return; }
    const t = setTimeout(() => {
      preflightBinding({ link_id: linkId, brain_key: brainKey, data_contract: contract })
        .then(setCheck)
        .catch(() => setCheck(null));
    }, 300);
    return () => clearTimeout(t);
  }, [linkId, brainKey, contract]);

  // WHAT IS ON SCREEN BUT NOT YET WRITTEN.
  //
  // Compared against the binding as it was loaded, so re-opening the dialog and
  // touching nothing registers no flush and the modal's Save stays a no-op here.
  //
  // These hooks sit ABOVE the early returns below on purpose. This component
  // returns early while the link is null or the binding is still loading, and a
  // hook placed after that point runs on some renders and not others — React
  // counts them and throws #310 the moment loading flips. (It did.)
  const persistedKey = binding?.brain_key ?? '';
  const persistedContract = React.useMemo(
    () => stableJson(binding ? { ...DEFAULT_CONTRACT, ...(binding.data_contract || {}) } : null),
    [binding],
  );
  const dirty =
    brainKey !== persistedKey ||
    (!!brainKey && stableJson(contract) !== persistedContract);

  // Holds the LATEST persist closure so the parent is not re-registered on every
  // keystroke. Assigned during render further down, once `persist` exists.
  const persistRef = React.useRef<((o?: { silent?: boolean }) => Promise<void>) | null>(null);

  React.useEffect(() => {
    if (!registerFlush) return;
    registerFlush(dirty ? () => persistRef.current!({ silent: true }) : null);
    return () => registerFlush(null);
  }, [registerFlush, dirty]);

  if (linkId == null) {
    return (
      <p className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-tiny leading-5 text-text-tertiary">
        {t('agentFlows.binding.saveLinkFirst')}
      </p>
    );
  }
  if (loading) {
    return <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />;
  }

  const setResolve = (key: string, entry: ResolveEntry | null) => {
    setContract((c) => {
      const next = { ...c.resolve };
      if (entry) next[key] = entry; else delete next[key];
      return { ...c, resolve: next };
    });
  };

  const toggleChart = (id: number) => {
    setContract((c) => {
      const has = c.charts.ids.includes(id);
      return {
        ...c,
        charts: {
          mode: 'allowlist',
          ids: has ? c.charts.ids.filter((x) => x !== id) : [...c.charts.ids, id],
        },
      };
    });
  };

  /** Write the pending choice. `silent` is for the modal's own Save, which
   *  reports once for the whole dialog rather than once per section. It RETHROWS
   *  so the caller can refuse to claim success — a binding that failed preflight
   *  must not be reported as "Link updated". */
  const persist = async ({ silent = false }: { silent?: boolean } = {}) => {
    if (linkId == null) return;
    setBusy(true);
    try {
      if (!brainKey) {
        // The picker was cleared. Nothing assigned is a real state, and leaving
        // the old binding in place would keep answering viewers with a flow the
        // author just removed from the screen.
        if (binding) {
          await deleteBinding(linkId);
          setBinding(null); setContract(DEFAULT_CONTRACT); setCheck(null);
          if (!silent) toast.success(t('agentFlows.binding.unassigned'));
        }
        return;
      }
      const res = await saveBinding({
        link_id: linkId, brain_key: brainKey, data_contract: contract,
      });
      if (!silent) toast.success(t('agentFlows.binding.assigned'));
      setBinding(await getBinding(linkId));
      setCheck(res);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      if (!silent) toast.error(detail || t('agentFlows.binding.assignFailed'));
      throw e;
    } finally { setBusy(false); }
  };

  const assign = async () => {
    try { await persist(); } catch { /* reported above */ }
  };

  persistRef.current = persist;

  const unassign = async () => {
    setBusy(true);
    try {
      await deleteBinding(linkId);
      setBinding(null); setBrainKey(''); setContract(DEFAULT_CONTRACT); setCheck(null);
      toast.success(t('agentFlows.binding.unassigned'));
    } finally { setBusy(false); }
  };

  const chosenFlow = flows.find((f) => f.brain_key === brainKey);
  const chartCount = contract.charts.ids.length;
  const totalCharts = candidates?.charts.length ?? 0;

  return (
    <div className="space-y-4">
      {/* 0 — IS THIS LINK CONNECTED?
          Measured before this existed: the assign button sat 438px BELOW the fold
          of a 1,423px nested scroller, and nothing above it said whether the link
          already had a flow. So the question "is my bot wired up?" could only be
          answered by scrolling to the bottom of a long form — which reads, to
          anyone who does not know the form is that long, as the feature not being
          there at all. The answer belongs at the top, before the controls that
          change it. */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2',
          binding
            ? 'border-success/30 bg-success/5'
            : 'border-[rgb(var(--border-line))] bg-surface-2',
        )}
      >
        <Workflow className={cn('h-4 w-4 flex-shrink-0',
          binding ? 'text-success' : 'text-text-tertiary')} />
        {binding ? (
          <>
            <span className="text-caption font-medium">
              {t('agentFlows.binding.connected', { name: chosenFlow?.name || binding.brain_key })}
            </span>
            <Badge variant="neutral">
              {t('agentFlows.binding.chartCount', { count: `${chartCount}/${totalCharts || '?'}` })}
            </Badge>
            {/* Web access is the one capability that sends a viewer's question
                OUT of the deployment, so it is called out rather than listed
                neutrally when it is on. */}
            <Badge variant={contract.capabilities.web_search ? 'warning' : 'neutral'}>
              {contract.capabilities.web_search ? t('agentFlows.binding.webOn') : t('agentFlows.binding.webOff')}
            </Badge>
          </>
        ) : (
          <span className="text-caption text-text-secondary">
            {brainKey
              ? t('agentFlows.binding.notConnectedReady')
              : t('agentFlows.binding.notConnectedStart')}
          </span>
        )}
      </div>

      {/* 1 — pick */}
      <Step n={1} title={t('agentFlows.binding.step.pick')}>
        <select
          value={brainKey}
          onChange={(e) => setBrainKey(e.target.value)}
          className="h-8 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption"
        >
          <option value="">{t('agentFlows.binding.option.none')}</option>
          {flows.map((f) => (
            <option key={f.brain_key} value={f.brain_key}>{f.name}</option>
          ))}
        </select>
        {!flows.length && (
          <p className="mt-1.5 text-tiny text-text-tertiary">
            {t('agentFlows.binding.noPublishedFlows')}
          </p>
        )}
        {binding?.status === 'needs_review' && (
          <p className="mt-2 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-2 text-tiny leading-5 text-warning">
            {t('agentFlows.binding.legacyPrefix')}{' '}
            <b>{t('agentFlows.binding.legacyStrong')}</b>.{' '}
            {t('agentFlows.binding.legacySuffix')}
          </p>
        )}
      </Step>

      {/* 2 — define */}
      {brainKey && candidates && (
        <Step n={2} title={t('agentFlows.binding.step.define')}>
          <p className="mb-2 text-tiny leading-5 text-text-tertiary">
            {t('agentFlows.binding.defineIntro')}
          </p>

          {candidates.requirements.items.map((req) => {
            const entry = contract.resolve[req.key];
            const chart = candidates.charts.find((c) => c.id === entry?.chart_id);
            const fields = req.kind === 'dimension'
              ? chart?.dimensions || []
              : chart?.measures || [];
            return (
              <div key={req.key} className="mt-2 rounded-lg border border-[rgb(var(--border-line))] p-2.5">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <b className="text-caption font-medium">{req.label || req.key}</b>
                  <Badge size="xs" variant="neutral">{req.kind}</Badge>
                  {req.required
                    ? <Badge size="xs" variant="danger">{t('agentFlows.binding.required')}</Badge>
                    : <Badge size="xs" variant="neutral">{t('agentFlows.binding.optional')}</Badge>}
                </div>
                {req.hint && <p className="mb-1.5 text-tiny text-text-tertiary">{req.hint}</p>}
                <div className="grid grid-cols-2 gap-1.5">
                  <select
                    value={entry?.chart_id ?? ''}
                    onChange={(e) => {
                      const id = Number(e.target.value);
                      setResolve(req.key, id
                        ? { kind: req.kind === 'dimension' ? 'dimension' : 'measure', chart_id: id, field: '', label: req.label }
                        : null);
                    }}
                    className="h-8 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-tiny"
                  >
                    <option value="">{t('agentFlows.binding.selectChart')}</option>
                    {candidates.charts.map((c) => (
                      <option key={c.id} value={c.id}>{c.title || `Chart ${c.id}`}</option>
                    ))}
                  </select>
                  <select
                    value={entry?.field || ''}
                    disabled={!entry?.chart_id}
                    onChange={(e) => setResolve(req.key, { ...(entry as ResolveEntry), field: e.target.value })}
                    className="h-8 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-tiny disabled:opacity-50"
                  >
                    <option value="">{t('agentFlows.binding.selectField')}</option>
                    {fields.map((f) => (
                      <option key={f.field} value={f.field}>{f.label || f.field}</option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}

          <div className="mt-3">
            <b className="text-caption font-medium">{t('agentFlows.binding.readableCharts')}</b>
            <p className="mb-1.5 text-tiny text-text-tertiary">
              {t('agentFlows.binding.readableChartsHint')}
            </p>
            <div className="max-h-44 overflow-auto rounded-lg border border-[rgb(var(--border-line))] p-1.5">
              {candidates.charts.map((c) => (
                <label key={c.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-tiny hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={contract.charts.ids.includes(c.id)}
                    onChange={() => toggleChart(c.id)}
                  />
                  <span className="truncate">{c.title || `Chart ${c.id}`}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setContract((ct) => ({
                ...ct, charts: { mode: 'allowlist', ids: candidates.charts.map((c) => c.id) },
              }))}
              className="mt-1 text-tiny text-brand hover:underline"
            >
              {t('agentFlows.binding.selectAll')}
            </button>
          </div>

          <label className="mt-3 flex items-center gap-2 text-caption">
            <input
              type="checkbox"
              checked={contract.capabilities.web_search}
              onChange={(e) => setContract((c) => ({
                ...c, capabilities: { ...c.capabilities, web_search: e.target.checked },
              }))}
            />
            {t('agentFlows.binding.allowWeb')}
            {candidates.flow_capabilities.web_search && !contract.capabilities.web_search && (
              <span className="text-tiny text-warning">{t('agentFlows.binding.webStepOffHint')}</span>
            )}
          </label>
        </Step>
      )}

      {/* 3 — the gate */}
      {brainKey && (
        <Step n={3} title={t('agentFlows.binding.step.preflight')}>
          {!check ? (
            <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
          ) : (
            <>
              {check.errors.map((e, i) => (
                <p key={i} className="mb-1.5 flex gap-1.5 rounded-lg border border-danger/25 bg-danger/5 p-2 text-tiny leading-5 text-danger">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />{e.message}
                </p>
              ))}
              {check.warnings.map((w, i) => (
                <p key={i} className="mb-1.5 rounded-lg border border-warning/25 bg-warning/5 p-2 text-tiny leading-5 text-warning">
                  {w.message}
                </p>
              ))}
              {check.ok && !check.errors.length && (
                <p className="mb-1.5 flex items-center gap-1.5 text-tiny text-success">
                  <Check className="h-3.5 w-3.5" /> {t('agentFlows.binding.ready')}
                </p>
              )}
              {/* The number the person approving this is committing to. A public
                  link has an unbounded audience and one Loop multiplies a single
                  question by up to 25 model calls. */}
              <p className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-2 text-tiny leading-5 text-text-secondary">
                {t('agentFlows.binding.estimatePrefix')} <b>{t('agentFlows.binding.oneQuestion')}</b>:{' '}
                {t('agentFlows.binding.estimateSuffix', {
                  llm: check.estimate.max_llm_calls,
                  tools: check.estimate.max_tool_calls,
                })}
                {check.estimate.max_tool_calls > contract.budget.max_tool_calls && (
                  <span className="text-warning">
                    {' '}{t('agentFlows.binding.overBudget', { limit: contract.budget.max_tool_calls })}
                  </span>
                )}
              </p>

            </>
          )}
        </Step>
      )}

      {/* THE ACTION, OUTSIDE THE STEPS AND STUCK TO THE BOTTOM.
          It lived inside step 3, which made two things true at once: it sat at
          the very end of a 1,423px scroll, and how far down it sat depended on
          how many warnings the preflight happened to raise. A `sticky` inside
          step 3 would not have fixed that either — a sticky element only floats
          while ITS OWN box is on screen, and step 3 was the part that was off
          screen. Lifted out to the editor's own footer, it stays reachable for
          the whole scroll, which is what "reachable" has to mean for the one
          control that performs the operation. */}
      {brainKey && check && (
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-2 border-t border-[rgb(var(--border-line))] bg-surface-1/95 px-1 py-2.5 backdrop-blur">
          <Button size="sm" onClick={assign} loading={busy} disabled={!check.ok}>
            {binding ? t('agentFlows.binding.update') : t('agentFlows.binding.assign')}
          </Button>
          {binding && (
            <Button variant="secondary" size="sm" onClick={unassign} loading={busy}>
              {t('agentFlows.binding.remove')}
            </Button>
          )}
          <span className="text-tiny text-text-tertiary">
            {check.ok
              ? t('agentFlows.binding.summaryReady', { charts: chartCount, llm: check.estimate.max_llm_calls })
              : t('agentFlows.binding.summaryNotReady')}
          </span>
        </div>
      )}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-tiny font-strong text-brand">
          {n}
        </span>
        <b className="text-caption font-strong">{title}</b>
      </div>
      {children}
    </div>
  );
}
