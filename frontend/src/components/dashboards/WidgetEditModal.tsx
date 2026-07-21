'use client';

import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/common/Modal';
import { dashboardApi } from '@/lib/api/dashboards';
import type { DashboardChart, DashboardWidgetType } from '@/types/api';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  dashboardId: number;
  widget: DashboardChart | null;
};

export function WidgetEditModal({ isOpen, onClose, dashboardId, widget }: Props) {
  const { t } = useI18n();
  const WIDGET_LABEL: Record<string, string> = {
    text: t('dashboards.widgetEdit.typeText'),
    countdown: t('dashboards.widgetEdit.typeCountdown'),
    image: t('dashboards.widgetEdit.typeImage'),
    shape: t('dashboards.widgetEdit.typeShape'),
    parameter_switcher: t('dashboards.widgetEdit.typeParameterSwitcher'),
  };
  const queryClient = useQueryClient();
  const [config, setConfig] = useState<Record<string, any>>({});
  const [isSaving, setIsSaving] = useState(false);

  // Reload draft each time a different widget is opened.
  useEffect(() => {
    if (!isOpen || !widget) return;
    setConfig({ ...(widget.widget_config ?? {}) });
  }, [isOpen, widget?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen || !widget) return null;

  const widgetType = (widget.widget_type ?? 'text') as DashboardWidgetType;

  const set = (key: string, value: any) =>
    setConfig((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await dashboardApi.updateWidget(dashboardId, widget.id, config);
      await queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
      toast.success(t('dashboards.widgetEdit.savedToast'));
      onClose();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : t('dashboards.widgetEdit.saveFailedToast'));
    } finally {
      setIsSaving(false);
    }
  };

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={onClose}
        className="inline-flex h-8 items-center rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-surface-2"
      >
        {t('common.cancel')}
      </button>
      <button
        type="button"
        onClick={handleSave}
        disabled={isSaving}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-[12px] font-[510] text-white shadow-sm transition-colors hover:bg-brand-hover disabled:opacity-60"
      >
        {isSaving && <Loader2 className="h-3 w-3 animate-spin" />}
        {isSaving ? t('dashboards.widgetEdit.saving') : t('dashboards.widgetEdit.save')}
      </button>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('dashboards.widgetEdit.title', { type: WIDGET_LABEL[widgetType] ?? widgetType })}
      size="md"
      footer={footer}
    >
      <div className="space-y-4 p-5">
        {widgetType === 'text' && <TextWidgetForm config={config} set={set} />}
        {widgetType === 'countdown' && <CountdownWidgetForm config={config} set={set} />}
        {widgetType === 'image' && <ImageWidgetForm config={config} set={set} />}
        {widgetType === 'shape' && <ShapeWidgetForm config={config} set={set} />}
        {widgetType === 'parameter_switcher' && (
          <ParameterSwitcherForm config={config} setConfig={setConfig} />
        )}
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-[510] text-text-secondary">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-text-tertiary">{hint}</p>}
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2.5 py-1.5 text-[13px] text-text-primary focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand';

