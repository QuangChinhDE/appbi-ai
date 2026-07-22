'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  fetchDatasetModelDistinctValues,
  SLICER_DISTINCT_PREFETCH_LIMIT,
  modelKeys,
  type DroppedFilterInfo,
} from '@/hooks/use-dataset-model';
import {
  getColumnKey,
  getDistinctValueFilterContext,
  getFilterKey,
  type BaseFilter,
  type ColumnInfo,
} from '@/lib/filters';

export interface FilterDistinctValuesResult {
  /** Distinct values keyed by columnKey (legacy shape — DashboardFilterBar reads this). */
  distinctValues: Record<string, string[]>;
  /** Dropped cascading filters reported by BE, keyed by the dropdown's columnKey.
   * Empty array when nothing was dropped. Used to render the "filters bị bỏ qua"
   * banner inside the affected FilterCard. */
  droppedFiltersByColumn: Record<string, DroppedFilterInfo[]>;
}

export function useFilterDistinctValues(
  columns: ColumnInfo[],
  filters: BaseFilter[],
  fallbackDistinctValues: Record<string, string[]>,
): FilterDistinctValuesResult {
  const activeSemanticDistinctTargets = useMemo(() => {
    if (columns.length === 0 || filters.length === 0) {
      return [];
    }

    const columnsByKey = new Map(
      columns.map((column) => [getColumnKey(column), column]),
    );
    const activeColumns = new Map<string, ColumnInfo>();

    for (const filter of filters) {
      const key = getFilterKey(filter);
      const column = columnsByKey.get(key);
      if (!column?.datasetId || !column.semanticField) continue;
      if (column.type !== 'dropdown' && column.type !== 'text') continue;
      activeColumns.set(key, column);
    }

    return Array.from(activeColumns.values()).map((column) => {
      const filterContext = getDistinctValueFilterContext(filters, column);
      return {
        column,
        filterContext,
        filterContextKey: JSON.stringify(filterContext),
      };
    });
  }, [columns, filters]);

  const semanticDistinctQueries = useQueries({
    queries: activeSemanticDistinctTargets.map(({ column, filterContext, filterContextKey }) => ({
      queryKey: [...modelKeys.distinct(column.datasetId!, column.semanticField!), 'filters', filterContextKey],
      queryFn: () => fetchDatasetModelDistinctValues(column.datasetId!, column.semanticField!, SLICER_DISTINCT_PREFETCH_LIMIT, filterContext),
      enabled: Boolean(column.datasetId && column.semanticField),
      staleTime: 5 * 60 * 1000,
      retry: 1,
      retryDelay: 1000,
    })),
  });

  return useMemo(() => {
    const mergedValues: Record<string, string[]> = { ...fallbackDistinctValues };
    const droppedByColumn: Record<string, DroppedFilterInfo[]> = {};

    activeSemanticDistinctTargets.forEach(({ column }, index) => {
      const queryData = semanticDistinctQueries[index]?.data;
      if (!queryData) return;
      const columnKey = getColumnKey(column);
      if (queryData.values) {
        mergedValues[columnKey] = queryData.values;
      }
      if (Array.isArray(queryData.dropped_filters) && queryData.dropped_filters.length > 0) {
        droppedByColumn[columnKey] = queryData.dropped_filters;
      }
    });

    return { distinctValues: mergedValues, droppedFiltersByColumn: droppedByColumn };
  }, [activeSemanticDistinctTargets, fallbackDistinctValues, semanticDistinctQueries]);
}
