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
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm xl:col-span-2">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600">{description}</p>
            {badges.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {badges.map((badge) => (
                  <span
                    key={badge}
                    className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700"
                  >
                    {badge}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {stats.map((stat) => (
        <div key={stat.label} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{stat.label}</p>
          <div className="mt-3 text-2xl font-semibold text-gray-900">{stat.value}</div>
          <p className="mt-2 text-sm text-gray-500">{stat.helper}</p>
        </div>
      ))}
    </div>
  );
}
