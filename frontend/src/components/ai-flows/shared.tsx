'use client';

/**
 * Shared bits for the Flow Studio. Kept small and on the existing design system
 * so the Studio looks like the rest of AppBI rather than a bolted-on tool.
 */
import React from 'react';
import {
  Bot, CheckCircle2, CircleSlash, Compass, Cpu, Flag, GitBranch,
  Shield, Wrench, XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';

/** Can the user edit drafts? Publishing needs `full` — see useCanPublish. */
export function useCanEdit(): boolean {
  const { data } = usePermissions();
  return hasPermission(data?.permissions, 'ai_flows', 'edit');
}

/**
 * Publishing changes what the AI says on a LIVE published report — the same
 * blast radius as a deploy — so it is gated one level above ordinary editing.
 */
export function useCanPublish(): boolean {
  const { data } = usePermissions();
  return hasPermission(data?.permissions, 'ai_flows', 'full');
}

export const NODE_ICONS: Record<string, React.ReactNode> = {
  guard: <Shield className="h-3.5 w-3.5" />,
  route: <GitBranch className="h-3.5 w-3.5" />,
  agent: <Bot className="h-3.5 w-3.5" />,
  legacy: <Cpu className="h-3.5 w-3.5" />,
  tool: <Wrench className="h-3.5 w-3.5" />,
  function: <CheckCircle2 className="h-3.5 w-3.5" />,
  condition: <Compass className="h-3.5 w-3.5" />,
  end: <Flag className="h-3.5 w-3.5" />,
};

/** LLM nodes are tinted — cost is the thing an author most needs to see. */
export const NODE_TONE: Record<string, string> = {
  guard: 'border-success/35 bg-success-soft/[0.07]',
  route: 'border-success/35 bg-success-soft/[0.07]',
  function: 'border-success/35 bg-success-soft/[0.07]',
  condition: 'border-success/35 bg-success-soft/[0.07]',
  agent: 'border-warning/45 bg-warning/[0.07]',
  legacy: 'border-warning/45 bg-warning/[0.07]',
  tool: 'border-info/35 bg-info/[0.07]',
  end: 'border-[rgb(var(--border-strong))] bg-surface-2',
};

export function StatusBadge({ status }: { status: string }) {
  if (status === 'published') return <Badge variant="success">Đang chạy</Badge>;
  if (status === 'archived') return <Badge variant="subtle">Đã lưu trữ</Badge>;
  return <Badge variant="warning">Bản nháp</Badge>;
}

export function Panel({ title, sub, action, children, className }: {
  title?: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 ${className ?? ''}`}>
      {(title || action) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            {title && <h3 className="text-caption font-strong text-text-primary">{title}</h3>}
            {sub && <p className="mt-0.5 text-tiny text-text-tertiary">{sub}</p>}
          </div>
          {action && <div className="flex-shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-0 px-4 py-8 text-center text-caption text-text-tertiary">
      {children}
    </div>
  );
}

/** Validation banner — the Studio's main teaching surface. */
export function ValidationList({ errors }: { errors: { code: string; message: string; node_key: string | null }[] }) {
  if (!errors.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-soft/[0.07] px-3 py-2 text-caption text-success">
        <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
        Luồng hợp lệ — có thể publish.
      </div>
    );
  }
  return (
    <div className="space-y-1.5 rounded-lg border border-danger/30 bg-danger/[0.05] p-3">
      <div className="flex items-center gap-2 text-caption font-emphasis text-danger">
        <XCircle className="h-4 w-4" /> {errors.length} lỗi cần sửa trước khi publish
      </div>
      <ul className="space-y-1">
        {errors.map((e, i) => (
          <li key={`${e.code}-${i}`} className="flex items-start gap-2 text-tiny text-text-secondary">
            <CircleSlash className="mt-0.5 h-3 w-3 flex-shrink-0 text-danger" />
            <span>
              {e.node_key && (
                <code className="mr-1 rounded bg-surface-2 px-1 text-text-primary">{e.node_key}</code>
              )}
              {e.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function costBadge(costClass: string): React.ReactNode {
  if (costClass === 'external') return <Badge variant="warning" size="xs">web</Badge>;
  if (costClass === 'data_query') return <Badge variant="info" size="xs">truy vấn</Badge>;
  if (costClass === 'expensive') return <Badge variant="danger" size="xs">nặng</Badge>;
  return <Badge variant="subtle" size="xs">rẻ</Badge>;
}

/**
 * Pull the message out of whatever the API threw.
 *
 * FastAPI puts the useful sentence in `detail`; axios buries it two levels
 * down. Showing "Request failed with status code 400" instead is how an author
 * ends up with no idea which field they got wrong.
 */
export function errText(e: unknown): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    // Pydantic validation errors arrive as a list of {loc, msg}.
    const first = detail[0] as { loc?: unknown[]; msg?: string } | undefined;
    if (first?.msg) return `${(first.loc ?? []).slice(1).join('.')}: ${first.msg}`;
  }
  return (e as Error)?.message || 'Có lỗi xảy ra';
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} giờ trước`;
  return `${Math.round(hours / 24)} ngày trước`;
}
