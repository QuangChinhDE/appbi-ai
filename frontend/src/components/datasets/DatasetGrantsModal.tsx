'use client';

/**
 * Dataset access modal — Power BI-style capability sets on a single dataset.
 * Lists the viewer's own capabilities, the explicit grants, and (for RESHARE/
 * MANAGE holders) lets them grant/revoke a verb to a user.
 *
 * Verbs are CAPABILITY SETS, not a ladder: build ⊃ {view,explore,build};
 * edit ⊃ {view,explore,edit}; edit does NOT imply build or reshare. This mirrors
 * the backend dataset_grants_service so the UI never implies a false hierarchy.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trash2, ShieldCheck } from 'lucide-react';
import { AppModalShell } from '@/components/common/AppModalShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { toast } from '@/lib/toast';
import { usersApi } from '@/lib/api-client';
import { useI18n } from '@/providers/LanguageProvider';
import {
  useDatasetGrants,
  useSetDatasetGrant,
  useRevokeDatasetGrant,
  type DatasetVerb,
} from '@/hooks/use-datasets';

/** Minimal shape from /users we need for the grant picker (structural subset). */
interface GrantUser {
  id: string;
  email: string;
  full_name: string;
}

const VERBS: DatasetVerb[] = ['view', 'explore', 'build', 'reshare', 'edit', 'manage'];
const VERB_LABEL: Record<DatasetVerb, string> = {
  view: 'datasets.grants.verbView',
  explore: 'datasets.grants.verbExplore',
  build: 'datasets.grants.verbBuild',
  reshare: 'datasets.grants.verbReshare',
  edit: 'datasets.grants.verbEdit',
  manage: 'datasets.grants.verbManage',
};
const VERB_DESC: Record<DatasetVerb, string> = {
  view: 'datasets.grants.verbViewDesc',
  explore: 'datasets.grants.verbExploreDesc',
  build: 'datasets.grants.verbBuildDesc',
  reshare: 'datasets.grants.verbReshareDesc',
  edit: 'datasets.grants.verbEditDesc',
  manage: 'datasets.grants.verbManageDesc',
};

export function DatasetGrantsModal({ datasetId, onClose }: { datasetId: number; onClose: () => void }) {
  const { t } = useI18n();
  const { data: grantsData } = useDatasetGrants(datasetId);
  const { data: users = [] } = useQuery<GrantUser[]>({ queryKey: ['users'], queryFn: usersApi.getAll });
  const setGrant = useSetDatasetGrant();
  const revokeGrant = useRevokeDatasetGrant();

  const [userId, setUserId] = useState('');
  const [verb, setVerb] = useState<DatasetVerb>('view');

  const canReshare = (grantsData?.my_capabilities ?? []).some((v) => v === 'reshare' || v === 'manage');

  const userById = useMemo(() => {
    const m = new Map<string, GrantUser>();
    users.forEach((u) => m.set(u.id, u));
    return m;
  }, [users]);

  const grants = grantsData?.grants ?? [];

  const onGrant = async () => {
    if (!userId) return;
    try {
      await setGrant.mutateAsync({ datasetId, verb, userId });
      toast.success(t('datasets.grants.toastGranted'));
      setUserId('');
    } catch (e: any) {
      toast.error(t('datasets.grants.toastError'), { description: e?.response?.data?.detail ?? e?.message });
    }
  };

  const onRevoke = async (uid: string | null, tid: string | null) => {
    try {
      await revokeGrant.mutateAsync({ datasetId, userId: uid ?? undefined, teamId: tid ?? undefined });
      toast.success(t('datasets.grants.toastRevoked'));
    } catch (e: any) {
      toast.error(t('datasets.grants.toastError'), { description: e?.response?.data?.detail ?? e?.message });
    }
  };

  return (
    <AppModalShell
      onClose={onClose}
      title={t('datasets.grants.title')}
      description={t('datasets.grants.subtitle')}
      icon={<ShieldCheck className="h-4 w-4" />}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-5">
        {/* My capabilities */}
        <div>
          <div className="mb-1.5 text-tiny font-emphasis uppercase tracking-wide text-text-tertiary">
            {t('datasets.grants.myCapabilities')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(grantsData?.my_capabilities ?? []).map((v) => (
              <Badge key={v} variant="brand" size="sm">{t(VERB_LABEL[v])}</Badge>
            ))}
          </div>
        </div>

        {/* Add grant (reshare/manage only) */}
        {canReshare && (
          <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
            <div className="mb-2 text-tiny font-emphasis uppercase tracking-wide text-text-tertiary">
              {t('datasets.grants.addGrant')}
            </div>
            <div className="flex items-end gap-2">
              <label className="flex-1 min-w-0">
                <span className="mb-1 block text-tiny text-text-tertiary">{t('datasets.grants.selectUser')}</span>
                <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">{t('datasets.grants.selectUser')}</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.full_name || u.email} · {u.email}</option>
                  ))}
                </Select>
              </label>
              <label className="w-32 shrink-0">
                <span className="mb-1 block text-tiny text-text-tertiary">{t('datasets.grants.selectVerb')}</span>
                <Select value={verb} onChange={(e) => setVerb(e.target.value as DatasetVerb)}>
                  {VERBS.map((v) => (
                    <option key={v} value={v}>{t(VERB_LABEL[v])}</option>
                  ))}
                </Select>
              </label>
              <Button size="sm" variant="primary" disabled={!userId || setGrant.isPending} onClick={onGrant}>
                {t('datasets.grants.grant')}
              </Button>
            </div>
            <p className="mt-1.5 text-tiny text-text-quaternary">{t(VERB_DESC[verb])}</p>
          </div>
        )}

        {/* Current grants */}
        <div>
          <div className="mb-1.5 text-tiny font-emphasis uppercase tracking-wide text-text-tertiary">
            {t('datasets.grants.currentGrants')}
          </div>
          {grants.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-3 py-4 text-center text-tiny text-text-tertiary">
              {t('datasets.grants.noGrants')}
            </p>
          ) : (
            <ul className="divide-y divide-[rgb(var(--border-line))] rounded-lg border border-[rgb(var(--border-line))]">
              {grants.map((g) => {
                const u = g.user_id ? userById.get(g.user_id) : null;
                const who = u ? (u.full_name || u.email) : g.team_id ? `Team ${g.team_id}` : g.user_id ?? '—';
                return (
                  <li key={g.id} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-caption text-text-primary">{who}</p>
                      {u?.email && <p className="truncate text-tiny text-text-quaternary">{u.email}</p>}
                    </div>
                    <Badge variant="neutral" size="sm">{t(VERB_LABEL[g.verb])}</Badge>
                    {canReshare && (
                      <button
                        className="p-1 text-text-quaternary hover:text-danger"
                        title={t('datasets.grants.revoke')}
                        onClick={() => onRevoke(g.user_id, g.team_id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </AppModalShell>
  );
}
