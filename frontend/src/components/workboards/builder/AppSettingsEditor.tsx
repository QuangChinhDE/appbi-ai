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
} from './types';
import { INPUT, Lbl } from './ScreenEditor';
import { GRADIENT_PRESETS } from '@/lib/wb-theme';
import type { Dataset } from '@/hooks/use-datasets';

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
  const [selectedDatasetId, setSelectedDatasetId] = useState(currentDatasetId);
  useEffect(() => {
    setSelectedDatasetId(currentDatasetId);
  }, [currentDatasetId]);
  const datasetChanged = selectedDatasetId !== currentDatasetId;
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <Lbl label="Dataset đang dùng">
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
          {datasetChangePending ? 'Đang đổi...' : 'Đổi dataset'}
        </button>
      </div>
      {datasetChanged && (
        <p className="mt-2 text-caption text-warning">
          Các screen đang trỏ tới bảng ngoài dataset mới sẽ được gỡ để bạn map lại. Bấm “Đổi
          dataset” để xem trước tác động.
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
  const nav = layout.mini_app_nav;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center gap-2 text-caption font-medium text-text-secondary">
          <Smartphone className="h-4 w-4" />
          Mobile
        </div>
        <SegmentedControl
          value={nav.mobile_kind}
          onChange={(mobile_kind) => onChange({ ...layout, mini_app_nav: { ...nav, mobile_kind } })}
          options={[
            { value: 'bottom_nav', label: 'Bottom nav' },
            { value: 'drawer', label: 'Drawer' },
          ]}
        />
      </div>
      <div>
        <div className="mb-2 flex items-center gap-2 text-caption font-medium text-text-secondary">
          <Monitor className="h-4 w-4" />
          Desktop
        </div>
        <SegmentedControl
          value={nav.desktop_kind}
          onChange={(desktop_kind) => onChange({ ...layout, mini_app_nav: { ...nav, desktop_kind } })}
          options={[
            { value: 'sidebar', label: 'Sidebar' },
            { value: 'top_tabs', label: 'Top tabs' },
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
            <option value="color">Màu đơn</option>
            <option value="gradient">Gradient</option>
            <option value="image">Ảnh nền</option>
          </select>
        </Lbl>
        {bg.kind === 'color' && (
          <ColorField
            label="Màu nền"
            value={bg.color}
            fallback="#f1f5f9"
            onChange={(hex) => onChange({ ...bg, color: hex })}
          />
        )}
        {bg.kind === 'gradient' && (
          <Lbl label="Kiểu gradient">
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
                setUploadErr('Không đọc được ảnh.');
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
            Ảnh được nén &amp; nhúng (~200KB) để hợp CSP. URL ngoài bị chặn.
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
  const pt: PrintTemplateSpec = layout.print_template || {};
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const set = (patch: Partial<PrintTemplateSpec>) =>
    onChange({ ...layout, print_template: { ...pt, ...patch } });
  return (
    <section>
      <h3 className={SECTION_H}>Mẫu in / Letterhead (phiếu &amp; báo cáo)</h3>
      <p className="mb-2 text-caption text-text-tertiary">
        Hiện ở đầu mọi tài liệu khi bấm <b>In</b> hoặc <b>Xuất Excel</b> — cấu hình 1 lần, dùng cho tất cả phiếu/báo cáo.
      </p>
      <label className="mb-2 flex items-center gap-2 text-caption text-text-secondary">
        <input
          type="checkbox"
          checked={pt.enabled !== false}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        Bật letterhead
      </label>
      <div className="grid grid-cols-2 gap-3">
        <Lbl label="Tên công ty">
          <input value={pt.company_name || ''} onChange={(e) => set({ company_name: e.target.value })} className={INPUT} placeholder="VD: Công ty ABC" />
        </Lbl>
        <Lbl label="Mã số thuế">
          <input value={pt.tax_code || ''} onChange={(e) => set({ tax_code: e.target.value })} className={INPUT} />
        </Lbl>
        <Lbl label="Địa chỉ">
          <input value={pt.address || ''} onChange={(e) => set({ address: e.target.value })} className={INPUT} />
        </Lbl>
        <Lbl label="Hotline">
          <input value={pt.hotline || ''} onChange={(e) => set({ hotline: e.target.value })} className={INPUT} />
        </Lbl>
        <Lbl label="Email">
          <input value={pt.email || ''} onChange={(e) => set({ email: e.target.value })} className={INPUT} />
        </Lbl>
        <Lbl label="Website">
          <input value={pt.website || ''} onChange={(e) => set({ website: e.target.value })} className={INPUT} />
        </Lbl>
        <Lbl label="Ghi chú chân trang">
          <input value={pt.footer_note || ''} onChange={(e) => set({ footer_note: e.target.value })} className={INPUT} />
        </Lbl>
        <ColorField
          label="Màu nhấn letterhead"
          value={pt.accent_color}
          fallback="#0f766e"
          onChange={(hex) => set({ accent_color: hex })}
        />
      </div>
      <div className="mt-2">
        <Lbl label="Logo (tải ảnh — nhúng, hợp CSP)">
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
                setLogoErr('Không đọc được ảnh.');
              }
            }}
            className="text-caption"
          />
        </Lbl>
        {logoErr && <p className="mt-1 text-caption text-status-danger">{logoErr}</p>}
        {pt.logo_data && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={pt.logo_data} alt="logo" className="mt-1 h-12 rounded object-contain" />
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
  const branding: BrandingSpec = layout.branding || {};
  const set = (patch: Partial<BrandingSpec>) =>
    onChange({ ...layout, branding: { ...branding, ...patch } });
  const card = branding.card_style || {};
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const logoPreview = branding.logo_data || branding.logo_url || '';

  return (
    <>
      <section>
        <h3 className={SECTION_H}>Thương hiệu</h3>
        <div className="grid grid-cols-2 gap-3">
          <Lbl label="Tên app">
            <input
              value={branding.app_name || ''}
              onChange={(e) => set({ app_name: e.target.value })}
              className={INPUT}
              placeholder="VD: Nhật ký sản xuất"
            />
          </Lbl>
          <Lbl label="Logo URL">
            <input
              value={branding.logo_url || ''}
              onChange={(e) => set({ logo_url: e.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Kiểu logo header">
            <select
              value={branding.logo_layout || 'mark'}
              onChange={(e) => set({ logo_layout: e.target.value as 'mark' | 'wide' })}
              className={INPUT}
            >
              <option value="mark">Biểu tượng vuông</option>
              <option value="wide">Logo ngang</option>
            </select>
          </Lbl>
          <div className="col-span-2 rounded-lg border border-[rgb(var(--border-line))] bg-[rgb(var(--surface-subtle))] p-3">
            <div className="flex flex-wrap items-center gap-3">
              <Lbl label="Upload logo app (nhúng, hợp CSP)">
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
                      setLogoErr('Không đọc được ảnh.');
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
                  <img src={logoPreview} alt="logo preview" className="h-full w-full object-contain" />
                </div>
              )}
              {branding.logo_data && (
                <button
                  type="button"
                  onClick={() => set({ logo_data: null })}
                  className="rounded-md border border-[rgb(var(--border-line))] bg-[rgb(var(--surface-base))] px-2 py-1 text-caption text-text-secondary hover:bg-[rgb(var(--surface-hover))]"
                >
                  Xóa logo upload
                </button>
              )}
            </div>
            {logoErr && <p className="mt-1 text-caption text-status-danger">{logoErr}</p>}
            <p className="mt-2 text-caption text-text-tertiary">
              Logo vuông phù hợp icon app; logo ngang phù hợp thương hiệu dạng banner. Banner in/PDF nên đặt ở mục Letterhead bên dưới.
            </p>
          </div>
          <Lbl label="Lời chào (trang login)">
            <input
              value={branding.welcome_text || ''}
              onChange={(e) => set({ welcome_text: e.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Tagline login">
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
        <h3 className={SECTION_H}>Màu &amp; chế độ</h3>
        <div className="grid grid-cols-2 gap-3">
          <ColorField
            label="Màu chính"
            value={branding.primary_color}
            fallback="#2563eb"
            onChange={(hex) => set({ primary_color: hex })}
          />
          <ColorField
            label="Màu nhấn (accent)"
            value={branding.accent_color}
            fallback="#2563eb"
            onChange={(hex) => set({ accent_color: hex })}
          />
          <Lbl label="Chế độ">
            <select
              value={branding.theme || 'auto'}
              onChange={(e) => set({ theme: e.target.value as ThemeMode })}
              className={INPUT}
            >
              <option value="auto">Tự động (theo máy)</option>
              <option value="light">Sáng</option>
              <option value="dark">Tối</option>
            </select>
          </Lbl>
          <Lbl label="Phông chữ">
            <select
              value={branding.font_family || 'system'}
              onChange={(e) => set({ font_family: e.target.value as ThemeFont })}
              className={INPUT}
            >
              <option value="system">Hệ thống</option>
              <option value="inter">Inter</option>
              <option value="be-vietnam">Be Vietnam Pro</option>
              <option value="roboto">Roboto</option>
              <option value="serif">Serif</option>
              <option value="mono">Mono</option>
            </select>
          </Lbl>
        </div>
      </section>

      <section>
        <h3 className={SECTION_H}>Nền app</h3>
        <BackgroundEditor
          label="Kiểu nền"
          value={branding.background}
          onChange={(bg) => set({ background: bg })}
        />
      </section>

      <section>
        <h3 className={SECTION_H}>Thẻ &amp; header</h3>
        <div className="grid grid-cols-3 gap-3">
          <Lbl label="Bo góc thẻ">
            <select
              value={card.radius || 'lg'}
              onChange={(e) =>
                set({ card_style: { ...card, radius: e.target.value as never } })
              }
              className={INPUT}
            >
              <option value="none">Không</option>
              <option value="sm">Nhỏ</option>
              <option value="md">Vừa</option>
              <option value="lg">Lớn</option>
              <option value="xl">Rất lớn</option>
            </select>
          </Lbl>
          <Lbl label="Đổ bóng">
            <select
              value={card.shadow || 'sm'}
              onChange={(e) =>
                set({ card_style: { ...card, shadow: e.target.value as never } })
              }
              className={INPUT}
            >
              <option value="none">Không</option>
              <option value="sm">Nhẹ</option>
              <option value="md">Rõ</option>
            </select>
          </Lbl>
          <Lbl label="Kiểu header">
            <select
              value={branding.header_style || 'line'}
              onChange={(e) => set({ header_style: e.target.value as never })}
              className={INPUT}
            >
              <option value="line">Viền dưới</option>
              <option value="fill">Nền màu</option>
              <option value="minimal">Tối giản</option>
            </select>
          </Lbl>
        </div>
      </section>

      <section>
        <h3 className={SECTION_H}>Nền trang login (tuỳ chọn)</h3>
        <BackgroundEditor
          label="Kiểu nền login"
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
            <select
              value={cfg.table_id || ''}
              onChange={(e) => {
                const next = [...configs];
                const tableId = Number(e.target.value) || null;
                next[idx] = { ...cfg, table_id: tableId };
                update(next);
              }}
              className={`${INPUT} col-span-3`}
              title="Scope this sequence to one table, or keep legacy all-table behaviour."
            >
              <option value="">All tables (legacy)</option>
              {tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.display_name}
                </option>
              ))}
            </select>
            <input
              value={cfg.column}
              onChange={(e) => {
                const next = [...configs];
                next[idx] = { ...cfg, column: e.target.value };
                update(next);
              }}
              placeholder="column"
              className={`${INPUT} col-span-3`}
              list={`auto-number-columns-${idx}`}
            />
            {cfg.table_id ? (
              <datalist id={`auto-number-columns-${idx}`}>
                {(tables.find((table) => table.id === cfg.table_id)?.columns || []).map((column) => (
                  <option key={column.name} value={column.name} />
                ))}
              </datalist>
            ) : null}
            <input
              value={cfg.pattern}
              onChange={(e) => {
                const next = [...configs];
                next[idx] = { ...cfg, pattern: e.target.value };
                update(next);
              }}
              placeholder="PO-{YYYY}{MM}{DD}-{N:4}"
              className={`${INPUT} col-span-3`}
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
              className={`${INPUT} col-span-2`}
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
              { table_id: null, column: '', pattern: 'PO-{YYYY}{MM}{DD}-{N:4}', reset: 'never' },
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
        aria-label={`Chọn màu ${label}`}
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
        placeholder="Kế thừa"
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
  return (
    <select
      value={value === undefined ? '' : value ? 'true' : 'false'}
      onChange={(event) =>
        onChange(event.target.value === '' ? undefined : event.target.value === 'true')
      }
      className={INPUT}
    >
      <option value="">Kế thừa</option>
      <option value="true">Bật</option>
      <option value="false">Tắt</option>
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
    { id: 'theme', label: 'Theme', icon: Palette },
    { id: 'shell', label: 'Shell', icon: PanelLeft },
    { id: 'navigation', label: 'Navigation', icon: Navigation },
    { id: 'screen', label: 'Screen', icon: Monitor, hidden: !screen },
    { id: 'feedback', label: 'Feedback', icon: MessageSquare },
  ];

  const COLOR_TOKENS: Array<[keyof ExperienceTheme, string]> = [
    ['primary', 'Primary'],
    ['success', 'Success'],
    ['warning', 'Warning'],
    ['danger', 'Danger'],
    ['info', 'Info'],
    ['neutral', 'Neutral'],
    ['background', 'Background'],
    ['surface', 'Surface'],
    ['border', 'Border'],
    ['text', 'Text'],
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
              {category === 'screen' ? screen?.title || 'Current screen' : categories.find((item) => item.id === category)?.label}
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
            Kế thừa
          </button>
        </div>

        <div className="space-y-6 p-4">
          {category === 'theme' && (
            <>
              <section>
                <h4 className={SECTION_H}>Semantic colors</h4>
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
                <Lbl label="Font chữ">
                  <select
                    value={theme.font_family || ''}
                    onChange={(event) => setTheme({ font_family: event.target.value || undefined })}
                    className={INPUT}
                  >
                    <option value="">Kế thừa</option>
                    <option value="system">System</option>
                    <option value="inter">Inter</option>
                    <option value="be-vietnam">Be Vietnam Pro</option>
                    <option value="roboto">Roboto</option>
                    <option value="serif">Serif</option>
                    <option value="mono">Mono</option>
                  </select>
                </Lbl>
                <Lbl label="Chế độ">
                  <select
                    value={theme.mode || ''}
                    onChange={(event) =>
                      setTheme({ mode: (event.target.value || undefined) as ExperienceTheme['mode'] })
                    }
                    className={INPUT}
                  >
                    <option value="">Kế thừa</option>
                    <option value="auto">Auto</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </Lbl>
                <Lbl label="Mật độ">
                  <select
                    value={theme.density || ''}
                    onChange={(event) =>
                      setTheme({ density: (event.target.value || undefined) as ExperienceTheme['density'] })
                    }
                    className={INPUT}
                  >
                    <option value="">Kế thừa</option>
                    <option value="compact">Compact</option>
                    <option value="cozy">Cozy</option>
                    <option value="comfortable">Comfortable</option>
                  </select>
                </Lbl>
                <Lbl label="Bo góc">
                  <select
                    value={theme.radius || ''}
                    onChange={(event) =>
                      setTheme({ radius: (event.target.value || undefined) as ExperienceTheme['radius'] })
                    }
                    className={INPUT}
                  >
                    <option value="">Kế thừa</option>
                    <option value="none">None</option>
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                    <option value="full">Full</option>
                  </select>
                </Lbl>
                <Lbl label="Độ nổi">
                  <select
                    value={theme.elevation || ''}
                    onChange={(event) =>
                      setTheme({ elevation: (event.target.value || undefined) as ExperienceTheme['elevation'] })
                    }
                    className={INPUT}
                  >
                    <option value="">Kế thừa</option>
                    <option value="none">None</option>
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </Lbl>
                <Lbl label="Chuyển động">
                  <select
                    value={theme.motion || ''}
                    onChange={(event) =>
                      setTheme({ motion: (event.target.value || undefined) as ExperienceTheme['motion'] })
                    }
                    className={INPUT}
                  >
                    <option value="">Kế thừa</option>
                    <option value="instant">Instant</option>
                    <option value="standard">Standard</option>
                    <option value="expressive">Expressive</option>
                  </select>
                </Lbl>
              </section>
            </>
          )}

          {category === 'shell' && (
            <section className="grid gap-3 sm:grid-cols-2">
              <Lbl label="Bề rộng nội dung">
                <select
                  value={shell.content_width || ''}
                  onChange={(event) =>
                    setShell({ content_width: (event.target.value || undefined) as ExperienceShell['content_width'] })
                  }
                  className={INPUT}
                >
                  <option value="">Kế thừa</option>
                  <option value="full_bleed">Full bleed</option>
                  <option value="constrained">Constrained</option>
                  <option value="wide">Wide</option>
                </select>
              </Lbl>
              <Lbl label="Khoảng đệm trang">
                <select
                  value={shell.page_padding || ''}
                  onChange={(event) =>
                    setShell({ page_padding: (event.target.value || undefined) as ExperienceShell['page_padding'] })
                  }
                  className={INPUT}
                >
                  <option value="">Kế thừa</option>
                  <option value="compact">Compact</option>
                  <option value="cozy">Cozy</option>
                  <option value="comfortable">Comfortable</option>
                </select>
              </Lbl>
              <Lbl label="Nền ứng dụng">
                <select
                  value={shell.background || ''}
                  onChange={(event) =>
                    setShell({ background: (event.target.value || undefined) as ExperienceShell['background'] })
                  }
                  className={INPUT}
                >
                  <option value="">Kế thừa</option>
                  <option value="light">Sáng</option>
                  <option value="gray">Xám nhạt</option>
                  <option value="dark">Tối</option>
                  <option value="custom">Tùy chỉnh</option>
                </select>
              </Lbl>
              <Lbl label="Màu nền tùy chỉnh">
                <ColorTokenField
                  label="Color"
                  value={theme.app_background || undefined}
                  onChange={(value) => setTheme({ app_background: value })}
                />
              </Lbl>
              <Lbl label="Sticky header">
                <TriStateSelect
                  value={shell.sticky_header}
                  onChange={(sticky_header) => setShell({ sticky_header })}
                />
              </Lbl>
              <Lbl label="Hiện tìm kiếm">
                <TriStateSelect
                  value={shell.show_search}
                  onChange={(show_search) => setShell({ show_search })}
                />
              </Lbl>
              <Lbl label="Hiện logo">
                <TriStateSelect value={shell.show_logo} onChange={(show_logo) => setShell({ show_logo })} />
              </Lbl>
              <Lbl label="Hiện footer">
                <TriStateSelect
                  value={shell.footer_enabled}
                  onChange={(footer_enabled) => setShell({ footer_enabled })}
                />
              </Lbl>
            </section>
          )}

          {category === 'navigation' && (
            <section className="grid gap-3 sm:grid-cols-2">
              <Lbl label="Desktop">
                <select
                  value={nav.desktop_kind || ''}
                  onChange={(event) =>
                    setNav({ desktop_kind: (event.target.value || undefined) as ExperienceNavigation['desktop_kind'] })
                  }
                  className={INPUT}
                >
                  <option value="">Kế thừa</option>
                  <option value="sidebar">Sidebar</option>
                  <option value="top_tabs">Top tabs</option>
                  <option value="compact_rail">Compact rail</option>
                </select>
              </Lbl>
              <Lbl label="Mobile">
                <select
                  value={nav.mobile_kind || ''}
                  onChange={(event) =>
                    setNav({ mobile_kind: (event.target.value || undefined) as ExperienceNavigation['mobile_kind'] })
                  }
                  className={INPUT}
                >
                  <option value="">Kế thừa</option>
                  <option value="bottom_nav">Bottom nav</option>
                  <option value="drawer">Drawer</option>
                </select>
              </Lbl>
              <Lbl label="Kiểu active">
                <select
                  value={nav.active_style || ''}
                  onChange={(event) =>
                    setNav({ active_style: (event.target.value || undefined) as ExperienceNavigation['active_style'] })
                  }
                  className={INPUT}
                >
                  <option value="">Kế thừa</option>
                  <option value="pill">Pill</option>
                  <option value="bar">Bar</option>
                  <option value="highlight">Highlight</option>
                </select>
              </Lbl>
              <Lbl label="Bề rộng sidebar">
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
                  placeholder="Kế thừa"
                />
              </Lbl>
              <Lbl label="Mặc định thu gọn">
                <TriStateSelect
                  value={nav.default_collapsed}
                  onChange={(default_collapsed) => setNav({ default_collapsed })}
                />
              </Lbl>
              <Lbl label="Hiện icon">
                <TriStateSelect value={nav.show_icons} onChange={(show_icons) => setNav({ show_icons })} />
              </Lbl>
              <Lbl label="Hiện nhãn">
                <TriStateSelect value={nav.show_labels} onChange={(show_labels) => setNav({ show_labels })} />
              </Lbl>
              <Lbl label="Breadcrumbs">
                <TriStateSelect
                  value={nav.breadcrumbs}
                  onChange={(breadcrumbs) => setNav({ breadcrumbs })}
                />
              </Lbl>
            </section>
          )}

          {category === 'feedback' && (
            <section className="grid gap-3 sm:grid-cols-2">
              <Lbl label="Loading">
                <select
                  value={feedback.loading || ''}
                  onChange={(event) =>
                    setFeedback({ loading: (event.target.value || undefined) as ExperienceFeedback['loading'] })
                  }
                  className={INPUT}
                >
                  <option value="">Kế thừa</option>
                  <option value="skeleton">Skeleton</option>
                  <option value="spinner">Spinner</option>
                </select>
              </Lbl>
              <Lbl label="Empty state">
                <select
                  value={feedback.empty_style || ''}
                  onChange={(event) =>
                    setFeedback({ empty_style: (event.target.value || undefined) as ExperienceFeedback['empty_style'] })
                  }
                  className={INPUT}
                >
                  <option value="">Kế thừa</option>
                  <option value="illustration">Illustration</option>
                  <option value="message">Message</option>
                  <option value="minimal">Minimal</option>
                </select>
              </Lbl>
              <Lbl label="Success feedback">
                <select
                  value={feedback.success || ''}
                  onChange={(event) =>
                    setFeedback({ success: (event.target.value || undefined) as ExperienceFeedback['success'] })
                  }
                  className={INPUT}
                >
                  <option value="">Kế thừa</option>
                  <option value="toast">Toast</option>
                  <option value="inline">Inline</option>
                  <option value="banner">Banner</option>
                </select>
              </Lbl>
              <Lbl label="Cho phép thử lại">
                <TriStateSelect
                  value={feedback.error_retry}
                  onChange={(error_retry) => setFeedback({ error_retry })}
                />
              </Lbl>
              <Lbl label="Thời lượng motion (ms)">
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
                  placeholder="Kế thừa"
                />
              </Lbl>
            </section>
          )}

          {category === 'screen' && screen && (
            <>
              <section className="grid gap-3 sm:grid-cols-2">
                <Lbl label="Bề rộng nội dung">
                  <select
                    value={presentation.content_width || ''}
                    onChange={(event) =>
                      setPresentation({
                        content_width: (event.target.value || undefined) as ScreenPresentationSpec['content_width'],
                      })
                    }
                    className={INPUT}
                  >
                    <option value="">Theo app</option>
                    <option value="narrow">Narrow</option>
                    <option value="standard">Standard</option>
                    <option value="wide">Wide</option>
                  </select>
                </Lbl>
                <Lbl label="Mật độ">
                  <select
                    value={presentation.density || ''}
                    onChange={(event) =>
                      setPresentation({
                        density: (event.target.value || undefined) as ScreenPresentationSpec['density'],
                      })
                    }
                    className={INPUT}
                  >
                    <option value="">Theo app</option>
                    <option value="compact">Compact</option>
                    <option value="cozy">Cozy</option>
                    <option value="comfortable">Comfortable</option>
                  </select>
                </Lbl>
                <Lbl label="Padding (px)">
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
                    placeholder="Theo app"
                  />
                </Lbl>
                <Lbl label="Bo góc card (px)">
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
                    placeholder="Theo app"
                  />
                </Lbl>
                <Lbl label="Độ nổi">
                  <select
                    value={presentation.shadow || ''}
                    onChange={(event) =>
                      setPresentation({
                        shadow: (event.target.value || undefined) as ScreenPresentationSpec['shadow'],
                      })
                    }
                    className={INPUT}
                  >
                    <option value="">Theo app</option>
                    <option value="none">None</option>
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </Lbl>
                <Lbl label="Chuyển động">
                  <select
                    value={presentation.motion || ''}
                    onChange={(event) =>
                      setPresentation({
                        motion: (event.target.value || undefined) as ScreenPresentationSpec['motion'],
                      })
                    }
                    className={INPUT}
                  >
                    <option value="">Theo app</option>
                    <option value="instant">Instant</option>
                    <option value="standard">Standard</option>
                    <option value="expressive">Expressive</option>
                  </select>
                </Lbl>
              </section>

              {screen.kind === 'form' && (
                <section className="grid gap-3 border-t border-[rgb(var(--border-line))] pt-5 sm:grid-cols-2">
                  <Lbl label="Số cột">
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
                      <option value="">Tự động</option>
                      <option value="1">1 cột</option>
                      <option value="2">2 cột</option>
                      <option value="3">3 cột</option>
                    </select>
                  </Lbl>
                  <Lbl label="Kiểu section">
                    <select
                      value={presentation.form?.section_style || ''}
                      onChange={(event) =>
                        setFormPresentation({
                          section_style: (event.target.value || undefined) as NonNullable<ScreenPresentationSpec['form']>['section_style'],
                        })
                      }
                      className={INPUT}
                    >
                      <option value="">Plain</option>
                      <option value="divided">Divided</option>
                      <option value="surface">Surface</option>
                    </select>
                  </Lbl>
                  <Lbl label="Sticky action bar">
                    <TriStateSelect
                      value={presentation.sticky_action_bar}
                      onChange={(sticky_action_bar) => setPresentation({ sticky_action_bar })}
                    />
                  </Lbl>
                </section>
              )}

              {screen.kind === 'table' && (
                <section className="grid gap-3 border-t border-[rgb(var(--border-line))] pt-5 sm:grid-cols-2">
                  <Lbl label="Sticky table header">
                    <TriStateSelect
                      value={presentation.table?.sticky_header}
                      onChange={(sticky_header) => setTablePresentation({ sticky_header })}
                    />
                  </Lbl>
                  <Lbl label="Chiều cao dòng">
                    <select
                      value={presentation.table?.row_height || ''}
                      onChange={(event) =>
                        setTablePresentation({
                          row_height: (event.target.value || undefined) as NonNullable<ScreenPresentationSpec['table']>['row_height'],
                        })
                      }
                      className={INPUT}
                    >
                      <option value="">Theo app</option>
                      <option value="compact">Compact</option>
                      <option value="cozy">Cozy</option>
                      <option value="comfortable">Comfortable</option>
                    </select>
                  </Lbl>
                  <Lbl label="Vị trí filter">
                    <select
                      value={presentation.table?.filter_position || ''}
                      onChange={(event) =>
                        setTablePresentation({
                          filter_position: (event.target.value || undefined) as NonNullable<ScreenPresentationSpec['table']>['filter_position'],
                        })
                      }
                      className={INPUT}
                    >
                      <option value="">Top</option>
                      <option value="sticky">Sticky top</option>
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
