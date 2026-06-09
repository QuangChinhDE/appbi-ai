/**
 * AppSettingsEditor — modal for app-level settings (branding + nav).
 */
'use client';

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import type { MiniAppLayoutSpec } from './types';
import { INPUT, Lbl } from './ScreenEditor';
import type { Dataset } from '@/hooks/use-datasets';

export default function AppSettingsEditor({
  layout,
  currentDatasetId,
  datasets,
  datasetChangePending,
  onChange,
  onDatasetChange,
  onClose,
}: {
  layout: MiniAppLayoutSpec;
  currentDatasetId: number;
  datasets: Dataset[];
  datasetChangePending?: boolean;
  onChange: (next: MiniAppLayoutSpec) => void;
  onDatasetChange: (datasetId: number) => Promise<void> | void;
  onClose: () => void;
}) {
  const branding = layout.branding || {};
  const nav = layout.mini_app_nav;
  const [selectedDatasetId, setSelectedDatasetId] = useState(currentDatasetId);

  useEffect(() => {
    setSelectedDatasetId(currentDatasetId);
  }, [currentDatasetId]);

  const datasetChanged = selectedDatasetId !== currentDatasetId;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/84 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-xl bg-surface-1 shadow-xl">
        <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-5 py-3">
          <h2 className="text-body font-emphasis text-text-primary">App settings</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 px-5 py-4">
          <section>
            <h3 className="mb-2 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
              Dataset
            </h3>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
              <Lbl label="Active dataset">
                <select
                  value={selectedDatasetId}
                  onChange={(e) => setSelectedDatasetId(Number(e.target.value))}
                  className={INPUT}
                >
                  {datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                      {dataset.name}
                    </option>
                  ))}
                </select>
              </Lbl>
              <button
                type="button"
                disabled={!datasetChanged || datasetChangePending}
                onClick={() => onDatasetChange(selectedDatasetId)}
                className="rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 py-1.5 text-caption font-emphasis text-text-secondary hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
              >
                {datasetChangePending ? 'Changing...' : 'Change dataset'}
              </button>
            </div>
            {datasetChanged && (
              <p className="mt-2 text-caption text-warning">
                Screens currently pointing to tables outside the new dataset will be cleared so you can map them again.
              </p>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
              Branding
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <Lbl label="App name">
                <input
                  value={branding.app_name || ''}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      branding: { ...branding, app_name: e.target.value },
                    })
                  }
                  className={INPUT}
                  placeholder="e.g. Production log"
                />
              </Lbl>
              <Lbl label="Primary color (hex)">
                <input
                  value={branding.primary_color || ''}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      branding: { ...branding, primary_color: e.target.value },
                    })
                  }
                  className={INPUT}
                  placeholder="#2563eb"
                />
              </Lbl>
              <Lbl label="Logo URL">
                <input
                  value={branding.logo_url || ''}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      branding: { ...branding, logo_url: e.target.value },
                    })
                  }
                  className={INPUT}
                />
              </Lbl>
              <Lbl label="Welcome text (login screen)">
                <input
                  value={branding.welcome_text || ''}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      branding: { ...branding, welcome_text: e.target.value },
                    })
                  }
                  className={INPUT}
                />
              </Lbl>
            </div>
          </section>

          <AutoNumberSection layout={layout} onChange={onChange} />

          <section>
            <h3 className="mb-2 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
              Navigation
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <Lbl label="Layout mobile">
                <select
                  value={nav.mobile_kind}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      mini_app_nav: {
                        ...nav,
                        mobile_kind: e.target.value as 'bottom_nav' | 'drawer',
                      },
                    })
                  }
                  className={INPUT}
                >
                  <option value="bottom_nav">Bottom nav (5 tabs)</option>
                  <option value="drawer">Drawer (slide-out sidebar)</option>
                </select>
              </Lbl>
              <Lbl label="Layout desktop">
                <select
                  value={nav.desktop_kind}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      mini_app_nav: {
                        ...nav,
                        desktop_kind: e.target.value as 'sidebar' | 'top_tabs',
                      },
                    })
                  }
                  className={INPUT}
                >
                  <option value="sidebar">Left sidebar</option>
                  <option value="top_tabs">Top tabs</option>
                </select>
              </Lbl>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}


function AutoNumberSection({
  layout,
  onChange,
}: {
  layout: MiniAppLayoutSpec;
  onChange: (next: MiniAppLayoutSpec) => void;
}) {
  const configs = layout.auto_number_columns || [];
  const update = (next: typeof configs) =>
    onChange({ ...layout, auto_number_columns: next });
  return (
    <section>
      <h3 className="mb-2 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
        Auto-number columns
      </h3>
      <p className="mb-3 text-caption text-text-tertiary">
        Server fills these columns on insert when the user leaves them blank.
        Use placeholders like <code>{'{YYYY}{MM}{DD}'}</code> and{' '}
        <code>{'{N:4}'}</code> in the pattern.
      </p>
      <div className="space-y-2">
        {configs.map((cfg, idx) => (
          <div
            key={idx}
            className="grid grid-cols-12 gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2"
          >
            <input
              value={cfg.column}
              onChange={(e) => {
                const next = [...configs];
                next[idx] = { ...cfg, column: e.target.value };
                update(next);
              }}
              placeholder="column"
              className={`${INPUT} col-span-3`}
            />
            <input
              value={cfg.pattern}
              onChange={(e) => {
                const next = [...configs];
                next[idx] = { ...cfg, pattern: e.target.value };
                update(next);
              }}
              placeholder="PO-{YYYY}{MM}{DD}-{N:4}"
              className={`${INPUT} col-span-5`}
            />
            <select
              value={cfg.reset || 'never'}
              onChange={(e) => {
                const next = [...configs];
                next[idx] = {
                  ...cfg,
                  reset: e.target.value as 'never' | 'daily' | 'monthly' | 'yearly',
                };
                update(next);
              }}
              className={`${INPUT} col-span-3`}
            >
              <option value="never">No reset</option>
              <option value="daily">Reset daily</option>
              <option value="monthly">Reset monthly</option>
              <option value="yearly">Reset yearly</option>
            </select>
            <button
              type="button"
              onClick={() => update(configs.filter((_, i) => i !== idx))}
              className="col-span-1 rounded-md text-caption text-status-danger hover:bg-status-danger/10"
              title="Remove"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            update([
              ...configs,
              { column: '', pattern: 'PO-{YYYY}{MM}{DD}-{N:4}', reset: 'never' },
            ])
          }
          className="rounded-md border border-dashed border-[rgb(var(--border-line))] px-3 py-1.5 text-caption text-text-secondary hover:bg-surface-2"
        >
          + Thêm cột auto-number
        </button>
      </div>
    </section>
  );
}
