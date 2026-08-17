'use client';

import { useState } from 'react';
import { Eye, Image as ImageIcon, Sparkles, Upload, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { normalizePublicLinkAppearance } from '@/lib/public-link-appearance';
import type { PublicLinkAppearanceConfig } from '@/types/api';

// Logo upload guard — a data: URI is stored inline in the appearance config,
// so cap the source image size to keep the config small. ~256 KB raw.
const MAX_LOGO_BYTES = 256 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface PublicLinkAppearanceEditorProps {
  value: PublicLinkAppearanceConfig;
  dashboardName: string;
  onChange: (value: PublicLinkAppearanceConfig) => void;
  // Snapshot freshness (TTL) only means something when the report actually has a
  // materialized source (BigQuery with materialization on). When false, the
  // report serves live/cached data and the TTL selector is hidden to avoid
  // implying a "refresh schedule" that does nothing.
  snapshotEnabled?: boolean;
}

interface ToggleCardProps {
  checked: boolean;
  label: string;
  description: string;
  onToggle: () => void;
}

function ToggleCard({ checked, label, description, onToggle }: ToggleCardProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex items-start justify-between gap-3 rounded-lg border px-3 py-3 text-left transition-colors',
        checked
          ? 'border-brand bg-brand text-text-inverse shadow-linear-sm'
          : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2',
      )}
    >
      <div>
        <p className="text-caption font-emphasis">{label}</p>
        <p className={cn('mt-1 text-tiny leading-5', checked ? 'text-text-inverse/80' : 'text-text-tertiary')}>
          {description}
        </p>
      </div>
      <span
        className={cn(
          'mt-0.5 inline-flex h-6 w-11 rounded-full border p-0.5 transition',
          checked ? 'border-white/15 bg-white/10' : 'border-[rgb(var(--border-strong))] bg-surface-2',
        )}
      >
        <span
          className={cn(
            'h-5 w-5 rounded-full transition',
            checked ? 'translate-x-5 bg-surface-1' : 'translate-x-0 bg-text-quaternary',
          )}
        />
      </span>
    </button>
  );
}

function SectionKicker({
  icon: Icon,
  label,
  description,
}: {
  icon: typeof Sparkles;
  label: string;
  description: string;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 text-text-primary">
        <Icon className="h-4 w-4 text-brand" />
        <h3 className="text-small font-strong">{label}</h3>
      </div>
      <p className="mt-1 text-caption leading-6 text-text-tertiary">{description}</p>
    </div>
  );
}

