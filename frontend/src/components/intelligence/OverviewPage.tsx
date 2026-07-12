'use client';

/**
 * Sẵn sàng AI — cockpit of the Intelligence group.
 * One glance answers: how healthy is the knowledge, what is the AI actually
 * using (provenance), what needs attention — and every approval routes to the
 * single review ledger (Đề xuất AI).
 */
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowRight, Inbox, Network, LayoutGrid, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PageListLayout } from '@/components/common/PageListLayout';
import { GlobalGraph } from '@/components/govern/KnowledgeTab';
import { Panel, EmptyHint, CoverageBar } from '@/components/intelligence/shared';
import { intelligenceOverview, createReviewItem, type IntelligenceOverview } from '@/lib/catalog';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';

const COVERAGE_ROWS: { key: string; labelKey: string; href: string }[] = [
  { key: 'metrics', labelKey: 'intel.type.metrics', href: '/semantics' },
  { key: 'terms', labelKey: 'intel.type.terms', href: '/govern' },
  { key: 'rules', labelKey: 'intel.type.rules', href: '/ai-guidance?tab=rules' },
  { key: 'playbooks', labelKey: 'intel.type.playbooks', href: '/ai-guidance' },
  { key: 'qa', labelKey: 'intel.type.qa', href: '/ai-guidance?tab=qa' },
  { key: 'docs', labelKey: 'intel.type.docs', href: '/govern' },
];

const KIND_LABEL_KEY: Record<string, string> = {
  metric: 'intel.kind.metric', doc: 'intel.kind.doc', rule: 'intel.kind.rule',
  playbook: 'intel.kind.playbook', qa: 'intel.kind.qa', caveat: 'intel.kind.caveat',
  instruction: 'intel.kind.instruction', term: 'intel.kind.term',
};

