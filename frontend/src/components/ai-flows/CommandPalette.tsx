'use client';

/**
 * Command palette (Ctrl/Cmd-K) and the shortcut sheet (?).
 *
 * The Studio has four tabs, N flows and a handful of destructive-ish actions.
 * Once someone builds here daily, hunting for a flow through a tab and a table
 * is the slowest part of the job — so everything reachable by clicking is also
 * reachable by typing.
 *
 * Shortcut discoverability is the other half: a shortcut nobody knows about
 * does not exist, hence the "?" sheet listing the same set the builder binds.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';

import { useI18n } from '@/providers/LanguageProvider';

export interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** True when focus is somewhere the user is typing prose, not driving the app. */
function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * Binds Ctrl/Cmd-K and "?" globally for the Studio.
 * Returns the open state so a host can also open the palette from a button.
 */
export function useCommandPalette() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === '?' && !inTextField(e.target)) {
        e.preventDefault();
        setHelpOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return { paletteOpen, setPaletteOpen, helpOpen, setHelpOpen };
}

export function CommandPalette({ commands, onClose }: {
  commands: Command[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter(
      (c) => `${c.label} ${c.hint ?? ''} ${c.group}`.toLowerCase().includes(needle),
    );
  }, [commands, q]);

  useEffect(() => { setActive(0); }, [q]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const grouped = useMemo(() => {
    const out: { group: string; items: { cmd: Command; idx: number }[] }[] = [];
    filtered.forEach((cmd, idx) => {
      const bucket = out.find((g) => g.group === cmd.group);
      if (bucket) bucket.items.push({ cmd, idx });
      else out.push({ group: cmd.group, items: [{ cmd, idx }] });
    });
    return out;
  }, [filtered]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[active];
      if (cmd) { onClose(); cmd.run(); }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t('aiFlows.cmd.placeholder')}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-3 py-2.5">
          <Search className="h-4 w-4 flex-shrink-0 text-text-quaternary" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('aiFlows.cmd.placeholder')}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-caption text-text-primary outline-none placeholder:text-text-quaternary focus:ring-0"
          />
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-caption text-text-tertiary">
              {t('aiFlows.cmd.empty')}
            </p>
          ) : (
            grouped.map((g) => (
              <div key={g.group} className="mb-1">
                <div className="px-2 py-1 text-[10px] font-strong uppercase tracking-wider text-text-quaternary">
                  {g.group}
                </div>
                {g.items.map(({ cmd, idx }) => (
                  <button
                    key={cmd.id}
                    type="button"
                    data-idx={idx}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => { onClose(); cmd.run(); }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      idx === active ? 'bg-brand/10' : 'hover:bg-surface-2'
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-caption text-text-primary">
                        {cmd.label}
                      </span>
                      {cmd.hint && (
                        <span className="block truncate text-tiny text-text-tertiary">
                          {cmd.hint}
                        </span>
                      )}
                    </span>
                    {idx === active && (
                      <CornerDownLeft className="h-3 w-3 flex-shrink-0 text-text-quaternary" />
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * These MUST mirror what FlowBuilderV2's keydown handler actually binds. A
 * shortcut sheet listing keys that do nothing is worse than no sheet: the reader
 * concludes the app is broken rather than that the list is stale.
 */
const SHORTCUTS: { keys: string; labelKey: string }[] = [
  { keys: 'Ctrl / ⌘ + K', labelKey: 'aiFlows.shortcuts.palette' },
  { keys: 'Ctrl / ⌘ + S', labelKey: 'aiFlows.shortcuts.save' },
  { keys: 'Ctrl / ⌘ + Z · ⇧Z', labelKey: 'aiFlows.shortcuts.undo' },
  { keys: 'Delete', labelKey: 'aiFlows.shortcuts.delete' },
  { keys: 'A', labelKey: 'aiFlows.shortcuts.layout' },
  { keys: 'P', labelKey: 'aiFlows.shortcuts.preview' },
  { keys: 'V', labelKey: 'aiFlows.shortcuts.validate' },
  { keys: '?', labelKey: 'aiFlows.shortcuts.help' },
];

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t('aiFlows.shortcuts.title')}
        className="w-full max-w-sm rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-caption font-strong text-text-primary">
          {t('aiFlows.shortcuts.title')}
        </h2>
        <ul className="space-y-1.5">
          {SHORTCUTS.map((s) => (
            <li key={s.keys} className="flex items-center justify-between gap-3">
              <span className="text-caption text-text-secondary">{t(s.labelKey)}</span>
              <kbd className="flex-shrink-0 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-1.5 py-0.5 font-mono text-tiny text-text-tertiary">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
