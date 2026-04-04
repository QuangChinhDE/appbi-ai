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
} from 'lucide-react';
import {
  useDatasetModel,
  type DatasetModelView,
  type DimensionDefinition,
  type MeasureDefinition,
} from '@/hooks/use-dataset-model';

function DimensionIcon({ type }: { type: string }) {
  switch (type) {
    case 'number':
      return <Hash className="w-3 h-3 text-blue-500 shrink-0" />;
    case 'date':
    case 'datetime':
      return <Calendar className="w-3 h-3 text-green-600 shrink-0" />;
    case 'yesno':
      return <ToggleLeft className="w-3 h-3 text-purple-500 shrink-0" />;
    default:
      return <Type className="w-3 h-3 text-gray-500 shrink-0" />;
  }
}

interface ExploreColumnPanelProps {
  datasetId: number | null;
  selectedTableId: number | null;
  onSelectDimension?: (dim: DimensionDefinition, viewName: string) => void;
  onSelectMeasure?: (measure: MeasureDefinition, viewName: string) => void;
}

export function ExploreColumnPanel({
  datasetId,
  selectedTableId,
  onSelectDimension,
  onSelectMeasure,
}: ExploreColumnPanelProps) {
  const { data: model, isLoading } = useDatasetModel(datasetId);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedViews, setExpandedViews] = useState<Record<number, boolean>>({});

  // Auto-expand the selected table's view
  const views = useMemo(() => {
    if (!model?.views) return [];
    return model.views.filter((v) => !v.dimensions.every((d) => d.hidden) || !v.measures.every((m) => m.hidden));
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
    if (selectedTableId && model?.views) {
      const match = model.views.find((v) => v.dataset_table_id === selectedTableId);
      if (match) {
        setExpandedViews((prev) => ({ ...prev, [match.id]: true }));
      }
    }
  }, [selectedTableId, model?.views]);

  const toggleView = (id: number) => {
    setExpandedViews((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  if (!datasetId) return null;

  if (isLoading) {
    return (
      <div className="px-4 py-3 text-xs text-gray-400">Loading model…</div>
    );
  }

  if (!model?.model_id || views.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-gray-400 italic">
        No data model. Generate one from the dataset Model tab.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Search */}
      <div className="px-4 pt-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search columns…"
            className="w-full pl-7 pr-3 py-1.5 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </div>
      </div>

      {/* Views Tree */}
      <div className="flex-1 overflow-y-auto pb-2">
        {filteredViews.map((view) => {
          const isExpanded = expandedViews[view.id] ?? false;
          const visibleDims = view.dimensions.filter((d) => !d.hidden);
          const visibleMeasures = view.measures.filter((m) => !m.hidden);

          return (
            <div key={view.id}>
              {/* View header */}
              <button
                onClick={() => toggleView(view.id)}
                className="w-full flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                {isExpanded ? (
                  <ChevronDown className="w-3 h-3 text-gray-400" />
                ) : (
                  <ChevronRight className="w-3 h-3 text-gray-400" />
                )}
                <TableIcon className="w-3 h-3 text-gray-400" />
                <span className="truncate">{view.table_display_name || view.name}</span>
                <span className="ml-auto text-[10px] text-gray-400">
                  {visibleDims.length}d · {visibleMeasures.length}m
                </span>
              </button>

              {isExpanded && (
                <div className="ml-4">
                  {/* Dimensions */}
                  {visibleDims.length > 0 && (
                    <div className="mb-1">
                      <div className="px-4 py-1 text-[10px] font-medium text-gray-400 uppercase">
                        Dimensions
                      </div>
                      {visibleDims.map((dim) => (
                        <button
                          key={dim.name}
                          onClick={() => onSelectDimension?.(dim, view.name)}
                          className="w-full flex items-center gap-2 px-4 py-1 text-xs text-gray-600 hover:bg-blue-50 hover:text-blue-700 rounded-sm transition-colors"
                          title={dim.description || dim.sql || dim.name}
                        >
                          <DimensionIcon type={dim.type} />
                          <span className="truncate">{dim.label || dim.name}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Measures */}
                  {visibleMeasures.length > 0 && (
                    <div className="mb-1">
                      <div className="px-4 py-1 text-[10px] font-medium text-gray-400 uppercase">
                        Measures
                      </div>
                      {visibleMeasures.map((m) => (
                        <button
                          key={m.name}
                          onClick={() => onSelectMeasure?.(m, view.name)}
                          className="w-full flex items-center gap-2 px-4 py-1 text-xs text-gray-600 hover:bg-orange-50 hover:text-orange-700 rounded-sm transition-colors"
                          title={`${m.type.toUpperCase()}(${m.sql || m.name})`}
                        >
                          <Sigma className="w-3 h-3 text-orange-500 shrink-0" />
                          <span className="truncate">{m.label || m.name}</span>
                          <span className="ml-auto text-[10px] text-gray-400 uppercase">
                            {m.type}
                          </span>
                        </button>
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
