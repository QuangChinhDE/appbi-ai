'use client';

import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { DashboardThemeConfig } from '@/types/api';

type Props = {
  initial: DashboardThemeConfig | null | undefined;
  onClose: () => void;
  onSave: (theme: DashboardThemeConfig) => Promise<void> | void;
};

const PRESETS: Array<{ label: string; value: DashboardThemeConfig }> = [
  { label: 'Default', value: { mode: 'light', cardStyle: 'soft', density: 'normal' } },
  { label: 'Dark · Amber', value: { mode: 'dark', accent: '#facc15', cardStyle: 'soft' } },
  { label: 'Dark · Emerald', value: { mode: 'dark', accent: '#10b981', cardStyle: 'soft' } },
  { label: 'Light · Sapphire', value: { mode: 'light', accent: '#2563eb', cardStyle: 'soft' } },
  { label: 'Elevated', value: { mode: 'light', cardStyle: 'elevated', density: 'normal' } },
  { label: 'Compact', value: { mode: 'light', cardStyle: 'flat', density: 'compact' } },
  { label: 'Sharp', value: { mode: 'light', cardStyle: 'sharp' } },
  { label: 'Flat', value: { mode: 'light', cardStyle: 'flat' } },
];

export function DashboardThemeModal({ initial, onClose, onSave }: Props) {
  const [theme, setTheme] = useState<DashboardThemeConfig>({
    mode: initial?.mode ?? 'light',
    accent: initial?.accent ?? '',
    fontFamily: initial?.fontFamily ?? initial?.font ?? '',
    cardStyle: initial?.cardStyle ?? 'soft',
    background: initial?.background ?? initial?.backgroundColor ?? '',
    density: initial?.density ?? 'normal',
    cardRadius: initial?.cardRadius ?? '',
    hoverAnimation: initial?.hoverAnimation ?? 'none',
  });
  const [saving, setSaving] = useState(false);

  const update = <K extends keyof DashboardThemeConfig>(k: K, v: DashboardThemeConfig[K]) => {
    setTheme((t) => ({ ...t, [k]: v }));
  };

  const submit = async () => {
    setSaving(true);
    try {
      const cleaned: DashboardThemeConfig = {
        mode: theme.mode,
        cardStyle: theme.cardStyle,
        density: theme.density,
        ...(theme.accent ? { accent: theme.accent } : {}),
        ...(theme.fontFamily ? { fontFamily: theme.fontFamily } : {}),
        ...(theme.background ? { background: theme.background } : {}),
        ...(theme.cardRadius ? { cardRadius: theme.cardRadius } : {}),
        ...(theme.hoverAnimation && theme.hoverAnimation !== 'none' ? { hoverAnimation: theme.hoverAnimation } : {}),
      };
      await onSave(cleaned);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
        <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-5 py-4">
          <h2 className="text-base font-semibold">Dashboard theme</h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 px-5 py-5">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              Presets
            </div>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => setTheme({ ...theme, ...p.value })}
                  className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-sm hover:bg-surface-3"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-tertiary">Mode</span>
              <select
                value={theme.mode}
                onChange={(e) => update('mode', e.target.value as 'light' | 'dark')}
                className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5"
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-tertiary">Card style</span>
              <select
                value={theme.cardStyle}
                onChange={(e) => update('cardStyle', e.target.value as 'soft' | 'sharp' | 'flat' | 'elevated')}
                className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5"
              >
                <option value="soft">Soft</option>
                <option value="elevated">Elevated</option>
                <option value="sharp">Sharp</option>
                <option value="flat">Flat</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-tertiary">Accent color</span>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={theme.accent || '#2563eb'}
                  onChange={(e) => update('accent', e.target.value)}
                  className="h-9 w-12 rounded border border-[rgb(var(--border-line))]"
                />
                <input
                  type="text"
                  value={theme.accent || ''}
                  placeholder="#2563eb"
                  onChange={(e) => update('accent', e.target.value)}
                  className="flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5 text-sm"
                />
              </div>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-tertiary">Background</span>
              <input
                type="text"
                value={theme.background || ''}
                placeholder="(optional CSS color)"
                onChange={(e) => update('background', e.target.value)}
                className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-sm">
              <span className="text-text-tertiary">Font family</span>
              <input
                type="text"
                value={theme.fontFamily || ''}
                placeholder='(optional, e.g. "Inter, sans-serif")'
                onChange={(e) => update('fontFamily', e.target.value)}
                className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-tertiary">Density</span>
              <select
                value={theme.density ?? 'normal'}
                onChange={(e) => update('density', e.target.value as 'compact' | 'normal' | 'spacious')}
                className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5"
              >
                <option value="compact">Compact</option>
                <option value="normal">Normal</option>
                <option value="spacious">Spacious</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-tertiary">Hover</span>
              <select
                value={theme.hoverAnimation ?? 'none'}
                onChange={(e) => update('hoverAnimation', e.target.value)}
                className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5"
              >
                <option value="none">None</option>
                <option value="lift">Lift</option>
                <option value="scale">Scale</option>
                <option value="glow">Glow</option>
              </select>
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-sm">
              <span className="text-text-tertiary">Card radius</span>
              <input
                type="text"
                value={theme.cardRadius ?? ''}
                placeholder="Optional, e.g. 8px or 16"
                onChange={(e) => update('cardRadius', e.target.value)}
                className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5 text-sm"
              />
            </label>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[rgb(var(--border-line))] px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-sm hover:bg-surface-3"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save theme'}
          </button>
        </div>
      </div>
    </div>
  );
}
