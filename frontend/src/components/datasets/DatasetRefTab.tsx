'use client';

/**
 * "From Dataset" tab — Dataset-on-Dataset composition. Pick a PUBLISHED parent
 * dataset the user can build on, then one of its tables, to reference it as a
 * table in this dataset. The child reads the parent's PINNED published snapshot;
 * no data is copied.
 */

import { useMemo, useState } from 'react';
import { Boxes, Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { useComposableParents, type AddTableInput } from '@/hooks/use-datasets';
import { useI18n } from '@/providers/LanguageProvider';

export function DatasetRefTab({
  datasetId,
  onAddTable,
  isLoading,
  saveError,
}: {
  datasetId: number;
  onAddTable: (input: AddTableInput) => void;
  isLoading?: boolean;
  saveError?: string | null;
}) {
  const { t } = useI18n();
  const { data: parents = [], isLoading: loadingParents } = useComposableParents(datasetId);
  const [parentId, setParentId] = useState<number | ''>('');
  const [tableId, setTableId] = useState<number | ''>('');
  const [displayName, setDisplayName] = useState('');

  const parent = useMemo(() => parents.find((p) => p.id === parentId), [parents, parentId]);
  const table = useMemo(() => parent?.tables.find((tb) => tb.id === tableId), [parent, tableId]);

  const canAdd = parentId !== '' && tableId !== '' && !isLoading;

  const submit = () => {
    if (parentId === '' || tableId === '') return;
    onAddTable({
      source_kind: 'dataset',
      parent_dataset_id: Number(parentId),
      parent_dataset_table_id: Number(tableId),
      display_name: displayName.trim() || table?.display_name || 'Parent reference',
    });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div className="flex items-start gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2.5 text-caption text-text-secondary">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        <span>{t('datasets.datasetRef.explainer')}</span>
      </div>

      <label className="block">
        <span className="mb-1 block text-caption font-emphasis text-text-secondary">{t('datasets.datasetRef.parent')}</span>
        {loadingParents ? (
          <div className="flex items-center gap-2 text-caption text-text-tertiary"><Loader2 className="h-4 w-4 animate-spin" />…</div>
        ) : parents.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-3 py-4 text-center text-caption text-text-tertiary">
            {t('datasets.datasetRef.noParents')}
          </p>
        ) : (
          <Select
            value={String(parentId)}
            onChange={(e) => { setParentId(e.target.value ? Number(e.target.value) : ''); setTableId(''); }}
          >
            <option value="">{t('datasets.datasetRef.selectParent')}</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
        )}
      </label>

      {parent && (
        <label className="block">
          <span className="mb-1 block text-caption font-emphasis text-text-secondary">{t('datasets.datasetRef.table')}</span>
          <Select value={String(tableId)} onChange={(e) => setTableId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{t('datasets.datasetRef.selectTable')}</option>
            {parent.tables.map((tb) => (
              <option key={tb.id} value={tb.id}>{tb.display_name}</option>
            ))}
          </Select>
        </label>
      )}

      {table && (
        <label className="block">
          <span className="mb-1 block text-caption font-emphasis text-text-secondary">{t('datasets.datasetRef.displayName')}</span>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={table.display_name} />
        </label>
      )}

      {saveError && <p className="text-caption text-danger">{saveError}</p>}

      <div className="flex justify-end">
        <Button variant="primary" leadingIcon={isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Boxes className="h-4 w-4" />} disabled={!canAdd} onClick={submit}>
          {t('datasets.datasetRef.add')}
        </Button>
      </div>
    </div>
  );
}
