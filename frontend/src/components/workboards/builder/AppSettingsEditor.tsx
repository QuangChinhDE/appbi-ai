/**
 * App-settings SECTION components — the building blocks of the Workboard
 * Settings tab (app/(main)/workboards/[id]/settings/page.tsx).
 *
 * Every section is pure: it takes the mini-app layout (or the dataset list)
 * plus an onChange / onDatasetChange callback and renders controls. The
 * Settings page owns the state + autosave; these just render and emit.
 *
 * (This file previously also exported an "App settings" MODAL opened from the
 * Build canvas. That modal was removed — Build is only for building; app
 * settings live in the Settings tab.)
 */
'use client';

import React, { useEffect, useState } from 'react';
import {
  Check,
  MessageSquare,
  Monitor,
  Navigation,
  Palette,
  PanelLeft,
  RotateCcw,
  Smartphone,
} from 'lucide-react';

import type {
  MiniAppLayoutSpec,
  BrandingSpec,
  ExperienceSpec,
  PrintTemplateSpec,
  ScreenPresentationSpec,
  ScreenSpec,
  ThemeBackgroundSpec,
  ThemeMode,
  ThemeFont,
  AutoNumberConfigSpec,
} from './types';
import { INPUT, Lbl } from './ScreenEditor';
import { GRADIENT_PRESETS } from '@/lib/wb-theme';
import { THEME_PRESETS } from './themePresets';
import type { Dataset } from '@/hooks/use-datasets';
import { useI18n } from '@/providers/LanguageProvider';

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name?: string;
  columns: { name: string; type?: string }[];
}

// ── Dataset picker (Settings › Data) ───────────────────────────────────────
export function DatasetSection({
  datasets,
  currentDatasetId,
  datasetChangePending,
  onDatasetChange,
}: {
  datasets: Dataset[];
  currentDatasetId: number;
  datasetChangePending?: boolean;
  onDatasetChange: (datasetId: number) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [selectedDatasetId, setSelectedDatasetId] = useState(currentDatasetId);
  useEffect(() => {
    setSelectedDatasetId(currentDatasetId);
  }, [currentDatasetId]);
  const datasetChanged = selectedDatasetId !== currentDatasetId;
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <Lbl label={t('workboards.settings.datasetCurrent')}>
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
          {datasetChangePending ? t('workboards.settings.datasetChanging') : t('workboards.settings.changeDataset')}
        </button>
      </div>
      {datasetChanged && (
        <p className="mt-2 text-caption text-warning">
          {t('workboards.settings.datasetChangeWarning')}
        </p>
      )}
    </div>
  );
}

// ── Navigation (Settings › Navigation) ──────────────────────────────────────
export function NavigationSection({
  layout,
  onChange,
}: {
  layout: MiniAppLayoutSpec;
  onChange: (next: MiniAppLayoutSpec) => void;
}) {
  const { t } = useI18n();
  const nav = layout.mini_app_nav;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center gap-2 text-caption font-medium text-text-secondary">
          <Smartphone className="h-4 w-4" />
          {t('workboards.settings.mobile')}
        </div>
        <SegmentedControl
          value={nav.mobile_kind}
          onChange={(mobile_kind) => onChange({ ...layout, mini_app_nav: { ...nav, mobile_kind } })}
          options={[
            { value: 'bottom_nav', label: t('workboards.settings.nav.bottomNav') },
            { value: 'drawer', label: t('workboards.settings.nav.drawer') },
          ]}
        />
      </div>
      <div>
        <div className="mb-2 flex items-center gap-2 text-caption font-medium text-text-secondary">
          <Monitor className="h-4 w-4" />
          {t('workboards.settings.desktop')}
        </div>
        <SegmentedControl
          value={nav.desktop_kind}
          onChange={(desktop_kind) => onChange({ ...layout, mini_app_nav: { ...nav, desktop_kind } })}
          options={[
            { value: 'sidebar', label: t('workboards.settings.nav.sidebar') },
            { value: 'top_tabs', label: t('workboards.settings.nav.topTabs') },
          ]}
        />
      </div>
    </div>
  );
}



// ── Theme / design-system editor ────────────────────────────────────────

const SECTION_H =
  'mb-2 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function SettingsPanel({
  icon,
  title,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        'rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-4',
        className,
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        {icon ? (
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-brand/10 text-brand">
            {icon}
          </span>
        ) : null}
        <h3 className="text-caption font-emphasis text-text-primary">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{
    value: T;
    label: string;
    icon?: React.ReactNode;
  }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cx(
              'flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-left text-caption transition-colors',
              active
                ? 'border-brand/40 bg-brand/10 text-brand'
                : 'border-[rgb(var(--border-line))] bg-surface-0 text-text-secondary hover:border-brand/30 hover:text-text-primary',
            )}
          >
            {option.icon ? <span className="shrink-0">{option.icon}</span> : null}
            <span className="font-medium">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Downscale + compress an uploaded image to a bounded data-URI (CSP-safe). */
function compressImageToDataUri(file: File, maxKb = 200): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        const maxDim = 1600;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const s = maxDim / Math.max(width, height);
          width = Math.round(width * s);
          height = Math.round(height * s);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('no ctx'));
        ctx.drawImage(img, 0, 0, width, height);
        let q = 0.82;
        let out = canvas.toDataURL('image/jpeg', q);
        while (out.length / 1024 > maxKb && q > 0.3) {
          q -= 0.12;
          out = canvas.toDataURL('image/jpeg', q);
        }
        resolve(out);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

function ColorField({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value?: string | null;
  fallback: string;
  onChange: (hex: string) => void;
}) {
  return (
    <Lbl label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || fallback}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-10 cursor-pointer rounded border border-[rgb(var(--border-line))] bg-transparent p-0.5"
        />
        <input
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
          placeholder={fallback}
        />
      </div>
    </Lbl>
  );
}

function BackgroundEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: ThemeBackgroundSpec | null;
  onChange: (bg: ThemeBackgroundSpec | null) => void;
}) {
  const { t } = useI18n();
  const bg = value || { kind: 'color' as const };
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] p-2">
      <div className="grid grid-cols-2 gap-3">
        <Lbl label={label}>
          <select
            value={bg.kind}
            onChange={(e) =>
              onChange({ ...bg, kind: e.target.value as ThemeBackgroundSpec['kind'] })
            }
            className={INPUT}
          >
            <option value="color">{t('workboards.settings.background.color')}</option>
            <option value="gradient">{t('workboards.settings.background.gradient')}</option>
            <option value="image">{t('workboards.settings.background.image')}</option>
          </select>
        </Lbl>
        {bg.kind === 'color' && (
          <ColorField
            label={t('workboards.settings.background.colorLabel')}
            value={bg.color}
            fallback="#f1f5f9"
            onChange={(hex) => onChange({ ...bg, color: hex })}
          />
        )}
        {bg.kind === 'gradient' && (
          <Lbl label={t('workboards.settings.background.gradientPreset')}>
            <select
              value={bg.gradient_preset || 'ocean'}
              onChange={(e) => onChange({ ...bg, gradient_preset: e.target.value })}
              className={INPUT}
            >
              {Object.keys(GRADIENT_PRESETS).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Lbl>
        )}
      </div>
      {bg.kind === 'gradient' && (
        <div
          className="mt-2 h-8 rounded"
          style={{ backgroundImage: GRADIENT_PRESETS[bg.gradient_preset || 'ocean'] }}
        />
      )}
      {bg.kind === 'image' && (
        <div className="mt-2">
          <input
            type="file"
            accept="image/*"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setUploadErr(null);
              try {
                const uri = await compressImageToDataUri(f, 200);
                onChange({ ...bg, image_data: uri });
              } catch {
                setUploadErr(t('workboards.settings.imageReadFailed'));
              }
            }}
            className="text-caption"
          />
          {uploadErr && <p className="mt-1 text-caption text-status-danger">{uploadErr}</p>}
          {bg.image_data && (
            <div
              className="mt-2 h-16 rounded border border-[rgb(var(--border-line))]"
              style={{
                backgroundImage: `url(${bg.image_data})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            />
          )}
          <p className="mt-1 text-caption text-text-tertiary">
            {t('workboards.settings.background.imageHint')}
          </p>
        </div>
      )}
    </div>
  );
}

export function PrintTemplateSection({
  layout,
  onChange,
}: {
  layout: MiniAppLayoutSpec;
  onChange: (next: MiniAppLayoutSpec) => void;
}) {
  const { t } = useI18n();
  const pt: PrintTemplateSpec = layout.print_template || {};
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const set = (patch: Partial<PrintTemplateSpec>) =>
    onChange({ ...layout, print_template: { ...pt, ...patch } });
  return (
    <section>
      <h3 className={SECTION_H}>{t('workboards.settings.printTemplateHeading')}</h3>
      <p className="mb-2 text-caption text-text-tertiary">
        {t('workboards.settings.printTemplateDescription')}
      </p>
      <label className="mb-2 flex items-center gap-2 text-caption text-text-secondary">
        <input
          type="checkbox"
          checked={pt.enabled !== false}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        {t('workboards.settings.enableLetterhead')}
      </label>
      <div className="grid grid-cols-2 gap-3">
        <Lbl label={t('workboards.settings.companyName')}>
          <input value={pt.company_name || ''} onChange={(e) => set({ company_name: e.target.value })} className={INPUT} placeholder={t('workboards.settings.companyNamePlaceholder')} />
        </Lbl>
        <Lbl label={t('workboards.settings.taxCode')}>
          <input value={pt.tax_code || ''} onChange={(e) => set({ tax_code: e.target.value })} className={INPUT} />
        </Lbl>
        <Lbl label={t('workboards.settings.address')}>
          <input value={pt.address || ''} onChange={(e) => set({ address: e.target.value })} className={INPUT} />
        </Lbl>
        <Lbl label={t('workboards.settings.hotline')}>
          <input value={pt.hotline || ''} onChange={(e) => set({ hotline: e.target.value })} className={INPUT} />
        </Lbl>
        <Lbl label={t('workboards.settings.email')}>
          <input value={pt.email || ''} onChange={(e) => set({ email: e.target.value })} className={INPUT} />
        </Lbl>
        <Lbl label={t('workboards.settings.website')}>
          <input value={pt.website || ''} onChange={(e) => set({ website: e.target.value })} className={INPUT} />
        </Lbl>
        <Lbl label={t('workboards.settings.footerNote')}>
          <input value={pt.footer_note || ''} onChange={(e) => set({ footer_note: e.target.value })} className={INPUT} />
        </Lbl>
        <ColorField
          label={t('workboards.settings.letterheadAccent')}
          value={pt.accent_color}
          fallback="#0f766e"
          onChange={(hex) => set({ accent_color: hex })}
        />
      </div>
      <div className="mt-2">
        <Lbl label={t('workboards.settings.letterheadLogo')}>
          <input
            type="file"
            accept="image/*"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setLogoErr(null);
              try {
                set({ logo_data: await compressImageToDataUri(f, 120) });
              } catch {
                setLogoErr(t('workboards.settings.imageReadFailed'));
              }
            }}
            className="text-caption"
          />
        </Lbl>
        {logoErr && <p className="mt-1 text-caption text-status-danger">{logoErr}</p>}
        {pt.logo_data && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={pt.logo_data} alt={t('workboards.settings.logoAlt')} className="mt-1 h-12 rounded object-contain" />
        )}
      </div>
    </section>
  );
}

export function ThemeSection({
  layout,
  onChange,
}: {
  layout: MiniAppLayoutSpec;
  onChange: (next: MiniAppLayoutSpec) => void;
}) {
  const { t } = useI18n();
  const branding: BrandingSpec = layout.branding || {};
  const set = (patch: Partial<BrandingSpec>) =>
    onChange({ ...layout, branding: { ...branding, ...patch } });
  const card = branding.card_style || {};
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const logoPreview = branding.logo_data || branding.logo_url || '';

  return (
    <>
      <section>
        <h3 className={SECTION_H}>{t('workboards.settings.branding')}</h3>
        <div className="grid grid-cols-2 gap-3">
          <Lbl label={t('workboards.settings.appName')}>
            <input
              value={branding.app_name || ''}
              onChange={(e) => set({ app_name: e.target.value })}
              className={INPUT}
              placeholder={t('workboards.settings.brandingAppNamePlaceholder')}
            />
          </Lbl>
          <Lbl label={t('workboards.settings.logoUrl')}>
            <input
              value={branding.logo_url || ''}
              onChange={(e) => set({ logo_url: e.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label={t('workboards.settings.headerLogoLayout')}>
            <select
              value={branding.logo_layout || 'mark'}
              onChange={(e) => set({ logo_layout: e.target.value as 'mark' | 'wide' })}
              className={INPUT}
            >
              <option value="mark">{t('workboards.settings.logoMark')}</option>
              <option value="wide">{t('workboards.settings.logoWide')}</option>
            </select>
          </Lbl>
          <div className="col-span-2 rounded-lg border border-[rgb(var(--border-line))] bg-[rgb(var(--surface-subtle))] p-3">
            <div className="flex flex-wrap items-center gap-3">
              <Lbl label={t('workboards.settings.uploadAppLogo')}>
                <input
                  type="file"
                  accept="image/*"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setLogoErr(null);
                    try {
                      set({ logo_data: await compressImageToDataUri(f, 120) });
                    } catch {
                      setLogoErr(t('workboards.settings.imageReadFailed'));
                    }
                  }}
                  className="text-caption"
                />
              </Lbl>
              {logoPreview && (
                <div
                  className={`flex h-11 items-center justify-center overflow-hidden rounded-lg bg-white p-1 ring-1 ring-[rgb(var(--border-line))] ${
                    branding.logo_layout === 'wide' ? 'w-28' : 'w-11'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={logoPreview} alt={t('workboards.settings.logoPreviewAlt')} className="h-full w-full object-contain" />
                </div>
              )}
              {branding.logo_data && (
                <button
                  type="button"
                  onClick={() => set({ logo_data: null })}
                  className="rounded-md border border-[rgb(var(--border-line))] bg-[rgb(var(--surface-base))] px-2 py-1 text-caption text-text-secondary hover:bg-[rgb(var(--surface-hover))]"
                >
                  {t('workboards.settings.clearUploadedLogo')}
                </button>
              )}
            </div>
            {logoErr && <p className="mt-1 text-caption text-status-danger">{logoErr}</p>}
            <p className="mt-2 text-caption text-text-tertiary">
              {t('workboards.settings.logoHint')}
            </p>
          </div>
          <Lbl label={t('workboards.settings.loginWelcome')}>
            <input
              value={branding.welcome_text || ''}
              onChange={(e) => set({ welcome_text: e.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label={t('workboards.settings.loginTagline')}>
            <input
              value={branding.login?.tagline || ''}
              onChange={(e) =>
                set({ login: { ...(branding.login || {}), tagline: e.target.value } })
              }
              className={INPUT}
            />
          </Lbl>
        </div>
      </section>

      <section>
        <h3 className={SECTION_H}>{t('workboards.settings.colorsMode')}</h3>
        <div className="grid grid-cols-2 gap-3">
          <ColorField
            label={t('workboards.settings.primaryColor')}
            value={branding.primary_color}
            fallback="#2563eb"
            onChange={(hex) => set({ primary_color: hex })}
          />
          <ColorField
            label={t('workboards.settings.accentColor')}
            value={branding.accent_color}
            fallback="#2563eb"
            onChange={(hex) => set({ accent_color: hex })}
          />
          <Lbl label={t('workboards.settings.mode')}>
            <select
              value={branding.theme || 'auto'}
              onChange={(e) => set({ theme: e.target.value as ThemeMode })}
              className={INPUT}
            >
              <option value="auto">{t('workboards.settings.modeAuto')}</option>
              <option value="light">{t('workboards.settings.modeLight')}</option>
              <option value="dark">{t('workboards.settings.modeDark')}</option>
            </select>
          </Lbl>
          <Lbl label={t('workboards.settings.font')}>
            <select
              value={branding.font_family || 'system'}
              onChange={(e) => set({ font_family: e.target.value as ThemeFont })}
              className={INPUT}
            >
              <option value="system">{t('workboards.settings.systemFont')}</option>
              <option value="inter">Inter</option>
              <option value="be-vietnam">Be Vietnam Pro</option>
              <option value="roboto">Roboto</option>
              <option value="serif">{t('workboards.settings.font.serif')}</option>
              <option value="mono">{t('workboards.settings.font.mono')}</option>
            </select>
          </Lbl>
        </div>
      </section>

      <section>
        <h3 className={SECTION_H}>{t('workboards.settings.appBackground')}</h3>
        <BackgroundEditor
          label={t('workboards.settings.backgroundType')}
          value={branding.background}
          onChange={(bg) => set({ background: bg })}
        />
      </section>

      <section>
        <h3 className={SECTION_H}>{t('workboards.settings.cardsHeader')}</h3>
        <div className="grid grid-cols-3 gap-3">
          <Lbl label={t('workboards.settings.cardRadius')}>
            <select
              value={card.radius || 'lg'}
              onChange={(e) =>
                set({ card_style: { ...card, radius: e.target.value as never } })
              }
              className={INPUT}
            >
              <option value="none">{t('workboards.settings.none')}</option>
              <option value="sm">{t('workboards.settings.sizeSmall')}</option>
              <option value="md">{t('workboards.settings.sizeMedium')}</option>
              <option value="lg">{t('workboards.settings.sizeLarge')}</option>
              <option value="xl">{t('workboards.settings.sizeExtraLarge')}</option>
            </select>
          </Lbl>
          <Lbl label={t('workboards.settings.shadow')}>
            <select
              value={card.shadow || 'sm'}
              onChange={(e) =>
                set({ card_style: { ...card, shadow: e.target.value as never } })
              }
              className={INPUT}
            >
              <option value="none">{t('workboards.settings.none')}</option>
              <option value="sm">{t('workboards.settings.shadowLight')}</option>
              <option value="md">{t('workboards.settings.shadowStrong')}</option>
            </select>
          </Lbl>
          <Lbl label={t('workboards.settings.headerStyle')}>
            <select
              value={branding.header_style || 'line'}
              onChange={(e) => set({ header_style: e.target.value as never })}
              className={INPUT}
            >
              <option value="line">{t('workboards.settings.headerLine')}</option>
              <option value="fill">{t('workboards.settings.headerFill')}</option>
              <option value="minimal">{t('workboards.settings.headerMinimal')}</option>
            </select>
          </Lbl>
        </div>
      </section>

      <section>
        <h3 className={SECTION_H}>{t('workboards.settings.loginBackground')}</h3>
        <BackgroundEditor
          label={t('workboards.settings.loginBackgroundType')}
          value={branding.login?.background}
          onChange={(bg) => set({ login: { ...(branding.login || {}), background: bg } })}
        />
      </section>
    </>
  );
}


export function AutoNumberSection({
  layout,
  tables = [],
  onChange,
}: {
  layout: MiniAppLayoutSpec;
  tables?: DatasetTableInfo[];
  onChange: (next: MiniAppLayoutSpec) => void;
}) {
  const { t } = useI18n();
  const configs = layout.auto_number_columns || [];
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const update = (next: typeof configs) =>
    onChange({ ...layout, auto_number_columns: next });
  const patch = (idx: number, changes: Partial<AutoNumberConfigSpec>) => {
    const next = [...configs];
    next[idx] = { ...next[idx], ...changes };
    update(next);
  };
  const columnsFor = (tableId?: number | null) =>
    tableId ? tables.find((t) => t.id === tableId)?.columns || [] : [];
  const toggleExpanded = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };
  return (
    <section>
      <h3 className="mb-2 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
        {t('workboards.settings.autoNumberColumns')}
      </h3>
      <p className="mb-3 text-caption text-text-tertiary">
        {t('workboards.settings.autoNumberDescriptionPrefix')}{' '}
        <code>{'{YYYY}{MM}{DD}'}</code> {t('workboards.settings.and')}{' '}
        <code>{'{N:4}'}</code> {t('workboards.settings.autoNumberDescriptionMiddle')}
        {t('workboards.settings.autoNumberDescriptionSuffix')}
      </p>
      <div className="space-y-2">
        {configs.map((cfg, idx) => {
          const cols = columnsFor(cfg.table_id);
          const isOpen = expanded.has(idx);
          const scopeCols = cfg.scope_columns || [];
          return (
            <div
              key={idx}
              className="rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2"
            >
              <div className="grid grid-cols-12 gap-2">
                <select
                  value={cfg.table_id || ''}
                  onChange={(e) => patch(idx, { table_id: Number(e.target.value) || null })}
                  className={`${INPUT} col-span-3`}
                  title={t('workboards.settings.autoNumberTableTitle')}
                >
                  <option value="">{t('workboards.settings.allTablesLegacy')}</option>
                  {tables.map((table) => (
                    <option key={table.id} value={table.id}>
                      {table.display_name}
                    </option>
                  ))}
                </select>
                <input
                  value={cfg.column}
                  onChange={(e) => patch(idx, { column: e.target.value })}
                  placeholder={t('workboards.settings.columnPlaceholder')}
                  className={`${INPUT} col-span-3`}
                  list={`auto-number-columns-${idx}`}
                />
                {cfg.table_id ? (
                  <datalist id={`auto-number-columns-${idx}`}>
                    {cols.map((column) => (
                      <option key={column.name} value={column.name} />
                    ))}
                  </datalist>
                ) : null}
                <input
                  value={cfg.pattern}
                  onChange={(e) => patch(idx, { pattern: e.target.value })}
                  placeholder="PO-{YYYY}{MM}{DD}-{N:4}"
                  className={`${INPUT} col-span-3`}
                />
                <select
                  value={cfg.reset || 'never'}
                  onChange={(e) =>
                    patch(idx, {
                      reset: e.target.value as 'never' | 'daily' | 'monthly' | 'yearly',
                    })
                  }
                  className={`${INPUT} col-span-2`}
                >
                  <option value="never">{t('workboards.settings.resetNever')}</option>
                  <option value="daily">{t('workboards.settings.resetDaily')}</option>
                  <option value="monthly">{t('workboards.settings.resetMonthly')}</option>
                  <option value="yearly">{t('workboards.settings.resetYearly')}</option>
                </select>
                <button
                  type="button"
                  onClick={() => update(configs.filter((_, i) => i !== idx))}
                  className="col-span-1 rounded-md text-caption text-status-danger hover:bg-status-danger/10"
                  title={t('common.delete')}
                >
                  ×
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggleExpanded(idx)}
                  className="text-tiny font-medium text-brand-600 hover:underline"
                >
                  {isOpen ? '▾' : '▸'} {t('workboards.settings.scopePolicy')}
                  {scopeCols.length > 0 ? (
                    <span className="ml-1 rounded bg-brand-50 px-1 text-brand-700">
                      {t('workboards.settings.scopeColumnCount', { count: scopeCols.length })}
                    </span>
                  ) : null}
                </button>
              </div>
              {isOpen ? (
                <div className="mt-2 space-y-3 rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-3">
                  {/* Scope columns */}
                  <div>
                    <div className="mb-1 text-tiny font-medium text-text-secondary">
                      {t('workboards.settings.scopeColumns')}
                    </div>
                    {cols.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {cols.map((column) => {
                          const on = scopeCols.includes(column.name);
                          return (
                            <button
                              key={column.name}
                              type="button"
                              onClick={() =>
                                patch(idx, {
                                  scope_columns: on
                                    ? scopeCols.filter((c) => c !== column.name)
                                    : [...scopeCols, column.name],
                                })
                              }
                              className={`rounded-full border px-2 py-0.5 text-tiny ${
                                on
                                  ? 'border-brand-500 bg-brand-50 text-brand-700'
                                  : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2'
                              }`}
                            >
                              {column.name}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-tiny text-text-tertiary">
                        {t('workboards.settings.pickSpecificTable')}
                      </p>
                    )}
                    <p className="mt-1 text-tiny text-text-tertiary">
                      {t('workboards.settings.scopeHint')}
                    </p>
                  </div>
                  {/* Date column */}
                  <label className="block">
                    <div className="mb-1 text-tiny font-medium text-text-secondary">
                      {t('workboards.settings.dateColumn')}
                    </div>
                    <select
                      value={cfg.date_column || ''}
                      onChange={(e) => patch(idx, { date_column: e.target.value || null })}
                      className={INPUT}
                    >
                      <option value="">{t('workboards.settings.entryTime')}</option>
                      {cols.map((column) => (
                        <option key={column.name} value={column.name}>
                          {column.name}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-tiny text-text-tertiary">
                      {t('workboards.settings.dateColumnHint')}
                    </p>
                  </label>
                  {/* Policies */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <label className="flex items-center gap-2 text-tiny text-text-secondary">
                      <input
                        type="checkbox"
                        checked={cfg.allow_manual_override !== false}
                        onChange={(e) => patch(idx, { allow_manual_override: e.target.checked })}
                        className="h-3.5 w-3.5"
                      />
                      {t('workboards.settings.allowManualOverride')}
                    </label>
                    <label className="block">
                      <div className="mb-1 text-tiny font-medium text-text-secondary">
                        {t('workboards.settings.whenMissingScope')}
                      </div>
                      <select
                        value={cfg.missing_scope_behavior || 'empty'}
                        onChange={(e) =>
                          patch(idx, {
                            missing_scope_behavior: e.target.value as 'empty' | 'error',
                          })
                        }
                        className={INPUT}
                      >
                        <option value="empty">{t('workboards.settings.leaveEmptySkip')}</option>
                        <option value="error">{t('workboards.settings.errorBlockSave')}</option>
                      </select>
                    </label>
                    <label className="block">
                      <div className="mb-1 text-tiny font-medium text-text-secondary">
                        {t('workboards.settings.whenNumberingFails')}
                      </div>
                      <select
                        value={cfg.on_error || 'leave_blank'}
                        onChange={(e) =>
                          patch(idx, {
                            on_error: e.target.value as 'leave_blank' | 'block',
                          })
                        }
                        className={INPUT}
                      >
                        <option value="leave_blank">{t('workboards.settings.leaveBlankSave')}</option>
                        <option value="block">{t('workboards.settings.blockSave')}</option>
                      </select>
                    </label>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() =>
            update([
              ...configs,
              { table_id: null, column: '', pattern: 'PO-{YYYY}{MM}{DD}-{N:4}', reset: 'never' },
            ])
          }
          className="rounded-md border border-dashed border-[rgb(var(--border-line))] px-3 py-1.5 text-caption text-text-secondary hover:bg-surface-2"
        >
          {t('workboards.settings.addAutoNumberColumn')}
        </button>
      </div>
    </section>
  );
}

// ── Experience Studio (v1 presentation contract) ───────────────────────────
// Edits layout.experience — the app-wide presentation contract. Additive +
// cosmetic; never touches fields/columns/RLS/actions. Resolved server-side so
// old boards (no experience block) render identically via the legacy adapter.
type StudioCategory = 'theme' | 'shell' | 'navigation' | 'screen' | 'feedback';
type ExperienceTheme = NonNullable<ExperienceSpec['theme']>;
type ExperienceShell = NonNullable<ExperienceSpec['shell']>;
type ExperienceNavigation = NonNullable<ExperienceSpec['navigation']>;
type ExperienceFeedback = NonNullable<ExperienceSpec['feedback']>;

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

function ColorTokenField({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: string;
  onChange: (next?: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value || '');
  useEffect(() => setDraft(value || ''), [value]);
  const valid = draft === '' || /^#[0-9a-fA-F]{6}$/.test(draft);
  const commit = () => {
    if (valid) onChange(draft || undefined);
  };
  return (
    <label className="grid grid-cols-[2.25rem_5rem_minmax(0,1fr)] items-center gap-2">
      <input
        type="color"
        aria-label={t('workboards.settings.pickColor', { label })}
        value={valid && draft ? draft : '#64748b'}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(event.target.value);
        }}
        className="h-8 w-9 cursor-pointer rounded-md border border-[rgb(var(--border-line))] bg-transparent p-0.5"
      />
      <span className="text-tiny font-medium text-text-secondary">{label}</span>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className={`${INPUT} font-mono ${valid ? '' : 'border-danger'}`}
        placeholder={t('workboards.settings.inherit')}
      />
    </label>
  );
}

function TriStateSelect({
  value,
  onChange,
}: {
  value?: boolean;
  onChange: (next?: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <select
      value={value === undefined ? '' : value ? 'true' : 'false'}
      onChange={(event) =>
        onChange(event.target.value === '' ? undefined : event.target.value === 'true')
      }
      className={INPUT}
    >
      <option value="">{t('workboards.settings.inherit')}</option>
      <option value="true">{t('workboards.settings.enabled')}</option>
      <option value="false">{t('workboards.settings.disabled')}</option>
    </select>
  );
}

export function ExperienceStudioSection({
  layout,
  onChange,
  screen,
  onScreenChange,
  disabled = false,
}: {
  layout: MiniAppLayoutSpec;
  onChange: (next: MiniAppLayoutSpec) => void;
  screen?: ScreenSpec | null;
  onScreenChange?: (next: ScreenSpec) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [category, setCategory] = useState<StudioCategory>('theme');
  const exp: ExperienceSpec = layout.experience || {};
  const theme = exp.theme || {};
  const shell = exp.shell || {};
  const nav = exp.navigation || {};
  const feedback = exp.feedback || {};
  const presentation = screen?.presentation || {};

  useEffect(() => {
    if (category === 'screen' && !screen) setCategory('theme');
  }, [category, screen]);

  const writeExperience = (next: ExperienceSpec) => {
    const cleaned: ExperienceSpec = { ...next };
    for (const key of ['theme', 'shell', 'navigation', 'feedback'] as const) {
      const section = cleaned[key];
      if (section && Object.keys(withoutUndefined(section)).length === 0) delete cleaned[key];
    }
    const meaningful = Boolean(
      cleaned.preset ||
        cleaned.theme ||
        cleaned.shell ||
        cleaned.navigation ||
        cleaned.feedback,
    );
    const nextLayout = { ...layout };
    if (meaningful) nextLayout.experience = { ...cleaned, schema_version: 1 };
    else delete nextLayout.experience;
    onChange(nextLayout);
  };

  const setTheme = (patch: Partial<ExperienceTheme>) =>
    writeExperience({
      ...exp,
      theme: withoutUndefined({ ...theme, ...patch }) as ExperienceTheme,
    });
  const setShell = (patch: Partial<ExperienceShell>) =>
    writeExperience({
      ...exp,
      shell: withoutUndefined({ ...shell, ...patch }) as ExperienceShell,
    });
  const setNav = (patch: Partial<ExperienceNavigation>) =>
    writeExperience({
      ...exp,
      navigation: withoutUndefined({ ...nav, ...patch }) as ExperienceNavigation,
    });
  const setFeedback = (patch: Partial<ExperienceFeedback>) =>
    writeExperience({
      ...exp,
      feedback: withoutUndefined({ ...feedback, ...patch }) as ExperienceFeedback,
    });
  const resetCategory = () => {
    if (category === 'screen') {
      if (screen && onScreenChange) onScreenChange({ ...screen, presentation: null });
      return;
    }
    const next = { ...exp };
    delete next[category];
    writeExperience(next);
  };
  const setPresentation = (patch: Partial<ScreenPresentationSpec>) => {
    if (!screen || !onScreenChange) return;
    const next = withoutUndefined({ ...presentation, ...patch }) as ScreenPresentationSpec;
    onScreenChange({ ...screen, presentation: Object.keys(next).length ? next : null });
  };
  const setFormPresentation = (
    patch: Partial<NonNullable<ScreenPresentationSpec['form']>>,
  ) => {
    const next = withoutUndefined({ ...(presentation.form || {}), ...patch });
    setPresentation({
      form: Object.keys(next).length
        ? (next as NonNullable<ScreenPresentationSpec['form']>)
        : undefined,
    });
  };
  const setTablePresentation = (
    patch: Partial<NonNullable<ScreenPresentationSpec['table']>>,
  ) => {
    const next = withoutUndefined({ ...(presentation.table || {}), ...patch });
    setPresentation({
      table: Object.keys(next).length
        ? (next as NonNullable<ScreenPresentationSpec['table']>)
        : undefined,
    });
  };

  const categories: Array<{
    id: StudioCategory;
    label: string;
    icon: React.ElementType;
    hidden?: boolean;
  }> = [
    { id: 'theme', label: t('workboards.settings.experience.theme'), icon: Palette },
    { id: 'shell', label: t('workboards.settings.experience.shell'), icon: PanelLeft },
    { id: 'navigation', label: t('workboards.settings.experience.navigation'), icon: Navigation },
    { id: 'screen', label: t('workboards.settings.experience.screen'), icon: Monitor, hidden: !screen },
    { id: 'feedback', label: t('workboards.settings.experience.feedback'), icon: MessageSquare },
  ];

  const COLOR_TOKENS: Array<[keyof ExperienceTheme, string]> = [
    ['primary', t('workboards.settings.color.primary')],
    ['success', t('workboards.settings.color.success')],
    ['warning', t('workboards.settings.color.warning')],
    ['danger', t('workboards.settings.color.danger')],
    ['info', t('workboards.settings.color.info')],
    ['neutral', t('workboards.settings.color.neutral')],
    ['background', t('workboards.settings.color.background')],
    ['surface', t('workboards.settings.color.surface')],
    ['border', t('workboards.settings.color.border')],
    ['text', t('workboards.settings.color.text')],
  ];

  return (
    <div className="flex min-h-[560px] flex-col overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 md:flex-row">
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[rgb(var(--border-line))] bg-surface-1 p-2 md:w-40 md:flex-col md:border-b-0 md:border-r">
        {categories.filter((item) => !item.hidden).map((item) => {
          const Icon = item.icon;
          const active = category === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setCategory(item.id)}
              className={`flex min-h-10 shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-caption font-medium transition-colors ${
                active
                  ? 'bg-brand/10 text-brand'
                  : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </button>
          );
        })}
      </nav>

      <fieldset disabled={disabled} className="min-w-0 flex-1">
        <div className="sticky top-0 z-10 flex min-h-12 items-center justify-between border-b border-[rgb(var(--border-line))] bg-surface-0/95 px-4 backdrop-blur">
          <div className="min-w-0">
            <h3 className="truncate text-caption font-emphasis text-text-primary">
              {category === 'screen'
                ? screen?.title || t('workboards.settings.experience.currentScreen')
                : categories.find((item) => item.id === category)?.label}
            </h3>
            {category === 'screen' && (
              <span className="text-tiny uppercase text-text-quaternary">{screen?.kind}</span>
            )}
          </div>
          <button
            type="button"
            onClick={resetCategory}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-tiny font-medium text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('workboards.settings.inherit')}
          </button>
        </div>

        <div className="space-y-6 p-4">
          {category === 'theme' && (
            <>
              <section>
                <h4 className={SECTION_H}>{t('workboards.settings.themePresets')}</h4>
                <p className="mb-2 text-tiny text-text-tertiary">
                  {t('workboards.settings.themePresetsHint')}
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {THEME_PRESETS.map((preset) => {
                    const active = exp.preset === preset.id;
                    const p = preset.theme;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() =>
                          writeExperience({ ...exp, preset: preset.id, theme: { ...p } })
                        }
                        className={`rounded-lg border p-2 text-left transition-colors ${
                          active
                            ? 'border-brand ring-1 ring-brand'
                            : 'border-[rgb(var(--border-line))] hover:bg-surface-2'
                        }`}
                      >
                        {/* Mini app-preview: background frame → surface card with
                            a primary dot, a text line and accent chips. */}
                        <div
                          className="mb-1.5 rounded-md p-1.5"
                          style={{ background: p.background }}
                        >
                          <div
                            className="flex items-center gap-1 rounded p-1.5"
                            style={{ background: p.surface, border: `1px solid ${p.border}` }}
                          >
                            <span
                              className="h-3 w-3 shrink-0 rounded-full"
                              style={{ background: p.primary }}
                            />
                            <span
                              className="h-1.5 flex-1 rounded"
                              style={{ background: p.text, opacity: 0.7 }}
                            />
                            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: p.info }} />
                            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: p.success }} />
                            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: p.danger }} />
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-caption font-emphasis text-text-primary">
                            {preset.name}
                          </span>
                          {active && <Check className="h-3.5 w-3.5 text-brand" />}
                        </div>
                        <span className="mt-0.5 block text-tiny leading-snug text-text-tertiary">
                          {preset.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
              <section>
                <h4 className={SECTION_H}>{t('workboards.settings.semanticColors')}</h4>
                <div className="grid gap-2 lg:grid-cols-2">
                  {COLOR_TOKENS.map(([key, label]) => (
                    <ColorTokenField
                      key={key}
                      label={label}
                      value={theme[key] as string | undefined}
                      onChange={(value) =>
                        setTheme({ [key]: value } as Partial<ExperienceTheme>)
                      }
                    />
                  ))}
                </div>
              </section>
              <section className="grid gap-3 border-t border-[rgb(var(--border-line))] pt-5 sm:grid-cols-2">
                <Lbl label={t('workboards.settings.font')}>
                  <select
                    value={theme.font_family || ''}
                    onChange={(event) => setTheme({ font_family: event.target.value || undefined })}
                    className={INPUT}
                  >
                    <option value="">{t('workboards.settings.inherit')}</option>
                    <option value="system">{t('workboards.settings.systemFont')}</option>
                    <option value="inter">Inter</option>
                    <option value="be-vietnam">Be Vietnam Pro</option>
                    <option value="roboto">Roboto</option>
                    <option value="serif">{t('workboards.settings.font.serif')}</option>
                    <option value="mono">{t('workboards.settings.font.mono')}</option>
                  </select>
                </Lbl>
                <Lbl label={t('workboards.settings.mode')}>
                  <select
                    value={theme.mode || ''}
                    onChange={(event) =>
                      setTheme({ mode: (event.target.value || undefined) as ExperienceTheme['mode'] })
                    }
                    className={INPUT}
                  >
                    <option value="">{t('workboards.settings.inherit')}</option>
                    <option value="auto">{t('workboards.settings.modeAuto')}</option>
                    <option value="light">{t('workboards.settings.modeLight')}</option>
                    <option value="dark">{t('workboards.settings.modeDark')}</option>
                  </select>
                </Lbl>
                <Lbl label={t('workboards.settings.density')}>
                  <select
                    value={theme.density || ''}
                    onChange={(event) =>
                      setTheme({ density: (event.target.value || undefined) as ExperienceTheme['density'] })
                    }
                    className={INPUT}
                  >
                    <option value="">{t('workboards.settings.inherit')}</option>
                    <option value="compact">{t('workboards.settings.option.compact')}</option>
                    <option value="cozy">{t('workboards.settings.option.cozy')}</option>
                    <option value="comfortable">{t('workboards.settings.option.comfortable')}</option>
                  </select>
                </Lbl>
                <Lbl label={t('workboards.settings.radius')}>
                  <select
                    value={theme.radius || ''}
                    onChange={(event) =>
                      setTheme({ radius: (event.target.value || undefined) as ExperienceTheme['radius'] })
                    }
                    className={INPUT}
                  >
                    <option value="">{t('workboards.settings.inherit')}</option>
                    <option value="none">{t('workboards.settings.option.none')}</option>
                    <option value="small">{t('workboards.settings.option.small')}</option>
                    <option value="medium">{t('workboards.settings.option.medium')}</option>
                    <option value="large">{t('workboards.settings.option.large')}</option>
                    <option value="full">{t('workboards.settings.option.full')}</option>
                  </select>
                </Lbl>
                <Lbl label={t('workboards.settings.elevation')}>
                  <select
                    value={theme.elevation || ''}
                    onChange={(event) =>
                      setTheme({ elevation: (event.target.value || undefined) as ExperienceTheme['elevation'] })
                    }
                    className={INPUT}
                  >
                    <option value="">{t('workboards.settings.inherit')}</option>
                    <option value="none">{t('workboards.settings.option.none')}</option>
                    <option value="small">{t('workboards.settings.option.small')}</option>
                    <option value="medium">{t('workboards.settings.option.medium')}</option>
                    <option value="large">{t('workboards.settings.option.large')}</option>
                  </select>
                </Lbl>
                <Lbl label={t('workboards.settings.motion')}>
                  <select
                    value={theme.motion || ''}
                    onChange={(event) =>
                      setTheme({ motion: (event.target.value || undefined) as ExperienceTheme['motion'] })
                    }
                    className={INPUT}
                  >
                    <option value="">{t('workboards.settings.inherit')}</option>
                    <option value="instant">{t('workboards.settings.option.instant')}</option>
                    <option value="standard">{t('workboards.settings.option.standard')}</option>
                    <option value="expressive">{t('workboards.settings.option.expressive')}</option>
                  </select>
                </Lbl>
              </section>
            </>
          )}

          {category === 'shell' && (
            <section className="grid gap-3 sm:grid-cols-2">
              <Lbl label={t('workboards.settings.contentWidth')}>
                <select
                  value={shell.content_width || ''}
                  onChange={(event) =>
                    setShell({ content_width: (event.target.value || undefined) as ExperienceShell['content_width'] })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.settings.inherit')}</option>
                  <option value="full_bleed">{t('workboards.settings.option.fullBleed')}</option>
                  <option value="constrained">{t('workboards.settings.option.constrained')}</option>
                  <option value="wide">{t('workboards.settings.option.wide')}</option>
                </select>
              </Lbl>
              <Lbl label={t('workboards.settings.pagePadding')}>
                <select
                  value={shell.page_padding || ''}
                  onChange={(event) =>
                    setShell({ page_padding: (event.target.value || undefined) as ExperienceShell['page_padding'] })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.settings.inherit')}</option>
                  <option value="compact">{t('workboards.settings.option.compact')}</option>
                  <option value="cozy">{t('workboards.settings.option.cozy')}</option>
                  <option value="comfortable">{t('workboards.settings.option.comfortable')}</option>
                </select>
              </Lbl>
              <Lbl label={t('workboards.settings.appBackground')}>
                <select
                  value={shell.background || ''}
                  onChange={(event) =>
                    setShell({ background: (event.target.value || undefined) as ExperienceShell['background'] })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.settings.inherit')}</option>
                  <option value="light">{t('workboards.settings.modeLight')}</option>
                  <option value="gray">{t('workboards.settings.grayLight')}</option>
                  <option value="dark">{t('workboards.settings.modeDark')}</option>
                  <option value="custom">{t('workboards.settings.custom')}</option>
                </select>
              </Lbl>
              <Lbl label={t('workboards.settings.customBackgroundColor')}>
                <ColorTokenField
                  label={t('workboards.settings.colorValue')}
                  value={theme.app_background || undefined}
                  onChange={(value) => setTheme({ app_background: value })}
                />
              </Lbl>
              <Lbl label={t('workboards.settings.stickyHeader')}>
                <TriStateSelect
                  value={shell.sticky_header}
                  onChange={(sticky_header) => setShell({ sticky_header })}
                />
              </Lbl>
              <Lbl label={t('workboards.settings.showSearch')}>
                <TriStateSelect
                  value={shell.show_search}
                  onChange={(show_search) => setShell({ show_search })}
                />
              </Lbl>
              <Lbl label={t('workboards.settings.showLogo')}>
                <TriStateSelect value={shell.show_logo} onChange={(show_logo) => setShell({ show_logo })} />
              </Lbl>
              <Lbl label={t('workboards.settings.showFooter')}>
                <TriStateSelect
                  value={shell.footer_enabled}
                  onChange={(footer_enabled) => setShell({ footer_enabled })}
                />
              </Lbl>
            </section>
          )}

          {category === 'navigation' && (
            <section className="grid gap-3 sm:grid-cols-2">
              <Lbl label={t('workboards.settings.desktop')}>
                <select
                  value={nav.desktop_kind || ''}
                  onChange={(event) =>
                    setNav({ desktop_kind: (event.target.value || undefined) as ExperienceNavigation['desktop_kind'] })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.settings.inherit')}</option>
                  <option value="sidebar">{t('workboards.settings.nav.sidebar')}</option>
                  <option value="top_tabs">{t('workboards.settings.nav.topTabs')}</option>
                  <option value="compact_rail">{t('workboards.settings.nav.compactRail')}</option>
                </select>
              </Lbl>
              <Lbl label={t('workboards.settings.mobile')}>
                <select
                  value={nav.mobile_kind || ''}
                  onChange={(event) =>
                    setNav({ mobile_kind: (event.target.value || undefined) as ExperienceNavigation['mobile_kind'] })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.settings.inherit')}</option>
                  <option value="bottom_nav">{t('workboards.settings.nav.bottomNav')}</option>
                  <option value="drawer">{t('workboards.settings.nav.drawer')}</option>
                </select>
              </Lbl>
              <Lbl label={t('workboards.settings.activeStyle')}>
                <select
                  value={nav.active_style || ''}
                  onChange={(event) =>
                    setNav({ active_style: (event.target.value || undefined) as ExperienceNavigation['active_style'] })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.settings.inherit')}</option>
                  <option value="pill">{t('workboards.settings.option.pill')}</option>
                  <option value="bar">{t('workboards.settings.option.bar')}</option>
                  <option value="highlight">{t('workboards.settings.option.highlight')}</option>
                </select>
              </Lbl>
              <Lbl label={t('workboards.settings.sidebarWidth')}>
                <input
                  type="number"
                  min={180}
                  max={400}
                  value={nav.sidebar_width ?? ''}
                  onChange={(event) =>
                    setNav({
                      sidebar_width: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                  className={INPUT}
                  placeholder={t('workboards.settings.inherit')}
                />
              </Lbl>
              <Lbl label={t('workboards.settings.defaultCollapsed')}>
                <TriStateSelect
                  value={nav.default_collapsed}
                  onChange={(default_collapsed) => setNav({ default_collapsed })}
                />
              </Lbl>
              <Lbl label={t('workboards.settings.showIcons')}>
                <TriStateSelect value={nav.show_icons} onChange={(show_icons) => setNav({ show_icons })} />
              </Lbl>
              <Lbl label={t('workboards.settings.showLabels')}>
                <TriStateSelect value={nav.show_labels} onChange={(show_labels) => setNav({ show_labels })} />
              </Lbl>
              <Lbl label={t('workboards.settings.breadcrumbs')}>
                <TriStateSelect
                  value={nav.breadcrumbs}
                  onChange={(breadcrumbs) => setNav({ breadcrumbs })}
                />
              </Lbl>
            </section>
          )}

          {category === 'feedback' && (
            <section className="grid gap-3 sm:grid-cols-2">
              <Lbl label={t('workboards.settings.loadingState')}>
                <select
                  value={feedback.loading || ''}
                  onChange={(event) =>
                    setFeedback({ loading: (event.target.value || undefined) as ExperienceFeedback['loading'] })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.settings.inherit')}</option>
                  <option value="skeleton">{t('workboards.settings.option.skeleton')}</option>
                  <option value="spinner">{t('workboards.settings.option.spinner')}</option>
                </select>
              </Lbl>
              <Lbl label={t('workboards.settings.emptyState')}>
                <select
                  value={feedback.empty_style || ''}
                  onChange={(event) =>
                    setFeedback({ empty_style: (event.target.value || undefined) as ExperienceFeedback['empty_style'] })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.settings.inherit')}</option>
                  <option value="illustration">{t('workboards.settings.option.illustration')}</option>
                  <option value="message">{t('workboards.settings.option.message')}</option>
                  <option value="minimal">{t('workboards.settings.option.minimal')}</option>
                </select>
              </Lbl>
              <Lbl label={t('workboards.settings.successFeedback')}>
                <select
                  value={feedback.success || ''}
                  onChange={(event) =>
                    setFeedback({ success: (event.target.value || undefined) as ExperienceFeedback['success'] })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.settings.inherit')}</option>
                  <option value="toast">{t('workboards.settings.option.toast')}</option>
                  <option value="inline">{t('workboards.settings.option.inline')}</option>
                  <option value="banner">{t('workboards.settings.option.banner')}</option>
                </select>
              </Lbl>
              <Lbl label={t('workboards.settings.allowRetry')}>
                <TriStateSelect
                  value={feedback.error_retry}
                  onChange={(error_retry) => setFeedback({ error_retry })}
                />
              </Lbl>
              <Lbl label={t('workboards.settings.motionDurationMs')}>
                <input
                  type="number"
                  min={0}
                  max={1000}
                  step={20}
                  value={feedback.motion_ms ?? ''}
                  onChange={(event) =>
                    setFeedback({
                      motion_ms: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                  className={INPUT}
                  placeholder={t('workboards.settings.inherit')}
                />
              </Lbl>
            </section>
          )}

          {category === 'screen' && screen && (
            <>
              <section className="grid gap-3 sm:grid-cols-2">
                <Lbl label={t('workboards.settings.contentWidth')}>
                  <select
                    value={presentation.content_width || ''}
                    onChange={(event) =>
                      setPresentation({
                        content_width: (event.target.value || undefined) as ScreenPresentationSpec['content_width'],
                      })
                    }
                    className={INPUT}
                  >
                    <option value="">{t('workboards.settings.followApp')}</option>
                    <option value="narrow">{t('workboards.settings.option.narrow')}</option>
                    <option value="standard">{t('workboards.settings.option.standard')}</option>
                    <option value="wide">{t('workboards.settings.option.wide')}</option>
                  </select>
                </Lbl>
                <Lbl label={t('workboards.settings.density')}>
                  <select
                    value={presentation.density || ''}
                    onChange={(event) =>
                      setPresentation({
                        density: (event.target.value || undefined) as ScreenPresentationSpec['density'],
                      })
                    }
                    className={INPUT}
                  >
                    <option value="">{t('workboards.settings.followApp')}</option>
                    <option value="compact">{t('workboards.settings.option.compact')}</option>
                    <option value="cozy">{t('workboards.settings.option.cozy')}</option>
                    <option value="comfortable">{t('workboards.settings.option.comfortable')}</option>
                  </select>
                </Lbl>
                <Lbl label={t('workboards.settings.paddingPx')}>
                  <input
                    type="number"
                    min={0}
                    max={64}
                    value={presentation.page_padding ?? ''}
                    onChange={(event) =>
                      setPresentation({
                        page_padding: event.target.value ? Number(event.target.value) : undefined,
                      })
                    }
                    className={INPUT}
                    placeholder={t('workboards.settings.followApp')}
                  />
                </Lbl>
                <Lbl label={t('workboards.settings.cardRadiusPx')}>
                  <input
                    type="number"
                    min={0}
                    max={32}
                    value={presentation.card_radius ?? ''}
                    onChange={(event) =>
                      setPresentation({
                        card_radius: event.target.value ? Number(event.target.value) : undefined,
                      })
                    }
                    className={INPUT}
                    placeholder={t('workboards.settings.followApp')}
                  />
                </Lbl>
                <Lbl label={t('workboards.settings.elevation')}>
                  <select
                    value={presentation.shadow || ''}
                    onChange={(event) =>
                      setPresentation({
                        shadow: (event.target.value || undefined) as ScreenPresentationSpec['shadow'],
                      })
                    }
                    className={INPUT}
                  >
                    <option value="">{t('workboards.settings.followApp')}</option>
                    <option value="none">{t('workboards.settings.option.none')}</option>
                    <option value="small">{t('workboards.settings.option.small')}</option>
                    <option value="medium">{t('workboards.settings.option.medium')}</option>
                    <option value="large">{t('workboards.settings.option.large')}</option>
                  </select>
                </Lbl>
                <Lbl label={t('workboards.settings.motion')}>
                  <select
                    value={presentation.motion || ''}
                    onChange={(event) =>
                      setPresentation({
                        motion: (event.target.value || undefined) as ScreenPresentationSpec['motion'],
                      })
                    }
                    className={INPUT}
                  >
                    <option value="">{t('workboards.settings.followApp')}</option>
                    <option value="instant">{t('workboards.settings.option.instant')}</option>
                    <option value="standard">{t('workboards.settings.option.standard')}</option>
                    <option value="expressive">{t('workboards.settings.option.expressive')}</option>
                  </select>
                </Lbl>
              </section>

              {screen.kind === 'form' && (
                <section className="grid gap-3 border-t border-[rgb(var(--border-line))] pt-5 sm:grid-cols-2">
                  <Lbl label={t('workboards.settings.columnCountLabel')}>
                    <select
                      value={presentation.form?.columns || ''}
                      onChange={(event) =>
                        setFormPresentation({
                          columns: event.target.value
                            ? (Number(event.target.value) as 1 | 2 | 3)
                            : undefined,
                        })
                      }
                      className={INPUT}
                    >
                      <option value="">{t('workboards.settings.auto')}</option>
                      <option value="1">{t('workboards.settings.oneColumn')}</option>
                      <option value="2">{t('workboards.settings.twoColumns')}</option>
                      <option value="3">{t('workboards.settings.threeColumns')}</option>
                    </select>
                  </Lbl>
                  <Lbl label={t('workboards.settings.sectionStyle')}>
                    <select
                      value={presentation.form?.section_style || ''}
                      onChange={(event) =>
                        setFormPresentation({
                          section_style: (event.target.value || undefined) as NonNullable<ScreenPresentationSpec['form']>['section_style'],
                        })
                      }
                      className={INPUT}
                    >
                      <option value="">{t('workboards.settings.option.plain')}</option>
                      <option value="divided">{t('workboards.settings.option.divided')}</option>
                      <option value="surface">{t('workboards.settings.option.surface')}</option>
                    </select>
                  </Lbl>
                  <Lbl label={t('workboards.settings.stickyActionBar')}>
                    <TriStateSelect
                      value={presentation.sticky_action_bar}
                      onChange={(sticky_action_bar) => setPresentation({ sticky_action_bar })}
                    />
                  </Lbl>
                </section>
              )}

              {screen.kind === 'table' && (
                <section className="grid gap-3 border-t border-[rgb(var(--border-line))] pt-5 sm:grid-cols-2">
                  <Lbl label={t('workboards.settings.stickyTableHeader')}>
                    <TriStateSelect
                      value={presentation.table?.sticky_header}
                      onChange={(sticky_header) => setTablePresentation({ sticky_header })}
                    />
                  </Lbl>
                  <Lbl label={t('workboards.settings.rowHeight')}>
                    <select
                      value={presentation.table?.row_height || ''}
                      onChange={(event) =>
                        setTablePresentation({
                          row_height: (event.target.value || undefined) as NonNullable<ScreenPresentationSpec['table']>['row_height'],
                        })
                      }
                      className={INPUT}
                    >
                      <option value="">{t('workboards.settings.followApp')}</option>
                      <option value="compact">{t('workboards.settings.option.compact')}</option>
                      <option value="cozy">{t('workboards.settings.option.cozy')}</option>
                      <option value="comfortable">{t('workboards.settings.option.comfortable')}</option>
                    </select>
                  </Lbl>
                  <Lbl label={t('workboards.settings.filterPosition')}>
                    <select
                      value={presentation.table?.filter_position || ''}
                      onChange={(event) =>
                        setTablePresentation({
                          filter_position: (event.target.value || undefined) as NonNullable<ScreenPresentationSpec['table']>['filter_position'],
                        })
                      }
                      className={INPUT}
                    >
                      <option value="">{t('workboards.settings.option.top')}</option>
                      <option value="sticky">{t('workboards.settings.option.stickyTop')}</option>
                    </select>
                  </Lbl>
                </section>
              )}
            </>
          )}
        </div>
      </fieldset>
    </div>
  );
}
