'use client';

import React from 'react';
import {
  ArrowUp, Check, Crosshair, Info, Layers, Loader2, Maximize2, Minus, Move,
  Palette, Paperclip, ShieldAlert, SlidersHorizontal, Sparkles, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/providers/LanguageProvider';
import type { PresentationDiff } from '@/lib/dashboard-presentation/diff';
import type { Violation } from '@/lib/dashboard-presentation/validator';
import type { PresentationScope } from '@/lib/dashboard-presentation/types';

/**
 * The chat side of AI Design.
 *
 * It renders a conversation, a scope selector, a change summary and two
 * buttons, and it owns none of the rules. Everything deciding whether a design
 * is legal, what it compiles to, or how it reaches the draft lives in
 * `lib/dashboard-presentation` — so this component cannot be the place a
 * capability quietly widens.
 *
 * Three things here are design decisions rather than decoration:
 *
 *   - the change summary is a row of counted chips. "Moved 8 · Resized 5"
 *     invites a look at the grid before Apply; "layout improved" invites a
 *     click. The number is the point.
 *   - notes sit in their own quiet block with an info mark, never mixed into
 *     the counts. They are where the system admits to approximating something,
 *     and burying them next to a success message would make the summary a lie
 *     by omission.
 *   - the scope selector is a control, not a hint, and it says out loud when
 *     the chosen scope is the one that repaints every page.
 */

export interface AiDesignTurn {
  role: 'user' | 'assistant';
  text: string;
  /** Present on assistant turns that produced a previewable design. */
  diff?: PresentationDiff;
  /** Present when a plan was refused. */
  violations?: Violation[];
  /** Reference images (data URLs) the user attached to THIS turn, shown back as
   *  thumbnails so the conversation records what the design was matched against. */
  images?: string[];
}

export interface AiDesignPanelProps {
  turns: AiDesignTurn[];
  busy: boolean;
  scope: PresentationScope;
  onScopeChange: (scope: PresentationScope) => void;
  onSubmit: (prompt: string, images?: string[]) => void;
  /** Non-null while a design is previewed but not applied. */
  pendingDiff: PresentationDiff | null;
  onApply: () => void;
  onDiscard: () => void;
  /** Collapse the panel to a floating bubble, revealing the full report. */
  onCollapse?: () => void;
  onClose: () => void;
  visualCount: number;
  pageName: string;
  /** When the user clicked a chart to restyle just it — its title, and a way to
   *  return to whole-page editing. */
  focusedChartName?: string | null;
  onClearFocus?: () => void;
}

const CHIP_ICONS = {
  moved: Move,
  resized: Maximize2,
  restyled: Palette,
  filters: SlidersHorizontal,
  theme: Palette,
  sections: Layers,
} as const;

function DiffChips({ diff }: { diff: PresentationDiff }) {
  const { t } = useI18n();
  const chips: Array<{ key: keyof typeof CHIP_ICONS; label: string }> = [];
  if (diff.moved.length) chips.push({ key: 'moved', label: t('dashboards.aiDesign.movedCount', { count: diff.moved.length }) });
  if (diff.resized.length) chips.push({ key: 'resized', label: t('dashboards.aiDesign.resizedCount', { count: diff.resized.length }) });
  if (diff.restyled.length) chips.push({ key: 'restyled', label: t('dashboards.aiDesign.restyledCount', { count: diff.restyled.length }) });
  if (diff.slicerKeys.length) chips.push({ key: 'filters', label: t('dashboards.aiDesign.chipFilters') });
  if (diff.themeKeys.length) chips.push({ key: 'theme', label: t('dashboards.aiDesign.chipTheme') });
  if (diff.createdWidgetCount) {
    chips.push({ key: 'sections', label: t('dashboards.aiDesign.chipSections', { count: diff.createdWidgetCount }) });
  }

  if (chips.length === 0 && diff.notes.length === 0) {
    return (
      <p className="mt-2 text-caption text-text-tertiary">{t('dashboards.aiDesign.noChange')}</p>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => {
            const Icon = CHIP_ICONS[chip.key];
            return (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1 rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-[11px] font-[510] text-text-secondary"
              >
                <Icon className="h-3 w-3 text-text-quaternary" />
                {chip.label}
              </span>
            );
          })}
        </div>
      )}
      {diff.notes.length > 0 && (
        <div className="rounded-lg bg-surface-2 px-2.5 py-2">
          {diff.notes.map((note) => (
            <p key={note} className="flex gap-1.5 text-[11px] leading-relaxed text-text-tertiary">
              <Info className="mt-[3px] h-3 w-3 shrink-0" />
              <span>{note}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function Turn({ turn }: { turn: AiDesignTurn }) {
  const { t } = useI18n();

  if (turn.role === 'user') {
    // Right-aligned and tinted, so the eye can find "what did I ask for?"
    // without reading. A label on every line would be noise.
    return (
      <div className="flex flex-col items-end gap-1.5">
        {turn.images && turn.images.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {turn.images.map((src, index) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={index}
                src={src}
                alt={t('dashboards.aiDesign.attachReference')}
                className="h-16 w-16 rounded-lg border border-[rgb(var(--border-line))] object-cover"
              />
            ))}
          </div>
        )}
        {turn.text && (
          <p className="max-w-[85%] rounded-2xl rounded-br-md bg-brand/10 px-3 py-2 text-caption leading-relaxed text-text-primary">
            {turn.text}
          </p>
        )}
      </div>
    );
  }

  const refused = Boolean(turn.violations?.length);
  return (
    <div className="flex gap-2">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
          refused ? 'bg-danger/10' : 'bg-brand/10'
        }`}
      >
        {refused
          ? <ShieldAlert className="h-3 w-3 text-danger" />
          : <Sparkles className="h-3 w-3 text-brand" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-caption leading-relaxed text-text-secondary">{turn.text}</p>
        {turn.diff && <DiffChips diff={turn.diff} />}
        {refused && (
          <ul className="mt-2 space-y-1 rounded-lg border border-danger/25 bg-danger/[0.04] px-2.5 py-2">
            {turn.violations!.slice(0, 4).map((violation) => (
              <li
                key={`${violation.code}-${violation.visualId ?? ''}`}
                className="text-[11px] leading-relaxed text-danger"
              >
                {violation.message}
              </li>
            ))}
            <li className="pt-0.5 text-[11px] leading-relaxed text-text-tertiary">
              {t('dashboards.aiDesign.notPresentation')}
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}

export function AiDesignPanel({
  turns, busy, scope, onScopeChange, onSubmit,
  pendingDiff, onApply, onDiscard, onCollapse, onClose, visualCount, pageName,
  focusedChartName, onClearFocus,
}: AiDesignPanelProps) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState('');
  // Reference images attached to the NEXT message, as data URLs. Cleared on send
  // — a reference belongs to the turn it was attached to, not the conversation.
  const [attached, setAttached] = React.useState<string[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [turns.length, busy, pendingDiff]);

  // Grow with the text up to a few lines, then scroll. A fixed 3-row box wastes
  // space on "make it dark" and truncates a considered instruction.
  React.useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
  }, [draft]);

  const disabled = busy || visualCount === 0;

  // Three references is plenty to describe a look; each is capped at 6MB so a
  // screenshot pasted at full resolution does not bloat the request. The server
  // enforces the same bounds — this is the friendly half of the pair.
  const MAX_REFS = 3;
  const MAX_BYTES = 6 * 1024 * 1024;

  const readAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const addFiles = React.useCallback(async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length < files.length) toast.error(t('dashboards.aiDesign.imageRejected'));
    const accepted: string[] = [];
    for (const file of images) {
      if (attached.length + accepted.length >= MAX_REFS) break;
      if (file.size > MAX_BYTES) { toast.error(t('dashboards.aiDesign.imageTooLarge')); continue; }
      try { accepted.push(await readAsDataUrl(file)); } catch { /* skip unreadable */ }
    }
    if (accepted.length > 0) setAttached((current) => [...current, ...accepted].slice(0, MAX_REFS));
  }, [attached.length, t]);

  const onPickFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ''; // let the same file be chosen again after removal
    if (files.length) void addFiles(files);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file != null);
    if (files.length > 0) { event.preventDefault(); void addFiles(files); }
  };

  const send = () => {
    const value = draft.trim();
    // An image on its own is a complete request — "make it look like this" — so
    // a default prompt stands in when only a reference was attached.
    if (disabled || (!value && attached.length === 0)) return;
    const prompt = value || t('dashboards.aiDesign.matchReference');
    const images = attached;
    setDraft('');
    setAttached([]);
    onSubmit(prompt, images.length > 0 ? images : undefined);
  };

  const examples = [
    t('dashboards.aiDesign.example1'),
    t('dashboards.aiDesign.example2'),
    t('dashboards.aiDesign.example3'),
  ];

  return (
    <aside
      className="flex h-full w-[380px] shrink-0 flex-col overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1"
      aria-label={t('dashboards.aiDesign.title')}
    >
      <header className="flex items-start gap-2.5 border-b border-[rgb(var(--border-line))] px-4 py-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand/10">
          <Sparkles className="h-3.5 w-3.5 text-brand" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-[560] text-text-primary">{t('dashboards.aiDesign.title')}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-tertiary">
            {t('dashboards.aiDesign.subtitle')}
          </p>
        </div>
        <div className="-mr-1 flex items-center gap-0.5">
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label={t('dashboards.aiDesign.collapse')}
              title={t('dashboards.aiDesign.collapse')}
              className="rounded-md p-1 text-text-quaternary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('dashboards.aiDesign.close')}
            className="rounded-md p-1 text-text-quaternary transition-colors hover:bg-surface-2 hover:text-text-primary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {focusedChartName ? (
        // The user clicked one visual. The scope selector is meaningless here —
        // this turn restyles exactly that tile — so it is replaced by a chip
        // that names the target and offers the way back to whole-page editing.
        <div className="border-b border-[rgb(var(--border-line))] px-4 py-2.5">
          <div className="flex items-center gap-2 rounded-lg border border-[rgb(var(--accent))]/35 bg-[rgb(var(--accent))]/10 px-2.5 py-1.5">
            <Crosshair className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--accent))]" />
            <span className="min-w-0 flex-1 truncate text-[11px] font-[560] text-text-primary">
              {t('dashboards.aiDesign.focusEditing', { chart: focusedChartName })}
            </span>
            <button
              type="button"
              onClick={() => onClearFocus?.()}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-[510] text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-secondary"
            >
              {t('dashboards.aiDesign.focusClear')}
            </button>
          </div>
          <p className="mt-1.5 flex gap-1.5 text-[11px] leading-relaxed text-text-tertiary">
            <Info className="mt-[3px] h-3 w-3 shrink-0" />
            <span>{t('dashboards.aiDesign.focusHint')}</span>
          </p>
        </div>
      ) : (
        <div className="border-b border-[rgb(var(--border-line))] px-4 py-2.5">
          <div
            className="flex rounded-lg bg-surface-2 p-0.5"
            role="radiogroup"
            aria-label={t('dashboards.aiDesign.scopeLabel')}
          >
            {(['page', 'report'] as PresentationScope[]).map((value) => {
              const active = scope === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onScopeChange(value)}
                  title={value === 'page' ? pageName : undefined}
                  className={`min-w-0 flex-1 truncate rounded-md px-2 py-1 text-[11px] font-[510] transition-colors ${
                    active
                      ? 'bg-surface-1 text-text-primary shadow-sm'
                      : 'text-text-tertiary hover:text-text-secondary'
                  }`}
                >
                  {value === 'page' ? t('dashboards.aiDesign.scopePage') : t('dashboards.aiDesign.scopeReport')}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 flex gap-1.5 text-[11px] leading-relaxed text-text-tertiary">
            <Info className="mt-[3px] h-3 w-3 shrink-0" />
            <span>
              {scope === 'report'
                ? t('dashboards.aiDesign.scopeReportWarning')
                : t('dashboards.aiDesign.scopePageHint', { page: pageName })}
            </span>
          </p>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5">
        {turns.length === 0 && (
          <div>
            {visualCount === 0 ? (
              <p className="text-caption leading-relaxed text-text-tertiary">
                {t('dashboards.aiDesign.emptyPage')}
              </p>
            ) : (
              <>
                <p className="text-[11px] font-[510] uppercase tracking-wide text-text-quaternary">
                  {t('dashboards.aiDesign.examplesTitle')}
                </p>
                <div className="mt-2 space-y-1.5">
                  {examples.map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => onSubmit(example)}
                      disabled={disabled}
                      className="group flex w-full items-start gap-2 rounded-lg border border-[rgb(var(--border-line))] px-2.5 py-2 text-left transition-colors hover:border-brand/40 hover:bg-brand/[0.04] disabled:opacity-50"
                    >
                      <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-text-quaternary transition-colors group-hover:text-brand" />
                      <span className="text-[11px] leading-relaxed text-text-secondary">{example}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {turns.map((turn, index) => (
          <Turn key={`${turn.role}-${index}`} turn={turn} />
        ))}

        {busy && (
          <div className="flex gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/10">
              <Loader2 className="h-3 w-3 animate-spin text-brand" />
            </span>
            <p className="text-caption leading-relaxed text-text-tertiary">
              {t('dashboards.aiDesign.thinking')}
            </p>
          </div>
        )}
      </div>

      {pendingDiff && (
        <div className="border-t border-[rgb(var(--border-line))] bg-brand/[0.04] px-4 py-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-[510] text-brand">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
            </span>
            {t('dashboards.aiDesign.previewing')}
          </p>
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={onDiscard}
              className="flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              {t('dashboards.aiDesign.discard')}
            </button>
            <button
              type="button"
              onClick={onApply}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-brand px-2 py-1.5 text-[12px] font-[510] text-white transition-colors hover:bg-brand-hover"
            >
              <Check className="h-3 w-3" />
              {t('dashboards.aiDesign.apply')}
            </button>
          </div>
        </div>
      )}

      <div className="border-t border-[rgb(var(--border-line))] px-4 py-3">
        <div
          onDragOver={(event) => { if (!disabled) { event.preventDefault(); setDragging(true); } }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (disabled) return;
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (files.length) void addFiles(files);
          }}
          className={`relative rounded-xl border bg-surface-1 transition-colors focus-within:border-brand/50 focus-within:ring-1 focus-within:ring-brand/30 ${
            dragging ? 'border-brand/60 ring-1 ring-brand/30' : 'border-[rgb(var(--border-line))]'
          }`}
        >
          {attached.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
              {attached.map((src, index) => (
                <span key={index} className="group relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt={t('dashboards.aiDesign.attachReference')}
                    className="h-12 w-12 rounded-md border border-[rgb(var(--border-line))] object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setAttached((current) => current.filter((_, i) => i !== index))}
                    aria-label={t('dashboards.aiDesign.removeReference')}
                    className="absolute -right-1.5 -top-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-surface-3 text-text-secondary shadow-sm ring-1 ring-[rgb(var(--border-line))] transition-colors hover:bg-danger hover:text-white"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={onPaste}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is a newline. This is a chat box, and
              // an instruction is almost always one line.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            rows={2}
            disabled={disabled}
            placeholder={t('dashboards.aiDesign.placeholder')}
            className="block w-full resize-none rounded-xl bg-transparent py-2.5 pl-9 pr-10 text-caption leading-relaxed text-text-primary outline-none placeholder:text-text-quaternary disabled:opacity-50"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onPickFiles}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || attached.length >= MAX_REFS}
            aria-label={t('dashboards.aiDesign.attachReference')}
            title={t('dashboards.aiDesign.referenceHint')}
            className="absolute bottom-2 left-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-text-quaternary transition-colors hover:bg-surface-2 hover:text-text-secondary disabled:opacity-40"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={send}
            disabled={disabled || (!draft.trim() && attached.length === 0)}
            aria-label={t('dashboards.aiDesign.send')}
            className="absolute bottom-2 right-2 inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand text-white transition-colors hover:bg-brand-hover disabled:bg-surface-2 disabled:text-text-quaternary"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUp className="h-3 w-3" />}
          </button>
        </div>
      </div>
    </aside>
  );
}
