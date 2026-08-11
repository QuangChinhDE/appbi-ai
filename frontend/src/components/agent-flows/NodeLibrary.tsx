'use client';

/**
 * "Thêm bước" — the node palette.
 *
 * GENERATED FROM THE SERVER'S REGISTRY, never from a list in this file. The module
 * this replaces kept its own table of node types and it drifted from the executor:
 * the palette offered nodes that published fine and then did nothing at run time.
 * If a type is here, something can run it.
 *
 * The insert position is shown rather than implied. "Thêm bước" that always appends
 * is why the previous builder could not express a branch — you could add a node but
 * never say where.
 */
import React from 'react';
import { Search, X } from 'lucide-react';

import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import type { NodeSpec, NodeType } from '@/lib/agentFlows';

const CATEGORIES: { key: string; label: string }[] = [
  { key: 'all', label: 'Tất cả' },
  { key: 'ai', label: 'AI' },
  { key: 'data', label: 'Dữ liệu' },
  { key: 'logic', label: 'Logic' },
  { key: 'flow', label: 'Điều khiển' },
  { key: 'utility', label: 'Xử lý' },
];

export function NodeLibrary({
  specs, positionLabel, onPick, onClose,
}: {
  specs: NodeSpec[];
  positionLabel: string;
  onPick: (type: NodeType) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState('all');

  const shown = specs.filter((s) => {
    const inCat = category === 'all' || s.category === category;
    const q = query.trim().toLowerCase();
    const match = !q
      || s.label_vi.toLowerCase().includes(q)
      || s.label_en.toLowerCase().includes(q)
      || s.description_vi.toLowerCase().includes(q);
    return inCat && match;
  });

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-[rgb(8_9_10/0.12)] pt-14"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[580px] max-h-[640px] overflow-hidden rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-lg">
        <div className="border-b border-[rgb(var(--border-line))] p-3">
          <div className="flex items-center gap-2">
            <div>
              <b className="text-body font-strong">Thêm bước</b>
              <span className="mt-px block text-tiny text-text-tertiary">
                Chọn loại bước — AppBI nối vào đúng vị trí.
              </span>
            </div>
            <div className="flex-1" />
            <button type="button" onClick={onClose} aria-label="Đóng"
              className="rounded-md p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="relative mt-2">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-quaternary" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm AI Agent, IF, Loop, Delay…"
              className="pl-8"
            />
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-tiny text-text-tertiary">
            Chèn tại:
            <span className="rounded-full border border-brand/20 bg-brand/5 px-2 py-px text-brand">
              {positionLabel}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-[130px_1fr] min-h-[380px] max-h-[500px]">
          <nav className="border-r border-[rgb(var(--border-line))] bg-surface-2/40 p-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setCategory(c.key)}
                className={cn(
                  'block w-full rounded-md px-2 py-1.5 text-left text-caption transition',
                  category === c.key
                    ? 'bg-surface-1 text-text-primary shadow-linear-sm'
                    : 'text-text-tertiary hover:text-text-primary',
                )}
              >
                {c.label}
              </button>
            ))}
          </nav>

          <div className="overflow-auto p-2.5">
            <div className="grid grid-cols-2 gap-2">
              {shown.map((s) => (
                <button
                  key={s.type}
                  type="button"
                  onClick={() => onPick(s.type)}
                  className="flex min-h-[70px] gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-2.5 text-left transition hover:border-brand/40 hover:bg-brand/[0.02]"
                >
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-surface-2 text-small">
                    {s.icon}
                  </span>
                  <span className="min-w-0">
                    <b className="flex items-center gap-1 text-caption font-strong">
                      {s.label_vi}
                      {/* Nine of twelve node types cost nothing. Saying so here is
                          what stops an author reaching for an AI Agent to do
                          something the engine can simply do. */}
                      {s.costs_llm && (
                        <span className="rounded border border-brand/20 bg-brand/5 px-1 text-tiny text-brand">
                          LLM
                        </span>
                      )}
                      {s.reaches_outside && (
                        <span className="rounded border border-warning/25 bg-warning/5 px-1 text-tiny text-warning">
                          ra ngoài
                        </span>
                      )}
                    </b>
                    <span className="mt-0.5 block text-tiny leading-snug text-text-tertiary">
                      {s.description_vi}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {!shown.length && (
              <p className="p-6 text-center text-caption text-text-tertiary">
                Không có loại bước nào khớp.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
