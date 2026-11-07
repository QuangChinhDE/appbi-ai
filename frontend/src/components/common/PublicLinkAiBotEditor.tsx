'use client';

import React, { useEffect, useState } from 'react';
import { BookOpen, Bot, Check, Sparkles, Workflow } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AiModelProvider, PublicLinkAiCatalog, PublicLinkAppearanceConfig } from '@/types/api';
import { Input } from '@/components/ui/Input';
import { dashboardApi } from '@/lib/api/dashboards';
import { AiModelKeyPicker } from '@/components/common/AiModelKeyPicker';
import { FlowBindingEditor, type BindingFlush } from '@/components/common/FlowBindingEditor';
import { PublisherGuideEditor } from '@/components/common/PublisherGuideEditor';
import { PublicLinkClaudeAccess } from '@/components/public-claude/PublicLinkClaudeAccess';
import { useI18n } from '@/providers/LanguageProvider';

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
  /** A report link reads its own readiness and catalog; absent = the dashboard's. */
  aiStatusOf?: (linkId: number) => Promise<Readiness>;
  aiCatalogOf?: (linkId: number) => Promise<PublicLinkAiCatalog>;
  /** The Agent Flow add-on is a dashboard-link binding; a report link has none. */
  allowFlow?: boolean;
}

type Readiness = { ready: boolean; provider: string | null; model: string | null;
                   credential: 'link' | null; missing?: 'key' | 'model' };

