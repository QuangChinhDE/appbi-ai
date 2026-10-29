'use client';

import { useEffect, useState } from 'react';
import { Bot, Workflow } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AiModelProvider, PublicLinkAppearanceConfig } from '@/types/api';
import { Input } from '@/components/ui/Input';
import { dashboardApi } from '@/lib/api/dashboards';
import { AiModelKeyPicker } from '@/components/common/AiModelKeyPicker';
import { FlowBindingEditor, type BindingFlush } from '@/components/common/FlowBindingEditor';
import { PublisherGuideEditor } from '@/components/common/PublisherGuideEditor';

// The AI assistant of one public link.
//
// PO directive (2026-10-28): the public Dashboard AI Bot is a consumer of the ONE
// Answer Core. Viewers ask about the published report and the Core answers from its
// charts, with the link's filters, locks and pages. No flow to pick first. The MODEL
// and the API KEY are the publisher's (pasted here, stored encrypted, never shown
// again) - there is no server default; the budget below is enforced on the server
// for every model call.
//
// An Agent Flow stays available as an OPTIONAL add-on: the Core may call it for
// documents (policies, procedures); it never answers in the Core's place and never
// reads data.

interface PublicLinkAiBotEditorProps {
  value: PublicLinkAppearanceConfig;
  onChange: (value: PublicLinkAppearanceConfig) => void;
  dashboardId: number;
  /** Null while the link is still being created. */
  linkId: number | null;
  /** Passed straight to the flow editor so the modal's own Save can write a flow
   *  the author picked here (see `FlowBindingEditorProps.registerFlush`). */
  registerBindingFlush?: (flush: BindingFlush | null) => void;
}

type Readiness = { ready: boolean; provider: string | null; model: string | null;
                   credential: 'link' | null; missing?: 'key' | 'model' };

