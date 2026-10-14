'use client';

/**
 * Start a report from a dataset. The server enumerates chart candidates from
 * the dataset's semantic model, lets the model (or the rules) choose among them
 * by id, runs each choice and keeps only what returns data — so the new report
 * opens with real, bound charts and no typed figures.
 */
import React, { useState } from 'react';

import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input, Textarea } from '@/components/ui/Input';
import { dashboardApi } from '@/lib/api/dashboards';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';

export function ReportStarterModal({ datasets, onClose, onCreated }: {
  datasets: { id: number; name: string }[];
  onClose: () => void;
  onCreated: (dashboardId: number) => void;
}) {
  const { t } = useI18n();
  const [datasetId, setDatasetId] = useState<number | ''>('');
  const [goal, setGoal] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (datasetId === '' || busy) return;
    setBusy(true);
    try {
      const out = await dashboardApi.reportStarter({ dataset_id: datasetId, goal: goal.trim() || undefined, name: name.trim() || undefined });
      onCreated(out.dashboard_id);
    } catch (e: any) {
      toast.error(`${t('report.starter.failed')}: ${e?.response?.data?.detail ?? e?.message ?? ''}`);
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={busy ? () => undefined : onClose}
      title={t('report.starter.title')}
      size="md"
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('report.starter.cancel')}</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={datasetId === '' || busy} loading={busy} data-testid="report-starter-create">
            {t('report.starter.create')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <FieldGroup label={t('report.starter.dataset')} required>
          <select
            data-testid="report-starter-dataset"
            className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-sm"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">{t('report.starter.pickDataset')}</option>
            {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </FieldGroup>
        <FieldGroup label={t('report.starter.goal')}>
          <Textarea data-testid="report-starter-goal" rows={2} value={goal} placeholder={t('report.starter.goalHint')} onChange={(e) => setGoal(e.target.value)} />
        </FieldGroup>
        <FieldGroup label={t('report.starter.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </FieldGroup>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('report.starter.note')}</p>
      </div>
    </Modal>
  );
}
