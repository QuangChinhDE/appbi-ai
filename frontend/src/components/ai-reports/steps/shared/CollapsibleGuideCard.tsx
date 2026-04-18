import { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function CollapsibleGuideCard({
  title,
  description,
  icon,
  isOpen,
  onToggle,
  badge,
  children,
  tone = 'gray',
}: {
  title: string;
  description: string;
  icon: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  badge?: string;
  children: ReactNode;
  tone?: 'gray' | 'blue';
}) {
  const toneClass =
    tone === 'blue'
      ? 'border-brand/20 bg-brand/10'
      : 'border-[rgb(var(--border-line))] bg-surface-1';
  const buttonToneClass =
    tone === 'blue'
      ? 'text-text-primary hover:bg-surface-1/70'
      : 'text-text-primary hover:bg-surface-2';

  return (
    <div className={`rounded-xl border p-5 shadow-linear-sm ${toneClass}`}>
      <button
        type="button"
        onClick={onToggle}
        className={`flex w-full items-start justify-between gap-4 rounded-md px-1 py-1 text-left transition ${buttonToneClass}`}
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 text-brand">{icon}</div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-small font-strong">{title}</h4>
              {badge && (
                <span className="rounded-full bg-surface-1 px-2.5 py-0.5 text-tiny font-emphasis uppercase tracking-[0.16em] text-text-tertiary">
                  {badge}
                </span>
              )}
            </div>
            <p className="mt-1 text-caption text-text-secondary">{description}</p>
          </div>
        </div>
        <div className="mt-0.5 text-text-quaternary">
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>
      {isOpen && <div className="mt-4">{children}</div>}
    </div>
  );
}
