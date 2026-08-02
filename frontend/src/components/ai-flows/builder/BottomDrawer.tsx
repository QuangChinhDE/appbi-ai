'use client';

/**
 * The drawer under the canvas: checks, test run, release gate, trace, changes.
 *
 * It lives below the canvas rather than in a dialog because every one of those
 * panels is something you read WHILE looking at the graph — an error you cannot
 * see the node for is just a sentence, and a test run you cannot watch on the
 * canvas is just a log.
 */
import React, { useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info, Lightbulb,
  Loader2, Play, Square, XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import { useI18n } from '@/providers/LanguageProvider';
import type {
  EvalResult, FlowDiff, PreviewEvent, Surfaces, ValidationError, ValidationResult,
} from '@/lib/aiFlows';

export type DrawerTab = 'validation' | 'preview' | 'eval' | 'trace' | 'changes';

interface Props {
  open: boolean;
  tab: DrawerTab;
  onTab: (t: DrawerTab) => void;
  onToggle: () => void;

  validation: ValidationResult | null;
  onFocusNode: (key: string) => void;

  // Preview
  surfaces: Surfaces | null;
  previewToken: string;
  previewQuestion: string;
  previewRunning: boolean;
  previewAnswer: string;
  previewStatus: string;
  previewError: string;
  previewSummary: PreviewEvent | null;
  previewTrace: { node: string; ok: boolean; latencyMs?: number }[];
  onPreviewToken: (v: string) => void;
  onPreviewQuestion: (v: string) => void;
  onPreviewRun: () => void;
  onPreviewStop: () => void;

  // Eval
  evalResult: EvalResult | null;
  evalRunning: boolean;
  onRunEval: () => void;

  // Changes
  diff: FlowDiff | null;
  dirty: boolean;
}

export function BottomDrawer(p: Props) {
  const { t } = useI18n();
  const counts = p.validation?.counts ?? { error: 0, warning: 0, suggestion: 0 };

  return (
    <div
      className="flex flex-col border-t border-[rgb(var(--border-line))] bg-surface-1"
      style={{ height: p.open ? 300 : 44 }}
    >
      <div className="flex flex-shrink-0 items-center gap-3 px-3" style={{ height: 44 }}>
        <Tabs
          size="sm"
          value={p.tab}
          onChange={(k) => { p.onTab(k as DrawerTab); if (!p.open) p.onToggle(); }}
          items={[
            {
              key: 'validation',
              label: t('aiFlows.validation.title'),
              badge: counts.error > 0
                ? <Badge variant="danger" size="xs">{counts.error}</Badge>
                : counts.warning > 0
                  ? <Badge variant="warning" size="xs">{counts.warning}</Badge>
                  : undefined,
            },
            { key: 'preview', label: t('aiFlows.preview.title') },
            { key: 'eval', label: t('aiFlows.eval.title') },
            { key: 'trace', label: t('aiFlows.preview.trace') },
            {
              key: 'changes',
              label: t('aiFlows.review.diff'),
              badge: p.dirty ? <Badge variant="warning" size="xs">•</Badge> : undefined,
            },
          ]}
        />
        <div className="ml-auto">
          <Button variant="ghost" size="xs" onClick={p.onToggle}>
            {p.open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {p.open && (
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-[rgb(var(--border-line))] p-3">
          {p.tab === 'validation' && (
            <ValidationTab validation={p.validation} onFocus={p.onFocusNode} />
          )}
          {p.tab === 'preview' && <PreviewTab {...p} />}
          {p.tab === 'eval' && (
            <EvalTab result={p.evalResult} running={p.evalRunning} onRun={p.onRunEval} />
          )}
          {p.tab === 'trace' && <TraceTab trace={p.previewTrace} />}
          {p.tab === 'changes' && <ChangesTab diff={p.diff} dirty={p.dirty} />}
        </div>
      )}
    </div>
  );
}

// ── Validation ──────────────────────────────────────────────────────────────
function severityIcon(sev: string) {
  if (sev === 'error') return <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-danger" />;
  if (sev === 'warning') return <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-warning" />;
  return <Lightbulb className="h-3.5 w-3.5 flex-shrink-0 text-info" />;
}

function ValidationTab({ validation, onFocus }: {
  validation: ValidationResult | null;
  onFocus: (key: string) => void;
}) {
  const { t } = useI18n();
  const issues = validation?.issues ?? [];
  if (!issues.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-soft/[0.07] px-3 py-2 text-caption text-success">
        <CheckCircle2 className="h-4 w-4" /> {t('aiFlows.validation.ok')}
      </div>
    );
  }
  const c = validation!.counts;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {c.error > 0 && (
          <Badge variant="danger" size="sm">
            {t('aiFlows.validation.errors', { count: c.error })}
          </Badge>
        )}
        {c.warning > 0 && (
          <Badge variant="warning" size="sm">
            {t('aiFlows.validation.warnings', { count: c.warning })}
          </Badge>
        )}
        {c.suggestion > 0 && (
          <Badge variant="info" size="sm">
            {t('aiFlows.validation.suggestions', { count: c.suggestion })}
          </Badge>
        )}
      </div>
      <ul className="space-y-1">
        {issues.map((i: ValidationError, idx) => (
          <li
            key={idx}
            className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2"
          >
            {severityIcon(i.severity)}
            <span className="min-w-0 flex-1">
              <span className="block text-caption text-text-primary">{i.message}</span>
              {i.suggested_action && (
                <span className="block text-tiny text-text-tertiary">{i.suggested_action}</span>
              )}
            </span>
            {i.node_key && (
              <Button variant="ghost" size="xs" onClick={() => onFocus(i.node_key!)}>
                {t('aiFlows.validation.jumpTo')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Preview ─────────────────────────────────────────────────────────────────
function PreviewTab(p: Props) {
  const { t } = useI18n();
  const s = p.previewSummary;
  const cov = s?.verification?.coverage;
  return (
    <div className="grid gap-3 lg:grid-cols-[320px,1fr]">
      <div className="space-y-2">
        <div>
          <Label>{t('aiFlows.preview.report')}</Label>
          <Select
            value={p.previewToken}
            disabled={p.previewRunning}
            onChange={(e) => p.onPreviewToken(e.target.value)}
          >
            <option value="">—</option>
            {(p.surfaces?.public_links ?? []).map((l) => (
              <option key={l.token} value={l.token}>{l.dashboard_name}</option>
            ))}
          </Select>
          {p.surfaces && p.surfaces.public_links.length === 0 && (
            <p className="mt-1 text-tiny text-warning">{t('aiFlows.preview.noLinks')}</p>
          )}
        </div>
        <div>
          <Label>{t('aiFlows.preview.question')}</Label>
          <Input
            value={p.previewQuestion}
            disabled={p.previewRunning}
            onChange={(e) => p.onPreviewQuestion(e.target.value)}
          />
        </div>
        {p.previewRunning ? (
          <Button variant="secondary" size="sm" className="w-full" onClick={p.onPreviewStop}>
            <Square className="h-3.5 w-3.5" /> {t('aiFlows.preview.stop')}
          </Button>
        ) : (
          <Button
            variant="primary" size="sm" className="w-full"
            disabled={!p.previewToken} onClick={p.onPreviewRun}
          >
            <Play className="h-3.5 w-3.5" /> {t('aiFlows.preview.run')}
          </Button>
        )}
        {p.previewStatus && (
          <div className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-tiny text-text-secondary">
            <Loader2 className="h-3 w-3 animate-spin" /> {p.previewStatus}
          </div>
        )}
        {s && (
          <div className="space-y-1 rounded-lg border border-[rgb(var(--border-line))] p-2">
            <div className="text-tiny font-strong uppercase tracking-wide text-text-quaternary">
              {t('aiFlows.preview.summary')}
            </div>
            <div className="flex flex-wrap gap-1">
              <Badge variant="subtle" size="xs">
                {t('aiFlows.preview.aiCalls', { count: s.model_calls ?? 0 })}
              </Badge>
              <Badge variant="subtle" size="xs">
                {t('aiFlows.preview.toolCalls', { count: s.tool_calls ?? 0 })}
              </Badge>
              <Badge variant="subtle" size="xs">${(s.usd ?? 0).toFixed(4)}</Badge>
              {cov != null ? (
                <Badge variant={cov >= 0.999 ? 'success' : 'warning'} size="xs">
                  {t('aiFlows.preview.verified', { percent: Math.round(cov * 100) })}
                </Badge>
              ) : (
                <Badge variant="subtle" size="xs">{t('aiFlows.preview.notVerified')}</Badge>
              )}
            </div>
            {cov == null && (
              <p className="text-[10px] leading-tight text-text-tertiary">
                {t('aiFlows.preview.notVerifiedHint')}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-2">
        {p.previewError && (
          <div className="whitespace-pre-wrap rounded-lg border border-danger/30 bg-danger/[0.05] p-2 text-tiny text-danger">
            {p.previewError}
          </div>
        )}
        <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-2.5">
          <div className="mb-1 text-tiny font-strong uppercase tracking-wide text-text-quaternary">
            {t('aiFlows.preview.answer')}
          </div>
          {p.previewAnswer ? (
            <div className="whitespace-pre-wrap text-caption leading-relaxed text-text-primary">
              {p.previewAnswer}
            </div>
          ) : (
            <div className="text-tiny text-text-quaternary">—</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Eval ────────────────────────────────────────────────────────────────────
function EvalTab({ result, running, onRun }: {
  result: EvalResult | null; running: boolean; onRun: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={running} onClick={onRun}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          {t('aiFlows.eval.run')}
        </Button>
        {result && (
          <>
            <Badge variant={result.can_publish ? 'success' : 'danger'} size="sm">
              {result.can_publish ? t('aiFlows.eval.canPublish') : t('aiFlows.eval.cannotPublish')}
            </Badge>
            <span className="text-caption text-text-secondary">
              {t('aiFlows.eval.passRate', { passed: result.passed, total: result.total })}
            </span>
          </>
        )}
      </div>

      {result && (
        <>
          <ul className="space-y-1">
            {result.checks.map((c) => (
              <li key={c.key} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-2">
                {c.passed
                  ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-success" />
                  : <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-danger" />}
                <span className="flex-1 text-caption text-text-primary">{c.label_vi}</span>
                {c.detail && <span className="text-tiny text-text-tertiary">{c.detail}</span>}
                <Badge variant={c.hard ? 'neutral' : 'subtle'} size="xs">
                  {c.hard ? t('aiFlows.eval.hard') : t('aiFlows.eval.soft')}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="flex items-start gap-1.5 text-tiny text-text-tertiary">
            <Info className="mt-px h-3 w-3 flex-shrink-0" /> {result.note}
          </p>
        </>
      )}
    </div>
  );
}

// ── Trace ───────────────────────────────────────────────────────────────────
function TraceTab({ trace }: { trace: { node: string; ok: boolean; latencyMs?: number }[] }) {
  const { t } = useI18n();
  if (!trace.length) {
    return <div className="text-caption text-text-tertiary">{t('aiFlows.runs.empty')}</div>;
  }
  return (
    <ol className="space-y-1">
      {trace.map((s, i) => (
        <li key={i} className="flex items-center gap-2 text-caption">
          <span className="w-5 text-tiny text-text-quaternary">{i + 1}</span>
          {s.ok
            ? <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            : <XCircle className="h-3.5 w-3.5 text-danger" />}
          <code className="font-emphasis text-text-primary">{s.node}</code>
          {s.latencyMs != null && (
            <span className="ml-auto text-tiny text-text-tertiary">{s.latencyMs}ms</span>
          )}
        </li>
      ))}
    </ol>
  );
}

// ── Changes ─────────────────────────────────────────────────────────────────
function ChangesTab({ diff, dirty }: { diff: FlowDiff | null; dirty: boolean }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      {dirty && (
        <Badge variant="warning" size="sm">{t('aiFlows.builder.unsaved')}</Badge>
      )}
      {!diff ? (
        <div className="text-caption text-text-tertiary">—</div>
      ) : diff.is_first_publish ? (
        <div className="text-caption text-text-tertiary">{t('aiFlows.review.firstPublish')}</div>
      ) : (
        <div className="space-y-1.5 text-caption">
          <DiffRow label={t('aiFlows.review.added')} items={diff.nodes_added} tone="success" />
          <DiffRow label={t('aiFlows.review.removed')} items={diff.nodes_removed} tone="danger" />
          <DiffRow label={t('aiFlows.review.changed')} items={diff.nodes_changed} tone="warning" />
          {Object.keys(diff.limit_changes ?? {}).length > 0 && (
            <div>
              <span className="text-tiny font-strong uppercase tracking-wide text-text-quaternary">
                {t('aiFlows.limits.title')}
              </span>
              <ul className="mt-0.5 space-y-0.5">
                {Object.entries(diff.limit_changes).map(([k, v]) => (
                  <li key={k} className="text-tiny text-text-secondary">
                    <code>{k}</code>: {String(v.from ?? '—')} → {String(v.to ?? '—')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiffRow({ label, items, tone }: {
  label: string; items: string[]; tone: 'success' | 'danger' | 'warning';
}) {
  if (!items?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-tiny font-strong uppercase tracking-wide text-text-quaternary">
        {label}
      </span>
      {items.map((i) => <Badge key={i} variant={tone} size="xs">{i}</Badge>)}
    </div>
  );
}
