'use client';

/**
 * Metrics & Terms, inside the dataset it describes.
 *
 * This was a top-level sidebar module. It should not have been: a managed metric
 * and a glossary term are statements ABOUT a dataset — what "GMV" means for THIS
 * data, which caveat applies to THESE numbers. Making it a separate destination
 * meant defining a dataset in one place and explaining it in another, and the
 * explaining step is the one people skip.
 *
 * So it lives beside Data Model, and it is SCOPED: only this dataset's metrics.
 * The standalone screen listed every metric in the deployment because it had no
 * dataset to be about. Data caveats moved out to their own tab — see
 * `DatasetCaveatsPanel`; they are a different kind of statement and they were only
 * sharing a screen because both used to live on one global page.
 *
 * The create/edit modal is `MetricFormModal`, unchanged — reused rather than
 * reimplemented, so the two places a metric can be authored cannot drift.
 */
import { LineChart, Plus } from 'lucide-react';
import React from 'react';

import { MetricFormModal } from '@/components/govern/MetricForm';
import { useDatasetModel } from '@/hooks/use-dataset-model';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/providers/LanguageProvider';
import {
  listKnowledge,
  listManagedMetrics,
  type ManagedMetric,
} from '@/lib/catalog';

export function DatasetMetricsPanel({
  datasetId,
  canEdit,
}: {
  datasetId: number;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  // The dataset's own model feeds the Data-link dropdowns, and its docs feed the
  // Home-doc one — so authoring a metric is picking, not spelling out a
  // `dataset_table_437.on_time_rate` string and a numeric doc id from memory.
  const { data: model } = useDatasetModel(datasetId);
  const [docs, setDocs] = React.useState<{ id: number; title: string }[]>([]);
  const [metrics, setMetrics] = React.useState<ManagedMetric[] | null>(null);
  const [editing, setEditing] = React.useState<string | null | undefined>(undefined);

  const reload = React.useCallback(async () => {
    const m = await listManagedMetrics().catch(() => [] as ManagedMetric[]);
    // Filtered client-side: the endpoint takes category/status but not a dataset,
    // and adding a query parameter is a backend change this move does not need.
    //
    // STRICT. Two datasets do not have the same metrics: a metric is defined over
    // this dataset's tables and columns, so one that belongs to nothing belongs
    // nowhere. The nine unbound rows this deployment had were deleted rather than
    // shown everywhere, and `defaultDatasetId` on the create form is what stops
    // new ones appearing.
    setMetrics(m.filter((x) => x.dataset_id === datasetId));
  }, [datasetId]);

  React.useEffect(() => { reload(); }, [reload]);
  React.useEffect(() => {
    listKnowledge()
      .then((r) => setDocs(r.docs.map((d) => ({ id: d.id, title: d.title }))))
      .catch(() => undefined);
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-small font-strong text-text-primary">
              <LineChart className="h-4 w-4 text-brand" />
              {t('datasets.metrics.title')}
            </h2>
            <p className="mt-0.5 text-tiny text-text-tertiary">
              {t('datasets.metrics.subtitle')}
            </p>
          </div>
          {canEdit && (
            <Button size="xs" variant="secondary" onClick={() => setEditing(null)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('datasets.metrics.add')}
            </Button>
          )}
        </div>

        {metrics === null ? (
          <p className="py-6 text-center text-tiny text-text-tertiary">{t('common.loading')}</p>
        ) : metrics.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-3 py-6 text-center text-tiny leading-5 text-text-tertiary">
            {t('datasets.metrics.empty')}
          </p>
        ) : (
          <div className="divide-y divide-[rgb(var(--border-line))] rounded-lg border border-[rgb(var(--border-line))]">
            {metrics.map((m) => (
              <button
                key={m.machine_name}
                type="button"
                onClick={() => setEditing(m.machine_name)}
                className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-caption text-text-primary">{m.name}</span>
                  {m.definition && (
                    <span className="mt-0.5 block line-clamp-2 text-tiny leading-5 text-text-tertiary">
                      {m.definition}
                    </span>
                  )}
                </span>
                <span className="flex flex-shrink-0 items-center gap-1.5 text-tiny text-text-quaternary">
                  {m.unit && <span>{m.unit}</span>}
                  {m.grain && <span>· {m.grain}</span>}
                  {m.measure_ref && (
                    <span className="rounded bg-surface-3 px-1 font-mono text-tiny text-text-tertiary">
                      {m.measure_ref}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {editing !== undefined && (
        <MetricFormModal
          machineName={editing}
          defaultDatasetId={datasetId}
          views={model?.views ?? []}
          docs={docs}
          onClose={() => setEditing(undefined)}
          onChanged={reload}
          onCreated={() => reload()}
        />
      )}
    </div>
  );
}

export default DatasetMetricsPanel;