function asPositive(raw: string): number | null {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function PublicLinkAiBotEditor({
  value, onChange, dashboardId, linkId, registerBindingFlush, aiStatusOf, aiCatalogOf, allowFlow = true,
}: PublicLinkAiBotEditorProps) {
  const { t } = useI18n();
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
    (aiStatusOf ? aiStatusOf(linkId) : dashboardApi.getPublicLinkAiStatus(dashboardId, linkId))
      .then((r) => { if (!stale) setReadiness(r); })
      .catch(() => { if (!stale) setReadiness(null); });
    return () => { stale = true; };
  }, [dashboardId, enabled, linkId, value.ai_bot_credential_id, value.ai_bot_model]);

  const patch = <K extends keyof PublicLinkAppearanceConfig>(key: K, next: PublicLinkAppearanceConfig[K]) =>
    onChange({ ...value, [key]: next });

  const claudeOn = value.mcp_access?.enabled === true;
  const setClaude = (on: boolean) => onChange({ ...value, mcp_access: { ...(value.mcp_access || {}), enabled: on } });
  const guideUnused = !enabled && claudeOn && value.mcp_access?.share_guide !== true;

  return (
    <div className="space-y-4">
      <section className={CARD}>
        <SectionHead icon={<Bot className="h-4 w-4 text-brand" />} title="Trợ lý cho người xem"
          hint="Chọn một hoặc cả hai. Không chọn: người xem không thấy trợ lý." />
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" role="group" aria-label="Chế độ trợ lý">
          <ModeCard testId="ai-bot-enable-toggle" active={enabled} onClick={() => patch('ai_bot_enabled', !enabled)}
            icon={<Bot className="h-4 w-4" />} title="AppBI AI" hint="Dùng model và API key của bạn." />
          <ModeCard testId="link-claude-enabled" active={claudeOn} onClick={() => setClaude(!claudeOn)}
            icon={<Sparkles className="h-4 w-4" />} title={t('publicClaude.owner.enable')} hint={t('publicClaude.owner.enableHint')} />
        </div>
        {enabled && claudeOn && (
          <p className="mt-3 text-tiny text-text-tertiary" data-testid="ai-mode-both-hint">
            Người xem chuyển giữa AppBI AI và Claude ngay trong khung trợ lý.
          </p>
        )}
      </section>

      {enabled && (
        <section className={CARD} data-testid="ai-bot-appbi-config">
          <SectionHead icon={<Bot className="h-4 w-4 text-brand" />} title="AppBI AI" />
          <div className="mt-4 space-y-5">
            <div>
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
              <div className="mt-2" data-testid="ai-bot-readiness">
                {!linkId ? (
                  <p className="text-tiny text-text-tertiary">Lưu link để kiểm tra trạng thái trợ lý.</p>
                ) : readiness === null ? (
                  <p className="text-tiny text-text-tertiary">Đang kiểm tra trạng thái trợ lý…</p>
                ) : readiness.ready ? (
                  <p className="flex items-center gap-1.5 text-tiny text-text-secondary" data-ready="true">
                    <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success" />
                    Sẵn sàng — {readiness.model}
                  </p>
                ) : (
                  <p className="flex items-center gap-1.5 text-tiny text-warning" data-ready="false">
                    <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning" />
                    {readiness.missing === 'model' ? 'Chưa chọn model.' : 'Chưa có API key.'}
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <FieldLabel>Hạn mức chi phí / 24 giờ (USD)</FieldLabel>
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
                <FieldLabel>Số câu hỏi tối đa / giờ</FieldLabel>
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

            {allowFlow && <div className="border-t border-[rgb(var(--border-line))] pt-4">
              <FieldLabel icon={<Workflow className="h-3.5 w-3.5 text-brand" />}>Agent Flow hỗ trợ (tuỳ chọn)</FieldLabel>
              <p className="mb-2 text-tiny leading-5 text-text-tertiary">Tra tài liệu (chính sách, quy trình) khi câu hỏi cần.</p>
              <FlowBindingEditor linkId={linkId} registerFlush={registerBindingFlush} />
            </div>}
          </div>
        </section>
      )}

      {claudeOn && <PublicLinkClaudeAccess value={value} onChange={onChange} />}

      {(enabled || claudeOn) && (
        <section className={CARD} data-testid="ai-bot-guide-section">
          <SectionHead icon={<BookOpen className="h-4 w-4 text-brand" />} title="Hướng dẫn trả lời"
            hint={enabled && claudeOn ? 'Dùng cho AppBI AI, và cho Claude khi bật "Chia sẻ hướng dẫn".' : undefined} />
          {guideUnused && (
            <p className="mt-3 rounded-md bg-warning/10 px-3 py-2 text-tiny text-warning" data-testid="ai-bot-guide-unused">
              Claude chưa dùng phần này: bật &quot;Chia sẻ hướng dẫn&quot; ở trên.
            </p>
          )}
          <div className="mt-3 space-y-5">
            <PublisherGuideEditor
              value={value.ai_bot_guide}
              onChange={(guide) => patch('ai_bot_guide', guide)}
              dashboardId={dashboardId}
              linkId={linkId}
              catalogOf={aiCatalogOf}
            />
            <label className="block">
              <FieldLabel>Ghi chú khác</FieldLabel>
              <textarea
                value={value.ai_bot_report_context_note ?? ''}
                rows={4}
                onChange={(e) => patch('ai_bot_report_context_note', e.target.value || null)}
                placeholder="Ví dụ: khi phân tích, ưu tiên so sánh theo tháng và chỉ ra 3 khu vực đóng góp lớn nhất."
                className="w-full resize-y rounded-md border border-stroke-strong bg-surface-1 px-3 py-2 text-caption text-text-primary placeholder:text-text-quaternary focus:border-brand focus:outline-none"
                data-testid="ai-bot-instructions"
              />
            </label>
          </div>
        </section>
      )}
    </div>
  );
}

const CARD = 'rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm';

function SectionHead({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div>
      <div className="flex items-center gap-2">{icon}<h3 className="text-small font-strong text-text-primary">{title}</h3></div>
      {hint && <p className="mt-1 text-tiny leading-5 text-text-tertiary">{hint}</p>}
    </div>
  );
}

function FieldLabel({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return <span className="mb-1.5 flex items-center gap-1.5 text-tiny font-strong text-text-secondary">{icon}{children}</span>;
}

function ModeCard({ active, onClick, icon, title, hint, testId }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; title: string; hint: string; testId: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={active} data-testid={testId} data-checked={active} onClick={onClick}
      className={cn('relative flex items-start gap-3 rounded-lg border p-3.5 text-left transition-colors',
        active ? 'border-brand bg-brand/5 ring-1 ring-brand'
          : 'border-[rgb(var(--border-line))] bg-surface-1 hover:border-[rgb(var(--border-strong))] hover:bg-surface-2')}>
      <span className={cn('flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md',
        active ? 'bg-brand text-white' : 'bg-surface-2 text-text-tertiary')}>{icon}</span>
      <span className="min-w-0 flex-1 pr-6">
        <span className="block text-caption font-strong text-text-primary">{title}</span>
        <span className="mt-0.5 block text-tiny leading-5 text-text-tertiary">{hint}</span>
      </span>
      <span className={cn('absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full border',
        active ? 'border-brand bg-brand text-white' : 'border-[rgb(var(--border-strong))] bg-surface-1')}>
        {active && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
    </button>
  );
}
