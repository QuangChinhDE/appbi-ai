'use client';

/**
 * Assistant configuration — a screen, not a modal.
 *
 * An assistant is where a report gets its behaviour, so the two things that
 * silently go wrong here get first-class treatment:
 *
 *   1. ROUTING ORDER. Rules match top-to-bottom, first match wins. A modal with
 *      a static list hides that completely. Here the order is the interaction:
 *      you drag rows, the catch-all is pinned last, and any rule an earlier row
 *      already covers is labelled unreachable instead of quietly never firing.
 *
 *   2. WHO ACTUALLY ANSWERS. Bindings inherit link → dashboard → global →
 *      built-in. Nobody holds that correctly in their head while clicking, so
 *      the page asks the backend to resolve a real surface and shows the answer.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ChevronDown, ChevronLeft, ChevronUp, FlaskConical, GripVertical,
  Lock, Plus, Target, Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import {
  type Assistant, type AssistantBinding, type EffectiveFlow, type FlowStat,
  type FlowSummary, type Palette, type RoutingRule, type Surfaces,
  getEffectiveFlow, getFlowStats, saveAssistant, setBindings,
} from '@/lib/aiFlows';
import { Panel, errText, useCanEdit, useCanPublish } from '../shared';

const WILDCARD = '*';

type PageTab = 'routing' | 'budget' | 'knowledge' | 'bindings';

/** Typical spend for one deep-reasoning turn — used only for the budget estimate. */
const USD_PER_TURN = 0.012;

interface Props {
  assistant: Assistant;
  flows: FlowSummary[];
  surfaces: Surfaces | null;
  palette: Palette | null;
  onBack: () => void;
  onChanged: () => void;
}

