'use client';

/**
 * Who changed what, and how to get an old version back.
 *
 * The change summaries are DIFFED SERVER-SIDE from the node trees, not written by
 * whoever saved. "Flow changed" on every row is the same as having no activity feed
 * at all.
 *
 * Two different buttons that are easy to confuse, kept apart on purpose:
 *   Nạp lại   loads an old version onto the canvas. Nothing live changes.
 *   Quay lại  re-publishes the previous version. Every viewer sees it immediately.
 */
import React from 'react';

import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  brainActivity, listVersions, restoreToDraft, rollbackBrain,
  type ActivityEvent, type BrainVersionRow,
} from '@/lib/agentFlows';
import { formatWhen, StatusBadge } from './shared';

const ACTION_LABEL: Record<string, string> = {
  agent_flow_saved: 'Sửa flow',
  agent_flow_published: 'Phát hành',
  agent_flow_rolled_back: 'Quay lại bản cũ',
  agent_flow_restored: 'Nạp bản cũ vào nháp',
  agent_flow_deleted: 'Xoá phiên bản',
  agent_flow_assigned: 'Gán vào link',
  agent_flow_unassigned: 'Gỡ khỏi link',
};

const ACTION_TONE: Record<string, 'success' | 'brand' | 'warning' | 'neutral'> = {
  agent_flow_published: 'success',
  agent_flow_assigned: 'success',
  agent_flow_rolled_back: 'warning',
  agent_flow_unassigned: 'warning',
  agent_flow_deleted: 'warning',
};

export function ActivityTab({
  brainKey, onReloaded,
}: { brainKey: string; onReloaded: () => void }) {
  const [events, setEvents] = React.useState<ActivityEvent[]>([]);
  const [versions, setVersions] = React.useState<BrainVersionRow[]>([]);
  const [busy, setBusy] = React.useState('');

  const load = React.useCallback(() => {
    Promise.all([brainActivity(brainKey), listVersions(brainKey)])
      .then(([e, v]) => { setEvents(e); setVersions(v); });
  }, [brainKey]);

  React.useEffect(load, [load]);

  const restore = async (version: number) => {
    setBusy(`restore-${version}`);
    try {
      await restoreToDraft(brainKey, version);
      load();
      onReloaded();
    } finally { setBusy(''); }
  };

  const rollback = async () => {
    setBusy('rollback');
    try {
      await rollbackBrain(brainKey);
      load();
      onReloaded();
    } finally { setBusy(''); }
  };

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto grid max-w-[1400px] gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(300px,0.65fr)]">
        <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
          <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-2/30 px-3 py-2.5">
            <b className="text-caption font-strong">Lịch sử hoạt động</b>
            <span className="text-tiny text-text-tertiary">Ai đã thay đổi gì</span>
          </div>
          {events.map((e, i) => (
            <div key={i}
              className="grid grid-cols-[130px_190px_130px_1fr_60px] items-center gap-2 border-t border-[rgb(var(--border-line))] px-3 py-2.5 text-tiny first:border-t-0">
              <span className="text-text-quaternary">{formatWhen(e.at)}</span>
              <span className="truncate text-text-secondary">{e.actor || '—'}</span>
              <span>
                <Badge size="xs" variant={ACTION_TONE[e.action] || 'brand'}>
                  {ACTION_LABEL[e.action] || e.action}
                </Badge>
              </span>
              <span className="truncate text-text-secondary">{e.summary || '—'}</span>
              <span className="text-right text-text-quaternary">
                {e.version != null ? `v${e.version}` : ''}
              </span>
            </div>
          ))}
          {!events.length && (
            <p className="p-8 text-center text-caption text-text-tertiary">Chưa có hoạt động nào.</p>
          )}
        </div>

        <aside className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
          <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-2/30 px-3 py-2.5">
            <b className="text-caption font-strong">Phiên bản</b>
            <div className="flex-1" />
            <Button variant="secondary" size="xs" onClick={rollback} loading={busy === 'rollback'}>
              Quay lại bản trước
            </Button>
          </div>
          <div className="p-2.5">
            {versions.map((v) => (
              <div key={v.version}
                className="flex items-start gap-2 border-t border-[rgb(var(--border-line))] py-2.5 first:border-t-0">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-surface-2 text-caption font-strong">
                  v{v.version}
                </span>
                <div className="min-w-0 flex-1">
                  <b className="block text-caption font-medium">{v.name || `Phiên bản ${v.version}`}</b>
                  <span className="mt-px block text-tiny text-text-tertiary">
                    {v.created_by || '—'} · {formatWhen(v.published_at || v.updated_at)}
                  </span>
                </div>
                <div className="flex flex-shrink-0 flex-col items-end gap-1">
                  <StatusBadge status={v.status} size="xs" />
                  {v.status !== 'draft' && (
                    <Button
                      variant="ghost" size="xs"
                      loading={busy === `restore-${v.version}`}
                      onClick={() => restore(v.version)}
                      title="Nạp bản này vào nháp đang mở — không đổi gì đang chạy."
                    >
                      Nạp lại
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
