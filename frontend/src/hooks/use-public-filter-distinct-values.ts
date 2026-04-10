'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { publicDashboardApi } from '@/lib/api/public';
import { getColumnKey, getFilterKey, type BaseFilter, type ColumnInfo } from '@/lib/filters';

export function usePublicFilterDistinctValues(
  token: string,
  sessionToken: string | undefined,
  columns: ColumnInfo[],
  filters: BaseFilter[],
  fallbackDistinctValues: Record<string, string[]>,
) {
  const activeSemanticDistinctColumns = useMemo(() => {
    if (!token || columns.length === 0 || filters.length === 0) {
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

    return Array.from(activeColumns.values());
  }, [columns, filters, token]);

  const semanticDistinctQueries = useQueries({
    queries: activeSemanticDistinctColumns.map((column) => ({
      queryKey: ['public-filter-distinct', token, column.datasetId, column.semanticField, sessionToken ?? 'anon'],
      queryFn: () => publicDashboardApi.getFilterDistinctValues(
        token,
        column.datasetId!,
        column.semanticField!,
        sessionToken,
      ),
      enabled: Boolean(token && column.datasetId && column.semanticField),
      staleTime: 5 * 60 * 1000,
    })),
  });

  return useMemo(() => {
    const mergedValues: Record<string, string[]> = { ...fallbackDistinctValues };

    activeSemanticDistinctColumns.forEach((column, index) => {
      const values = semanticDistinctQueries[index]?.data?.values;
      if (values) {
        mergedValues[getColumnKey(column)] = values;
      }
    });

    return mergedValues;
  }, [activeSemanticDistinctColumns, fallbackDistinctValues, semanticDistinctQueries]);
}
