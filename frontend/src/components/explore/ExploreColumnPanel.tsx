/**
 * ExploreColumnPanel — Sidebar panel showing semantic dimensions/measures
 * from the dataset model. Users can click to add dimensions to group-by
 * or measures to aggregation config.
 */
'use client';

import React, { useState, useMemo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Hash,
  Type,
  Calendar,
  ToggleLeft,
  Sigma,
  Search,
  Table as TableIcon,
  Info,
} from 'lucide-react';
import {
  useDatasetModel,
  type DimensionDefinition,
  type MeasureDefinition,
} from '@/hooks/use-dataset-model';
import { Input } from '@/components/ui/Input';

function DimensionIcon({ type }: { type: string }) {
  switch (type) {
    case 'number':
      return <Hash className="h-3 w-3 shrink-0 text-brand" />;
    case 'date':
    case 'datetime':
      return <Calendar className="h-3 w-3 shrink-0 text-success" />;
    case 'yesno':
      return <ToggleLeft className="h-3 w-3 shrink-0 text-brand" />;
    default:
      return <Type className="h-3 w-3 shrink-0 text-text-tertiary" />;
  }
}

interface ExploreColumnPanelProps {
  datasetId: number | null;
  selectedTableId: number | null;
  /**
   * Names of views reachable from the selected table via JOINs declared in
   * the dataset's semantic explore. Views NOT in this set are still rendered,
   * but disabled with a tooltip prompting the user to define a relationship
   * in the Data Model tab. When `undefined`, all views are treated as
   * reachable (back-compat for callers that don't yet pass the prop).
   */
  reachableViewNames?: Set<string>;
  onSelectDimension?: (dim: DimensionDefinition, viewName: string) => void;
  onSelectMeasure?: (measure: MeasureDefinition, viewName: string) => void;
}

function groupMeasures(measures: MeasureDefinition[]) {
  const groups = new Map<string, MeasureDefinition[]>();
  for (const measure of measures) {
    const groupName = measure.folder?.trim() || 'Measures';
    groups.set(groupName, [...(groups.get(groupName) ?? []), measure]);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => {
    if (a === 'Measures') return -1;
    if (b === 'Measures') return 1;
    return a.localeCompare(b);
  });
}

function measureTitle(measure: MeasureDefinition) {
  const source = measure.expression || measure.sql || measure.name;
  const parts = [`${measure.type.toUpperCase()}(${source})`];
  if (measure.filters?.length) parts.push(`${measure.filters.length} measure filter(s)`);
  if (measure.depends_on?.length) parts.push(`depends on: ${measure.depends_on.join(', ')}`);
  return parts.join(' | ');
}

