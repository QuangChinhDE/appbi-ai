/**
 * ChartEditorWithTabs — wraps ExploreEditor with a secondary tab for creating
 * Calculated Tables inline, so users can add a new derived table to the
 * current dataset without leaving the chart editor.
 *
 * Tabs:
 *   1) "Chart"            → the full ExploreEditor
 *   2) "Calculated table" → CalculatedTableTab (same UI as the Dataset editor)
 *
 * On save in tab 2, the new table is persisted via useAddTableToDataset and
 * the dataset cache is invalidated; when the user switches back to the Chart
 * tab, ExploreEditor's source selector immediately sees the new table.
 */
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Sigma } from 'lucide-react';
import { toast } from '@/lib/toast';

import { ExploreEditor, type ExploreEditorProps } from '@/components/explore/ExploreEditor';
import { CalculatedTableTab } from '@/components/datasets/CalculatedTableTab';
import { useDataset, useAddTableToDataset } from '@/hooks/use-datasets';

type EditorTab = 'chart' | 'calc';

export type ChartEditorWithTabsProps = Omit<ExploreEditorProps, 'onDatasetChange'>;

export function ChartEditorWithTabs(props: ChartEditorWithTabsProps) {
  const { initialDatasetId = null } = props;
  const [activeTab, setActiveTab] = useState<EditorTab>('chart');
  const [currentDatasetId, setCurrentDatasetId] = useState<number | null>(initialDatasetId ?? null);

  const handleDatasetChange = useCallback((id: number | null) => {
    setCurrentDatasetId(id);
  }, []);

  // Keep the ExploreEditor mounted across tab switches so the user's
  // in-progress chart state survives. We just hide/show via CSS.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabBar
        active={activeTab}
        onChange={setActiveTab}
        calcDisabled={currentDatasetId == null}
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        <div
          className={`h-full min-h-0 ${activeTab === 'chart' ? 'block' : 'hidden'}`}
        >
          <ExploreEditor {...props} onDatasetChange={handleDatasetChange} />
        </div>
        {activeTab === 'calc' && (
          <div className="h-full min-h-0 overflow-y-auto">
            <CalculatedTablePane
              datasetId={currentDatasetId}
              onCreated={() => {
                // Bounce back to the chart tab once the new table is ready
                // so the user can immediately pick it up in the source selector.
                setActiveTab('chart');
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function TabBar({
  active,
  onChange,
  calcDisabled,
}: {
  active: EditorTab;
  onChange: (tab: EditorTab) => void;
  calcDisabled: boolean;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4">
      <TabButton
        active={active === 'chart'}
        onClick={() => onChange('chart')}
        icon={<BarChart3 className="h-4 w-4" />}
        label="Chart"
      />
      <TabButton
        active={active === 'calc'}
        onClick={() => onChange('calc')}
        icon={<Sigma className="h-4 w-4" />}
        label="Calculated table"
        disabled={calcDisabled}
        disabledReason={calcDisabled ? 'Pick a dataset in the Chart tab first' : undefined}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  disabled,
  disabledReason,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      className={[
        'flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
        active
          ? 'border-brand text-brand'
          : 'border-transparent text-text-secondary hover:text-text-primary',
        disabled ? 'cursor-not-allowed opacity-40 hover:text-text-secondary' : '',
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  );
}

function CalculatedTablePane({
  datasetId,
  onCreated,
}: {
  datasetId: number | null;
  onCreated: () => void;
}) {
  const { data: dataset, isLoading: isDatasetLoading } = useDataset(datasetId);
  const addTable = useAddTableToDataset();
  const [saveError, setSaveError] = useState<string | null>(null);

  const availableTables = useMemo(() => dataset?.tables ?? [], [dataset?.tables]);

  // Reset any lingering error when dataset context changes
  useEffect(() => {
    setSaveError(null);
  }, [datasetId]);

  if (datasetId == null) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-text-tertiary">
        Select a dataset in the Chart tab to add a calculated table.
      </div>
    );
  }

  if (isDatasetLoading && availableTables.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-text-tertiary">
        Loading dataset tables…
      </div>
    );
  }

  return (
    <CalculatedTableTab
      availableTables={availableTables}
      isLoading={addTable.isPending}
      saveError={saveError}
      onAddTable={async (input) => {
        setSaveError(null);
        try {
          await addTable.mutateAsync({ datasetId, input });
          toast.success('Calculated table added. Switch to the Chart tab to use it.');
          onCreated();
        } catch (err: any) {
          const message =
            err?.response?.data?.detail ||
            err?.response?.data?.message ||
            err?.message ||
            'Failed to create calculated table';
          setSaveError(typeof message === 'string' ? message : JSON.stringify(message));
        }
      }}
    />
  );
}
