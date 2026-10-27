'use client';

import { useEffect, useState } from 'react';
import { Bot, Workflow } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PublicLinkAppearanceConfig } from '@/types/api';
import { Input } from '@/components/ui/Input';
import { dashboardApi } from '@/lib/api/dashboards';
import { FlowBindingEditor, type BindingFlush } from '@/components/common/FlowBindingEditor';

// The AI assistant of one public link.
//
// PO directive (2026-10-28): the public Dashboard AI Bot is a consumer of the ONE
// Answer Core. Turning it on is enough: viewers ask about the published report and
// the Core answers from its charts, with the link's filters, locks and pages. There
// is no flow to pick first, no key to paste, no model or "thinking" mode to choose:
// the credential is the server's (or a key this link already had, kept encrypted),
// and the budget below is enforced on the server for every model call.
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

type Readiness = { ready: boolean; provider: string | null; credential: 'server' | 'link' | null };

function asPositive(raw: string): number | null {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function PublicLinkAiBotEditor({
  value, onChange, dashboardId, linkId, registerBindingFlush,
}: PublicLinkAiBotEditorProps) {
  const enabled = value.ai_bot_enabled === true;
  const [readiness, setReadiness] = useState<Readiness | null>(null);

  useEffect(() => {
    if (!enabled || !linkId) return undefined;
    let stale = false;
    dashboardApi.getPublicLinkAiStatus(dashboardId, linkId)
      .then((r) => { if (!stale) setReadiness(r); })
      .catch(() => { if (!stale) setReadiness(null); });
    return () => { stale = true; };
  }, [dashboardId, enabled, linkId, value.ai_bot_credential_id]);

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
          công khai, đúng bộ lọc và khoá của link này. Không cần tạo Agent Flow hay nhập API key.
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
            <div data-testid="ai-bot-readiness">
              {!linkId ? (
                <p className="text-tiny text-text-tertiary">Lưu link để kiểm tra trạng thái mô hình AI.</p>
              ) : readiness === null ? (
                <p className="text-tiny text-text-tertiary">Đang kiểm tra mô hình AI…</p>
              ) : readiness.ready ? (
                <p className="flex items-center gap-1.5 text-tiny text-text-secondary">
                  <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success" />
                  Mô hình AI sẵn sàng
                  {readiness.credential === 'link' ? ' — dùng API key riêng của link (đã mã hoá).'
                    : ' — dùng cấu hình AI của hệ thống.'}
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-tiny text-warning">
                  <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning" />
                  Chưa có mô hình AI được cấu hình trên máy chủ. Người xem sẽ thấy trợ lý chưa sẵn sàng.
                </p>
              )}
              {value.ai_bot_key_configured && (
                <button
                  type="button"
                  className="mt-1.5 text-tiny text-brand underline-offset-2 hover:underline"
                  onClick={() => onChange({ ...value, ai_bot_credential_id: null, ai_bot_key_configured: false })}
                >
                  Bỏ API key riêng, dùng cấu hình AI của hệ thống
                </button>
              )}
            </div>

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