export function ExploreColumnPanel({
  datasetId,
  selectedTableId,
  reachableViewNames,
  onSelectDimension,
  onSelectMeasure,
}: ExploreColumnPanelProps) {
  const { data: model, isLoading } = useDatasetModel(datasetId);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedViews, setExpandedViews] = useState<Record<number, boolean>>({});

  // Auto-expand the selected table's view
  const views = useMemo(() => {
    if (!model?.views) return [];
    return model.views.filter(
      (v) => !v.hidden_in_canvas && (!v.dimensions.every((d) => d.hidden) || !v.measures.every((m) => m.hidden)),
    );
  }, [model?.views]);

  // Filter by search
  const filteredViews = useMemo(() => {
    if (!searchQuery) return views;
    const q = searchQuery.toLowerCase();
    return views
      .map((v) => ({
        ...v,
        dimensions: v.dimensions.filter(
          (d) => !d.hidden && ((d.label || d.name).toLowerCase().includes(q) || d.name.toLowerCase().includes(q))
        ),
        measures: v.measures.filter(
          (m) => !m.hidden && ((m.label || m.name).toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
        ),
      }))
      .filter((v) => v.dimensions.length > 0 || v.measures.length > 0);
  }, [views, searchQuery]);

  // Default expand: the view matching selectedTableId
  React.useEffect(() => {
    if (selectedTableId) {
      const match = views.find((v) => v.dataset_table_id === selectedTableId);
      if (match) {
        setExpandedViews((prev) => ({ ...prev, [match.id]: true }));
      }
    }
  }, [selectedTableId, views]);

  const toggleView = (id: number) => {
    setExpandedViews((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  if (!datasetId) return null;

  if (isLoading) {
    return (
      <div className="px-4 py-3 text-caption text-text-quaternary">Loading model...</div>
    );
  }

  if (!model?.model_id || views.length === 0) {
    return (
      <div className="group/help relative flex cursor-default items-center gap-1.5 px-4 py-3 text-caption italic text-text-quaternary">
        No data model.
        <span className="inline-flex items-center">
          <Info className="h-3.5 w-3.5 text-text-quaternary transition-colors group-hover/help:text-brand" />
          <span className="pointer-events-none absolute left-4 top-full z-50 mt-1 hidden w-64 rounded-md bg-surface-inverse px-2.5 py-2 text-tiny not-italic tracking-normal text-text-inverse shadow-linear-lg group-hover/help:block">
            Generate a data model from the dataset Model tab to start using the column panel.
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-4 pb-2 pt-3">
        <Input
          size="sm"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search columns..."
          leadingIcon={<Search className="h-3.5 w-3.5" />}
        />
      </div>

      <div className="flex-1 overflow-y-auto pb-2">
        {filteredViews.map((view) => {
          const isExpanded = expandedViews[view.id] ?? false;
          const visibleDims = view.dimensions.filter((d) => !d.hidden);
          const visibleMeasures = view.measures.filter((m) => !m.hidden);
          const measureGroups = groupMeasures(visibleMeasures);
          const isReachable = reachableViewNames === undefined || reachableViewNames.has(view.name);
          const unreachableTitle = isReachable
            ? undefined
            : 'No JOIN defined between this view and the selected table. Open the Data Model tab to add a relationship.';

          return (
            <div key={view.id}>
              <button
                onClick={() => toggleView(view.id)}
                className="flex w-full items-center gap-1.5 px-4 py-1.5 text-caption font-emphasis text-text-secondary transition-colors hover:bg-surface-2"
                title={unreachableTitle}
              >
                {isExpanded ? (
                  <ChevronDown className="h-3 w-3 text-text-quaternary" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-text-quaternary" />
                )}
                <TableIcon className="h-3 w-3 text-text-quaternary" />
                <span className={`truncate ${isReachable ? '' : 'text-text-quaternary'}`}>
                  {view.table_display_name || view.name}
                </span>
                {!isReachable && (
                  <span className="rounded bg-surface-2 px-1 text-tiny text-text-quaternary">no join</span>
                )}
                <span className="ml-auto text-tiny text-text-quaternary">
                  {visibleDims.length}d · {visibleMeasures.length}m
                </span>
              </button>

              {isExpanded && (
                <div className="ml-4">
                  {visibleDims.length > 0 && (
                    <div className="mb-1">
                      <div className="px-4 py-1 text-tiny font-emphasis uppercase text-text-quaternary">
                        Dimensions
                      </div>
                      {visibleDims.map((dim) => (
                        <button
                          key={dim.name}
                          disabled={!isReachable}
                          onClick={() => isReachable && onSelectDimension?.(dim, view.name)}
                          className={`flex w-full items-center gap-2 rounded-sm px-4 py-1 text-caption transition-colors ${
                            isReachable
                              ? 'text-text-secondary hover:bg-brand/10 hover:text-brand'
                              : 'cursor-not-allowed text-text-quaternary opacity-60'
                          }`}
                          title={unreachableTitle ?? dim.description ?? dim.sql ?? dim.name}
                        >
                          <DimensionIcon type={dim.type} />
                          <span className="truncate">{dim.label || dim.name}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {visibleMeasures.length > 0 && (
                    <div className="mb-1">
                      {measureGroups.map(([groupName, groupMeasures]) => (
                        <div key={groupName}>
                          <div className="px-4 py-1 text-tiny font-emphasis uppercase text-text-quaternary">
                            {groupName}
                          </div>
                          {groupMeasures.map((m) => (
                            <button
                              key={m.name}
                              disabled={!isReachable}
                              onClick={() => isReachable && onSelectMeasure?.(m, view.name)}
                              className={`flex w-full items-center gap-2 rounded-sm px-4 py-1 text-caption transition-colors ${
                                isReachable
                                  ? 'text-text-secondary hover:bg-warning/10 hover:text-warning'
                                  : 'cursor-not-allowed text-text-quaternary opacity-60'
                              }`}
                              title={unreachableTitle ?? measureTitle(m)}
                            >
                              <Sigma className="h-3 w-3 shrink-0 text-warning" />
                              <span className="truncate">{m.label || m.name}</span>
                              {(m.filters?.length ?? 0) > 0 && (
                                <span className="rounded bg-warning/10 px-1 text-tiny text-warning">
                                  f{m.filters?.length}
                                </span>
                              )}
                              {m.format?.kind && m.format.kind !== 'number' && (
                                <span className="rounded bg-surface-2 px-1 text-tiny text-text-quaternary">
                                  {m.format.kind}
                                </span>
                              )}
                              <span className="ml-auto text-tiny uppercase text-text-quaternary">
                                {m.type}
                              </span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
