'use client';

import React, { useState } from 'react';
import { Loader2, Search, LayoutGrid, List as ListIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import { Input } from '@/components/ui/Input';

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
  activeFilters?: ((ctx: ToolbarCtx) => React.ReactNode) | React.ReactNode;
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
  activeFilters,
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
          <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin text-brand" />
          <p className="text-caption text-text-tertiary">{loadingText ?? t('common.loading')}</p>
        </div>
      </div>
    );
  }

  const ctx: ToolbarCtx = { viewMode, filterText };
  const toolbarExtraContent = typeof toolbarExtra === 'function' ? toolbarExtra(ctx) : toolbarExtra;
  const activeFiltersContent = typeof activeFilters === 'function' ? activeFilters(ctx) : activeFilters;
  const showToolbar = searchable || viewToggle || Boolean(toolbarExtraContent) || Boolean(activeFiltersContent);

  return (
    <div className="px-8 py-6">
      <div className="mb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-h1 text-text-primary font-emphasis">{title}</h1>
            {description && (
              <p className="mt-1 text-caption text-text-tertiary max-w-2xl">
                {description}
              </p>
            )}
          </div>
          {action && <div className="flex-shrink-0">{action}</div>}
        </div>
      </div>

      {overview && <div className="mb-4">{overview}</div>}

      {showToolbar && (
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {searchable && (
              <div className="min-w-[240px] max-w-xl flex-[0_1_320px]">
                <Input
                  size="sm"
                  value={filterText}
                  onChange={(event) => setFilterText(event.target.value)}
                  placeholder={searchPlaceholder ?? t('common.search')}
                  leadingIcon={<Search />}
                />
              </div>
            )}
            {activeFiltersContent && (
              <div
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 overflow-x-auto whitespace-nowrap',
                  '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
                )}
              >
                {activeFiltersContent}
              </div>
            )}
          </div>
          {(toolbarExtraContent || viewToggle) && (
            <div className="ml-auto flex items-center gap-2">
              {toolbarExtraContent && (
                <div className="flex flex-wrap items-center gap-2">
                  {toolbarExtraContent}
                </div>
              )}
              {viewToggle && (
                <div className="inline-flex items-center overflow-hidden rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 p-0.5">
                  <button
                    type="button"
                    onClick={() => setViewMode('grid')}
                    className={cn(
                      'inline-flex items-center justify-center h-7 w-7 rounded-sm transition-colors',
                      viewMode === 'grid'
                        ? 'bg-surface-3 text-text-primary'
                        : 'text-text-tertiary hover:text-text-primary',
                    )}
                    title={t('common.gridView')}
                  >
                    <LayoutGrid className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('list')}
                    className={cn(
                      'inline-flex items-center justify-center h-7 w-7 rounded-sm transition-colors',
                      viewMode === 'list'
                        ? 'bg-surface-3 text-text-primary'
                        : 'text-text-tertiary hover:text-text-primary',
                    )}
                    title={t('common.listView')}
                  >
                    <ListIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {typeof children === 'function' ? children(ctx) : children}
    </div>
  );
}
