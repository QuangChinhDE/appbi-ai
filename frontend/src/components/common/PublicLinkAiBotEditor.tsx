'use client';

import { useEffect, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, ExternalLink, Loader2, Workflow } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PublicLinkAppearanceConfig } from '@/types/api';
import { Input, Textarea } from '@/components/ui/Input';
import { AiButton } from '@/components/ui/AiButton';
import { dashboardApi } from '@/lib/api/dashboards';
import { FlowBindingEditor } from '@/components/common/FlowBindingEditor';

// The AI setup for one public link.
//
// This panel used to be where you WROTE how the bot behaves: an analysis-depth
// dropdown and a 4000-character system prompt, per link, with no way to reuse
// either and no way to see what the bot would actually do with them. Now it is
// where you CHOOSE — the ways of thinking live in AI Flow Studio as chains of AI
// Agents, and a link points at one. Same report, two links, two different bots.
//
// What stays here is what genuinely belongs to the LINK rather than to the way
// of thinking: whether the bot appears at all, and the credentials it runs on.

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
  /** Null while the link is still being created. The data contract is attached to a
   *  LINK, so there is nothing to define until one exists. */
  linkId: number | null;
}

export function PublicLinkAiBotEditor({
  value, onChange, dashboardId, linkId,
}: PublicLinkAiBotEditorProps) {
  const enabled = value.ai_bot_enabled === true;
  const provider = value.ai_bot_provider || 'openai';
  const systemPrompt = value.ai_bot_report_context_note || '';
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);


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

  // Self-heal: the provider select renders a fallback default (OpenAI) even when
  // nothing is stored. Without this, an admin who opens an enabled link, sees
  // "OpenAI", and saves would persist NO provider (onChange never fired) — so
  // the bot silently defaults to the wrong provider. Write the shown default
  // once so what you see is what gets saved.
  //
  // The FLOW is deliberately not self-healed. An empty value means "use the
  // default", the BE resolves it that way, and writing the built-in key here
  // would freeze this link onto today's default — a later change of default
  // would then skip every link that had merely been left alone.
  useEffect(() => {
    if (!enabled) return;
    if (!value.ai_bot_provider) onChange({ ...value, ai_bot_provider: 'openai' });
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
          Bật trợ lý AI nổi trên trang công khai / embed của link này, rồi <b>chọn cách con bot
          suy nghĩ</b>. Cách suy nghĩ là một chuỗi AI Agent bạn thiết kế trong Xưởng AI — cùng một
          báo cáo, mỗi link có thể dùng một con bot khác nhau.
        </p>

        <button
          type="button"
          onClick={() => {
            if (!enabled) {
              onChange({
                ...value,
                ai_bot_enabled: true,
                ai_bot_provider: value.ai_bot_provider || 'openai',
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
            {/* THE FLOW PICKER, AND THE DATA DEFINITION THAT MUST COME WITH IT.
                Choosing a flow used to be the whole act, and the runtime then
                worked out what the bot could read: every chart on the dashboard,
                every document the flow's author could see. Nobody ever declared
                anything, so nobody could answer "what does this bot read".

                Now the scope is declared HERE, before the flow is assigned, and a
                link with no valid declaration does not answer at all. */}
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-tiny font-strong text-text-secondary">
                <Workflow className="h-3.5 w-3.5 text-brand" />
                Agent Flow &amp; phạm vi dữ liệu
              </label>
              <FlowBindingEditor linkId={linkId} />
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

            {/* Kept, and relabelled to what it now actually drives.
                Chat stopped reading this — how the bot thinks is the chosen
                flow's prompts. But the executive Brief and Explore features
                still read it, so deleting the field would have quietly emptied
                their context while reworking something else. Collapsed by
                default so it stops competing with the choice above. */}
            <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2">
              <button
                type="button"
                onClick={() => setNotesOpen((o) => !o)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
              >
                <span className="text-tiny font-strong text-text-secondary">
                  Ghi chú ngữ cảnh cho Brief &amp; Khám phá
                  {systemPrompt ? (
                    <span className="ml-1.5 text-tiny font-normal text-text-quaternary tabular-nums">
                      ({systemPrompt.length} ký tự)
                    </span>
                  ) : null}
                </span>
                {notesOpen
                  ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
                  : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />}
              </button>

              {notesOpen && (
            <div className="border-t border-[rgb(var(--border-line))] p-3">
              <p className="mb-2 text-tiny leading-5 text-text-tertiary">
                Chat <b>không</b> dùng ô này nữa — cách trả lời do luồng bạn chọn ở trên quyết định.
                Hai tính năng còn đọc nó là <b>Brief điều hành</b> và <b>Khám phá</b>.
              </p>
              <div className="mb-1 flex items-center justify-end gap-2">
                <AiButton
                  size="xs"
                  onClick={handleGenerate}
                  loading={generating}
                  title="Để AI đọc báo cáo và viết nháp ghi chú (bạn có thể sửa lại)"
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
                  Không hiển thị cho người xem.
                </p>
                <p className="text-tiny text-text-quaternary tabular-nums">
                  {systemPrompt.length}/{MAX_SYSTEM_PROMPT_CHARS}
                </p>
              </div>
            </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
