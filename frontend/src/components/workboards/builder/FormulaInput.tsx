/**
 * FormulaInput — single-line formula editor with live preview + autocomplete.
 *
 * Used by GridScreenEditor's "Computed columns" inspector. Renders an
 * input that suggests both the project's column names and the formula
 * engine's built-in functions; validates on every keystroke via the
 * same TS parser the runtime uses, so the builder sees errors instantly.
 */
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

import { INPUT } from './ScreenEditor';
import {
  CompiledFormula,
  FormulaError,
  compileFormula,
  functionNames,
} from '@/lib/wb-formula';

interface Props {
  value: string;
  onChange: (next: string) => void;
  availableColumns: string[];
  previewRow?: Record<string, unknown>;
  placeholder?: string;
}

const FUNCTION_LIST = functionNames();

export default function FormulaInput({
  value,
  onChange,
  availableColumns,
  previewRow,
  placeholder,
}: Props) {
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const inputRef = useRef<HTMLInputElement>(null);

  // Validate + parse on every change so the user gets instant feedback.
  const { error, compiled } = useMemo<{
    error: string | null;
    compiled: CompiledFormula | null;
  }>(() => {
    if (!value.trim()) return { error: null, compiled: null };
    try {
      const c = compileFormula(value, { allowedColumns: availableColumns });
      return { error: null, compiled: c };
    } catch (err) {
      return {
        error: err instanceof FormulaError ? err.message : String(err),
        compiled: null,
      };
    }
  }, [value, availableColumns]);

  // Preview output against a sample row (typically the first grid row).
  const preview = useMemo(() => {
    if (!compiled || !previewRow) return null;
    try {
      const out = compiled.evaluate(previewRow);
      if (out === null || out === undefined) return '(empty)';
      if (typeof out === 'object') return JSON.stringify(out);
      return String(out);
    } catch (err) {
      return err instanceof FormulaError ? `Error: ${err.message}` : `Error: ${String(err)}`;
    }
  }, [compiled, previewRow]);

  // Word-under-caret detection drives the autocomplete dropdown.
  const currentToken = useMemo(() => {
    const upTo = value.slice(0, caret);
    const match = upTo.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    return match ? match[1] : '';
  }, [value, caret]);

  const suggestions = useMemo(() => {
    if (!focused || currentToken.length < 1) return [] as Array<{ label: string; kind: 'col' | 'fn' }>;
    const lower = currentToken.toLowerCase();
    const cols = availableColumns
      .filter((c) => c.toLowerCase().startsWith(lower))
      .slice(0, 6)
      .map((c) => ({ label: c, kind: 'col' as const }));
    const fns = FUNCTION_LIST.filter((fn) => fn.toLowerCase().startsWith(lower))
      .slice(0, 6)
      .map((fn) => ({ label: fn, kind: 'fn' as const }));
    return [...cols, ...fns];
  }, [focused, currentToken, availableColumns]);

  const acceptSuggestion = (label: string, kind: 'col' | 'fn') => {
    if (!inputRef.current) return;
    const before = value.slice(0, caret - currentToken.length);
    const after = value.slice(caret);
    const insert = kind === 'fn' ? `${label}(` : label;
    const next = before + insert + after;
    onChange(next);
    // Refocus + put caret right after the insertion.
    queueMicrotask(() => {
      const input = inputRef.current;
      if (!input) return;
      const newCaret = (before + insert).length;
      input.focus();
      input.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  };

  // Track caret as user moves around.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onSelect = () => setCaret(input.selectionStart ?? value.length);
    input.addEventListener('keyup', onSelect);
    input.addEventListener('click', onSelect);
    return () => {
      input.removeEventListener('keyup', onSelect);
      input.removeEventListener('click', onSelect);
    };
  }, [value]);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          // Defer so a click on a suggestion still fires before blur kills it.
          setTimeout(() => setFocused(false), 120);
        }}
        placeholder={placeholder || 'e.g. price * qty'}
        className={`${INPUT} font-mono`}
        spellCheck={false}
        autoComplete="off"
      />
      {suggestions.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-[rgb(var(--border-line))] bg-surface-1 shadow-popover">
          {suggestions.map((s, idx) => (
            <button
              key={`${s.kind}:${s.label}:${idx}`}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                acceptSuggestion(s.label, s.kind);
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-caption hover:bg-surface-2"
            >
              <span className="truncate font-mono text-text-primary">{s.label}</span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-micro ${
                  s.kind === 'fn'
                    ? 'bg-brand/10 text-brand'
                    : 'bg-surface-2 text-text-tertiary'
                }`}
              >
                {s.kind === 'fn' ? 'fn' : 'col'}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-1.5 space-y-0.5 text-caption">
        {error ? (
          <p className="text-danger">⚠ {error}</p>
        ) : preview !== null ? (
          <p className="text-text-tertiary">
            <span className="font-emphasis text-text-secondary">Preview:</span>{' '}
            <span className="font-mono">{preview}</span>
          </p>
        ) : (
          <p className="text-text-quaternary">
            Type column names or functions (autocomplete on focus).
          </p>
        )}
      </div>
    </div>
  );
}
