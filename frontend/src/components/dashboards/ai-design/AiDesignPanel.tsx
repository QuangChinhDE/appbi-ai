'use client';

import type { ContentProposal } from '@/lib/dashboard-presentation/proposals';
import React from 'react';
import {
  ArrowUp, Check, Crosshair, Info, LayoutGrid, Lightbulb, Loader2, Lock, Maximize2, Minus, Move,
  Palette, Paperclip, ShieldAlert, SlidersHorizontal, Sparkles, Wand2, X,
  Type,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/providers/LanguageProvider';
import type { PresentationDiff } from '@/lib/dashboard-presentation/diff';
import type { Violation } from '@/lib/dashboard-presentation/validator';
import type { DesignSuggestion } from '@/lib/dashboard-presentation/types';

/**
 * The chat side of AI Design.
 *
 * It renders a conversation, what the next request will act on, a change
 * summary and two buttons, and it owns none of the rules. Everything deciding whether a design
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
 *   - there is no mode switch. Whether a request may move things is read from
 *     the words (style unless the user asked to rearrange), and every result
 *     SAYS which it was — "Layout kept" is a chip, not a promise.
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
  /** Ideas that are not presentation (a better chart type…). Shown, never applied. */
  suggestions?: DesignSuggestion[];
}

export interface AiDesignPanelProps {
  turns: AiDesignTurn[];
  busy: boolean;
  onSubmit: (prompt: string, images?: string[]) => void;
  /** Recompose the page with a design direction (a redesign, previewed first). */
  onDirection?: (direction: 'executive' | 'operations' | 'editorial') => void;
  /** Changes to what a tile SAYS, waiting for the author's decision. */
  proposals?: ContentProposal[];
  onDecideProposal?: (proposal: ContentProposal, accepted: boolean) => void;
  /** Non-null while a design is previewed but not applied. */
  pendingDiff: PresentationDiff | null;
  onApply: () => void;
  onDiscard: () => void;
  /** Collapse the panel to a floating bubble, revealing the full report. */
  onCollapse?: () => void;
  onClose: () => void;
  visualCount: number;
  pageName: string;
  /** Titles of the visuals the user selected on the canvas; empty = whole page. */
  selectionNames?: string[];
  onClearSelection?: () => void;
  /** How many visuals on this page are locked — they will not move. */
  lockedCount?: number;
}

const CHIP_ICONS = {
  moved: Move,
  resized: Maximize2,
  restyled: Palette,
  filters: SlidersHorizontal,
  theme: Palette,
  blocks: Type,
} as const;

const LAYER_CHIP = {
  style: { icon: Lock, key: 'dashboards.aiDesign.layerStyle' },
  structure: { icon: Move, key: 'dashboards.aiDesign.layerStructure' },
  redesign: { icon: LayoutGrid, key: 'dashboards.aiDesign.layerRedesign' },
} as const;

