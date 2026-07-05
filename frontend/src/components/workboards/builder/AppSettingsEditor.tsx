/**
 * AppSettingsEditor — modal for app-level settings (branding + nav).
 */
'use client';

import React, { useEffect, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { AppModalShell } from '@/components/common/AppModalShell';

import type {
  MiniAppLayoutSpec,
  BrandingSpec,
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
      maxWidthClass="max-w-3xl"
      bodyClassName="space-y-5 px-5 py-5"
    >
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

          <ThemeSection layout={layout} onChange={onChange} />

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
    </AppModalShell>
  );
}


// ── Theme / design-system editor ────────────────────────────────────────

const SECTION_H =
  'mb-2 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary';

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