export function IntelligenceOverviewPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [ov, setOv] = useState<IntelligenceOverview | null>(null);
  const [tab, setTab] = useState<'board' | 'graph'>('board');
  const [proposed, setProposed] = useState<Set<string>>(new Set());

  const reload = useCallback(() => {
    intelligenceOverview().then(setOv).catch(() => setOv(null));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const propose = async (question: string) => {
    try {
      await createReviewItem({
        entity_type: 'metric',
        action: 'suggest',
        title: `${t('intel.overview.defineFor')}: ${question}`,
        evidence: t('intel.overview.fromUngrounded'),
      });
      setProposed((s) => new Set(s).add(question));
      toast.success(t('intel.overview.proposalCreated'));
      reload();
    } catch {
      toast.error(t('intel.overview.proposalFailed'));
    }
  };

  return (
    <PageListLayout
      title={t('intel.overview.title')}
      description={t('intel.overview.desc')}
      searchable={false}
      viewToggle={false}
      action={(
        <Link href="/ai-inbox">
          <Button variant="secondary" leadingIcon={<Inbox className="h-3.5 w-3.5" />}>
            {t('intel.overview.openInbox')}{ov ? ` (${ov.pending_reviews})` : ''}
          </Button>
        </Link>
      )}
      overview={ov ? (
        <ModuleOverview stats={[
          { label: t('intel.overview.readiness'), value: `${ov.readiness}%`, helper: t('intel.overview.readinessHelp') },
          { label: t('intel.status.approved'), value: `${Object.values(ov.coverage).reduce((a, c) => a + c.approved, 0)}/${Object.values(ov.coverage).reduce((a, c) => a + c.total, 0)}` },
          { label: t('intel.overview.pending'), value: ov.pending_reviews },
          { label: t('intel.overview.flagged'), value: ov.flagged },
          { label: t('intel.overview.answers30d'), value: ov.answers_30d, helper: t('intel.overview.answers30dHelp') },
        ]} />
      ) : undefined}
      toolbarExtra={(
        <Tabs
          size="sm"
          value={tab}
          onChange={(k) => setTab(k)}
          items={[
            { key: 'board', label: t('intel.overview.tabBoard'), icon: <LayoutGrid className="h-3.5 w-3.5" /> },
            { key: 'graph', label: t('intel.overview.tabGraph'), icon: <Network className="h-3.5 w-3.5" /> },
          ]}
        />
      )}
    >
      {tab === 'graph' ? (
        <div className="pb-8">
          <GlobalGraph onOpen={(id) => router.push(`/govern?doc=${id}`)} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 pb-8 lg:grid-cols-2">
          {/* Coverage per knowledge type */}
          <Panel title={t('intel.overview.coverage')} sub={t('intel.overview.coverageSub')}>
            <div className="space-y-1.5">
              {COVERAGE_ROWS.map((row) => {
                const c = ov?.coverage?.[row.key];
                return (
                  <Link key={row.key} href={row.href} className="group flex items-center gap-3 rounded-md px-1 py-1 hover:bg-surface-2">
                    <span className="w-28 flex-shrink-0 text-caption font-emphasis text-text-primary group-hover:text-brand">{t(row.labelKey)}</span>
                    <CoverageBar approved={c?.approved ?? 0} total={c?.total ?? 0} />
                    <span className="w-14 flex-shrink-0 text-right font-mono text-tiny text-text-tertiary">
                      {c ? `${c.approved}/${c.total}` : '—'}
                    </span>
                  </Link>
                );
              })}
            </div>
            <p className="mt-3 text-tiny text-text-quaternary">{t('intel.overview.coverageNote')}</p>
          </Panel>

          {/* Provenance — what the AI is actually using */}
          <Panel
            title={(
              <span className="inline-flex items-center gap-1.5">
                <Badge variant="brand" size="xs"><Sparkles className="h-2.5 w-2.5" /> Provenance</Badge>
                {t('intel.overview.topUsed')}
              </span>
            )}
            sub={t('intel.overview.topUsedSub')}
          >
            {ov && ov.top_used.length > 0 ? (
              <div className="space-y-0.5">
                {ov.top_used.map((u) => (
                  <div key={`${u.kind}:${u.name}`} className="flex items-center gap-2 border-t border-[rgb(var(--border-line))] py-1.5 first:border-t-0">
                    <Badge variant="subtle" size="xs">{t(KIND_LABEL_KEY[u.kind] ?? 'intel.kind.other')}</Badge>
                    <span className="min-w-0 flex-1 truncate text-caption text-text-primary">{u.name}</span>
                    <span className="font-mono text-tiny font-emphasis text-brand">{u.count}×</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyHint>{t('intel.overview.topUsedEmpty')}</EmptyHint>
            )}
          </Panel>

          {/* Attention */}
          <Panel title={t('intel.overview.attention')} sub={t('intel.overview.attentionSub')}>
            <div className="space-y-0.5">
              {ov && ov.unbound_metrics.map((m) => (
                <Link key={m.id} href="/semantics" className="group flex items-start gap-2 border-t border-[rgb(var(--border-line))] py-2 first:border-t-0">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-danger" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-caption font-emphasis text-text-primary group-hover:text-brand">
                      {t('intel.overview.unboundMetric')}: {m.display_name}
                    </span>
                    <span className="block text-tiny text-text-tertiary">
                      {m.binding === 'unbound' ? t('intel.overview.unbound') : t('intel.overview.unresolved')} · {m.status}
                    </span>
                  </span>
                  <ArrowRight className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" />
                </Link>
              ))}
              {ov && ov.pending_reviews > 0 && (
                <Link href="/ai-inbox" className="group flex items-start gap-2 border-t border-[rgb(var(--border-line))] py-2 first:border-t-0">
                  <Inbox className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-brand" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-caption font-emphasis text-text-primary group-hover:text-brand">
                      {ov.pending_reviews} {t('intel.overview.pendingItems')}
                    </span>
                    <span className="block text-tiny text-text-tertiary">{t('intel.overview.pendingItemsSub')}</span>
                  </span>
                  <ArrowRight className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" />
                </Link>
              )}
              {ov && ov.unbound_metrics.length === 0 && ov.pending_reviews === 0 && (
                <EmptyHint>{t('intel.overview.attentionEmpty')}</EmptyHint>
              )}
            </div>
          </Panel>

          {/* Ungrounded questions → propose knowledge */}
          <Panel title={t('intel.overview.ungrounded')} sub={t('intel.overview.ungroundedSub')}>
            {ov && ov.ungrounded_questions.length > 0 ? (
              <div className="space-y-0.5">
                {ov.ungrounded_questions.map((q) => (
                  <div key={q} className="flex items-center gap-2 border-t border-[rgb(var(--border-line))] py-1.5 first:border-t-0">
                    <span className="min-w-0 flex-1 truncate text-caption text-text-secondary">“{q}”</span>
                    <Button size="xs" variant="secondary" disabled={proposed.has(q)} onClick={() => propose(q)}>
                      {proposed.has(q) ? t('intel.overview.proposed') : t('intel.overview.propose')}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyHint>{t('intel.overview.ungroundedEmpty')}</EmptyHint>
            )}
          </Panel>
        </div>
      )}
    </PageListLayout>
  );
}