export function PublicLinkAppearanceEditor({
  value,
  dashboardName,
  onChange,
  snapshotEnabled = false,
}: PublicLinkAppearanceEditorProps) {
  const appearance = normalizePublicLinkAppearance(value);
  const [logoError, setLogoError] = useState<string | null>(null);

  const handleLogoFile = async (file: File | undefined) => {
    setLogoError(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setLogoError('Please choose an image file.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError(`Image is too large (${Math.round(file.size / 1024)} KB). Keep it under ${Math.round(MAX_LOGO_BYTES / 1024)} KB.`);
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      updateField('logo_url', dataUrl);
    } catch {
      setLogoError('Could not read that image. Try another file.');
    }
  };

  const nextBaseAppearance = (): PublicLinkAppearanceConfig => ({
    ...appearance,
    density: 'compact',
    canvas_style: 'plain',
    embed_header_mode: 'compact',
    hero_label: null,
    summary: null,
    footer_note: null,
    show_summary: false,
    show_stats: false,
    show_footer: false,
    show_chart_type_label: false,
    // AI bot config is edited on its own modal tab (PublicLinkAiBotEditor),
    // but it lives on the same appearance_config object — preserve it so
    // editing layout here never wipes the AI setup.
    ai_bot_enabled: value.ai_bot_enabled,
    ai_bot_provider: value.ai_bot_provider,
    ai_bot_model: value.ai_bot_model,
    ai_bot_web_search_enabled: value.ai_bot_web_search_enabled,
    ai_bot_report_context_note: value.ai_bot_report_context_note,
    ai_bot_key: value.ai_bot_key,
    ai_bot_key_configured: value.ai_bot_key_configured,
    // Snapshot freshness TTL lives on the same appearance_config object —
    // preserve it so editing layout here never resets the data-freshness choice.
    cache_ttl_minutes: value.cache_ttl_minutes,
  });

  const updateField = <K extends keyof PublicLinkAppearanceConfig>(
    key: K,
    nextValue: PublicLinkAppearanceConfig[K],
  ) => {
    onChange({
      ...nextBaseAppearance(),
      [key]: nextValue,
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
        <SectionKicker
          icon={Sparkles}
          label="Viewer layout"
          description="The shared report inherits the dashboard's own theme (colors, fonts) automatically. Here you only set the logo and whether viewers can use page tabs or filters."
        />
        <div className="rounded-md border border-brand/20 bg-brand/10 px-4 py-3 text-caption leading-6 text-text-secondary">
          Colors and typography follow the published dashboard theme, so the shared report stays consistent with the original.
        </div>
      </div>

      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
        <SectionKicker
          icon={ImageIcon}
          label="Report logo"
          description="Upload a logo to replace the default generated mark in the report header. Leave empty to use the auto-generated accent mark."
        />

        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-2">
            {appearance.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={appearance.logo_url} alt="Logo preview" className="h-full w-full object-contain" />
            ) : (
              <ImageIcon className="h-6 w-6 text-text-quaternary" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-caption font-emphasis text-text-secondary transition-colors hover:border-[rgb(var(--border-strong))] hover:bg-surface-1">
                <Upload className="h-3.5 w-3.5" />
                {appearance.logo_url ? 'Replace logo' : 'Upload logo'}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    void handleLogoFile(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </label>
              {appearance.logo_url && (
                <button
                  type="button"
                  onClick={() => { setLogoError(null); updateField('logo_url', null); }}
                  className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2.5 py-1.5 text-caption text-text-tertiary transition-colors hover:border-danger/40 hover:text-danger"
                >
                  <X className="h-3.5 w-3.5" />
                  Remove
                </button>
              )}
            </div>
            <p className="mt-1.5 text-tiny text-text-quaternary">
              PNG, JPG, or SVG. Square works best. Max {Math.round(MAX_LOGO_BYTES / 1024)} KB.
            </p>
            {logoError && (
              <p className="mt-1 text-tiny text-danger">{logoError}</p>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
        <SectionKicker
          icon={Eye}
          label="Viewer controls"
          description="Only keep controls that affect how people navigate or explore the report."
        />

        <div className="grid gap-2 md:grid-cols-2">
          <ToggleCard
            checked={appearance.show_page_tabs}
            label="Show page tabs"
            description="Keep page switching visible for multi-page dashboards."
            onToggle={() => updateField('show_page_tabs', !appearance.show_page_tabs)}
          />
          <ToggleCard
            checked={appearance.allow_viewer_filters}
            label="Allow viewer filters"
            description="Let viewers use filter controls on the shared report."
            onToggle={() => updateField('allow_viewer_filters', !appearance.allow_viewer_filters)}
          />
          <ToggleCard
            checked={appearance.allow_data_export}
            label="Allow data export"
            description="Let viewers download each chart's data (CSV) — only the chart's filtered rows."
            onToggle={() => updateField('allow_data_export', !appearance.allow_data_export)}
          />
        </div>
      </div>

      {/* Snapshot freshness TTL only applies to a materialized source (BigQuery
          with materialization on). For live/cached sources (Postgres, MySQL,
          Sheets, manual, or BQ not materialized) there is no snapshot to
          serve-stale/rebuild, so hiding this avoids implying a refresh schedule
          that does nothing. */}
      {snapshotEnabled && (
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
        <SectionKicker
          icon={Sparkles}
          label="Độ tươi dữ liệu (snapshot)"
          description="Với dataset đã bật materialization: báo cáo phục vụ snapshot đã dựng sẵn nên mở rất nhanh. Chọn sau bao lâu thì một lượt xem sẽ tự dựng lại snapshot ở nền (số hiện tại vẫn hiện ngay, không ai phải chờ)."
        />
        <select
          className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-caption text-text-primary"
          value={value.cache_ttl_minutes ?? ''}
          onChange={(event) => {
            const raw = event.target.value;
            updateField('cache_ttl_minutes', raw === '' ? null : Number(raw));
          }}
        >
          <option value="">Tự động (mặc định 30 phút)</option>
          <option value="0">Realtime — luôn chạy trực tiếp (không dùng snapshot)</option>
          <option value="15">Làm mới sau 15 phút</option>
          <option value="30">Làm mới sau 30 phút</option>
          <option value="60">Làm mới sau 60 phút</option>
          <option value="-1">Thủ công — chỉ làm mới khi DA bấm Refresh trong builder</option>
        </select>
        <p className="mt-2 text-caption leading-6 text-text-tertiary">
          Ví dụ TTL 30 phút: mở lúc 10:00 phục vụ snapshot hiện có; trong 10:00–10:30 không dựng lại. Ai xem sau 10:30 sẽ kích hoạt dựng snapshot mới ở nền; nếu 10:30 không ai xem thì không tự dựng.
        </p>
      </div>
      )}

    </div>
  );
}
