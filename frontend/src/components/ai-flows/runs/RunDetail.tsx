'use client';

/**
 * Run detail — the same canvas the author built on, replaying what happened.
 *
 * A step list tells you the order things ran. It does not tell you which BRANCH
 * was taken, or which arm of a route never fired. That is exactly what someone
 * debugging "why did it answer that" needs, and the canvas already draws it —
 * so the run is projected back onto the published graph rather than rendered as
 * a second, weaker view of the same data.
 *
 * If the flow version has since been deleted, we say so and fall back to the
 * list instead of showing an empty canvas that implies nothing ran.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { useI18n } from '@/providers/LanguageProvider';
import {
  type FlowDetail, type Palette, type Trace, getFlow, getTrace,
} from '@/lib/aiFlows';
import { FlowCanvas, type PreviewState } from '../canvas/FlowCanvas';
import { EmptyHint, NODE_ICONS, Panel, timeAgo } from '../shared';

type DetailTab = 'canvas' | 'steps' | 'evidence';

interface Props {
  runId: string;
  palette: Palette | null;
  onBack: () => void;
}

export function RunDetail({ runId, palette, onBack }: Props) {
  const { t } = useI18n();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [flow, setFlow] = useState<FlowDetail | null>(null);
  const [flowMissing, setFlowMissing] = useState(false);
  const [tab, setTab] = useState<DetailTab>('canvas');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getTrace(runId)
      .then((tr) => {
        if (!alive) return;
        setTrace(tr);
        return getFlow(tr.run.flow_key, tr.run.flow_version)
          .then((f) => { if (alive) setFlow(f); })
          .catch(() => { if (alive) { setFlowMissing(true); setTab('steps'); } });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [runId]);

  /**
   * Map the trace onto per-node execution state. Nodes with no trace row are
   * marked `skipped` rather than left blank — "this branch was not taken" is a
   * finding, not missing data.
   *
   * The engine stops AT an `end` node without doing any work there, so `end`
   * never gets a trace row. Left as-is that paints the terminal step "not
   * reached" on every successful run, which reads as a broken flow. So the end
   * the run actually landed on is derived from the last traced step's wiring —
   * and only that one, because a graph may have several ends and claiming all
   * of them were reached would be a different lie.
   */
  const previewStates = useMemo(() => {
    if (!trace || !flow) return {};
    const out: Record<string, PreviewState> = {};
    Object.keys(flow.graph.nodes).forEach((k) => { out[k] = { status: 'skipped' }; });
    trace.nodes.forEach((n) => {
      out[n.node_key] = {
        status: n.status === 'ok' ? 'completed' : 'failed',
        latencyMs: n.latency_ms ?? undefined,
      };
    });

    const last = trace.nodes[trace.nodes.length - 1];
    const lastNode = last ? flow.graph.nodes[last.node_key] : undefined;
    if (lastNode) {
      const target = lastNode.on_success || lastNode.on_failure
        ? (last.status === 'ok' ? lastNode.on_success : lastNode.on_failure)
        : lastNode.next;
      if (target && flow.graph.nodes[target]?.type === 'end') {
        out[target] = { status: trace.run.status === 'completed' ? 'completed' : 'failed' };
      }
    }
    return out;
  }, [trace, flow]);

  if (!trace) {
    return (
      <div className="px-8 py-10 text-caption text-text-tertiary">
        {t('aiFlows.common.loading')}
      </div>
    );
  }

  const run = trace.run;

  return (
    <div className="flex h-[calc(100vh-0px)] flex-col">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" /> {t('aiFlows.common.back')}
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-caption font-strong text-text-primary">
            {run.question || t('aiFlows.runs.detail')}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-tiny text-text-tertiary">
            <code>{run.flow_key} v{run.flow_version}</code>
            <span>·</span>
            <span>{timeAgo(run.started_at)}</span>
            {run.mode === 'preview' && (
              <Badge variant="subtle" size="xs">{t('aiFlows.runs.modePreview')}</Badge>
            )}
            {run.error_code && <Badge variant="danger" size="xs">{run.error_code}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="subtle" size="xs">
            {t('aiFlows.preview.aiCalls', { count: run.model_calls })}
          </Badge>
          <Badge variant="subtle" size="xs">
            {t('aiFlows.preview.toolCalls', { count: run.tool_calls })}
          </Badge>
          <Badge variant="subtle" size="xs">${run.usd.toFixed(4)}</Badge>
          {run.verification_coverage == null ? (
            <Badge variant="warning" size="xs">{t('aiFlows.preview.notVerified')}</Badge>
          ) : (
            <Badge
              variant={run.verification_coverage >= 0.999 ? 'success' : 'warning'}
              size="xs"
            >
              {t('aiFlows.preview.verified', {
                percent: Math.round(run.verification_coverage * 100),
              })}
            </Badge>
          )}
        </div>
      </header>

      <div className="flex-shrink-0 border-b border-[rgb(var(--border-line))] px-4 pt-2">
        <Tabs
          value={tab}
          onChange={(k) => setTab(k as DetailTab)}
          items={[
            { key: 'canvas', label: t('aiFlows.runs.tabCanvas') },
            { key: 'steps', label: t('aiFlows.runs.tabSteps') },
            { key: 'evidence', label: t('aiFlows.runs.tabEvidence') },
          ]}
        />
      </div>

      {flowMissing && (
        <div className="flex-shrink-0 bg-warning/[0.06] px-4 py-1.5 text-tiny text-text-secondary">
          {t('aiFlows.runs.flowGone')}
        </div>
      )}

      {tab === 'canvas' && (
        flow ? (
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1">
              <FlowCanvas
                graph={flow.graph}
                palette={palette}
                issues={[]}
                selected={selected}
                previewStates={previewStates}
                readOnly
                onSelect={setSelected}
                onChange={() => undefined}
                onDropNode={() => undefined}
              />
            </div>
            <aside className="w-72 flex-shrink-0 overflow-y-auto border-l border-[rgb(var(--border-line))] bg-surface-1 p-3">
              <p className="mb-2 text-tiny leading-relaxed text-text-tertiary">
                {t('aiFlows.runs.canvasHint')}
              </p>
              {selected ? (
                <NodeFacts
                  nodeKey={selected}
                  trace={trace}
                  isTerminal={
                    flow.graph.nodes[selected]?.type === 'end'
                    && previewStates[selected]?.status === 'completed'
                  }
                />
              ) : (
                <p className="text-tiny text-text-quaternary">{t('aiFlows.inspector.empty')}</p>
              )}
            </aside>
          </div>
        ) : (
          <div className="p-5">
            <EmptyHint>{t('aiFlows.common.loading')}</EmptyHint>
          </div>
        )
      )}

      {tab === 'steps' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <Panel title={t('aiFlows.runs.stepsRan')}>
            <ol className="space-y-1.5">
              {trace.nodes.map((n) => (
                <li key={n.seq} className="flex flex-wrap items-center gap-2 text-caption">
                  <span className="w-5 text-tiny text-text-quaternary">{n.seq}</span>
                  <span className="text-text-secondary">{NODE_ICONS[n.node_type]}</span>
                  <code className="font-emphasis text-text-primary">{n.node_key}</code>
                  <Badge variant="subtle" size="xs">{n.node_type}</Badge>
                  <Badge variant={n.status === 'ok' ? 'success' : 'danger'} size="xs">
                    {n.status}
                  </Badge>
                  {n.model && <span className="text-tiny text-text-tertiary">{n.model}</span>}
                  <span className="ml-auto text-tiny text-text-tertiary">{n.latency_ms}ms</span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      )}

      {tab === 'evidence' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <Panel title={t('aiFlows.runs.evidence')} sub={t('aiFlows.runs.evidenceHint')}>
            {trace.evidence.length === 0 ? (
              <EmptyHint>{t('aiFlows.runs.noEvidence')}</EmptyHint>
            ) : (
              <ul className="space-y-1.5">
                {trace.evidence.map((e) => (
                  <li key={e.id} className="rounded-lg border border-[rgb(var(--border-line))] p-2">
                    <div className="flex flex-wrap items-center gap-2 text-tiny">
                      <code className="font-emphasis text-text-primary">{e.tool_name}</code>
                      {!!(e.source_ref as { chart_id?: number })?.chart_id && (
                        <Badge variant="info" size="xs">
                          chart:{(e.source_ref as { chart_id?: number }).chart_id}
                        </Badge>
                      )}
                      {e.row_count != null && (
                        <span className="text-text-quaternary">{e.row_count} dòng</span>
                      )}
                      {e.truncated && <Badge variant="warning" size="xs">cắt bớt</Badge>}
                      {!e.ok && <Badge variant="danger" size="xs">lỗi</Badge>}
                    </div>
                    {e.numbers?.length > 0 && (
                      <div className="mt-1 break-words text-tiny text-text-tertiary">
                        {e.numbers.slice(0, 12).join(', ')}
                        {e.numbers.length > 12 && ` … (+${e.numbers.length - 12})`}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

function NodeFacts({ nodeKey, trace, isTerminal }: {
  nodeKey: string; trace: Trace; isTerminal?: boolean;
}) {
  const { t } = useI18n();
  const rows = trace.nodes.filter((n) => n.node_key === nodeKey);

  if (!rows.length && isTerminal) {
    // The engine does no work at `end`, so there is nothing to report beyond
    // "the run finished here" — saying "not reached" would be wrong.
    return (
      <div>
        <code className="text-caption font-emphasis text-text-primary">{nodeKey}</code>
        <p className="mt-1 text-tiny text-text-tertiary">{t('aiFlows.runs.endedHere')}</p>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div>
        <code className="text-caption font-emphasis text-text-primary">{nodeKey}</code>
        <p className="mt-1 text-tiny text-text-tertiary">{t('aiFlows.runs.notRun')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <code className="text-caption font-emphasis text-text-primary">{nodeKey}</code>
      {rows.map((n) => (
        <div key={n.seq} className="rounded-lg border border-[rgb(var(--border-line))] p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="subtle" size="xs">#{n.seq}</Badge>
            <Badge variant={n.status === 'ok' ? 'success' : 'danger'} size="xs">{n.status}</Badge>
            <span className="text-tiny text-text-tertiary">{n.latency_ms}ms</span>
          </div>
          {n.model && (
            <p className="mt-1 truncate text-tiny text-text-secondary">{n.model}</p>
          )}
          {!!n.error && (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-danger/[0.06] p-1.5 text-tiny text-danger">
              {typeof n.error === 'string' ? n.error : JSON.stringify(n.error, null, 2)}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
