'use client';

import React from 'react';
import type { LucideIcon } from 'lucide-react';

interface ModuleOverviewStat {
  label: string;
  value: React.ReactNode;
  helper: string;
}

interface ModuleOverviewProps {
  icon: LucideIcon;
  title: string;
  description: string;
  badges?: string[];
  stats: ModuleOverviewStat[];
}

export function ModuleOverview({
  icon: Icon,
  title,
  description,
  badges = [],
  stats,
}: ModuleOverviewProps) {
  const statsGridClassName =
    stats.length <= 1
      ? 'grid-cols-1'
      : stats.length === 2
        ? 'grid-cols-1 sm:grid-cols-2'
        : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3';

  return (
    <div className="grid gap-2 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1.85fr)]">
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3">
        <div className="flex items-start gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-label text-text-primary font-strong">{title}</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">{description}</p>
            {badges.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {badges.map((badge) => (
                  <span
                    key={badge}
                    className="rounded-full border border-brand/15 bg-brand/8 px-1.5 py-px text-[10px] font-emphasis text-brand"
                  >
                    {badge}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={`grid gap-2 ${statsGridClassName}`}>
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3">
            <p className="text-[10px] uppercase tracking-[0.12em] text-text-quaternary font-emphasis">{stat.label}</p>
            <div className="mt-1.5 text-lg font-strong text-text-primary">{stat.value}</div>
            <p className="mt-0.5 text-[11px] text-text-tertiary">{stat.helper}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
