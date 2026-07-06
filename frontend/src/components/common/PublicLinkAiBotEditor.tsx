'use client';

import { useEffect, useState } from 'react';
import { Bot, ChevronDown, Sparkles, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PublicLinkAppearanceConfig } from '@/types/api';
import { Input, Textarea } from '@/components/ui/Input';
import { AiButton } from '@/components/ui/AiButton';
import { dashboardApi } from '@/lib/api/dashboards';

// Dedicated AI-analyst setup for a public link. Split out of the appearance
// editor (2026-06-23) so the AI bot is configured on its own modal tab:
// provider + model + key + a report-specific System Prompt that steers how
// the bot reads THIS report (analysis flow + domain logic). No cost cap —
// the per-question ceiling was removed; max-tool-calls bounds runaway.

const AI_PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'gemini', label: 'Google Gemini' },
] as const;

const AI_MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  openai: [
    { value: 'gpt-5', label: 'GPT-5 (strongest)' },
    { value: 'gpt-5-mini', label: 'GPT-5 mini (balanced)' },
    { value: 'gpt-5-nano', label: 'GPT-5 nano (cheap, fast)' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini (cheap, fast)' },
  ],
  anthropic: [
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5 (recommended)' },
    { value: 'claude-opus-4-8', label: 'Claude Opus 4.8 (strongest)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (cheap, fast)' },
  ],
  gemini: [
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (recommended)' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (cheap, fast)' },
  ],
};

const MAX_SYSTEM_PROMPT_CHARS = 4000;

interface PublicLinkAiBotEditorProps {
  value: PublicLinkAppearanceConfig;
  onChange: (value: PublicLinkAppearanceConfig) => void;
  dashboardId: number;
}

