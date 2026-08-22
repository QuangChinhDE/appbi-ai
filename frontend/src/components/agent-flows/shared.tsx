'use client';

/**
 * Small pieces shared by the Agent Flows list and builder.
 *
 * They live here rather than in `@/components/ui` because each one encodes
 * something about brains specifically — what a status means, what a tool's cost
 * class is called in Vietnamese, which sources a step may attach. A generic UI
 * folder is the wrong home for vocabulary only this module has.
 */
import { Check, ChevronDown, Search, X } from 'lucide-react';
import React from 'react';

import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import type {
  Attachable, AttachableItem, BrainStatus, KnowledgeAttachment, ToolSpec,
} from '@/lib/agentFlows';

/* ── status ───────────────────────────────────────────────────────────────── */

/** What a version's status means to somebody deciding whether to touch it.
 *
 *  `published` is the only one a viewer can reach, so it is the only one that gets
 *  a live-looking colour. A draft reading "success" green would say the opposite of
 *  what it is. */
export function StatusBadge({
  status, version, size = 'sm',
}: { status: BrainStatus; version?: number; size?: 'xs' | 'sm' }) {
  const { t } = useI18n();
  const suffix = version === undefined ? '' : ` v${version}`;
  if (status === 'published') {
    return <Badge variant="success" size={size} dot>{t('agentFlows.status.published', { suffix })}</Badge>;
  }
  if (status === 'archived') {
    return <Badge variant="neutral" size={size}>{t('agentFlows.status.archived', { suffix })}</Badge>;
  }
  return <Badge variant="warning" size={size}>{t('agentFlows.status.draft', { suffix })}</Badge>;
}

/* ── tool cost ────────────────────────────────────────────────────────────── */

const COST_LABEL_KEY: Record<ToolSpec['cost_class'], string> = {
  cheap: 'agentFlows.cost.cheap',
  data_query: 'agentFlows.cost.dataQuery',
  expensive: 'agentFlows.cost.expensive',
  external: 'agentFlows.cost.external',
};

const COST_TONE: Record<ToolSpec['cost_class'], string> = {
  cheap: 'bg-surface-2 text-text-quaternary border-[rgb(var(--border-line))]',
  data_query: 'bg-info/10 text-info border-info/20',
  expensive: 'bg-warning/10 text-warning border-warning/25',
  external: 'bg-danger/10 text-danger border-danger/25',
};

const COST_HINT_KEY: Record<ToolSpec['cost_class'], string> = {
  cheap: 'agentFlows.costHint.cheap',
  data_query: 'agentFlows.costHint.dataQuery',
  expensive: 'agentFlows.costHint.expensive',
  external: 'agentFlows.costHint.external',
};

/** The cost class, named and explained. The previous build printed "rẻ" / "ngoài" /
 *  "truy vấn" with nothing to hover — three words that look like a category system
 *  without saying what any of them costs. */
export function CostChip({ cost }: { cost: ToolSpec['cost_class'] }) {
  const { t } = useI18n();
  return (
    <span
      title={t(COST_HINT_KEY[cost])}
      className={cn(
        'inline-flex h-4 flex-shrink-0 cursor-help items-center rounded border px-1.5 text-tiny leading-none',
        COST_TONE[cost],
      )}
    >
      {t(COST_LABEL_KEY[cost])}
    </span>
  );
}

export const COST_LEGEND: { cost: ToolSpec['cost_class']; hint: string }[] =
  (Object.keys(COST_LABEL_KEY) as ToolSpec['cost_class'][]).map((cost) => ({ cost, hint: COST_HINT_KEY[cost] }));

/* ── small text bits ──────────────────────────────────────────────────────── */

/** A count badge for a tab label. Wrapped rather than interpolated: the raw number
 *  rendered flush against the label read as "Công cụ2". */
export function TabCount({ n, tone = 'neutral' }: { n: number; tone?: 'neutral' | 'warning' }) {
  return (
    <span
      className={cn(
        'ml-0.5 min-w-4 rounded px-1 text-tiny font-strong tabular-nums',
        tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-surface-3 text-text-secondary',
      )}
    >
      {n}
    </span>
  );
}

