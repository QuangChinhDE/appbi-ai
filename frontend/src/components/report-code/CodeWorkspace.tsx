'use client';

/**
 * Code-first workspace: three editors (HTML / CSS / JS) that stay mounted so each
 * keeps its own undo history, a toolbar, a problems panel (syntax errors from the
 * parser + runtime / quality issues from the preview) and a status bar.
 */
import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ClipboardPaste, Loader2, Maximize2, Minimize2, Play, Redo2, RotateCcw, Save, Search, Undo2, Wand2, WrapText, Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { SourceEditor, formatSource, type EditorProblem, type SourceEditorHandle, type SourceLanguage } from '@/components/report-code/SourceEditor';
import type { RuntimeIssue } from '@/components/report-code/ReportFrame';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';

export interface CodeSource { html: string; css: string; js: string }
export interface CodeWorkspaceHandle { insertHtml: (snippet: string) => void; focus: (lang?: SourceLanguage) => void }

/** Where a Data-tab snippet goes when the author has not placed the cursor: a filter into
 *  the page's filter bar, a block in place of the empty card placeholder, else inside the
 *  first data region (kpis / charts), else at the end. */
export function placeFor(doc: string, snippet: string): { from: number; to: number; text: string } | null {
  if (/data-rac-filter=/.test(snippet)) {
    const bar = /<div class="filters">(\s*<!--[\s\S]*?-->\s*)?/.exec(doc);
    if (bar) return { from: bar.index + '<div class="filters">'.length, to: bar.index + bar[0].length, text: snippet.trim() };
  }
  const empty = /<div class="card empty">[\s\S]*?<\/div>/.exec(doc);
  if (empty) return { from: empty.index, to: empty.index + empty[0].length, text: snippet.trim() };
  const region = /<(section|div)[^>]*data-rac-region="(kpis|charts)"[^>]*>/.exec(doc);
  if (region) { const at = region.index + region[0].length; return { from: at, to: at, text: `\n${snippet}` }; }
  return { from: doc.length, to: doc.length, text: `\n${snippet}` };
}

const FILES: { key: SourceLanguage; label: string }[] = [
  { key: 'html', label: 'HTML' }, { key: 'css', label: 'CSS' }, { key: 'js', label: 'JavaScript' },
];

