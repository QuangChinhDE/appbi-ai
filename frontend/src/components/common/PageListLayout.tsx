/**
 * Standard layout for all module list pages.
 *
 * Usage (render prop — recommended):
 *   <PageListLayout
 *     title="Dashboards"
 *     description="3 dashboards"
 *     action={<button>New</button>}
 *     isLoading={isLoading}
 *     defaultView="grid"
 *   >
 *     {({ viewMode, filterText }) => (
 *       viewMode === 'grid' ? <CardGrid items={filtered} /> : <Table items={filtered} />
 *     )}
 *   </PageListLayout>
 *
 * Also accepts plain ReactNode children for backward-compat.
 */
'use client';

import React, { useState } from 'react';
import { Loader2, Search, LayoutGrid, List as ListIcon } from 'lucide-react';

export type ViewMode = 'grid' | 'list';

export interface ToolbarCtx {
  viewMode: ViewMode;
  filterText: string;
}

interface PageListLayoutProps {
  /** Page heading */
  title: string;
  /** Subtitle / item count shown below the title */
  description?: React.ReactNode;
  /** Primary action button (top-right of header) */
  action?: React.ReactNode;
  /** Renders a centered spinner when true */
  isLoading?: boolean;
  /** Label next to the spinner. Default: "Loading…" */
  loadingText?: string;
  /** Show the search input. Default: true */
  searchable?: boolean;
  /** Placeholder for the search input. Default: "Search…" */
  searchPlaceholder?: string;
  /** Show the grid / list toggle. Default: true */
  viewToggle?: boolean;
  /** Initial view mode. Default: 'grid' */
  defaultView?: ViewMode;
  /**
   * Render prop receives current toolbar state so each page can
   * filter its data and switch between grid / list layouts.
   * Also accepts plain ReactNode for backward-compat.
   */
  children: ((ctx: ToolbarCtx) => React.ReactNode) | React.ReactNode;
}

export function PageListLayout({
  title,
  description,
  action,
  isLoading = false,
  loadingText = 'Loading…',
  searchable = true,
  searchPlaceholder = 'Search…',
  viewToggle = true,
  defaultView = 'grid',
  children,
}: PageListLayoutProps) {
  const [viewMode, setViewMode] = useState<ViewMode>(defaultView);
  const [filterText, setFilterText] = useState('');

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-3" />
          <p className="text-gray-600">{loadingText}</p>
        </div>
      </div>
    );
  }

  const showToolbar = searchable || viewToggle;
  const ctx: ToolbarCtx = { viewMode, filterText };

  return (
    <div className="p-8">
      {/* ── Header ────────────────────────────────────────────── */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
          {action && <div>{action}</div>}
        </div>
        {description && <p className="text-gray-600">{description}</p>}
      </div>

      {/* ── Toolbar ───────────────────────────────────────────── */}
      {showToolbar && (
        <div className="flex items-center gap-3 mb-6">
          {searchable && (
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          )}
          {viewToggle && (
            <div className="flex items-center border border-gray-300 rounded-md overflow-hidden ml-auto">
              <button
                onClick={() => setViewMode('grid')}
                className={`p-2 transition-colors ${
                  viewMode === 'grid'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
                title="Grid view"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-2 transition-colors ${
                  viewMode === 'list'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
                title="List view"
              >
                <ListIcon className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Content ───────────────────────────────────────────── */}
      {typeof children === 'function' ? children(ctx) : children}
    </div>
  );
}
