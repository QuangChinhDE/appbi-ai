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
      ? 'border-blue-200 bg-blue-50'
      : 'border-gray-200 bg-white';
  const buttonToneClass =
    tone === 'blue'
      ? 'text-blue-900 hover:bg-white/70'
      : 'text-gray-900 hover:bg-gray-50';

  return (
    <div className={`rounded-xl border p-5 shadow-sm ${toneClass}`}>
      <button
        type="button"
        onClick={onToggle}
        className={`flex w-full items-start justify-between gap-4 rounded-lg px-1 py-1 text-left transition ${buttonToneClass}`}
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 text-blue-600">{icon}</div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-base font-semibold">{title}</h4>
              {badge && (
                <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-600">
                  {badge}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-600">{description}</p>
          </div>
        </div>
        <div className="mt-0.5 text-gray-400">
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>
      {isOpen && <div className="mt-4">{children}</div>}
    </div>
  );
}