function asPositive(raw: string): number | null {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function PublicLinkAiBotEditor({
  value, onChange, dashboardId, linkId, registerBindingFlush,
}: PublicLinkAiBotEditorProps) {
  const enabled = value.ai_bot_enabled === true;
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [providers, setProviders] = useState<AiModelProvider[]>([]);

  useEffect(() => {
    if (!enabled) return undefined;
    let stale = false;
    dashboardApi.getPublicLinkAiModels()
      .then((r) => { if (!stale) setProviders(r.providers || []); })
      .catch(() => { if (!stale) setProviders([]); });
    return () => { stale = true; };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !linkId) return undefined;
    let stale = false;
    dashboardApi.getPublicLinkAiStatus(dashboardId, linkId)
      .then((r) => { if (!stale) setReadiness(r); })
      .catch(() => { if (!stale) setReadiness(null); });
    return () => { stale = true; };
  }, [dashboardId, enabled, linkId, value.ai_bot_credential_id, value.ai_bot_model]);

  const patch = <K extends keyof PublicLinkAppearanceConfig>(key: K, next: PublicLinkAppearanceConfig[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
        <div className="mb-3 flex items-center gap-2 text-text-primary">
          <Bot className="h-4 w-4 text-brand" />
          <h3 className="text-small font-strong">Trợ lý AI của báo cáo</h3>
        </div>
        <p className="mb-4 text-caption leading-6 text-text-tertiary">
          Người xem link công khai hỏi về số liệu của báo cáo; trợ lý trả lời từ chính các biểu đồ đã
          công khai, đúng bộ lọc và khoá của link này. Chọn model và dán API key của bạn để trợ lý hoạt động.
        </p>

        <button
          type="button"
          data-testid="ai-bot-enable-toggle"
          onClick={() => patch('ai_bot_enabled', !enabled)}
          className={cn(
            'flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-3 text-left transition-colors',
            enabled
              ? 'border-brand bg-brand text-text-inverse shadow-linear-sm'
              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2',
          )}
        >
          <div>
            <p className="text-caption font-emphasis">Bật trợ lý AI</p>
            <p className={cn('mt-1 text-tiny leading-5', enabled ? 'text-text-inverse/80' : 'text-text-tertiary')}>
              Hiện trợ lý cho người xem trang công khai của link này.
            </p>
          </div>
          <span
            className={cn(
              'mt-0.5 inline-flex h-6 w-11 flex-shrink-0 rounded-full border p-0.5 transition',
              enabled ? 'border-white/15 bg-white/10' : 'border-[rgb(var(--border-strong))] bg-surface-2',
            )}
          >
            <span className={cn('h-4 w-4 rounded-full bg-white transition-transform', enabled ? 'translate-x-5' : 'translate-x-0')} />
          </span>
        </button>

        {enabled && (
          <div className="mt-4 space-y-4 rounded-lg border border-brand/20 bg-brand/5 p-4">
            <div>
              <p className="mb-2 text-tiny font-strong text-text-secondary">Model và API key của trợ lý</p>
              {providers.length > 0 ? (
                <AiModelKeyPicker
                  providers={providers}
                  testId="ai-bot-model-key"
                  keyHint={value.ai_bot_key_configured ? value.ai_bot_key_hint : null}
                  value={{ provider: value.ai_bot_provider || 'openai', model: value.ai_bot_model || '',
                           apiKey: value.ai_bot_key || '' }}
                  onChange={(next) => onChange({
                    ...value, ai_bot_provider: next.provider, ai_bot_model: next.model,
                    ai_bot_key: next.apiKey || undefined,
                  })}
                />
              ) : (
                <p className="text-tiny text-text-tertiary">Đang tải danh sách model…</p>
              )}
            </div>

            <div data-testid="ai-bot-readiness">
              {!linkId ? (
                <p className="text-tiny text-text-tertiary">Lưu link để kiểm tra trạng thái trợ lý.</p>
              ) : readiness === null ? (
                <p className="text-tiny text-text-tertiary">Đang kiểm tra trạng thái trợ lý…</p>
              ) : readiness.ready ? (
                <p className="flex items-center gap-1.5 text-tiny text-text-secondary" data-ready="true">
                  <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success" />
                  Trợ lý sẵn sàng — {readiness.model} với API key của bạn (đã mã hoá).
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-tiny text-warning" data-ready="false">
                  <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning" />
                  {readiness.missing === 'model'
                    ? 'Chưa chọn model cho API key của link. Người xem sẽ thấy trợ lý chưa sẵn sàng.'
                    : 'Chưa có API key cho trợ lý. Người xem sẽ thấy trợ lý chưa sẵn sàng.'}
                </p>
              )}
            </div>

            <div>
              <p className="mb-1 text-tiny font-strong text-text-secondary">Hướng dẫn cho trợ lý</p>
              <p className="mb-2 text-tiny leading-5 text-text-tertiary">
                Mỗi phần có một công dụng rõ ràng: thuật ngữ giúp chọn đúng biểu đồ, định nghĩa được trả nguyên văn,
                mục tiêu được hệ thống tự so sánh, nguyên nhân chỉ lấy từ biểu đồ nguồn. Người xem không thấy nguyên văn
                hướng dẫn, nhưng trợ lý có thể nêu nội dung trong đó khi trả lời - đừng ghi thông tin không muốn công khai.
              </p>
              <PublisherGuideEditor
                value={value.ai_bot_guide}
                onChange={(guide) => patch('ai_bot_guide', guide)}
                dashboardId={dashboardId}
                linkId={linkId}
              />
            </div>

            <label className="block">
              <span className="mb-1 block text-tiny font-strong text-text-secondary">Ghi chú khác (tự do)</span>
              <textarea
                value={value.ai_bot_report_context_note ?? ''}
                rows={4}
                onChange={(e) => patch('ai_bot_report_context_note', e.target.value || null)}
                placeholder={'Điều chưa có ô riêng ở trên, ví dụ:\n'
                  + '- Khi phân tích, ưu tiên so sánh theo tháng và chỉ ra 3 khu vực đóng góp lớn nhất.'}
                className="w-full resize-y rounded-md border border-stroke-strong bg-surface-1 px-3 py-2 text-caption text-text-primary placeholder:text-text-quaternary focus:border-brand focus:outline-none"
                data-testid="ai-bot-instructions"
              />
              <span className="mt-1 block text-tiny leading-5 text-text-tertiary">
                Văn bản tự do, dùng như trước. Ưu tiên các ô có cấu trúc ở trên: chúng được dùng chính xác hơn
                (thuật ngữ, định nghĩa, mục tiêu được hệ thống xử lý trực tiếp, không phụ thuộc AI đoán).
              </span>
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-tiny font-strong text-text-secondary">Hạn mức chi phí / 24 giờ (USD)</span>
                <Input
                  type="number"
                  min={0}
                  step="0.5"
                  value={value.ai_bot_budget_usd_per_day ?? ''}
                  placeholder="Mặc định của hệ thống"
                  onChange={(e) => patch('ai_bot_budget_usd_per_day', asPositive(e.target.value))}
                  data-testid="ai-bot-budget-usd"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-tiny font-strong text-text-secondary">Số câu hỏi tối đa / giờ</span>
                <Input
                  type="number"
                  min={0}
                  step="1"
                  value={value.ai_bot_turns_per_hour ?? ''}
                  placeholder="Mặc định của hệ thống"
                  onChange={(e) => patch('ai_bot_turns_per_hour', asPositive(e.target.value))}
                  data-testid="ai-bot-budget-turns"
                />
              </label>
            </div>

            <div>
              <label className="mb-1 flex items-center gap-1.5 text-tiny font-strong text-text-secondary">
                <Workflow className="h-3.5 w-3.5 text-brand" />
                Agent Flow hỗ trợ (tuỳ chọn)
              </label>
              <p className="mb-2 text-tiny leading-5 text-text-tertiary">
                Không bắt buộc. Nếu gắn, trợ lý có thể gọi luồng này để tra tài liệu (chính sách, quy trình) khi
                câu hỏi cần; luồng không trả lời thay trợ lý và không đọc số liệu.
              </p>
              <FlowBindingEditor linkId={linkId} registerFlush={registerBindingFlush} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
