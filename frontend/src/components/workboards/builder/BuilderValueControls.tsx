'use client';

import React from 'react';

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

  React.useEffect(() => {
    if (!stringValue.trim()) return;
    if (guessValueMode(stringValue) === 'expression') {
      setMode('expression');
    }
  }, [stringValue]);

  const matchedExpression = expressionOptions.find((option) => option.value === stringValue);
  const expressionSelectValue = matchedExpression ? matchedExpression.value : '__custom__';

  const showCustomInput =
    mode === 'expression' &&
    (expressionOptions.length === 0 || expressionSelectValue === '__custom__');

  return (
    <div className="flex w-full items-stretch gap-1">
      {/* Tiny inline toggle — single character so it doesn't push the input down. */}
      <div className="flex shrink-0 overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1 text-tiny">
        {(['fixed', 'expression'] as const).map((nextMode) => (
          <button
            key={nextMode}
            type="button"
            onClick={() => setMode(nextMode)}
            title={nextMode === 'fixed' ? 'Giá trị cố định' : 'Biểu thức'}
            className={`px-2 font-medium transition-colors ${
              mode === nextMode
                ? 'bg-brand/10 text-brand'
                : 'text-text-tertiary hover:bg-surface-2 hover:text-text-primary'
            }`}
          >
            {nextMode === 'fixed' ? 'abc' : 'fx'}
          </button>
        ))}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {mode === 'fixed' ? (
          <input
            value={stringValue}
            onChange={(event) => onChange(event.target.value)}
            placeholder={fixedPlaceholder}
            className={CONTROL_INPUT}
          />
        ) : (
          <>
            {expressionOptions.length > 0 && (
              <select
                value={expressionSelectValue}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next !== '__custom__') onChange(next);
                }}
                className={CONTROL_INPUT}
              >
                {expressionOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
                <option value="__custom__">Tự nhập biểu thức…</option>
              </select>
            )}
            {showCustomInput ? (
              <input
                value={stringValue}
                onChange={(event) => onChange(event.target.value)}
                placeholder={expressionPlaceholder}
                className={CONTROL_INPUT}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
