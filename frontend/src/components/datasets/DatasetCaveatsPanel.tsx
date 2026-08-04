'use client';

/**
 * Data caveats for ONE dataset.
 *
 * A caveat is what the AI must say every time it explains these numbers: this data
 * stops in October 2018, the current month is a partial period, this table double
 * counts refunds. It is never a general truth — it is a property of one dataset,
 * which is why it is authored here and scoped here.
 *
 * It used to be global. `dataset_id` was nullable and a null meant "applies
 * everywhere", so the two caveats this deployment had were attached to nothing and
 * injected into every report — including one that read "Dataset Olist kết thúc
 * 2018-10", a fact about exactly one dataset being told to all of them. Both were
 * deleted rather than migrated: a caveat nobody scoped is a caveat nobody can trust.
 *
 * So this panel writes `dataset_id` on create and filters strictly on read. There
 * is no "all datasets" option, because that option is what produced the mess.
 */
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import React from 'react';

import { Button } from '@/components/ui/Button';
import { Input, Label, Textarea } from '@/components/ui/Input';
import { useI18n } from '@/providers/LanguageProvider';
import { deleteCaveat, listCaveats, upsertCaveat, type GovernCaveat } from '@/lib/catalog';

export function DatasetCaveatsPanel({
  datasetId,
  canEdit,
}: {
  datasetId: number;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const [caveats, setCaveats] = React.useState<GovernCaveat[] | null>(null);
  const [draft, setDraft] = React.useState<{ title: string; content: string } | null>(null);
  const [saving, setSaving] = React.useState(false);

  const reload = React.useCallback(async () => {
    const rows = await listCaveats().catch(() => [] as GovernCaveat[]);
    // Strict. A row belonging to another dataset — or to none — is not this
    // dataset's warning and must not be read as one.
    setCaveats(rows.filter((x) => x.dataset_id === datasetId));
  }, [datasetId]);

  React.useEffect(() => { reload(); }, [reload]);

  const save = async () => {
    if (!draft?.content.trim()) return;
    setSaving(true);
    try {
      await upsertCaveat({
        dataset_id: datasetId,          // bound at creation, never left to be chosen
        title: draft.title.trim() || draft.content.trim().slice(0, 60),
        content: draft.content.trim(),
        always_inject: true,
        status: 'Approved',
      });
      setDraft(null);
      await reload();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-small font-strong text-text-primary">
            <AlertTriangle className="h-4 w-4 text-warning" />
            {t('datasets.caveats.title')}
          </h2>
          <p className="mt-0.5 max-w-2xl text-tiny leading-5 text-text-tertiary">
            {t('datasets.caveats.subtitle')}
          </p>
        </div>
        {canEdit && !draft && (
          <Button size="xs" variant="secondary" onClick={() => setDraft({ title: '', content: '' })}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('datasets.caveats.add')}
          </Button>
        )}
      </div>

      {draft && (
        <div className="space-y-2.5 rounded-lg border border-brand/25 bg-brand/5 p-3">
          <div>
            <Label className="mb-1 block">{t('datasets.caveats.fieldTitle')}</Label>
            <Input
              value={draft.title}
              placeholder={t('datasets.caveats.titlePlaceholder')}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>
          <div>
            <Label className="mb-1 block">{t('datasets.caveats.fieldContent')}</Label>
            <Textarea
              rows={3}
              value={draft.content}
              placeholder={t('datasets.caveats.contentPlaceholder')}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="xs" disabled={!draft.content.trim() || saving} onClick={save}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}

      {caveats === null ? (
        <p className="py-6 text-center text-tiny text-text-tertiary">{t('common.loading')}</p>
      ) : caveats.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-3 py-6 text-center text-tiny leading-5 text-text-tertiary">
          {t('datasets.caveats.empty')}
        </p>
      ) : (
        <div className="divide-y divide-[rgb(var(--border-line))] rounded-lg border border-[rgb(var(--border-line))]">
          {caveats.map((c) => (
            <div key={c.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                {c.title && (
                  <p className="truncate text-caption text-text-primary">{c.title}</p>
                )}
                <p className="mt-0.5 text-tiny leading-5 text-text-secondary">{c.content}</p>
              </div>
              {canEdit && (
                <button
                  type="button"
                  aria-label={t('common.delete')}
                  onClick={async () => { await deleteCaveat(c.id); reload(); }}
                  className="flex-shrink-0 rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default DatasetCaveatsPanel;
