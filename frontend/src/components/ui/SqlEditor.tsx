'use client';

import React, { useRef, useEffect, useCallback } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { sql, PostgreSQL, MySQL, StandardSQL } from '@codemirror/lang-sql';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';

// ─── SQL dialect mapping ────────────────────────────────────────────────────

export type SqlDialect = 'postgresql' | 'mysql' | 'bigquery' | 'standard';

function getSqlDialect(dialect: SqlDialect) {
  switch (dialect) {
    case 'postgresql': return PostgreSQL;
    case 'mysql': return MySQL;
    case 'bigquery': return StandardSQL; // BigQuery is closest to StandardSQL in CodeMirror
    default: return StandardSQL;
  }
}

// ─── Dark theme matching Linear-style design ────────────────────────────────

const appTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    backgroundColor: 'rgb(var(--surface-1))',
    color: 'rgb(var(--text-primary))',
    borderRadius: '8px',
  },
  '.cm-content': {
    padding: '12px 0',
    caretColor: 'rgb(var(--brand))',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'rgb(var(--brand))',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(var(--brand), 0.15)',
  },
  '.cm-gutters': {
    backgroundColor: 'rgb(var(--surface-2))',
    color: 'rgb(var(--text-quaternary))',
    border: 'none',
    borderRight: '1px solid rgb(var(--border-line))',
    borderRadius: '8px 0 0 8px',
    minWidth: '40px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(var(--brand), 0.08)',
    color: 'rgb(var(--text-secondary))',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(var(--brand), 0.04)',
  },
  '.cm-foldGutter': {
    width: '12px',
  },
  '.cm-tooltip': {
    backgroundColor: 'rgb(var(--surface-2))',
    border: '1px solid rgb(var(--border-line))',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li': {
      padding: '4px 8px',
    },
    '& > ul > li[aria-selected]': {
      backgroundColor: 'rgba(var(--brand), 0.15)',
      color: 'rgb(var(--text-primary))',
    },
  },
  '.cm-panels': {
    backgroundColor: 'rgb(var(--surface-2))',
    color: 'rgb(var(--text-primary))',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(var(--brand), 0.2)',
    outline: '1px solid rgba(var(--brand), 0.4)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'rgba(var(--brand), 0.1)',
  },
  // Syntax highlighting overrides for SQL keywords / types / strings etc.
  '.ͼb': { color: '#c678dd' },   // keywords: purple
  '.ͼd': { color: '#61afef' },   // types: blue
  '.ͼe': { color: '#98c379' },   // strings: green
  '.ͼc': { color: '#d19a66' },   // numbers: orange
  '.ͼm': { color: '#5c6370', fontStyle: 'italic' }, // comments: gray italic
  '.ͼ7': { color: '#e06c75' },   // special/operators: red
});

// ─── Props ──────────────────────────────────────────────────────────────────

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  dialect?: SqlDialect;
  placeholder?: string;
  readOnly?: boolean;
  disabled?: boolean;
  height?: string;
  minHeight?: string;
  maxHeight?: string;
  className?: string;
  hasError?: boolean;
  /** Optional list of table names for autocomplete */
  tables?: string[];
}

// ─── Component ──────────────────────────────────────────────────────────────

export function SqlEditor({
  value,
  onChange,
  dialect = 'standard',
  placeholder = 'SELECT * FROM ...',
  readOnly = false,
  disabled = false,
  height = '240px',
  minHeight,
  maxHeight,
  className = '',
  hasError = false,
  tables,
}: SqlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const dialectCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());

  // Stable onChange ref to avoid recreating the editor
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Build schema for autocomplete from table names
  const buildSchema = useCallback(() => {
    if (!tables || tables.length === 0) return undefined;
    const schema: Record<string, string[]> = {};
    for (const t of tables) {
      schema[t] = [];
    }
    return schema;
  }, [tables]);

  // Create editor
  useEffect(() => {
    if (!containerRef.current) return;

    const schema = buildSchema();
    const sqlConfig = sql({
      dialect: getSqlDialect(dialect),
      upperCaseKeywords: true,
      ...(schema ? { schema } : {}),
    });

    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      bracketMatching(),
      closeBrackets(),
      foldGutter(),
      highlightSelectionMatches(),
      autocompletion(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      appTheme,
      dialectCompartment.current.of(sqlConfig),
      readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly || disabled)),
      cmPlaceholder(placeholder),
      keymap.of([
        ...defaultKeymap,
        ...searchKeymap,
        ...closeBracketsKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const doc = update.state.doc.toString();
          onChangeRef.current(doc);
        }
      }),
      EditorView.lineWrapping,
    ];

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Only create once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  // Reconfigure dialect
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const schema = buildSchema();
    const sqlConfig = sql({
      dialect: getSqlDialect(dialect),
      upperCaseKeywords: true,
      ...(schema ? { schema } : {}),
    });
    view.dispatch({
      effects: dialectCompartment.current.reconfigure(sqlConfig),
    });
  }, [dialect, buildSchema]);

  // Reconfigure readOnly
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        EditorState.readOnly.of(readOnly || disabled),
      ),
    });
  }, [readOnly, disabled]);

  const borderColor = hasError
    ? 'border-danger/40'
    : 'border-[rgb(var(--border-strong))]';

  const focusRing = hasError
    ? 'focus-within:ring-danger'
    : 'focus-within:ring-brand';

  return (
    <div
      ref={containerRef}
      className={`overflow-hidden rounded-lg border ${borderColor} focus-within:ring-2 ${focusRing} transition-shadow ${disabled ? 'opacity-60 pointer-events-none' : ''} ${className}`}
      style={{
        height,
        minHeight: minHeight || height,
        maxHeight: maxHeight || undefined,
        overflow: 'auto',
      }}
    />
  );
}
