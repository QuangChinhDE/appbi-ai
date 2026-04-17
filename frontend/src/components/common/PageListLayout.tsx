'use client';

import React, { useState } from 'react';
import { Loader2, Search, LayoutGrid, List as ListIcon } from 'lucide-react';

import { useI18n } from '@/providers/LanguageProvider';

export type ViewMode = 'grid' | 'list';

export interface ToolbarCtx {
  viewMode: ViewMode;
  filterText: string;
}

interface PageListLayoutProps {
  title: string;
  description?: React.ReactNode;
  overview?: React.ReactNode;
  action?: React.ReactNode;
  isLoading?: boolean;
  loadingText?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchValueChange?: (value: string) => void;
  viewToggle?: boolean;
  defaultView?: ViewMode;
  toolbarExtra?: ((ctx: ToolbarCtx) => React.ReactNode) | React.ReactNode;
  children: ((ctx: ToolbarCtx) => React.ReactNode) | React.ReactNode;
}

export function PageListLayout({
  title,
  description,
  overview,
  action,
  isLoading = false,
  loadingText,
  searchable = true,
  searchPlaceholder,
  searchValue,
  onSearchValueChange,
  viewToggle = true,
  defaultView = 'grid',
  toolbarExtra,
  children,
}: PageListLayoutProps) {
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<ViewMode>(defaultView);
  const [internalFilterText, setInternalFilterText] = useState('');

  const filterText = searchValue ?? internalFilterText;
  const setFilterText = onSearchValueChange ?? setInternalFilterText;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-blue-600" />
          <p className="text-gray-600">{loadingText ?? t('common.loading')}</p>
        </div>
      </div>
    );
  }

  const showToolbar = searchable || viewToggle || Boolean(toolbarExtra);
  const ctx: ToolbarCtx = { viewMode, filterText };
  const toolbarExtraContent = typeof toolbarExtra === 'function' ? toolbarExtra(ctx) : toolbarExtra;

  return (
    <div className="p-8">
      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
          {action && <div>{action}</div>}
        </div>
        {description && <p className="text-gray-600">{description}</p>}
      </div>

      {overview && <div className="mb-6">{overview}</div>}

      {showToolbar && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          {searchable && (
            <div className="relative min-w-[240px] max-w-lg flex-[1_1_280px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={filterText}
                onChange={(event) => setFilterText(event.target.value)}
                placeholder={searchPlaceholder ?? t('common.search')}
                className="w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}
          {toolbarExtraContent && (
            <div className="flex flex-wrap items-center gap-3">
              {toolbarExtraContent}
            </div>
          )}
          {viewToggle && (
            <div className="ml-auto flex items-center overflow-hidden rounded-md border border-gray-300">
              <button
                onClick={() => setViewMode('grid')}
                className={`p-2 transition-colors ${
                  viewMode === 'grid' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
                title={t('common.gridView')}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-2 transition-colors ${
                  viewMode === 'list' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
                title={t('common.listView')}
              >
                <ListIcon className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {typeof children === 'function' ? children(ctx) : children}
    </div>
  );
}