function TextWidgetForm({ config, set }: { config: any; set: (k: string, v: any) => void }) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('dashboards.widgetEdit.template')} hint={t('dashboards.widgetEdit.templateHint')}>
        <textarea
          value={config.template ?? ''}
          onChange={(e) => set('template', e.target.value)}
          rows={5}
          className={inputClass}
          placeholder="Hello {{today()}}"
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t('dashboards.widgetEdit.align')}>
          <select value={config.align ?? 'left'} onChange={(e) => set('align', e.target.value)} className={inputClass}>
            <option value="left">{t('dashboards.widgetEdit.alignLeft')}</option>
            <option value="center">{t('dashboards.widgetEdit.alignCenter')}</option>
            <option value="right">{t('dashboards.widgetEdit.alignRight')}</option>
          </select>
        </Field>
        <Field label={t('dashboards.widgetEdit.fontSize')}>
          <input
            type="number"
            min={10}
            max={72}
            value={config.fontSize ?? 14}
            onChange={(e) => set('fontSize', Number(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label={t('dashboards.widgetEdit.color')}>
          <input
            type="color"
            value={config.color ?? '#000000'}
            onChange={(e) => set('color', e.target.value)}
            className="h-9 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1"
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-[12px] text-text-secondary">
        <input type="checkbox" checked={!!config.bold} onChange={(e) => set('bold', e.target.checked)} />
        {t('dashboards.widgetEdit.bold')}
      </label>
    </>
  );
}

function CountdownWidgetForm({ config, set }: { config: any; set: (k: string, v: any) => void }) {
  // Convert ISO ↔ datetime-local for input compatibility
  const targetIso: string = config.target ?? '';
  const localValue = (() => {
    if (!targetIso) return '';
    const d = new Date(targetIso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();

  const { t } = useI18n();
  return (
    <>
      <Field label={t('dashboards.widgetEdit.label')}>
        <input
          type="text"
          value={config.label ?? ''}
          onChange={(e) => set('label', e.target.value)}
          className={inputClass}
          placeholder={t('dashboards.widgetEdit.countdownLabelPlaceholder')}
        />
      </Field>
      <Field label={t('dashboards.widgetEdit.targetDateTime')}>
        <input
          type="datetime-local"
          value={localValue}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) {
              set('target', '');
              return;
            }
            set('target', new Date(v).toISOString());
          }}
          className={inputClass}
        />
      </Field>
      <Field label={t('dashboards.widgetEdit.accentColor')}>
        <input
          type="color"
          value={config.accent ?? '#facc15'}
          onChange={(e) => set('accent', e.target.value)}
          className="h-9 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1"
        />
      </Field>
    </>
  );
}

function ImageWidgetForm({ config, set }: { config: any; set: (k: string, v: any) => void }) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('dashboards.widgetEdit.imageUrl')} hint={t('dashboards.widgetEdit.imageUrlHint')}>
        <input
          type="url"
          value={config.url ?? ''}
          onChange={(e) => set('url', e.target.value)}
          className={inputClass}
          placeholder="https://…"
        />
      </Field>
      <Field label={t('dashboards.widgetEdit.altText')}>
        <input
          type="text"
          value={config.alt ?? ''}
          onChange={(e) => set('alt', e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label={t('dashboards.widgetEdit.fit')}>
        <select value={config.fit ?? 'contain'} onChange={(e) => set('fit', e.target.value)} className={inputClass}>
          <option value="contain">{t('dashboards.widgetEdit.fitContain')}</option>
          <option value="cover">{t('dashboards.widgetEdit.fitCover')}</option>
        </select>
      </Field>
      {config.url ? (
        <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={config.url} alt={config.alt ?? ''} className="max-h-48 w-full" style={{ objectFit: config.fit ?? 'contain' }} />
        </div>
      ) : null}
    </>
  );
}

