'use client';

/**
 * Đề xuất AI — THE single review ledger of the Intelligence group.
 * AI suggestions (with evidence + confidence), re-certifies after binding
 * drift, and flagged answers all land here; approving materializes the entity
 * (Approved) so the bot uses it from the next question.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Check, Inbox, X } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { FilterTag } from '@/components/ui/FilterTag';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PageListLayout } from '@/components/common/PageListLayout';
import { EmptyHint, timeAgo } from '@/components/intelligence/shared';
import {
  listReviewItems, approveReviewItem, rejectReviewItem, type ReviewItem,
} from '@/lib/catalog';
import { toast } from '@/lib/toast';
import { extractApiError } from '@/lib/api-errors';
import { useI18n } from '@/providers/LanguageProvider';

const TYPE_META: Record<string, { labelKey: string; variant: 'brand' | 'warning' | 'success' | 'info' | 'danger' | 'neutral' }> = {
  metric: { labelKey: 'intel.kind.metric', variant: 'brand' },
  term: { labelKey: 'intel.kind.term', variant: 'info' },
  rule: { labelKey: 'intel.kind.rule', variant: 'warning' },
  playbook: { labelKey: 'intel.kind.playbook', variant: 'success' },
  qa: { labelKey: 'intel.kind.qa', variant: 'brand' },
  caveat: { labelKey: 'intel.kind.caveat', variant: 'warning' },
  instruction: { labelKey: 'intel.kind.instruction', variant: 'neutral' },
  doc: { labelKey: 'intel.kind.doc', variant: 'neutral' },
};

const ACTION_LABEL_KEY: Record<string, string> = {
  suggest: 'intel.inbox.actSuggest',
  certify: 'intel.inbox.actCertify',
  recertify: 'intel.inbox.actRecertify',
  flag: 'intel.inbox.actFlag',
  retire: 'intel.inbox.actRetire',
};

export function InboxPage() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await listReviewItems({ status, entity_type: typeFilter ?? undefined });
      setItems(res.items);
      setPending(res.pending);
    } finally {
      setLoading(false);
    }
  }, [status, typeFilter]);
  useEffect(() => { reload(); }, [reload]);

  const act = async (item: ReviewItem, approve: boolean) => {
    setBusy(item.id);
    try {
      if (approve) {
        await approveReviewItem(item.id);
        toast.success(`${t('intel.inbox.approved')}: ${item.title}`, { description: t('intel.inbox.approvedDesc') });
      } else {
        await rejectReviewItem(item.id);
        toast.info(t('intel.inbox.rejected'));
      }
      reload();
    } catch (err) {
      toast.error(extractApiError(err, t('intel.inbox.actionFailed')));
    } finally {
      setBusy(null);
    }
  };

  const types = ['metric', 'term', 'rule', 'playbook', 'qa', 'caveat'];

  return (
    <PageListLayout
      title={t('intel.inbox.title')}
      description={t('intel.inbox.desc')}
      searchable={false}
      viewToggle={false}
      isLoading={loading}
      overview={(
        <ModuleOverview stats={[
          { label: t('intel.overview.pending'), value: pending },
          { label: t('intel.inbox.showing'), value: items.length },
        ]} />
      )}
      toolbarExtra={(
        <Tabs
          size="sm"
          value={status}
          onChange={(k) => setStatus(k)}
          items={[
            { key: 'pending', label: t('intel.inbox.tabPending') },
            { key: 'approved', label: t('intel.inbox.tabApproved') },
            { key: 'rejected', label: t('intel.inbox.tabRejected') },
          ]}
        />
      )}
      activeFilters={(
        <>
          <FilterTag tone="brand" active={typeFilter === null} onClick={() => setTypeFilter(null)}>
            {t('intel.inbox.all')}
          </FilterTag>
          {types.map((k) => (
            <FilterTag key={k} tone="neutral" active={typeFilter === k} onClick={() => setTypeFilter(typeFilter === k ? null : k)}>
              {t(TYPE_META[k]?.labelKey ?? k)}
            </FilterTag>
          ))}
        </>
      )}
    >
      <div className="space-y-2.5 pb-8">
        {items.map((item) => {
          const meta = TYPE_META[item.entity_type] ?? { labelKey: item.entity_type, variant: 'neutral' as const };
          return (
            <div key={item.id} className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={meta.variant} size="sm">{t(meta.labelKey)}</Badge>
                <Badge variant="outline" size="xs">{t(ACTION_LABEL_KEY[item.action] ?? item.action)}</Badge>
                <span className="min-w-0 flex-1 truncate text-caption font-strong text-text-primary">{item.title}</span>
                {typeof item.confidence === 'number' && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-1 w-16 overflow-hidden rounded-full bg-surface-3">
                      <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round(item.confidence * 100)}%` }} />
                    </span>
                    <span className="font-mono text-tiny text-text-tertiary">{Math.round(item.confidence * 100)}%</span>
                  </span>
                )}
              </div>
              {item.payload && Object.keys(item.payload).length > 0 && (
                <div className="mt-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                  {Object.entries(item.payload).slice(0, 6).map(([k, v]) => (
                    <p key={k} className="truncate text-tiny text-text-secondary">
                      <span className="font-mono text-text-quaternary">{k}:</span>{' '}
                      {typeof v === 'string' ? v : JSON.stringify(v)}
                    </p>
                  ))}
                </div>
              )}
              {item.evidence && (
                <p className="mt-2 text-tiny text-text-tertiary">🔎 {item.evidence}</p>
              )}
              <div className="mt-3 flex items-center gap-2 border-t border-[rgb(var(--border-line))] pt-2.5">
                {item.status === 'pending' ? (
                  <>
                    <Button size="xs" variant="primary" loading={busy === item.id} leadingIcon={<Check className="h-3 w-3" />} onClick={() => act(item, true)}>
                      {t('intel.inbox.approve')}
                    </Button>
                    <Button size="xs" variant="ghost" disabled={busy === item.id} leadingIcon={<X className="h-3 w-3" />} onClick={() => act(item, false)}>
                      {t('intel.inbox.reject')}
                    </Button>
                  </>
                ) : (
                  <Badge variant={item.status === 'approved' ? 'success' : 'danger'} size="xs">
                    {item.status === 'approved' ? `✓ ${t('intel.inbox.tabApproved')}` : `✕ ${t('intel.inbox.tabRejected')}`}
                    {item.resolved_by ? ` · ${item.resolved_by}` : ''}
                  </Badge>
                )}
                <span className="ml-auto text-tiny text-text-quaternary">
                  {item.source === 'ai' ? 'AI' : item.created_by || t('intel.inbox.srcUser')} · {timeAgo(item.created_at, locale)}
                </span>
              </div>
            </div>
          );
        })}
        {items.length === 0 && (
          <EmptyHint>
            <Inbox className="mx-auto mb-2 h-6 w-6 text-text-quaternary" />
            {status === 'pending' ? t('intel.inbox.emptyPending') : t('intel.inbox.emptyResolved')}
          </EmptyHint>
        )}
        <p className="text-center text-tiny text-text-quaternary">{t('intel.inbox.ledgerNote')}</p>
      </div>
    </PageListLayout>
  );
}