export function MetaChip({
  children, muted, tone,
}: { children: React.ReactNode; muted?: boolean; tone?: 'brand' | 'warning' }) {
  return (
    <span
      className={cn(
        'inline-flex h-4 items-center rounded border px-1.5 text-tiny leading-none tabular-nums',
        tone === 'brand' && 'border-brand/20 bg-brand/10 text-brand',
        tone === 'warning' && 'border-warning/25 bg-warning/10 text-warning',
        !tone && 'border-[rgb(var(--border-line))] bg-surface-2',
        !tone && (muted ? 'text-text-quaternary' : 'text-text-tertiary'),
      )}
    >
      {children}
    </span>
  );
}

/** A section header inside a panel. One line, uppercase, no card chrome — the same
 *  weight the Dataset panels use, so a brain panel does not read as a heavier
 *  screen than the one next door. */
export function SectionTitle({
  children, count, action,
}: { children: React.ReactNode; count?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h3 className="text-tiny font-strong uppercase tracking-[0.08em] text-text-tertiary">
        {children}
      </h3>
      {count !== undefined && (
        <span className="text-tiny font-strong tabular-nums text-text-quaternary">{count}</span>
      )}
      <div className="flex-1" />
      {action}
    </div>
  );
}

export function HintText({ children }: { children: React.ReactNode }) {
  return <p className="text-tiny leading-relaxed text-text-tertiary">{children}</p>;
}

/** A dated line, in the user's locale. Brains carry ISO strings; printing them raw
 *  is what the first build did on the version list. */
