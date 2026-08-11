'use client';

/**
 * Rendering a structured answer.
 *
 * The flow's last node can return TYPED BLOCKS instead of a paragraph, and this is
 * what turns them into a screen. Seven types, deliberately few: every new one is
 * frontend work, so one gets added when there is a screen that renders it — not in
 * advance.
 *
 * `chart_ref` is the one worth pointing at. The bot is answering ON the dashboard
 * the viewer is looking at, so the best answer is often not a re-drawn number — it
 * is "look at this chart, this segment". Clicking it scrolls to the chart and asks
 * the dashboard to highlight the part being discussed, which no amount of prose can
 * do.
 *
 * A flow that returns plain prose still arrives here as a single `text` block, so
 * there is one rendering path rather than two.
 */
import React from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, BarChart3, Info } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { AnswerBlock } from '@/lib/agentFlows';

export function AnswerBlocks({
  blocks, onOpenChart, onAskFollowup, renderMarkdown,
}: {
  blocks: AnswerBlock[];
  onOpenChart?: (chartId: number, highlight?: { field: string; values: unknown[] } | null) => void;
  onAskFollowup?: (question: string) => void;
  /** The host's own markdown renderer, so an answer looks identical whether it
   *  arrived as prose or as a text block. */
  renderMarkdown?: (md: string) => React.ReactNode;
}) {
  if (!blocks?.length) return null;
  return (
    <div className="space-y-2.5">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'text':
            return (
              <div key={i} className="text-caption leading-relaxed text-text-primary">
                {renderMarkdown ? renderMarkdown(block.markdown) : block.markdown}
              </div>
            );

          case 'metric':
            return <MetricTile key={i} block={block} onOpenChart={onOpenChart} />;

          case 'table':
            return <MiniTable key={i} block={block} />;

          case 'chart_ref':
            return (
              <button
                key={i}
                type="button"
                onClick={() => onOpenChart?.(block.chart_id, block.highlight)}
                disabled={!onOpenChart}
                className="flex w-full items-center gap-2 rounded-lg border border-brand/25 bg-brand/[0.04] px-2.5 py-2 text-left transition hover:bg-brand/[0.08] disabled:cursor-default"
              >
                <BarChart3 className="h-4 w-4 flex-shrink-0 text-brand" />
                <span className="min-w-0 flex-1">
                  <b className="block text-caption font-medium text-text-primary">
                    {block.caption || 'Xem biểu đồ liên quan'}
                  </b>
                  {block.highlight?.values?.length ? (
                    <span className="block text-tiny text-text-tertiary">
                      Tô sáng: {block.highlight.values.map(String).join(', ')}
                    </span>
                  ) : null}
                </span>
              </button>
            );

          case 'callout': {
            const tone = block.level === 'danger'
              ? 'border-danger/25 bg-danger/5 text-danger'
              : block.level === 'warning'
                ? 'border-warning/25 bg-warning/5 text-warning'
                : 'border-info/25 bg-info/5 text-info';
            const Icon = block.level === 'info' ? Info : AlertTriangle;
            return (
              <p key={i} className={cn('flex gap-1.5 rounded-lg border p-2 text-tiny leading-5', tone)}>
                <Icon className="mt-px h-3.5 w-3.5 flex-shrink-0" />
                {block.text}
              </p>
            );
          }

          case 'followups':
            return (
              <div key={i} className="flex flex-wrap gap-1.5 pt-0.5">
                {block.items.map((q, k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => onAskFollowup?.(q)}
                    disabled={!onAskFollowup}
                    className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-1 text-tiny text-text-secondary transition hover:border-brand/40 hover:text-brand disabled:cursor-default"
                  >
                    {q}
                  </button>
                ))}
              </div>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}

function MetricTile({
  block, onOpenChart,
}: {
  block: Extract<AnswerBlock, { type: 'metric' }>;
  onOpenChart?: (chartId: number, highlight?: { field: string; values: unknown[] } | null) => void;
}) {
  const chartId = block.source?.chart_id ?? null;
  const dir = block.delta?.direction;
  return (
    <div
      onClick={() => chartId && onOpenChart?.(chartId, null)}
      className={cn(
        'rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/50 px-3 py-2',
        chartId && onOpenChart && 'cursor-pointer hover:border-brand/40',
      )}
    >
      <span className="block text-tiny uppercase tracking-wide text-text-tertiary">
        {block.label}
      </span>
      <span className="mt-0.5 flex items-baseline gap-2">
        <b className="text-body font-strong tabular-nums">{formatValue(block.value, block.format)}</b>
        {block.delta && (
          <span
            className={cn(
              'flex items-center gap-0.5 text-tiny font-medium tabular-nums',
              dir === 'down' ? 'text-danger' : dir === 'up' ? 'text-success' : 'text-text-tertiary',
            )}
          >
            {dir === 'down' ? <ArrowDown className="h-3 w-3" />
              : dir === 'up' ? <ArrowUp className="h-3 w-3" /> : null}
            {formatValue(block.delta.value, block.delta.format)}
          </span>
        )}
      </span>
    </div>
  );
}

function MiniTable({ block }: { block: Extract<AnswerBlock, { type: 'table' }> }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border-line))]">
      <table className="w-full border-collapse text-tiny">
        <thead>
          <tr className="bg-surface-2 text-left text-text-quaternary">
            {block.columns.map((c) => (
              <th key={c.key} className="whitespace-nowrap px-2 py-1.5 font-medium">{c.label || c.key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.slice(0, 20).map((row, i) => (
            <tr key={i} className="border-t border-[rgb(var(--border-line))]">
              {block.columns.map((c) => (
                <td key={c.key} className="whitespace-nowrap px-2 py-1.5 tabular-nums text-text-secondary">
                  {formatValue(row[c.key], c.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Formatting lives here, not in the flow.
 *  A model asked to format its own currency produces a different answer each turn;
 *  the block carries a NUMBER and a format name, and the number is shown the same
 *  way every time. */
function formatValue(value: unknown, format?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  if (Number.isFinite(n)) {
    if (format === 'percent') {
      return `${(n * (Math.abs(n) <= 1 ? 100 : 1)).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`;
    }
    if (format === 'currency') {
      return n.toLocaleString('vi-VN', { maximumFractionDigits: 0 });
    }
    if (format === 'number') {
      return n.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
    }
  }
  return String(value);
}
