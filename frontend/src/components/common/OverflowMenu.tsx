'use client';

import * as React from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';

export interface OverflowMenuItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown as the item's tooltip when disabled, so the user knows why. */
  disabledReason?: string;
  danger?: boolean;
  testId?: string;
  /** Draws a separator above this item. */
  separatorBefore?: boolean;
  /** Extra content on the right of the label (a count, a shortcut). */
  trailing?: React.ReactNode;
}

export interface OverflowMenuProps {
  items: OverflowMenuItem[];
  /** Accessible name of the trigger. Defaults to "More actions". */
  label?: string;
  /** Custom trigger content; defaults to a "···" icon. */
  trigger?: React.ReactNode;
  triggerClassName?: string;
  triggerTestId?: string;
  align?: 'left' | 'right';
  menuClassName?: string;
  /** Rendered above the items (e.g. a section heading). */
  header?: React.ReactNode;
}

/**
 * Accessible "more actions" menu: button with aria-haspopup, role=menu panel,
 * Arrow/Home/End to move, Enter/Space to pick, Esc or outside click to close,
 * focus returns to the trigger. Replaces the hand-rolled backdrop+panel menus.
 */
export function OverflowMenu({
  items,
  label,
  trigger,
  triggerClassName,
  triggerTestId,
  align = 'right',
  menuClassName,
  header,
}: OverflowMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();

  const enabledItems = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);

  const close = React.useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  React.useEffect(() => {
    if (!open) return;
    enabledItems()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const list = enabledItems();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  if (items.length === 0) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid={triggerTestId}
        aria-label={label ?? t('common.detailHeader.moreActions')}
        title={label ?? t('common.detailHeader.moreActions')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-md border border-stroke-strong bg-surface-1 px-2 text-xs text-text-secondary transition-colors hover:border-stroke-control hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
          open && 'bg-surface-2 text-text-primary',
          triggerClassName,
        )}
      >
        {trigger ?? <MoreHorizontal className="h-4 w-4" aria-hidden />}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label ?? t('common.detailHeader.moreActions')}
          onKeyDown={onMenuKeyDown}
          className={cn(
            'absolute top-full z-50 mt-1 max-h-[min(70vh,32rem)] min-w-[220px] overflow-y-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 py-1 shadow-linear-md',
            align === 'right' ? 'right-0' : 'left-0',
            menuClassName,
          )}
        >
          {header}
          {items.map((item) => (
            <React.Fragment key={item.id}>
              {item.separatorBefore && <div role="separator" className="my-1 h-px bg-[rgb(var(--border-line))]" />}
              <button
                type="button"
                role="menuitem"
                data-testid={item.testId}
                disabled={item.disabled}
                title={item.disabled ? item.disabledReason : undefined}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors focus:outline-none',
                  item.danger
                    ? 'text-danger hover:bg-danger/10 focus:bg-danger/10'
                    : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary focus:bg-surface-2 focus:text-text-primary',
                  item.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                )}
              >
                {item.icon && <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5">{item.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.trailing}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