function DiffChips({ diff }: { diff: PresentationDiff }) {
  const { t } = useI18n();
  const chips: Array<{ key: keyof typeof CHIP_ICONS; label: string }> = [];
  if (diff.moved.length) chips.push({ key: 'moved', label: t('dashboards.aiDesign.movedCount', { count: diff.moved.length }) });
  if (diff.resized.length) chips.push({ key: 'resized', label: t('dashboards.aiDesign.resizedCount', { count: diff.resized.length }) });
  if (diff.restyled.length) chips.push({ key: 'restyled', label: t('dashboards.aiDesign.restyledCount', { count: diff.restyled.length }) });
  if (diff.addedBlocks) chips.push({ key: 'blocks', label: t('dashboards.aiDesign.addedBlocks', { count: diff.addedBlocks }) });
  if (diff.slicerKeys.length) chips.push({ key: 'filters', label: t('dashboards.aiDesign.chipFilters') });
  if (diff.themeKeys.length) chips.push({ key: 'theme', label: t('dashboards.aiDesign.chipTheme') });
  const layerChip = LAYER_CHIP[diff.layer] ?? LAYER_CHIP.style;
  const LayerIcon = layerChip.icon;

  if (chips.length === 0 && diff.notes.length === 0) {
    return (
      <p className="mt-2 text-caption text-text-tertiary">{t('dashboards.aiDesign.noChange')}</p>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      <p
        data-testid="ai-design-layer"
        data-layer={diff.layer}
        className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-[560] text-brand"
      >
        <LayerIcon className="h-3 w-3" />
        {t(layerChip.key)}
      </p>
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
        {turn.suggestions && turn.suggestions.length > 0 && (
          // Not presentation, so never applied — a pointer to the Chart Editor.
          <div className="mt-2 rounded-lg border border-[rgb(var(--border-line))] px-2.5 py-2">
            <p className="mb-1 flex items-center gap-1.5 text-[11px] font-[560] text-text-secondary">
              <Wand2 className="h-3 w-3 text-text-quaternary" />
              {t('dashboards.aiDesign.suggestionsTitle')}
            </p>
            {turn.suggestions.map((suggestion, index) => (
              <p key={index} className="text-[11px] leading-relaxed text-text-tertiary">• {suggestion.text}</p>
            ))}
          </div>
        )}
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
  turns, busy, onSubmit, onDirection, proposals = [], onDecideProposal,
  pendingDiff, onApply, onDiscard, onCollapse, onClose, visualCount, pageName,
  selectionNames = [], onClearSelection, lockedCount = 0,
}: AiDesignPanelProps) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState('');
  // Reference images attached to the NEXT message, as data URLs. Cleared on send
  // — a reference belongs to the turn it was attached to, not the conversation.
  const [attached, setAttached] = React.useState<string[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const [showGuide, setShowGuide] = React.useState(false);
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

  // The prompt guide — grouped, tap-to-fill example prompts covering every
  // capability, so a user learns what AI Design can do without guessing. Tapping
  // an example DROPS it into the input (never auto-sends), so the user can tweak
  // it first. Purely presentational strings — nothing here is dashboard-specific.
  const guideGroups: Array<{ title: string; prompts: string[] }> = [
    { title: t('dashboards.aiDesign.guideLayout'), prompts: [
      t('dashboards.aiDesign.guideLayout1'), t('dashboards.aiDesign.guideLayout2'),
    ] },
    { title: t('dashboards.aiDesign.guideColour'), prompts: [
      t('dashboards.aiDesign.guideColour1'), t('dashboards.aiDesign.guideColour2'),
    ] },
    { title: t('dashboards.aiDesign.guideFont'), prompts: [
      t('dashboards.aiDesign.guideFont1'), t('dashboards.aiDesign.guideFont2'),
    ] },
    { title: t('dashboards.aiDesign.guideChart'), prompts: [
      t('dashboards.aiDesign.guideChart1'), t('dashboards.aiDesign.guideChart2'),
    ] },
  ];
  const fillFromGuide = (prompt: string) => {
    setDraft(prompt);
    setShowGuide(false);
    textareaRef.current?.focus();
  };

  return (
    <aside
      className="relative flex h-full w-[380px] shrink-0 flex-col overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1"
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
          <button
            type="button"
            onClick={() => setShowGuide((v) => !v)}
            aria-label={t('dashboards.aiDesign.guideTitle')}
            title={t('dashboards.aiDesign.guideTitle')}
            className={`rounded-md p-1 transition-colors hover:bg-surface-2 ${
              showGuide ? 'text-brand' : 'text-text-quaternary hover:text-text-primary'
            }`}
          >
            <Lightbulb className="h-3.5 w-3.5" />
          </button>
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

      {showGuide && (
        // Tap-to-fill prompt guide, laid over the conversation. Escape/backdrop
        // or a second tap on the lightbulb closes it.
        <div className="absolute inset-x-0 bottom-0 top-[57px] z-20 flex flex-col bg-surface-1">
          <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-4 py-2.5">
            <span className="flex items-center gap-1.5 text-[12px] font-[560] text-text-primary">
              <Lightbulb className="h-3.5 w-3.5 text-brand" />
              {t('dashboards.aiDesign.guideTitle')}
            </span>
            <button
              type="button"
              onClick={() => setShowGuide(false)}
              aria-label={t('dashboards.aiDesign.close')}
              className="rounded-md p-1 text-text-quaternary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5">
            <p className="text-[11px] leading-relaxed text-text-tertiary">{t('dashboards.aiDesign.guideIntro')}</p>
            {guideGroups.map((group) => (
              <div key={group.title}>
                <p className="mb-1.5 text-[11px] font-[560] uppercase tracking-wide text-text-quaternary">{group.title}</p>
                <div className="space-y-1.5">
                  {group.prompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => fillFromGuide(prompt)}
                      className="group flex w-full items-start gap-2 rounded-lg border border-[rgb(var(--border-line))] px-2.5 py-2 text-left transition-colors hover:border-brand/40 hover:bg-brand/[0.04]"
                    >
                      <ArrowUp className="mt-0.5 h-3 w-3 shrink-0 rotate-45 text-text-quaternary transition-colors group-hover:text-brand" />
                      <span className="text-[11px] leading-relaxed text-text-secondary">{prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="flex gap-1.5 rounded-lg bg-surface-2 px-2.5 py-2 text-[11px] leading-relaxed text-text-tertiary">
              <ShieldAlert className="mt-[2px] h-3 w-3 shrink-0" />
              <span>{t('dashboards.aiDesign.guideSafety')}</span>
            </p>
          </div>
        </div>
      )}

      <div className="border-b border-[rgb(var(--border-line))] px-4 py-2.5" data-testid="ai-design-target">
        {selectionNames.length > 0 ? (
          // What the next request acts on. Selecting on the canvas IS the scope
          // control — there is no second one to keep in sync.
          <div className="flex items-center gap-2 rounded-lg border border-[rgb(var(--accent))]/35 bg-[rgb(var(--accent))]/10 px-2.5 py-1.5">
            <Crosshair className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--accent))]" />
            <span className="min-w-0 flex-1 truncate text-[11px] font-[560] text-text-primary" title={selectionNames.join(', ')}>
              {selectionNames.length === 1
                ? t('dashboards.aiDesign.focusEditing', { chart: selectionNames[0] })
                : t('dashboards.aiDesign.selectionEditing', { count: selectionNames.length })}
            </span>
            <button
              type="button"
              onClick={() => onClearSelection?.()}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-[510] text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-secondary"
            >
              {t('dashboards.aiDesign.focusClear')}
            </button>
          </div>
        ) : (
          <p className="flex gap-1.5 text-[11px] leading-relaxed text-text-tertiary">
            <Info className="mt-[3px] h-3 w-3 shrink-0" />
            <span>{t('dashboards.aiDesign.pageHint', { page: pageName })}</span>
          </p>
        )}
        {lockedCount > 0 && (
          <p className="mt-1.5 flex gap-1.5 text-[11px] leading-relaxed text-text-tertiary">
            <Lock className="mt-[3px] h-3 w-3 shrink-0" />
            <span>{t('dashboards.aiDesign.lockedHint', { count: lockedCount })}</span>
          </p>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5">
        {turns.length === 0 && (
          <div>
            {visualCount === 0 ? (
              <p className="text-caption leading-relaxed text-text-tertiary">
                {t('dashboards.aiDesign.emptyPage')}
              </p>
            ) : (
              <>
                {onDirection && (
                  <div className="mb-4" data-testid="ai-design-directions">
                    <p className="text-[11px] font-[510] uppercase tracking-wide text-text-quaternary">
                      {t('dashboards.aiDesign.directionsTitle')}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-text-tertiary">{t('dashboards.aiDesign.directionsHint')}</p>
                    <div className="mt-2 grid grid-cols-1 gap-1.5">
                      {(['executive', 'operations', 'editorial'] as const).map((direction) => (
                        <button
                          key={direction}
                          type="button"
                          data-testid={`ai-design-direction-${direction}`}
                          onClick={() => onDirection(direction)}
                          disabled={disabled}
                          className="flex w-full flex-col items-start rounded-lg border border-[rgb(var(--border-line))] px-2.5 py-2 text-left transition-colors hover:border-brand/40 hover:bg-brand/[0.04] disabled:opacity-50"
                        >
                          <span className="text-[12px] font-[560] text-text-primary">{t(`dashboards.aiDesign.direction.${direction}`)}</span>
                          <span className="text-[11px] leading-relaxed text-text-tertiary">{t(`dashboards.aiDesign.direction.${direction}Hint`)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
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

        {proposals.length > 0 && onDecideProposal && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.05] p-2.5" data-testid="ai-design-proposals">
            <p className="text-[11px] font-[560] uppercase tracking-wide text-text-secondary">{t('dashboards.aiDesign.proposalsTitle')}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-text-tertiary">{t('dashboards.aiDesign.proposalsHint')}</p>
            <div className="mt-2 space-y-2">
              {proposals.slice(0, 6).map((p) => (
                <div key={p.id} className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-2" data-testid={'ai-design-proposal-' + p.kind}>
                  <p className="text-[12px] font-[560] text-text-primary">{t('dashboards.aiDesign.proposal.' + p.kind)}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-text-tertiary">
                    <span className="line-through opacity-70">{p.before}</span>
                    <span className="mx-1">→</span>
                    <span className="text-text-secondary">{p.after}</span>
                  </p>
                  <div className="mt-1.5 flex gap-1.5">
                    <button type="button" onClick={() => onDecideProposal(p, true)} data-testid="ai-design-proposal-accept"
                      className="rounded-md bg-brand px-2 py-1 text-[11px] font-[560] text-white hover:bg-brand/90">{t('dashboards.aiDesign.proposalAccept')}</button>
                    <button type="button" onClick={() => onDecideProposal(p, false)} data-testid="ai-design-proposal-reject"
                      className="rounded-md border border-[rgb(var(--border-line))] px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-2">{t('dashboards.aiDesign.proposalReject')}</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

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
              data-testid="ai-design-discard"
              className="flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              {t('dashboards.aiDesign.discard')}
            </button>
            <button
              type="button"
              onClick={onApply}
              data-testid="ai-design-apply"
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
            data-testid="ai-design-input"
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
            data-testid="ai-design-send"
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
