'use client';

/**
 * The studio's code editor: CodeMirror 6 with HTML / CSS / JavaScript languages,
 * folding, completion, search & replace, bracket matching and syntax diagnostics
 * read from the language parser itself. Exposes a small imperative API so the
 * toolbar and the Data tab can drive it (format, undo, insert a snippet…).
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import {
  bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, syntaxTree,
} from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';

export type SourceLanguage = 'html' | 'css' | 'js';

export interface EditorProblem { line: number; message: string }

export interface SourceEditorHandle {
  focus: () => void;
  undo: () => void;
  redo: () => void;
  openSearch: () => void;
  gotoLine: (line: number) => void;
  insertAtCursor: (text: string) => void;
  /** Where the cursor is (0 = the author has not placed it yet). */
  getCursor: () => number;
  /** Replace [from, to) with text and put the cursor after it. */
  replaceRange: (from: number, to: number, text: string) => void;
  getValue: () => string;
  setValue: (text: string) => void;
}

const VI_PHRASES = EditorState.phrases.of({
  'Find': 'Tìm', 'Replace': 'Thay bằng', 'next': 'tiếp', 'previous': 'trước', 'all': 'tất cả', 'match case': 'phân biệt hoa thường',
  'regexp': 'biểu thức chính quy', 'by word': 'theo từ', 'replace': 'thay', 'replace all': 'thay tất cả', 'close': 'đóng',
  'Go to line': 'Đến dòng', 'go': 'đi', 'Folded lines': 'Dòng đã gập', 'Unfolded lines': 'Dòng đã mở', 'Fold line': 'Gập dòng', 'Unfold line': 'Mở dòng',
  'current match': 'kết quả hiện tại', 'on line': 'ở dòng', 'replaced match on line $': 'đã thay ở dòng $', 'replaced $ matches': 'đã thay $ kết quả',
});

const languageFor = (l: SourceLanguage) => (l === 'html' ? html({ autoCloseTags: true }) : l === 'css' ? css() : javascript());

/** Syntax errors as the parser sees them: error nodes in the syntax tree. */
function syntaxLinter(onProblems?: (p: EditorProblem[]) => void) {
  return linter((view) => {
    const out: Diagnostic[] = [];
    syntaxTree(view.state).cursor().iterate((node) => {
      if (node.type.isError && out.length < 50) {
        const from = node.from;
        const to = Math.max(node.to, Math.min(view.state.doc.length, from + 1));
        out.push({ from, to, severity: 'error', message: 'Lỗi cú pháp ở đây' });
      }
    });
    onProblems?.(out.map((d) => ({ line: view.state.doc.lineAt(d.from).number, message: d.message })));
    return out;
  }, { delay: 400 });
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'rgb(var(--surface-1))' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace', lineHeight: '1.6' },
  '.cm-content': { padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'rgb(var(--surface-2))', border: 'none', color: 'rgb(var(--text-quaternary, 148 163 184))' },
  '.cm-activeLineGutter': { backgroundColor: 'rgb(var(--brand-container))', color: 'rgb(var(--brand))' },
  '.cm-activeLine': { backgroundColor: 'rgba(11,87,208,0.04)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(11,87,208,0.18) !important' },
  '.cm-panels': { backgroundColor: 'rgb(var(--surface-2))', borderColor: 'rgb(var(--border-strong))' },
  '.cm-tooltip': { border: '1px solid rgb(var(--border-strong))', borderRadius: '8px', overflow: 'hidden' },
});

export const SourceEditor = forwardRef<SourceEditorHandle, {
  value: string;
  onChange: (next: string) => void;
  language: SourceLanguage;
  wrap?: boolean;
  onSave?: () => void;
  onRun?: () => void;
  onFormat?: () => void;
  onProblems?: (problems: EditorProblem[]) => void;
  readOnly?: boolean;
  testId?: string;
}>(function SourceEditor({ value, onChange, language, wrap = true, onSave, onRun, onFormat, onProblems, readOnly = false, testId }, ref) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const wrapCompartment = useRef(new Compartment());
  const cb = useRef({ onChange, onSave, onRun, onFormat, onProblems });
  cb.current = { onChange, onSave, onRun, onFormat, onProblems };

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(), foldGutter(), lintGutter(), highlightActiveLineGutter(), highlightSpecialChars(), history(),
        drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }), bracketMatching(), closeBrackets(), autocompletion(),
        rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
        languageFor(language),
        VI_PHRASES,
        syntaxLinter((p) => cb.current.onProblems?.(p)),
        EditorState.readOnly.of(readOnly),
        wrapCompartment.current.of(wrap ? EditorView.lineWrapping : []),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { cb.current.onSave?.(); return true; } },
          { key: 'Mod-Enter', preventDefault: true, run: () => { cb.current.onRun?.(); return true; } },
          { key: 'Shift-Alt-f', preventDefault: true, run: () => { cb.current.onFormat?.(); return true; } },
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
        ]),
        theme,
        EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current });
    return () => { view.current?.destroy(); view.current = null; };
  }, [language, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    view.current?.dispatch({ effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  // Outside changes (revert, AI result, format) replace the document; typing does not loop back.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    undo: () => { if (view.current) undo(view.current); },
    redo: () => { if (view.current) redo(view.current); },
    openSearch: () => { if (view.current) openSearchPanel(view.current); },
    gotoLine: (line: number) => {
      const v = view.current;
      if (!v) return;
      const l = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
      v.dispatch({ selection: EditorSelection.cursor(l.from), effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
      v.focus();
    },
    insertAtCursor: (text: string) => {
      const v = view.current;
      if (!v) return;
      const pos = v.state.selection.main.head;
      v.dispatch({ changes: { from: pos, insert: text }, selection: EditorSelection.cursor(pos + text.length), scrollIntoView: true });
      v.focus();
    },
    getCursor: () => view.current?.state.selection.main.head ?? 0,
    replaceRange: (from: number, to: number, text: string) => {
      const v = view.current;
      if (!v) return;
      v.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length), scrollIntoView: true });
      v.focus();
    },
    getValue: () => view.current?.state.doc.toString() ?? '',
    setValue: (text: string) => {
      const v = view.current;
      if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    },
  }), []);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-testid={testId} />;
});

/** Format code with Prettier, loaded only when asked for. */
export async function formatSource(code: string, language: SourceLanguage): Promise<string> {
  const prettier = await import('prettier/standalone');
  const plugins = language === 'html'
    ? [await import('prettier/plugins/html'), await import('prettier/plugins/postcss'), await import('prettier/plugins/babel'), await import('prettier/plugins/estree')]
    : language === 'css'
      ? [await import('prettier/plugins/postcss')]
      : [await import('prettier/plugins/babel'), await import('prettier/plugins/estree')];
  return prettier.format(code, {
    parser: language === 'html' ? 'html' : language === 'css' ? 'css' : 'babel',
    plugins: plugins as never[],
    printWidth: 110,
    htmlWhitespaceSensitivity: 'ignore',
  });
}
