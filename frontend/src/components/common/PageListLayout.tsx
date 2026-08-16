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
    <div className="flex h-full flex-col px-4 pt-6 sm:px-6 xl:px-8">
      <div className="mb-4 shrink-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-h1 text-text-primary font-emphasis">{title}</h1>
            {description && (
              <p className="mt-1 text-caption text-text-tertiary max-w-2xl">
                {description}
              </p>
            )}
          </div>
          {action && (
            <div className="w-full flex-shrink-0 overflow-x-auto pb-0.5 sm:w-auto sm:overflow-visible sm:pb-0">
              {action}
            </div>
          )}
        </div>
      </div>

      {overview && <div className="mb-4 shrink-0">{overview}</div>}

      {showToolbar && (
        <div className="relative z-20 mb-4 shrink-0">
          <div className="flex flex-col gap-2.5 xl:flex-row xl:items-center">
            <div className="flex min-w-0 flex-1 flex-col gap-2.5 lg:flex-row lg:items-center">
              {searchable && (
                <div className="w-full min-w-0 lg:min-w-[240px] lg:max-w-xl lg:flex-[0_0_320px]">
                  <Input
                    size="sm"
                    value={filterText}
                    onChange={(event) => setFilterText(event.target.value)}
                    placeholder={searchPlaceholder ?? t('common.search')}
                    leadingIcon={<Search />}
                  />
                </div>
              )}

              {(toolbarExtraContent || activeFiltersContent) && (
                <div className="flex min-w-0 flex-1 items-center gap-2.5 lg:min-w-[320px]">
                  {toolbarExtraContent && (
                    <div className="relative z-30 flex-shrink-0">
                      {toolbarExtraContent}
                    </div>
                  )}

                  {activeFiltersContent && (
                    <div
                      className={cn(
                        'min-w-0 flex-1 overflow-x-auto whitespace-nowrap',
                        '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
                      )}
                    >
                      <div className="flex min-w-max items-center gap-2 pr-1">
                        {activeFiltersContent}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {viewToggle && (
              <div className="flex items-center xl:justify-end">
                <div className="inline-flex items-center overflow-hidden rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 p-0.5">
                  <button
                    type="button"
                    onClick={() => setViewMode('grid')}
                    className={cn(
                      'inline-flex h-7 w-7 items-center justify-center rounded-sm transition-colors',
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
                      'inline-flex h-7 w-7 items-center justify-center rounded-sm transition-colors',
                      viewMode === 'list'
                        ? 'bg-surface-3 text-text-primary'
                        : 'text-text-tertiary hover:text-text-primary',
                    )}
                    title={t('common.listView')}
                  >
                    <ListIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {typeof children === 'function' ? children(ctx) : children}
      </div>
    </div>
  );
}