export function PublicLinkAiBotEditor({ value, onChange, dashboardId }: PublicLinkAiBotEditorProps) {
  const enabled = value.ai_bot_enabled === true;
  const provider = value.ai_bot_provider || 'openai';
  const systemPrompt = value.ai_bot_report_context_note || '';
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setGenError(null);
    setGenerating(true);
    try {
      const text = await dashboardApi.suggestAiSystemPrompt(dashboardId, {
        provider,
        model: value.ai_bot_model || undefined,
        apiKey: value.ai_bot_key || undefined, // typed key wins; else server uses stored
      });
      if (text) patch('ai_bot_report_context_note', text.slice(0, MAX_SYSTEM_PROMPT_CHARS));
      else setGenError('AI không trả về nội dung.');
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setGenError(detail || 'Tạo system prompt thất bại. Kiểm tra API key.');
    } finally {
      setGenerating(false);
    }
  };

  // Patch a single AI field on top of the shared appearance config without
  // disturbing the layout/filter settings owned by the other tabs.
  const patch = <K extends keyof PublicLinkAppearanceConfig>(
    key: K,
    next: PublicLinkAppearanceConfig[K],
  ) => onChange({ ...value, [key]: next });

  // Self-heal: the provider/mode selects render a fallback default (OpenAI /
  // Auto) even when nothing is stored. Without this, an admin who opens an
  // enabled link, sees "OpenAI", and saves would persist NO provider (onChange
  // never fired) — so the bot silently defaults to the wrong provider. Write
  // the shown defaults once so what you see is what gets saved.
  useEffect(() => {
    if (!enabled) return;
    const patches: Partial<PublicLinkAppearanceConfig> = {};
    if (!value.ai_bot_provider) patches.ai_bot_provider = 'openai';
    if (!value.ai_bot_default_mode) patches.ai_bot_default_mode = 'auto';
    if (Object.keys(patches).length > 0) onChange({ ...value, ...patches });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
        <div className="mb-3 flex items-center gap-2 text-text-primary">
          <Bot className="h-4 w-4 text-brand" />
          <h3 className="text-small font-strong">AI analyst</h3>
        </div>
        <p className="mb-4 text-caption leading-6 text-text-tertiary">
          Bật trợ lý AI nổi trên trang công khai / embed của link này, chọn nhà cung cấp &amp; model,
          và viết system prompt điều hướng AI đọc báo cáo đúng flow và logic của bạn.
        </p>

        <button
          type="button"
          onClick={() => {
            if (!enabled) {
              onChange({
                ...value,
                ai_bot_enabled: true,
                ai_bot_provider: value.ai_bot_provider || 'openai',
                ai_bot_default_mode: value.ai_bot_default_mode || 'auto',
              });
            } else {
              patch('ai_bot_enabled', false);
            }
          }}
          className={cn(
            'flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-3 text-left transition-colors',
            enabled
              ? 'border-brand bg-brand text-text-inverse shadow-linear-sm'
              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2',
          )}
        >
          <div>
            <p className="text-caption font-emphasis">Bật AI analyst</p>
            <p className={cn('mt-1 text-tiny leading-5', enabled ? 'text-text-inverse/80' : 'text-text-tertiary')}>
              Hiện trợ lý phân tích cho người xem link công khai &amp; embed.
            </p>
          </div>
          <span
            className={cn(
              'mt-0.5 inline-flex h-6 w-11 flex-shrink-0 rounded-full border p-0.5 transition',
              enabled ? 'border-white/15 bg-white/10' : 'border-[rgb(var(--border-strong))] bg-surface-2',
            )}
          >
            <span
              className={cn(
                'h-4 w-4 rounded-full bg-white transition-transform',
                enabled ? 'translate-x-5' : 'translate-x-0',
              )}
            />
          </span>
        </button>

        {enabled && (
          <div className="mt-4 space-y-4 rounded-lg border border-brand/20 bg-brand/5 p-4">
            <p className="text-tiny leading-5 text-text-tertiary">
              API key được lưu phía server và không bao giờ lộ cho người xem. Mỗi câu hỏi bị giới hạn
              bởi số bước công cụ (không còn trần chi phí USD).
            </p>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-tiny font-strong text-text-secondary">Nhà cung cấp</label>
                <div className="relative">
                  <select
                    value={provider}
                    onChange={(e) => onChange({ ...value, ai_bot_provider: e.target.value, ai_bot_model: '' })}
                    className="w-full appearance-none rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 py-1.5 pl-3 pr-8 text-caption text-text-primary focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  >
                    {AI_PROVIDERS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
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
                    onChange={(e) => patch('ai_bot_model', e.target.value)}
                    className="w-full appearance-none rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 py-1.5 pl-3 pr-8 text-caption text-text-primary focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  >
                    <option value="">Dùng model mặc định của nhà cung cấp</option>
                    {(AI_MODEL_OPTIONS[provider] ?? []).map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-tiny font-strong text-text-secondary">Chế độ phân tích</label>
                <div className="relative">
                  <select
                    value={value.ai_bot_default_mode || 'auto'}
                    onChange={(e) => patch('ai_bot_default_mode', e.target.value as 'auto' | 'normal' | 'thinking')}
                    className="w-full appearance-none rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 py-1.5 pl-3 pr-8 text-caption text-text-primary focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  >
                    <option value="auto">Tự động (router chọn theo câu hỏi)</option>
                    <option value="normal">Luôn Normal (trả lời nhanh)</option>
                    <option value="thinking">Luôn Thinking (phân tích sâu)</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
                </div>
                <p className="mt-1 text-tiny text-text-quaternary">
                  Tự động: câu "cho xem/bao nhiêu" → nhanh; câu "tại sao/so sánh/xu hướng" → sâu. Người xem không phải chọn.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-tiny font-strong text-text-secondary">Tra cứu web (domain)</label>
                <button
                  type="button"
                  onClick={() => patch('ai_bot_web_search_enabled', !(value.ai_bot_web_search_enabled === true))}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-caption transition-colors',
                    value.ai_bot_web_search_enabled === true
                      ? 'border-brand bg-brand/10 text-text-primary'
                      : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary hover:border-[rgb(var(--border-strong))]',
                  )}
                >
                  <span>{value.ai_bot_web_search_enabled === true ? 'Bật' : 'Tắt'}</span>
                  <span
                    className={cn(
                      'inline-flex h-5 w-9 rounded-full border p-0.5 transition',
                      value.ai_bot_web_search_enabled === true ? 'border-brand/30 bg-brand/20' : 'border-[rgb(var(--border-strong))] bg-surface-1',
                    )}
                  >
                    <span className={cn('h-3.5 w-3.5 rounded-full bg-white transition-transform', value.ai_bot_web_search_enabled === true ? 'translate-x-4' : 'translate-x-0')} />
                  </span>
                </button>
                <p className="mt-1 text-tiny text-text-quaternary">
                  Cho phép chế độ sâu tra know-how thị trường/ngành trên web (cần cấu hình API key phía server).
                </p>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-tiny font-strong text-text-secondary">API key</label>
              {value.ai_bot_key_configured && !value.ai_bot_key && (
                <p className="mb-1.5 flex items-center gap-1.5 text-tiny text-success">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                  Link này đã có key cấu hình sẵn. Chỉ nhập key mới bên dưới nếu muốn thay.
                </p>
              )}
              <Input
                type="password"
                value={value.ai_bot_key || ''}
                onChange={(e) => patch('ai_bot_key', e.target.value)}
                placeholder={
                  value.ai_bot_key_configured
                    ? '(giữ key hiện tại phía server)'
                    : provider === 'anthropic' ? 'sk-ant-...'
                    : provider === 'gemini' ? 'AIza...'
                    : 'sk-...'
                }
              />
              <p className="mt-1 text-tiny text-text-quaternary">
                Để trống để giữ key hiện tại. Xoá giá trị rồi lưu để gỡ key đã lưu.
              </p>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="block text-tiny font-strong text-text-secondary">
                  System prompt — điều hướng AI đọc báo cáo
                </label>
                <AiButton
                  size="xs"
                  onClick={handleGenerate}
                  loading={generating}
                  title="Để AI đọc báo cáo và viết nháp system prompt (bạn có thể sửa lại)"
                >
                  AI đọc &amp; viết giúp
                </AiButton>
              </div>
              {genError && <p className="mb-1 text-tiny text-danger">{genError}</p>}
              <Textarea
                rows={8}
                value={systemPrompt}
                onChange={(e) => patch('ai_bot_report_context_note', e.target.value.slice(0, MAX_SYSTEM_PROMPT_CHARS))}
                placeholder={
                  'Ví dụ:\n'
                  + '• Đây là báo cáo vận hành nhà máy. Luôn đọc theo flow: sản lượng → tỷ lệ hoàn thành KH → bất thường.\n'
                  + '• Khi so sánh kỳ, dùng cùng phép tổng hợp và nêu rõ đơn vị (tr.kWh, %).\n'
                  + '• Ưu tiên nút thắt và đảo chiều xu hướng; tránh liệt kê KPI chung chung.\n'
                  + '• Thuật ngữ: "đầu cực" = sản lượng tại đầu cực máy phát.'
                }
              />
              <div className="mt-1 flex items-center justify-between">
                <p className="text-tiny text-text-quaternary">
                  Được nạp vào prompt hệ thống của bot để bám đúng logic báo cáo. Không hiển thị cho người xem.
                </p>
                <p className="text-tiny text-text-quaternary tabular-nums">
                  {systemPrompt.length}/{MAX_SYSTEM_PROMPT_CHARS}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
