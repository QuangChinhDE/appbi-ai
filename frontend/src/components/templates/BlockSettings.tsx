'use client';

import React, { useState } from 'react';
import { X, Database } from 'lucide-react';
import type { TemplateBlock, CellValue, DataFieldBinding } from '@/types/template';
import { isDataField } from '@/types/template';
import { DataFieldPicker } from './DataFieldPicker';

interface BlockSettingsProps {
  block: TemplateBlock;
  onChange: (updated: TemplateBlock) => void;
  onClose: () => void;
}

export function BlockSettings({ block, onChange, onClose }: BlockSettingsProps) {
  const cfg = block.config;
  const [showTextFieldPicker, setShowTextFieldPicker] = useState(false);

  const updateConfig = (patch: Record<string, any>) => {
    onChange({ ...block, config: { ...cfg, ...patch } });
  };

  const updateLayout = (patch: Partial<typeof block.layout>) => {
    onChange({ ...block, layout: { ...block.layout, ...patch } });
  };

  /** Insert a data field binding into text block content */
  const insertTextDataField = (binding: DataFieldBinding) => {
    const current: CellValue[] = Array.isArray(cfg.content)
      ? cfg.content
      : cfg.content
        ? [cfg.content as string]
        : [];
    updateConfig({ content: [...current, binding] });
    setShowTextFieldPicker(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Block Settings
        </h3>
        <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Position & Size */}
      <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-2 text-sm">
        <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Position & Size</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[10px] text-gray-500">X</span>
            <input type="number" value={Math.round(block.layout.x)} onChange={(e) => updateLayout({ x: Number(e.target.value) })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-xs tabular-nums focus:border-blue-500 focus:outline-none" />
          </label>
          <label className="block">
            <span className="text-[10px] text-gray-500">Y</span>
            <input type="number" value={Math.round(block.layout.y)} onChange={(e) => updateLayout({ y: Number(e.target.value) })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-xs tabular-nums focus:border-blue-500 focus:outline-none" />
          </label>
          <label className="block">
            <span className="text-[10px] text-gray-500">W</span>
            <input type="number" value={Math.round(block.layout.width)} min={40} onChange={(e) => updateLayout({ width: Math.max(40, Number(e.target.value)) })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-xs tabular-nums focus:border-blue-500 focus:outline-none" />
          </label>
          <label className="block">
            <span className="text-[10px] text-gray-500">H</span>
            <input type="number" value={Math.round(block.layout.height)} min={20} onChange={(e) => updateLayout({ height: Math.max(20, Number(e.target.value)) })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-xs tabular-nums focus:border-blue-500 focus:outline-none" />
          </label>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3 text-sm">
        <p className="text-xs text-gray-400 uppercase tracking-wider">{block.type} block</p>

        {/* ── Title block settings ──────────────────────────────────── */}
        {block.type === 'title' && (
          <>
            <label className="block">
              <span className="text-gray-600">Heading text</span>
              <input type="text" value={cfg.text ?? ''} onChange={(e) => updateConfig({ text: e.target.value })}
                placeholder="Report title…"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </label>
            <label className="block">
              <span className="text-gray-600">Subtitle</span>
              <input type="text" value={cfg.subtitle ?? ''} onChange={(e) => updateConfig({ subtitle: e.target.value })}
                placeholder="Optional subtitle…"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cfg.centered ?? true} onChange={(e) => updateConfig({ centered: e.target.checked })}
                className="rounded border-gray-300" />
              <span className="text-gray-600">Center align</span>
            </label>
          </>
        )}

        {/* ── Table block settings (basic options — editing via TableEditor panel) */}
        {block.type === 'table' && (
          <>
            <label className="block">
              <span className="text-gray-600">Table heading</span>
              <input type="text" value={cfg.heading ?? ''} onChange={(e) => updateConfig({ heading: e.target.value })}
                placeholder="Table title…"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cfg.showBorder ?? true} onChange={(e) => updateConfig({ showBorder: e.target.checked })}
                className="rounded border-gray-300" />
              <span className="text-gray-600">Show borders</span>
            </label>
            <p className="text-xs text-gray-400 mt-2">
              Click the table block, then use the editor panel below the canvas to edit cells, merge columns, and link data fields.
            </p>
          </>
        )}

        {/* ── Signature block settings ──────────────────────────────── */}
        {block.type === 'signature' && (
          <label className="block">
            <span className="text-gray-600">Signature columns (comma-separated titles)</span>
            <input type="text"
              value={(cfg.columns ?? []).map((c: any) => c.title).join(', ')}
              onChange={(e) => {
                const titles = e.target.value.split(',').map((t: string) => t.trim()).filter(Boolean);
                updateConfig({ columns: titles.map((title: string) => ({ title, subtitle: '(Ký, ghi rõ họ tên)' })) });
              }}
              placeholder="Người lập biểu, Kế toán trưởng, Giám đốc"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </label>
        )}

        {/* ── Text block settings ───────────────────────────────────── */}
        {block.type === 'text' && (() => {
          const segments: CellValue[] = Array.isArray(cfg.content)
            ? cfg.content
            : cfg.content
              ? [String(cfg.content)]
              : [];
          const hasBindings = segments.some((s) => typeof s !== 'string');

          const updateSegment = (idx: number, val: string) => {
            const next = [...segments];
            next[idx] = val;
            updateConfig({ content: next.length === 1 && typeof next[0] === 'string' ? next[0] : next });
          };

          const removeSegment = (idx: number) => {
            const next = segments.filter((_, i) => i !== idx);
            updateConfig({
              content: next.length === 0 ? '' : next.length === 1 && typeof next[0] === 'string' ? next[0] : next,
            });
          };

          return (
            <>
              <div className="space-y-1.5">
                <span className="text-sm text-gray-600">Content</span>
                {!hasBindings ? (
                  <textarea
                    value={typeof cfg.content === 'string' ? cfg.content : ''}
                    onChange={(e) => updateConfig({ content: e.target.value })}
                    placeholder="Enter text content…"
                    rows={4}
                    className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                ) : (
                  <div className="rounded-md border border-gray-300 bg-gray-50 p-2 space-y-1.5 min-h-[80px]">
                    {segments.map((seg, i) =>
                      typeof seg === 'string' ? (
                        <input
                          key={i}
                          type="text"
                          value={seg}
                          onChange={(e) => updateSegment(i, e.target.value)}
                          placeholder="Text…"
                          className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm"
                        />
                      ) : isDataField(seg) ? (
                        <div key={i} className="flex items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                            <Database className="h-3 w-3" />
                            {seg.label ?? seg.column}
                          </span>
                          <button
                            onClick={() => removeSegment(i)}
                            className="rounded p-0.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ) : null,
                    )}
                  </div>
                )}
              </div>
              {hasBindings && (
                <button
                  onClick={() => updateConfig({ content: [...segments, ''] })}
                  className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  + Text
                </button>
              )}
              <div className="relative">
                <button
                  onClick={() => setShowTextFieldPicker(!showTextFieldPicker)}
                  className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
                >
                  <Database className="h-3 w-3" /> Insert data field
                </button>
                {showTextFieldPicker && (
                  <div className="absolute left-0 top-full z-50 mt-1">
                    <DataFieldPicker
                      onSelect={insertTextDataField}
                      onCancel={() => setShowTextFieldPicker(false)}
                    />
                  </div>
                )}
              </div>
            </>
          );
        })()}

        {/* ── Image block settings ──────────────────────────────────── */}
        {block.type === 'image' && (
          <>
            <label className="block">
              <span className="text-gray-600">Image URL</span>
              <input type="text" value={cfg.url ?? ''} onChange={(e) => updateConfig({ url: e.target.value })}
                placeholder="https://…"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </label>
            <label className="block">
              <span className="text-gray-600">Alt text</span>
              <input type="text" value={cfg.alt ?? ''} onChange={(e) => updateConfig({ alt: e.target.value })}
                placeholder="Logo"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </label>
          </>
        )}

        {/* ── Spacer ────────────────────────────────────────────────── */}
        {block.type === 'spacer' && (
          <p className="text-gray-400 text-xs">Adjust height by resizing the block on the canvas.</p>
        )}
      </div>
    </div>
  );
}
