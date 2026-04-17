'use client';

import { Eye, Palette, Sparkles, Type } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  PUBLIC_LINK_ACCENT_OPTIONS,
  PUBLIC_LINK_PRESET_OPTIONS,
  normalizePublicLinkAppearance,
} from '@/lib/public-link-appearance';
import type { PublicLinkAppearanceConfig } from '@/types/api';

interface PublicLinkAppearanceEditorProps {
  value: PublicLinkAppearanceConfig;
  dashboardName: string;
  onChange: (value: PublicLinkAppearanceConfig) => void;
}

interface ChoiceCardProps {
  active: boolean;
  label: string;
  description: string;
  onClick: () => void;
}

function ChoiceCard({ active, label, description, onClick }: ChoiceCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-[20px] border px-4 py-3 text-left transition-colors',
        active
          ? 'border-blue-600 bg-blue-600 text-white shadow-lg shadow-blue-600/15'
          : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
      )}
    >
      <p className="text-sm font-semibold">{label}</p>
      <p className={cn('mt-1 text-xs leading-5', active ? 'text-slate-300' : 'text-slate-500')}>
        {description}
      </p>
    </button>
  );
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
        'flex items-start justify-between gap-3 rounded-[18px] border px-3 py-3 text-left transition-colors',
        checked
          ? 'border-blue-600 bg-blue-600 text-white shadow-lg shadow-blue-600/15'
          : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
      )}
    >
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className={cn('mt-1 text-xs leading-5', checked ? 'text-slate-300' : 'text-slate-500')}>
          {description}
        </p>
      </div>
      <span
        className={cn(
          'mt-0.5 inline-flex h-6 w-11 rounded-full border p-0.5 transition',
          checked ? 'border-white/15 bg-white/10' : 'border-slate-300 bg-slate-100',
        )}
      >
        <span
          className={cn(
            'h-5 w-5 rounded-full transition',
            checked ? 'translate-x-5 bg-white' : 'translate-x-0 bg-slate-500',
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
      <div className="flex items-center gap-2 text-slate-900">
        <Icon className="h-4 w-4 text-sky-600" />
        <h3 className="text-sm font-semibold">{label}</h3>
      </div>
      <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>
    </div>
  );
}

export function PublicLinkAppearanceEditor({
  value,
  dashboardName,
  onChange,
}: PublicLinkAppearanceEditorProps) {
  const appearance = normalizePublicLinkAppearance(value);

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

  const updateHeadline = (nextValue: string) => {
    onChange({
      ...nextBaseAppearance(),
      headline: nextValue,
    });
  };

  const selectAccentPreset = (accentPreset: NonNullable<PublicLinkAppearanceConfig['accent_preset']>) => {
    onChange({
      ...nextBaseAppearance(),
      accent_preset: accentPreset,
      accent_color: null,
    });
  };

  return (
    <div className="space-y-5">
      <div className="rounded-[28px] border border-slate-200/80 bg-white/90 p-5 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)]">
        <SectionKicker
          icon={Sparkles}
          label="Viewer layout"
          description="Public page and embed now use one compact report rail by default. Here you only set the visual tone, report title, and whether viewers can use tabs or filters."
        />
        <div className="rounded-[22px] border border-sky-100 bg-sky-50/70 px-4 py-3 text-sm leading-6 text-slate-600">
          Footer, summary, extra badges, and wide header variants are removed so the shared report stays focused on charts.
        </div>
      </div>

      <div className="rounded-[28px] border border-slate-200/80 bg-white/90 p-5 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)]">
        <SectionKicker
          icon={Palette}
          label="Visual direction"
          description="Choose the report mood first, then adjust the accent color if needed."
        />

        <div className="space-y-5">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              <Sparkles className="h-3.5 w-3.5" />
              Preset
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              {PUBLIC_LINK_PRESET_OPTIONS.map((option) => (
                <ChoiceCard
                  key={option.value}
                  active={appearance.preset === option.value}
                  label={option.label}
                  description={option.description}
                  onClick={() => updateField('preset', option.value)}
                />
              ))}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),220px]">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                <Palette className="h-3.5 w-3.5" />
                Accent
              </div>
              <div className="flex flex-wrap gap-2">
                {PUBLIC_LINK_ACCENT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => selectAccentPreset(option.value)}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors',
                      appearance.accent_preset === option.value && !appearance.accent_color
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
                    )}
                  >
                    <span
                      className="h-3 w-3 rounded-full border border-black/10"
                      style={{ backgroundColor: option.color }}
                    />
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                <Palette className="h-3.5 w-3.5" />
                Custom color
              </label>
              <div className="flex items-center gap-3 rounded-[18px] border border-slate-200 bg-slate-50 px-3 py-2.5">
                <input
                  type="color"
                  value={appearance.accent_color ?? '#0EA5E9'}
                  onChange={(event) => updateField('accent_color', event.target.value)}
                  className="h-9 w-11 cursor-pointer rounded-lg border border-slate-200 bg-transparent"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-700">
                    {appearance.accent_color ? appearance.accent_color.toUpperCase() : 'Using preset tone'}
                  </p>
                  <button
                    type="button"
                    onClick={() => updateField('accent_color', null)}
                    className="text-xs text-slate-500 hover:text-slate-700"
                  >
                    Reset custom color
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-[28px] border border-slate-200/80 bg-white/90 p-5 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)]">
        <SectionKicker
          icon={Type}
          label="Report title"
          description="This is the one main text viewers should see. Leave it blank to reuse the link name."
        />

        <label className="mb-1.5 flex items-center gap-2 text-sm font-medium text-slate-700">
          <Type className="h-4 w-4 text-slate-400" />
          Headline
        </label>
        <input
          type="text"
          value={appearance.headline ?? ''}
          onChange={(event) => updateHeadline(event.target.value)}
          placeholder={dashboardName}
          className="w-full rounded-2xl border border-slate-300 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100"
        />
      </div>

      <div className="rounded-[28px] border border-slate-200/80 bg-white/90 p-5 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.45)]">
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
        </div>
      </div>
    </div>
  );
}
