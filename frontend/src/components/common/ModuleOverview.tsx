'use client';

import React from 'react';
import type { LucideIcon } from 'lucide-react';

interface ModuleOverviewStat {
  label: string;
  value: React.ReactNode;
  helper?: string;
}

interface ModuleOverviewProps {
  /**
   * Kept for backward compatibility with existing call sites. The explainer
   * card (icon / title / description / badges) is intentionally not rendered
   * here — that long-form context lives on the /overview home. Module pages
   * keep only a thin, single-line stats strip so the list dominates the screen.
   */
  icon?: LucideIcon;
  title?: string;
  description?: string;
  badges?: string[];
  stats: ModuleOverviewStat[];
  storageKey?: string;
}

export function ModuleOverview({ stats }: ModuleOverviewProps) {
  if (stats.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-1.5">
      {stats.map((stat) => (
        <div key={stat.label} className="flex items-baseline gap-1.5" title={stat.helper}>
          <span className="text-small font-strong text-text-primary">{stat.value}</span>
          <span className="text-tiny uppercase tracking-[0.08em] text-text-tertiary">{stat.label}</span>
        </div>
      ))}
    </div>
  );
}
