'use client';

/**
 * Hướng dẫn AI — teach the AI to analyze the business's way:
 *   Playbooks (trigger → steps → expected output)
 *   Quy tắc (condition → conclusion, bound via applies-to)
 *   Hỏi-đáp chuẩn (trigger phrases → approved answer, pinned pre-agent)
 *   Phạm vi dữ liệu (AI data scope — what the bot may see)
 *   Chỉ dẫn AI (versioned, scoped system steering)
 * Everything only reaches the bot once Approved.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  BookMarked, CheckCircle2, ListChecks, MessageSquareQuote, Plus, Scale, ShieldCheck, SlidersHorizontal, Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { Input, Label, Textarea } from '@/components/ui/Input';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PageListLayout } from '@/components/common/PageListLayout';
import { AppModalShell } from '@/components/common/AppModalShell';
import { Panel, EmptyHint, StatusBadge, useCanAuthor } from '@/components/intelligence/shared';
import {
  listPlaybooks, upsertPlaybook, deletePlaybook,
  listRules, upsertRule, deleteRule,
  listQA, upsertQA, deleteQA,
  certifyEntity, listInstructions, createInstructionVersion,
  getAIScope, putAIScope, listDatasetsLite, listManagedMetrics,
  type GovernPlaybook, type GovernRule, type GovernQA, type GovernInstruction,
  type AIScope, type DatasetLite, type ManagedMetric,
} from '@/lib/catalog';
import { toast } from '@/lib/toast';
import { extractApiError } from '@/lib/api-errors';
import { useI18n } from '@/providers/LanguageProvider';

type GuidanceTab = 'playbooks' | 'rules' | 'qa' | 'scope' | 'instructions';

export function GuidancePage() {
  const { t } = useI18n();
  const canAuthor = useCanAuthor();
  const search = useSearchParams();
  const initial = (search.get('tab') as GuidanceTab) || 'playbooks';
  const [tab, setTab] = useState<GuidanceTab>(
    ['playbooks', 'rules', 'qa', 'scope', 'instructions'].includes(initial) ? initial : 'playbooks',
  );
  const [playbooks, setPlaybooks] = useState<GovernPlaybook[]>([]);
  const [rules, setRules] = useState<GovernRule[]>([]);
  const [qa, setQa] = useState<GovernQA[]>([]);
  const [instructions, setInstructions] = useState<GovernInstruction[]>([]);
  const [metrics, setMetrics] = useState<ManagedMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [pbModal, setPbModal] = useState<GovernPlaybook | 'new' | null>(null);
  const [ruleModal, setRuleModal] = useState<GovernRule | 'new' | null>(null);
  const [qaModal, setQaModal] = useState<GovernQA | 'new' | null>(null);

  const reload = useCallback(async () => {
    try {
      const [p, r, q, i, m] = await Promise.all([
        listPlaybooks().catch(() => []),
        listRules().catch(() => []),
        listQA().catch(() => []),
        listInstructions().catch(() => []),
        listManagedMetrics().catch(() => []),
      ]);
      setPlaybooks(p); setRules(r); setQa(q); setInstructions(i); setMetrics(m);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  // Non-tech reviewers don't see the admin-only tabs (data scope / instructions).
  useEffect(() => {
    if (!canAuthor && (tab === 'scope' || tab === 'instructions')) setTab('playbooks');
  }, [canAuthor, tab]);

  const certify = async (kind: 'rule' | 'playbook' | 'qa', id: number, name: string) => {
    try {
      await certifyEntity(kind, id);
      toast.success(`${t('intel.sem.certified')}: ${name}`, { description: t('intel.guid.certifiedDesc') });
      reload();
    } catch (err) {
      toast.error(extractApiError(err, t('intel.sem.certifyFailed')));
    }
  };

  const stats = [
    { label: 'Playbooks', value: `${playbooks.filter((p) => p.status === 'Approved').length}/${playbooks.length}` },
    { label: t('intel.type.rules'), value: `${rules.filter((r) => r.status === 'Approved').length}/${rules.length}` },
    { label: t('intel.type.qa'), value: `${qa.filter((x) => x.status === 'Approved').length}/${qa.length}` },
    { label: t('intel.guid.instrVersions'), value: instructions.filter((i) => i.status === 'active').length },
  ];

  const createAction = tab === 'playbooks' ? (
    <Button variant="primary" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setPbModal('new')}>{t('intel.guid.newPlaybook')}</Button>
  ) : tab === 'rules' ? (
    <Button variant="primary" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setRuleModal('new')}>{t('intel.guid.newRule')}</Button>
  ) : tab === 'qa' ? (
    <Button variant="primary" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setQaModal('new')}>{t('intel.guid.newQA')}</Button>
  ) : undefined;

  return (
    <PageListLayout
      title={t('intel.guid.title')}
      description={t('intel.guid.desc')}
      searchable={false}
      viewToggle={false}
      isLoading={loading}
      action={canAuthor ? createAction : undefined}
      overview={<ModuleOverview stats={stats} />}
      toolbarExtra={(
        <Tabs
          size="sm"
          value={tab}
          onChange={(k) => setTab(k as GuidanceTab)}
          items={[
            { key: 'playbooks', label: 'Playbooks', icon: <BookMarked className="h-3.5 w-3.5" /> },
            { key: 'rules', label: t('intel.guid.tabRules'), icon: <Scale className="h-3.5 w-3.5" /> },
            { key: 'qa', label: t('intel.guid.tabQA'), icon: <MessageSquareQuote className="h-3.5 w-3.5" /> },
            { key: 'scope', label: t('intel.guid.tabScope'), icon: <SlidersHorizontal className="h-3.5 w-3.5" /> },
            { key: 'instructions', label: t('intel.guid.tabInstr'), icon: <ListChecks className="h-3.5 w-3.5" /> },
          ].filter((it) => canAuthor || (it.key !== 'scope' && it.key !== 'instructions'))}
        />
      )}
    >
      {tab === 'playbooks' && (
        <div className="grid grid-cols-1 gap-3 pb-8 md:grid-cols-2 xl:grid-cols-3">
          {playbooks.map((p) => (
            <Panel
              key={p.id}
              title={p.name}
              sub={`${t('intel.guid.trigger')}: ${p.trigger_text}`}
              action={<StatusBadge status={p.status} />}
              className="cursor-pointer transition-[border-color,box-shadow] hover:border-[rgb(var(--border-strong))] hover:shadow-linear"
            >
              <div onClick={() => setPbModal(p)}>
                <ol className="ml-4 list-decimal space-y-1 text-caption text-text-secondary marker:text-text-quaternary">
                  {p.steps.slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}
                </ol>
                {p.expected_output && (
                  <p className="mt-2 text-tiny text-text-tertiary"><b className="font-emphasis">{t('intel.guid.output')}:</b> {p.expected_output}</p>
                )}
                {p.linked_metrics.length > 0 && (
                  <p className="mt-1.5 text-tiny text-text-quaternary">{t('intel.guid.linkedMetrics')}: {p.linked_metrics.join(', ')}</p>
                )}
              </div>
              <div className="mt-3 flex items-center gap-1.5 border-t border-[rgb(var(--border-line))] pt-2.5">
                {p.status !== 'Approved' && (
                  <Button size="xs" variant="secondary" leadingIcon={<ShieldCheck className="h-3 w-3" />} onClick={() => certify('playbook', p.id, p.name)}>
                    {t('intel.sem.certify')}
                  </Button>
                )}
                {canAuthor && <Button size="xs" variant="ghost" onClick={() => setPbModal(p)}>{t('intel.common.edit')}</Button>}
                <span className="ml-auto text-tiny text-text-quaternary">v{p.version}</span>
              </div>
            </Panel>
          ))}
          {playbooks.length === 0 && <div className="md:col-span-2 xl:col-span-3"><EmptyHint>{t('intel.guid.emptyPlaybooks')}</EmptyHint></div>}
        </div>
      )}

      {tab === 'rules' && (
        <div className="pb-8">
          <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
            <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
              <colgroup><col className="w-[34%]" /><col className="w-[22%]" /><col className="w-[16%]" /><col className="w-[14%]" /><col className="w-[14%]" /></colgroup>
              <thead className="bg-surface-2">
                <tr>
                  <th className="app-list-header">{t('intel.guid.colRule')}</th>
                  <th className="app-list-header">{t('intel.guid.colException')}</th>
                  <th className="app-list-header">{t('intel.guid.colAppliesTo')}</th>
                  <th className="app-list-header">{t('intel.sem.colStatus')}</th>
                  <th className="app-list-header text-right">{t('intel.sem.colActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                {rules.map((r) => (
                  <tr key={r.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setRuleModal(r)}>
                    <td className="app-list-cell">
                      <span className="block text-caption font-emphasis text-text-primary">{r.name}</span>
                      <span className="block text-tiny text-text-tertiary">
                        {t('intel.guid.if')} {r.condition_text} → {r.conclusion_text}
                      </span>
                    </td>
                    <td className="app-list-cell text-tiny text-text-tertiary">{r.exceptions_text || '—'}</td>
                    <td className="app-list-cell">
                      <span className="flex flex-wrap gap-1">
                        {r.applies_to.slice(0, 3).map((a, i) => (
                          <Badge key={i} variant="brand" size="xs">{a.label || a.ref}</Badge>
                        ))}
                        {r.applies_to.length === 0 && <span className="text-tiny text-text-quaternary">—</span>}
                      </span>
                    </td>
                    <td className="app-list-cell"><StatusBadge status={r.status} /></td>
                    <td className="app-list-cell-tight text-right" onClick={(e) => e.stopPropagation()}>
                      {r.status !== 'Approved' && (
                        <Button size="xs" variant="secondary" leadingIcon={<ShieldCheck className="h-3 w-3" />} onClick={() => certify('rule', r.id, r.name)}>
                          {t('intel.sem.certify')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rules.length === 0 && <div className="p-8"><EmptyHint>{t('intel.guid.emptyRules')}</EmptyHint></div>}
          </div>
          <p className="mt-2 text-tiny text-text-quaternary">{t('intel.guid.rulesNote')}</p>
        </div>
      )}

      {tab === 'qa' && (
        <div className="grid grid-cols-1 gap-3 pb-8 md:grid-cols-2 xl:grid-cols-3">
          {qa.map((x) => (
            <Panel
              key={x.id}
              title={x.question}
              action={<StatusBadge status={x.status} />}
              className="cursor-pointer transition-[border-color,box-shadow] hover:border-[rgb(var(--border-strong))] hover:shadow-linear"
            >
              <div onClick={() => setQaModal(x)}>
                <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-caption text-text-secondary">
                  {x.answer_md.length > 180 ? `${x.answer_md.slice(0, 180)}…` : x.answer_md}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {x.trigger_phrases.slice(0, 4).map((p, i) => (
                    <span key={i} className="rounded border border-[rgb(var(--border-line))] bg-surface-2 px-1.5 py-0.5 text-tiny text-text-tertiary">{p}</span>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1.5 border-t border-[rgb(var(--border-line))] pt-2.5">
                {x.status !== 'Approved' && (
                  <Button size="xs" variant="secondary" leadingIcon={<ShieldCheck className="h-3 w-3" />} onClick={() => certify('qa', x.id, x.question)}>
                    {t('intel.sem.certify')}
                  </Button>
                )}
                {canAuthor && <Button size="xs" variant="ghost" onClick={() => setQaModal(x)}>{t('intel.common.edit')}</Button>}
                <span className="ml-auto inline-flex items-center gap-2 text-tiny text-text-quaternary">
                  {x.as_test && <Badge variant="info" size="xs">{t('intel.guid.asTest')}</Badge>}
                  {t('intel.guid.used')} {x.use_count}×
                </span>
              </div>
            </Panel>
          ))}
          {qa.length === 0 && <div className="md:col-span-2 xl:col-span-3"><EmptyHint>{t('intel.guid.emptyQA')}</EmptyHint></div>}
        </div>
      )}

      {tab === 'scope' && <ScopeTab />}

      {tab === 'instructions' && (
        <InstructionsTab instructions={instructions} onSaved={reload} />
      )}

      {pbModal !== null && (
        <PlaybookModal
          playbook={pbModal === 'new' ? null : pbModal}
          metrics={metrics}
          onClose={() => setPbModal(null)}
          onSaved={() => { setPbModal(null); reload(); }}
          onDelete={pbModal !== 'new' ? async () => {
            await deletePlaybook((pbModal as GovernPlaybook).id); setPbModal(null); toast.success(t('intel.common.deleted')); reload();
          } : undefined}
        />
      )}
      {ruleModal !== null && (
        <RuleModal
          rule={ruleModal === 'new' ? null : ruleModal}
          metrics={metrics}
          onClose={() => setRuleModal(null)}
          onSaved={() => { setRuleModal(null); reload(); }}
          onDelete={ruleModal !== 'new' ? async () => {
            await deleteRule((ruleModal as GovernRule).id); setRuleModal(null); toast.success(t('intel.common.deleted')); reload();
          } : undefined}
        />
      )}
      {qaModal !== null && (
        <QAModal
          qa={qaModal === 'new' ? null : qaModal}
          onClose={() => setQaModal(null)}
          onSaved={() => { setQaModal(null); reload(); }}
          onDelete={qaModal !== 'new' ? async () => {
            await deleteQA((qaModal as GovernQA).id); setQaModal(null); toast.success(t('intel.common.deleted')); reload();
          } : undefined}
        />
      )}
    </PageListLayout>
  );
}

// ── Playbook modal ───────────────────────────────────────────────────────────
function PlaybookModal({ playbook, metrics, onClose, onSaved, onDelete }: {
  playbook: GovernPlaybook | null;
  metrics: ManagedMetric[];
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(playbook?.name ?? '');
  const [trigger, setTrigger] = useState(playbook?.trigger_text ?? '');
  const [steps, setSteps] = useState((playbook?.steps ?? []).join('\n'));
  const [dims, setDims] = useState((playbook?.dim_priority ?? []).join(', '));
  const [output, setOutput] = useState(playbook?.expected_output ?? '');
  const [linked, setLinked] = useState<string[]>(playbook?.linked_metrics ?? []);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await upsertPlaybook({
        id: playbook?.id,
        name, trigger_text: trigger,
        steps: steps.split('\n').map((s) => s.trim()).filter(Boolean),
        dim_priority: dims.split(',').map((s) => s.trim()).filter(Boolean),
        expected_output: output || null,
        linked_metrics: linked,
      });
      toast.success(t('intel.common.saved'));
      onSaved();
    } catch (err) {
      toast.error(extractApiError(err, t('intel.common.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppModalShell
      onClose={onClose}
      title={playbook ? t('intel.guid.editPlaybook') : t('intel.guid.newPlaybook')}
      description={t('intel.guid.playbookModalDesc')}
      icon={<BookMarked className="h-4 w-4" />}
      maxWidthClass="max-w-2xl"
      footer={(
        <>
          {onDelete && (
            <Button variant="ghost" size="sm" className="mr-auto text-danger hover:text-danger" leadingIcon={<Trash2 className="h-3 w-3" />} onClick={onDelete}>
              {t('intel.common.delete')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>{t('intel.common.cancel')}</Button>
          <Button variant="primary" size="sm" loading={saving} disabled={!name.trim() || !trigger.trim() || !steps.trim()} onClick={save}>
            {t('intel.common.save')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <div className="flex flex-col gap-1.5">
          <Label required>{t('intel.guid.pbName')}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('intel.guid.pbNamePh')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label required>{t('intel.guid.trigger')}</Label>
          <Input value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder={t('intel.guid.triggerPh')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label required>{t('intel.guid.steps')}</Label>
          <Textarea rows={5} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={t('intel.guid.stepsPh')} />
          <p className="text-tiny text-text-quaternary">{t('intel.guid.stepsHelp')}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t('intel.guid.dims')}</Label>
            <Input value={dims} onChange={(e) => setDims(e.target.value)} placeholder="customer_state, product_category" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t('intel.guid.output')}</Label>
            <Input value={output} onChange={(e) => setOutput(e.target.value)} placeholder={t('intel.guid.outputPh')} />
          </div>
        </div>
        <MetricPicker metrics={metrics} value={linked} onChange={setLinked} label={t('intel.guid.linkedMetrics')} help={t('intel.guid.linkedMetricsHelp')} />
      </div>
    </AppModalShell>
  );
}

// ── Rule modal ───────────────────────────────────────────────────────────────
function RuleModal({ rule, metrics, onClose, onSaved, onDelete }: {
  rule: GovernRule | null;
  metrics: ManagedMetric[];
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(rule?.name ?? '');
  const [condition, setCondition] = useState(rule?.condition_text ?? '');
  const [conclusion, setConclusion] = useState(rule?.conclusion_text ?? '');
  const [exceptions, setExceptions] = useState(rule?.exceptions_text ?? '');
  const [applies, setApplies] = useState<string[]>((rule?.applies_to ?? []).map((a) => a.ref));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const byRef = new Map(metrics.map((m) => [m.machine_name, m.name]));
      await upsertRule({
        id: rule?.id,
        name, condition_text: condition, conclusion_text: conclusion,
        exceptions_text: exceptions || null,
        applies_to: applies.map((ref) => ({ kind: 'metric', ref, label: byRef.get(ref) ?? ref })),
      });
      toast.success(t('intel.common.saved'));
      onSaved();
    } catch (err) {
      toast.error(extractApiError(err, t('intel.common.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppModalShell
      onClose={onClose}
      title={rule ? t('intel.guid.editRule') : t('intel.guid.newRule')}
      description={t('intel.guid.ruleModalDesc')}
      icon={<Scale className="h-4 w-4" />}
      maxWidthClass="max-w-xl"
      footer={(
        <>
          {onDelete && (
            <Button variant="ghost" size="sm" className="mr-auto text-danger hover:text-danger" leadingIcon={<Trash2 className="h-3 w-3" />} onClick={onDelete}>
              {t('intel.common.delete')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>{t('intel.common.cancel')}</Button>
          <Button variant="primary" size="sm" loading={saving} disabled={!name.trim() || !condition.trim() || !conclusion.trim()} onClick={save}>
            {t('intel.common.save')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <div className="flex flex-col gap-1.5">
          <Label required>{t('intel.guid.ruleName')}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('intel.guid.ruleNamePh')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label required>{t('intel.guid.condition')}</Label>
          <Input value={condition} onChange={(e) => setCondition(e.target.value)} placeholder={t('intel.guid.conditionPh')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label required>{t('intel.guid.conclusion')}</Label>
          <Input value={conclusion} onChange={(e) => setConclusion(e.target.value)} placeholder={t('intel.guid.conclusionPh')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('intel.guid.exceptions')}</Label>
          <Input value={exceptions} onChange={(e) => setExceptions(e.target.value)} placeholder={t('intel.guid.exceptionsPh')} />
        </div>
        <MetricPicker metrics={metrics} value={applies} onChange={setApplies} label={t('intel.guid.colAppliesTo')} help={t('intel.guid.appliesToHelp')} />
      </div>
    </AppModalShell>
  );
}

// ── QA modal ─────────────────────────────────────────────────────────────────
function QAModal({ qa, onClose, onSaved, onDelete }: {
  qa: GovernQA | null;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [question, setQuestion] = useState(qa?.question ?? '');
  const [phrases, setPhrases] = useState((qa?.trigger_phrases ?? []).join('\n'));
  const [answer, setAnswer] = useState(qa?.answer_md ?? '');
  const [chartId, setChartId] = useState(qa?.chart_id ? String(qa.chart_id) : '');
  const [dashboardId, setDashboardId] = useState(qa?.dashboard_id ? String(qa.dashboard_id) : '');
  const [asTest, setAsTest] = useState(qa?.as_test ?? true);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await upsertQA({
        id: qa?.id,
        question,
        trigger_phrases: phrases.split('\n').map((s) => s.trim()).filter(Boolean),
        answer_md: answer,
        chart_id: chartId ? Number(chartId) : null,
        dashboard_id: dashboardId ? Number(dashboardId) : null,
        as_test: asTest,
      });
      toast.success(t('intel.common.saved'));
      onSaved();
    } catch (err) {
      toast.error(extractApiError(err, t('intel.common.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppModalShell
      onClose={onClose}
      title={qa ? t('intel.guid.editQA') : t('intel.guid.newQA')}
      description={t('intel.guid.qaModalDesc')}
      icon={<MessageSquareQuote className="h-4 w-4" />}
      maxWidthClass="max-w-xl"
      footer={(
        <>
          {onDelete && (
            <Button variant="ghost" size="sm" className="mr-auto text-danger hover:text-danger" leadingIcon={<Trash2 className="h-3 w-3" />} onClick={onDelete}>
              {t('intel.common.delete')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>{t('intel.common.cancel')}</Button>
          <Button variant="primary" size="sm" loading={saving} disabled={!question.trim() || !answer.trim()} onClick={save}>
            {t('intel.common.save')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <div className="flex flex-col gap-1.5">
          <Label required>{t('intel.guid.qaQuestion')}</Label>
          <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t('intel.guid.qaQuestionPh')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('intel.guid.qaPhrases')}</Label>
          <Textarea rows={3} value={phrases} onChange={(e) => setPhrases(e.target.value)} placeholder={t('intel.guid.qaPhrasesPh')} />
          <p className="text-tiny text-text-quaternary">{t('intel.guid.qaPhrasesHelp')}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label required>{t('intel.guid.qaAnswer')}</Label>
          <Textarea rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('intel.guid.qaAnswerPh')} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t('intel.guid.qaChart')}</Label>
            <Input type="number" value={chartId} onChange={(e) => setChartId(e.target.value)} placeholder="ID" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t('intel.guid.qaDashboard')}</Label>
            <Input type="number" value={dashboardId} onChange={(e) => setDashboardId(e.target.value)} placeholder={t('intel.guid.qaDashboardPh')} />
          </div>
          <label className="mt-6 inline-flex items-center gap-2 text-caption text-text-secondary">
            <input type="checkbox" className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))]" checked={asTest} onChange={(e) => setAsTest(e.target.checked)} />
            {t('intel.guid.asTest')}
          </label>
        </div>
      </div>
    </AppModalShell>
  );
}

// ── Metric multi-picker (chips + datalist) ───────────────────────────────────
function MetricPicker({ metrics, value, onChange, label, help }: {
  metrics: ManagedMetric[];
  value: string[];
  onChange: (v: string[]) => void;
  label: string;
  help?: string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const options = useMemo(() => metrics.filter((m) => !value.includes(m.machine_name)), [metrics, value]);
  const add = (ref: string) => {
    const m = metrics.find((x) => x.machine_name === ref || x.name === ref);
    if (m && !value.includes(m.machine_name)) onChange([...value, m.machine_name]);
    setDraft('');
  };
  const byRef = new Map(metrics.map((m) => [m.machine_name, m.name]));
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5">
        {value.map((ref) => (
          <span key={ref} className="inline-flex items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-tiny text-brand">
            {byRef.get(ref) ?? ref}
            <button type="button" className="text-brand/70 hover:text-brand" onClick={() => onChange(value.filter((v) => v !== ref))}>×</button>
          </span>
        ))}
        <input
          className="min-w-[140px] flex-1 bg-transparent text-caption text-text-primary outline-none placeholder:text-text-quaternary"
          list="intel-metric-options"
          value={draft}
          placeholder={t('intel.guid.pickMetric')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }}
          onBlur={() => draft && add(draft)}
        />
        <datalist id="intel-metric-options">
          {options.map((m) => <option key={m.machine_name} value={m.machine_name}>{m.name}</option>)}
        </datalist>
      </div>
      {help && <p className="text-tiny text-text-quaternary">{help}</p>}
    </div>
  );
}

// ── AI data scope tab ────────────────────────────────────────────────────────
function ScopeTab() {
  const { t } = useI18n();
  const [datasets, setDatasets] = useState<DatasetLite[]>([]);
  const [datasetId, setDatasetId] = useState<number | null>(null);
  const [scope, setScope] = useState<AIScope | null>(null);
  const [exCols, setExCols] = useState<Set<string>>(new Set());
  const [exMeasures, setExMeasures] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listDatasetsLite().then((ds) => {
      setDatasets(ds);
      if (ds.length > 0) setDatasetId(ds[0].id);
    }).catch(() => setDatasets([]));
  }, []);

  useEffect(() => {
    if (datasetId == null) return;
    getAIScope(datasetId).then((s) => {
      setScope(s);
      setExCols(new Set(s.excluded_columns));
      setExMeasures(new Set(s.excluded_measures));
    }).catch(() => setScope(null));
  }, [datasetId]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, name: string) => {
    const next = new Set(set);
    if (next.has(name)) next.delete(name); else next.add(name);
    setter(next);
  };

  const save = async () => {
    if (datasetId == null) return;
    setSaving(true);
    try {
      await putAIScope(datasetId, { excluded_columns: [...exCols], excluded_measures: [...exMeasures] });
      toast.success(t('intel.guid.scopeSaved'), { description: t('intel.guid.scopeSavedDesc') });
    } catch (err) {
      toast.error(extractApiError(err, t('intel.common.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const fields = scope?.fields;
  return (
    <div className="max-w-3xl space-y-3 pb-8">
      <Panel title={t('intel.guid.scopeTitle')} sub={t('intel.guid.scopeSub')}>
        <div className="mb-3 flex items-center gap-2">
          <select
            className="h-8 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2.5 text-caption text-text-primary outline-none focus:border-brand"
            value={datasetId ?? ''}
            onChange={(e) => setDatasetId(Number(e.target.value))}
          >
            {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <Badge variant="brand" size="xs">
            {fields ? `${(fields.measures.length - exMeasures.size)}/${fields.measures.length} ${t('intel.guid.scopeMeasures')} · ${(fields.columns.length - exCols.size)}/${fields.columns.length} ${t('intel.guid.scopeColumns')}` : '—'}
          </Badge>
          <Button size="sm" variant="primary" className="ml-auto" loading={saving} onClick={save} leadingIcon={<CheckCircle2 className="h-3.5 w-3.5" />}>
            {t('intel.common.save')}
          </Button>
        </div>
        {fields && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1.5 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">{t('intel.guid.scopeMeasures')}</p>
              <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-[rgb(var(--border-line))] p-2">
                {fields.measures.map((m) => (
                  <label key={m.name} className="flex items-center gap-2 rounded px-1.5 py-1 text-caption text-text-secondary hover:bg-surface-2">
                    <input type="checkbox" className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))]" checked={!exMeasures.has(m.name)} onChange={() => toggle(exMeasures, setExMeasures, m.name)} />
                    <span className="min-w-0 flex-1 truncate">{m.label}</span>
                    <span className="text-tiny text-text-quaternary">{m.kind}</span>
                  </label>
                ))}
                {fields.measures.length === 0 && <p className="px-1.5 py-2 text-tiny text-text-quaternary">{t('intel.guid.scopeNoFields')}</p>}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">{t('intel.guid.scopeColumns')}</p>
              <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-[rgb(var(--border-line))] p-2">
                {fields.columns.map((c) => (
                  <label key={c.name} className="flex items-center gap-2 rounded px-1.5 py-1 text-caption text-text-secondary hover:bg-surface-2">
                    <input type="checkbox" className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))]" checked={!exCols.has(c.name)} onChange={() => toggle(exCols, setExCols, c.name)} />
                    <span className="min-w-0 flex-1 truncate font-mono text-tiny">{c.name}</span>
                  </label>
                ))}
                {fields.columns.length === 0 && <p className="px-1.5 py-2 text-tiny text-text-quaternary">{t('intel.guid.scopeNoFields')}</p>}
              </div>
            </div>
          </div>
        )}
        <p className="mt-3 text-tiny text-text-quaternary">{t('intel.guid.scopeNote')}</p>
      </Panel>
    </div>
  );
}

// ── AI instructions tab ──────────────────────────────────────────────────────
function InstructionsTab({ instructions, onSaved }: {
  instructions: GovernInstruction[];
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [scope, setScope] = useState<'global' | 'dataset' | 'dashboard'>('global');
  const [scopeId, setScopeId] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const active = instructions.filter((i) => i.status === 'active');
  const archived = instructions.filter((i) => i.status === 'archived');

  const save = async () => {
    setSaving(true);
    try {
      await createInstructionVersion({
        scope,
        scope_id: scope === 'global' ? null : Number(scopeId) || null,
        content_md: content,
      });
      toast.success(t('intel.guid.instrSaved'), { description: t('intel.guid.instrSavedDesc') });
      setContent('');
      onSaved();
    } catch (err) {
      toast.error(extractApiError(err, t('intel.common.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const scopeLabel = (i: GovernInstruction) =>
    i.scope === 'global' ? t('intel.guid.scopeGlobal') : `${i.scope === 'dataset' ? t('intel.sem.dataset') : 'Dashboard'} #${i.scope_id}`;

  return (
    <div className="grid grid-cols-1 gap-3 pb-8 lg:grid-cols-2">
      <div className="space-y-3">
        {active.map((i) => (
          <Panel
            key={i.id}
            title={(
              <span className="inline-flex items-center gap-2">
                {scopeLabel(i)}
                <Badge variant="success" size="xs">v{i.version} · {t('intel.guid.instrActive')}</Badge>
              </span>
            )}
            sub={i.created_by ? `${i.created_by}` : undefined}
          >
            <pre className="whitespace-pre-wrap font-sans text-caption leading-relaxed text-text-secondary">{i.content_md}</pre>
          </Panel>
        ))}
        {active.length === 0 && <EmptyHint>{t('intel.guid.emptyInstr')}</EmptyHint>}
        {archived.length > 0 && (
          <Panel title={t('intel.guid.instrHistory')}>
            <div className="space-y-1">
              {archived.slice(0, 8).map((i) => (
                <div key={i.id} className="flex items-center gap-2 border-t border-[rgb(var(--border-line))] py-1.5 text-tiny text-text-tertiary first:border-t-0">
                  <span className="font-mono">{(i.created_at ?? '').slice(0, 10)}</span>
                  <span className="text-text-secondary">{scopeLabel(i)} · v{i.version}</span>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
      <Panel title={t('intel.guid.instrNew')} sub={t('intel.guid.instrNewSub')}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>{t('intel.guid.instrScope')}</Label>
              <select
                className="h-9 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-3 text-caption text-text-primary outline-none focus:border-brand"
                value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}
              >
                <option value="global">{t('intel.guid.scopeGlobal')}</option>
                <option value="dataset">{t('intel.sem.dataset')}</option>
                <option value="dashboard">Dashboard</option>
              </select>
            </div>
            {scope !== 'global' && (
              <div className="flex flex-col gap-1.5">
                <Label>ID</Label>
                <Input type="number" value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder={scope === 'dataset' ? 'dataset_id' : 'dashboard_id'} />
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label required>{t('intel.guid.instrContent')}</Label>
            <Textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)} placeholder={t('intel.guid.instrContentPh')} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-tiny text-text-quaternary">{t('intel.guid.instrNote')}</p>
            <Button variant="primary" size="sm" loading={saving} disabled={!content.trim() || (scope !== 'global' && !scopeId)} onClick={save}>
              {t('intel.guid.instrPublish')}
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
