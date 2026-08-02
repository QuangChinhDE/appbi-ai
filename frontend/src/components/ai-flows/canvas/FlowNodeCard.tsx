'use client';

/**
 * One node on the canvas.
 *
 * A node has to answer four questions at a glance, without being opened:
 * what step is this, does it cost money, is it configured, and did it just run.
 * Anything less and the canvas becomes decoration — the failure mode the spec
 * calls out as anti-pattern #4.
 *
 * Ports are real React Flow handles: input left, output right, plus named
 * outputs for branching steps so an edge can carry its own label.
 */
import React, { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Ban, Lock, MoreVertical } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { LOCKED_TYPES, PREVIEW_RING, themeFor, type PreviewStatus } from './nodeTheme';

export interface FlowNodeData extends Record<string, unknown> {
  nodeKey: string;
  type: string;
  label: string;
  typeLabel: string;
  summary: string[];
  /** Named outputs beyond the default one, e.g. route intents / success+failure. */
  outputs: { id: string; label: string }[];
  errorCount: number;
  warningCount: number;
  firstIssue?: string;
  disabled?: boolean;
  isEntry?: boolean;
  previewStatus?: PreviewStatus;
  previewLatencyMs?: number;
  previewUsd?: number;
  readOnly?: boolean;
  onMenu?: (nodeKey: string, el: HTMLElement) => void;
}

function FlowNodeCardInner({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const theme = themeFor(d.type);
  const Icon = theme.icon;
  const locked = LOCKED_TYPES.has(d.type);
  const hasError = d.errorCount > 0;
  const ring = d.previewStatus ? PREVIEW_RING[d.previewStatus] : '';

  return (
    <div
      className={[
        'w-[248px] rounded-xl border-2 bg-white shadow-sm transition-shadow',
        hasError ? 'border-[#D92D20]' : theme.border,
        selected ? 'shadow-lg ring-2 ring-[#2459C4] ring-offset-1' : '',
        d.disabled ? 'opacity-55' : '',
        ring,
      ].join(' ')}
      aria-label={`${d.typeLabel}: ${d.label}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#667085]"
        aria-label="input"
      />

      {/* Header */}
      <div className={`flex items-center gap-2 rounded-t-[10px] px-2.5 py-2 ${theme.headerBg}`}>
        <span className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md ${theme.iconBg} ${theme.iconFg}`}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-tight text-[#101828]">
            {d.label}
          </span>
          <span className="block truncate text-[11px] leading-tight text-[#667085]">
            {d.typeLabel}
          </span>
        </span>
        {locked && <Lock className="h-3 w-3 flex-shrink-0 text-[#667085]" aria-label="locked" />}
        {!d.readOnly && !locked && (
          <button
            type="button"
            className="nodrag flex-shrink-0 rounded p-0.5 text-[#667085] hover:bg-white/70"
            aria-label="menu"
            onClick={(e) => {
              e.stopPropagation();
              d.onMenu?.(d.nodeKey, e.currentTarget);
            }}
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="space-y-1.5 px-2.5 py-2">
        {d.summary.length > 0 ? (
          d.summary.slice(0, 3).map((line, i) => (
            <p key={i} className="truncate text-[11px] leading-tight text-[#344054]">{line}</p>
          ))
        ) : (
          <p className="text-[11px] italic leading-tight text-[#98A2B3]">Chưa cấu hình</p>
        )}

        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          {theme.usesLlm && (
            <Badge variant="warning" size="xs">AI</Badge>
          )}
          {!theme.usesLlm && d.type !== 'end' && (
            <Badge variant="success" size="xs">0 AI</Badge>
          )}
          {d.isEntry && <Badge variant="brand" size="xs">bắt đầu</Badge>}
          {d.disabled && (
            <Badge variant="subtle" size="xs">
              <Ban className="h-2.5 w-2.5" /> bỏ qua
            </Badge>
          )}
          {d.previewLatencyMs != null && (
            <Badge variant="subtle" size="xs">{(d.previewLatencyMs / 1000).toFixed(1)}s</Badge>
          )}
          {d.previewUsd != null && d.previewUsd > 0 && (
            <Badge variant="subtle" size="xs">${d.previewUsd.toFixed(4)}</Badge>
          )}
        </div>

        {/* One inline problem, not a wall of them — the drawer has the full list. */}
        {d.firstIssue && (
          <p
            className={`flex items-start gap-1 text-[11px] leading-tight ${
              hasError ? 'text-[#B42318]' : 'text-[#B45309]'
            }`}
          >
            <AlertTriangle className="mt-px h-3 w-3 flex-shrink-0" />
            <span className="line-clamp-2">{d.firstIssue}</span>
          </p>
        )}
      </div>

      {/* Outputs: one default handle, or a labelled row per named branch. */}
      {d.type !== 'end' && (
        d.outputs.length === 0 ? (
          <Handle
            type="source"
            position={Position.Right}
            className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#2459C4]"
            aria-label="output"
          />
        ) : (
          <div className="border-t border-[#EAECF0] px-2.5 py-1">
            {d.outputs.map((o, i) => (
              <div key={o.id} className="relative flex items-center justify-end py-0.5">
                <span className="pr-3 text-[10px] font-medium uppercase tracking-wide text-[#667085]">
                  {o.label}
                </span>
                <Handle
                  id={o.id}
                  type="source"
                  position={Position.Right}
                  style={{ top: 'auto', bottom: 'auto', transform: 'none' }}
                  className="!relative !right-0 !h-2.5 !w-2.5 !border-2 !border-white !bg-[#E77713]"
                  aria-label={`output ${o.label}`}
                />
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

export const FlowNodeCard = memo(FlowNodeCardInner);
