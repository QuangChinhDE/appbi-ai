'use client';

import React from 'react';
import { ChevronDown } from 'lucide-react';

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
        title="Chèn biến động vào biểu thức"
        className="inline-flex h-9 shrink-0 items-center gap-0.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 text-tiny font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary"
      >
        + Biến
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
              className="block w-full px-2.5 py-1.5 text-left text-tiny hover:bg-surface-2"
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
  emptyMessage = 'No options available.',
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
  const selected = new Set(selectedValues);
  if (options.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2 text-tiny text-text-tertiary">
        {emptyMessage}
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
      <div className="flex h-9 shrink-0 overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1 text-tiny">
        {(['fixed', 'expression'] as const).map((nextMode) => (
          <button
            key={nextMode}
            type="button"
            onClick={() => setMode(nextMode)}
            title={
              nextMode === 'fixed'
                ? 'Giá trị cố định (gõ trực tiếp)'
                : 'Biểu thức động (chèn biến)'
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
