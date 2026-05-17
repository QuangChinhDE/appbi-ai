/**
 * JsFormulaEditor — sandboxed-JavaScript computed-column editor.
 *
 * UX after the user pointed out three pain points:
 *   1. The editor must FEEL like a normal code editor — light theme, real
 *      syntax colours, click anywhere = caret moves, no popup hijacks
 *      typing. We disable autocomplete-on-typing entirely; the user opens
 *      suggestions on demand with Ctrl+Space (or Alt+Space).
 *   2. The columns panel handles 100+ columns: groups collapse by default
 *      so the panel doesn't dump everything; a search box and a small
 *      counter per group let the user drill in fast.
 *   3. Helpers used to live as a permanent tab. Now it's a popover
 *      triggered from a small button in the toolbar — open, look up,
 *      close. No tab toggle, no real estate stolen from columns.
 */
'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import {
  CompletionContext,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
  startCompletion,
} from '@codemirror/autocomplete';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import {
  Calculator,
  ChevronDown,
  ChevronRight,
  Check,
  Code2,
  Copy,
  Database,
  Link2,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';

import { cn } from '@/lib/utils';

export interface AvailableColumn {
  name: string;
  source: 'db' | 'lookup' | 'computed';
  label?: string;
  /** For lookups, where the value comes from, e.g. "Customers.name". */
  origin?: string;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  availableColumns: AvailableColumn[];
}

interface HelperEntry {
  name: string;
  signature: string;
  description: string;
}

const HELPERS: HelperEntry[] = [
  { name: '$helpers.sum',     signature: '$helpers.sum(rows, "col")',                            description: 'Cộng tất cả giá trị số của cột "col".' },
  { name: '$helpers.avg',     signature: '$helpers.avg(rows, "col")',                            description: 'Trung bình cộng, trả null khi rỗng.' },
  { name: '$helpers.min',     signature: '$helpers.min(rows, "col")',                            description: 'Giá trị nhỏ nhất.' },
  { name: '$helpers.max',     signature: '$helpers.max(rows, "col")',                            description: 'Giá trị lớn nhất.' },
  { name: '$helpers.count',   signature: '$helpers.count(rows, predicate?)',                     description: 'Đếm rows (có thể truyền predicate).' },
  { name: '$helpers.sumIf',   signature: '$helpers.sumIf(rows, r => r.x > 10, "qty")',           description: 'SUMIF — cộng có điều kiện.' },
  { name: '$helpers.countIf', signature: '$helpers.countIf(rows, r => r.x > 10)',                description: 'COUNTIF — đếm có điều kiện.' },
  { name: '$helpers.lookup',  signature: '$helpers.lookup(rows, "key", value, "returnKey"?)',    description: 'Tìm row đầu tiên khớp, trả 1 field hoặc nguyên row.' },
  { name: '$helpers.today',   signature: '$helpers.today()',                                     description: 'ISO date UTC hôm nay.' },
  { name: '$helpers.now',     signature: '$helpers.now()',                                       description: 'ISO datetime UTC hiện tại.' },
  { name: '$helpers.dayjs',   signature: '$helpers.dayjs(input?).format("YYYY-MM-DD")',          description: 'Wrapper ngày giờ: format / diff / add.' },
  { name: '$helpers.format',  signature: '$helpers.format(value, "#,##0.00")',                   description: 'Format số: 0 / 0.00 / #,##0 / 0% / 0.00%.' },
];

const SOURCE_META: Record<
  AvailableColumn['source'],
  { label: string; Icon: React.ElementType; badge: string }
> = {
  db:       { label: 'Bảng gốc',  Icon: Database,   badge: 'bg-surface-2 text-text-tertiary' },
  lookup:   { label: 'Lookup',    Icon: Link2,      badge: 'bg-info/10 text-info' },
  computed: { label: 'Computed',  Icon: Calculator, badge: 'bg-brand/10 text-brand' },
};

function includesSearch(value: string | undefined, query: string): boolean {
  return (value || '').toLowerCase().includes(query);
}

/**
 * VSCode-light–ish highlight palette. Background lives in the `&` theme
 * block below; this only controls token colours.
 */
const lightHighlight = HighlightStyle.define([
  { tag: t.keyword,           color: '#0000ff' },
  { tag: [t.string, t.special(t.string)], color: '#a31515' },
  { tag: t.number,            color: '#098658' },
  { tag: t.comment,           color: '#008000', fontStyle: 'italic' },
  { tag: t.function(t.variableName), color: '#795e26' },
  { tag: t.variableName,      color: '#001080' },
  { tag: t.propertyName,      color: '#001080' },
  { tag: t.bool,              color: '#0000ff' },
  { tag: t.null,              color: '#0000ff' },
  { tag: t.operator,          color: '#000000' },
  { tag: t.bracket,           color: '#000000' },
  { tag: t.regexp,            color: '#811f3f' },
  { tag: [t.atom, t.self],    color: '#0000ff' },
]);

/**
 * Build a CodeMirror completion source — manual-trigger only.
 *
 * Returns suggestions when the cursor sits after ``row.`` or
 * ``$helpers.``. Even with manual trigger, prefix-matching narrows the
 * list, so users can type ``row.id`` + Ctrl+Space and see only ``id``-ish
 * columns.
 */
function makeCompletions(columns: AvailableColumn[]) {
  return (ctx: CompletionContext) => {
    const rowMatch = ctx.matchBefore(/row\.\w*$/);
    if (rowMatch) {
      const from = rowMatch.from + 'row.'.length;
      return {
        from,
        options: columns.map((col) => ({
          label: col.name,
          type:
            col.source === 'lookup'
              ? 'class'
              : col.source === 'computed'
                ? 'function'
                : 'variable',
          detail:
            col.source === 'lookup'
              ? col.origin || 'lookup'
              : col.source === 'computed'
                ? 'computed'
                : 'source',
          info: col.label || undefined,
        })),
        validFor: /^\w*$/,
      };
    }
    const helperMatch = ctx.matchBefore(/\$helpers\.\w*$/);
    if (helperMatch) {
      const from = helperMatch.from + '$helpers.'.length;
      return {
        from,
        options: HELPERS.map((h) => ({
          label: h.name.replace('$helpers.', ''),
          type: 'function',
          detail: h.signature.replace('$helpers.', ''),
          info: h.description,
        })),
        validFor: /^\w*$/,
      };
    }
    return null;
  };
}

export default function JsFormulaEditor({
  value,
  onChange,
  availableColumns,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const columnsRef = useRef(availableColumns);
  const [search, setSearch] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // Sidebar groups — collapsed by default so a 100-col table doesn't
  // dump everything on first render. ``helpers`` lives in the same rail
  // as the column groups (was previously a floating toolbar popover; the
  // popover was removed because positioning quirks could open it
  // unexpectedly on certain layouts).
  const [openGroups, setOpenGroups] = useState<{
    db: boolean;
    lookup: boolean;
    computed: boolean;
    helpers: boolean;
  }>({ db: false, lookup: false, computed: false, helpers: false });

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    columnsRef.current = availableColumns;
  }, [availableColumns]);

  // Build the editor exactly once. Recreating on every parent render
  // would clobber the user's selection + scroll position.
  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;

    const completion = autocompletion({
      override: [
        (ctx: CompletionContext) =>
          makeCompletions(columnsRef.current)(ctx) || null,
      ],
      // Manual-trigger only: prevents the popup from hijacking the
      // caret every time the user clicks into the editor.
      activateOnTyping: false,
      // ``defaultKeymap: false`` removes Tab/Enter = accept-completion
      // so a stray Tab keeps indenting code instead of inserting a
      // suggestion. Ctrl+Space + Escape are bound below.
      defaultKeymap: false,
      closeOnBlur: true,
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        highlightActiveLine(),
        completion,
        javascript(),
        syntaxHighlighting(lightHighlight),
        // Soft-wrap long lines: a formula in a narrow inspector pane
        // should never need horizontal scroll.
        EditorView.lineWrapping,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          // Manual completion only — opens with Ctrl+Space / Alt+Space.
          // We deliberately do NOT bind Enter/Tab to accept, so typing
          // never triggers a surprise insert.
          { key: 'Mod-Space', run: startCompletion },
          { key: 'Alt-Space', run: startCompletion },
          { key: 'Escape', run: closeCompletion },
          indentWithTab,
        ]),
        EditorView.theme(
          {
            '&': {
              height: '100%',
              fontSize: '13px',
              backgroundColor: '#ffffff',
              color: '#1f2328',
            },
            '.cm-scroller': {
              fontFamily:
                'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, monospace',
              lineHeight: '1.6',
            },
            '.cm-content': {
              caretColor: '#1f2328',
              padding: '12px 0',
            },
            '.cm-line': { padding: '0 14px' },
            '.cm-gutters': {
              backgroundColor: '#f6f8fa',
              borderRight: '1px solid #e1e4e8',
              color: '#8c959f',
              fontSize: '11px',
            },
            '.cm-activeLine': { backgroundColor: '#f6f8fa' },
            '.cm-activeLineGutter': {
              backgroundColor: '#eaeef2',
              color: '#1f2328',
            },
            '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
              backgroundColor: '#cce5ff !important',
            },
            '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
              backgroundColor: '#fffbdd',
              color: 'inherit',
              outline: '1px solid #e7c84a',
            },
            '.cm-tooltip-autocomplete': {
              border: '1px solid #d0d7de',
              borderRadius: '8px',
              boxShadow: '0 8px 24px -8px rgba(15, 23, 42, 0.18)',
              backgroundColor: '#ffffff',
              color: '#1f2328',
              fontSize: '12px',
              overflow: 'hidden',
            },
            '.cm-tooltip-autocomplete > ul': {
              fontFamily:
                'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, monospace',
            },
            '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
              backgroundColor: '#0969da',
              color: 'white',
            },
          },
          { dark: false },
        ),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });

    viewRef.current = new EditorView({
      state,
      parent: containerRef.current,
    });

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external value changes into the doc only when they differ —
  // avoids resetting the caret on every parent render.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  // ── Groups + search ─────────────────────────────────────────────────
  const groupedColumns = useMemo(() => {
    const out: Record<AvailableColumn['source'], AvailableColumn[]> = {
      db: [],
      lookup: [],
      computed: [],
    };
    const query = search.trim().toLowerCase();
    for (const col of availableColumns) {
      const matches =
        !query ||
        includesSearch(col.name, query) ||
        includesSearch(col.label, query) ||
        includesSearch(col.origin, query);
      if (matches) out[col.source].push(col);
    }
    return out;
  }, [availableColumns, search]);

  // While the user is searching, force every non-empty group open so
  // results are immediately visible. When the search clears, restore the
  // user's manual open/close state.
  const effectiveOpen = useMemo(() => {
    if (search.trim()) {
      return {
        db: groupedColumns.db.length > 0,
        lookup: groupedColumns.lookup.length > 0,
        computed: groupedColumns.computed.length > 0,
        helpers: true,
      };
    }
    return openGroups;
  }, [search, openGroups, groupedColumns]);

  const filteredHelpers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return HELPERS;
    return HELPERS.filter(
      (helper) =>
        includesSearch(helper.name, query) ||
        includesSearch(helper.signature, query) ||
        includesSearch(helper.description, query),
    );
  }, [search]);

  const lineCount = useMemo(() => {
    if (!value) return 1;
    return value.split(/\r\n|\r|\n/).length;
  }, [value]);

  // Insert helpers — use mousedown.preventDefault so clicking a row
  // doesn't blur the editor (which would lose the selection).
  const insertSnippet = useCallback(
    (snippet: string) => {
      const view = viewRef.current;
      if (!view) {
        onChangeRef.current(`${value}${snippet}`);
        return;
      }
      view.dispatch(view.state.replaceSelection(snippet));
      view.focus();
    },
    [value],
  );

  const copyText = useCallback(async (key: string, text: string) => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1200);
    } catch {
      // Clipboard permission failures should not interrupt formula editing.
    }
  }, []);

  const totalColumnsAfterSearch =
    groupedColumns.db.length +
    groupedColumns.lookup.length +
    groupedColumns.computed.length;

  return (
    <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[rgb(var(--border-line))] bg-surface-0 text-brand">
          <Code2 className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="text-caption font-emphasis text-text-primary">
            JavaScript formula
          </div>
          <div className="text-tiny text-text-tertiary">QuickJS sandbox</div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5 text-tiny text-text-tertiary">
          {['row', 'rows', 'index', '$helpers'].map((token) => (
            <code
              key={token}
              className="rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-1.5 py-0.5"
            >
              {token}
            </code>
          ))}
        </div>
      </div>

      {/* Body: editor + Columns rail */}
      <div className="grid grid-cols-[1fr_280px] min-h-[440px]">
        {/* Editor */}
        <div className="min-w-0 bg-white">
          <div
            ref={containerRef}
            className="h-[440px] min-h-[360px] overflow-auto"
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-[rgb(var(--border-line))] bg-surface-1 px-3 py-1.5 text-tiny text-text-tertiary">
            <span>
              {lineCount} dòng · {value.length} ký tự
            </span>
            <span className="ml-auto rounded bg-surface-2 px-1.5 py-0.5 font-emphasis text-text-secondary">
              Ctrl+Space để autocomplete
            </span>
          </div>
        </div>

        {/* Columns rail — collapse by default, search box on top */}
        <aside className="flex min-h-[300px] flex-col border-l border-[rgb(var(--border-line))] bg-surface-1">
          <div className="border-b border-[rgb(var(--border-line))] p-2">
            <div className="flex items-center gap-1.5 px-1 pb-2 text-tiny font-emphasis uppercase tracking-wider text-text-tertiary">
              <Database className="h-3 w-3" />
              Columns
              <span className="ml-auto rounded bg-surface-2 px-1 normal-case font-normal text-text-quaternary">
                {availableColumns.length}
              </span>
            </div>
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-quaternary" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-8 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 pl-8 pr-2 text-caption text-text-primary outline-none transition-colors placeholder:text-text-quaternary focus:border-brand"
                placeholder="Tìm cột…"
              />
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1.5">
            {totalColumnsAfterSearch === 0 ? (
              <div className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-0 px-3 py-6 text-center text-caption text-text-tertiary">
                {search.trim() ? 'Không có cột khớp.' : 'Không có cột nào.'}
              </div>
            ) : (
              (['db', 'lookup', 'computed'] as const).map((source) =>
                groupedColumns[source].length === 0 ? null : (
                  <ColumnGroup
                    key={source}
                    source={source}
                    columns={groupedColumns[source]}
                    open={effectiveOpen[source]}
                    forced={!!search.trim()}
                    onToggle={() =>
                      setOpenGroups((prev) => ({
                        ...prev,
                        [source]: !prev[source],
                      }))
                    }
                    copiedKey={copiedKey}
                    onInsert={insertSnippet}
                    onCopy={copyText}
                  />
                ),
              )
            )}
            {filteredHelpers.length > 0 ? (
              <section className="pt-1 mt-1 border-t border-[rgb(var(--border-line))]">
                <button
                  type="button"
                  onClick={
                    search.trim()
                      ? undefined
                      : () =>
                          setOpenGroups((prev) => ({
                            ...prev,
                            helpers: !prev.helpers,
                          }))
                  }
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors',
                    search.trim() ? 'cursor-default' : 'hover:bg-surface-2',
                  )}
                >
                  {!search.trim() &&
                    (effectiveOpen.helpers ? (
                      <ChevronDown className="h-3 w-3 text-text-quaternary" />
                    ) : (
                      <ChevronRight className="h-3 w-3 text-text-quaternary" />
                    ))}
                  <Sparkles className="h-3 w-3 text-text-tertiary" />
                  <span className="text-tiny font-emphasis text-text-secondary">
                    Helpers
                  </span>
                  <span className="ml-auto rounded bg-surface-2 px-1.5 py-0.5 text-micro text-text-tertiary">
                    {filteredHelpers.length}
                  </span>
                </button>
                {effectiveOpen.helpers && (
                  <div className="mt-0.5 space-y-1 pl-2">
                    {filteredHelpers.map((h) => (
                      <HelperRow
                        key={h.name}
                        helper={h}
                        copied={copiedKey === `helper:${h.name}`}
                        onInsert={() => insertSnippet(h.signature)}
                        onCopy={() => copyText(`helper:${h.name}`, h.signature)}
                      />
                    ))}
                  </div>
                )}
              </section>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

function ColumnGroup({
  source,
  columns,
  open,
  forced,
  onToggle,
  copiedKey,
  onInsert,
  onCopy,
}: {
  source: AvailableColumn['source'];
  columns: AvailableColumn[];
  open: boolean;
  /** True when search is active — the group is force-open and the
   * collapse chevron is hidden so the user knows toggling is locked. */
  forced: boolean;
  onToggle: () => void;
  copiedKey: string | null;
  onInsert: (snippet: string) => void;
  onCopy: (key: string, text: string) => void;
}) {
  const meta = SOURCE_META[source];
  return (
    <section>
      <button
        type="button"
        onClick={forced ? undefined : onToggle}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors',
          forced
            ? 'cursor-default'
            : 'hover:bg-surface-2',
        )}
      >
        {!forced &&
          (open ? (
            <ChevronDown className="h-3 w-3 text-text-quaternary" />
          ) : (
            <ChevronRight className="h-3 w-3 text-text-quaternary" />
          ))}
        <meta.Icon className="h-3 w-3 text-text-tertiary" />
        <span className="text-tiny font-emphasis text-text-secondary">
          {meta.label}
        </span>
        <span className="ml-auto rounded bg-surface-2 px-1.5 py-0.5 text-micro text-text-tertiary">
          {columns.length}
        </span>
      </button>
      {open && (
        <div className="mt-0.5 space-y-1 pl-2">
          {columns.map((column) => {
            const snippet = `row.${column.name}`;
            const key = `col:${column.name}`;
            return (
              <ReferenceRow
                key={`${source}:${column.name}`}
                title={snippet}
                subtitle={column.origin || column.label}
                badge={meta.label}
                badgeClassName={meta.badge}
                copied={copiedKey === key}
                onInsert={() => onInsert(snippet)}
                onCopy={() => onCopy(key, snippet)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function HelperRow({
  helper,
  copied,
  onInsert,
  onCopy,
}: {
  helper: HelperEntry;
  copied: boolean;
  onInsert: () => void;
  onCopy: () => void;
}) {
  return (
    <ReferenceRow
      title={helper.name}
      subtitle={helper.signature}
      description={helper.description}
      badge="ƒ"
      badgeClassName="bg-brand/10 text-brand"
      copied={copied}
      onInsert={onInsert}
      onCopy={onCopy}
    />
  );
}

function ReferenceRow({
  title,
  subtitle,
  description,
  badge,
  badgeClassName,
  copied,
  onInsert,
  onCopy,
}: {
  title: string;
  subtitle?: string;
  description?: string;
  badge: string;
  badgeClassName: string;
  copied: boolean;
  onInsert: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="group rounded-md border border-transparent bg-surface-0 px-2 py-1.5 transition-colors hover:border-[rgb(var(--border-line))] hover:bg-surface-2">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <code className="min-w-0 truncate text-[11px] font-emphasis text-text-primary">
              {title}
            </code>
            <span
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-micro font-emphasis',
                badgeClassName,
              )}
            >
              {badge}
            </span>
          </div>
          {subtitle ? (
            <div className="mt-0.5 truncate text-[10px] text-text-tertiary">
              {subtitle}
            </div>
          ) : null}
          {description ? (
            <div className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-text-quaternary">
              {description}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
          <button
            type="button"
            onMouseDown={(event) => {
              // Insert without stealing the editor's focus.
              event.preventDefault();
              onInsert();
            }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary transition-colors hover:border-brand/30 hover:text-brand"
            title="Chèn vào editor"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onCopy}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary transition-colors hover:border-brand/30 hover:text-brand"
            title="Copy"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
