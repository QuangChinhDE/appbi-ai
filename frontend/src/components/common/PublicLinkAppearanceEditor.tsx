'use client';

import { useEffect, useState } from 'react';
import { Bot, ChevronDown, Eye, Image as ImageIcon, Sparkles, Upload, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { normalizePublicLinkAppearance } from '@/lib/public-link-appearance';
import type { PublicLinkAppearanceConfig } from '@/types/api';
import { Input, Textarea } from '@/components/ui/Input';

const AI_PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'gemini', label: 'Google Gemini' },
] as const;

const AI_MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  openai: [
    { value: 'gpt-5', label: 'GPT-5 (strongest, expensive — set a $ cap)' },
    { value: 'gpt-5-mini', label: 'GPT-5 mini (balanced)' },
    { value: 'gpt-5-nano', label: 'GPT-5 nano (cheap, fast)' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini (cheap, fast)' },
  ],
  anthropic: [
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (recommended)' },
    { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (strongest)' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (cheap, fast)' },
  ],
  gemini: [
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (cheap, fast)' },
  ],
};

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

const DEFAULT_NORMAL_COST_CAP_USD = 0.05;
const DEFAULT_THINKING_COST_CAP_USD = 0.10;
const MIN_AI_COST_CAP_USD = 0.01;
const MAX_AI_COST_CAP_USD = 5.0;

interface PublicLinkAppearanceEditorProps {
  value: PublicLinkAppearanceConfig;
  dashboardName: string;
  onChange: (value: PublicLinkAppearanceConfig) => void;
}

function clampAiCostCap(value: number): number {
  return Math.max(MIN_AI_COST_CAP_USD, Math.min(MAX_AI_COST_CAP_USD, value));
}

function resolveAiCostCap(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clampAiCostCap(value)
    : fallback;
}

function formatAiCostCap(value: number | null | undefined, fallback: number): string {
  return resolveAiCostCap(value, fallback).toFixed(2);
}

function parseAiCostCapInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || !/^\d+(\.\d{0,3})?$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return clampAiCostCap(parsed);
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
}: PublicLinkAppearanceEditorProps) {
  const appearance = normalizePublicLinkAppearance(value);
  const [normalCapInput, setNormalCapInput] = useState(() => (
    formatAiCostCap(value.ai_bot_normal_cost_cap_usd, DEFAULT_NORMAL_COST_CAP_USD)
  ));
  const [thinkingCapInput, setThinkingCapInput] = useState(() => (
    formatAiCostCap(value.ai_bot_thinking_cost_cap_usd, DEFAULT_THINKING_COST_CAP_USD)
  ));
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
    ai_bot_enabled: value.ai_bot_enabled,
    ai_bot_provider: value.ai_bot_provider,
    ai_bot_model: value.ai_bot_model,
    ai_bot_normal_cost_cap_usd: value.ai_bot_normal_cost_cap_usd,
    ai_bot_thinking_cost_cap_usd: value.ai_bot_thinking_cost_cap_usd,
    ai_bot_report_context_note: value.ai_bot_report_context_note,
    ai_bot_key: value.ai_bot_key,
    ai_bot_key_configured: value.ai_bot_key_configured,
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

  useEffect(() => {
    setNormalCapInput(formatAiCostCap(value.ai_bot_normal_cost_cap_usd, DEFAULT_NORMAL_COST_CAP_USD));
  }, [value.ai_bot_normal_cost_cap_usd]);

  useEffect(() => {
    setThinkingCapInput(formatAiCostCap(value.ai_bot_thinking_cost_cap_usd, DEFAULT_THINKING_COST_CAP_USD));
  }, [value.ai_bot_thinking_cost_cap_usd]);

  const handleAiToggle = () => {
    onChange({
      ...nextBaseAppearance(),
      ai_bot_enabled: !(value.ai_bot_enabled === true),
      ai_bot_provider: value.ai_bot_provider || 'openai',
      ai_bot_model: value.ai_bot_model,
      ai_bot_normal_cost_cap_usd: resolveAiCostCap(
        value.ai_bot_normal_cost_cap_usd,
        DEFAULT_NORMAL_COST_CAP_USD,
      ),
      ai_bot_thinking_cost_cap_usd: resolveAiCostCap(
        value.ai_bot_thinking_cost_cap_usd,
        DEFAULT_THINKING_COST_CAP_USD,
      ),
      ai_bot_report_context_note: value.ai_bot_report_context_note ?? '',
      ai_bot_key: value.ai_bot_key,
      ai_bot_key_configured: value.ai_bot_key_configured,
    });
  };

  const handleAiCostCapInputChange = (
    key: 'ai_bot_normal_cost_cap_usd' | 'ai_bot_thinking_cost_cap_usd',
    rawValue: string,
    setInput: (value: string) => void,
  ) => {
    setInput(rawValue);
    const parsed = parseAiCostCapInput(rawValue);
    if (parsed !== null) {
      updateField(key, parsed);
    }
  };

  const handleAiCostCapBlur = (
    key: 'ai_bot_normal_cost_cap_usd' | 'ai_bot_thinking_cost_cap_usd',
    rawValue: string,
    fallback: number,
    setInput: (value: string) => void,
  ) => {
    const parsed = parseAiCostCapInput(rawValue) ?? fallback;
    updateField(key, parsed);
    setInput(parsed.toFixed(2));
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
        </div>
      </div>

      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
        <SectionKicker
          icon={Bot}
          label="AI analyst"
          description="Give this public report its own AI section, budget ceilings, and a report-specific analysis lens."
        />

        <ToggleCard
          checked={value.ai_bot_enabled === true}
          label="Enable AI analyst"
          description="Show a floating analyst on the public page and embed for this link."
          onToggle={handleAiToggle}
        />

        {value.ai_bot_enabled === true && (
          <div className="mt-4 space-y-4 rounded-lg border border-brand/20 bg-brand/5 p-4">
            <p className="text-tiny leading-5 text-text-tertiary">
              The API key is stored server-side and never exposed to viewers. The two caps below are enforced per question,
              with separate ceilings for `Normal` and `Thinking`.
            </p>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-tiny font-strong text-text-secondary">Provider</label>
                <div className="relative">
                  <select
                    value={value.ai_bot_provider || 'openai'}
                    onChange={(event) => onChange({ ...value, ai_bot_provider: event.target.value, ai_bot_model: '' })}
                    className="w-full appearance-none rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 py-1.5 pl-3 pr-8 text-caption text-text-primary focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  >
                    {AI_PROVIDERS.map((providerOption) => (
                      <option key={providerOption.value} value={providerOption.value}>{providerOption.label}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-tiny font-strong text-text-secondary">Model</label>
                <div className="relative">
                  <select
                    value={value.ai_bot_model || ''}
                    onChange={(event) => onChange({ ...value, ai_bot_model: event.target.value })}
                    className="w-full appearance-none rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 py-1.5 pl-3 pr-8 text-caption text-text-primary focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  >
                    <option value="">Use provider default</option>
                    {(AI_MODEL_OPTIONS[value.ai_bot_provider || 'openai'] ?? []).map((modelOption) => (
                      <option key={modelOption.value} value={modelOption.value}>{modelOption.label}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
                </div>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-tiny font-strong text-text-secondary">API key</label>
              {value.ai_bot_key_configured && !value.ai_bot_key && (
                <p className="mb-1.5 flex items-center gap-1.5 text-tiny text-success">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                  A key is already configured for this link. Enter a new key below only if you want to replace it.
                </p>
              )}
              <Input
                type="password"
                value={value.ai_bot_key || ''}
                onChange={(event) => onChange({ ...value, ai_bot_key: event.target.value })}
                placeholder={
                  value.ai_bot_key_configured
                    ? '(keep current server-side key)'
                    : value.ai_bot_provider === 'anthropic' ? 'sk-ant-...'
                    : value.ai_bot_provider === 'gemini' ? 'AIza...'
                    : 'sk-...'
                }
              />
              <p className="mt-1 text-tiny text-text-quaternary">
                Leave blank to keep the current key. Clear the value and save to remove the stored key.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-tiny font-strong text-text-secondary">Normal cost cap (USD)</label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={normalCapInput}
                  onChange={(event) => handleAiCostCapInputChange(
                    'ai_bot_normal_cost_cap_usd',
                    event.target.value,
                    setNormalCapInput,
                  )}
                  onBlur={() => handleAiCostCapBlur(
                    'ai_bot_normal_cost_cap_usd',
                    normalCapInput,
                    DEFAULT_NORMAL_COST_CAP_USD,
                    setNormalCapInput,
                  )}
                  placeholder={DEFAULT_NORMAL_COST_CAP_USD.toFixed(2)}
                />
                <p className="mt-1 text-tiny text-text-quaternary">
                  Used for standard asks. Range: {MIN_AI_COST_CAP_USD.toFixed(2)} to {MAX_AI_COST_CAP_USD.toFixed(2)} USD.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-tiny font-strong text-text-secondary">Thinking cost cap (USD)</label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={thinkingCapInput}
                  onChange={(event) => handleAiCostCapInputChange(
                    'ai_bot_thinking_cost_cap_usd',
                    event.target.value,
                    setThinkingCapInput,
                  )}
                  onBlur={() => handleAiCostCapBlur(
                    'ai_bot_thinking_cost_cap_usd',
                    thinkingCapInput,
                    DEFAULT_THINKING_COST_CAP_USD,
                    setThinkingCapInput,
                  )}
                  placeholder={DEFAULT_THINKING_COST_CAP_USD.toFixed(2)}
                />
                <p className="mt-1 text-tiny text-text-quaternary">
                  Used when viewers switch to the deeper `Thinking` mode for multi-step or logic-heavy analysis.
                </p>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-tiny font-strong text-text-secondary">Report mindset note</label>
              <Textarea
                rows={3}
                value={value.ai_bot_report_context_note || ''}
                onChange={(event) => updateField('ai_bot_report_context_note', event.target.value.slice(0, 1200))}
                placeholder="Example: Read this as an executive risk report. Prioritize bottlenecks, trend reversals, and logical links between departments. Avoid drifting into generic KPI recitation."
              />
              <p className="mt-1 text-tiny text-text-quaternary">
                This note is injected into the bot prompt to keep analysis aligned with the report. It is not shown to public viewers.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
