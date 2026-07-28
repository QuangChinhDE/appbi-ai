'use client';

import React from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';

import { useI18n } from '@/providers/LanguageProvider';
import { BUILDER_INPUT } from './BuilderChrome';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

const CONTROL_INPUT = BUILDER_INPUT;

type ValueMode = 'fixed' | 'expression';

function guessValueMode(value: unknown): ValueMode {
  if (typeof value !== 'string') return 'fixed';
  const text = value.trim();
  if (!text) return 'fixed';
  if (text.startsWith('{{') && text.endsWith('}}')) return 'expression';
  if (/\[[^\]]+\]/.test(text)) return 'expression';
  if (/\b(IF|AND|OR|NOT|CONCAT|UPPER|LOWER|TODAY|NOW)\s*\(/i.test(text)) {
    return 'expression';
  }
  return 'fixed';
}

function VariableInsertButton({
  options,
  onInsert,
}: {
  options: SelectOption[];
  onInsert: (snippet: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const { t } = useI18n();

  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (options.length === 0) return null;

  return (
    <div ref={wrapRef} className="relative flex shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('workboards.builder.value.insertVariableTitle')}
        className="inline-flex h-9 shrink-0 items-center gap-0.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 text-caption font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary"
      >
        {t('workboards.builder.value.insertVariable')}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-64 max-h-72 overflow-y-auto rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 py-1 shadow-linear-md">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onInsert(option.value);
                setOpen(false);
              }}
              className="block w-full px-2.5 py-1.5 text-left text-caption hover:bg-surface-2"
            >
              <span className="block text-text-primary">{option.label}</span>
              <span className="block truncate font-mono text-[11px] text-text-tertiary">
                {option.value}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CheckboxMultiSelect({
  options,
  selectedValues,
  onChange,
  columns = 3,
  emptyMessage,
  compact = false,
}: {
  options: SelectOption[];
  selectedValues: string[];
  onChange: (next: string[]) => void;
  columns?: 2 | 3 | 4;
  emptyMessage?: string;
  /** Compact = 1-line rows, no description, no min-height. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const selected = new Set(selectedValues);
  if (options.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2 text-caption text-text-tertiary">
        {emptyMessage ?? t('workboards.builder.value.noOptionsAvailable')}
      </div>
    );
  }

  // Auto-detect: when no row carries a description, drop to compact rows so
  // a list of 8 plain column names doesn't render as 8 large 52px tiles.
  const effectiveCompact = compact || options.every((option) => !option.description);

  return (
    <div
      className="grid gap-x-3 gap-y-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <label
          key={option.value}
          className={
            effectiveCompact
              ? 'flex items-center gap-2 rounded px-1.5 py-1 text-caption text-text-secondary hover:bg-surface-2'
              : 'flex items-start gap-2 rounded px-1.5 py-1.5 text-caption text-text-secondary hover:bg-surface-2'
          }
        >
          <input
            type="checkbox"
            checked={selected.has(option.value)}
            onChange={(event) => {
              const next = new Set(selectedValues);
              if (event.target.checked) next.add(option.value);
              else next.delete(option.value);
              onChange(Array.from(next));
            }}
            className="h-3.5 w-3.5 shrink-0"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-text-primary">{option.label}</span>
            {!effectiveCompact && option.description ? (
              <span className="block truncate text-[11px] text-text-tertiary">
                {option.description}
              </span>
            ) : null}
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * Searchable multi-select for picking column-like values. Renders as a
 * wrapping chip input that opens a popover with a search box — much
 * friendlier than a grid of checkboxes when the source list is wide
 * (50+ columns is common in real datasets).
 *
 * Use this for any "pick N items from a list of names" picker; for
 * short lists of tagged options with descriptions (e.g. user roles),
 * CheckboxMultiSelect still reads better.
 */
export function MultiColumnPicker({
  sourceColumns,
  value,
  onChange,
  placeholder,
  emptyHint,
}: {
  sourceColumns: string[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Optional override for the empty-popover message. */
  emptyHint?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const selected = new Set(value);
  const queryNorm = query.trim().toLowerCase();
  const candidates = sourceColumns.filter((c) => !selected.has(c));
  const filtered = queryNorm
    ? candidates.filter((c) => c.toLowerCase().includes(queryNorm))
    : candidates;

  const toggle = (name: string) => {
    if (selected.has(name)) onChange(value.filter((c) => c !== name));
    else onChange([...value, name]);
  };

  const remove = (name: string) => onChange(value.filter((c) => c !== name));

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-h-9 flex-wrap items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1.5 text-left text-caption text-text-secondary hover:border-brand/30"
      >
        {value.length === 0 && (
          <span className="text-text-tertiary">
            {placeholder ?? t('workboards.builder.value.addColumnsPlaceholder')}
          </span>
        )}
        {value.map((name) => (
          <span
            key={name}
            className="inline-flex items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-caption text-brand"
          >
            {name}
            <span
              role="button"
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                remove(name);
              }}
              className="flex cursor-pointer items-center justify-center rounded hover:bg-brand/20"
              title={t('workboards.builder.value.remove')}
            >
              <X className="h-3 w-3" />
            </span>
          </span>
        ))}
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 text-text-tertiary transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-md">
          <div className="sticky top-0 border-b border-[rgb(var(--border-line))] bg-surface-1 p-2">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('workboards.builder.value.searchOptions', { count: candidates.length })}
              className="h-7 w-full rounded border border-[rgb(var(--border-line))] bg-surface-0 px-2 text-caption"
            />
          </div>
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-caption text-text-tertiary">
              {emptyHint ??
                (candidates.length === 0
                  ? t('workboards.builder.value.allOptionsSelected')
                  : t('workboards.builder.value.noMatch'))}
            </p>
          ) : (
            <div className="p-1">
              {filtered.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggle(name)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-caption text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                >
                  <Plus className="h-3 w-3 text-text-tertiary" />
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Single-value sibling of MultiColumnPicker. Renders as a chip showing
 * the current value (or a placeholder when empty), with the same
 * popover search as the multi-select picker so the builder UI looks
 * consistent across all "pick from a list" controls.
 *
 * Use this when the field holds at most one value (e.g. "after submit
 * go to", "sort column", "value column"). For free-form text or numeric
 * inputs, stick with a native input — chips imply enumeration.
 */
export function SingleColumnPicker({
  sourceColumns,
  value,
  onChange,
  placeholder,
  emptyHint,
  clearable = true,
  /** Optional pretty labels: by `value` → display string. */
  labelByValue,
}: {
  sourceColumns: string[];
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  placeholder?: string;
  emptyHint?: string;
  /** When false, omits the clear button (use for required pickers). */
  clearable?: boolean;
  labelByValue?: Record<string, string>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const queryNorm = query.trim().toLowerCase();
  const filtered = queryNorm
    ? sourceColumns.filter((c) => c.toLowerCase().includes(queryNorm)
        || (labelByValue?.[c] || '').toLowerCase().includes(queryNorm))
    : sourceColumns;

  const display = value ? (labelByValue?.[value] ?? value) : null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-h-9 items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1.5 text-left text-caption text-text-secondary hover:border-brand/30"
      >
        {value && display ? (
          <span className="inline-flex max-w-full items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-caption text-brand">
            <span className="truncate">{display}</span>
            {clearable && (
              <span
                role="button"
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  onChange(null);
                }}
                className="flex cursor-pointer items-center justify-center rounded hover:bg-brand/20"
                title={t('workboards.builder.value.clear')}
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </span>
        ) : (
          <span className="text-text-tertiary">
            {placeholder ?? t('workboards.builder.value.pickPlaceholder')}
          </span>
        )}
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 text-text-tertiary transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-md">
          <div className="sticky top-0 border-b border-[rgb(var(--border-line))] bg-surface-1 p-2">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('workboards.builder.value.searchOptions', { count: sourceColumns.length })}
              className="h-7 w-full rounded border border-[rgb(var(--border-line))] bg-surface-0 px-2 text-caption"
            />
          </div>
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-caption text-text-tertiary">
              {emptyHint ??
                (sourceColumns.length === 0
                  ? t('workboards.builder.value.noOptions')
                  : t('workboards.builder.value.noMatch'))}
            </p>
          ) : (
            <div className="p-1">
              {filtered.map((name) => {
                const isActive = name === value;
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      onChange(name);
                      setOpen(false);
                      setQuery('');
                    }}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-caption hover:bg-surface-2 ${
                      isActive ? 'bg-brand/10 text-brand' : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {labelByValue?.[name] ?? name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FixedExpressionInput({
  value,
  onChange,
  fixedPlaceholder,
  expressionPlaceholder,
  expressionOptions = [],
}: {
  value: unknown;
  onChange: (next: string) => void;
  fixedPlaceholder?: string;
  expressionPlaceholder?: string;
  expressionOptions?: SelectOption[];
}) {
  const { t } = useI18n();
  const stringValue = value == null ? '' : String(value);
  const [mode, setMode] = React.useState<ValueMode>(() => guessValueMode(value));
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!stringValue.trim()) return;
    if (guessValueMode(stringValue) === 'expression') {
      setMode('expression');
    }
  }, [stringValue]);

  const insertVariable = (snippet: string) => {
    const el = inputRef.current;
    if (!el) {
      // No input mounted yet — replace the value entirely.
      onChange(snippet);
      return;
    }
    const start = el.selectionStart ?? stringValue.length;
    const end = el.selectionEnd ?? stringValue.length;
    const next = stringValue.slice(0, start) + snippet + stringValue.slice(end);
    onChange(next);
    // Restore caret right after the inserted snippet on the next tick.
    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      const caret = start + snippet.length;
      node.focus();
      node.setSelectionRange(caret, caret);
    });
  };

  return (
    // All controls share h-9 so the row aligns with neighbouring inputs in
    // grids like wb-row-key-value (no helper text below — that pushed the
    // row taller than its siblings and made columns visually misaligned).
    <div className="flex w-full items-center gap-1">
      <div className="flex h-9 shrink-0 overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1 text-caption">
        {(['fixed', 'expression'] as const).map((nextMode) => (
          <button
            key={nextMode}
            type="button"
            onClick={() => setMode(nextMode)}
            title={
              nextMode === 'fixed'
                ? t('workboards.builder.value.fixedValueTitle')
                : t('workboards.builder.value.expressionValueTitle')
            }
            className={`inline-flex h-full items-center px-2 font-medium transition-colors ${
              mode === nextMode
                ? 'bg-brand/10 text-brand'
                : 'text-text-tertiary hover:bg-surface-2 hover:text-text-primary'
            }`}
          >
            {nextMode === 'fixed' ? 'abc' : 'fx'}
          </button>
        ))}
      </div>

      <input
        ref={inputRef}
        value={stringValue}
        onChange={(event) => onChange(event.target.value)}
        placeholder={mode === 'fixed' ? fixedPlaceholder : expressionPlaceholder}
        className={`${CONTROL_INPUT} min-w-0 flex-1 ${
          mode === 'expression' ? 'font-mono' : ''
        }`}
      />

      {mode === 'expression' && (
        <VariableInsertButton options={expressionOptions} onInsert={insertVariable} />
      )}
    </div>
  );
}