export const CodeWorkspace = forwardRef<CodeWorkspaceHandle, {
  source: CodeSource;
  saved: CodeSource | null;
  onChange: (next: CodeSource) => void;
  onSave: () => void;
  onRevert: () => void;
  onRun: () => void;
  saving: boolean;
  editable: boolean;
  live: boolean;
  onToggleLive: () => void;
  maximized: boolean;
  onToggleMaximize: () => void;
  runtimeIssues: RuntimeIssue[];
  onPaste?: () => void;
  onAskAiFix?: () => void;
  warnings?: string[];
}>(function CodeWorkspace(props, ref) {
  const { t } = useI18n();
  const { source, saved, onChange, onSave, onRevert, onRun, saving, editable, live, onToggleLive, maximized, onToggleMaximize, runtimeIssues, onPaste, onAskAiFix, warnings } = props;
  const [active, setActive] = useState<SourceLanguage>('html');
  const [wrap, setWrap] = useState(true);
  const [formatting, setFormatting] = useState(false);
  const [syntax, setSyntax] = useState<Record<SourceLanguage, EditorProblem[]>>({ html: [], css: [], js: [] });
  const [showProblems, setShowProblems] = useState(true);
  const editors = { html: useRef<SourceEditorHandle | null>(null), css: useRef<SourceEditorHandle | null>(null), js: useRef<SourceEditorHandle | null>(null) };

  useImperativeHandle(ref, () => ({
    insertHtml: (snippet: string) => {
      setActive('html');
      setTimeout(() => {
        const ed = editors.html.current;
        if (!ed) return;
        // The author placed the cursor: insert exactly there. Not placed yet (still at 0):
        // put the snippet where it belongs in the page, never above the layout.
        const at = ed.getCursor() > 0 ? null : placeFor(ed.getValue(), snippet);
        if (at) ed.replaceRange(at.from, at.to, at.text);
        else ed.insertAtCursor(snippet);
      }, 0);
    },
    focus: (lang?: SourceLanguage) => { if (lang) setActive(lang); setTimeout(() => editors[lang || active].current?.focus(), 0); },
  }));

  const dirtyOf = (k: SourceLanguage) => !!saved && source[k] !== saved[k];
  const dirty = FILES.some((f) => dirtyOf(f.key));
  const lines = useMemo(() => Object.fromEntries(FILES.map((f) => [f.key, source[f.key].split('\n').length])) as Record<SourceLanguage, number>, [source]);
  const syntaxCount = syntax.html.length + syntax.css.length + syntax.js.length;
  const runtimeShown = runtimeIssues.filter((i) => i.kind !== 'blocked' || /cancelled|removed/.test(i.message));
  const problemCount = syntaxCount + runtimeShown.length + (warnings?.length || 0);

  const format = async () => {
    if (!editable || formatting) return;
    setFormatting(true);
    try {
      const out = await formatSource(source[active], active);
      onChange({ ...source, [active]: out });
      toast.success(t('reportCode.code.formatted', { file: FILES.find((f) => f.key === active)!.label }));
    } catch (e: any) {
      toast.error(t('reportCode.code.formatFailed') + (e?.message ? ` — ${String(e.message).split('\n')[0]}` : ''));
    } finally {
      setFormatting(false);
    }
  };

  const tool = (icon: React.ReactNode, title: string, onClick: () => void, opts: { testId?: string; disabled?: boolean; on?: boolean } = {}) => (
    <button type="button" title={title} aria-label={title} onClick={onClick} disabled={opts.disabled} data-testid={opts.testId}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition disabled:opacity-40 ${opts.on ? 'bg-brand-container text-brand' : 'text-text-tertiary hover:bg-surface-2 hover:text-text-primary'}`}>
      {icon}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="code-panel">
      {/* File tabs + actions */}
      <div className="flex flex-wrap items-center gap-1 border-b border-stroke-line bg-surface-1 px-2 py-1.5">
        <div className="flex items-center gap-0.5" role="tablist">
          {FILES.map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={active === f.key} onClick={() => setActive(f.key)} data-testid={`code-tab-${f.key}`}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${active === f.key ? 'bg-surface-2 text-text-primary ring-1 ring-inset ring-stroke-strong' : 'text-text-tertiary hover:text-text-primary'}`}>
              {f.label}
              <span className="text-[10px] font-normal text-text-quaternary">{lines[f.key]}</span>
              {dirtyOf(f.key) && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title={t('reportCode.code.unsaved')} />}
              {syntax[f.key].length > 0 && <span className="rounded bg-red-50 px-1 text-[10px] text-red-700">{syntax[f.key].length}</span>}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          {tool(formatting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />, `${t('reportCode.code.format')} (Shift+Alt+F)`, format, { testId: 'code-format', disabled: !editable })}
          {tool(<Undo2 className="h-3.5 w-3.5" />, `${t('reportCode.code.undo')} (Ctrl+Z)`, () => editors[active].current?.undo(), { testId: 'code-undo', disabled: !editable })}
          {tool(<Redo2 className="h-3.5 w-3.5" />, `${t('reportCode.code.redo')} (Ctrl+Shift+Z)`, () => editors[active].current?.redo(), { testId: 'code-redo', disabled: !editable })}
          {tool(<Search className="h-3.5 w-3.5" />, `${t('reportCode.code.search')} (Ctrl+F)`, () => editors[active].current?.openSearch(), { testId: 'code-search' })}
          {tool(<WrapText className="h-3.5 w-3.5" />, t('reportCode.code.wrap'), () => setWrap((w) => !w), { on: wrap })}
          {tool(maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />, maximized ? t('reportCode.code.restore') : t('reportCode.code.maximize'), onToggleMaximize, { testId: 'code-maximize', on: maximized })}
          {onPaste && tool(<ClipboardPaste className="h-3.5 w-3.5" />, t('reportCode.paste.open'), onPaste, { testId: 'code-paste-open' })}
        </div>
      </div>

      {/* Run / save row */}
      <div className="flex items-center gap-2 border-b border-stroke-line bg-surface-2/60 px-2.5 py-1.5">
        <button type="button" onClick={onToggleLive} data-testid="code-live-toggle"
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${live ? 'bg-brand-container text-brand-on-container ring-brand/30' : 'text-text-tertiary ring-stroke-strong'}`}>
          <Zap className="h-3 w-3" />{live ? t('reportCode.code.liveOn') : t('reportCode.code.liveOff')}
        </button>
        {!live && <Button size="xs" variant="secondary" leadingIcon={<Play className="h-3 w-3" />} onClick={onRun} data-testid="code-run">{t('reportCode.code.run')}</Button>}
        <span className="text-[11px] text-text-tertiary">{dirty ? t('reportCode.code.previewUnsaved') : t('reportCode.code.previewSaved')}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {editable && <Button size="xs" variant="ghost" leadingIcon={<RotateCcw className="h-3 w-3" />} onClick={onRevert} disabled={!dirty || saving} data-testid="code-revert">{t('reportCode.code.revert')}</Button>}
          {editable && <Button size="xs" variant="primary" leadingIcon={<Save className="h-3 w-3" />} onClick={onSave} disabled={!dirty || saving} loading={saving} data-testid="code-save">{t('reportCode.code.save')}</Button>}
        </div>
      </div>

      {/* Editors — all mounted, one shown */}
      <div className="relative min-h-0 flex-1">
        {FILES.map((f) => (
          <div key={f.key} className={active === f.key ? 'absolute inset-0' : 'hidden'}>
            <SourceEditor
              ref={editors[f.key]}
              language={f.key}
              value={source[f.key]}
              wrap={wrap}
              readOnly={!editable}
              onChange={(v) => onChange({ ...source, [f.key]: v })}
              onSave={onSave}
              onRun={onRun}
              onFormat={format}
              onProblems={(p) => setSyntax((prev) => (JSON.stringify(prev[f.key]) === JSON.stringify(p) ? prev : { ...prev, [f.key]: p }))}
              testId={`code-editor-${f.key}`}
            />
          </div>
        ))}
      </div>

      {/* Problems */}
      <div className="border-t border-stroke-line bg-surface-1">
        <button type="button" onClick={() => setShowProblems((v) => !v)} data-testid="code-problems-toggle"
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-text-tertiary hover:bg-surface-2">
          <AlertTriangle className={`h-3.5 w-3.5 ${problemCount ? 'text-amber-500' : 'text-text-quaternary'}`} />
          {t('reportCode.code.problems')} <span className={`rounded-full px-1.5 text-[10px] ${problemCount ? 'bg-amber-50 text-amber-800' : 'bg-surface-2 text-text-tertiary'}`}>{problemCount}</span>
          <span className="ml-auto font-normal normal-case tracking-normal text-text-quaternary">{t('reportCode.code.shortcuts')}</span>
        </button>
        {showProblems && problemCount > 0 && (
          <div className="max-h-40 overflow-y-auto px-2 pb-2 text-[11px]" data-testid="code-problems">
            {FILES.flatMap((f) => syntax[f.key].map((p, i) => (
              <button key={`${f.key}-${i}`} type="button" onClick={() => { setActive(f.key); setTimeout(() => editors[f.key].current?.gotoLine(p.line), 0); }}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-2">
                <span className="rounded bg-red-50 px-1.5 text-[10px] font-semibold text-red-700">{f.label}:{p.line}</span>
                <span className="text-text-secondary">{p.message}</span>
              </button>
            )))}
            {runtimeShown.map((i, n) => (
              <div key={`rt-${n}`} className="flex items-start gap-2 px-1.5 py-1">
                <span className="shrink-0 rounded bg-amber-50 px-1.5 text-[10px] font-semibold text-amber-800">{t(`reportCode.issues.kind.${i.kind}`) || i.kind}</span>
                <span className="text-text-secondary">{i.message}</span>
              </div>
            ))}
            {(warnings || []).map((w) => (
              <div key={w} className="flex items-start gap-2 px-1.5 py-1">
                <span className="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] font-semibold text-text-secondary">{t('reportCode.code.saveCheck')}</span>
                <span className="text-text-secondary">{w}</span>
              </div>
            ))}
            {onAskAiFix && (runtimeShown.some((i) => i.kind !== 'js_off') || syntaxCount > 0) && (
              <Button size="xs" variant="secondary" className="ml-1.5 mt-1" leadingIcon={<Wand2 className="h-3 w-3" />} onClick={onAskAiFix} data-testid="code-ai-fix">{t('reportCode.issues.fix')}</Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
