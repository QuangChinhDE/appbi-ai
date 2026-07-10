/**
 * AppSettingsEditor — modal for app-level settings (branding + nav).
 */
'use client';

import React, { useEffect, useState } from 'react';
import { Database, FileText, Hash, Monitor, Palette, Settings2, Smartphone } from 'lucide-react';
import { AppModalShell } from '@/components/common/AppModalShell';

import type {
  MiniAppLayoutSpec,
  BrandingSpec,
  PrintTemplateSpec,
  ThemeBackgroundSpec,
  ThemeMode,
  ThemeFont,
} from './types';
import { INPUT, Lbl } from './ScreenEditor';
import { GRADIENT_PRESETS } from '@/lib/wb-theme';
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
  const nav = layout.mini_app_nav;
  const [selectedDatasetId, setSelectedDatasetId] = useState(currentDatasetId);

  useEffect(() => {
    setSelectedDatasetId(currentDatasetId);
  }, [currentDatasetId]);

  const datasetChanged = selectedDatasetId !== currentDatasetId;

  return (
    <AppModalShell
      onClose={onClose}
      title="App settings"
      description="Giao diện · Dữ liệu nguồn · Auto-number · Điều hướng"
      icon={<Settings2 className="h-4 w-4" />}
      maxWidthClass="max-w-5xl"
      bodyClassName="space-y-5 px-5 py-5"
    >
          <MiniAppSettingsPreview layout={layout} />

          <SettingsPanel
            title="Dataset"
            icon={<Database className="h-4 w-4" />}
          >
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
          </SettingsPanel>

          <SettingsPanel
            title="Brand & theme"
            icon={<Palette className="h-4 w-4" />}
          >
            <ThemeSection layout={layout} onChange={onChange} />
          </SettingsPanel>

          <SettingsPanel
            title="Documents"
            icon={<FileText className="h-4 w-4" />}
          >
            <PrintTemplateSection layout={layout} onChange={onChange} />
          </SettingsPanel>

          <SettingsPanel
            title="Automation"
            icon={<Hash className="h-4 w-4" />}
          >
            <AutoNumberSection layout={layout} onChange={onChange} />
          </SettingsPanel>

          <SettingsPanel
            title="Navigation"
            icon={<Smartphone className="h-4 w-4" />}
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <div className="mb-2 flex items-center gap-2 text-caption font-medium text-text-secondary">
                  <Smartphone className="h-4 w-4" />
                  Mobile
                </div>
                <SegmentedControl
                  value={nav.mobile_kind}
                  onChange={(mobile_kind) =>
                    onChange({
                      ...layout,
                      mini_app_nav: { ...nav, mobile_kind },
                    })
                  }
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
                  onChange={(desktop_kind) =>
                    onChange({
                      ...layout,
                      mini_app_nav: { ...nav, desktop_kind },
                    })
                  }
                  options={[
                    { value: 'sidebar', label: 'Sidebar' },
                    { value: 'top_tabs', label: 'Top tabs' },
                  ]}
                />
              </div>
            </div>
          </SettingsPanel>
    </AppModalShell>
  );
}


// ── Theme / design-system editor ────────────────────────────────────────

const SECTION_H =
  'mb-2 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function SettingsPanel({
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

function MiniAppSettingsPreview({ layout }: { layout: MiniAppLayoutSpec }) {
  const branding = layout.branding || {};
  const primary = branding.primary_color || '#2563eb';
  const accent = branding.accent_color || primary;
  const appName = branding.app_name || 'Mini app';
  const logoSrc = branding.logo_data || branding.logo_url;
  const wideLogo = branding.logo_layout === 'wide';
  const visibleScreens = (layout.screens || []).filter((screen) => screen.show_in_nav !== false);

  return (
    <section className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
      <div
        className="flex min-h-24 items-end justify-between gap-4 px-4 py-4"
        style={{
          background:
            branding.background?.kind === 'gradient'
              ? GRADIENT_PRESETS[branding.background.gradient_preset || 'ocean']
              : branding.background?.kind === 'color'
                ? branding.background.color || '#f8fafc'
                : `linear-gradient(135deg, ${primary}, ${accent})`,
        }}
      >
        <div className="min-w-0">
          <div className="inline-flex rounded-md bg-white/90 px-2 py-1 text-tiny font-emphasis uppercase tracking-wider text-slate-600">
            Preview
          </div>
          <h3 className="mt-2 truncate text-body font-strong text-white drop-shadow-sm">
            {appName}
          </h3>
        </div>
        <div
          className={`flex h-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/90 p-1 text-sm font-strong text-slate-700 shadow-sm ${
            wideLogo ? 'w-24' : 'w-10'
          }`}
        >
          {logoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoSrc} alt="" className="h-full w-full object-contain" />
          ) : (
            appName.slice(0, 1).toUpperCase()
          )}
        </div>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-3">
          <div className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            Screens
          </div>
          <div className="mt-1 text-body font-strong text-text-primary">
            {visibleScreens.length}
          </div>
        </div>
        <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-3">
          <div className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            Mobile
          </div>
          <div className="mt-1 truncate text-caption font-medium text-text-primary">
            {layout.mini_app_nav.mobile_kind === 'drawer' ? 'Drawer' : 'Bottom nav'}
          </div>
        </div>
        <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-3">
          <div className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            Desktop
          </div>
          <div className="mt-1 truncate text-caption font-medium text-text-primary">
            {layout.mini_app_nav.desktop_kind === 'top_tabs' ? 'Top tabs' : 'Sidebar'}
          </div>
        </div>
      </div>
    </section>
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

function PrintTemplateSection({
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

function ThemeSection({
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