function ShapeWidgetForm({ config, set }: { config: any; set: (k: string, v: any) => void }) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('dashboards.widgetEdit.kind')}>
        <select value={config.kind ?? 'rect'} onChange={(e) => set('kind', e.target.value)} className={inputClass}>
          <option value="rect">{t('dashboards.widgetEdit.kindRectangle')}</option>
          <option value="circle">{t('dashboards.widgetEdit.kindCircle')}</option>
          <option value="line">{t('dashboards.widgetEdit.kindLine')}</option>
          <option value="divider">{t('dashboards.widgetEdit.kindDivider')}</option>
        </select>
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t('dashboards.widgetEdit.color')}>
          <input
            type="color"
            value={config.color ?? '#94a3b8'}
            onChange={(e) => set('color', e.target.value)}
            className="h-9 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1"
          />
        </Field>
        <Field label={t('dashboards.widgetEdit.radiusPx')}>
          <input
            type="number"
            min={0}
            max={64}
            value={config.radius ?? 8}
            onChange={(e) => set('radius', Number(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label={t('dashboards.widgetEdit.opacity')}>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={config.opacity ?? 0.85}
            onChange={(e) => set('opacity', Number(e.target.value))}
            className={inputClass}
          />
        </Field>
      </div>
    </>
  );
}

function ParameterSwitcherForm({
  config,
  setConfig,
}: {
  config: any;
  setConfig: React.Dispatch<React.SetStateAction<Record<string, any>>>;
}) {
  const { t } = useI18n();
  const options: Array<{ label: string; value: string }> = Array.isArray(config.options) ? config.options : [];
  const updateOption = (i: number, patch: Partial<{ label: string; value: string }>) => {
    const next = options.map((o, idx) => (idx === i ? { ...o, ...patch } : o));
    setConfig((prev) => ({ ...prev, options: next }));
  };
  const addOption = () => {
    setConfig((prev) => ({
      ...prev,
      options: [...(Array.isArray(prev.options) ? prev.options : []), { label: '', value: '' }],
    }));
  };
  const removeOption = (i: number) => {
    setConfig((prev) => ({
      ...prev,
      options: (Array.isArray(prev.options) ? prev.options : []).filter((_: any, idx: number) => idx !== i),
    }));
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('dashboards.widgetEdit.parameterName')} hint={t('dashboards.widgetEdit.parameterNameHint')}>
          <input
            type="text"
            value={config.paramName ?? ''}
            onChange={(e) => setConfig((p) => ({ ...p, paramName: e.target.value }))}
            className={inputClass}
            placeholder="period"
          />
        </Field>
        <Field label={t('dashboards.widgetEdit.label')}>
          <input
            type="text"
            value={config.label ?? ''}
            onChange={(e) => setConfig((p) => ({ ...p, label: e.target.value }))}
            className={inputClass}
            placeholder={t('dashboards.widgetEdit.parameterLabelPlaceholder')}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('dashboards.widgetEdit.layout')}>
          <select
            value={config.layout ?? 'tabs'}
            onChange={(e) => setConfig((p) => ({ ...p, layout: e.target.value }))}
            className={inputClass}
          >
            <option value="tabs">{t('dashboards.widgetEdit.layoutTabs')}</option>
            <option value="dropdown">{t('dashboards.widgetEdit.layoutDropdown')}</option>
          </select>
        </Field>
        <Field
          label={t('dashboards.widgetEdit.paramFilterColumn')}
          hint={t('dashboards.widgetEdit.paramFilterColumnHint')}
        >
          <input
            type="text"
            value={config.field ?? ''}
            onChange={(e) => setConfig((p) => ({ ...p, field: e.target.value }))}
            className={inputClass}
            placeholder="order_status"
          />
        </Field>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[12px] font-[510] text-text-secondary">{t('dashboards.widgetEdit.options')}</label>
          <button
            type="button"
            onClick={addOption}
            className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-[11px] font-[510] text-text-secondary hover:bg-surface-2"
          >
            <Plus className="h-3 w-3" /> {t('dashboards.widgetEdit.addOption')}
          </button>
        </div>
        <div className="space-y-2">
          {options.length === 0 && (
            <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-[12px] text-text-tertiary">
              {t('dashboards.widgetEdit.noOptions')}
            </p>
          )}
          {options.map((opt, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
              <input
                type="text"
                placeholder={t('dashboards.widgetEdit.optionLabelPlaceholder')}
                value={opt.label ?? ''}
                onChange={(e) => updateOption(i, { label: e.target.value })}
                className={inputClass}
              />
              <input
                type="text"
                placeholder={t('dashboards.widgetEdit.optionValuePlaceholder')}
                value={opt.value ?? ''}
                onChange={(e) => updateOption(i, { value: e.target.value })}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => removeOption(i)}
                className="rounded-md p-1.5 text-text-quaternary hover:bg-danger/10 hover:text-danger"
                title={t('dashboards.widgetEdit.removeOption')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
