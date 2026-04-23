'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';

import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import {
  getAvailableRelatedOptions,
  getRelatedFilterLabel,
  type CatalogRelationIndex,
  type RelatedFilterKey,
} from '@/lib/module-relations';

export interface CrossModuleFilterConfig {
  key: RelatedFilterKey;
  label: string;
  placeholder: string;
}

interface CrossModuleFilterControlsProps {
  index: CatalogRelationIndex;
  configs: CrossModuleFilterConfig[];
  filters: Partial<Record<RelatedFilterKey, string | undefined>>;
  onChange: (key: RelatedFilterKey, value?: string) => void;
}

const IDLE_OPTION_LIMIT = 12;

export function CrossModuleFilterControls({
  index,
  configs,
  filters,
  onChange,
}: CrossModuleFilterControlsProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [openKey, setOpenKey] = useState<RelatedFilterKey | null>(null);
  const [searchByKey, setSearchByKey] = useState<Partial<Record<RelatedFilterKey, string>>>({});

  useEffect(() => {
    if (!openKey) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenKey(null);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpenKey(null);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openKey]);

  if (configs.length === 0) {
    return null;
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        'flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap pb-1',
        '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
      )}
    >
      {configs.map((config) => {
        const currentValue = filters[config.key];
        const currentLabel = currentValue
          ? getRelatedFilterLabel(index, config.key, currentValue)
          : null;
        const availableOptions = getAvailableRelatedOptions(index, config.key, filters);
        const rawQuery = searchByKey[config.key] ?? '';
        const query = rawQuery.trim().toLowerCase();
        const matchedOptions = query.length === 0
          ? availableOptions
          : availableOptions.filter((option) => option.label.toLowerCase().includes(query));
        const currentOption = currentValue
          ? availableOptions.find((option) => option.value === currentValue)
          : null;
        const visibleOptions = query.length === 0 && matchedOptions.length > IDLE_OPTION_LIMIT
          ? [
              ...(currentOption ? [currentOption] : []),
              ...matchedOptions.filter((option) => option.value !== currentValue).slice(0, IDLE_OPTION_LIMIT),
            ]
          : matchedOptions;

        return (
          <div key={config.key} className="relative min-w-[180px] max-w-[240px] flex-[0_0_220px]">
            <button
              type="button"
              aria-label={config.label}
              aria-expanded={openKey === config.key}
              onClick={() => {
                setOpenKey((current) => current === config.key ? null : config.key);
                setSearchByKey((current) => ({ ...current, [config.key]: '' }));
              }}
              className={cn(
                'flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-surface-1 px-3 text-caption transition-[border-color,box-shadow] duration-150',
                'border-[rgb(var(--border-strong))] hover:border-brand/40 focus:outline-none focus:border-brand focus:shadow-focus-brand',
                currentValue ? 'pr-9' : 'pr-3',
                currentValue ? 'text-text-primary' : 'text-text-quaternary',
              )}
            >
              <span className="truncate text-left">{currentLabel ?? config.placeholder}</span>
              <span className="flex items-center gap-1 text-text-quaternary">
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', openKey === config.key && 'rotate-180')} />
              </span>
            </button>

            {currentValue && (
              <button
                type="button"
                aria-label={`Clear ${config.label} filter`}
                onClick={() => onChange(config.key, undefined)}
                className="absolute right-7 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-text-quaternary transition-colors hover:bg-surface-2 hover:text-text-primary"
              >
                <X className="h-3 w-3" />
              </button>
            )}

            {openKey === config.key && (
              <div className="absolute left-0 top-[calc(100%+0.375rem)] z-30 w-full min-w-[260px] rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 p-3 shadow-linear-lg">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-label font-emphasis text-text-secondary">{config.label}</p>
                    <span className="text-tiny text-text-quaternary">{availableOptions.length} available</span>
                  </div>

                  <Input
                    size="sm"
                    value={rawQuery}
                    onChange={(event) => setSearchByKey((current) => ({ ...current, [config.key]: event.target.value }))}
                    placeholder={`Search ${config.label.toLowerCase()}...`}
                    leadingIcon={<Search />}
                    autoFocus
                  />

                  <div className="flex items-center justify-between gap-2 text-tiny text-text-quaternary">
                    <span>
                      {query.length > 0 ? `${matchedOptions.length} match${matchedOptions.length === 1 ? '' : 'es'}` : config.placeholder}
                    </span>
                    {currentValue && (
                      <button
                        type="button"
                        onClick={() => {
                          onChange(config.key, undefined);
                          setOpenKey(null);
                        }}
                        className="text-brand hover:text-brand-hover"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-1">
                  <button
                    type="button"
                    onClick={() => {
                      onChange(config.key, undefined);
                      setOpenKey(null);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-caption transition-colors',
                      !currentValue ? 'bg-brand/10 text-brand' : 'text-text-secondary hover:bg-surface-3',
                    )}
                  >
                    <span>{config.placeholder}</span>
                    {!currentValue && <Check className="h-3.5 w-3.5" />}
                  </button>

                  {visibleOptions.length > 0 ? (
                    visibleOptions.map((option) => {
                      const isActive = option.value === currentValue;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            onChange(config.key, option.value);
                            setOpenKey(null);
                          }}
                          className={cn(
                            'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-caption transition-colors',
                            isActive
                              ? 'bg-brand/10 text-brand'
                              : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary',
                          )}
                        >
                          <span className="truncate">{option.label}</span>
                          {isActive && <Check className="h-3.5 w-3.5 flex-shrink-0" />}
                        </button>
                      );
                    })
                  ) : (
                    <div className="px-2.5 py-6 text-center text-caption text-text-quaternary">
                      No {config.label.toLowerCase()} matches.
                    </div>
                  )}
                </div>

                {query.length === 0 && matchedOptions.length > IDLE_OPTION_LIMIT && (
                  <p className="mt-2 text-tiny text-text-quaternary">
                    Showing the first {visibleOptions.length - (currentValue ? 1 : 0)} options. Type to narrow the full list.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}