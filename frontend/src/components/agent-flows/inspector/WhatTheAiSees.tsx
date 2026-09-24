/**
 * "What the AI sees" — the preview that shows an author the prompt a step will
 * actually receive. Extracted whole; it reads a flow and renders, and shares
 * nothing with the editors beyond the field primitives.
 */
// AUTO-EXTRACTED FROM NodeInspector.tsx — see that file's header for why.
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import type { FlowNode, FlowType, StepPreview } from '@/lib/agentFlows';
import { previewStep } from '@/lib/agentFlows';
import { SectionTitle, HintText } from '../shared';

export function WhatTheAiSees({
  brainKey, flowType, nodeKey, nodeName, onClose,
}: {
  brainKey: string; flowType: FlowType; nodeKey: string; nodeName: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [question, setQuestion] = React.useState('Doanh thu tháng này bao nhiêu?');
  const [data, setData] = React.useState<StepPreview | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  /* The report the author already chose in Test. Reusing it beats a second
     picker: on a BOT flow the question "what does this step see" has no answer
     without a report, and making them choose one twice implies the two are
     different.

     A chat flow needs none of this. It is not a bot flow missing its report — it
     is a different surface, and the server assembles the preview from what the
     flow attached, exactly as a real chat turn does. */
  const needsReport = flowType === 'bot';
  const reportId = React.useMemo(() => {
    try {
      const raw = window.localStorage.getItem(`appbi.flowtest.${brainKey}`);
      const id = raw ? JSON.parse(raw)?.reportId : null;
      return typeof id === 'number' ? id : null;
    } catch { return null; }
  }, [brainKey]);

  const load = React.useCallback(async () => {
    if (needsReport && !reportId) return;
    setBusy(true);
    setError('');
    try {
      setData(await previewStep(brainKey, nodeKey, {
        ...(needsReport && reportId ? { dashboard_id: reportId } : {}),
        question,
      }));
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : t('agentFlows.seen.failed'));
    } finally {
      setBusy(false);
    }
  }, [brainKey, needsReport, nodeKey, question, reportId, t]);

  React.useEffect(() => { void load(); /* eslint-disable-next-line */ }, [reportId, needsReport]);

  const sp = data?.system_prompt;
  const yours = sp ? sp.this_step_chars : 0;
  const total = sp ? sp.this_step_chars + sp.shared_base_chars : 0;
  const pct = total ? Math.round((yours / total) * 100) : 0;

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-[rgb(8_9_10/0.12)] pt-10">
      <div className="flex max-h-[86vh] w-[min(880px,94vw)] flex-col overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
        <div className="flex flex-shrink-0 items-start justify-between border-b border-[rgb(var(--border-line))] px-4 py-3">
          <div>
            <h2 className="text-body font-strong">{t('agentFlows.seen.title')}</h2>
            <p className="text-caption text-text-tertiary">
              {nodeName} · {t('agentFlows.seen.subtitle')}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        </div>

        <div className="flex-shrink-0 border-b border-[rgb(var(--border-line))] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void load(); }}
              placeholder={t('agentFlows.seen.questionPlaceholder')}
              className="h-8 flex-1"
            />
            <Button size="sm" variant="secondary" onClick={() => void load()}
                    disabled={busy || (needsReport && !reportId)}>
              {busy ? t('agentFlows.seen.loading') : t('agentFlows.seen.refresh')}
            </Button>
          </div>
          {needsReport && !reportId && (
            <p className="mt-1.5 text-tiny text-warning">{t('agentFlows.seen.needReport')}</p>
          )}
          {!needsReport && (
            <p className="mt-1.5 text-tiny text-text-tertiary">{t('agentFlows.seen.chatNote')}</p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && <p className="text-tiny text-danger">{error}</p>}
          {data && sp && (
            <div className="space-y-4">
              {/* THE HEADLINE. One sentence and one bar: how much of what the model
                  reads is yours. Everything else on this screen is the evidence. */}
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                <p className="text-caption">
                  {t('agentFlows.seen.share', {
                    yours: String(yours), total: String(total), pct: String(pct),
                  })}
                </p>
                <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-surface-1">
                  <div className="bg-brand" style={{ width: `${Math.max(pct, 1)}%` }} />
                  <div className="flex-1 bg-[rgb(var(--border-line))]" />
                </div>
                <p className="mt-2 text-tiny text-text-tertiary">
                  {t(`agentFlows.seen.base.${sp.base_kind}`)}
                </p>
              </div>

              <SeenSection title={t('agentFlows.seen.systemPrompt')} defaultOpen>
                {/* The author's own words marked inside the whole, because the
                    proportion is the lesson and a wall of text hides it. */}
                <PromptWithYours full={sp.full} yours={sp.this_step} />
              </SeenSection>

              <SeenSection
                title={t('agentFlows.seen.messages', { n: String(data.messages.length) })}
                defaultOpen
              >
                <div className="space-y-1.5">
                  {data.messages.map((m, i) => (
                    <div key={i} className="rounded-md border border-[rgb(var(--border-line))] p-2">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="rounded bg-surface-2 px-1.5 text-tiny uppercase tracking-wide text-text-tertiary">
                          {m.role}
                        </span>
                        <span className="text-tiny text-text-quaternary">{m.chars} ký tự</span>
                      </div>
                      <pre className="whitespace-pre-wrap break-words font-mono text-tiny leading-relaxed text-text-secondary">
                        {m.content}
                      </pre>
                    </div>
                  ))}
                </div>
              </SeenSection>

              <SeenSection title={t('agentFlows.seen.tools', { n: String(data.tools.length) })}>
                {/* HOW THIS LIST WAS CHOSEN. A step granted more than the limit is
                    shown a shortlist for the question; the rest stay granted and
                    can be discovered. Said here, because otherwise a granted tool
                    missing from this list looks like a bug. */}
                {data.capabilities && (
                  <p className="mb-1.5 text-tiny leading-snug text-text-tertiary">
                    {data.capabilities.shortlisted
                      ? t('agentFlows.seen.shortlisted', {
                          shown: String(data.capabilities.visible?.length ?? data.tools.length),
                          eligible: String(data.capabilities.eligible.length),
                          granted: String(data.capabilities.granted.length),
                        })
                      : t('agentFlows.seen.allShown', { n: String(data.capabilities.eligible.length) })}
                    {Object.keys(data.capabilities.excluded || {}).length > 0 && (
                      <span className="block text-text-quaternary">
                        {t('agentFlows.seen.excluded', {
                          list: Object.entries(data.capabilities.excluded)
                            .map(([n, why]) => `${n} (${why})`).join(', '),
                        })}
                      </span>
                    )}
                  </p>
                )}
                {data.tools.length === 0 ? (
                  <HintText>{t('agentFlows.seen.noTools')}</HintText>
                ) : (
                  <div className="space-y-1.5">
                    {data.tools.map((tool) => (
                      <div key={tool.name} className="rounded-md border border-[rgb(var(--border-line))] p-2">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <b className="font-mono text-tiny">{tool.name}</b>
                          {tool.required.length > 0 && (
                            <span className="rounded bg-warning/10 px-1.5 text-tiny text-warning">
                              {t('agentFlows.seen.requires', { args: tool.required.join(', ') })}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-tiny leading-snug text-text-tertiary">
                          {tool.description}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </SeenSection>

              {data.pending_upstream.length > 0 && (
                <SeenSection title={t('agentFlows.seen.pending')}>
                  <HintText>{t('agentFlows.seen.pendingHint')}</HintText>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {data.pending_upstream.map((v) => (
                      <span key={v} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-tiny">
                        {`{{${v}}}`}
                      </span>
                    ))}
                  </div>
                </SeenSection>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function SeenSection({
  title, children, defaultOpen = false,
}: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="rounded-lg border border-[rgb(var(--border-line))]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <b className="text-caption font-strong">{title}</b>
        <span className="text-tiny text-text-tertiary">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="border-t border-[rgb(var(--border-line))] p-3">{children}</div>}
    </div>
  );
}

/** The system prompt with the author's own instructions marked inside it.
 *
 *  Split rather than annotated: the backend hands back both the whole string and
 *  the author's part, so the seam is found by locating one in the other. When the
 *  step's prompt uses variables the resolved text will not match the raw one and
 *  the highlight is skipped — showing the prompt unmarked is right, guessing at a
 *  range is not. */
export function PromptWithYours({ full, yours }: { full: string; yours: string }) {
  const at = yours.trim() ? full.indexOf(yours.trim()) : -1;
  if (at < 0) {
    return (
      <pre className="max-h-[38vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-tiny leading-relaxed text-text-secondary">
        {full}
      </pre>
    );
  }
  return (
    <pre className="max-h-[38vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-tiny leading-relaxed text-text-secondary">
      {full.slice(0, at)}
      <mark className="rounded bg-brand/15 text-text-primary">{full.slice(at, at + yours.trim().length)}</mark>
      {full.slice(at + yours.trim().length)}
    </pre>
  );
}


