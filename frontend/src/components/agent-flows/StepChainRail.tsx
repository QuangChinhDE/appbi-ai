'use client';

/**
 * The left rail: the brain's overview, then its chain of steps.
 *
 * `w-72`, same as the Dataset table tree, because it is the same kind of thing — a
 * navigator, not a work surface. It shows ORDER and STATE and nothing else: the
 * previous build tried to be a canvas, printing two lines of every step's prompt in
 * the middle of the screen, which used the widest column in the layout for text
 * nobody reads at that size.
 *
 * WHY THERE IS NO DRAG CANVAS
 * The runtime is linear: step one feeds step two, and the last step's text is the
 * answer. A drag surface with free node placement would imply branching that does
 * not exist, and the first thing an author would try is a fork. Reordering is
 * therefore up/down, which is the only rearrangement the runtime can honour.
 */
import {
  AlertTriangle, ArrowDown, ArrowUp, BookOpen, Copy, KeyRound, Link2, MessageSquare, Plus,
  Settings2, Trash2, Wrench,
} from 'lucide-react';
import React from 'react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { MAX_STEPS, type AgentStep, type StepProblem } from '@/lib/agentFlows';

import { MetaChip } from './shared';

export function StepChainRail({
  steps, selection, problemsByStep, warningCount, readCount, linkCount, canEdit,
  onSelectOverview, onSelectStep, onAdd, onDuplicate, onMove, onRemove,
}: {
  steps: AgentStep[];
  selection: { kind: 'overview' } | { kind: 'step'; index: number };
  problemsByStep: Map<number, StepProblem[]>;
  warningCount: number;
  readCount: number;
  linkCount: number;
  canEdit: boolean;
  onSelectOverview: () => void;
  onSelectStep: (index: number) => void;
  onAdd: (at: number) => void;
  onDuplicate: (index: number) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onRemove: (index: number) => void;
}) {
  const [confirmRemove, setConfirmRemove] = React.useState<number | null>(null);
  const atCap = steps.length >= MAX_STEPS;

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-[rgb(var(--border-line))] bg-surface-1">
      {/* ── brain-level destination ── */}
      <div className="shrink-0 border-b border-[rgb(var(--border-line))] p-2">
        <button
          type="button"
          onClick={onSelectOverview}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
            selection.kind === 'overview'
              ? 'bg-brand/10 text-brand'
              : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
          )}
        >
          <Settings2 className="h-4 w-4 flex-shrink-0" />
          <span className="min-w-0 flex-1 text-caption font-emphasis">Tổng quan bộ não</span>
          {warningCount > 0 && (
            <span className="flex items-center gap-0.5 text-tiny font-strong tabular-nums text-warning">
              <AlertTriangle className="h-3 w-3" />
              {warningCount}
            </span>
          )}
        </button>
        <div className="mt-1 flex flex-wrap gap-1 px-2">
          <MetaChip muted={readCount === 0}>
            <BookOpen className="mr-1 h-2.5 w-2.5" />
            {readCount === 0 ? 'không gắn tri thức' : `${readCount} nguồn`}
          </MetaChip>
          <MetaChip muted={linkCount === 0} tone={linkCount > 0 ? 'brand' : undefined}>
            <Link2 className="mr-1 h-2.5 w-2.5" />
            {linkCount === 0 ? 'chưa link nào dùng' : `${linkCount} link`}
          </MetaChip>
        </div>
      </div>

      {/* ── the chain ── */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="mb-1.5 flex items-center gap-2 px-1">
          <h3 className="text-tiny font-strong uppercase tracking-[0.08em] text-text-quaternary">
            Chuỗi bước
          </h3>
          <span className="text-tiny tabular-nums text-text-quaternary">{steps.length}/{MAX_STEPS}</span>
        </div>
        <p className="mb-2 px-1 text-tiny leading-snug text-text-tertiary">
          Câu hỏi đi từ trên xuống. Bước cuối là câu trả lời người xem đọc được.
        </p>

        {steps.map((step, index) => {
          const active = selection.kind === 'step' && selection.index === index;
          const problems = problemsByStep.get(index) || [];
          const tools = (step.tools || []).length;
          const knowledge = (step.knowledge || []).length;
          const isLast = index === steps.length - 1;
          return (
            <div key={`${step.key}-${index}`} className="group/step">
              <div
                className={cn(
                  'rounded-md border transition-colors',
                  active
                    ? 'border-brand bg-brand/5'
                    : 'border-transparent hover:border-[rgb(var(--border-line))] hover:bg-surface-2',
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectStep(index)}
                  className="w-full px-2 py-1.5 text-left"
                >
                  <span className="flex items-center gap-2">
                    <span className={cn(
                      'grid h-4.5 w-4.5 flex-shrink-0 place-items-center rounded text-tiny font-strong tabular-nums',
                      active ? 'bg-brand text-text-inverse' : 'bg-surface-3 text-text-secondary',
                    )}
                    >
                      {index + 1}
                    </span>
                    <span className={cn(
                      'min-w-0 flex-1 truncate text-caption font-emphasis',
                      active ? 'text-brand' : 'text-text-primary',
                    )}
                    >
                      {step.name || step.key}
                    </span>
                    {problems.length > 0 && (
                      <span className="flex-shrink-0 text-danger" title="Bước này còn chỗ cần sửa">
                        <AlertTriangle className="h-3 w-3" />
                      </span>
                    )}
                  </span>
                  {/* Indented to clear the number badge (18px) plus its gap (8px), so
                      the chips line up with the step name rather than the number. */}
                  <span className="mt-1 flex flex-wrap items-center gap-1 pl-[1.625rem]">
                    <MetaChip muted={tools === 0}>
                      <Wrench className="mr-1 h-2.5 w-2.5" />
                      {tools}
                    </MetaChip>
                    {knowledge > 0 && (
                      <MetaChip>
                        <BookOpen className="mr-1 h-2.5 w-2.5" />
                        {knowledge}
                      </MetaChip>
                    )}
                    {step.provider && step.provider !== 'inherit' && step.model && (
                      <MetaChip>{step.model}</MetaChip>
                    )}
                    {/* Which nodes carry their own token, visible without opening
                        each one — otherwise "why is this step billing elsewhere"
                        takes four clicks to answer. */}
                    {(step.has_api_key && !step.api_key_clear) && (
                      <MetaChip tone="brand">
                        <KeyRound className="mr-1 h-2.5 w-2.5" />
                        token
                      </MetaChip>
                    )}
                    {isLast && (
                      <Badge variant="success" size="xs">
                        <MessageSquare className="mr-0.5 h-2.5 w-2.5" />
                        trả lời
                      </Badge>
                    )}
                  </span>
                </button>

                {canEdit && (
                  // Revealed on hover/focus. Four always-visible icon buttons per row
                  // would out-weigh the step names they belong to.
                  <div className="flex items-center gap-0.5 border-t border-[rgb(var(--border-line))] px-1.5 py-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/step:opacity-100">
                    <IconButton
                      aria-label="Chuyển lên" variant="ghost" size="xs" title="Chuyển lên"
                      disabled={index === 0} onClick={() => onMove(index, -1)}
                    >
                      <ArrowUp className="h-3 w-3" />
                    </IconButton>
                    <IconButton
                      aria-label="Chuyển xuống" variant="ghost" size="xs" title="Chuyển xuống"
                      disabled={index === steps.length - 1} onClick={() => onMove(index, 1)}
                    >
                      <ArrowDown className="h-3 w-3" />
                    </IconButton>
                    <IconButton
                      aria-label="Nhân bản bước" variant="ghost" size="xs" title="Nhân bản bước"
                      disabled={atCap} onClick={() => onDuplicate(index)}
                    >
                      <Copy className="h-3 w-3" />
                    </IconButton>
                    <div className="flex-1" />
                    <IconButton
                      aria-label="Thêm bước ngay dưới" variant="ghost" size="xs" title="Thêm bước ngay dưới"
                      disabled={atCap} onClick={() => onAdd(index + 1)}
                    >
                      <Plus className="h-3 w-3" />
                    </IconButton>
                    <IconButton
                      aria-label="Xoá bước" variant="ghost" size="xs" title="Xoá bước"
                      className="hover:text-danger"
                      disabled={steps.length <= 1} onClick={() => setConfirmRemove(index)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </IconButton>
                  </div>
                )}
              </div>

              {index < steps.length - 1 && (
                <span className="ml-4 block h-2 w-px bg-[rgb(var(--border-strong))]" aria-hidden />
              )}
            </div>
          );
        })}

        {canEdit && (
          <button
            type="button"
            disabled={atCap}
            onClick={() => onAdd(steps.length)}
            title={atCap ? `Tối đa ${MAX_STEPS} bước` : undefined}
            className={cn(
              'mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1.5 text-tiny font-emphasis transition-colors',
              atCap
                ? 'cursor-not-allowed border-[rgb(var(--border-line))] text-text-quaternary'
                : 'border-[rgb(var(--border-line))] text-text-secondary hover:border-brand hover:text-brand',
            )}
          >
            <Plus className="h-3 w-3" />
            Thêm bước
          </button>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmRemove !== null}
        title="Xoá bước này?"
        description={
          confirmRemove !== null
            ? `“${steps[confirmRemove]?.name || steps[confirmRemove]?.key}” sẽ bị bỏ khỏi chuỗi. Thay đổi chỉ có hiệu lực sau khi bạn lưu.`
            : ''
        }
        confirmLabel="Xoá bước"
        variant="danger"
        onConfirm={() => { if (confirmRemove !== null) onRemove(confirmRemove); }}
        onClose={() => setConfirmRemove(null)}
      />
    </aside>
  );
}