export function AssistantPage({
  assistant, flows, surfaces, palette, onBack, onChanged,
}: Props) {
  const { t } = useI18n();
  const canEdit = useCanEdit();
  const canPublish = useCanPublish();

  const [tab, setTab] = useState<PageTab>('routing');
  const [name, setName] = useState(assistant.display_name);
  const [status, setStatus] = useState(assistant.status);
  const [routing, setRouting] = useState<RoutingRule[]>(() => normalise(assistant.routing));
  const [budget, setBudget] = useState(assistant.budget ?? {});
  const [knowledge, setKnowledge] = useState<Record<string, unknown>>(assistant.knowledge_scope ?? {});
  const [bindings, setLocalBindings] = useState<AssistantBinding[]>(assistant.bindings ?? []);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const published = useMemo(() => flows.filter((f) => f.status === 'published'), [flows]);
  const intents = palette?.intents ?? [];
  const touch = () => setDirty(true);

  const save = async () => {
    setBusy(true);
    try {
      await saveAssistant({
        key: assistant.key,
        display_name: name,
        status,
        routing,
        budget,
        knowledge_scope: knowledge,
        locale: assistant.locale,
      });
      if (canPublish) await setBindings(assistant.key, bindings);
      toast.success(t('aiFlows.common.saved'));
      setDirty(false);
      onChanged();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-0px)] flex-col">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" /> {t('aiFlows.common.back')}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={name}
              disabled={!canEdit}
              onChange={(e) => { setName(e.target.value); touch(); }}
              className="min-w-0 max-w-sm flex-1 truncate border-0 bg-transparent p-0 text-body font-strong text-text-primary outline-none focus:ring-0 disabled:opacity-70"
            />
            <Badge variant={status === 'published' ? 'success' : 'warning'} size="xs">
              {status === 'published'
                ? t('aiFlows.assistants.statusPublished')
                : t('aiFlows.assistants.statusDraft')}
            </Badge>
            {dirty && <Badge variant="warning" size="xs">{t('aiFlows.builder.unsaved')}</Badge>}
          </div>
          <p className="mt-0.5 text-tiny text-text-tertiary"><code>{assistant.key}</code></p>
        </div>
        <Select
          className="w-44"
          value={status}
          disabled={!canEdit}
          onChange={(e) => { setStatus(e.target.value as Assistant['status']); touch(); }}
        >
          <option value="draft">{t('aiFlows.assistants.statusDraft')}</option>
          <option value="published">{t('aiFlows.assistants.statusPublished')}</option>
        </Select>
        {canEdit && (
          <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={save}>
            {dirty ? t('aiFlows.common.save') : t('aiFlows.common.saved')}
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <Tabs
          className="mb-4"
          value={tab}
          onChange={(k) => setTab(k as PageTab)}
          items={[
            { key: 'routing', label: t('aiFlows.assistants.tabRouting') },
            { key: 'bindings', label: t('aiFlows.assistants.tabBindings') },
            { key: 'budget', label: t('aiFlows.assistants.tabBudget') },
            { key: 'knowledge', label: t('aiFlows.assistants.tabKnowledge') },
          ]}
        />

        {tab === 'routing' && (
          <div className="grid max-w-6xl gap-4 xl:grid-cols-[minmax(0,1fr),340px]">
            <RoutingTable
              routing={routing}
              flows={published}
              intents={intents}
              readOnly={!canEdit}
              onChange={(next) => { setRouting(next); touch(); }}
            />
            <EffectivePreview assistantKey={assistant.key} surfaces={surfaces} intents={intents} />
          </div>
        )}

        {tab === 'bindings' && (
          <BindingsEditor
            bindings={bindings}
            surfaces={surfaces}
            canPublish={canPublish}
            onChange={(next) => { setLocalBindings(next); touch(); }}
          />
        )}

        {tab === 'budget' && (
          <BudgetEditor
            budget={budget}
            readOnly={!canEdit}
            onChange={(next) => { setBudget(next); touch(); }}
          />
        )}

        {tab === 'knowledge' && (
          <KnowledgeScope
            scope={knowledge}
            palette={palette}
            readOnly={!canEdit}
            onChange={(next) => { setKnowledge(next); touch(); }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Exactly one catch-all, and it is always last.
 *
 * If stored data somehow holds two, the FIRST is kept — the runtime matches
 * top-to-bottom, so the first one is the rule that answers today. Keeping any
 * other would quietly change live behaviour just by opening this screen.
 */
function normalise(rules: RoutingRule[]): RoutingRule[] {
  // Spread first: reordering must not quietly drop fields it does not know
  // about. An earlier version rebuilt each row from {when_intent, flow} and
  // would have erased a rule's canary the moment anyone dragged it.
  const list = (rules ?? []).map((r) => ({
    ...r,
    when_intent: [...(r.when_intent ?? [])],
    flow: r.flow,
  }));
  const wildcards = list.filter(isWildcard);
  const rest = list.filter((r) => !isWildcard(r));
  return wildcards.length ? [...rest, wildcards[0]] : rest;
}

const isWildcard = (r: RoutingRule) => (r.when_intent ?? []).includes(WILDCARD);

// ── Routing: order IS the semantics, so make order the interaction ──────────
function RoutingTable({ routing, flows, intents, readOnly, onChange }: {
  routing: RoutingRule[];
  flows: FlowSummary[];
  intents: { key: string; label_vi: string }[];
  readOnly?: boolean;
  onChange: (next: RoutingRule[]) => void;
}) {
  const { t } = useI18n();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const wildcardAt = routing.findIndex(isWildcard);
  const hasWildcard = wildcardAt >= 0;
  const movableCount = hasWildcard ? routing.length - 1 : routing.length;

  /**
   * The catch-all is not a selectable intent here — it is the locked last row.
   * The backend intent list happens to lead with `*`, so taking intents[0] as
   * the default for a new rule minted a SECOND catch-all, and `normalise` then
   * kept only one of them: the author's real catch-all silently lost its flow.
   */
  const selectableIntents = intents.filter((x) => x.key !== WILDCARD);

  /** A rule is dead if an earlier rule already claims every intent it matches. */
  const coveredBefore = (i: number): boolean => {
    const mine = new Set(routing[i]?.when_intent ?? []);
    if (!mine.size) return false;
    const claimed = new Set<string>();
    for (let j = 0; j < i; j += 1) {
      (routing[j].when_intent ?? []).forEach((x) => claimed.add(x));
    }
    if (claimed.has(WILDCARD)) return true;
    return Array.from(mine).every((x) => claimed.has(x));
  };

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= movableCount) return;
    const next = [...routing];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    onChange(normalise(next));
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <Label className="!mb-0">{t('aiFlows.assistants.routing')}</Label>
        {!readOnly && (
          <Button
            variant="ghost" size="xs"
            onClick={() => {
              // Insert above the locked catch-all, never after it.
              const head = hasWildcard ? routing.slice(0, -1) : routing;
              const tail = hasWildcard ? [routing[routing.length - 1]] : [];
              // Prefer an intent no rule claims yet, so a fresh row is useful
              // rather than instantly flagged unreachable.
              const taken = new Set(head.flatMap((r) => r.when_intent ?? []));
              const free = selectableIntents.find((x) => !taken.has(x.key));
              onChange(normalise([
                ...head,
                {
                  when_intent: [free?.key ?? selectableIntents[0]?.key ?? 'lookup'],
                  flow: tail[0]?.flow || flows[0]?.flow_key || '',
                },
                ...tail,
              ]));
            }}
          >
            <Plus className="h-3 w-3" /> {t('aiFlows.assistants.addRule')}
          </Button>
        )}
      </div>

      <p className="mb-2 text-tiny text-text-tertiary">{t('aiFlows.assistants.dragHint')}</p>

      <div className="space-y-1.5">
        {routing.map((rule, i) => {
          const locked = isWildcard(rule);
          const dead = !locked && coveredBefore(i);
          return (
            <div
              key={i}
              draggable={!readOnly && !locked}
              onDragStart={() => setDragIdx(i)}
              onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
              onDragOver={(e) => {
                if (dragIdx === null || locked) return;
                e.preventDefault();
                setOverIdx(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx !== null && !locked) move(dragIdx, i);
                setDragIdx(null);
                setOverIdx(null);
              }}
              className={`flex flex-wrap items-center gap-2 rounded-lg border bg-surface-1 p-2 transition-colors ${
                overIdx === i && dragIdx !== null && dragIdx !== i
                  ? 'border-brand bg-brand/[0.04]'
                  : 'border-[rgb(var(--border-line))]'
              } ${dragIdx === i ? 'opacity-50' : ''} ${dead ? 'opacity-70' : ''}`}
            >
              <span className="flex flex-shrink-0 items-center gap-0.5 text-tiny text-text-quaternary">
                {locked ? (
                  <Lock className="h-3 w-3" aria-label={t('aiFlows.assistants.wildcardLocked')} />
                ) : (
                  <GripVertical
                    className={`h-3.5 w-3.5 ${readOnly ? '' : 'cursor-grab'}`}
                    aria-hidden
                  />
                )}
                <span className="w-3 text-center">{i + 1}</span>
                {/* Drag is the fast path, but it is mouse-only: no keyboard
                    route, awkward on touch. These buttons are the same move
                    operation reachable by Tab and Enter. */}
                {!readOnly && !locked && (
                  <span className="flex flex-col">
                    <button
                      type="button"
                      disabled={i === 0}
                      aria-label={t('aiFlows.assistants.moveUp')}
                      title={t('aiFlows.assistants.moveUp')}
                      onClick={() => move(i, i - 1)}
                      className="text-text-quaternary hover:text-brand disabled:opacity-30"
                    >
                      <ChevronUp className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      disabled={i >= movableCount - 1}
                      aria-label={t('aiFlows.assistants.moveDown')}
                      title={t('aiFlows.assistants.moveDown')}
                      onClick={() => move(i, i + 1)}
                      className="text-text-quaternary hover:text-brand disabled:opacity-30"
                    >
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </span>

              {locked ? (
                <span className="flex-1 rounded bg-surface-2 px-2 py-1 text-caption text-text-secondary">
                  {t('aiFlows.assistants.wildcardLabel')} <code className="ml-1">*</code>
                </span>
              ) : (
                <Select
                  className="min-w-[160px] flex-1"
                  value={(rule.when_intent ?? [])[0] ?? ''}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = [...routing];
                    next[i] = { ...rule, when_intent: [e.target.value] };
                    onChange(next);
                  }}
                >
                  {selectableIntents.map((x) => (
                    <option key={x.key} value={x.key}>{x.label_vi}</option>
                  ))}
                </Select>
              )}

              <span className="text-text-quaternary">→</span>

              <Select
                className="min-w-[160px] flex-1"
                value={rule.flow}
                disabled={readOnly}
                onChange={(e) => {
                  const next = [...routing];
                  next[i] = { ...rule, flow: e.target.value };
                  onChange(next);
                }}
              >
                <option value="">—</option>
                {flows.map((f) => (
                  <option key={f.flow_key} value={f.flow_key}>{f.display_name}</option>
                ))}
              </Select>

              {!readOnly && (
                <Button
                  variant="ghost" size="xs"
                  title={t('aiFlows.canary.toggle')}
                  aria-label={t('aiFlows.canary.toggle')}
                  onClick={() => {
                    const next = [...routing];
                    next[i] = rule.canary_flow
                      ? { ...rule, canary_flow: null, canary_percent: 0 }
                      : { ...rule, canary_flow: '', canary_percent: 10 };
                    onChange(next);
                  }}
                  className={rule.canary_flow != null ? '!text-brand' : undefined}
                >
                  <FlaskConical className="h-3.5 w-3.5" />
                </Button>
              )}

              {!readOnly && !locked && (
                <Button
                  variant="ghost" size="xs"
                  onClick={() => onChange(routing.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-3.5 w-3.5 text-danger" />
                </Button>
              )}

              {dead && (
                <p className="w-full pl-8 text-tiny text-warning">
                  {t('aiFlows.assistants.unreachable')}
                </p>
              )}

              {rule.canary_flow != null && (
                <CanaryRow
                  rule={rule}
                  flows={flows}
                  readOnly={readOnly}
                  onChange={(patch) => {
                    const next = [...routing];
                    next[i] = { ...rule, ...patch };
                    onChange(next);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {hasWildcard ? (
        <p className="mt-2 flex items-start gap-1.5 text-tiny text-text-quaternary">
          <Lock className="mt-px h-3 w-3 flex-shrink-0" />
          {t('aiFlows.assistants.wildcardLocked')}
        </p>
      ) : (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/[0.06] p-2">
          <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="text-tiny text-text-secondary">
              {t('aiFlows.assistants.wildcardMissing')}
            </p>
            {!readOnly && (
              <Button
                variant="ghost" size="xs" className="mt-1"
                onClick={() => onChange([
                  ...routing, { when_intent: [WILDCARD], flow: flows[0]?.flow_key ?? '' },
                ])}
              >
                <Plus className="h-3 w-3" /> {t('aiFlows.assistants.wildcardLabel')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Canary: send a slice of viewers to a candidate flow.
 *
 * The percentage is deliberately paired with the live comparison below it. A
 * split with nothing to compare is just unexplained inconsistency between two
 * viewers, so the numbers from real traffic sit right where the split is set.
 *
 * The slice is per SESSION, not per question — a viewer stays on one flow for
 * the whole conversation. Mixing two flows inside one thread would make
 * "why did the answer change?" unanswerable.
 */
function CanaryRow({ rule, flows, readOnly, onChange }: {
  rule: RoutingRule;
  flows: FlowSummary[];
  readOnly?: boolean;
  onChange: (patch: Partial<RoutingRule>) => void;
}) {
  const { t } = useI18n();
  const [stats, setStats] = useState<FlowStat[]>([]);
  const keys = useMemo(
    () => [rule.flow, rule.canary_flow].filter((k): k is string => !!k),
    [rule.flow, rule.canary_flow],
  );

  useEffect(() => {
    if (keys.length < 2) { setStats([]); return; }
    getFlowStats(keys).then(setStats).catch(() => setStats([]));
  }, [keys]);

  const percent = Math.max(0, Math.min(100, Number(rule.canary_percent ?? 0)));
  const sameFlow = !!rule.canary_flow && rule.canary_flow === rule.flow;

  return (
    <div className="w-full space-y-2 rounded-lg border border-brand/25 bg-brand/[0.03] p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-tiny font-strong uppercase tracking-wide text-brand">
          <FlaskConical className="h-3 w-3" /> {t('aiFlows.canary.title')}
        </span>
        <Select
          className="min-w-[160px] flex-1"
          value={rule.canary_flow ?? ''}
          disabled={readOnly}
          onChange={(e) => onChange({ canary_flow: e.target.value })}
        >
          <option value="">{t('aiFlows.canary.pick')}</option>
          {flows.map((f) => (
            <option key={f.flow_key} value={f.flow_key}>{f.display_name}</option>
          ))}
        </Select>
        <label className="flex items-center gap-1.5 text-tiny text-text-secondary">
          <input
            type="range" min={0} max={100} step={5}
            value={percent}
            disabled={readOnly}
            onChange={(e) => onChange({ canary_percent: Number(e.target.value) })}
            className="w-28"
          />
          <span className="w-10 text-right font-mono">{percent}%</span>
        </label>
      </div>

      {sameFlow ? (
        <p className="text-tiny text-warning">{t('aiFlows.canary.sameFlow')}</p>
      ) : (
        <p className="text-tiny leading-relaxed text-text-quaternary">
          {t('aiFlows.canary.hint', { percent })}
        </p>
      )}

      {stats.length === 2 && (
        <div className="overflow-x-auto">
          <table className="w-full text-tiny">
            <thead className="text-text-quaternary">
              <tr>
                <th className="py-1 text-left">{t('aiFlows.canary.arm')}</th>
                <th className="py-1 text-right">{t('aiFlows.canary.runs')}</th>
                <th className="py-1 text-right">{t('aiFlows.canary.usd')}</th>
                <th className="py-1 text-right">{t('aiFlows.canary.latency')}</th>
                <th className="py-1 text-right">{t('aiFlows.canary.verified')}</th>
                <th className="py-1 text-right">{t('aiFlows.canary.errors')}</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s, idx) => (
                <tr key={s.flow_key} className="border-t border-[rgb(var(--border-line))]">
                  <td className="py-1">
                    <Badge variant={idx === 0 ? 'subtle' : 'info'} size="xs">
                      {idx === 0 ? t('aiFlows.canary.primary') : t('aiFlows.canary.candidate')}
                    </Badge>
                  </td>
                  <td className="py-1 text-right">{s.runs}</td>
                  <td className="py-1 text-right">${s.usd_avg.toFixed(4)}</td>
                  <td className="py-1 text-right">
                    {s.latency_p50_ms != null ? `${(s.latency_p50_ms / 1000).toFixed(1)}s` : '—'}
                  </td>
                  <td className="py-1 text-right">
                    {s.verified_avg != null ? `${Math.round(s.verified_avg * 100)}%` : '—'}
                  </td>
                  <td className="py-1 text-right">
                    {s.error_rate != null ? `${Math.round(s.error_rate * 100)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {stats.some((s) => s.runs < 20) && (
            <p className="mt-1 text-tiny text-text-quaternary">
              {t('aiFlows.canary.thinData')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── "What actually answers" — resolved server-side, not guessed ─────────────
function EffectivePreview({ assistantKey, surfaces, intents }: {
  assistantKey: string;
  surfaces: Surfaces | null;
  intents: { key: string; label_vi: string }[];
}) {
  const { t } = useI18n();
  const links = surfaces?.public_links ?? [];
  const [token, setToken] = useState('');
  const [intent, setIntent] = useState('');
  const [result, setResult] = useState<EffectiveFlow | null>(null);

  useEffect(() => {
    if (!token && links.length) setToken(links[0].token);
  }, [links, token]);

  const probe = useCallback(() => {
    if (!token) return;
    const link = links.find((l) => l.token === token);
    getEffectiveFlow(assistantKey, {
      token,
      dashboard_id: link?.dashboard_id,
      intent: intent || undefined,
    })
      .then(setResult)
      .catch(() => setResult(null));
  }, [assistantKey, intent, links, token]);

  useEffect(() => { probe(); }, [probe]);

  return (
    <Panel
      title={<span className="flex items-center gap-1.5"><Target className="h-3.5 w-3.5" /> {t('aiFlows.assistants.effective')}</span>}
      sub={t('aiFlows.assistants.effectiveHint')}
    >
      {links.length === 0 ? (
        <p className="text-tiny text-text-tertiary">{t('aiFlows.preview.noLinks')}</p>
      ) : (
        <div className="space-y-2">
          <div>
            <Label>{t('aiFlows.assistants.effectivePick')}</Label>
            <Select value={token} onChange={(e) => setToken(e.target.value)}>
              {links.map((l) => (
                <option key={l.token} value={l.token}>{l.dashboard_name}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('aiFlows.assistants.colIntent')}</Label>
            <Select value={intent} onChange={(e) => setIntent(e.target.value)}>
              <option value="">{t('aiFlows.common.all')}</option>
              {intents.filter((x) => x.key !== WILDCARD).map((x) => (
                <option key={x.key} value={x.key}>{x.label_vi}</option>
              ))}
            </Select>
          </div>

          <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-2.5">
            {!result || !result.resolved ? (
              <p className="text-tiny text-text-tertiary">
                {result?.reason ?? t('aiFlows.assistants.effectiveNone')}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge
                    variant={result.matches_this_assistant ? 'success' : 'warning'}
                    size="xs"
                  >
                    {result.matches_this_assistant
                      ? t('aiFlows.assistants.effectiveMine')
                      : t('aiFlows.assistants.effectiveOther', {
                          key: result.assistant_key ?? '—',
                        })}
                  </Badge>
                </div>
                <p className="mt-1.5 text-tiny text-text-secondary">
                  <code className="rounded bg-brand/10 px-1 text-brand">
                    {result.flow_key} v{result.flow_version}
                  </code>
                </p>
                {result.source && (
                  <p className="mt-1 text-tiny text-text-quaternary">
                    {t('aiFlows.assistants.effectiveVia', { source: result.source })}
                  </p>
                )}
              </>
            )}
          </div>

          <p className="text-tiny leading-relaxed text-text-quaternary">
            {t('aiFlows.assistants.hierarchyBody')}
          </p>
        </div>
      )}
    </Panel>
  );
}

// ── Budget, with what the numbers actually buy ──────────────────────────────
function BudgetEditor({ budget, readOnly, onChange }: {
  budget: Assistant['budget'];
  readOnly?: boolean;
  onChange: (b: Assistant['budget']) => void;
}) {
  const { t } = useI18n();
  const perDay = Number(budget.max_usd_per_day ?? 0);
  const turns = perDay > 0 ? Math.floor(perDay / USD_PER_TURN) : 0;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t('aiFlows.assistants.budgetDay')}</Label>
          <Input
            type="number" step="0.5" min="0"
            value={String(budget.max_usd_per_day ?? '')}
            disabled={readOnly}
            onChange={(e) => onChange({
              ...budget,
              max_usd_per_day: e.target.value === '' ? undefined : Number(e.target.value),
            })}
          />
        </div>
        <div>
          <Label>{t('aiFlows.assistants.budgetHour')}</Label>
          <Input
            type="number" min="0"
            value={String(budget.max_turns_per_hour ?? '')}
            disabled={readOnly}
            onChange={(e) => onChange({
              ...budget,
              max_turns_per_hour: e.target.value === '' ? undefined : Number(e.target.value),
            })}
          />
        </div>
      </div>

      <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-3">
        <div className="text-tiny font-strong uppercase tracking-wide text-text-quaternary">
          {t('aiFlows.assistants.estimate')}
        </div>
        <p className="mt-1 text-caption leading-relaxed text-text-secondary">
          {perDay > 0
            ? t('aiFlows.assistants.estimateBody', {
                turns, perTurn: USD_PER_TURN.toFixed(3),
              })
            : t('aiFlows.assistants.estimateNoCap')}
        </p>
      </div>

      <p className="text-tiny leading-relaxed text-text-quaternary">
        {t('aiFlows.assistants.budgetHint')}
      </p>
    </div>
  );
}

// ── Knowledge scope ─────────────────────────────────────────────────────────
function KnowledgeScope({ scope, palette, readOnly, onChange }: {
  scope: Record<string, unknown>;
  palette: Palette | null;
  readOnly?: boolean;
  onChange: (s: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const sources = palette?.context_sources ?? [];
  const enabled = (scope.sources as string[]) ?? sources.map((s) => s.key);

  return (
    <div className="max-w-2xl">
      <Label>{t('aiFlows.assistants.knowledge')}</Label>
      <div className="mt-1 space-y-1">
        {sources.map((s) => {
          const on = s.locked || enabled.includes(s.key);
          return (
            <label
              key={s.key}
              className={`flex items-center gap-2 rounded-lg border border-[rgb(var(--border-line))] p-2 ${
                s.locked ? '' : 'cursor-pointer hover:bg-surface-2'
              }`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={readOnly || s.locked}
                onChange={() => onChange({
                  ...scope,
                  sources: on
                    ? enabled.filter((x) => x !== s.key)
                    : [...enabled, s.key],
                })}
              />
              <span className="flex-1 text-caption text-text-primary">{s.label_vi}</span>
              {s.locked && (
                <Badge variant="subtle" size="xs">{t('aiFlows.inspector.contextLocked')}</Badge>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ── Bindings ────────────────────────────────────────────────────────────────
function BindingsEditor({ bindings, surfaces, canPublish, onChange }: {
  bindings: AssistantBinding[];
  surfaces: Surfaces | null;
  canPublish: boolean;
  onChange: (b: AssistantBinding[]) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex items-center justify-between">
        <Label className="!mb-0">{t('aiFlows.assistants.serving')}</Label>
        <Button
          variant="ghost" size="xs"
          disabled={!canPublish}
          onClick={() => onChange([
            ...bindings, { surface: 'public_link', surface_ref: '', enabled: true },
          ])}
        >
          <Plus className="h-3 w-3" /> {t('aiFlows.assistants.addBinding')}
        </Button>
      </div>

      {!canPublish && (
        <p className="text-tiny text-warning">{t('aiFlows.assistants.bindingNeedsFull')}</p>
      )}

      <div className="space-y-2">
        {bindings.map((b, i) => (
          <div
            key={i}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-[rgb(var(--border-line))] p-2"
          >
            <Select
              className="w-44"
              value={b.surface}
              disabled={!canPublish}
              onChange={(e) => {
                const next = [...bindings];
                next[i] = {
                  ...b,
                  surface: e.target.value as AssistantBinding['surface'],
                  surface_ref: '',
                };
                onChange(next);
              }}
            >
              <option value="public_link">{t('aiFlows.assistants.surfaceLink')}</option>
              <option value="dashboard">{t('aiFlows.assistants.surfaceDashboard')}</option>
              <option value="global">{t('aiFlows.assistants.surfaceGlobal')}</option>
            </Select>

            {b.surface !== 'global' && (
              <Select
                className="min-w-[180px] flex-1"
                value={b.surface_ref ?? ''}
                disabled={!canPublish}
                onChange={(e) => {
                  const next = [...bindings];
                  next[i] = { ...b, surface_ref: e.target.value };
                  onChange(next);
                }}
              >
                <option value="">—</option>
                {b.surface === 'public_link'
                  ? (surfaces?.public_links ?? []).map((l) => (
                      <option key={l.token} value={l.token}>{l.dashboard_name}</option>
                    ))
                  : (surfaces?.dashboards ?? []).map((d) => (
                      <option key={d.id} value={String(d.id)}>{d.name}</option>
                    ))}
              </Select>
            )}

            <label className="flex items-center gap-1 text-tiny text-text-tertiary">
              <input
                type="checkbox"
                checked={b.enabled}
                disabled={!canPublish}
                onChange={(e) => {
                  const next = [...bindings];
                  next[i] = { ...b, enabled: e.target.checked };
                  onChange(next);
                }}
              />
              {t('aiFlows.assistants.colEnabled')}
            </label>

            <Button
              variant="ghost" size="xs" disabled={!canPublish}
              onClick={() => onChange(bindings.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </Button>
          </div>
        ))}
      </div>

      <Panel title={t('aiFlows.assistants.hierarchy')}>
        <p className="text-tiny leading-relaxed text-text-secondary">
          {t('aiFlows.assistants.hierarchyBody')}
        </p>
      </Panel>
    </div>
  );
}