export function formatWhen(iso: string | null | undefined, locale = 'vi-VN'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale, {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/* ── searchable picker ────────────────────────────────────────────────────── */

/**
 * A one-of-many picker with a search box.
 *
 * A native `<select>` was the previous choice and it does not survive the real
 * data: this deployment returns 55 datasets, so choosing one meant scrolling an
 * unsearchable dropdown reading names that differ in their last four characters
 * ("… DA1-2026-06-03T17-12-09-813Z"). Options may carry a `group`, which sections
 * the list — that is how a metric's category earns its place.
 */
export function SearchPicker({
  value, options, onChange, placeholder, emptyText, disabled, invalid, className,
}: {
  value: string;
  options: AttachableItem[];
  onChange: (ref: string) => void;
  placeholder: string;
  emptyText: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const boxRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.ref === value);
  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      o.name.toLowerCase().includes(q) || o.ref.toLowerCase().includes(q));
  }, [options, query]);

  // Grouped only when the data actually groups. Sectioning a flat list would add a
  // heading row per item.
  const grouped = React.useMemo(() => {
    const map = new Map<string, AttachableItem[]>();
    shown.forEach((o) => {
      const key = o.group || '';
      const list = map.get(key);
      if (list) list.push(o); else map.set(key, [o]);
    });
    return [...map.entries()];
  }, [shown]);

  return (
    <div ref={boxRef} className={cn('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { setOpen((v) => !v); setQuery(''); }}
        className={cn(
          'flex h-8 w-full items-center gap-1.5 rounded-md border bg-surface-1 px-2.5 text-left text-caption',
          'transition-[border-color,box-shadow] duration-150',
          invalid
            ? 'border-danger/60'
            : 'border-[rgb(var(--border-strong))] hover:border-brand/60',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate', selected ? 'text-text-primary' : 'text-text-quaternary')}>
          {selected ? selected.name : placeholder}
        </span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-lg border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear">
          <div className="border-b border-[rgb(var(--border-line))] p-1.5">
            <Input
              autoFocus
              size="sm"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('agentFlows.picker.searchPlaceholder')}
              leadingIcon={<Search />}
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {options.length === 0 && (
              <p className="px-2.5 py-3 text-tiny leading-snug text-text-tertiary">{emptyText}</p>
            )}
            {options.length > 0 && shown.length === 0 && (
              <p className="px-2.5 py-3 text-tiny text-text-tertiary">{t('agentFlows.picker.empty')}</p>
            )}
            {grouped.map(([group, items]) => (
              <div key={group || '_'}>
                {group && (
                  <p className="px-2.5 pb-0.5 pt-1.5 text-tiny font-strong uppercase tracking-[0.08em] text-text-quaternary">
                    {group}
                  </p>
                )}
                {items.map((o) => (
                  <button
                    key={o.ref}
                    type="button"
                    onClick={() => { onChange(o.ref); setOpen(false); }}
                    className={cn(
                      'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption',
                      o.ref === value ? 'bg-brand/8 text-brand' : 'text-text-secondary hover:bg-surface-2',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                    {o.ref === value && <Check className="h-3.5 w-3.5 flex-shrink-0" />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── knowledge attachments ────────────────────────────────────────────────── */

/** WHAT A STEP MAY LOOK UP — the control that was missing entirely.
 *
 *  `SearchPicker` existed, `/attachable` existed and served documents, datasets
 *  and metrics under a permission model, and the contract carried
 *  `KnowledgeAttachment` on both Agent and Knowledge nodes. Nothing rendered any
 *  of it. So every Knowledge node in the product ran with an empty scope, which
 *  the retriever reads as "no narrowing" — the widest possible reach, chosen by
 *  nobody. An author could not attach a source even if they wanted to.
 *
 *  The row is deliberately quiet: kind, source, and when to use it, in the order
 *  a person decides them. `reads_data` is a badge and not a sentence, because the
 *  one thing worth saying here — this attachment reaches real numbers, that one is
 *  only wording — is a property of the item, and a property belongs on the item.
 *
 *  Add stays disabled until the row is valid. The server requires a description of
 *  at least ten characters, and a Save that fails on a rule the form never showed
 *  is the conflict this control exists to prevent. */
export function KnowledgeAttachments({
  value, options, onChange, disabled,
}: {
  value: KnowledgeAttachment[];
  options: Attachable | null;
  onChange: (next: KnowledgeAttachment[]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [kind, setKind] = React.useState<KnowledgeAttachment['source']>('document');
  const [ref, setRef] = React.useState('');
  const [why, setWhy] = React.useState('');

  const pool: AttachableItem[] = React.useMemo(() => {
    if (!options) return [];
    return kind === 'document' ? options.documents
      : kind === 'semantic' ? options.datasets
      : kind === 'metric' ? options.metrics
      : options.terms || [];
  }, [options, kind]);

  const label = React.useCallback((source: KnowledgeAttachment['source']) =>
    t(`agentFlows.knowledge.source.${source}`), [t]);

  const nameOf = React.useCallback((a: KnowledgeAttachment) => {
    if (!options) return a.ref;
    const all = [...options.documents, ...options.datasets, ...options.metrics,
                 ...(options.terms || [])];
    return all.find((o) => o.ref === a.ref)?.name || a.ref;
  }, [options]);

  const canAdd = !!ref && why.trim().length >= 10
    && !value.some((a) => a.source === kind && a.ref === ref);

  const add = () => {
    if (!canAdd) return;
    onChange([...value, { source: kind, ref, description: why.trim() }]);
    setRef('');
    setWhy('');
  };

  return (
    <div className="mt-3">
      <SectionTitle count={value.length || undefined}>
        {t('agentFlows.knowledge.title')}
      </SectionTitle>

      {value.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-md border border-[rgb(var(--border-line))]">
          {value.map((a, i) => (
            <div
              key={`${a.source}-${a.ref}`}
              className="flex items-start gap-2 border-t border-[rgb(var(--border-line))] p-2 first:border-t-0"
            >
              <Badge size="xs" variant="neutral">{label(a.source)}</Badge>
              <div className="min-w-0 flex-1">
                <div className="truncate text-caption font-medium">{nameOf(a)}</div>
                <Input
                  size="sm"
                  className="mt-1"
                  disabled={disabled}
                  value={a.description}
                  onChange={(e) => {
                    const next = [...value];
                    next[i] = { ...a, description: e.target.value };
                    onChange(next);
                  }}
                  placeholder={t('agentFlows.knowledge.whenPlaceholder')}
                  invalid={a.description.trim().length < 10}
                />
              </div>
              {!disabled && (
                <button
                  type="button"
                  aria-label={t('agentFlows.knowledge.remove')}
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                  className="rounded p-1 text-text-quaternary transition hover:bg-surface-2 hover:text-danger"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!disabled && (
        <div className="space-y-1.5 rounded-md border border-dashed border-[rgb(var(--border-line))] p-2">
          <div className="flex gap-1.5">
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as KnowledgeAttachment['source']);
                setRef('');
              }}
              className="h-8 flex-shrink-0 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption"
            >
              {(['document', 'metric', 'term', 'semantic'] as const).map((k) => (
                <option key={k} value={k}>{label(k)}</option>
              ))}
            </select>
            <SearchPicker
              className="min-w-0 flex-1"
              value={ref}
              options={pool}
              onChange={setRef}
              placeholder={t('agentFlows.knowledge.pick')}
              emptyText={t('agentFlows.knowledge.none')}
            />
          </div>
          <div className="flex gap-1.5">
            <Input
              size="sm"
              className="min-w-0 flex-1"
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
              placeholder={t('agentFlows.knowledge.whenPlaceholder')}
            />
            <button
              type="button"
              disabled={!canAdd}
              onClick={add}
              className={cn(
                'h-8 flex-shrink-0 rounded-md px-2.5 text-caption font-medium transition',
                canAdd
                  ? 'bg-brand text-white hover:opacity-90'
                  : 'cursor-not-allowed bg-surface-2 text-text-quaternary',
              )}
            >
              {t('agentFlows.knowledge.add')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── run status ───────────────────────────────────────────────────────────── */

/** A RUN's outcome, as distinct from a brain's lifecycle status above.
 *
 *  The tone table and label keys lived inside `RunsTab` and were about to be
 *  copied into the conversations and feedback views — three places deciding
 *  independently what colour `partial` is. One definition instead, here, because
 *  `partial` reading as danger in one view and warning in another would make a
 *  reader distrust both.
 *
 *  `partial` is WARNING, not danger, on purpose: a partial run answered the
 *  viewer. It just could not finish everything it set out to do. */
const RUN_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ok: 'success', partial: 'warning', blocked: 'danger', failed: 'danger',
  throttled: 'warning',
};

const RUN_LABEL_KEY: Record<string, string> = {
  ok: 'agentFlows.runs.status.ok',
  partial: 'agentFlows.runs.status.partial',
  blocked: 'agentFlows.runs.status.blocked',
  failed: 'agentFlows.runs.status.failed',
  throttled: 'agentFlows.runs.status.throttled',
};

export function RunStatusBadge({
  status, size = 'xs',
}: { status: string; size?: 'xs' | 'sm' }) {
  const { t } = useI18n();
  return (
    <Badge variant={RUN_TONE[status] || 'neutral'} size={size}>
      {RUN_LABEL_KEY[status] ? t(RUN_LABEL_KEY[status]) : status}
    </Badge>
  );
}

/* ── history surfaces ─────────────────────────────────────────────────────── */

/** One figure in a summary strip. Value then a quiet uppercase label.
 *
 *  Moved here from `RunsTab` when the Feedback tab needed the same strip. Two
 *  copies would have drifted in the one place drift is most visible: a row of
 *  numbers where the numbers do not line up. */
export function Stat({
  value, label, tone,
}: {
  value: React.ReactNode;
  label: string;
  /** Semantic emphasis for a figure that means good or bad. Left off for
   *  counts and durations, which are neither. */
  tone?: 'success' | 'danger';
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <strong className={cn(
        'text-body font-strong',
        tone === 'success' && 'text-success',
        tone === 'danger' && 'text-danger',
      )}>
        {value}
      </strong>
      <span className="text-tiny uppercase tracking-wide text-text-tertiary">{label}</span>
    </div>
  );
}

/** The strip itself, so every history tab frames its numbers identically. */
export function StatStrip({
  children, note,
}: { children: React.ReactNode; note?: string }) {
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5"
      title={note}
    >
      {children}
      {note && <span className="text-tiny text-text-quaternary">{note}</span>}
    </div>
  );
}

/** WHERE A TURN CAME FROM.
 *
 *  This replaced an "include test runs" checkbox that defaulted to OFF, which made
 *  the Runs tab empty in the one moment an author most needs it: straight after
 *  running a test. The checkbox was also the wrong control for the question — it
 *  offered "viewers" or "viewers and me", and never "just what I ran", which is the
 *  view you want while building.
 *
 *  Default is `all`: this tab lives inside the builder, and hiding the author's own
 *  work from the author is not a sensible default anywhere in it. */
export type RunSource = 'all' | 'viewer' | 'test';

export function SourceFilter({
  value, onChange,
}: { value: RunSource; onChange: (v: RunSource) => void }) {
  const { t } = useI18n();
  return (
    <div className="flex gap-1 rounded-lg bg-surface-2 p-1">
      {(['all', 'viewer', 'test'] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            'rounded-md px-2 py-1 text-caption transition',
            value === v ? 'bg-surface-1 font-medium shadow-linear-sm' : 'text-text-tertiary',
          )}
        >
          {t(`agentFlows.runs.source.${v}`)}
        </button>
      ))}
    </div>
  );
}
