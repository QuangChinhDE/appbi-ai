'use client';

import React, { useState, useCallback, useEffect } from 'react';
import {
  X, Database, Table2, Unlink, Settings2, Columns3, LayoutGrid,
} from 'lucide-react';
import type {
  TemplateBlock, TableConfig, TableDataSource,
} from '@/types/template';
import { TableDataSourcePicker } from './TableDataSourcePicker';
import { TableEditor } from './TableEditor';

/* ── Props ─────────────────────────────────────────────────── */

interface TableBlockSettingsModalProps {
  block: TemplateBlock;
  onChange: (updated: TemplateBlock) => void;
  onClose: () => void;
}

/* ── Component ─────────────────────────────────────────────── */

export function TableBlockSettingsModal({
  block,
  onChange,
  onClose,
}: TableBlockSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'datasource' | 'editor'>('datasource');
  const cfg = block.config as Partial<TableConfig> & Record<string, any>;
  const currentDataSource = cfg.dataSource as TableDataSource | undefined;
  const hasDataSource = !!currentDataSource;

  // Auto-switch to editor tab if datasource is already connected
  useEffect(() => {
    if (hasDataSource) setActiveTab('editor');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const updateConfig = useCallback(
    (patch: Record<string, any>) => {
      onChange({ ...block, config: { ...cfg, ...patch } });
    },
    [block, cfg, onChange],
  );

  const updateLayout = useCallback(
    (patch: Partial<typeof block.layout>) => {
      onChange({ ...block, layout: { ...block.layout, ...patch } });
    },
    [block, onChange],
  );

  const handleDataSourceApply = useCallback(
    (source: TableDataSource, generatedConfig: Partial<TableConfig>) => {
      onChange({
        ...block,
        config: {
          ...cfg,
          ...generatedConfig,
          heading: cfg.heading || '',
        },
      });
      // After applying datasource, switch to the editor tab
      setActiveTab('editor');
    },
    [block, cfg, onChange],
  );

  const handleDisconnect = useCallback(() => {
    const { dataSource: _, ...rest } = cfg;
    onChange({ ...block, config: rest });
    setActiveTab('datasource');
  }, [block, cfg, onChange]);

  const handleTableConfigChange = useCallback(
    (config: TableConfig) => {
      onChange({ ...block, config: { ...cfg, ...config } });
    },
    [block, cfg, onChange],
  );

  const tabs = [
    { key: 'datasource' as const, label: 'Data Source', icon: Database },
    { key: 'editor' as const, label: 'Table Editor', icon: LayoutGrid },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl"
        style={{ maxHeight: 'calc(100vh - 48px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <Settings2 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-900">
                Table Block Settings
              </h2>
              {currentDataSource && (
                <p className="text-xs text-gray-500 truncate">
                  {currentDataSource.datasetName} → {currentDataSource.tableName}
                  {' · '}{currentDataSource.columns.length} columns
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* ── Tab bar ── */}
        <div className="flex items-center gap-1 border-b border-gray-200 px-6">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`relative flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? 'text-blue-600'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-t" />
                )}
              </button>
            );
          })}
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'datasource' && (
            <div className="flex gap-6 p-6">
              {/* Left: Data source picker */}
              <div className="w-80 shrink-0 space-y-5">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-blue-600 flex items-center gap-1.5">
                    <Database className="h-3.5 w-3.5" />
                    Data Source
                  </p>
                  {currentDataSource && (
                    <button
                      onClick={handleDisconnect}
                      className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Unlink className="h-3 w-3" />
                      Disconnect
                    </button>
                  )}
                </div>
                <TableDataSourcePicker
                  current={currentDataSource}
                  onApply={handleDataSourceApply}
                />
              </div>

              {/* Right: General settings */}
              <div className="flex-1 space-y-5 border-l border-gray-100 pl-6">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                  General Settings
                </p>

                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Table heading</span>
                  <input
                    type="text"
                    value={cfg.heading ?? ''}
                    onChange={(e) => updateConfig({ heading: e.target.value })}
                    placeholder="Table title…"
                    className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </label>

                <label className="flex items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={cfg.showBorder ?? true}
                    onChange={(e) => updateConfig({ showBorder: e.target.checked })}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">Show borders</span>
                </label>

                {/* Position & Size */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
                    Position & Size
                  </p>
                  <div className="grid grid-cols-4 gap-3">
                    {[
                      { label: 'X', key: 'x' as const, min: 0 },
                      { label: 'Y', key: 'y' as const, min: 0 },
                      { label: 'W', key: 'width' as const, min: 40 },
                      { label: 'H', key: 'height' as const, min: 20 },
                    ].map(({ label, key, min }) => (
                      <label key={key} className="block">
                        <span className="text-[10px] text-gray-500 uppercase">{label}</span>
                        <input
                          type="number"
                          value={Math.round(block.layout[key])}
                          min={min}
                          onChange={(e) =>
                            updateLayout({ [key]: Math.max(min, Number(e.target.value)) })
                          }
                          className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs tabular-nums focus:border-blue-500 focus:outline-none"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'editor' && (
            <div className="p-6">
              {hasDataSource ? (
                <TableEditor
                  config={cfg as TableConfig}
                  onChange={handleTableConfigChange}
                />
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                  <Database className="h-10 w-10 mb-3 opacity-40" />
                  <p className="text-sm font-medium">No data source connected</p>
                  <p className="text-xs mt-1">Switch to the Data Source tab to connect a dataset table first.</p>
                  <button
                    onClick={() => setActiveTab('datasource')}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                  >
                    <Database className="h-3.5 w-3.5" />
                    Set up Data Source
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-200 bg-gray-50 px-6 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
