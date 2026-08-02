'use client';

/**
 * Send-for-review / publish, with the blast radius in front of the person
 * pressing the button.
 *
 * The checkbox is not ceremony: publishing swaps the AI's behaviour on reports
 * that are already shared with customers. Showing "2 assistants · 6 links"
 * beside the confirm is the difference between an approval and a reflex.
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/providers/LanguageProvider';
import {
  type EvalResult, type FlowDetail, type FlowDiff, type FlowImpact, getFlowImpact,
} from '@/lib/aiFlows';

interface Props {
  flow: FlowDetail;
  diff: FlowDiff | null;
  evalResult: EvalResult | null;
  canPublish: boolean;
  onClose: () => void;
  onSendReview: () => void;
  onPublish: () => void;
}

export function PublishDialog({
  flow, diff, evalResult, canPublish, onClose, onSendReview, onPublish,
}: Props) {
  const { t } = useI18n();
  const [impact, setImpact] = useState<FlowImpact | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getFlowImpact(flow.flow_key).then(setImpact).catch(() => setImpact(null));
  }, [flow.flow_key]);

  const isReview = flow.status !== 'in_review';
  const hardFails = (evalResult?.checks ?? []).filter((c) => c.hard && !c.passed);
  const blocked = hardFails.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-body font-strong text-text-primary">
          {isReview ? t('aiFlows.review.title') : t('aiFlows.builder.publish')}
        </h2>
        <p className="mb-4 text-caption text-text-secondary">
          {flow.display_name} · v{flow.version}
        </p>

        <div className="space-y-4">
          {/* Impact */}
          <section>
            <h3 className="mb-1 text-tiny font-strong uppercase tracking-wide text-text-quaternary">
              {t('aiFlows.review.impact')}
            </h3>
            {impact === null ? (
              <div className="flex items-center gap-2 text-caption text-text-tertiary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('aiFlows.common.loading')}
              </div>
            ) : (
              <>
                <p className="text-caption text-text-primary">
                  {t('aiFlows.review.impactBody', {
                    assistants: impact.assistant_count,
                    bindings: impact.binding_count,
                  })}
                </p>
                {impact.assistants.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {impact.assistants.map((a) => (
                      <Badge key={a.key} variant="info" size="xs">{a.display_name}</Badge>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          {/* Diff */}
          <section>
            <h3 className="mb-1 text-tiny font-strong uppercase tracking-wide text-text-quaternary">
              {t('aiFlows.review.diff')}
            </h3>
            {!diff || diff.is_first_publish ? (
              <p className="text-caption text-text-tertiary">{t('aiFlows.review.firstPublish')}</p>
            ) : (
              <div className="space-y-1">
                {(['nodes_added', 'nodes_removed', 'nodes_changed'] as const).map((k) => {
                  const items = diff[k];
                  if (!items?.length) return null;
                  const label = k === 'nodes_added' ? t('aiFlows.review.added')
                    : k === 'nodes_removed' ? t('aiFlows.review.removed')
                    : t('aiFlows.review.changed');
                  const tone = k === 'nodes_added' ? 'success'
                    : k === 'nodes_removed' ? 'danger' : 'warning';
                  return (
                    <div key={k} className="flex flex-wrap items-center gap-1">
                      <span className="text-tiny text-text-tertiary">{label}</span>
                      {items.map((i) => <Badge key={i} variant={tone} size="xs">{i}</Badge>)}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Gate */}
          <section>
            <h3 className="mb-1 text-tiny font-strong uppercase tracking-wide text-text-quaternary">
              {t('aiFlows.eval.title')}
            </h3>
            {!evalResult ? (
              <p className="flex items-center gap-1.5 text-caption text-warning">
                <AlertTriangle className="h-3.5 w-3.5" /> {t('aiFlows.eval.run')}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {evalResult.checks.map((c) => (
                  <li key={c.key} className="flex items-center gap-2 text-caption">
                    {c.passed
                      ? <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                      : <XCircle className="h-3.5 w-3.5 text-danger" />}
                    <span className="flex-1 text-text-primary">{c.label_vi}</span>
                    {c.detail && <span className="text-tiny text-text-tertiary">{c.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {!isReview && (
            <label className="flex items-start gap-2 rounded-lg border border-[rgb(var(--border-line))] p-2.5 text-caption text-text-secondary">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {t('aiFlows.review.confirm')}
            </label>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('aiFlows.common.cancel')}</Button>
          {isReview ? (
            <Button
              variant="primary"
              disabled={busy || blocked}
              title={blocked ? t('aiFlows.eval.cannotPublish') : undefined}
              onClick={() => { setBusy(true); onSendReview(); }}
            >
              {t('aiFlows.review.submit')}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!canPublish || !confirmed || blocked || busy}
              title={!canPublish ? t('aiFlows.perm.needFull') : undefined}
              onClick={() => { setBusy(true); onPublish(); }}
            >
              {t('aiFlows.builder.publish')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
